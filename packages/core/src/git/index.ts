/**
 * @substrate-ai/core git barrel export.
 * Re-exports all git-related utilities, interfaces, and implementations.
 */

export * from './git-utils.js'
export type { GitWorktreeManager, WorktreeInfo, ConflictReport, MergeResult } from './git-worktree-manager.js'
export {
  GitWorktreeManagerImpl,
  createGitWorktreeManager,
  BRANCH_PREFIX,
} from './git-worktree-manager-impl.js'
export type { GitWorktreeManagerOptions, LegacyDbLike } from './git-worktree-manager-impl.js'
// v0.20.112: GitManager + createGitManager excised — zero production callers
// (per operator-excision policy from schema-unification arc cleanup).
