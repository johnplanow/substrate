/**
 * CostTracker module — barrel export.
 *
 * Public API for the cost-tracker module:
 *  - CostTracker interface and implementation
 *  - Token rate lookup and cost estimation utilities
 *  - All shared types (CostEntry, TaskCostSummary, SessionCostSummary, etc.)
 */

export type { CostTracker } from './cost-tracker-impl.js'
export { CostTrackerImpl, createCostTracker } from './cost-tracker-impl.js'
export type { CostTrackerOptions } from './cost-tracker-impl.js'

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
  getTokenRate,
  estimateCost,
  estimateCostSafe,
} from './token-rates.js'
