/**
 * Re-export shim — routing/index.ts
 *
 * All routing module exports have moved to @substrate-ai/core.
 * This file exists for backwards compatibility with existing monolith imports.
 *
 * Public API for the routing module:
 *  - RoutingEngine interface and factory
 *  - RoutingDecision type and builder
 *  - ProviderStatus type and tracker
 *  - RoutingPolicy schema and loader
 *  - RoutingEngineImpl and factory
 *  - ModelRoutingConfig schema and loader
 *  - RoutingResolver and related constants
 *  - Token tracking, telemetry, recommender, and tuner
 */

export type { RoutingEngine } from '@substrate-ai/core'
// RoutingEngineOptions alias for backwards compatibility
export type { RoutingEngineImplOptions as RoutingEngineOptions } from '@substrate-ai/core'
export { createRoutingEngine } from '@substrate-ai/core'

export type { RoutingDecision } from '@substrate-ai/core'
export { makeRoutingDecision, RoutingDecisionBuilder } from '@substrate-ai/core'

export type { ProviderStatus } from '@substrate-ai/core'
export { ProviderStatusTracker } from '@substrate-ai/core'

export type {
  RoutingPolicy,
  ProviderPolicy,
  TaskTypePolicy,
  DefaultRoutingPolicy,
  ApiBillingConfig,
  RateLimitConfig,
} from '@substrate-ai/core'
export {
  RoutingPolicySchema,
  ProviderPolicySchema,
  loadRoutingPolicy,
  RoutingPolicyValidationError,
} from '@substrate-ai/core'

export type { RoutingEngineImplOptions } from '@substrate-ai/core'
export { RoutingEngineImpl, createRoutingEngineImpl } from '@substrate-ai/core'

export type { ModelRoutingConfig, ModelPhaseConfig } from '@substrate-ai/core'
export {
  ModelRoutingConfigSchema,
  RoutingConfigError,
  loadModelRoutingConfig,
} from '@substrate-ai/core'

export type { ModelResolution } from '@substrate-ai/core'
export {
  RoutingResolver,
  TASK_TYPE_PHASE_MAP,
  ROUTING_RESOLVER_LOGGER_NAME,
} from '@substrate-ai/core'

export type {
  PhaseTokenEntry,
  PhaseTokenBreakdown,
  RoutingRecommendation,
  RoutingAnalysis,
  TuneLogEntry,
} from '@substrate-ai/core'

export { RoutingTokenAccumulator } from '@substrate-ai/core'

export { RoutingTelemetry } from '@substrate-ai/core'

export { RoutingRecommender } from '@substrate-ai/core'

export { RoutingTuner } from '@substrate-ai/core'

export { getModelTier } from '@substrate-ai/core'
