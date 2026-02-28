/**
 * VersionManagerImpl — concrete implementation of the VersionManager interface.
 *
 * Handles update checks with caching, upgrade previews, and config migration delegation.
 * (AC6, FR62, FR64)
 */

import { createRequire } from 'module'
import type { VersionManager, VersionCheckResult, UpgradePreview } from './version-manager.js'
import { UpdateChecker } from './update-checker.js'
import { VersionCache } from './version-cache.js'
import type { MigrationResult } from '../config/config-migrator.js'
import { defaultConfigMigrator } from '../config/config-migrator.js'
import {
  SUPPORTED_CONFIG_FORMAT_VERSIONS,
  SUPPORTED_TASK_GRAPH_VERSIONS,
} from '../config/config-schema.js'

// ---------------------------------------------------------------------------
// Dependencies interface
// ---------------------------------------------------------------------------

export interface VersionManagerDeps {
  cache?: VersionCache
  updateChecker?: UpdateChecker
  /**
   * Whether the update_check config setting is enabled.
   * Pass `false` when `global.update_check` is explicitly set to `false` in config.
   * Defaults to `true` (checks enabled).
   */
  updateCheckEnabled?: boolean
}

// ---------------------------------------------------------------------------
// VersionManagerImpl
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of VersionManager.
 *
 * @param deps - Optional overrides for cache and updateChecker (for testing)
 */
export class VersionManagerImpl implements VersionManager {
  private readonly cache: VersionCache
  private readonly updateChecker: UpdateChecker
  private readonly updateCheckEnabled: boolean

  constructor(deps: VersionManagerDeps = {}) {
    this.cache = deps.cache ?? new VersionCache()
    this.updateChecker = deps.updateChecker ?? new UpdateChecker()
    this.updateCheckEnabled = deps.updateCheckEnabled !== false
  }

  /**
   * Read the current package version from the bundled package.json.
   * Falls back to '0.0.0' if the file is unreadable.
   */
  getCurrentVersion(): string {
    try {
      const _require = createRequire(import.meta.url)
      const pkg = _require('../../../package.json') as { version?: string }
      return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0'
    } catch {
      return '0.0.0'
    }
  }

  /**
   * Check whether a newer version is available on npm.
   *
   * Respects:
   * 1. update_check config setting (AC5)
   * 2. SUBSTRATE_NO_UPDATE_CHECK env var
   * 3. Cache TTL (24h by default), unless forceRefresh is true
   *
   * Returns updateAvailable: false without a network call when checks are disabled
   * or the cache is fresh (and forceRefresh is not set).
   *
   * @param forceRefresh - When true, skips the cache and always makes a fresh network request.
   */
  async checkForUpdates(forceRefresh = false): Promise<VersionCheckResult> {
    const currentVersion = this.getCurrentVersion()

    // Check config suppression (AC5: update_check: false in config)
    if (!this.updateCheckEnabled) {
      return {
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        isBreaking: false,
        changelog: '',
      }
    }

    // Check env var suppression
    if (process.env['SUBSTRATE_NO_UPDATE_CHECK'] === '1') {
      return {
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        isBreaking: false,
        changelog: '',
      }
    }

    // Check cache — if fresh and not forcing a refresh, return cached result without a network call
    if (!forceRefresh) {
      const cached = this.cache.read()
      if (cached !== null) {
        const updateAvailable = cached.latestVersion !== cached.currentVersion
        return {
          currentVersion: cached.currentVersion,
          latestVersion: cached.latestVersion,
          updateAvailable,
          isBreaking: this.updateChecker.isBreaking(cached.currentVersion, cached.latestVersion),
          changelog: this.updateChecker.getChangelog(cached.latestVersion),
        }
      }
    }

    // Cache miss, expired, or forceRefresh — fetch from npm
    try {
      const latestVersion = await this.updateChecker.fetchLatestVersion('substrate-ai')
      const updateAvailable = latestVersion !== currentVersion

      // Write to cache (even when forceRefresh was used, so subsequent calls benefit)
      this.cache.write({
        lastChecked: new Date().toISOString(),
        latestVersion,
        currentVersion,
      })

      return {
        currentVersion,
        latestVersion,
        updateAvailable,
        isBreaking: this.updateChecker.isBreaking(currentVersion, latestVersion),
        changelog: this.updateChecker.getChangelog(latestVersion),
      }
    } catch {
      // Network error — return no-update result (never block CLI)
      return {
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        isBreaking: false,
        changelog: '',
      }
    }
  }

  /**
   * Return an upgrade preview for the given target version.
   */
  getUpgradePreview(targetVersion: string): UpgradePreview {
    const fromVersion = this.getCurrentVersion()
    const breaking = this.updateChecker.isBreaking(fromVersion, targetVersion)

    return {
      fromVersion,
      toVersion: targetVersion,
      breakingChanges: breaking
        ? [`Major version bump from v${fromVersion} to v${targetVersion}`]
        : [],
      migrationSteps: [this.updateChecker.getChangelog(targetVersion)],
      automaticMigrations: breaking ? ['Run defaultConfigMigrator.migrate() if config changed'] : [],
      manualStepsRequired: breaking
        ? ['Review breaking changes at the changelog URL above']
        : [],
    }
  }

  /**
   * Migrate the project configuration from one format version to another.
   * Delegates to the shared defaultConfigMigrator singleton.
   * Loads the actual config from the project config file so migration functions receive real data.
   */
  migrateConfiguration(fromVersion: string, toVersion: string): MigrationResult {
    let configObj: unknown = {}
    try {
      const _require = createRequire(import.meta.url)
      const fs = _require('fs') as typeof import('fs')
      const path = _require('path') as typeof import('path')
      const yaml = _require('js-yaml') as typeof import('js-yaml')
      const configPath = path.join(process.cwd(), '.substrate', 'config.yaml')
      try {
        const raw = fs.readFileSync(configPath, 'utf-8')
        configObj = yaml.load(raw) ?? {}
      } catch {
        // No project config file — use empty object
        configObj = {}
      }
    } catch {
      configObj = {}
    }
    const { result } = defaultConfigMigrator.migrate(configObj, fromVersion, toVersion)
    return result
  }

  /**
   * Migrate a task graph file from one format version to another.
   * Delegates to the shared defaultConfigMigrator singleton.
   */
  migrateTaskGraphFormat(fromVersion: string, toVersion: string, filePath: string): MigrationResult {
    const { result } = defaultConfigMigrator.migrate({}, fromVersion, toVersion, filePath)
    return result
  }

  /**
   * Check whether the given config format version is supported by this toolkit.
   */
  isConfigCompatible(configVersion: string): boolean {
    return SUPPORTED_CONFIG_FORMAT_VERSIONS.includes(configVersion)
  }

  /**
   * Check whether the given task graph format version is supported by this toolkit.
   */
  isTaskGraphCompatible(graphVersion: string): boolean {
    return SUPPORTED_TASK_GRAPH_VERSIONS.includes(graphVersion)
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a new VersionManager instance with optional dependency overrides.
 */
export function createVersionManager(deps: VersionManagerDeps = {}): VersionManager {
  return new VersionManagerImpl(deps)
}
