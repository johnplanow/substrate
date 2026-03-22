/**
 * Re-export shim: git-utils.ts → @substrate-ai/core
 * Implementation migrated to packages/core/src/git/git-utils.ts (Story 41-8)
 */
export {
  spawnGit,
  getGitVersion,
  parseGitVersion,
  isGitVersionSupported,
  verifyGitVersion,
  createWorktree,
  removeWorktree,
  removeBranch,
  getOrphanedWorktrees,
  simulateMerge,
  abortMerge,
  getConflictingFiles,
  performMerge,
  getMergedFiles,
} from '@substrate-ai/core'
export type { SpawnOptions, GitSpawnResult, GitVersion } from '@substrate-ai/core'
