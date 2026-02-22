/**
 * version-manager module — barrel exports
 *
 * Re-exports all public types and classes for the version management subsystem.
 */

export type { VersionManager, VersionCheckResult, UpgradePreview } from './version-manager.js'
export type { VersionManagerDeps } from './version-manager-impl.js'
export { VersionManagerImpl, createVersionManager } from './version-manager-impl.js'
export { UpdateChecker, UpdateCheckError } from './update-checker.js'
export type { VersionCacheEntry } from './version-cache.js'
export { VersionCache } from './version-cache.js'
