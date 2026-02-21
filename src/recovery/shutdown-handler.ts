/**
 * setupGracefulShutdown — registers SIGTERM and SIGINT handlers for clean process exit.
 *
 * On signal receipt:
 *  1. Pauses the task graph engine (stops scheduling new tasks)
 *  2. Terminates all workers (with grace period)
 *  3. Marks running tasks as pending (interrupted for re-queue on next start)
 *  4. Marks the active session as 'interrupted'
 *  5. Flushes the WAL checkpoint to disk
 *  6. Exits with code 0
 *
 * Returns a cleanup function that removes the listeners (for test teardown).
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { WorkerPoolManager } from '../modules/worker-pool/worker-pool-manager.js'
import type { TaskGraphEngine } from '../modules/task-graph/task-graph-engine.js'
import type pino from 'pino'
import { createLogger } from '../utils/logger.js'

const defaultLogger = createLogger('shutdown-handler')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShutdownHandlerOptions {
  db: BetterSqlite3Database
  workerPoolManager: WorkerPoolManager
  taskGraphEngine: TaskGraphEngine
  sessionId: string
  logger?: pino.Logger
}

// ---------------------------------------------------------------------------
// setupGracefulShutdown
// ---------------------------------------------------------------------------

/**
 * Register SIGTERM and SIGINT handlers for graceful shutdown.
 *
 * @returns Cleanup function that removes the signal listeners
 */
export function setupGracefulShutdown(options: ShutdownHandlerOptions): () => void {
  const { db, workerPoolManager, taskGraphEngine, sessionId } = options
  const log = options.logger ?? defaultLogger

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'Graceful shutdown initiated')

    // Step 1: Pause scheduling (no new task:ready events)
    try {
      taskGraphEngine.pause()
    } catch {
      // Engine may not be in a pausable state — continue anyway
    }

    // Step 2: Terminate all workers (SIGTERM with 5-second grace, then SIGKILL)
    try {
      await workerPoolManager.terminateAll()
    } catch {
      // Continue even if termination fails
    }

    // Step 3: Mark running tasks as pending (re-queue on next start)
    db.prepare(`
      UPDATE tasks
      SET status = 'pending',
          retry_count = retry_count + 1,
          worker_id = NULL,
          updated_at = datetime('now')
      WHERE session_id = ? AND status = 'running'
    `).run(sessionId)

    // Step 4: Mark session as interrupted
    db.prepare(`
      UPDATE sessions
      SET status = 'interrupted',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(sessionId)

    // Step 5: Flush WAL to disk
    db.pragma('wal_checkpoint(FULL)')

    // Step 6: Log and exit
    log.info('Graceful shutdown complete')
    process.exit(0)
  }

  const sigintHandler = (): void => {
    void shutdown('SIGINT')
  }

  const sigtermHandler = (): void => {
    void shutdown('SIGTERM')
  }

  process.on('SIGINT', sigintHandler)
  process.on('SIGTERM', sigtermHandler)

  // Return cleanup function for test teardown
  return (): void => {
    process.removeListener('SIGINT', sigintHandler)
    process.removeListener('SIGTERM', sigtermHandler)
  }
}
