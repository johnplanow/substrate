/**
 * Re-export shim: git-worktree module → @substrate-ai/core
 * Implementation migrated to packages/core/src/git/ (Story 41-8)
 */
export type {
  GitWorktreeManager,
  WorktreeInfo,
  ConflictReport,
  MergeResult,
} from '@substrate-ai/core'
export { GitWorktreeManagerImpl, createGitWorktreeManager } from '@substrate-ai/core'
export type { GitWorktreeManagerOptions } from '@substrate-ai/core'
