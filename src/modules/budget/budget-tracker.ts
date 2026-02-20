/**
 * BudgetTracker — interface and stub for tracking token/cost budgets.
 *
 * The full implementation will be provided by a later story.
 * This stub subscribes to budget and task events and satisfies the
 * BaseService lifecycle contract.
 *
 * Event subscriptions (Architecture Section 19):
 *  - Listens to budget:warning and budget:exceeded events
 *  - Listens to task:complete and task:failed for cost accumulation
 */

import type { BaseService } from '../../core/di.js'
import type { TypedEventBus } from '../../core/event-bus.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('budget')

// ---------------------------------------------------------------------------
// BudgetTracker interface
// ---------------------------------------------------------------------------

export interface BudgetTracker extends BaseService {
  // Full interface to be expanded in budget tracker implementation story
}

// ---------------------------------------------------------------------------
// BudgetTrackerImpl (stub)
// ---------------------------------------------------------------------------

export class BudgetTrackerImpl implements BudgetTracker {
  private readonly _eventBus: TypedEventBus

  constructor(eventBus: TypedEventBus) {
    this._eventBus = eventBus
  }

  async initialize(): Promise<void> {
    logger.info('BudgetTracker.initialize() — stub')

    // Subscribe to budget events
    this._eventBus.on('budget:warning', ({ taskId, currentSpend, limit }) => {
      logger.warn({ taskId, currentSpend, limit }, 'budget:warning')
    })

    this._eventBus.on('budget:exceeded', ({ taskId, spend, limit }) => {
      logger.error({ taskId, spend, limit }, 'budget:exceeded')
    })

    // Subscribe to task events for cost tracking
    this._eventBus.on('task:complete', ({ taskId, result }) => {
      logger.debug({ taskId, costUsd: result.costUsd }, 'task:complete — accumulate cost')
    })

    this._eventBus.on('task:progress', ({ taskId, tokensUsed }) => {
      logger.debug({ taskId, tokensUsed }, 'task:progress — update token usage')
    })
  }

  async shutdown(): Promise<void> {
    logger.info('BudgetTracker.shutdown() — stub')
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface BudgetTrackerOptions {
  eventBus: TypedEventBus
}

export function createBudgetTracker(options: BudgetTrackerOptions): BudgetTracker {
  return new BudgetTrackerImpl(options.eventBus)
}
