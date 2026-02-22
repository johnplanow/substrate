/**
 * VersionManager interface and type definitions.
 *
 * Defines the contract for version checking, upgrade previews, and
 * configuration migration delegation (FR62, FR64).
 */

import type { MigrationResult } from '../config/config-migrator.js'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Result of a version check against the npm registry.
 */
export interface VersionCheckResult {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  isBreaking: boolean
  changelog: string
}

/**
 * Preview of a pending upgrade, including breaking changes and migration steps.
 */
export interface UpgradePreview {
  fromVersion: string
  toVersion: string
  breakingChanges: string[]
  migrationSteps: string[]
  automaticMigrations: string[]
  manualStepsRequired: string[]
}

// ---------------------------------------------------------------------------
// VersionManager interface
// ---------------------------------------------------------------------------

/**
 * Provides version checking, upgrade previews, and config migration delegation.
 *
 * Create an instance via `createVersionManager()` from version-manager-impl.ts.
 */
export interface VersionManager {
  /**
   * Return the current installed version from the bundled package.json.
   */
  getCurrentVersion(): string

  /**
   * Check whether a newer version is available on npm.
   * Respects cache TTL and update_check config / SUBSTRATE_NO_UPDATE_CHECK env var.
   *
   * @param forceRefresh - When true, bypasses the cache and always makes a fresh network request.
   *   Used by `substrate upgrade --check` to show the latest npm data.
   */
  checkForUpdates(forceRefresh?: boolean): Promise<VersionCheckResult>

  /**
   * Return a preview of what upgrading to targetVersion would entail.
   */
  getUpgradePreview(targetVersion: string): UpgradePreview

  /**
   * Migrate the project configuration file from one format version to another.
   * Delegates to defaultConfigMigrator.
   */
  migrateConfiguration(fromVersion: string, toVersion: string): MigrationResult

  /**
   * Migrate a task graph file from one format version to another.
   * Delegates to defaultConfigMigrator.
   */
  migrateTaskGraphFormat(fromVersion: string, toVersion: string, filePath: string): MigrationResult

  /**
   * Check whether the given config format version is compatible with this toolkit.
   */
  isConfigCompatible(configVersion: string): boolean

  /**
   * Check whether the given task graph format version is compatible with this toolkit.
   */
  isTaskGraphCompatible(graphVersion: string): boolean
}
