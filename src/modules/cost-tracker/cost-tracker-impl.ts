/**
 * CostTrackerImpl — concrete implementation of the CostTracker interface.
 *
 * Responsibilities:
 *  - Record cost entries per task (AC1)
 *  - Aggregate session cost summaries with subscription vs. API breakdown (AC2)
 *  - Calculate savings from subscription routing (AC4)
 *  - Emit cost:recorded events via TypedEventBus
 *  - Use atomic database operations for consistency
 *
 * Architecture constraints:
 *  - Uses better-sqlite3 synchronous API for zero-latency writes (NFR22)
 *  - Cost recording is synchronous for consistency with event handling
 *  - Subscription billing_mode => cost_usd = 0; savings = equivalent API cost
 *  - Token rates in USD per 1M tokens (AC3)
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { CostEntry, TaskCostSummary, SessionCostSummary } from './types.js'
import { TOKEN_RATES, getTokenRate, estimateCostSafe } from './token-rates.js'
import type { TokenRates } from './token-rates.js'
import {
  recordCostEntry,
  incrementTaskCost,
  getCostEntryById,
  getSessionCostSummary,
  getTaskCostSummary,
  getAgentCostBreakdown,
  getAllCostEntries,
} from '../../persistence/queries/cost.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('cost-tracker')

// ---------------------------------------------------------------------------
// CostTracker interface
// ---------------------------------------------------------------------------

/**
 * CostTracker records and queries cost data for tasks and sessions.
 *
 * All methods are synchronous (uses better-sqlite3) to avoid blocking
 * the event loop or adding latency to task execution.
 */
export interface CostTracker {
  /**
   * Record the cost for a completed task.
   *
   * For subscription billing, cost_usd = 0 and savings_usd = equivalent API cost.
   * For API billing, cost_usd = actual API charge and savings_usd = 0.
   *
   * Returns the inserted CostEntry.
   */
  recordTaskCost(
    sessionId: string,
    taskId: string,
    agentUsed: string,
    providerUsed: string,
    modelUsed: string,
    tokensInput: number,
    tokensOutput: number,
    billingMode: 'subscription' | 'api',
  ): CostEntry

  /**
   * Retrieve aggregated cost data for a single task.
   */
  getTaskCost(taskId: string): TaskCostSummary

  /**
   * Retrieve the full session cost summary with breakdown by billing mode
   * and per-agent totals (FR26, FR28).
   */
  getSessionCost(sessionId: string): SessionCostSummary

  /**
   * Retrieve cost breakdown for a specific agent within a session.
   */
  getAgentCostBreakdown(
    sessionId: string,
    agent: string,
  ): { cost_usd: number; task_count: number; billing_breakdown: { subscription: number; api: number } }

  /**
   * Retrieve all cost entries for a session, optionally paginated.
   */
  getAllCosts(sessionId: string, limit?: number): CostEntry[]
}

// ---------------------------------------------------------------------------
// CostTrackerImpl
// ---------------------------------------------------------------------------

export class CostTrackerImpl implements CostTracker {
  private readonly _db: BetterSqlite3Database
  private readonly _eventBus: TypedEventBus
  private readonly _tokenRates: TokenRates

  constructor(db: BetterSqlite3Database, eventBus: TypedEventBus, tokenRates: TokenRates) {
    this._db = db
    this._eventBus = eventBus
    this._tokenRates = tokenRates
  }

  recordTaskCost(
    sessionId: string,
    taskId: string,
    agentUsed: string,
    providerUsed: string,
    modelUsed: string,
    tokensInput: number,
    tokensOutput: number,
    billingMode: 'subscription' | 'api',
  ): CostEntry {
    // Calculate the equivalent API cost regardless of billing mode
    // This is used for savings calculation when billing_mode = 'subscription'
    // Uses the injected tokenRates so custom rates actually affect cost estimation
    const equivalentApiCost = estimateCostSafe(providerUsed, modelUsed, tokensInput, tokensOutput, this._tokenRates)

    // When subscription billing: zero marginal cost, savings = equivalent API rate
    // When API billing: actual cost charged, zero savings
    const costUsd = billingMode === 'subscription' ? 0 : equivalentApiCost
    const savingsUsd = billingMode === 'subscription' ? equivalentApiCost : 0

    // Write cost entry and update task cost atomically; return DB-assigned id
    const insertAndUpdate = this._db.transaction(() => {
      const newId = recordCostEntry(this._db, {
        session_id: sessionId,
        task_id: taskId,
        agent: agentUsed,
        provider: providerUsed,
        model: modelUsed,
        billing_mode: billingMode,
        tokens_input: tokensInput,
        tokens_output: tokensOutput,
        cost_usd: costUsd,
        savings_usd: savingsUsd,
      })

      // Atomically increment the task's cumulative cost
      incrementTaskCost(this._db, taskId, costUsd)

      return newId
    })

    const insertedId = insertAndUpdate()

    if (!insertedId) {
      throw new Error(`Cost entry insert failed: transaction returned id=${insertedId}`)
    }

    // Retrieve the full record with the DB-assigned id and timestamp
    const entry = getCostEntryById(this._db, insertedId)
    if (!entry) {
      throw new Error(`Cost entry not found after insert: id=${insertedId}`)
    }

    // Emit cost:recorded event (non-blocking — event bus is synchronous)
    this._eventBus.emit('cost:recorded', {
      taskId,
      sessionId,
      costUsd: entry.cost_usd,
      savingsUsd: entry.savings_usd,
      billingMode: entry.billing_mode,
    })

    logger.debug(
      { taskId, billingMode, costUsd: entry.cost_usd, savingsUsd: entry.savings_usd, tokensInput, tokensOutput },
      'Cost recorded',
    )

    return entry
  }

  getTaskCost(taskId: string): TaskCostSummary {
    return getTaskCostSummary(this._db, taskId)
  }

  getSessionCost(sessionId: string): SessionCostSummary {
    return getSessionCostSummary(this._db, sessionId)
  }

  getAgentCostBreakdown(
    sessionId: string,
    agent: string,
  ): { cost_usd: number; task_count: number; billing_breakdown: { subscription: number; api: number } } {
    const breakdown = getAgentCostBreakdown(this._db, sessionId, agent)
    return {
      cost_usd: breakdown.cost_usd,
      task_count: breakdown.task_count,
      billing_breakdown: {
        subscription: breakdown.subscription_tasks,
        api: breakdown.api_tasks,
      },
    }
  }

  getAllCosts(sessionId: string, limit?: number): CostEntry[] {
    return getAllCostEntries(this._db, sessionId, limit)
  }

  /**
   * Look up token rates for a given provider and model.
   * Delegates to getTokenRate using the injected tokenRates table.
   */
  getTokenRate(provider: string, model: string) {
    return getTokenRate(provider, model, this._tokenRates)
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CostTrackerOptions {
  db: BetterSqlite3Database
  eventBus: TypedEventBus
  tokenRates?: TokenRates
}

/**
 * Create a CostTrackerImpl with the given database, event bus, and token rates.
 *
 * If tokenRates is not provided, the built-in TOKEN_RATES table is used.
 */
export function createCostTracker(options: CostTrackerOptions): CostTracker {
  return new CostTrackerImpl(options.db, options.eventBus, options.tokenRates ?? TOKEN_RATES)
}
