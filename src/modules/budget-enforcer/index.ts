/**
 * BudgetEnforcer module — barrel export.
 *
 * Public API for the budget-enforcer module:
 *  - BudgetEnforcer interface and implementation
 *  - BudgetEnforcerSubscriber for event-driven integration
 *  - All shared types (BudgetCheckResult, BudgetStatus, SessionBudgetStatus)
 */

export type { BudgetEnforcer } from './budget-enforcer.js'

export type { BudgetCheckResult, BudgetStatus, SessionBudgetStatus } from './types.js'

export {
  BudgetEnforcerImpl,
  createBudgetEnforcer,
} from './budget-enforcer-impl.js'
export type { BudgetEnforcerOptions, BudgetEnforcerConfig } from './budget-enforcer-impl.js'

export {
  BudgetEnforcerSubscriber,
  createBudgetEnforcerSubscriber,
} from './budget-enforcer-subscriber.js'
export type { BudgetEnforcerSubscriberOptions } from './budget-enforcer-subscriber.js'
