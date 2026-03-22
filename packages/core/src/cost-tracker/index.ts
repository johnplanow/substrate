/**
 * Cost-tracker module barrel export — @substrate-ai/core (Story 41-7)
 */

export type { CostTracker, CostTrackerOptions } from './cost-tracker-impl.js'
export { CostTrackerImpl, createCostTracker } from './cost-tracker-impl.js'

export { CostTrackerSubscriber, createCostTrackerSubscriber } from './cost-tracker-subscriber.js'
export type { CostTrackerSubscriberOptions } from './cost-tracker-subscriber.js'

export type {
  CostEntry,
  TaskCostSummary,
  SessionCostSummary,
  AgentCostBreakdown,
} from './types.js'

export type { TokenRates, ModelRates } from './token-rates.js'
export {
  TOKEN_RATES,
  PROVIDER_ALIASES,
  getTokenRate,
  estimateCost,
  estimateCostSafe,
} from './token-rates.js'
