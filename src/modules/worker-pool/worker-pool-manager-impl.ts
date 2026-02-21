/**
 * WorkerPoolManagerImpl — concrete implementation of WorkerPoolManager.
 *
 * Subscribes to worktree:created events (emitted by GitWorktreeManager after
 * a worktree is created for a task). This eliminates the race condition where
 * workers could be spawned before their worktree was ready.
 *
 * Integrates with TaskGraphEngine to update task state (running / complete / failed).
 */

import { randomUUID } from 'node:crypto'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import type { WorkerAdapter } from '../../adapters/worker-adapter.js'
import type { TaskGraphEngine } from '../task-graph/task-graph-engine.js'
import type { DatabaseService } from '../../persistence/database.js'
import { getTask } from '../../persistence/queries/tasks.js'
import type { Task } from '../../persistence/queries/tasks.js'
import type { TaskResult as AdapterTaskResult } from '../../adapters/types.js'
import type { TaskResult as EventTaskResult } from '../../core/event-bus.types.js'
import type { SubstrateConfig } from '../config/config-schema.js'
import { WorkerHandle } from './worker-handle.js'
import type { WorkerPoolManager, WorkerInfo } from './worker-pool-manager.js'
import type { GitWorktreeManager } from '../git-worktree/git-worktree-manager.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('worker-pool')

// Grace period (ms) between SIGTERM and SIGKILL during terminateAll()
const TERMINATE_GRACE_MS = 5_000

// ---------------------------------------------------------------------------
// Internal tracking type
// ---------------------------------------------------------------------------

interface ActiveWorkerEntry {
  handle: WorkerHandle
  taskId: string
  adapterName: string
  status: 'spawning' | 'running' | 'terminating'
}

// ---------------------------------------------------------------------------
// WorkerPoolManagerImpl
// ---------------------------------------------------------------------------

export class WorkerPoolManagerImpl implements WorkerPoolManager {
  private readonly _eventBus: TypedEventBus
  private readonly _adapterRegistry: AdapterRegistry
  private readonly _engine: TaskGraphEngine
  private readonly _db: DatabaseService
  private readonly _gitWorktreeManager: GitWorktreeManager | null

  /** Max concurrent workers — updated on config:reloaded (AC5) */
  private _maxConcurrency: number | null = null

  private readonly _activeWorkers: Map<string, ActiveWorkerEntry> = new Map()

  /** Bound reference kept so we can call off() in shutdown() */
  private readonly _onWorktreeCreated: (payload: { taskId: string; worktreePath: string; branchName: string }) => void
  private readonly _onConfigReloaded: (payload: { newConfig: SubstrateConfig; changedKeys: string[] }) => void

  constructor(
    eventBus: TypedEventBus,
    adapterRegistry: AdapterRegistry,
    engine: TaskGraphEngine,
    db: DatabaseService,
    gitWorktreeManager: GitWorktreeManager | null = null,
  ) {
    this._eventBus = eventBus
    this._adapterRegistry = adapterRegistry
    this._engine = engine
    this._db = db
    this._gitWorktreeManager = gitWorktreeManager

    // Bind once so we can remove the listener in shutdown()
    this._onWorktreeCreated = ({ taskId, worktreePath, branchName }: { taskId: string; worktreePath: string; branchName: string }) => {
      this._handleWorktreeCreated(taskId, worktreePath, branchName)
    }

    this._onConfigReloaded = ({ newConfig }: { newConfig: SubstrateConfig; changedKeys: string[] }) => {
      this._handleConfigReloaded(newConfig)
    }
  }

  // ---------------------------------------------------------------------------
  // BaseService lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    logger.info('WorkerPoolManager.initialize()')
    this._eventBus.on('worktree:created', this._onWorktreeCreated)
    this._eventBus.on('config:reloaded', this._onConfigReloaded as Parameters<typeof this._eventBus.on>[1])
  }

  async shutdown(): Promise<void> {
    logger.info('WorkerPoolManager.shutdown()')
    this._eventBus.off('worktree:created', this._onWorktreeCreated)
    this._eventBus.off('config:reloaded', this._onConfigReloaded as Parameters<typeof this._eventBus.off>[1])
    await this.terminateAll()
  }

  // ---------------------------------------------------------------------------
  // worktree:created handler
  // ---------------------------------------------------------------------------

  private _handleWorktreeCreated(taskId: string, worktreePath: string, _branchName: string): void {
    logger.debug({ taskId, worktreePath }, 'worktree:created received')

    // Look up full task from DB
    const task = getTask(this._db.db, taskId)
    if (task === undefined) {
      logger.warn({ taskId }, 'worktree:created — task not found in DB, skipping')
      return
    }

    // Look up adapter
    const agentId = task.agent ?? undefined
    if (agentId === undefined) {
      logger.warn({ taskId }, 'worktree:created — task has no agent, emitting task:failed')
      this._eventBus.emit('task:failed', {
        taskId,
        error: {
          message: `Task "${taskId}" has no agent specified`,
          code: 'NO_AGENT',
        },
      })
      return
    }

    const adapter = this._adapterRegistry.get(agentId)
    if (adapter === undefined) {
      logger.warn({ taskId, agentId }, 'worktree:created — no adapter found, emitting task:failed')
      this._eventBus.emit('task:failed', {
        taskId,
        error: {
          message: `No adapter registered for agent "${agentId}"`,
          code: 'ADAPTER_NOT_FOUND',
        },
      })
      return
    }

    // Use the worktreePath from the event — the worktree is guaranteed to exist
    this.spawnWorker(task, adapter, worktreePath)
  }

  // ---------------------------------------------------------------------------
  // config:reloaded handler (AC5)
  // ---------------------------------------------------------------------------

  private _handleConfigReloaded(newConfig: SubstrateConfig): void {
    const newLimit = newConfig.global.max_concurrent_tasks ?? this._maxConcurrency
    if (newLimit !== null && newLimit !== this._maxConcurrency) {
      this._maxConcurrency = newLimit
      logger.info({ maxConcurrency: newLimit }, `Concurrency limit updated to ${newLimit} from config reload`)
    }
  }

  // ---------------------------------------------------------------------------
  // WorkerPoolManager interface
  // ---------------------------------------------------------------------------

  spawnWorker(task: Task, adapter: WorkerAdapter, worktreePath: string): WorkerHandle {
    const workerId = randomUUID()
    const taskId = task.id

    logger.debug({ taskId, workerId, adapter: adapter.id }, 'spawnWorker: building command')

    // Build the spawn command
    const cmd = adapter.buildCommand(task.prompt, {
      worktreePath,
      billingMode: 'subscription',
    })

    // Emit task:started BEFORE spawning
    this._eventBus.emit('task:started', {
      taskId,
      workerId,
      agent: adapter.id,
    })

    // Create callbacks
    const onComplete = (stdout: string, stderr: string, exitCode: number) => {
      logger.debug({ taskId, workerId, exitCode }, 'worker onComplete')

      // Parse output via adapter
      const adapterResult: AdapterTaskResult = adapter.parseOutput(stdout, stderr, exitCode)

      // Map adapter TaskResult → event bus TaskResult
      const eventResult: EventTaskResult = {
        output: adapterResult.output,
        exitCode: adapterResult.exitCode,
        tokensUsed: adapterResult.metadata?.tokensUsed?.total,
        costUsd: undefined,
      }

      // Remove from pool
      this._activeWorkers.delete(workerId)

      // Emit task:complete — the TaskGraphEngine subscribes to this event
      // and calls markTaskComplete internally. Do NOT call engine.markTaskComplete
      // directly here to avoid double-updating DB state.
      this._eventBus.emit('task:complete', {
        taskId,
        result: eventResult,
      })
    }

    const onError = (stderr: string, exitCode: number) => {
      logger.debug({ taskId, workerId, exitCode }, 'worker onError')

      // Remove from pool
      this._activeWorkers.delete(workerId)

      // Emit task:failed — the TaskGraphEngine subscribes to this event
      // and calls markTaskFailed internally. Do NOT call engine.markTaskFailed
      // directly here to avoid double-updating DB state.
      this._eventBus.emit('task:failed', {
        taskId,
        error: {
          message: stderr,
          code: String(exitCode),
        },
      })
    }

    // Create and start the handle
    const handle = new WorkerHandle(
      workerId,
      taskId,
      adapter.id,
      cmd,
      onComplete,
      onError,
    )

    // Track in pool as 'spawning' before start()
    this._activeWorkers.set(workerId, {
      handle,
      taskId,
      adapterName: adapter.id,
      status: 'spawning',
    })

    // Start the process
    handle.start()

    // Transition to 'running' and update graph engine
    const entry = this._activeWorkers.get(workerId)
    if (entry !== undefined) {
      entry.status = 'running'
    }
    this._engine.markTaskRunning(taskId, workerId)

    // Emit worker:spawned after process is started
    this._eventBus.emit('worker:spawned', {
      workerId,
      taskId,
      agent: adapter.id,
    })

    logger.info({ taskId, workerId, adapter: adapter.id }, 'Worker spawned')

    return handle
  }

  terminateWorker(workerId: string, reason: string): void {
    const entry = this._activeWorkers.get(workerId)
    if (entry === undefined) {
      logger.warn({ workerId }, 'terminateWorker: worker not found')
      return
    }

    entry.status = 'terminating'
    entry.handle.terminate('SIGTERM')
    this._activeWorkers.delete(workerId)

    this._eventBus.emit('worker:terminated', { workerId, reason })
    logger.debug({ workerId, reason }, 'Worker terminated')
  }

  async terminateAll(): Promise<void> {
    if (this._activeWorkers.size === 0) {
      return
    }

    logger.info({ count: this._activeWorkers.size }, 'terminateAll: sending SIGTERM to all workers')

    // Snapshot current workers
    const entries = Array.from(this._activeWorkers.entries())

    // Send SIGTERM to all
    for (const [, entry] of entries) {
      entry.status = 'terminating'
      entry.handle.terminate('SIGTERM')
    }

    // Wait for grace period
    await new Promise<void>((resolve) => setTimeout(resolve, TERMINATE_GRACE_MS))

    // Snapshot workers still alive after the grace period (those that did NOT
    // exit naturally — their close handlers would have already removed them
    // from _activeWorkers). We capture this BEFORE sending SIGKILL because
    // SIGKILL may trigger close handlers that remove workers from the map.
    const stillAlive = entries.filter(([workerId]) => this._activeWorkers.has(workerId))

    // SIGKILL any still remaining
    for (const [, entry] of stillAlive) {
      entry.handle.terminate('SIGKILL')
    }

    // Emit worker:terminated for workers that were still alive after the grace
    // period (i.e., required forced termination).
    for (const [workerId] of stillAlive) {
      this._eventBus.emit('worker:terminated', {
        workerId,
        reason: 'terminateAll',
      })
    }

    this._activeWorkers.clear()
    logger.info('terminateAll: all workers terminated')
  }

  getActiveWorkers(): WorkerInfo[] {
    const now = Date.now()
    return Array.from(this._activeWorkers.entries()).map(([workerId, entry]) => ({
      workerId,
      taskId: entry.taskId,
      adapter: entry.adapterName,
      status: entry.status,
      startedAt: entry.handle.startedAt,
      elapsedMs: now - entry.handle.startedAt.getTime(),
    }))
  }

  getWorkerCount(): number {
    return this._activeWorkers.size
  }

  getWorker(workerId: string): WorkerInfo | null {
    const entry = this._activeWorkers.get(workerId)
    if (entry === undefined) {
      return null
    }
    const now = Date.now()
    return {
      workerId,
      taskId: entry.taskId,
      adapter: entry.adapterName,
      status: entry.status,
      startedAt: entry.handle.startedAt,
      elapsedMs: now - entry.handle.startedAt.getTime(),
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface WorkerPoolManagerOptions {
  eventBus: TypedEventBus
  adapterRegistry: AdapterRegistry
  engine: TaskGraphEngine
  db: DatabaseService
  gitWorktreeManager?: GitWorktreeManager | null
}

export function createWorkerPoolManager(options: WorkerPoolManagerOptions): WorkerPoolManager {
  return new WorkerPoolManagerImpl(
    options.eventBus,
    options.adapterRegistry,
    options.engine,
    options.db,
    options.gitWorktreeManager ?? null,
  )
}
