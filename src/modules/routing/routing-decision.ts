/**
 * Re-export shim — routing/routing-decision.ts
 *
 * RoutingDecision, MonitorRecommendation, RoutingDecisionBuilder, and
 * makeRoutingDecision have moved to @substrate-ai/core.
 * This file exists for backwards compatibility with existing monolith imports.
 */
export type { RoutingDecision, MonitorRecommendation } from '@substrate-ai/core'
export { makeRoutingDecision, RoutingDecisionBuilder } from '@substrate-ai/core'
