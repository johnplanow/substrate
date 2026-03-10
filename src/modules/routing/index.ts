/**
 * Routing module — barrel export.
 *
 * Public API for the routing module:
 *  - RoutingEngine interface and factory
 *  - RoutingDecision type and builder
 *  - ProviderStatus type and tracker
 *  - RoutingPolicy schema and loader
 */

export type { RoutingEngine, RoutingEngineOptions } from './routing-engine.js'
export { createRoutingEngine } from './routing-engine.js'

export type { RoutingDecision } from './routing-decision.js'
export { makeRoutingDecision, RoutingDecisionBuilder } from './routing-decision.js'

export type { ProviderStatus } from './provider-status.js'
export { ProviderStatusTracker } from './provider-status.js'

export type {
  RoutingPolicy,
  ProviderPolicy,
  TaskTypePolicy,
  DefaultRoutingPolicy,
  ApiBillingConfig,
  RateLimitConfig,
} from './routing-policy.js'
export {
  RoutingPolicySchema,
  ProviderPolicySchema,
  loadRoutingPolicy,
  RoutingPolicyValidationError,
} from './routing-policy.js'

export type { RoutingEngineImplOptions } from './routing-engine-impl.js'
export { RoutingEngineImpl, createRoutingEngineImpl } from './routing-engine-impl.js'

export type { ModelRoutingConfig, ModelPhaseConfig } from './model-routing-config.js'
export {
  ModelRoutingConfigSchema,
  RoutingConfigError,
  loadModelRoutingConfig,
} from './model-routing-config.js'

export type { ModelResolution } from './model-routing-resolver.js'
export {
  RoutingResolver,
  TASK_TYPE_PHASE_MAP,
} from './model-routing-resolver.js'

export type {
  PhaseTokenEntry,
  PhaseTokenBreakdown,
  RoutingRecommendation,
  RoutingAnalysis,
  TuneLogEntry,
} from './types.js'

export { RoutingTokenAccumulator } from './routing-token-accumulator.js'

export { RoutingTelemetry } from './routing-telemetry.js'

export { RoutingRecommender } from './routing-recommender.js'

export { RoutingTuner } from './routing-tuner.js'

export { getModelTier } from './model-tier.js'
