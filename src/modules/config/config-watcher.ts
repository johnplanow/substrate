/**
 * ConfigWatcher — file watcher for hot-reloading substrate.config.yaml.
 *
 * Responsibilities (Story 5.6):
 *  - Watch the config file using Node.js fs.watch
 *  - Debounce rapid file change events (default 300ms)
 *  - Validate the new config using the Zod schema
 *  - Call onReload with the parsed config on success
 *  - Call onError with validation/parse errors on failure
 *  - Clean up file handles on stop()
 *
 * Architecture constraints:
 *  - ADR-001: Module in src/modules/config/; communicates changes via callback
 *  - ESM imports: ALL imports use .js extension
 */

import { watch, readFile, existsSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import yaml from 'js-yaml'
import { createLogger } from '../../utils/logger.js'
import { SubstrateConfigSchema, type SubstrateConfig } from './config-schema.js'

const logger = createLogger('config-watcher')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigWatcherOptions {
  /** Absolute path to the config file to watch */
  configPath: string
  /** Called with the new validated config when the file changes successfully */
  onReload: (newConfig: SubstrateConfig) => void
  /** Called when validation or parsing fails */
  onError: (err: Error) => void
  /** Debounce delay in milliseconds (default: 300) */
  debounceMs?: number
}

export interface ConfigWatcher {
  /** Start watching the config file */
  start(): void
  /** Stop watching and clean up resources */
  stop(): void
}

// ---------------------------------------------------------------------------
// flattenObject — deep-flatten for changed-keys computation
// ---------------------------------------------------------------------------

/**
 * Recursively flatten a nested object into dot-notation key/value pairs.
 * Arrays are treated as leaf values (not recursed into).
 */
export function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  return Object.entries(obj).reduce((acc, [key, val]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(acc, flattenObject(val as Record<string, unknown>, fullKey))
    } else {
      acc[fullKey] = val
    }
    return acc
  }, {} as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// computeChangedKeys
// ---------------------------------------------------------------------------

/**
 * Compute the set of dot-notation keys that differ between two configs.
 *
 * @param prev - Previous config
 * @param next - New config
 * @returns Array of dot-notation paths that changed (e.g., 'global.max_concurrent_tasks')
 */
export function computeChangedKeys(prev: SubstrateConfig, next: SubstrateConfig): string[] {
  const prevFlat = flattenObject(prev as unknown as Record<string, unknown>)
  const nextFlat = flattenObject(next as unknown as Record<string, unknown>)
  const allKeys = new Set([...Object.keys(prevFlat), ...Object.keys(nextFlat)])
  return [...allKeys].filter((k) => prevFlat[k] !== nextFlat[k])
}

// ---------------------------------------------------------------------------
// createConfigWatcher
// ---------------------------------------------------------------------------

/**
 * Create a config file watcher that detects changes and reloads the config.
 *
 * AC1: Registers file watcher on configPath with persistent=false
 * AC2: Debounces events, reads+parses+validates on change
 * AC3: Calls onError for invalid config without calling onReload
 */
export function createConfigWatcher(options: ConfigWatcherOptions): ConfigWatcher {
  const { configPath, onReload, onError, debounceMs = 300 } = options

  let watcher: FSWatcher | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const handleChange = () => {
    // Debounce: cancel any pending reload
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null
      readFile(configPath, 'utf-8', (readErr, raw) => {
        if (readErr !== null) {
          logger.error({ err: readErr, configPath }, 'Config reload failed: could not read file')
          onError(readErr)
          return
        }

        try {
          const parsed = yaml.load(raw)
          const result = SubstrateConfigSchema.safeParse(parsed)
          if (!result.success) {
            const message = result.error.errors
              .map((e) => `${e.path.join('.')}: ${e.message}`)
              .join('; ')
            const err = new Error(`Config validation failed: ${message}. Continuing with previous config.`)
            logger.error({ configPath, details: message }, 'Config reload failed: schema validation error. Continuing with previous config.')
            onError(err)
            return
          }
          onReload(result.data)
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          logger.error({ err: error, configPath }, 'Config reload failed: YAML parse error. Continuing with previous config.')
          onError(error)
        }
      })
    }, debounceMs)
  }

  return {
    start(): void {
      if (watcher !== null) {
        logger.warn({ configPath }, 'ConfigWatcher.start() called but watcher already running')
        return
      }

      if (!existsSync(configPath)) {
        logger.info({ configPath }, 'Config file not found, hot-reload disabled')
        return
      }

      logger.info({ configPath }, 'Config watcher active: watching substrate.config.yaml')

      watcher = watch(configPath, { persistent: false }, (_eventType, _filename) => {
        handleChange()
      })

      watcher.on('error', (err) => {
        logger.error({ err, configPath }, 'Config watcher error')
        onError(err)
      })
    },

    stop(): void {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }

      if (watcher !== null) {
        watcher.close()
        watcher = null
        logger.info({ configPath }, 'Config watcher stopped')
      }
    },
  }
}
