/**
 * GitWorktreeManagerImpl — concrete implementation of GitWorktreeManager.
 *
 * Subscribes to task:ready events to create worktrees and to
 * task:complete / task:failed events to clean them up.
 *
 * Architecture constraints:
 *  - Uses child_process.spawn for all git operations (via git-utils)
 *  - Branch names: "substrate/task-{taskId}"
 *  - Worktree path: {projectRoot}/.substrate-worktrees/{taskId}
 *  - Implements BaseService lifecycle (initialize / shutdown)
 */

import * as path from 'node:path'
import { access } from 'node:fs/promises'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { DatabaseService } from '../../persistence/database.js'
import { getTask, updateTaskWorktree } from '../../persistence/queries/tasks.js'
import { createLogger } from '../../utils/logger.js'
import type { GitWorktreeManager, WorktreeInfo, ConflictReport, MergeResult } from './git-worktree-manager.js'
import * as gitUtils from './git-utils.js'

const logger = createLogger('git-worktree')

// Branch name prefix for substrate task branches
const BRANCH_PREFIX = 'substrate/task-'

// Default base directory for worktrees (relative to projectRoot)
const DEFAULT_WORKTREE_BASE = '.substrate-worktrees'

// ---------------------------------------------------------------------------
// GitWorktreeManagerImpl
// ---------------------------------------------------------------------------

export class GitWorktreeManagerImpl implements GitWorktreeManager {
  private readonly _eventBus: TypedEventBus
  private readonly _projectRoot: string
  private readonly _baseDirectory: string
  private readonly _db: DatabaseService | null

  /** Bound listener references for cleanup in shutdown() */
  private readonly _onTaskReady: (payload: { taskId: string }) => void
  private readonly _onTaskComplete: (payload: { taskId: string }) => void
  private readonly _onTaskFailed: (payload: { taskId: string }) => void

  constructor(
    eventBus: TypedEventBus,
    projectRoot: string,
    baseDirectory: string = DEFAULT_WORKTREE_BASE,
    db: DatabaseService | null = null,
  ) {
    this._eventBus = eventBus
    this._projectRoot = projectRoot
    this._baseDirectory = baseDirectory
    this._db = db

    // Bind listeners once so we can remove them in shutdown()
    // Note: _handleTaskReady is async; it awaits worktree creation and emits
    // worktree:created only after the worktree exists. The WorkerPoolManager
    // subscribes to worktree:created (not task:ready) to avoid race conditions.
    this._onTaskReady = ({ taskId }: { taskId: string }) => {
      this._handleTaskReady(taskId).catch((err) => {
        logger.error({ taskId, err }, 'Unhandled error in _handleTaskReady')
      })
    }
    this._onTaskComplete = ({ taskId }: { taskId: string }) => {
      void this._handleTaskDone(taskId)
    }
    this._onTaskFailed = ({ taskId }: { taskId: string }) => {
      void this._handleTaskDone(taskId)
    }
  }

  // ---------------------------------------------------------------------------
  // BaseService lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    logger.info({ projectRoot: this._projectRoot }, 'GitWorktreeManager.initialize()')

    // AC5: Validate git version on startup
    await this.verifyGitVersion()

    // AC4: Clean up orphaned worktrees from previous crashes
    const cleaned = await this.cleanupAllWorktrees()
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Recovered orphaned worktrees on startup')
    }

    // AC1: Subscribe to task:ready to create worktrees
    this._eventBus.on('task:ready', this._onTaskReady)

    // AC3: Subscribe to completion events to trigger cleanup
    this._eventBus.on('task:complete', this._onTaskComplete)
    this._eventBus.on('task:failed', this._onTaskFailed)

    logger.info('GitWorktreeManager initialized')
  }

  async shutdown(): Promise<void> {
    logger.info('GitWorktreeManager.shutdown()')

    // Unsubscribe from event bus
    this._eventBus.off('task:ready', this._onTaskReady)
    this._eventBus.off('task:complete', this._onTaskComplete)
    this._eventBus.off('task:failed', this._onTaskFailed)

    // Clean up any remaining worktrees
    await this.cleanupAllWorktrees()

    logger.info('GitWorktreeManager shutdown complete')
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private async _handleTaskReady(taskId: string): Promise<void> {
    logger.debug({ taskId }, 'task:ready — creating worktree')
    try {
      await this.createWorktree(taskId)
    } catch (err) {
      logger.error({ taskId, err }, 'Failed to create worktree for task')
    }
  }

  private async _handleTaskDone(taskId: string): Promise<void> {
    logger.debug({ taskId }, 'task done — cleaning up worktree')
    try {
      await this.cleanupWorktree(taskId)
    } catch (err) {
      // Log but don't rethrow — cleanup failure should not block task completion
      logger.warn({ taskId, err }, 'Failed to cleanup worktree for task')
    }
  }

  // ---------------------------------------------------------------------------
  // GitWorktreeManager interface
  // ---------------------------------------------------------------------------

  async createWorktree(taskId: string, baseBranch = 'main'): Promise<WorktreeInfo> {
    if (!taskId || taskId.trim().length === 0) {
      throw new Error('createWorktree: taskId must be a non-empty string')
    }

    const branchName = BRANCH_PREFIX + taskId
    const worktreePath = this.getWorktreePath(taskId)

    logger.debug({ taskId, branchName, worktreePath, baseBranch }, 'createWorktree')

    // Create the worktree via git-utils
    await gitUtils.createWorktree(this._projectRoot, taskId, branchName, baseBranch)

    const createdAt = new Date()

    // AC2: Update Task record with worktree_path field (if DB is available)
    if (this._db !== null) {
      try {
        updateTaskWorktree(this._db.db, taskId, {
          worktree_path: worktreePath,
          worktree_branch: branchName,
        })
      } catch (err) {
        logger.warn({ taskId, err }, 'createWorktree: failed to update task record (task may not be in DB)')
      }
    }

    // AC1: Emit worktree:created event
    this._eventBus.emit('worktree:created', {
      taskId,
      branchName,
      worktreePath,
      createdAt,
    })

    const info: WorktreeInfo = {
      taskId,
      branchName,
      worktreePath,
      createdAt,
    }

    logger.info({ taskId, branchName, worktreePath }, 'Worktree created')
    return info
  }

  async cleanupWorktree(taskId: string): Promise<void> {
    const branchName = BRANCH_PREFIX + taskId
    const worktreePath = this.getWorktreePath(taskId)

    logger.debug({ taskId, branchName, worktreePath }, 'cleanupWorktree')

    // AC5 guard: Check if worktree directory exists before attempting removal.
    // This makes cleanupWorktree idempotent and prevents double-cleanup races
    // (e.g., when WorkerPoolManager emits task:failed for NO_AGENT path).
    let worktreeExists = false
    try {
      await access(worktreePath)
      worktreeExists = true
    } catch {
      // Worktree directory doesn't exist — already cleaned up or never created
      logger.debug({ taskId, worktreePath }, 'cleanupWorktree: worktree does not exist, skipping removal')
    }

    // AC3: Remove worktree directory (only if it exists)
    if (worktreeExists) {
      try {
        await gitUtils.removeWorktree(worktreePath, this._projectRoot)
      } catch (err) {
        logger.warn({ taskId, worktreePath, err }, 'removeWorktree failed during cleanup')
      }
    }

    // AC3: Delete the task branch
    try {
      await gitUtils.removeBranch(branchName, this._projectRoot)
    } catch (err) {
      logger.warn({ taskId, branchName, err }, 'removeBranch failed during cleanup')
    }

    // AC3: Update Task record with cleanup timestamp (if DB is available)
    if (this._db !== null) {
      try {
        updateTaskWorktree(this._db.db, taskId, {
          worktree_cleaned_at: new Date().toISOString(),
        })
      } catch (err) {
        logger.warn({ taskId, err }, 'cleanupWorktree: failed to update task record')
      }
    }

    // AC3: Emit worktree:removed event
    this._eventBus.emit('worktree:removed', {
      taskId,
      branchName,
    })

    logger.info({ taskId, branchName }, 'Worktree cleaned up')
  }

  async cleanupAllWorktrees(): Promise<number> {
    logger.debug({ projectRoot: this._projectRoot }, 'cleanupAllWorktrees')

    const orphanedPaths = await gitUtils.getOrphanedWorktrees(this._projectRoot, this._baseDirectory)
    let cleaned = 0

    for (const worktreePath of orphanedPaths) {
      // Extract taskId from path (last segment of the path)
      const taskId = path.basename(worktreePath)

      // AC4: Check if corresponding task exists and is running (if DB available)
      if (this._db !== null) {
        try {
          const task = getTask(this._db.db, taskId)
          if (task !== undefined && (task.status === 'running' || task.status === 'queued')) {
            // Task is still active — don't clean up
            logger.debug({ taskId }, 'cleanupAllWorktrees: task is still active, skipping')
            continue
          }
        } catch (err) {
          // If we can't check the task, clean up to be safe
          logger.warn({ taskId, err }, 'cleanupAllWorktrees: failed to check task status, cleaning up')
        }
      }

      // AC4: Remove orphaned worktree
      let worktreeRemoved = false
      try {
        await gitUtils.removeWorktree(worktreePath, this._projectRoot)
        worktreeRemoved = true
        logger.debug({ taskId, worktreePath }, 'cleanupAllWorktrees: removed orphaned worktree')
      } catch (err) {
        logger.warn({ taskId, worktreePath, err }, 'cleanupAllWorktrees: failed to remove worktree')
      }

      // AC4: Remove orphaned branch
      const branchName = BRANCH_PREFIX + taskId
      let branchRemoved = false
      try {
        branchRemoved = await gitUtils.removeBranch(branchName, this._projectRoot)
        if (branchRemoved) {
          logger.debug({ taskId, branchName }, 'cleanupAllWorktrees: removed orphaned branch')
        }
      } catch (err) {
        logger.warn({ taskId, branchName, err }, 'cleanupAllWorktrees: failed to remove branch')
      }

      // Only count as cleaned if worktree removal succeeded
      if (worktreeRemoved) {
        cleaned++
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'cleanupAllWorktrees: recovered orphaned worktrees')
    }

    return cleaned
  }

  async detectConflicts(taskId: string, targetBranch = 'main'): Promise<ConflictReport> {
    if (!taskId || taskId.trim().length === 0) {
      throw new Error('detectConflicts: taskId must be a non-empty string')
    }

    const branchName = BRANCH_PREFIX + taskId
    const worktreePath = this.getWorktreePath(taskId)

    logger.debug({ taskId, branchName, targetBranch }, 'detectConflicts')

    // Verify the worktree exists
    try {
      await access(worktreePath)
    } catch {
      throw new Error(
        `detectConflicts: Worktree for task "${taskId}" not found at "${worktreePath}". ` +
        `The worktree may have already been cleaned up.`,
      )
    }

    // AC1: Run simulated merge on the project root (target branch working dir)
    // We simulate the merge from the project root perspective, where the target branch is checked out
    const mergeClean = await gitUtils.simulateMerge(branchName, this._projectRoot)

    let conflictingFiles: string[] = []

    try {
      if (!mergeClean) {
        // Get the list of conflicting files
        conflictingFiles = await gitUtils.getConflictingFiles(this._projectRoot)
      }
    } finally {
      // AC1: Always abort the simulated merge to clean up state
      await gitUtils.abortMerge(this._projectRoot)
    }

    const report: ConflictReport = {
      hasConflicts: !mergeClean || conflictingFiles.length > 0,
      conflictingFiles,
      taskId,
      targetBranch,
    }

    // AC3: Emit worktree:conflict event if conflicts exist
    if (report.hasConflicts) {
      this._eventBus.emit('worktree:conflict', {
        taskId,
        branch: branchName,
        conflictingFiles: report.conflictingFiles,
      })
    }

    logger.info({ taskId, hasConflicts: report.hasConflicts, conflictCount: conflictingFiles.length }, 'Conflict detection complete')
    return report
  }

  async mergeWorktree(taskId: string, targetBranch = 'main'): Promise<MergeResult> {
    if (!taskId || taskId.trim().length === 0) {
      throw new Error('mergeWorktree: taskId must be a non-empty string')
    }

    const branchName = BRANCH_PREFIX + taskId

    logger.debug({ taskId, branchName, targetBranch }, 'mergeWorktree')

    // AC2: Call detectConflicts() first to check for conflicts (also verifies worktree exists)
    const conflictReport = await this.detectConflicts(taskId, targetBranch)

    if (conflictReport.hasConflicts) {
      // AC3: Return failure result without attempting merge
      logger.info({ taskId, conflictCount: conflictReport.conflictingFiles.length }, 'Merge skipped due to conflicts')
      return {
        success: false,
        mergedFiles: [],
        conflicts: conflictReport,
      }
    }

    // AC2: Perform actual merge
    const mergeSuccess = await gitUtils.performMerge(branchName, this._projectRoot)

    if (!mergeSuccess) {
      throw new Error(`mergeWorktree: git merge --no-ff failed for task "${taskId}" branch "${branchName}"`)
    }

    // AC2: Get the list of merged files
    const mergedFiles = await gitUtils.getMergedFiles(this._projectRoot)

    // AC2: Emit worktree:merged event
    this._eventBus.emit('worktree:merged', {
      taskId,
      branch: branchName,
      mergedFiles,
    })

    // Update task record with merge info (if DB is available)
    if (this._db !== null) {
      try {
        updateTaskWorktree(this._db.db, taskId, {
          worktree_cleaned_at: new Date().toISOString(),
        })
      } catch (err) {
        logger.warn({ taskId, err }, 'mergeWorktree: failed to update task record after merge')
      }
    }

    const result: MergeResult = {
      success: true,
      mergedFiles,
    }

    logger.info({ taskId, branchName, mergedFileCount: mergedFiles.length }, 'Worktree merged successfully')
    return result
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    logger.debug({ projectRoot: this._projectRoot, baseDirectory: this._baseDirectory }, 'listWorktrees')

    const worktreePaths = await gitUtils.getOrphanedWorktrees(this._projectRoot, this._baseDirectory)
    const results: WorktreeInfo[] = []

    for (const worktreePath of worktreePaths) {
      const taskId = path.basename(worktreePath)
      const branchName = BRANCH_PREFIX + taskId

      // Try to get the creation time from the worktree directory
      let createdAt: Date
      try {
        const { stat } = await import('node:fs/promises')
        const stats = await stat(worktreePath)
        createdAt = stats.birthtime ?? stats.ctime
      } catch {
        // If we can't stat the directory, use current time as fallback
        createdAt = new Date()
      }

      results.push({
        taskId,
        branchName,
        worktreePath,
        createdAt,
      })
    }

    logger.debug({ count: results.length }, 'listWorktrees: found worktrees')
    return results
  }

  getWorktreePath(taskId: string): string {
    // AC6: Return consistent path {projectRoot}/.substrate-worktrees/{taskId}
    return path.join(this._projectRoot, this._baseDirectory, taskId)
  }

  async verifyGitVersion(): Promise<void> {
    try {
      await gitUtils.verifyGitVersion()
    } catch (err) {
      throw new Error(`GitWorktreeManager: git version check failed: ${String(err)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface GitWorktreeManagerOptions {
  eventBus: TypedEventBus
  projectRoot: string
  baseDirectory?: string
  db?: DatabaseService | null
}

export function createGitWorktreeManager(options: GitWorktreeManagerOptions): GitWorktreeManager {
  return new GitWorktreeManagerImpl(
    options.eventBus,
    options.projectRoot,
    options.baseDirectory,
    options.db ?? null,
  )
}
