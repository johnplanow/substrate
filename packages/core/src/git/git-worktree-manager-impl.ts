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
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import type { TypedEventBus, CoreEvents } from '../events/index.js'
import type { ILogger } from '../dispatch/types.js'
import { createStderrLogger } from '../utils/stderr-logger.js'
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

// Legacy in-repo base directory for worktrees (relative to projectRoot)
const DEFAULT_WORKTREE_BASE = '.substrate-worktrees'

/**
 * H4.2 (AC2): resolve the worktree base directory for a project.
 *
 * 'external' (the NEW DEFAULT) puts worktrees OUTSIDE the parent tree at
 * `~/.substrate/worktrees/<projectname>-<hash8>/` — an agent inside its
 * worktree has no parent repo above it to leak into (composes with H4.1's
 * GIT_CEILING_DIRECTORIES, which points at this base). 'in-repo' retains the
 * pre-H4.2 `<projectRoot>/.substrate-worktrees/` for tooling that assumed
 * the old path (MIGRATION NOTE: reconcile-from-disk, editor bookmarks, and
 * scripts that globbed `.substrate-worktrees/` should use
 * `substrate worktrees list` or set `worktree.base: in-repo`).
 *
 * When `baseOverride` is not given, reads `worktree.base` from
 * `.substrate/config.yaml` directly (same no-threading pattern as
 * `resolveEpicsPathOverride`) so EVERY construction site — orchestrator,
 * `substrate merge`, `substrate worktrees` — resolves identically.
 */
export function resolveWorktreeBaseDirectory(
  projectRoot: string,
  baseOverride?: 'in-repo' | 'external',
): string {
  let mode: 'in-repo' | 'external' | undefined = baseOverride
  if (mode === undefined) {
    try {
      const raw = readFileSync(path.join(projectRoot, '.substrate', 'config.yaml'), 'utf-8')
      const parsed = yaml.load(raw) as { worktree?: { base?: string } } | undefined
      if (parsed?.worktree?.base === 'in-repo' || parsed?.worktree?.base === 'external') {
        mode = parsed.worktree.base
      }
    } catch {
      // No config / unreadable — fall through to the default.
    }
  }
  if ((mode ?? 'external') === 'in-repo') {
    return DEFAULT_WORKTREE_BASE
  }
  const hash = createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 8)
  return path.join(homedir(), '.substrate', 'worktrees', `${path.basename(projectRoot)}-${hash}`)
}

// ---------------------------------------------------------------------------
// GitWorktreeManagerImpl
// ---------------------------------------------------------------------------

export class GitWorktreeManagerImpl implements GitWorktreeManager {
  private readonly _eventBus: TypedEventBus<CoreEvents>
  private readonly _projectRoot: string
  private readonly _baseDirectory: string
  private readonly _db: LegacyDbLike | null
  private readonly _logger: ILogger
  /** v0.20.109: files to copy from project root into each new worktree (e.g. `.env`). */
  private readonly _copyFiles: readonly string[]

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
    copyFiles: readonly string[] = [],
  ) {
    this._eventBus = eventBus
    this._projectRoot = projectRoot
    this._baseDirectory = baseDirectory
    this._db = db
    this._logger = logger ?? createStderrLogger('git-worktree-manager')
    this._copyFiles = copyFiles

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

  async createWorktree(taskId: string, baseBranch?: string): Promise<WorktreeInfo> {
    if (!taskId || taskId.trim().length === 0) {
      throw new Error('createWorktree: taskId must be a non-empty string')
    }

    // H4.2: when no base branch is named, use the repo's CURRENT branch —
    // the 'main' hardcode failed live on a master-default CI runner
    // (`git worktree add … invalid reference: main`).
    const resolvedBaseBranch = baseBranch ?? (await this._detectCurrentBranch()) ?? 'main'

    const branchName = BRANCH_PREFIX + taskId
    const worktreePath = this.getWorktreePath(taskId)

    this._logger.debug({ taskId, branchName, worktreePath, baseBranch: resolvedBaseBranch, copyFiles: this._copyFiles }, 'createWorktree')

    // H1.1 (hardening program): the project profile must reach every worktree —
    // it is the single source of truth for the project's language/build/test
    // commands, and consumers running inside the worktree (build gates,
    // verify_command, install hints) silently fall back to Node-leaning
    // defaults when it's absent. `git worktree add` only carries tracked
    // files; the copy is a no-op when the profile is tracked (same content)
    // or missing (copyFilesToWorktree skips absent sources silently).
    const copyFiles = this._copyFiles.includes('.substrate/project-profile.yaml')
      ? this._copyFiles
      : [...this._copyFiles, '.substrate/project-profile.yaml']

    // Create the worktree via git-utils (forwards copyFiles for gitignored env carry-over)
    await gitUtils.createWorktree(this._projectRoot, taskId, branchName, resolvedBaseBranch, copyFiles, this._baseDirectory)

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

  async cleanupWorktree(taskId: string, opts?: { force?: boolean; keepBranch?: boolean }): Promise<void> {
    const branchName = BRANCH_PREFIX + taskId
    const worktreePath = this.getWorktreePath(taskId)

    this._logger.debug({ taskId, branchName, worktreePath, force: opts?.force === true }, 'cleanupWorktree')

    // H0.3 (field findings #17/#19): refuse to destroy unrecoverable work.
    // Removal used `git worktree remove --force` + `git branch -D`
    // unconditionally — twice in the income-sources run this destroyed the
    // only copy of a story's implementation. Dirty worktree or unmerged
    // branch commits now require an explicit force from the caller.
    if (opts?.force !== true) {
      const decision = await gitUtils.inspectWorktreeRemovalSafety(worktreePath, this._projectRoot, branchName)
      // H3.1 (branch/pr finalization): when the branch is being KEPT as the
      // deliverable, unmerged commits on it are the POINT — only a dirty
      // working tree blocks removal.
      const blockingReasons = opts?.keepBranch === true
        ? decision.reasons.filter((r) => r.includes('uncommitted'))
        : decision.reasons
      if (blockingReasons.length > 0) {
        throw new Error(
          `refusing to clean up worktree for "${taskId}": ${blockingReasons.join('; ')}.\n` +
            `Inspect first (git -C ${worktreePath} status; git log ${branchName} --oneline) ` +
            `or re-run with --force to discard.`,
        )
      }
    }

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

    // Delete the task branch (unless it IS the deliverable — H3.1 branch/pr modes)
    if (opts?.keepBranch !== true) {
      try {
        await gitUtils.removeBranch(branchName, this._projectRoot)
      } catch (err) {
        this._logger.warn({ taskId, branchName, err }, 'removeBranch failed during cleanup')
      }
    }

    // Emit worktree:removed event
    this._eventBus.emit('worktree:removed', {
      taskId,
      branchName,
    })

    this._logger.info({ taskId, branchName }, 'Worktree cleaned up')
  }

  async cleanupAllWorktrees(opts?: { force?: boolean }): Promise<number> {
    this._logger.debug({ projectRoot: this._projectRoot, force: opts?.force === true }, 'cleanupAllWorktrees')

    const orphanedPaths = await gitUtils.getOrphanedWorktrees(this._projectRoot, this._baseDirectory)
    let cleaned = 0

    for (const worktreePath of orphanedPaths) {
      // Extract taskId from path (last segment of the path)
      const taskId = path.basename(worktreePath)

      // H0.3: the orphan sweep must not destroy recoverable work either — a
      // "stale" worktree from a crashed run is exactly where uncommitted
      // story output lives (field finding #17). Skip unsafe ones with a
      // named reason; the operator discards explicitly via
      // `substrate worktrees cleanup --force`.
      const branchGuardName = BRANCH_PREFIX + taskId
      const decision = opts?.force === true
        ? { safe: true as const, reasons: [] }
        : await gitUtils.inspectWorktreeRemovalSafety(worktreePath, this._projectRoot, branchGuardName)
      if (!decision.safe) {
        this._logger.warn(
          { taskId, worktreePath, reasons: decision.reasons },
          'cleanupAllWorktrees: preserving worktree — removal would destroy work (use `substrate worktrees cleanup --force` to discard)',
        )
        continue
      }

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

  /** H4.2: current branch of the parent repo (undefined when detached/unreadable). */
  private async _detectCurrentBranch(): Promise<string | undefined> {
    try {
      const result = await gitUtils.spawnGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this._projectRoot })
      const name = result.code === 0 ? result.stdout.trim() : ''
      return name !== '' && name !== 'HEAD' ? name : undefined
    } catch {
      return undefined
    }
  }

  getWorktreePath(taskId: string): string {
    // H4.2: _baseDirectory may be absolute (external base) — resolve, not join.
    return path.resolve(this._projectRoot, this._baseDirectory, taskId)
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
  /**
   * v0.20.109: files (relative to projectRoot) to copy into each new worktree
   * after `git worktree add`. Useful for gitignored env files. Default: `[]`.
   */
  copyFiles?: readonly string[]
}

export function createGitWorktreeManager(options: GitWorktreeManagerOptions): GitWorktreeManager {
  return new GitWorktreeManagerImpl(
    options.eventBus,
    options.projectRoot,
    // H4.2: single resolution point — explicit option, else `worktree.base`
    // from .substrate/config.yaml, else the external default.
    options.baseDirectory ?? resolveWorktreeBaseDirectory(options.projectRoot),
    options.db ?? null,
    options.logger,
    options.copyFiles,
  )
}
