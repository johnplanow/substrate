/**
 * @substrate-ai/core version-manager barrel export.
 * Re-exports all version management types and implementations.
 */

export type { VersionManager, VersionCheckResult, UpgradePreview } from './version-manager.js'
export { VersionManagerImpl, createVersionManager } from './version-manager-impl.js'
export type { VersionManagerDeps } from './version-manager-impl.js'
export { UpdateChecker, UpdateCheckError } from './update-checker.js'
export { VersionCache } from './version-cache.js'
export type { VersionCacheEntry } from './version-cache.js'
export { classifyVersionGap } from './version-gap.js'
export type { VersionGap } from './version-gap.js'
