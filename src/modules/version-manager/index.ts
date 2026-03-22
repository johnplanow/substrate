/**
 * Re-export shim: version-manager module → @substrate-ai/core
 * Implementation migrated to packages/core/src/version-manager/ (Story 41-8)
 */
export type { VersionManager, VersionCheckResult, UpgradePreview } from '@substrate-ai/core'
export type { VersionManagerDeps } from '@substrate-ai/core'
export { VersionManagerImpl, createVersionManager } from '@substrate-ai/core'
export { UpdateChecker, UpdateCheckError } from '@substrate-ai/core'
export type { VersionCacheEntry } from '@substrate-ai/core'
export { VersionCache } from '@substrate-ai/core'
