/**
 * ConfigSystem implementation — loads configuration in hierarchy order and
 * exposes get/set/getMasked operations.
 *
 * Hierarchy (lowest → highest priority):
 *   built-in defaults
 *     → global user config  (~/.substrate/config.yaml)
 *     → project config      (./.substrate/config.yaml)
 *     → environment vars    (ADT_* prefixed)
 *     → CLI flag overrides  (passed via ConfigSystemOptions.cliOverrides)
 *
 * No imports from src/ (monolith) — zero monolith dependencies.
 */

import { readFile, writeFile, mkdir, access } from 'fs/promises'
import { join, resolve } from 'path'
import { homedir } from 'os'
import yaml from 'js-yaml'
import type { ILogger } from '../dispatch/types.js'
import { ConfigError, ConfigIncompatibleFormatError } from './errors.js'
import {
  SubstrateConfigSchema,
  PartialSubstrateConfigSchema,
  CURRENT_CONFIG_FORMAT_VERSION,
  SUPPORTED_CONFIG_FORMAT_VERSIONS,
  type SubstrateConfig,
  type PartialSubstrateConfig,
  type ConfigSystem,
  type ConfigSystemOptions,
} from './types.js'
import { isVersionSupported, formatUnsupportedVersionError } from './version-utils.js'
import { defaultConfigMigrator } from './config-migrator.js'
import { DEFAULT_CONFIG } from './defaults.js'

// ---------------------------------------------------------------------------
// Credential masking (inlined from src/cli/utils/masking.ts to avoid monolith import)
// ---------------------------------------------------------------------------

const MASKED_VALUE = '***'

const CREDENTIAL_FIELDS = new Set([
  'api_key',
  'apiKey',
  'api_key_env',
  'api_key_value',
  'token',
  'secret',
  'password',
])

function deepMask(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(deepMask)
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const masked: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (CREDENTIAL_FIELDS.has(k)) {
        masked[k] = MASKED_VALUE
      } else {
        masked[k] = deepMask(v)
      }
    }
    return masked
  }
  return value
}

// ---------------------------------------------------------------------------
// Deep merge utility
// ---------------------------------------------------------------------------

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: DeepPartial<T>
): T {
  const result = { ...base } as Record<string, unknown>
  for (const [key, val] of Object.entries(override)) {
    if (
      val !== null &&
      val !== undefined &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as DeepPartial<Record<string, unknown>>
      )
    } else if (val !== undefined) {
      result[key] = val
    }
  }
  return result as T
}

// ---------------------------------------------------------------------------
// Environment variable resolution
// ---------------------------------------------------------------------------

/**
 * Map of ADT_ environment variable names to config paths.
 * Only overrides scalar values; does not support nested structures via env.
 */
const ENV_VAR_MAP: Record<string, string> = {
  ADT_LOG_LEVEL: 'global.log_level',
  ADT_MAX_CONCURRENT_TASKS: 'global.max_concurrent_tasks',
  ADT_BUDGET_CAP_TOKENS: 'global.budget_cap_tokens',
  ADT_BUDGET_CAP_USD: 'global.budget_cap_usd',
  ADT_WORKSPACE_DIR: 'global.workspace_dir',
  ADT_CLAUDE_ENABLED: 'providers.claude.enabled',
  ADT_CODEX_ENABLED: 'providers.codex.enabled',
  ADT_GEMINI_ENABLED: 'providers.gemini.enabled',
}

/**
 * Read relevant environment variables and return a partial config overlay.
 */
function readEnvOverrides(logger: ILogger): PartialSubstrateConfig {
  const overrides: Record<string, unknown> = {}

  for (const [envKey, configPath] of Object.entries(ENV_VAR_MAP)) {
    const rawValue = process.env[envKey]
    if (rawValue === undefined) continue

    const parts = configPath.split('.')
    let cursor: Record<string, unknown> = overrides
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i] ?? ''
      if (cursor[part] === undefined) cursor[part] = {}
      cursor = cursor[part] as Record<string, unknown>
    }
    const lastKey = parts[parts.length - 1] ?? ''

    // Coerce to appropriate type
    if (rawValue === 'true') cursor[lastKey] = true
    else if (rawValue === 'false') cursor[lastKey] = false
    else if (/^\d+$/.test(rawValue)) cursor[lastKey] = parseInt(rawValue, 10)
    else if (/^\d*\.\d+$/.test(rawValue)) cursor[lastKey] = parseFloat(rawValue)
    else cursor[lastKey] = rawValue
  }

  // Validate the env overrides as partial config
  const parsed = PartialSubstrateConfigSchema.safeParse(overrides)
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.issues }, 'Invalid environment variable overrides ignored')
    return {}
  }
  return parsed.data
}

// ---------------------------------------------------------------------------
// Dot-notation key accessor / setter
// ---------------------------------------------------------------------------

/**
 * Get a value from a nested object using dot-notation key.
 */
export function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let cursor: unknown = obj
  for (const part of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

/**
 * Return a deep clone of `obj` with `path` set to `value`.
 * Creates intermediate objects as needed.
 */
export function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const parts = path.split('.')
  const result = { ...obj }
  let cursor: Record<string, unknown> = result

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] ?? ''
    const existing = cursor[part]
    if (existing === null || existing === undefined || typeof existing !== 'object') {
      cursor[part] = {}
    } else {
      cursor[part] = { ...(existing as Record<string, unknown>) }
    }
    cursor = cursor[part] as Record<string, unknown>
  }

  const lastKey = parts[parts.length - 1] ?? ''
  cursor[lastKey] = value
  return result
}

// ---------------------------------------------------------------------------
// getVersionCompatibility — utility exported from core
// ---------------------------------------------------------------------------

/**
 * Check whether a config format version is compatible with this toolkit.
 *
 * @param version - Version string to check
 * @returns true if the version is in SUPPORTED_CONFIG_FORMAT_VERSIONS
 */
export function getVersionCompatibility(version: string): boolean {
  return isVersionSupported(version, SUPPORTED_CONFIG_FORMAT_VERSIONS)
}

// ---------------------------------------------------------------------------
// ConfigSystemImpl
// ---------------------------------------------------------------------------

export class ConfigSystemImpl implements ConfigSystem {
  private _config: SubstrateConfig | null = null
  private readonly _projectConfigDir: string
  private readonly _globalConfigDir: string
  private readonly _cliOverrides: PartialSubstrateConfig
  private readonly _logger: ILogger

  constructor(options: ConfigSystemOptions = {}) {
    this._projectConfigDir = options.projectConfigDir
      ? resolve(options.projectConfigDir)
      : resolve(process.cwd(), '.substrate')
    this._globalConfigDir = options.globalConfigDir
      ? resolve(options.globalConfigDir)
      : resolve(homedir(), '.substrate')
    this._cliOverrides = options.cliOverrides ?? {}
    this._logger = options.logger ?? console
  }

  get isLoaded(): boolean {
    return this._config !== null
  }

  async load(): Promise<void> {
    // 1. Start with built-in defaults
    let merged: SubstrateConfig = structuredClone(DEFAULT_CONFIG)

    // 2. Apply global user config if present
    const globalConfig = await this._loadYamlFile(
      join(this._globalConfigDir, 'config.yaml')
    )
    if (globalConfig !== null) {
      merged = deepMerge(
        merged as unknown as Record<string, unknown>,
        globalConfig as DeepPartial<Record<string, unknown>>
      ) as unknown as SubstrateConfig
    }

    // 3. Apply project config if present
    const projectConfig = await this._loadYamlFile(
      join(this._projectConfigDir, 'config.yaml')
    )
    if (projectConfig !== null) {
      merged = deepMerge(
        merged as unknown as Record<string, unknown>,
        projectConfig as DeepPartial<Record<string, unknown>>
      ) as unknown as SubstrateConfig
    }

    // 4. Apply environment variable overrides
    const envOverrides = readEnvOverrides(this._logger)
    if (Object.keys(envOverrides).length > 0) {
      merged = deepMerge(
        merged as unknown as Record<string, unknown>,
        envOverrides as DeepPartial<Record<string, unknown>>
      ) as unknown as SubstrateConfig
    }

    // 5. Apply CLI flag overrides
    if (Object.keys(this._cliOverrides).length > 0) {
      merged = deepMerge(
        merged as unknown as Record<string, unknown>,
        this._cliOverrides as DeepPartial<Record<string, unknown>>
      ) as unknown as SubstrateConfig
    }

    // 6. Validate the merged config
    const result = SubstrateConfigSchema.safeParse(merged)
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')
      throw new ConfigError(
        `Configuration validation failed:\n${issues}`,
        { issues: result.error.issues }
      )
    }

    this._config = result.data
    this._logger.debug('Configuration loaded successfully')
  }

  getConfig(): SubstrateConfig {
    if (this._config === null) {
      throw new ConfigError(
        'Configuration has not been loaded. Call load() before getConfig().',
        {}
      )
    }
    return this._config
  }

  get(key: string): unknown {
    const config = this.getConfig()
    return getByPath(config, key)
  }

  async set(key: string, value: unknown): Promise<void> {
    // Validate key exists in schema by checking current merged config path
    const current = this.getConfig()
    const existing = getByPath(current, key)

    // Reject unknown keys — the key must resolve to something in the merged config
    if (existing === undefined) {
      throw new ConfigError(
        `Unknown config key: ${key}`,
        { key }
      )
    }

    // Key path must resolve to a non-object (scalar) — we don't allow replacing whole sections
    if (
      typeof existing === 'object' &&
      existing !== null
    ) {
      throw new ConfigError(
        `Cannot set object key "${key}" — use a more specific dot-notation path`,
        { key }
      )
    }

    // Load the raw project config file (or start fresh)
    let projectConfigRaw: Record<string, unknown> = {}
    const projectConfigPath = join(this._projectConfigDir, 'config.yaml')
    const existingYaml = await this._loadYamlFile(projectConfigPath)
    if (existingYaml !== null) {
      projectConfigRaw = existingYaml as Record<string, unknown>
    }

    // Apply the change
    const updated = setByPath(projectConfigRaw, key, value)

    // Validate the partial update
    const partial = PartialSubstrateConfigSchema.safeParse(updated)
    if (!partial.success) {
      const issues = partial.error.issues
        .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
        .join('\n')
      throw new ConfigError(
        `Invalid value for "${key}":\n${issues}`,
        { key, value, issues: partial.error.issues }
      )
    }

    // Write back and reload
    await mkdir(this._projectConfigDir, { recursive: true })
    const yamlStr = yaml.dump(updated)
    await writeFile(projectConfigPath, yamlStr, 'utf-8')

    // Reload to get the updated merged config
    await this.load()
  }

  getMasked(): SubstrateConfig {
    const config = this.getConfig()
    return deepMask(config) as SubstrateConfig
  }

  getConfigFormatVersion(): string {
    return CURRENT_CONFIG_FORMAT_VERSION
  }

  isCompatible(version: string): boolean {
    return SUPPORTED_CONFIG_FORMAT_VERSIONS.includes(version)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath)
      return true
    } catch {
      return false
    }
  }

  private async _loadYamlFile(filePath: string): Promise<PartialSubstrateConfig | null> {
    if (!(await this._fileExists(filePath))) return null

    try {
      const raw = await readFile(filePath, 'utf-8')
      let parsed = yaml.load(raw)

      // Pre-check config_format_version and attempt auto-migration before Zod runs (AC4, AC5)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const rawObj = parsed as Record<string, unknown>
        const version = rawObj['config_format_version']
        if (version !== undefined && typeof version === 'string' && !isVersionSupported(version, SUPPORTED_CONFIG_FORMAT_VERSIONS)) {
          // Attempt auto-migration if a migration path exists (FR63)
          if (defaultConfigMigrator.canMigrate(version, CURRENT_CONFIG_FORMAT_VERSION)) {
            const migrationOutput = defaultConfigMigrator.migrate(
              rawObj, version, CURRENT_CONFIG_FORMAT_VERSION, filePath,
            )
            if (migrationOutput.result.success) {
              this._logger.info(
                { from: version, to: CURRENT_CONFIG_FORMAT_VERSION, backup: migrationOutput.result.backupPath },
                'Config auto-migrated successfully',
              )
              parsed = migrationOutput.config
            } else {
              throw new ConfigIncompatibleFormatError(
                `Config migration failed: ${migrationOutput.result.manualStepsRequired.join('; ')}`,
                { filePath, version },
              )
            }
          } else {
            throw new ConfigIncompatibleFormatError(
              formatUnsupportedVersionError('config', version, SUPPORTED_CONFIG_FORMAT_VERSIONS),
              { filePath },
            )
          }
        }
      }

      const result = PartialSubstrateConfigSchema.safeParse(parsed)
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
          .join('\n')
        throw new ConfigError(
          `Invalid config file at ${filePath}:\n${issues}`,
          { filePath, issues: result.error.issues }
        )
      }

      return result.data
    } catch (err) {
      if (err instanceof ConfigError) throw err
      if (err instanceof ConfigIncompatibleFormatError) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new ConfigError(
        `Failed to read config file at ${filePath}: ${message}`,
        { filePath }
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a new ConfigSystem instance.
 *
 * @example
 * const config = createConfigSystem()
 * await config.load()
 * const cfg = config.getConfig()
 */
export function createConfigSystem(options: ConfigSystemOptions = {}): ConfigSystem {
  return new ConfigSystemImpl(options)
}
