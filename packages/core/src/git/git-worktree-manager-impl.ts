/**
 * GitWorktreeManagerImpl — concrete implementation of GitWorktreeManager.
 *
 * Subscribes to task:ready events to create worktrees and to
 * task:complete / task:failed events to clean them up.
 *
 * Architecture constraints:
 *  - Uses child_process.spawn for all git operations (via git-utils)
 *  - Branch names: "substrate/story-{taskId}"
 *  - Worktree path: {projectRoot}/.substrate-worktrees/{taskId}
 *  - Implements IBaseService lifecycle (initialize / shutdown)
 */

import * as path from 'node:path'
import { access } from 'node:fs/promises'
import type { TypedEventBus, CoreEvents } from '../events/index.js'
import type { ILogger } from '../dispatch/types.js'
import type { GitWorktreeManager, WorktreeInfo, ConflictReport, MergeResult } from './git-worktree-manager.js'
import * as gitUtils from './git-utils.js'

/**
 * Minimal interface for the legacy db parameter (unused in current implementation,
 * kept for backward compatibility with call sites that pass a db instance).
 */
export interface LegacyDbLike {
  readonly isOpen?: boolean
  readonly db?: Record<string, unknown>
  initialize?(): Promise<void>
  shutdown?(): Promise<void>
}

/**
 * Branch name prefix for substrate per-story branches.
 *
 * Exported as the canonical source of truth so consumers (orchestrator,
 * integration tests, tooling) can compose branch names without
 * independently encoding the prefix. v0.20.82 production bug:
 * `orchestrator-impl.ts:4290` hardcoded `substrate/story-${storyKey}`
 * while this module created `substrate/task-${taskId}` — the resulting
 * merge-to-main looked at a non-existent branch. Recurrence prevention:
 * all branch-name construction MUST import this constant.
 */
export const BRANCH_PREFIX = 'substrate/story-'

// Default base directory for worktrees (relative to projectRoot)
const DEFAULT_WORKTREE_BASE = '.substrate-worktrees'

// ---------------------------------------------------------------------------
// GitWorktreeManagerImpl
// ---------------------------------------------------------------------------

export class GitWorktreeManagerImpl implements GitWorktreeManager {
  private readonly _eventBus: TypedEventBus<CoreEvents>
  private readonly _projectRoot: string
  private readonly _baseDirectory: string
  private readonly _db: LegacyDbLike | null
  private readonly _logger: ILogger

  /** Bound listener references for cleanup in shutdown() */
  private readonly _onTaskReady: (payload: { taskId: string }) => void
  private readonly _onTaskComplete: (payload: { taskId: string }) => void
  private readonly _onTaskFailed: (payload: { taskId: string }) => void

  constructor(
    eventBus: TypedEventBus<CoreEvents>,
    projectRoot: string,
    baseDirectory: string = DEFAULT_WORKTREE_BASE,
    db: LegacyDbLike | null = null,
    logger?: ILogger,
  ) {
    this._eventBus = eventBus
    this._projectRoot = projectRoot
    this._baseDirectory = baseDirectory
    this._db = db
    this._logger = logger ?? console

    // Bind listeners once so we can remove them in shutdown()
    // Note: _handleTaskReady is async; it awaits worktree creation and emits
    // worktree:created only after the worktree exists. The WorkerPoolManager
    // subscribes to worktree:created (not task:ready) to avoid race conditions.
    this._onTaskReady = ({ taskId }: { taskId: string }) => {
      this._handleTaskReady(taskId).catch((err) => {
        this._logger.error({ taskId, err }, 'Unhandled error in _handleTaskReady')
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
  // IBaseService lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    this._logger.info({ projectRoot: this._projectRoot }, 'GitWorktreeManager.initialize()')

    // Validate git version on startup
    await this.verifyGitVersion()

    // Clean up orphaned worktrees from previous crashes
    const cleaned = await this.cleanupAllWorktrees()
    if (cleaned > 0) {
      this._logger.info({ cleaned }, 'Recovered orphaned worktrees on startup')
    }

    // Subscribe to task:ready to create worktrees
    this._eventBus.on('task:ready', this._onTaskReady)

    // Subscribe to completion events to trigger cleanup
    this._eventBus.on('task:complete', this._onTaskComplete)
    this._eventBus.on('task:failed', this._onTaskFailed)

    this._logger.info('GitWorktreeManager initialized')
  }

  async shutdown(): Promise<void> {
    this._logger.info('GitWorktreeManager.shutdown()')

    // Unsubscribe from event bus
    this._eventBus.off('task:ready', this._onTaskReady)
    this._eventBus.off('task:complete', this._onTaskComplete)
    this._eventBus.off('task:failed', this._onTaskFailed)

    // Clean up any remaining worktrees
    await this.cleanupAllWorktrees()

    this._logger.info('GitWorktreeManager shutdown complete')
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private async _handleTaskReady(taskId: string): Promise<void> {
    this._logger.debug({ taskId }, 'task:ready — creating worktree')
    try {
      await this.createWorktree(taskId)
    } catch (err) {
      this._logger.error({ taskId, err }, 'Failed to create worktree for task')
    }
  }

  private async _handleTaskDone(taskId: string): Promise<void> {
    this._logger.debug({ taskId }, 'task done — cleaning up worktree')
    try {
      await this.cleanupWorktree(taskId)
    } catch (err) {
      // Log but don't rethrow — cleanup failure should not block task completion
      this._logger.warn({ taskId, err }, 'Failed to cleanup worktree for task')
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

    this._logger.debug({ taskId, branchName, worktreePath, baseBranch }, 'createWorktree')

    // Create the worktree via git-utils
    await gitUtils.createWorktree(this._projectRoot, taskId, branchName, baseBranch)

    const createdAt = new Date()

    // Emit worktree:created event
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

    this._logger.info({ taskId, branchName, worktreePath }, 'Worktree created')
    return info
  }

  async cleanupWorktree(taskId: string): Promise<void> {
    const branchName = BRANCH_PREFIX + taskId
    const worktreePath = this.getWorktreePath(taskId)

    this._logger.debug({ taskId, branchName, worktreePath }, 'cleanupWorktree')

    // Guard: Check if worktree directory exists before attempting removal.
    // This makes cleanupWorktree idempotent and prevents double-cleanup races.
    let worktreeExists = false
    try {
      await access(worktreePath)
      worktreeExists = true
    } catch {
      // Worktree directory doesn't exist — already cleaned up or never created
      this._logger.debug({ taskId, worktreePath }, 'cleanupWorktree: worktree does not exist, skipping removal')
    }

    // Remove worktree directory (only if it exists)
    if (worktreeExists) {
      try {
        await gitUtils.removeWorktree(worktreePath, this._projectRoot)
      } catch (err) {
        this._logger.warn({ taskId, worktreePath, err }, 'removeWorktree failed during cleanup')
      }
    }

    // Delete the task branch
    try {
      await gitUtils.removeBranch(branchName, this._projectRoot)
    } catch (err) {
      this._logger.warn({ taskId, branchName, err }, 'removeBranch failed during cleanup')
    }

    // Emit worktree:removed event
    this._eventBus.emit('worktree:removed', {
      taskId,
      branchName,
    })

    this._logger.info({ taskId, branchName }, 'Worktree cleaned up')
  }

  async cleanupAllWorktrees(): Promise<number> {
    this._logger.debug({ projectRoot: this._projectRoot }, 'cleanupAllWorktrees')

    const orphanedPaths = await gitUtils.getOrphanedWorktrees(this._projectRoot, this._baseDirectory)
    let cleaned = 0

    for (const worktreePath of orphanedPaths) {
      // Extract taskId from path (last segment of the path)
      const taskId = path.basename(worktreePath)

      // Remove orphaned worktree
      let worktreeRemoved = false
      try {
        await gitUtils.removeWorktree(worktreePath, this._projectRoot)
        worktreeRemoved = true
        this._logger.debug({ taskId, worktreePath }, 'cleanupAllWorktrees: removed orphaned worktree')
      } catch (err) {
        this._logger.warn({ taskId, worktreePath, err }, 'cleanupAllWorktrees: failed to remove worktree')
      }

      // Remove orphaned branch
      const branchName = BRANCH_PREFIX + taskId
      try {
        const branchRemoved = await gitUtils.removeBranch(branchName, this._projectRoot)
        if (branchRemoved) {
          this._logger.debug({ taskId, branchName }, 'cleanupAllWorktrees: removed orphaned branch')
        }
      } catch (err) {
        this._logger.warn({ taskId, branchName, err }, 'cleanupAllWorktrees: failed to remove branch')
      }

      // Only count as cleaned if worktree removal succeeded
      if (worktreeRemoved) {
        cleaned++
      }
    }

    if (cleaned > 0) {
      this._logger.info({ cleaned }, 'cleanupAllWorktrees: recovered orphaned worktrees')
    }

    return cleaned
  }

  async detectConflicts(taskId: string, targetBranch = 'main'): Promise<ConflictReport> {
    if (!taskId || taskId.trim().length === 0) {
      throw new Error('detectConflicts: taskId must be a non-empty string')
    }

    const branchName = BRANCH_PREFIX + taskId
    const worktreePath = this.getWorktreePath(taskId)

    this._logger.debug({ taskId, branchName, targetBranch }, 'detectConflicts')

    // Verify the worktree exists
    try {
      await access(worktreePath)
    } catch {
      throw new Error(
        `detectConflicts: Worktree for task "${taskId}" not found at "${worktreePath}". ` +
        `The worktree may have already been cleaned up.`,
      )
    }

    // Run simulated merge on the project root (target branch working dir)
    const mergeClean = await gitUtils.simulateMerge(branchName, this._projectRoot)

    let conflictingFiles: string[] = []

    try {
      if (!mergeClean) {
        // Get the list of conflicting files
        conflictingFiles = await gitUtils.getConflictingFiles(this._projectRoot)
      }
    } finally {
      // Always abort the simulated merge to clean up state
      await gitUtils.abortMerge(this._projectRoot)
    }

    const report: ConflictReport = {
      hasConflicts: !mergeClean || conflictingFiles.length > 0,
      conflictingFiles,
      taskId,
      targetBranch,
    }

    // Emit worktree:conflict event if conflicts exist
    if (report.hasConflicts) {
      this._eventBus.emit('worktree:conflict', {
        taskId,
        branch: branchName,
        conflictingFiles: report.conflictingFiles,
      })
    }

    this._logger.info({ taskId, hasConflicts: report.hasConflicts, conflictCount: conflictingFiles.length }, 'Conflict detection complete')
    return report
  }

  async mergeWorktree(taskId: string, targetBranch = 'main'): Promise<MergeResult> {
    if (!taskId || taskId.trim().length === 0) {
      throw new Error('mergeWorktree: taskId must be a non-empty string')
    }

    const branchName = BRANCH_PREFIX + taskId

    this._logger.debug({ taskId, branchName, targetBranch }, 'mergeWorktree')

    // Call detectConflicts() first to check for conflicts (also verifies worktree exists)
    const conflictReport = await this.detectConflicts(taskId, targetBranch)

    if (conflictReport.hasConflicts) {
      // Return failure result without attempting merge
      this._logger.info({ taskId, conflictCount: conflictReport.conflictingFiles.length }, 'Merge skipped due to conflicts')
      return {
        success: false,
        mergedFiles: [],
        conflicts: conflictReport,
      }
    }

    // Perform actual merge
    const mergeSuccess = await gitUtils.performMerge(branchName, this._projectRoot)

    if (!mergeSuccess) {
      throw new Error(`mergeWorktree: git merge --no-ff failed for task "${taskId}" branch "${branchName}"`)
    }

    // Get the list of merged files
    const mergedFiles = await gitUtils.getMergedFiles(this._projectRoot)

    // Emit worktree:merged event
    this._eventBus.emit('worktree:merged', {
      taskId,
      branch: branchName,
      mergedFiles,
    })

    const result: MergeResult = {
      success: true,
      mergedFiles,
    }

    this._logger.info({ taskId, branchName, mergedFileCount: mergedFiles.length }, 'Worktree merged successfully')
    return result
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    this._logger.debug({ projectRoot: this._projectRoot, baseDirectory: this._baseDirectory }, 'listWorktrees')

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

    this._logger.debug({ count: results.length }, 'listWorktrees: found worktrees')
    return results
  }

  getWorktreePath(taskId: string): string {
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
  eventBus: TypedEventBus<CoreEvents>
  projectRoot: string
  baseDirectory?: string
  db?: LegacyDbLike | null
  logger?: ILogger
}

export function createGitWorktreeManager(options: GitWorktreeManagerOptions): GitWorktreeManager {
  return new GitWorktreeManagerImpl(
    options.eventBus,
    options.projectRoot,
    options.baseDirectory,
    options.db ?? null,
    options.logger,
  )
}
