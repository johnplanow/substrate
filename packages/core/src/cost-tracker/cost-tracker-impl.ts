/**
 * CostTrackerImpl — concrete implementation of the CostTracker interface.
 * Migrated to @substrate-ai/core (Story 41-7)
 */

import type { DatabaseAdapter } from '../persistence/types.js'
import type { TypedEventBus, CoreEvents } from '../events/index.js'
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
} from '../persistence/queries/cost.js'
import type { ILogger } from '../dispatch/types.js'

// ---------------------------------------------------------------------------
// CostTracker interface
// ---------------------------------------------------------------------------

export interface CostTracker {
  recordTaskCost(
    sessionId: string,
    taskId: string,
    agentUsed: string,
    providerUsed: string,
    modelUsed: string,
    tokensInput: number,
    tokensOutput: number,
    billingMode: 'subscription' | 'api'
  ): Promise<CostEntry>

  getTaskCost(taskId: string): Promise<TaskCostSummary>

  getSessionCost(sessionId: string): Promise<SessionCostSummary>

  getAgentCostBreakdown(
    sessionId: string,
    agent: string
  ): Promise<{
    cost_usd: number
    task_count: number
    billing_breakdown: { subscription: number; api: number }
  }>

  getAllCosts(sessionId: string, limit?: number): Promise<CostEntry[]>
}

// ---------------------------------------------------------------------------
// CostTrackerImpl
// ---------------------------------------------------------------------------

export class CostTrackerImpl implements CostTracker {
  private readonly _db: DatabaseAdapter
  private readonly _eventBus: TypedEventBus<CoreEvents>
  private readonly _tokenRates: TokenRates
  private readonly _logger: ILogger

  constructor(
    db: DatabaseAdapter,
    eventBus: TypedEventBus<CoreEvents>,
    tokenRates: TokenRates,
    logger?: ILogger
  ) {
    this._db = db
    this._eventBus = eventBus
    this._tokenRates = tokenRates
    this._logger = logger ?? console
  }

  async recordTaskCost(
    sessionId: string,
    taskId: string,
    agentUsed: string,
    providerUsed: string,
    modelUsed: string,
    tokensInput: number,
    tokensOutput: number,
    billingMode: 'subscription' | 'api'
  ): Promise<CostEntry> {
    const equivalentApiCost = estimateCostSafe(
      providerUsed,
      modelUsed,
      tokensInput,
      tokensOutput,
      this._tokenRates
    )

    const costUsd = billingMode === 'subscription' ? 0 : equivalentApiCost
    const savingsUsd = billingMode === 'subscription' ? equivalentApiCost : 0

    const insertedId = await this._db.transaction(async () => {
      const newId = await recordCostEntry(this._db, {
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

      await incrementTaskCost(this._db, taskId, costUsd)

      return newId
    })

    if (!insertedId) {
      throw new Error(`Cost entry insert failed: transaction returned id=${insertedId}`)
    }

    const entry = await getCostEntryById(this._db, insertedId)
    if (!entry) {
      throw new Error(`Cost entry not found after insert: id=${insertedId}`)
    }

    this._eventBus.emit('cost:recorded', {
      taskId,
      sessionId,
      costUsd: entry.cost_usd,
      savingsUsd: entry.savings_usd,
      billingMode: entry.billing_mode,
    })

    this._logger.debug(
      {
        taskId,
        billingMode,
        costUsd: entry.cost_usd,
        savingsUsd: entry.savings_usd,
        tokensInput,
        tokensOutput,
      },
      'Cost recorded'
    )

    return entry
  }

  async getTaskCost(taskId: string): Promise<TaskCostSummary> {
    return getTaskCostSummary(this._db, taskId)
  }

  async getSessionCost(sessionId: string): Promise<SessionCostSummary> {
    return getSessionCostSummary(this._db, sessionId)
  }

  async getAgentCostBreakdown(
    sessionId: string,
    agent: string
  ): Promise<{
    cost_usd: number
    task_count: number
    billing_breakdown: { subscription: number; api: number }
  }> {
    const breakdown = await getAgentCostBreakdown(this._db, sessionId, agent)
    return {
      cost_usd: breakdown.cost_usd,
      task_count: breakdown.task_count,
      billing_breakdown: {
        subscription: breakdown.subscription_tasks,
        api: breakdown.api_tasks,
      },
    }
  }

  async getAllCosts(sessionId: string, limit?: number): Promise<CostEntry[]> {
    return getAllCostEntries(this._db, sessionId, limit)
  }

  getTokenRate(provider: string, model: string) {
    return getTokenRate(provider, model, this._tokenRates)
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CostTrackerOptions {
  db: DatabaseAdapter
  eventBus: TypedEventBus<CoreEvents>
  tokenRates?: TokenRates
  logger?: ILogger
}

export function createCostTracker(options: CostTrackerOptions): CostTracker {
  return new CostTrackerImpl(
    options.db,
    options.eventBus,
    options.tokenRates ?? TOKEN_RATES,
    options.logger
  )
}
