/**
 * Re-export shim: git-manager.ts → @substrate-ai/core
 * Implementation migrated to packages/core/src/git/git-manager.ts (Story 41-8)
 */
export type { GitManager, GitManagerOptions } from '@substrate-ai/core'
export { GitManagerImpl, createGitManager } from '@substrate-ai/core'
