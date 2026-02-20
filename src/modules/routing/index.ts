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
