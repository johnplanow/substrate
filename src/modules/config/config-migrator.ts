/**
 * ConfigMigrator — registry and executor of config format migrations (FR63).
 *
 * Migrations are keyed as "N->M" strings (e.g. "1->2") and are applied
 * sequentially when migrating across multiple versions.
 */

import { writeFileSync, readFileSync } from 'fs'

export interface MigrationResult {
  success: boolean
  fromVersion: string
  toVersion: string
  migratedKeys: string[]
  manualStepsRequired: string[]
  backupPath: string | null
}

/**
 * ConfigMigrator manages a registry of migration functions and applies them
 * sequentially to upgrade config documents from one format version to another.
 */
export class ConfigMigrator {
  private readonly migrations: Map<string, (config: unknown) => unknown> = new Map()

  /**
   * Register a migration function for the given version key.
   *
   * @param key - Migration key in format "N->M" (e.g. "1->2")
   * @param fn - Migration function that receives the raw config and returns the migrated config
   */
  register(key: string, fn: (config: unknown) => unknown): void {
    this.migrations.set(key, fn)
  }

  /**
   * Check whether a sequential migration path exists from fromVersion to toVersion.
   *
   * @param fromVersion - Starting version string
   * @param toVersion - Target version string
   * @returns true if every step in the path is registered
   */
  canMigrate(fromVersion: string, toVersion: string): boolean {
    if (fromVersion === toVersion) return true

    const from = parseInt(fromVersion, 10)
    const to = parseInt(toVersion, 10)

    if (isNaN(from) || isNaN(to) || from >= to) return false

    for (let v = from; v < to; v++) {
      const key = `${String(v)}->${String(v + 1)}`
      if (!this.migrations.has(key)) return false
    }

    return true
  }

  /**
   * Apply sequential migrations from fromVersion to toVersion.
   *
   * If fromVersion === toVersion, returns a no-op success result.
   * If any intermediate migration is missing, returns success:false.
   *
   * When filePath is provided and migration is needed, a backup is written to
   * `${filePath}.bak.v${fromVersion}` before any transformations are applied.
   *
   * @param config - Raw config object to migrate
   * @param fromVersion - Starting format version string
   * @param toVersion - Target format version string
   * @param filePath - Optional path to the source config file for backup creation
   * @returns Object containing the (possibly migrated) config and a MigrationResult
   */
  migrate(
    config: unknown,
    fromVersion: string,
    toVersion: string,
    filePath?: string
  ): { config: unknown; result: MigrationResult } {
    // No-op: same version
    if (fromVersion === toVersion) {
      return {
        config,
        result: {
          success: true,
          fromVersion,
          toVersion,
          migratedKeys: [],
          manualStepsRequired: [],
          backupPath: null,
        },
      }
    }

    const from = parseInt(fromVersion, 10)
    const to = parseInt(toVersion, 10)

    if (isNaN(from) || isNaN(to) || from >= to) {
      return {
        config,
        result: {
          success: false,
          fromVersion,
          toVersion,
          migratedKeys: [],
          manualStepsRequired: [
            `Cannot migrate from version "${fromVersion}" to "${toVersion}": invalid version range.`,
          ],
          backupPath: null,
        },
      }
    }

    // Check all steps exist first
    for (let v = from; v < to; v++) {
      const key = `${String(v)}->${String(v + 1)}`
      if (!this.migrations.has(key)) {
        return {
          config,
          result: {
            success: false,
            fromVersion,
            toVersion,
            migratedKeys: [],
            manualStepsRequired: [
              `Missing migration step: "${key}". ` +
                `Cannot automatically migrate from version "${fromVersion}" to "${toVersion}". ` +
                `Please upgrade the toolkit: npm install -g substrate@latest`,
            ],
            backupPath: null,
          },
        }
      }
    }

    // Write backup file before applying any migrations (AC4)
    let backupPath: string | null = null
    if (filePath !== undefined) {
      backupPath = `${filePath}.bak.v${fromVersion}`
      const originalContent = readFileSync(filePath, 'utf-8')
      writeFileSync(backupPath, originalContent, 'utf-8')
    }

    // Apply migrations sequentially
    let current = config
    const migratedKeys: string[] = []

    for (let v = from; v < to; v++) {
      const key = `${String(v)}->${String(v + 1)}`
      const fn = this.migrations.get(key)!

      const before = JSON.stringify(current)
      current = fn(current)
      const after = JSON.stringify(current)

      // Detect changed keys if both are objects
      if (
        current !== null &&
        typeof current === 'object' &&
        !Array.isArray(current) &&
        config !== null &&
        typeof config === 'object'
      ) {
        const beforeObj = JSON.parse(before) as Record<string, unknown>
        const afterObj = JSON.parse(after) as Record<string, unknown>
        for (const k of Object.keys(afterObj)) {
          if (JSON.stringify(afterObj[k]) !== JSON.stringify(beforeObj[k])) {
            if (!migratedKeys.includes(k)) {
              migratedKeys.push(k)
            }
          }
        }
      }
    }

    return {
      config: current,
      result: {
        success: true,
        fromVersion,
        toVersion,
        migratedKeys,
        manualStepsRequired: [],
        backupPath,
      },
    }
  }
}

/** Singleton instance for use throughout the toolkit */
export const defaultConfigMigrator = new ConfigMigrator()
