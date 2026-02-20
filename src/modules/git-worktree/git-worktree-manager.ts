/**
 * GitWorktreeManager — interface and types for git worktree lifecycle management.
 *
 * Responsible for:
 *  - Creating per-task git worktrees (AC1)
 *  - Providing worktree paths to WorkerPoolManager (AC2, AC6)
 *  - Cleaning up worktrees on task completion (AC3)
 *  - Recovering orphaned worktrees on startup (AC4)
 *  - Validating git version on startup (AC5)
 *
 * Implementation: GitWorktreeManagerImpl (git-worktree-manager-impl.ts)
 */

import type { BaseService } from '../../core/di.js'

// ---------------------------------------------------------------------------
// WorktreeInfo
// ---------------------------------------------------------------------------

/**
 * Describes a created worktree associated with a task.
 */
export interface WorktreeInfo {
  /** Task this worktree belongs to */
  taskId: string
  /** Branch name in the form "substrate/task-{taskId}" */
  branchName: string
  /** Absolute path to the worktree directory */
  worktreePath: string
  /** When the worktree was created */
  createdAt: Date
}

// ---------------------------------------------------------------------------
// ConflictReport
// ---------------------------------------------------------------------------

/**
 * Result of a conflict detection check for a task's worktree branch.
 * Returned by detectConflicts() after simulating a merge.
 */
export interface ConflictReport {
  /** Whether conflicts were found */
  hasConflicts: boolean
  /** List of files with conflicts (empty if no conflicts) */
  conflictingFiles: string[]
  /** Task ID being checked */
  taskId: string
  /** Target branch that was used for conflict detection */
  targetBranch: string
}

// ---------------------------------------------------------------------------
// MergeResult
// ---------------------------------------------------------------------------

/**
 * Result of a merge operation for a task's worktree branch.
 * Returned by mergeWorktree().
 */
export interface MergeResult {
  /** Whether the merge succeeded */
  success: boolean
  /** List of files that were merged (only populated on success) */
  mergedFiles: string[]
  /** Conflict report if merge failed due to conflicts */
  conflicts?: ConflictReport
}

// ---------------------------------------------------------------------------
// GitWorktreeManager interface
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of git worktrees for parallel task execution.
 *
 * Each task gets an isolated git worktree to prevent file conflicts between
 * concurrently running agents (FR16, FR17, NFR10).
 */
export interface GitWorktreeManager extends BaseService {
  /**
   * Create a git worktree and branch for the given task.
   *
   * @param taskId     - The task identifier
   * @param baseBranch - Branch to base the worktree on (defaults to 'main')
   * @returns          - WorktreeInfo with path and branch details
   * @throws           - Error if git command fails
   */
  createWorktree(taskId: string, baseBranch?: string): Promise<WorktreeInfo>

  /**
   * Remove the worktree and branch associated with a task.
   *
   * @param taskId - The task identifier
   * @throws       - Error if git removal command fails
   */
  cleanupWorktree(taskId: string): Promise<void>

  /**
   * Scan for orphaned worktrees and clean them up.
   *
   * Used during initialization to recover from crashes.
   *
   * @returns - Count of worktrees that were cleaned up
   */
  cleanupAllWorktrees(): Promise<number>

  /**
   * Get the consistent worktree path for a given task.
   *
   * @param taskId - The task identifier
   * @returns      - Absolute path: {projectRoot}/.substrate-worktrees/{taskId}
   */
  getWorktreePath(taskId: string): string

  /**
   * Verify that git is installed and version >= 2.20.
   *
   * @throws - Error with clear message if git is missing or too old
   */
  verifyGitVersion(): Promise<void>

  /**
   * Detect merge conflicts between a task's worktree branch and a target branch.
   *
   * Uses `git merge --no-commit --no-ff` to simulate the merge without committing,
   * then aborts the simulation via `git merge --abort`.
   *
   * @param taskId       - The task identifier (used to derive branch name)
   * @param targetBranch - The branch to merge into (default: "main")
   * @returns            - ConflictReport with conflict details
   * @throws             - Error if worktree does not exist or git command fails
   */
  detectConflicts(taskId: string, targetBranch?: string): Promise<ConflictReport>

  /**
   * Merge a task's worktree branch into the target branch.
   *
   * Calls detectConflicts() first. If conflicts exist, returns MergeResult with
   * success: false. Otherwise, performs `git merge --no-ff` and emits worktree:merged.
   *
   * @param taskId       - The task identifier
   * @param targetBranch - The branch to merge into (default: "main")
   * @returns            - MergeResult with success status and file list
   * @throws             - Error if worktree does not exist or git command fails
   */
  mergeWorktree(taskId: string, targetBranch?: string): Promise<MergeResult>

  /**
   * List all active worktrees in the .substrate-worktrees directory.
   *
   * Scans the base worktree directory and returns WorktreeInfo objects
   * for each discovered worktree. Does not require a database connection.
   *
   * @returns - Array of WorktreeInfo objects (may be empty if no worktrees exist)
   */
  listWorktrees(): Promise<WorktreeInfo[]>
}
