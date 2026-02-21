/**
 * TaskGraphEngine — interface and implementation for the DAG-based task graph.
 *
 * Loads task graphs from YAML/JSON files or strings, validates them,
 * persists them to the SQLite database, and emits lifecycle events.
 *
 * Implements the orchestrator state machine (ADR-002 — custom TypeScript, NOT XState)
 * with intent logging: log entry is always written BEFORE the status update
 * in a single transaction, providing crash safety.
 *
 * State machine transitions (Architecture Section 2):
 *   Idle → Loading (START command)
 *   Loading → Executing (graph loaded & validated)
 *   Executing → Executing (task completes → check newly ready)
 *   Executing → Paused (PAUSE command)
 *   Paused → Executing (RESUME command)
 *   Executing → Completing (all tasks finished/failed)
 *   Completing → Idle (ready for new graph)
 *   Executing → Cancelling (CANCEL command)
 *   Cancelling → Idle (all workers terminated)
 *
 * Event subscriptions (Architecture Section 19):
 *  - Listens to graph lifecycle events to manage state transitions
 */

import { randomUUID } from 'node:crypto'
import type { BaseService } from '../../core/di.js'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { DatabaseService } from '../../persistence/database.js'
import { createSession } from '../../persistence/queries/sessions.js'
import {
  createTask,
  getReadyTasks,
  getTasksByStatus,
  getAllTasks,
  getTask,
  updateTaskStatus,
} from '../../persistence/queries/tasks.js'
import type { Task } from '../../persistence/queries/tasks.js'
import { appendLog } from '../../persistence/queries/log.js'
import { maskSecrets } from '../../cli/utils/masking.js'
import { parseGraphFile, parseGraphString } from './task-parser.js'
import type { GraphFormat } from './task-parser.js'
import { validateGraph, ValidationError } from './task-validator.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('task-graph')

// ---------------------------------------------------------------------------
// Orchestrator state enum (ADR-002: custom TS, not XState)
// ---------------------------------------------------------------------------

export type OrchestratorState =
  | 'Idle'
  | 'Loading'
  | 'Executing'
  | 'Completing'
  | 'Paused'
  | 'Cancelling'

/** Valid state transitions map */
const VALID_TRANSITIONS: Record<OrchestratorState, OrchestratorState[]> = {
  Idle: ['Loading'],
  Loading: ['Executing'],
  Executing: ['Executing', 'Paused', 'Completing', 'Cancelling'],
  Completing: ['Idle'],
  Paused: ['Executing', 'Cancelling'],
  Cancelling: ['Idle'],
}

// ---------------------------------------------------------------------------
// TaskGraphEngine interface
// ---------------------------------------------------------------------------

export interface TaskGraphEngine extends BaseService {
  /**
   * Load a task graph from a file path. Detects format by file extension.
   * Parses, validates, and persists the graph to the database.
   *
   * @param filePath - Path to YAML or JSON task graph file
   * @returns The session ID created for this graph
   * @throws {ParseError} if the file cannot be read or parsed
   * @throws {ValidationError} if the graph fails validation (no partial data persisted)
   */
  loadGraph(filePath: string): Promise<string>

  /**
   * Load a task graph from a string (YAML or JSON).
   * Parses, validates, and persists the graph to the database.
   *
   * @param content - String content of the task graph
   * @param format - 'yaml' or 'json'
   * @returns The session ID created for this graph
   * @throws {ParseError} if the content cannot be parsed
   * @throws {ValidationError} if the graph fails validation (no partial data persisted)
   */
  loadGraphFromString(content: string, format: GraphFormat): Promise<string>

  /**
   * Begin execution of a loaded graph. Transitions Idle → Executing and
   * schedules the first batch of ready tasks.
   *
   * @param sessionId - The session ID returned by loadGraph / loadGraphFromString
   * @param maxConcurrency - Maximum number of tasks that may run simultaneously
   */
  startExecution(sessionId: string, maxConcurrency: number): void

  /**
   * Mark a task as running. Writes an intent log entry and then updates status.
   * Both operations occur inside a single transaction.
   *
   * @param taskId - ID of the task to mark running
   * @param workerId - ID of the worker handling this task
   */
  markTaskRunning(taskId: string, workerId: string): void

  /**
   * Mark a task as completed. Writes intent log, updates status, then checks
   * for newly-ready tasks to schedule.
   *
   * @param taskId - ID of the task to mark complete
   * @param result - Result string from the task
   * @param costUsd - Cost incurred for this task execution
   */
  markTaskComplete(taskId: string, result: string, costUsd?: number): void

  /**
   * Mark a task as failed. Writes intent log, updates status. If retries remain
   * (retry_count < max_retries) the task is reset to 'pending' with an incremented
   * retry_count instead of being set to 'failed'.
   *
   * @param taskId - ID of the task to mark failed
   * @param error - Error message
   * @param exitCode - Exit code from the worker process
   */
  markTaskFailed(taskId: string, error: string, exitCode?: number): void

  /**
   * Mark a task as cancelled. Writes intent log, updates status.
   *
   * @param taskId - ID of the task to cancel
   */
  markTaskCancelled(taskId: string): void

  /**
   * Retrieve tasks that are ready to execute (from the ready_tasks view).
   *
   * @param sessionId - Session to query
   * @returns Array of tasks with satisfied dependencies
   */
  getReadyTasks(sessionId: string): Task[]

  /**
   * Retrieve a single task by ID.
   *
   * @param taskId - Task ID to look up
   * @returns The task, or undefined if not found
   */
  getTask(taskId: string): Task | undefined

  /**
   * Retrieve all tasks for a session.
   *
   * @param sessionId - Session to query
   */
  getAllTasks(sessionId: string): Task[]

  /**
   * Retrieve all tasks for a session with a specific status.
   *
   * @param sessionId - Session to query
   * @param status - Status to filter by
   */
  getTasksByStatus(sessionId: string, status: string): Task[]

  /**
   * Pause graph execution. Stops scheduling new tasks; running tasks continue.
   * Transitions Executing → Paused.
   */
  pause(): void

  /**
   * Resume paused execution. Schedules ready tasks again.
   * Transitions Paused → Executing.
   */
  resume(): void

  /**
   * Cancel all pending and running tasks. Marks them 'cancelled' and emits
   * graph:cancelled. Transitions Executing/Paused → Cancelling → Idle.
   */
  cancelAll(): void

  /** Current orchestrator state (read-only) */
  readonly state: OrchestratorState
}

// ---------------------------------------------------------------------------
// TaskGraphEngineImpl
// ---------------------------------------------------------------------------

export class TaskGraphEngineImpl implements TaskGraphEngine {
  private readonly _eventBus: TypedEventBus
  private readonly _databaseService: DatabaseService

  private _state: OrchestratorState = 'Idle'
  private _sessionId: string | null = null
  private _maxConcurrency: number = 1
  /** Tracks tasks emitted as task:ready but not yet confirmed via markTaskRunning */
  private _inFlightCount: number = 0
  /** Timer handle for the session signal polling loop */
  private _signalPollTimer: ReturnType<typeof setInterval> | null = null

  constructor(eventBus: TypedEventBus, databaseService: DatabaseService) {
    this._eventBus = eventBus
    this._databaseService = databaseService
  }

  get state(): OrchestratorState {
    return this._state
  }

  async initialize(): Promise<void> {
    logger.info('TaskGraphEngine.initialize()')

    // Subscribe to relevant graph events
    this._eventBus.on('graph:loaded', ({ sessionId, taskCount, readyCount }) => {
      logger.debug({ sessionId, taskCount, readyCount }, 'graph:loaded')
    })

    this._eventBus.on('graph:paused', (_payload) => {
      logger.debug('graph:paused')
    })

    this._eventBus.on('graph:resumed', (_payload) => {
      logger.debug('graph:resumed')
    })

    this._eventBus.on('task:complete', ({ taskId, result }) => {
      logger.debug({ taskId, costUsd: result.costUsd }, 'task:complete — update graph state')
      // Mark the task complete and cascade to check for newly ready tasks
      if (this._state === 'Executing' && this._sessionId !== null) {
        const output = result.output !== undefined ? result.output : ''
        this.markTaskComplete(taskId, output, result.costUsd)
      }
    })

    this._eventBus.on('task:failed', ({ taskId, error }) => {
      logger.warn({ taskId, error: error.message }, 'task:failed — update graph state')
      // Mark task failed (retry logic is inside markTaskFailed)
      if (this._state === 'Executing' && this._sessionId !== null) {
        this.markTaskFailed(taskId, error.message, undefined)
      }
    })
  }

  async shutdown(): Promise<void> {
    logger.info('TaskGraphEngine.shutdown()')
    this._stopSignalPolling()
  }

  // ---------------------------------------------------------------------------
  // Signal polling (Story 5.3: pause/resume/cancel via DB signal queue)
  // ---------------------------------------------------------------------------

  /**
   * Start polling the session_signals table for unprocessed signals.
   * Called when execution begins so the orchestrator can react to pause/resume/cancel
   * commands issued by the CLI in a separate process.
   */
  private _startSignalPolling(sessionId: string): void {
    if (this._signalPollTimer !== null) return

    this._signalPollTimer = setInterval(() => {
      this._pollSessionSignals(sessionId)
    }, 500)
  }

  /**
   * Stop the signal polling timer.
   */
  private _stopSignalPolling(): void {
    if (this._signalPollTimer !== null) {
      clearInterval(this._signalPollTimer)
      this._signalPollTimer = null
    }
  }

  /**
   * Poll the session_signals table for unprocessed signals and handle them.
   * Marks each signal as processed after handling.
   */
  private _pollSessionSignals(sessionId: string): void {
    try {
      const db = this._databaseService.db

      // Check if the table exists first (migration may not have run in test environments)
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='session_signals'`)
        .get() as { name: string } | undefined

      if (!tableExists) return

      const signals = db
        .prepare(
          `SELECT id, signal FROM session_signals
           WHERE session_id = ? AND processed_at IS NULL
           ORDER BY id ASC`,
        )
        .all(sessionId) as Array<{ id: number; signal: string }>

      for (const sig of signals) {
        logger.debug({ sessionId, signal: sig.signal }, 'Processing session signal')
        this._handleSignal(sig.signal)
        db.prepare(
          `UPDATE session_signals SET processed_at = datetime('now') WHERE id = ?`,
        ).run(sig.id)
      }
    } catch (err) {
      logger.warn({ err }, 'Signal polling error — skipping this poll cycle')
    }
  }

  /**
   * Handle a signal value received from the session_signals table.
   */
  private _handleSignal(signal: string): void {
    switch (signal) {
      case 'pause':
        if (this._state === 'Executing') {
          this.pause()
          this._eventBus.emit('session:pause:requested', {})
        }
        break
      case 'resume':
        if (this._state === 'Paused') {
          this.resume()
          this._eventBus.emit('session:resume:requested', {})
        }
        break
      case 'cancel':
        if (this._state === 'Executing' || this._state === 'Paused') {
          this._stopSignalPolling()
          this.cancelAll()
          this._eventBus.emit('session:cancel:requested', {})
        }
        break
      default:
        logger.warn({ signal }, 'Unknown session signal — ignoring')
    }
  }

  async loadGraph(filePath: string): Promise<string> {
    logger.info({ filePath }, 'loadGraph: parsing file')

    // Parse
    const raw = parseGraphFile(filePath)

    // Validate
    const result = validateGraph(raw)
    if (!result.valid || !result.graph) {
      throw new ValidationError(result.errors, result.warnings)
    }

    // Log any warnings
    for (const warning of result.warnings) {
      logger.warn(warning)
    }

    // Persist and emit
    return this._persistGraph(result.graph, filePath)
  }

  async loadGraphFromString(content: string, format: GraphFormat): Promise<string> {
    logger.info({ format }, 'loadGraphFromString: parsing content')

    // Parse
    const raw = parseGraphString(content, format)

    // Validate
    const result = validateGraph(raw)
    if (!result.valid || !result.graph) {
      throw new ValidationError(result.errors, result.warnings)
    }

    // Log any warnings
    for (const warning of result.warnings) {
      logger.warn(warning)
    }

    // Persist and emit (no file path for string-based loading)
    return this._persistGraph(result.graph, '<string>')
  }

  // ---------------------------------------------------------------------------
  // State machine
  // ---------------------------------------------------------------------------

  /**
   * Attempt a state transition. Throws if the transition is not valid from the
   * current state.
   */
  private _transition(newState: OrchestratorState): void {
    const allowed = VALID_TRANSITIONS[this._state]
    if (!allowed.includes(newState)) {
      throw new Error(
        `Invalid state transition: ${this._state} → ${newState}. ` +
        `Allowed from ${this._state}: [${allowed.join(', ')}]`,
      )
    }
    // Log to execution_log if we have an active session
    if (this._sessionId !== null) {
      try {
        appendLog(this._databaseService.db, {
          session_id: this._sessionId,
          task_id: null,
          event: 'orchestrator:state_change',
          old_status: this._state,
          new_status: newState,
        })
      } catch { /* ignore if DB not ready */ }
    }
    logger.debug({ from: this._state, to: newState }, 'State transition')
    this._state = newState
  }

  startExecution(sessionId: string, maxConcurrency: number): void {
    if (this._state !== 'Idle') {
      throw new Error(`startExecution requires Idle state; current state is ${this._state}`)
    }
    // Set _sessionId before first transition so orchestrator:state_change entries are logged
    this._sessionId = sessionId
    this._maxConcurrency = maxConcurrency
    this._inFlightCount = 0
    // Transition through Loading to Executing
    this._transition('Loading')
    this._transition('Executing')

    logger.info({ sessionId, maxConcurrency }, 'Execution started')
    this._startSignalPolling(sessionId)
    this._checkAndScheduleReady()
  }

  pause(): void {
    this._transition('Paused')
    this._eventBus.emit('graph:paused', {})
    logger.info('Graph paused')
  }

  resume(): void {
    this._transition('Executing')
    this._eventBus.emit('graph:resumed', {})
    logger.info('Graph resumed')
    this._checkAndScheduleReady()
  }

  cancelAll(): void {
    this._transition('Cancelling')

    const db = this._databaseService.db
    const sessionId = this._sessionId
    if (sessionId === null) {
      this._transition('Idle')
      return
    }

    // Mark all pending/running tasks as cancelled with intent logging
    const cancellableTasks = db
      .prepare(`SELECT * FROM tasks WHERE session_id = ? AND status IN ('pending', 'running', 'ready', 'queued')`)
      .all(sessionId) as Task[]

    for (const task of cancellableTasks) {
      this._logAndUpdateStatus(task.id, task.status, 'cancelled', sessionId, task.agent ?? null)
    }

    const cancelledCount = cancellableTasks.length
    logger.info({ sessionId, cancelledCount }, 'Graph cancelled')

    this._inFlightCount = 0
    this._eventBus.emit('graph:cancelled', { cancelledTasks: cancelledCount })
    this._transition('Idle')
  }

  // ---------------------------------------------------------------------------
  // Task state transition methods (Task 1)
  // ---------------------------------------------------------------------------

  markTaskRunning(taskId: string, workerId: string): void {
    this._inFlightCount = Math.max(0, this._inFlightCount - 1)

    const db = this._databaseService.db
    const task = getTask(db, taskId)
    if (task === undefined) {
      throw new Error(`Task "${taskId}" not found`)
    }

    const doTransition = db.transaction(() => {
      appendLog(db, {
        session_id: task.session_id,
        task_id: taskId,
        event: 'task:status_change',
        old_status: task.status,
        new_status: 'running',
        agent: task.agent ?? null,
      })
      updateTaskStatus(db, taskId, 'running', {
        worker_id: workerId,
        started_at: new Date().toISOString(),
      })
    })

    doTransition()
    logger.debug({ taskId, workerId, oldStatus: task.status, newStatus: 'running', agent: task.agent }, 'markTaskRunning')
  }

  markTaskComplete(taskId: string, result: string, costUsd?: number): void {
    const db = this._databaseService.db
    const task = getTask(db, taskId)
    if (task === undefined) {
      throw new Error(`Task "${taskId}" not found`)
    }

    const doTransition = db.transaction(() => {
      appendLog(db, {
        session_id: task.session_id,
        task_id: taskId,
        event: 'task:status_change',
        old_status: task.status,
        new_status: 'completed',
        agent: task.agent ?? null,
        cost_usd: costUsd ?? null,
        data: JSON.stringify({ result: maskSecrets(result) }),
      })
      updateTaskStatus(db, taskId, 'completed', {
        result,
        completed_at: new Date().toISOString(),
        cost_usd: costUsd,
      })
    })

    doTransition()
    logger.debug({ taskId, costUsd, oldStatus: task.status, newStatus: 'completed', agent: task.agent }, 'markTaskComplete')

    // After marking complete, check for newly ready tasks (cascade scheduling)
    if (this._state === 'Executing') {
      this._checkAndScheduleReady()
    }
  }

  markTaskFailed(taskId: string, error: string, exitCode?: number): void {
    const db = this._databaseService.db
    const task = getTask(db, taskId)
    if (task === undefined) {
      throw new Error(`Task "${taskId}" not found`)
    }

    const canRetry = task.retry_count < task.max_retries
    const newStatus = canRetry ? 'pending' : 'failed'

    const doTransition = db.transaction(() => {
      appendLog(db, {
        session_id: task.session_id,
        task_id: taskId,
        event: 'task:status_change',
        old_status: task.status,
        new_status: newStatus,
        agent: task.agent ?? null,
        data: JSON.stringify({ error: maskSecrets(error) }),
      })

      if (canRetry) {
        // Reset to pending with incremented retry_count
        const result = db.prepare(`
          UPDATE tasks
          SET status = 'pending',
              retry_count = retry_count + 1,
              error = @error,
              exit_code = @exit_code,
              updated_at = datetime('now')
          WHERE id = @taskId
        `).run({ taskId, error, exit_code: exitCode ?? null })
        if (result.changes === 0) {
          throw new Error(`Task "${taskId}" not found`)
        }
      } else {
        updateTaskStatus(db, taskId, 'failed', {
          error,
          exit_code: exitCode,
          completed_at: new Date().toISOString(),
        })
      }
    })

    doTransition()
    logger.debug({ taskId, canRetry, newStatus, error, oldStatus: task.status, agent: task.agent }, 'markTaskFailed')

    // After failure, check for newly ready tasks or graph completion
    if (this._state === 'Executing') {
      this._checkAndScheduleReady()
    }
  }

  markTaskCancelled(taskId: string): void {
    const db = this._databaseService.db
    const task = getTask(db, taskId)
    if (task === undefined) {
      throw new Error(`Task "${taskId}" not found`)
    }

    this._logAndUpdateStatus(taskId, task.status, 'cancelled', task.session_id, task.agent ?? null)
    logger.debug({ taskId, oldStatus: task.status, newStatus: 'cancelled' }, 'markTaskCancelled')
  }

  // ---------------------------------------------------------------------------
  // Query methods (Task 1)
  // ---------------------------------------------------------------------------

  getReadyTasks(sessionId: string): Task[] {
    return getReadyTasks(this._databaseService.db, sessionId)
  }

  getTask(taskId: string): Task | undefined {
    return getTask(this._databaseService.db, taskId)
  }

  getAllTasks(sessionId: string): Task[] {
    return getAllTasks(this._databaseService.db, sessionId)
  }

  getTasksByStatus(sessionId: string, status: string): Task[] {
    return getTasksByStatus(this._databaseService.db, sessionId, status)
  }

  // ---------------------------------------------------------------------------
  // Internal scheduling helpers (Task 2)
  // ---------------------------------------------------------------------------

  /**
   * Query ready_tasks, compare to available concurrency slots, and emit
   * task:ready events for each task that can be started. If there are no
   * ready tasks and no running tasks the graph is complete.
   */
  private _checkAndScheduleReady(): void {
    if (this._sessionId === null) return
    if (this._state !== 'Executing') return

    const db = this._databaseService.db
    const sessionId = this._sessionId

    const runningCount = getTasksByStatus(db, sessionId, 'running').length
    const effectiveRunning = runningCount + this._inFlightCount
    const availableSlots = this._maxConcurrency - effectiveRunning

    const readyTasks = getReadyTasks(db, sessionId)

    let scheduledCount = 0
    if (availableSlots > 0) {
      const toSchedule = readyTasks.slice(0, availableSlots)
      for (const task of toSchedule) {
        this._inFlightCount++
        scheduledCount++
        logger.debug({ taskId: task.id }, 'Emitting task:ready')
        this._eventBus.emit('task:ready', { taskId: task.id })
      }
    }

    // Check if graph is complete: no ready tasks, no running tasks, and no in-flight tasks
    // Use computed values instead of redundant DB queries — DB state hasn't changed since the emit calls are synchronous
    const remainingReady = readyTasks.length - scheduledCount
    const newRunningCount = runningCount + this._inFlightCount

    if (remainingReady === 0 && newRunningCount === 0 && this._inFlightCount === 0) {
      const allTasks = getAllTasks(db, sessionId)
      const totalTasks = allTasks.length
      const completedTasks = allTasks.filter((t) => t.status === 'completed').length
      const failedTasks = allTasks.filter((t) => t.status === 'failed').length
      const totalCostUsd = allTasks.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0)

      logger.info({ sessionId, totalTasks, completedTasks, failedTasks, totalCostUsd }, 'Graph complete')
      this._stopSignalPolling()
      this._transition('Completing')
      this._eventBus.emit('graph:complete', { totalTasks, completedTasks, failedTasks, totalCostUsd })
    }
  }

  /**
   * Helper: write intent log entry, then update task status — inside a single
   * transaction. This is the core crash-safety guarantee (Architecture: "log
   * intent before action").
   */
  private _logAndUpdateStatus(
    taskId: string,
    oldStatus: string,
    newStatus: string,
    sessionId?: string,
    agent?: string | null,
  ): void {
    const db = this._databaseService.db
    const resolvedSessionId = sessionId ?? this._sessionId

    if (resolvedSessionId === null) {
      throw new Error('Cannot log status change: no active session')
    }

    const doTransition = db.transaction(() => {
      appendLog(db, {
        session_id: resolvedSessionId,
        task_id: taskId,
        event: 'task:status_change',
        old_status: oldStatus,
        new_status: newStatus,
        agent: agent ?? null,
      })
      updateTaskStatus(db, taskId, newStatus)
    })

    doTransition()
  }

  // ---------------------------------------------------------------------------
  // Graph persistence (unchanged from Story 2-3)
  // ---------------------------------------------------------------------------

  private _persistGraph(
    graph: NonNullable<ReturnType<typeof validateGraph>['graph']>,
    filePath: string,
  ): string {
    const db = this._databaseService.db
    const sessionId = randomUUID()

    // Wrap all inserts in a transaction — if anything fails, nothing is persisted
    const insertDep = db.prepare('INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)')
    const persist = db.transaction(() => {
      // Insert session
      createSession(db, {
        id: sessionId,
        graph_file: filePath,
        name: graph.session.name,
        budget_usd: graph.session.budget_usd ?? null,
        status: 'active',
      })

      // Insert all tasks first (to satisfy FK constraints)
      for (const [taskKey, taskDef] of Object.entries(graph.tasks)) {
        createTask(db, {
          id: taskKey,
          session_id: sessionId,
          name: taskDef.name,
          description: taskDef.description ?? null,
          prompt: taskDef.prompt,
          status: 'pending',
          agent: taskDef.agent ?? null,
          model: taskDef.model ?? null,
          budget_usd: taskDef.budget_usd ?? null,
          task_type: taskDef.type,
        })
      }

      // Insert dependencies after all tasks are created
      for (const [taskKey, taskDef] of Object.entries(graph.tasks)) {
        for (const dep of taskDef.depends_on ?? []) {
          insertDep.run(taskKey, dep)
        }
      }
    })

    persist()

    // Count total tasks and ready tasks
    const taskCount = Object.keys(graph.tasks).length
    const readyTasks = getReadyTasks(db, sessionId)
    const readyCount = readyTasks.length

    logger.info({ sessionId, taskCount, readyCount }, 'Graph persisted successfully')

    // Emit graph:loaded event
    this._eventBus.emit('graph:loaded', { sessionId, taskCount, readyCount })

    return sessionId
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface TaskGraphEngineOptions {
  eventBus: TypedEventBus
  databaseService?: DatabaseService
}

export function createTaskGraphEngine(options: TaskGraphEngineOptions): TaskGraphEngine {
  // databaseService is required for full functionality; if not provided the
  // engine will fail at loadGraph/loadGraphFromString call time.
  // This preserves backward compatibility with the stub (which had no DB).
  if (options.databaseService === undefined) {
    // Return a minimal stub engine for backward compatibility
    return new StubTaskGraphEngine(options.eventBus)
  }
  return new TaskGraphEngineImpl(options.eventBus, options.databaseService)
}

// ---------------------------------------------------------------------------
// StubTaskGraphEngine (backward compat for callers without a databaseService)
// ---------------------------------------------------------------------------

class StubTaskGraphEngine implements TaskGraphEngine {
  private readonly _eventBus: TypedEventBus

  constructor(eventBus: TypedEventBus) {
    this._eventBus = eventBus
  }

  get state(): OrchestratorState {
    return 'Idle'
  }

  async initialize(): Promise<void> {
    logger.info('TaskGraphEngine.initialize() — stub (no databaseService provided)')

    this._eventBus.on('graph:loaded', ({ sessionId, taskCount, readyCount }) => {
      logger.debug({ sessionId, taskCount, readyCount }, 'graph:loaded')
    })

    this._eventBus.on('graph:paused', (_payload) => {
      logger.debug('graph:paused')
    })

    this._eventBus.on('graph:resumed', (_payload) => {
      logger.debug('graph:resumed')
    })

    this._eventBus.on('task:complete', ({ taskId }) => {
      logger.debug({ taskId }, 'task:complete — update graph state')
    })

    this._eventBus.on('task:failed', ({ taskId, error }) => {
      logger.debug({ taskId, error }, 'task:failed — update graph state')
    })
  }

  async shutdown(): Promise<void> {
    logger.info('TaskGraphEngine.shutdown() — stub')
  }

  async loadGraph(_filePath: string): Promise<string> {
    throw new Error('TaskGraphEngine: databaseService is required to load graphs')
  }

  async loadGraphFromString(_content: string, _format: GraphFormat): Promise<string> {
    throw new Error('TaskGraphEngine: databaseService is required to load graphs')
  }

  startExecution(_sessionId: string, _maxConcurrency: number): void {
    throw new Error('TaskGraphEngine: databaseService is required to start execution')
  }

  markTaskRunning(_taskId: string, _workerId: string): void {
    throw new Error('TaskGraphEngine: databaseService is required')
  }

  markTaskComplete(_taskId: string, _result: string, _costUsd?: number): void {
    throw new Error('TaskGraphEngine: databaseService is required')
  }

  markTaskFailed(_taskId: string, _error: string, _exitCode?: number): void {
    throw new Error('TaskGraphEngine: databaseService is required')
  }

  markTaskCancelled(_taskId: string): void {
    throw new Error('TaskGraphEngine: databaseService is required')
  }

  getReadyTasks(_sessionId: string): Task[] {
    throw new Error('TaskGraphEngine: databaseService is required')
  }

  getTask(_taskId: string): Task | undefined {
    throw new Error('TaskGraphEngine: databaseService is required')
  }

  getAllTasks(_sessionId: string): Task[] {
    throw new Error('TaskGraphEngine: databaseService is required')
  }

  getTasksByStatus(_sessionId: string, _status: string): Task[] {
    throw new Error('TaskGraphEngine: databaseService is required')
  }

  pause(): void {
    throw new Error('TaskGraphEngine: databaseService is required')
  }

  resume(): void {
    throw new Error('TaskGraphEngine: databaseService is required')
  }

  cancelAll(): void {
    throw new Error('TaskGraphEngine: databaseService is required')
  }
}
