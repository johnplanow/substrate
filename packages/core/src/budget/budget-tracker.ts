/**
 * BudgetTracker — interface and stub for tracking token/cost budgets.
 * Migrated to @substrate-ai/core (Story 41-7)
 */

import type { IBaseService } from '../types.js'
import type { TypedEventBus, CoreEvents } from '../events/index.js'
import type { ILogger } from '../dispatch/types.js'

// ---------------------------------------------------------------------------
// BudgetTracker interface
// ---------------------------------------------------------------------------

export interface BudgetTracker extends IBaseService {
  // Full interface to be expanded in budget tracker implementation story
}

// ---------------------------------------------------------------------------
// BudgetTrackerImpl (stub)
// ---------------------------------------------------------------------------

export class BudgetTrackerImpl implements BudgetTracker {
  private readonly _eventBus: TypedEventBus<CoreEvents>
  private readonly _logger: ILogger

  constructor(eventBus: TypedEventBus<CoreEvents>, logger?: ILogger) {
    this._eventBus = eventBus
    this._logger = logger ?? console
  }

  async initialize(): Promise<void> {
    this._logger.info('BudgetTracker.initialize() — stub')

    // Subscribe to budget events
    this._eventBus.on('budget:warning', ({ taskId, currentSpend, limit }) => {
      this._logger.warn({ taskId, currentSpend, limit }, 'budget:warning')
    })

    this._eventBus.on('budget:exceeded', ({ taskId, spend, limit }) => {
      this._logger.error({ taskId, spend, limit }, 'budget:exceeded')
    })

    // Subscribe to task events for cost tracking
    this._eventBus.on('task:complete', ({ taskId, result }) => {
      this._logger.debug({ taskId, costUsd: result.costUsd }, 'task:complete — accumulate cost')
    })

    this._eventBus.on('task:progress', ({ taskId, tokensUsed }) => {
      this._logger.debug({ taskId, tokensUsed }, 'task:progress — update token usage')
    })
  }

  async shutdown(): Promise<void> {
    this._logger.info('BudgetTracker.shutdown() — stub')
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface BudgetTrackerOptions {
  eventBus: TypedEventBus<CoreEvents>
  logger?: ILogger
}

export function createBudgetTracker(options: BudgetTrackerOptions): BudgetTracker {
  return new BudgetTrackerImpl(options.eventBus, options.logger)
}
