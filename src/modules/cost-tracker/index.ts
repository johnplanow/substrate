/**
 * CostTracker module barrel export — shim re-exporting from @substrate-ai/core (Story 41-7).
 *
 * Note: `estimateCost` exported here is the cost-tracker variant (provider, model, inputTokens, outputTokens).
 * The @substrate-ai/core root exports the telemetry version under the plain `estimateCost` name
 * and the cost-tracker version under the `estimateCostForProvider` alias.
 */
export type { CostTracker, CostTrackerOptions } from '@substrate-ai/core'
export { CostTrackerImpl, createCostTracker } from '@substrate-ai/core'
export { CostTrackerSubscriber, createCostTrackerSubscriber } from '@substrate-ai/core'
export type { CostTrackerSubscriberOptions } from '@substrate-ai/core'
export type { CostEntry, TaskCostSummary, SessionCostSummary, AgentCostBreakdown } from '@substrate-ai/core'
export type { TokenRates, ModelRates } from '@substrate-ai/core'
export {
  TOKEN_RATES,
  PROVIDER_ALIASES,
  getTokenRate,
  estimateCostForProvider as estimateCost,
  estimateCostSafe,
} from '@substrate-ai/core'
