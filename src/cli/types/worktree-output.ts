/**
 * Output types for the `substrate worktrees` CLI command.
 *
 * Defines the data structures used for both human-readable table output
 * and machine-readable JSON output of worktree information.
 */

// ---------------------------------------------------------------------------
// WorktreeDisplayInfo
// ---------------------------------------------------------------------------

/**
 * Task statuses that can be associated with a worktree.
 */
export type TaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'paused' | 'queued'

/**
 * Represents a worktree entry for display in CLI output.
 * Extends WorktreeInfo with task status from the persistence layer.
 */
export interface WorktreeDisplayInfo {
  /** Task this worktree belongs to */
  taskId: string
  /** Branch name in the form "substrate/task-{taskId}" */
  branchName: string
  /** Absolute path to the worktree directory */
  worktreePath: string
  /** Current status of the associated task */
  taskStatus: TaskStatus
  /** When the worktree was created */
  createdAt: Date
  /** When the task was completed (if completed) */
  completedAt?: Date
}

// ---------------------------------------------------------------------------
// Sort options
// ---------------------------------------------------------------------------

/**
 * Sort keys for worktree list output.
 */
export type WorktreeSortKey = 'created' | 'task-id' | 'status'

// ---------------------------------------------------------------------------
// Table row
// ---------------------------------------------------------------------------

/**
 * A single row in the worktree list table.
 */
export interface WorktreeTableRow {
  taskId: string
  branchName: string
  worktreePath: string
  taskStatus: string
  createdAt: string
  completedAt?: string
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

/**
 * JSON-serializable worktree info object.
 * Matches the structure required by AC2.
 */
export interface WorktreeJsonEntry {
  taskId: string
  branchName: string
  worktreePath: string
  taskStatus: string
  createdAt: string
  completedAt: string | null
}
