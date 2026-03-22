/**
 * @substrate-ai/core git barrel export.
 * Re-exports all git-related utilities, interfaces, and implementations.
 */

export * from './git-utils.js'
export type { GitWorktreeManager, WorktreeInfo, ConflictReport, MergeResult } from './git-worktree-manager.js'
export {
  GitWorktreeManagerImpl,
  createGitWorktreeManager,
} from './git-worktree-manager-impl.js'
export type { GitWorktreeManagerOptions, LegacyDbLike } from './git-worktree-manager-impl.js'
export type { GitManager, GitManagerOptions } from './git-manager.js'
export { GitManagerImpl, createGitManager } from './git-manager.js'
