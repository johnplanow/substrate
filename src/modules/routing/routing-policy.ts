/**
 * Re-export shim — routing/routing-policy.ts
 *
 * RoutingPolicy schema, types, and loader have moved to @substrate-ai/core.
 * This file exists for backwards compatibility with existing monolith imports.
 */
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
