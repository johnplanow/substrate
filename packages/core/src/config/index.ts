/**
 * Barrel export for config types, Zod schemas, and interfaces.
 *
 * NOTE: RateLimitConfig is intentionally not re-exported at the barrel level to
 * avoid a naming collision with the routing module's RateLimitConfig (which has a
 * different shape: tokens_per_window vs. tokens). The config-specific RateLimitConfig
 * remains available via direct import from packages/core/src/config/types.ts.
 */

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
  SubstrateConfigSchema,
  PartialProviderConfigSchema,
  PartialGlobalSettingsSchema,
  PartialSubstrateConfigSchema,
} from './types.js'

export type {
  SubscriptionRouting,
  // RateLimitConfig omitted — conflicts with routing module's RateLimitConfig (different shape).
  // Available via direct import from packages/core/src/config/types.ts.
  ProviderConfig,
  ProvidersConfig,
  LogLevelValue,
  GlobalSettings,
  CostTrackerConfig,
  BudgetConfig,
  TelemetryConfig,
  SubstrateConfig,
  PartialProviderConfig,
  PartialGlobalSettings,
  PartialSubstrateConfig,
  ConfigSystemOptions,
  ConfigSystem,
} from './types.js'
