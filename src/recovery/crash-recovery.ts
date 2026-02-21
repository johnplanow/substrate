/**
 * CrashRecoveryManager — identifies stuck tasks after a crash and re-queues them.
 *
 * Responsibilities:
 *  - Find all tasks in 'running' state (orphaned after a crash)
 *  - Re-queue retryable tasks (retry_count < max_retries) back to 'pending'
 *  - Mark exhausted tasks as 'failed'
 *  - Clean up orphaned worktrees (if GitWorktreeManager provided)
 *  - Find and archive interrupted sessions
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { GitWorktreeManager } from '../modules/git-worktree/git-worktree-manager.js'
import type { Session } from '../persistence/queries/sessions.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('crash-recovery')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecoveryAction {
  taskId: string
  action: 'requeued' | 'failed'
  reason: string
}

export interface RecoveryResult {
  /** Tasks reset to pending */
  recovered: number
  /** Tasks set to failed (retries exhausted) */
  failed: number
  /** Tasks now appearing in ready_tasks view */
  newlyReady: number
  actions: RecoveryAction[]
}

export interface CrashRecoveryManagerOptions {
  db: BetterSqlite3Database
  gitWorktreeManager?: GitWorktreeManager
}

// ---------------------------------------------------------------------------
// CrashRecoveryManager
// ---------------------------------------------------------------------------

export class CrashRecoveryManager {
  private readonly db: BetterSqlite3Database
  private readonly gitWorktreeManager?: GitWorktreeManager

  constructor(options: CrashRecoveryManagerOptions) {
    this.db = options.db
    this.gitWorktreeManager = options.gitWorktreeManager
  }

  /**
   * Recover from a crash by re-queuing stuck tasks and cleaning up orphaned worktrees.
   *
   * @param sessionId - If provided, only recover tasks for this session; otherwise recover all
   */
  recover(sessionId?: string): RecoveryResult {
    const db = this.db

    // Find all stuck tasks (running at time of crash)
    const stuckTasks = sessionId !== undefined
      ? db.prepare(
          "SELECT * FROM tasks WHERE session_id = ? AND status = 'running'",
        ).all(sessionId) as Array<{ id: string; retry_count: number; max_retries: number; session_id: string }>
      : db.prepare(
          "SELECT * FROM tasks WHERE status = 'running'",
        ).all() as Array<{ id: string; retry_count: number; max_retries: number; session_id: string }>

    const actions: RecoveryAction[] = []
    let recovered = 0
    let failed = 0

    const requeueStmt = db.prepare(`
      UPDATE tasks
      SET status = 'pending',
          retry_count = retry_count + 1,
          worker_id = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `)

    const failStmt = db.prepare(`
      UPDATE tasks
      SET status = 'failed',
          error = 'Process crashed and max retries exceeded',
          worker_id = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `)

    for (const task of stuckTasks) {
      if (task.retry_count < task.max_retries) {
        requeueStmt.run(task.id)
        recovered++
        actions.push({
          taskId: task.id,
          action: 'requeued',
          reason: `retry_count ${task.retry_count} < max_retries ${task.max_retries}`,
        })
      } else {
        failStmt.run(task.id)
        failed++
        actions.push({
          taskId: task.id,
          action: 'failed',
          reason: `retry_count ${task.retry_count} >= max_retries ${task.max_retries}`,
        })
      }
    }

    // Clean up orphaned worktrees if available
    if (this.gitWorktreeManager !== undefined) {
      // Fire and forget — don't await in synchronous context
      this.cleanupOrphanedWorktrees().catch((err: unknown) => {
        logger.warn({ err }, 'Worktree cleanup failed during recovery (non-fatal)')
      })
    }

    // Count newly ready tasks
    let newlyReady = 0
    if (sessionId !== undefined) {
      const row = db.prepare(
        "SELECT COUNT(*) as count FROM ready_tasks WHERE session_id = ?",
      ).get(sessionId) as { count: number }
      newlyReady = row.count
    } else {
      const row = db.prepare(
        "SELECT COUNT(*) as count FROM ready_tasks",
      ).get() as { count: number }
      newlyReady = row.count
    }

    logger.info(
      { event: 'recovery:complete', recovered, failed, newlyReady },
      `Recovery complete: recovered=${recovered} failed=${failed} newlyReady=${newlyReady}`,
    )

    return { recovered, failed, newlyReady, actions }
  }

  /**
   * Clean up all orphaned worktrees via the GitWorktreeManager.
   *
   * @returns Count of worktrees cleaned up
   */
  async cleanupOrphanedWorktrees(): Promise<number> {
    if (this.gitWorktreeManager === undefined) {
      return 0
    }
    try {
      const count = await this.gitWorktreeManager.cleanupAllWorktrees()
      logger.info({ count }, 'Cleaned up orphaned worktrees')
      return count
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up orphaned worktrees — continuing')
      return 0
    }
  }

  /**
   * Find the most recent interrupted session.
   *
   * @param db - BetterSqlite3 database instance
   * @returns The interrupted session, or undefined if none found
   */
  static findInterruptedSession(db: BetterSqlite3Database): Session | undefined {
    const row = db.prepare(
      "SELECT * FROM sessions WHERE status = 'interrupted' ORDER BY created_at DESC LIMIT 1",
    ).get() as Session | undefined
    return row
  }

  /**
   * Archive an interrupted session by setting its status to 'abandoned'.
   *
   * @param db        - BetterSqlite3 database instance
   * @param sessionId - Session to archive
   */
  static archiveSession(db: BetterSqlite3Database, sessionId: string): void {
    db.prepare(`
      UPDATE sessions
      SET status = 'abandoned',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(sessionId)
  }
}
