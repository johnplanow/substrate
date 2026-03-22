/**
 * Routing module barrel export.
 * Re-exports all routing interfaces, schemas, types, and implementations
 * from @substrate-ai/core.
 */

// Duck-typed interfaces and token-analysis types
export * from './types.js'

// RoutingDecision, MonitorRecommendation, RoutingDecisionBuilder, makeRoutingDecision
export * from './routing-decision.js'

// ProviderStatus, ProviderStatusTracker
export * from './provider-status.js'

// ModelRoutingConfig, ModelPhaseConfig, ModelRoutingConfigSchema, RoutingConfigError, loadModelRoutingConfig
export * from './model-routing-config.js'

// RoutingPolicy and related, RoutingPolicySchema, ProviderPolicySchema, loadRoutingPolicy, RoutingPolicyValidationError
export * from './routing-policy.js'

// RoutingTask, ModelResolution, IRoutingResolver, RoutingEngine, TASK_TYPE_PHASE_MAP
export * from './routing-engine.js'

// RoutingEngineImpl, RoutingEngineImplOptions, createRoutingEngineImpl, createRoutingEngine
export * from './routing-engine-impl.js'

// RoutingResolver, ROUTING_RESOLVER_LOGGER_NAME
export * from './model-routing-resolver.js'

// getModelTier
export * from './model-tier.js'

// RoutingRecommender
export * from './routing-recommender.js'

// RoutingTelemetry
export * from './routing-telemetry.js'

// RoutingTokenAccumulator
export * from './routing-token-accumulator.js'

// RoutingTuner
export * from './routing-tuner.js'
