/**
 * `substrate retry` command
 *
 * Re-executes failed tasks from a previous session (FR9, FR39).
 *
 * Usage:
 *   substrate retry <sessionId>                            Retry all failed tasks
 *   substrate retry <sessionId> --task <taskId>           Retry a specific task (AC2)
 *   substrate retry <sessionId> --dry-run                 Show error report without retrying (AC3)
 *   substrate retry <sessionId> --dry-run --output-format json  NDJSON error report (AC4)
 *   substrate retry <sessionId> --follow                  Stream output until retried tasks complete (AC1, AC5)
 *   substrate retry <sessionId> --max-retries <n>         Safety guard (AC8, default: 3)
 *
 * Exit codes:
 *   0   - All retried tasks succeeded (or dry-run / no failures)
 *   1   - Partial success (some succeeded, some failed)
 *   2   - Usage error (session not found, dependency check failed)
 *   4   - All retried tasks failed again
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync } from 'fs'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import {
  fetchFailedTaskDetails,
  renderFailedTasksHuman,
  renderFailedTasksJson,
} from '../formatters/retry-formatter.js'
import { createEventBus } from '../../core/event-bus.js'
import { createDatabaseService } from '../../modules/database/database-service.js'
import { createTaskGraphEngine } from '../../modules/task-graph/task-graph-engine.js'
import { createRoutingEngine } from '../../modules/routing/routing-engine.js'
import { createWorkerPoolManager } from '../../modules/worker-pool/worker-pool-manager-impl.js'
import { createGitWorktreeManager } from '../../modules/git-worktree/git-worktree-manager-impl.js'
import { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { createConfigSystem } from '../../modules/config/config-system-impl.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('retry-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const RETRY_EXIT_SUCCESS = 0
export const RETRY_EXIT_PARTIAL_FAILURE = 1
export const RETRY_EXIT_USAGE_ERROR = 2
export const RETRY_EXIT_ALL_FAILED = 4

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryActionOptions {
  sessionId: string
  taskId?: string
  dryRun: boolean
  follow: boolean
  outputFormat: 'human' | 'json'
  maxRetries: number
  projectRoot: string
  version?: string
}

// ---------------------------------------------------------------------------
// validateTaskDependencies — AC2
// ---------------------------------------------------------------------------

/**
 * Validate that all dependencies of a task are completed.
 *
 * Returns `{ valid: true, blockedBy: [] }` if all deps are completed,
 * or `{ valid: false, blockedBy: [<dep1>, ...] }` if some are not.
 */
export function validateTaskDependencies(
  db: import('better-sqlite3').Database,
  _sessionId: string,
  taskId: string,
): { valid: boolean; blockedBy: string[] } {
  const deps = db
    .prepare(
      `SELECT d.depends_on AS dependency_id, t.status
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on
       WHERE d.task_id = ?`,
    )
    .all(taskId) as Array<{ dependency_id: string; status: string }>

  const unmet = deps.filter((d) => d.status !== 'completed').map((d) => d.dependency_id)

  return { valid: unmet.length === 0, blockedBy: unmet }
}

// ---------------------------------------------------------------------------
// runRetryAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the retry command.
 *
 * Returns exit code. Separated from Commander integration for testability.
 */
export async function runRetryAction(options: RetryActionOptions): Promise<number> {
  const {
    sessionId,
    taskId: specificTaskId,
    dryRun,
    follow,
    outputFormat,
    maxRetries,
    projectRoot,
  } = options

  const dbPath = join(projectRoot, '.substrate', 'state.db')

  if (!existsSync(dbPath)) {
    process.stderr.write(
      `Error: No Substrate database found at ${dbPath}. Run 'substrate init' first.\n`,
    )
    return RETRY_EXIT_USAGE_ERROR
  }

  let wrapper: DatabaseWrapper | null = null

  try {
    wrapper = new DatabaseWrapper(dbPath)
    wrapper.open()
    const db = wrapper.db

    // Run migrations to ensure schema is up-to-date
    runMigrations(db)

    // AC6: Query session by ID; if not found → stderr + exit 2
    const session = db
      .prepare('SELECT id, status FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; status: string } | undefined

    if (!session) {
      process.stderr.write(`Error: Session not found: ${sessionId}\n`)
      return RETRY_EXIT_USAGE_ERROR
    }

    // Fetch all failed tasks for session
    let failedTasks = fetchFailedTaskDetails(db, sessionId)

    // AC6: If no failed tasks → print message + exit 0
    if (failedTasks.length === 0) {
      process.stdout.write(`No failed tasks found in session ${sessionId}.\n`)
      return RETRY_EXIT_SUCCESS
    }

    // AC2: If --task <taskId>: filter to that one task; validate dependencies
    if (specificTaskId !== undefined) {
      const targetTask = failedTasks.find((t) => t.taskId === specificTaskId)
      if (!targetTask) {
        // Task might not be in the failed list — check if it exists at all
        const taskRow = db
          .prepare('SELECT id, status FROM tasks WHERE id = ? AND session_id = ?')
          .get(specificTaskId, sessionId) as { id: string; status: string } | undefined

        if (!taskRow) {
          process.stderr.write(
            `Error: Task not found: ${specificTaskId} in session ${sessionId}\n`,
          )
          return RETRY_EXIT_USAGE_ERROR
        }

        process.stderr.write(
          `Error: Task ${specificTaskId} is not in failed status (current: ${taskRow.status})\n`,
        )
        return RETRY_EXIT_USAGE_ERROR
      }

      // Validate dependencies are all completed
      const depCheck = validateTaskDependencies(db, sessionId, specificTaskId)
      if (!depCheck.valid) {
        process.stderr.write(
          `Error: Cannot retry task ${specificTaskId}: dependencies [${depCheck.blockedBy.join(', ')}] are not completed.\n`,
        )
        return RETRY_EXIT_USAGE_ERROR
      }

      failedTasks = [targetTask]
    }

    // AC8: Apply --max-retries filter: skip tasks where retry_count >= maxRetries
    const eligibleTasks = failedTasks.filter((t) => t.retryCount < maxRetries)
    const skippedTasks = failedTasks.filter((t) => t.retryCount >= maxRetries)

    // AC3: If --dry-run: render error report and exit 0
    if (dryRun) {
      if (outputFormat === 'json') {
        // AC4: NDJSON output
        renderFailedTasksJson(failedTasks)
      } else {
        // AC3: Human-readable ASCII table
        process.stdout.write(renderFailedTasksHuman(sessionId, failedTasks) + '\n')
      }
      return RETRY_EXIT_SUCCESS
    }

    // If all tasks exceeded max-retries
    if (eligibleTasks.length === 0) {
      process.stdout.write(
        `No failed tasks found in session ${sessionId}.\n`,
      )
      if (skippedTasks.length > 0) {
        process.stdout.write(
          `${skippedTasks.length} task(s) skipped (exceeded max-retries of ${maxRetries}).\n`,
        )
      }
      return RETRY_EXIT_SUCCESS
    }

    const eligibleTaskIds = eligibleTasks.map((t) => t.taskId)

    // Reset eligible failed tasks to pending and increment retry_count, then write resume signal
    db.transaction(() => {
      for (const tId of eligibleTaskIds) {
        db.prepare(
          `UPDATE tasks
           SET status = 'pending', retry_count = retry_count + 1, error = NULL, exit_code = NULL, completed_at = NULL
           WHERE id = ?`,
        ).run(tId)
      }
      db.prepare(
        `INSERT INTO session_signals (session_id, signal, created_at)
         VALUES (?, 'resume', datetime('now'))`,
      ).run(sessionId)
    })()

    // Print summary
    if (specificTaskId !== undefined) {
      process.stdout.write(`Retrying task ${specificTaskId} in session ${sessionId}.\n`)
    } else {
      process.stdout.write(`Retrying ${eligibleTaskIds.length} failed tasks in session ${sessionId}.\n`)
    }

    if (skippedTasks.length > 0) {
      process.stdout.write(
        `${skippedTasks.length} task(s) skipped (exceeded max-retries of ${maxRetries}).\n`,
      )
    }

    // AC5: If --follow: spin up the full orchestrator and stream output
    if (follow) {
      // Close the db-only wrapper before initializing the full stack
      wrapper.close()
      wrapper = null

      return await runFollowMode({
        sessionId,
        eligibleTaskIds,
        projectRoot,
        outputFormat,
      })
    }

    return RETRY_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runRetryAction failed')
    return RETRY_EXIT_USAGE_ERROR
  } finally {
    if (wrapper !== null) {
      try {
        wrapper.close()
      } catch {
        // Ignore close errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// runFollowMode — AC1, AC5
// ---------------------------------------------------------------------------

/**
 * Run the full orchestrator wiring and stream output until the retried tasks complete.
 *
 * Exit codes (AC5):
 *   0 — all retried tasks succeeded
 *   1 — partial success (some succeeded, some failed)
 *   4 — all retried tasks failed again
 */
async function runFollowMode(opts: {
  sessionId: string
  eligibleTaskIds: string[]
  projectRoot: string
  outputFormat: 'human' | 'json'
}): Promise<number> {
  const { sessionId, eligibleTaskIds, projectRoot, outputFormat } = opts

  const dbPath = join(projectRoot, '.substrate', 'state.db')

  const eventBus = createEventBus()
  const databaseService = createDatabaseService(dbPath)
  const configSystem = createConfigSystem({ projectRoot })
  await configSystem.load()
  const config = configSystem.getConfig()
  const resolvedMaxConcurrency = config.global?.max_concurrent_workers ?? config.global?.max_concurrent_tasks ?? 4

  const taskGraphEngine = createTaskGraphEngine({ eventBus, databaseService })
  const adapterRegistry = new AdapterRegistry()
  const gitWorktreeManager = createGitWorktreeManager({
    eventBus,
    projectRoot,
    db: databaseService,
  })
  const routingEngine = createRoutingEngine({ eventBus, adapterRegistry })
  const workerPoolManager = createWorkerPoolManager({
    eventBus,
    adapterRegistry,
    engine: taskGraphEngine,
    db: databaseService,
    gitWorktreeManager,
  })

  try {
    await databaseService.initialize()
    await taskGraphEngine.initialize()
    await adapterRegistry.discoverAndRegister()
    await gitWorktreeManager.initialize()
    await routingEngine.initialize()
    await workerPoolManager.initialize()

    // Track completed and failed retried tasks
    const succeededRetried = new Set<string>()
    const failedRetried = new Set<string>()

    // Set up event listeners
    if (outputFormat === 'json') {
      eventBus.on('task:started', (payload) => {
        if (eligibleTaskIds.includes((payload as { taskId: string }).taskId)) {
          const line = JSON.stringify({
            event: 'task:started',
            timestamp: new Date().toISOString(),
            data: { taskId: (payload as { taskId: string }).taskId },
          })
          process.stdout.write(line + '\n')
        }
      })
      eventBus.on('task:complete', (payload) => {
        const tId = (payload as { taskId: string }).taskId
        if (eligibleTaskIds.includes(tId)) {
          succeededRetried.add(tId)
          const line = JSON.stringify({
            event: 'task:complete',
            timestamp: new Date().toISOString(),
            data: { taskId: tId },
          })
          process.stdout.write(line + '\n')
        }
      })
      eventBus.on('task:failed', (payload) => {
        const tId = (payload as { taskId: string }).taskId
        if (eligibleTaskIds.includes(tId)) {
          failedRetried.add(tId)
          const line = JSON.stringify({
            event: 'task:failed',
            timestamp: new Date().toISOString(),
            data: {
              taskId: tId,
              error: (payload as { error: { message: string } }).error?.message,
            },
          })
          process.stdout.write(line + '\n')
        }
      })
    } else {
      eventBus.on('task:started', (payload) => {
        const p = payload as { taskId: string; agent?: string }
        if (eligibleTaskIds.includes(p.taskId)) {
          process.stdout.write(`→ [running] ${p.taskId} (agent: ${p.agent ?? 'unknown'})\n`)
        }
      })
      eventBus.on('task:complete', (payload) => {
        const p = payload as { taskId: string; result?: { costUsd?: number } }
        if (eligibleTaskIds.includes(p.taskId)) {
          succeededRetried.add(p.taskId)
          const cost = p.result?.costUsd !== undefined ? `$${p.result.costUsd.toFixed(2)}` : 'N/A'
          process.stdout.write(`✓ [complete] ${p.taskId} (cost: ${cost})\n`)
        }
      })
      eventBus.on('task:failed', (payload) => {
        const p = payload as { taskId: string; error: { message: string } }
        if (eligibleTaskIds.includes(p.taskId)) {
          failedRetried.add(p.taskId)
          process.stdout.write(`✗ [failed] ${p.taskId}: ${p.error?.message}\n`)
        }
      })
    }

    // Wait for graph:complete or graph:cancelled
    const done = new Promise<{ exitCode: number }>((resolve) => {
      eventBus.on('graph:complete', () => {
        const succeeded = succeededRetried.size
        const failed = failedRetried.size
        const total = eligibleTaskIds.length

        if (outputFormat === 'human') {
          process.stdout.write(
            `\nRetry complete: ${succeeded}/${total} succeeded, ${failed} failed\n`,
          )
        }

        // AC5 exit codes
        if (failed === 0) {
          resolve({ exitCode: RETRY_EXIT_SUCCESS })
        } else if (succeeded === 0) {
          resolve({ exitCode: RETRY_EXIT_ALL_FAILED })
        } else {
          resolve({ exitCode: RETRY_EXIT_PARTIAL_FAILURE })
        }
      })

      eventBus.on('graph:cancelled', () => {
        resolve({ exitCode: RETRY_EXIT_PARTIAL_FAILURE })
      })
    })

    // Register signal handlers
    const sigintHandler = () => {
      logger.info('SIGINT received — initiating graceful shutdown')
      taskGraphEngine.cancelAll()
    }
    const sigtermHandler = () => {
      logger.info('SIGTERM received — initiating graceful shutdown')
      taskGraphEngine.cancelAll()
    }
    process.once('SIGINT', sigintHandler)
    process.once('SIGTERM', sigtermHandler)

    // Start execution for the session (tasks are already reset to pending)
    taskGraphEngine.startExecution(sessionId, resolvedMaxConcurrency)

    const result = await done

    process.removeListener('SIGINT', sigintHandler)
    process.removeListener('SIGTERM', sigtermHandler)

    return result.exitCode
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runFollowMode failed')
    return RETRY_EXIT_USAGE_ERROR
  } finally {
    try { await workerPoolManager.shutdown() } catch { /* ignore */ }
    try { await routingEngine.shutdown() } catch { /* ignore */ }
    try { await gitWorktreeManager.shutdown() } catch { /* ignore */ }
    try { await taskGraphEngine.shutdown() } catch { /* ignore */ }
    try { await databaseService.shutdown() } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// registerRetryCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate retry` command with the CLI program.
 *
 * @param program     - Commander program instance
 * @param version     - Current Substrate package version
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerRetryCommand(
  program: Command,
  version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('retry <sessionId>')
    .description('Re-execute failed tasks from a previous session')
    .option('--task <taskId>', 'Retry a specific task by ID')
    .option('--dry-run', 'Show error report without retrying any tasks', false)
    .option('--follow', 'Stream output until retried tasks complete', false)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json (NDJSON)',
      'human',
    )
    .option(
      '--max-retries <n>',
      'Maximum number of times a task can be retried (default: 3)',
      '3',
    )
    .action(
      async (
        sessionId: string,
        opts: {
          task?: string
          dryRun: boolean
          follow: boolean
          outputFormat: string
          maxRetries: string
        },
      ) => {
        const outputFormat: 'human' | 'json' = opts.outputFormat === 'json' ? 'json' : 'human'
        const maxRetries = parseInt(opts.maxRetries, 10) || 3

        const exitCode = await runRetryAction({
          sessionId,
          taskId: opts.task,
          dryRun: opts.dryRun,
          follow: opts.follow,
          outputFormat,
          maxRetries,
          projectRoot,
          version,
        })

        process.exitCode = exitCode
      },
    )
}
