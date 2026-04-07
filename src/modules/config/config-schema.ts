/**
 * Re-export shim for config schemas.
 *
 * Most schemas are now defined in @substrate-ai/core. This shim re-exports
 * them plus defines the following locally (not in core):
 *  - RoutingPolicySchema / RoutingPolicy / RoutingRuleSchema / RoutingRule
 *    (config-level routing distinct from routing module's RoutingPolicy)
 *  - TokenCeilingsSchema / TokenCeilings (SDLC-specific, excluded from core)
 *  - SubstrateConfigSchema / SubstrateConfig (extended with token_ceilings, strict)
 *  - PartialSubstrateConfigSchema / PartialSubstrateConfig (extended with token_ceilings, strict)
 */

import { z } from 'zod'
import {
  SubscriptionRoutingSchema,
  RateLimitSchema,
  ProviderConfigSchema,
  ProvidersSchema,
  LogLevelSchema,
  GlobalSettingsSchema,
  CostTrackerConfigSchema,
  BudgetConfigSchema,
  TelemetryConfigSchema,
  PartialProviderConfigSchema,
  PartialGlobalSettingsSchema,
  CURRENT_CONFIG_FORMAT_VERSION,
  CURRENT_TASK_GRAPH_VERSION,
  SUPPORTED_CONFIG_FORMAT_VERSIONS,
  SUPPORTED_TASK_GRAPH_VERSIONS,
} from '@substrate-ai/core'

// Re-export all core schemas and types
export {
  SubscriptionRoutingSchema,
  RateLimitSchema,
  ProviderConfigSchema,
  ProvidersSchema,
  LogLevelSchema,
  GlobalSettingsSchema,
  CostTrackerConfigSchema,
  BudgetConfigSchema,
  TelemetryConfigSchema,
  PartialProviderConfigSchema,
  PartialGlobalSettingsSchema,
  CURRENT_CONFIG_FORMAT_VERSION,
  CURRENT_TASK_GRAPH_VERSION,
  SUPPORTED_CONFIG_FORMAT_VERSIONS,
  SUPPORTED_TASK_GRAPH_VERSIONS,
}

export type {
  SubscriptionRouting,
  ProviderConfig,
  ProvidersConfig,
  LogLevelValue,
  GlobalSettings,
  CostTrackerConfig,
  BudgetConfig,
  TelemetryConfig,
  PartialProviderConfig,
  PartialGlobalSettings,
} from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// RoutingPolicy — defined locally (config-level, different from routing module)
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
// TokenCeilingsSchema — SDLC-specific, excluded from core
// ---------------------------------------------------------------------------

/**
 * Per-workflow token ceiling overrides.
 * Keys match the workflow type names used in prompts and events.
 * Values must be positive integers.
 */
export const TokenCeilingsSchema = z.object({
  'create-story': z.number().int().positive('create-story token ceiling must be a positive integer').optional(),
  'dev-story': z.number().int().positive('dev-story token ceiling must be a positive integer').optional(),
  'code-review': z.number().int().positive('code-review token ceiling must be a positive integer').optional(),
  'test-plan': z.number().int().positive('test-plan token ceiling must be a positive integer').optional(),
  'test-expansion': z.number().int().positive('test-expansion token ceiling must be a positive integer').optional(),
})

export type TokenCeilings = z.infer<typeof TokenCeilingsSchema>

// ---------------------------------------------------------------------------
// DispatchTimeoutsSchema — per-task-type timeout overrides (milliseconds)
// ---------------------------------------------------------------------------

/**
 * Per-task-type dispatch timeout overrides (milliseconds).
 * Keys match task types in DEFAULT_TIMEOUTS. Values override defaults.
 */
export const DispatchTimeoutsSchema = z.object({
  'create-story': z.number().int().positive().optional(),
  'dev-story': z.number().int().positive().optional(),
  'code-review': z.number().int().positive().optional(),
  'minor-fixes': z.number().int().positive().optional(),
  'major-rework': z.number().int().positive().optional(),
})

export type DispatchTimeouts = z.infer<typeof DispatchTimeoutsSchema>

// ---------------------------------------------------------------------------
// SubstrateConfigSchema — strict and includes token_ceilings (SDLC full schema)
// ---------------------------------------------------------------------------

export const SubstrateConfigSchema = z
  .object({
    /** Schema version for migration support (FR63) */
    config_format_version: z.enum(['1']),
    /** Task graph version for migration support */
    task_graph_version: z.enum(['1']).optional(),
    global: GlobalSettingsSchema,
    providers: ProvidersSchema,
    /** Cost tracker settings (Story 4.2) */
    cost_tracker: CostTrackerConfigSchema.optional(),
    /** Budget enforcement settings (Story 4.3) */
    budget: BudgetConfigSchema.optional(),
    /** Per-workflow token ceiling overrides (Story 24-7) */
    token_ceilings: TokenCeilingsSchema.optional(),
    /** Per-task-type dispatch timeout overrides in ms (pipeline finding v0.19.0) */
    dispatch_timeouts: DispatchTimeoutsSchema.optional(),
    /** OTLP telemetry ingestion settings (Story 27-9) */
    telemetry: TelemetryConfigSchema.optional(),
    /** Default agent backend for all dispatches (e.g., 'claude-code', 'codex', 'gemini'). Defaults to 'claude-code'. */
    default_agent: z.string().optional(),
    /** Supervisor poll interval in seconds. Overrides --poll-interval CLI flag when set (Story 53-1 AC6). Default: 30. */
    supervisor_poll_interval_seconds: z.number().int().positive().optional(),
    /** Per-story maximum retry count before mandatory escalation (Story 53-4 AC7). Default: 2. */
    retry_budget: z.number().int().positive().optional(),
  })
  .strict()

export type SubstrateConfig = z.infer<typeof SubstrateConfigSchema>

// ---------------------------------------------------------------------------
// PartialSubstrateConfigSchema — strict and includes token_ceilings
// ---------------------------------------------------------------------------

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
    token_ceilings: TokenCeilingsSchema.optional(),
    dispatch_timeouts: DispatchTimeoutsSchema.optional(),
    telemetry: TelemetryConfigSchema.partial().optional(),
    default_agent: z.string().optional(),
    /** Supervisor poll interval in seconds. Overrides --poll-interval CLI flag when set (Story 53-1 AC6). Default: 30. */
    supervisor_poll_interval_seconds: z.number().int().positive().optional(),
    /** Per-story maximum retry count before mandatory escalation (Story 53-4 AC7). Default: 2. */
    retry_budget: z.number().int().positive().optional(),
  })
  .strict()

export type PartialSubstrateConfig = z.infer<typeof PartialSubstrateConfigSchema>
