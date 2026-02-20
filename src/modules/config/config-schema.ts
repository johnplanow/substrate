/**
 * Zod validation schemas for the Substrate configuration system.
 *
 * Defines schemas for all config sections:
 *  - provider config (claude, codex, gemini)
 *  - global settings
 *  - routing policy
 *  - full config document
 */

import { z } from 'zod'

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
  })
  .strict()

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>

// ---------------------------------------------------------------------------
// Routing policy schema
// ---------------------------------------------------------------------------

export const RoutingRuleSchema = z
  .object({
    task_type: z.string(),
    preferred_provider: z.string(),
    fallback_providers: z.array(z.string()),
  })
  .strict()

export type RoutingRule = z.infer<typeof RoutingRuleSchema>

export const RoutingPolicySchema = z
  .object({
    default_provider: z.string(),
    rules: z.array(RoutingRuleSchema),
  })
  .strict()

export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>

// ---------------------------------------------------------------------------
// Top-level configuration document
// ---------------------------------------------------------------------------

/** Current supported config format version */
export const CURRENT_CONFIG_FORMAT_VERSION = '1'

/** Current supported task graph version */
export const CURRENT_TASK_GRAPH_VERSION = '1'

export const SubstrateConfigSchema = z
  .object({
    /** Schema version for migration support (FR63) */
    config_format_version: z.literal('1'),
    /** Task graph version for migration support */
    task_graph_version: z.literal('1').optional(),
    global: GlobalSettingsSchema,
    providers: ProvidersSchema,
  })
  .strict()

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
    config_format_version: z.literal('1').optional(),
    task_graph_version: z.literal('1').optional(),
    global: PartialGlobalSettingsSchema.optional(),
    providers: z
      .object({
        claude: PartialProviderConfigSchema.optional(),
        codex: PartialProviderConfigSchema.optional(),
        gemini: PartialProviderConfigSchema.optional(),
      })
      .partial()
      .optional(),
  })
  .strict()

export type PartialSubstrateConfig = z.infer<typeof PartialSubstrateConfigSchema>
