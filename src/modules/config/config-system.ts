/**
 * ConfigSystem interface — public contract for the configuration subsystem.
 *
 * All callers should depend on this interface, not the concrete implementation.
 * Create an instance via `createConfigSystem()` from config-system-impl.ts.
 */

import type { SubstrateConfig, PartialSubstrateConfig } from './config-schema.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for initializing the config system.
 */
export interface ConfigSystemOptions {
  /** Path to the project-level .substrate/ directory (default: <cwd>/.substrate) */
  projectConfigDir?: string
  /** Path to the global user-level .substrate/ directory (default: ~/.substrate) */
  globalConfigDir?: string
  /**
   * Additional values that override everything except env vars.
   * Typically populated from CLI flags.
   */
  cliOverrides?: PartialSubstrateConfig
}

// ---------------------------------------------------------------------------
// ConfigSystem interface
// ---------------------------------------------------------------------------

/**
 * Provides access to fully-merged, validated Substrate configuration.
 *
 * Hierarchy (lowest → highest priority):
 *   built-in defaults < global config < project config < env vars < CLI flags
 */
export interface ConfigSystem {
  /**
   * Load and validate configuration from all sources in hierarchy order.
   * Must be called before `getConfig()`.
   */
  load(): Promise<void>

  /**
   * Return the fully-merged, validated configuration.
   * @throws {ConfigError} if `load()` has not been called or config is invalid.
   */
  getConfig(): SubstrateConfig

  /**
   * Return a single value by dot-notation key (e.g. "global.log_level").
   * @returns the value, or undefined if the key does not exist.
   */
  get(key: string): unknown

  /**
   * Persist a single value to the project config file using dot-notation key.
   * @throws {ConfigError} if key is invalid or the update fails.
   */
  set(key: string, value: unknown): Promise<void>

  /**
   * Return the merged config with all credential values masked.
   * Safe to display in CLI output or logs.
   */
  getMasked(): SubstrateConfig

  /**
   * Whether load() has been called and succeeded.
   */
  readonly isLoaded: boolean
}
