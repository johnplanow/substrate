/**
 * git-worktree module — barrel export.
 *
 * Exports the public interface, types, and factory for GitWorktreeManager.
 * Internal helpers (git-utils) are not re-exported; import directly if needed.
 */

export type { GitWorktreeManager, WorktreeInfo, ConflictReport, MergeResult } from './git-worktree-manager.js'
export {
  GitWorktreeManagerImpl,
  createGitWorktreeManager,
} from './git-worktree-manager-impl.js'
export type { GitWorktreeManagerOptions } from './git-worktree-manager-impl.js'
