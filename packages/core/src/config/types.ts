/**
 * Zod validation schemas and TypeScript interfaces for the Substrate configuration system.
 *
 * Extracted from src/modules/config/config-schema.ts and src/modules/config/config-system.ts
 * for use in @substrate-ai/core.
 *
 * NOTE: TokenCeilings / token_ceilings is intentionally excluded from SubstrateConfig here.
 * That field is SDLC-specific. The SDLC package will extend this type with
 * `SdlcConfig extends SubstrateConfig` (with token_ceilings added) in a future story.
 */

import { z } from 'zod'
import type { ILogger } from '../dispatch/types.js'

// ---------------------------------------------------------------------------
// Provider-level schema
// ---------------------------------------------------------------------------

/** Subscription routing modes */
export const SubscriptionRoutingSchema = z.enum(['auto', 'subscription', 'api', 'disabled'])
export type SubscriptionRouting = z.infer<typeof SubscriptionRoutingSchema>

/** Rate limit configuration for a provider */
export const RateLimitSchema = z
  .object({
    tokens: z.number().int().positive(),
    window_seconds: z.number().int().positive(),
  })
  .strict()

export type RateLimitConfig = z.infer<typeof RateLimitSchema>

/** Per-provider configuration */
export const ProviderConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** Path to the CLI binary — resolved at runtime; never used for api keys */
    cli_path: z.string().optional(),
    subscription_routing: SubscriptionRoutingSchema,
    max_concurrent: z.number().int().min(1).max(32),
    rate_limit: RateLimitSchema.optional(),
    /** Name of the environment variable that holds the API key */
    api_key_env: z.string().optional(),
    /** Whether API billing is enabled for this provider */
    api_billing: z.boolean(),
  })
  .strict()

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

/** Map of all known providers */
export const ProvidersSchema = z
  .object({
    claude: ProviderConfigSchema.optional(),
    codex: ProviderConfigSchema.optional(),
    gemini: ProviderConfigSchema.optional(),
  })
  .strict()

export type ProvidersConfig = z.infer<typeof ProvidersSchema>

// ---------------------------------------------------------------------------
// Global / project settings
// ---------------------------------------------------------------------------

export const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
export type LogLevelValue = z.infer<typeof LogLevelSchema>

export const GlobalSettingsSchema = z
  .object({
    log_level: LogLevelSchema,
    max_concurrent_tasks: z.number().int().min(1).max(64),
    /** Max total tokens per orchestration session (0 = unlimited) */
    budget_cap_tokens: z.number().int().min(0),
    /** Max approximate USD cost per session (0 = unlimited) */
    budget_cap_usd: z.number().min(0),
    /** Working directory for temporary files */
    workspace_dir: z.string().optional(),
    /** Whether to perform automatic background update checks (default: true) */
    update_check: z.boolean().optional(),
  })
  .strict()

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>

// ---------------------------------------------------------------------------
// Cost tracker config schema
// ---------------------------------------------------------------------------

export const CostTrackerConfigSchema = z
  .object({
    /** Enable cost tracking (default: true) */
    enabled: z.boolean(),
    /** Source for token rates: 'builtin' uses built-in table, 'custom' uses injected custom rates */
    token_rates_provider: z.enum(['builtin', 'custom']),
    /** Whether to track planning/orchestration costs in addition to task costs */
    track_planning_costs: z.boolean(),
    /** Whether to include savings summary in cost reports (FR28) */
    savings_reporting: z.boolean(),
  })
  .strict()

export type CostTrackerConfig = z.infer<typeof CostTrackerConfigSchema>

// ---------------------------------------------------------------------------
// Budget enforcer config schema
// ---------------------------------------------------------------------------

export const BudgetConfigSchema = z
  .object({
    /** Default per-task budget cap in USD if task has no explicit cap (0 = unlimited) */
    default_task_budget_usd: z.number().min(0),
    /** Default session budget cap in USD (0 = unlimited) */
    default_session_budget_usd: z.number().min(0),
    /** When true, planning/orchestration costs count toward session budget */
    planning_costs_count_against_budget: z.boolean(),
    /** Percentage threshold at which budget:warning is emitted (0-100) */
    warning_threshold_percent: z.number().min(0).max(100),
  })
  .strict()

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>

// ---------------------------------------------------------------------------
// Telemetry config schema
// ---------------------------------------------------------------------------

export const TelemetryConfigSchema = z
  .object({
    /** Whether OTLP telemetry ingestion is enabled */
    enabled: z.boolean().default(false),
    /** Port for the local OTLP HTTP ingestion server (1–65535) */
    port: z.number().int().min(1).max(65535).default(4318),
    /** Agent-mesh telemetry server URL (e.g., http://localhost:4100). When set, run reports are pushed after pipeline completion. */
    meshUrl: z.string().url().optional(),
    /** Project identifier sent with run reports (e.g., "nextgen-ticketing"). Defaults to the directory name. */
    projectId: z.string().optional(),
  })
  .strict()

export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>

// ---------------------------------------------------------------------------
// Top-level configuration document
// (token_ceilings intentionally excluded — SDLC-specific, see file header)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config format version constants
// ---------------------------------------------------------------------------

/** Current supported config format version */
export const CURRENT_CONFIG_FORMAT_VERSION = '1'

/** Current supported task graph version */
export const CURRENT_TASK_GRAPH_VERSION = '1'

/** All config format versions this toolkit can read and validate */
export const SUPPORTED_CONFIG_FORMAT_VERSIONS: readonly string[] = ['1']

/** All task graph format versions this toolkit can read and validate */
export const SUPPORTED_TASK_GRAPH_VERSIONS: readonly string[] = ['1']

// ---------------------------------------------------------------------------
// Top-level configuration document
// (token_ceilings intentionally excluded — SDLC-specific, see file header)
// .passthrough() allows SDLC/factory packages to extend the config shape
// (e.g. with token_ceilings) without core validation stripping unknown keys.
// ---------------------------------------------------------------------------

export const SubstrateConfigSchema = z
  .object({
    /** Schema version for migration support */
    config_format_version: z.enum(['1']),
    /** Task graph version for migration support */
    task_graph_version: z.enum(['1']).optional(),
    global: GlobalSettingsSchema,
    providers: ProvidersSchema,
    /** Cost tracker settings */
    cost_tracker: CostTrackerConfigSchema.optional(),
    /** Budget enforcement settings */
    budget: BudgetConfigSchema.optional(),
    /** OTLP telemetry ingestion settings */
    telemetry: TelemetryConfigSchema.optional(),
    /** Minimum output token count for TrivialOutputCheck (Story 51-3). Default: 100. */
    trivialOutputThreshold: z.number().int().nonnegative().optional(),
  })
  .passthrough()

export type SubstrateConfig = z.infer<typeof SubstrateConfigSchema>

// ---------------------------------------------------------------------------
// Partial / merged config (allows partial during load before merging)
// ---------------------------------------------------------------------------

export const PartialProviderConfigSchema = ProviderConfigSchema.partial()
export type PartialProviderConfig = z.infer<typeof PartialProviderConfigSchema>

export const PartialGlobalSettingsSchema = GlobalSettingsSchema.partial()
export type PartialGlobalSettings = z.infer<typeof PartialGlobalSettingsSchema>

export const PartialSubstrateConfigSchema = z
  .object({
    config_format_version: z.enum(['1']).optional(),
    task_graph_version: z.enum(['1']).optional(),
    global: PartialGlobalSettingsSchema.optional(),
    providers: z
      .object({
        claude: PartialProviderConfigSchema.optional(),
        codex: PartialProviderConfigSchema.optional(),
        gemini: PartialProviderConfigSchema.optional(),
      })
      .partial()
      .optional(),
    cost_tracker: CostTrackerConfigSchema.partial().optional(),
    budget: BudgetConfigSchema.partial().optional(),
    telemetry: TelemetryConfigSchema.partial().optional(),
    /** Minimum output token count for TrivialOutputCheck (Story 51-3). Default: 100. */
    trivialOutputThreshold: z.number().int().nonnegative().optional(),
  })
  .passthrough()

export type PartialSubstrateConfig = z.infer<typeof PartialSubstrateConfigSchema>

// ---------------------------------------------------------------------------
// ConfigSystemOptions
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
  /**
   * Logger instance for config system messages.
   * Defaults to console if not provided.
   */
  logger?: ILogger
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

  /**
   * Return the current config format version string.
   */
  getConfigFormatVersion(): string

  /**
   * Check whether the given config format version is compatible with this toolkit.
   * @param version - Version string to check
   * @returns true if the version is in SUPPORTED_CONFIG_FORMAT_VERSIONS
   */
  isCompatible(version: string): boolean
}
