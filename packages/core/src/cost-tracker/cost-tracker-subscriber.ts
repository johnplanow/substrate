/**
 * CostTrackerSubscriber — subscribes to task lifecycle events and records
 * cost data via the CostTracker module.
 * Migrated to @substrate-ai/core (Story 41-7)
 */

import type { IBaseService } from '../types.js'
import type { TypedEventBus, CoreEvents } from '../events/index.js'
import type { CostTracker } from './cost-tracker-impl.js'
import { PROVIDER_ALIASES } from './token-rates.js'
import type { ILogger } from '../dispatch/types.js'

// ---------------------------------------------------------------------------
// RoutingContext
// ---------------------------------------------------------------------------

interface RoutingContext {
  sessionId: string
  agent: string
  provider: string
  model: string
  billingMode: 'subscription' | 'api'
}

// ---------------------------------------------------------------------------
// CostTrackerSubscriber
// ---------------------------------------------------------------------------

export class CostTrackerSubscriber implements IBaseService {
  private readonly _eventBus: TypedEventBus<CoreEvents>
  private readonly _costTracker: CostTracker
  private readonly _routingCache = new Map<string, RoutingContext>()
  private _defaultSessionId: string
  private readonly _logger: ILogger

  private readonly _onTaskRouted: (payload: {
    taskId: string
    decision: {
      taskId: string
      agent: string
      billingMode: string
      model?: string
      rationale: string
    }
  }) => void

  private readonly _onTaskComplete: (payload: {
    taskId: string
    result: {
      output?: string
      exitCode?: number
      tokensUsed?: number
      costUsd?: number
    }
  }) => void

  private readonly _onTaskFailed: (payload: {
    taskId: string
    error: { message: string; code?: string; stack?: string }
  }) => void

  constructor(eventBus: TypedEventBus<CoreEvents>, costTracker: CostTracker, sessionId?: string, logger?: ILogger) {
    this._eventBus = eventBus
    this._costTracker = costTracker
    this._defaultSessionId = sessionId ?? 'default'
    this._logger = logger ?? console

    this._onTaskRouted = (payload) => {
      const { taskId, decision } = payload

      if (decision.billingMode === 'unavailable') {
        this._logger.debug({ taskId }, 'Billing mode is "unavailable" — skipping cost tracking for unrouted task')
        return
      }

      const billingMode: 'subscription' | 'api' = decision.billingMode === 'subscription' ? 'subscription' : 'api'

      const provider = resolveProviderFromAgent(decision.agent)
      const model = decision.model ?? resolveDefaultModel(decision.agent)

      this._routingCache.set(taskId, {
        sessionId: this._defaultSessionId,
        agent: decision.agent,
        provider,
        model,
        billingMode,
      })

      this._logger.debug({ taskId, billingMode, provider, model }, 'Cached routing context for cost tracking')
    }

    this._onTaskComplete = (payload) => {
      const { taskId, result } = payload
      const routing = this._routingCache.get(taskId)

      if (!routing) {
        this._logger.debug({ taskId }, 'No routing context cached — skipping cost recording')
        return
      }

      const totalTokens = result.tokensUsed ?? 0
      const tokensInput = Math.round(totalTokens * 0.25)
      const tokensOutput = totalTokens - tokensInput

      try {
        this._costTracker.recordTaskCost(
          routing.sessionId,
          taskId,
          routing.agent,
          routing.provider,
          routing.model,
          tokensInput,
          tokensOutput,
          routing.billingMode,
        )
        this._logger.debug({ taskId, billingMode: routing.billingMode }, 'Cost recorded on task:complete')
      } catch (err) {
        this._logger.warn({ err, taskId }, 'Failed to record cost on task:complete (non-fatal)')
      } finally {
        this._routingCache.delete(taskId)
      }
    }

    this._onTaskFailed = (payload) => {
      const { taskId } = payload
      const routing = this._routingCache.get(taskId)

      if (!routing) {
        this._logger.debug({ taskId }, 'No routing context cached for failed task — skipping cost recording')
        return
      }

      try {
        this._costTracker.recordTaskCost(
          routing.sessionId,
          taskId,
          routing.agent,
          routing.provider,
          routing.model,
          0,
          0,
          routing.billingMode,
        )
        this._logger.debug({ taskId }, 'Zero-cost entry recorded for failed task')
      } catch (err) {
        this._logger.warn({ err, taskId }, 'Failed to record cost on task:failed (non-fatal)')
      } finally {
        this._routingCache.delete(taskId)
      }
    }
  }

  setDefaultSessionId(sessionId: string): void {
    this._defaultSessionId = sessionId
  }

  async initialize(): Promise<void> {
    this._eventBus.on('task:routed', this._onTaskRouted)
    this._eventBus.on('task:complete', this._onTaskComplete)
    this._eventBus.on('task:failed', this._onTaskFailed)
    this._logger.info('CostTrackerSubscriber initialized — subscribed to task events')
  }

  async shutdown(): Promise<void> {
    this._eventBus.off('task:routed', this._onTaskRouted)
    this._eventBus.off('task:complete', this._onTaskComplete)
    this._eventBus.off('task:failed', this._onTaskFailed)
    this._routingCache.clear()
    this._logger.info('CostTrackerSubscriber shutdown complete')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveProviderFromAgent(agent: string): string {
  return PROVIDER_ALIASES[agent.toLowerCase()] ?? agent.toLowerCase()
}

function resolveDefaultModel(agent: string): string {
  const defaults: Record<string, string> = {
    claude: 'claude-3-sonnet',
    codex: 'gpt-4o',
    gemini: 'gemini-1.5-pro',
  }
  return defaults[agent.toLowerCase()] ?? agent.toLowerCase()
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CostTrackerSubscriberOptions {
  eventBus: TypedEventBus<CoreEvents>
  costTracker: CostTracker
  sessionId?: string
  logger?: ILogger
}

export function createCostTrackerSubscriber(options: CostTrackerSubscriberOptions): CostTrackerSubscriber {
  return new CostTrackerSubscriber(options.eventBus, options.costTracker, options.sessionId, options.logger)
}
