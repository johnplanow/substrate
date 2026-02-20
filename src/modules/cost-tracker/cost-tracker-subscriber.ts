/**
 * CostTrackerSubscriber — subscribes to task lifecycle events and records
 * cost data via the CostTracker module.
 *
 * Integrates the CostTracker with the EventBus per Story 4.2 Task 5 (AC1, AC4):
 *  - Listens for task:routed to capture billingMode and routing metadata
 *  - Listens for task:complete to record cost after task finishes
 *  - Listens for task:failed to record zero-cost entry for failed tasks
 *
 * Design decisions:
 *  - Routing decisions are cached in memory (Map) until the task completes
 *  - Cost recording happens synchronously in the event handler (non-blocking due
 *    to better-sqlite3 synchronous API which is very fast for single writes)
 *  - Errors during cost recording are logged but never propagate to callers
 *  - Provider/model resolution: uses routing decision if available, falls back
 *    to defaults if not (graceful degradation)
 */

import type { BaseService } from '../../core/di.js'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { CostTracker } from './cost-tracker-impl.js'
import { PROVIDER_ALIASES } from './token-rates.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('cost-tracker:subscriber')

// ---------------------------------------------------------------------------
// RoutingContext — cached routing decision metadata for a task
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

/**
 * Bridges the EventBus with the CostTracker module.
 *
 * Lifecycle: call initialize() to subscribe, shutdown() to unsubscribe.
 */
export class CostTrackerSubscriber implements BaseService {
  private readonly _eventBus: TypedEventBus
  private readonly _costTracker: CostTracker
  /** In-memory cache: taskId -> routing context (cleared on task completion/failure) */
  private readonly _routingCache = new Map<string, RoutingContext>()
  /** Session ID resolved at construction or updated via setDefaultSessionId */
  private _defaultSessionId: string

  // Bound handlers for clean unsubscription
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

  constructor(eventBus: TypedEventBus, costTracker: CostTracker, sessionId?: string) {
    this._eventBus = eventBus
    this._costTracker = costTracker
    this._defaultSessionId = sessionId ?? 'default'

    this._onTaskRouted = (payload) => {
      const { taskId, decision } = payload

      // Fix #6: Skip cost recording for 'unavailable' billing mode (task was not routed)
      if (decision.billingMode === 'unavailable') {
        logger.debug({ taskId }, 'Billing mode is "unavailable" — skipping cost tracking for unrouted task')
        return
      }

      const billingMode: 'subscription' | 'api' = decision.billingMode === 'subscription' ? 'subscription' : 'api'

      // Derive provider from agent name (simple alias resolution)
      const provider = resolveProviderFromAgent(decision.agent)
      const model = decision.model ?? resolveDefaultModel(decision.agent)

      this._routingCache.set(taskId, {
        sessionId: this._defaultSessionId,
        agent: decision.agent,
        provider,
        model,
        billingMode,
      })

      logger.debug({ taskId, billingMode, provider, model }, 'Cached routing context for cost tracking')
    }

    this._onTaskComplete = (payload) => {
      const { taskId, result } = payload
      const routing = this._routingCache.get(taskId)

      if (!routing) {
        logger.debug({ taskId }, 'No routing context cached — skipping cost recording')
        return
      }

      // Fix #5: task:complete carries aggregate tokensUsed only.
      // Split proportionally: assume 25% input / 75% output as a reasonable heuristic
      // for LLM usage where output typically exceeds input. This is documented as a
      // limitation — when per-direction token counts become available in the event
      // payload, this heuristic should be replaced with actual values.
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
        logger.debug({ taskId, billingMode: routing.billingMode }, 'Cost recorded on task:complete')
      } catch (err) {
        logger.warn({ err, taskId }, 'Failed to record cost on task:complete (non-fatal)')
      } finally {
        this._routingCache.delete(taskId)
      }
    }

    this._onTaskFailed = (payload) => {
      const { taskId } = payload
      const routing = this._routingCache.get(taskId)

      if (!routing) {
        logger.debug({ taskId }, 'No routing context cached for failed task — skipping cost recording')
        return
      }

      // Record zero-cost entry for failed tasks (they may have consumed tokens up to failure)
      try {
        this._costTracker.recordTaskCost(
          routing.sessionId,
          taskId,
          routing.agent,
          routing.provider,
          routing.model,
          0, // tokens unknown on failure
          0,
          routing.billingMode,
        )
        logger.debug({ taskId }, 'Zero-cost entry recorded for failed task')
      } catch (err) {
        logger.warn({ err, taskId }, 'Failed to record cost on task:failed (non-fatal)')
      } finally {
        this._routingCache.delete(taskId)
      }
    }
  }

  /**
   * Set the default session ID used when session cannot be resolved from events.
   * Call this after the session is created.
   */
  setDefaultSessionId(sessionId: string): void {
    this._defaultSessionId = sessionId
  }

  async initialize(): Promise<void> {
    this._eventBus.on('task:routed', this._onTaskRouted)
    this._eventBus.on('task:complete', this._onTaskComplete)
    this._eventBus.on('task:failed', this._onTaskFailed)
    logger.info('CostTrackerSubscriber initialized — subscribed to task events')
  }

  async shutdown(): Promise<void> {
    this._eventBus.off('task:routed', this._onTaskRouted)
    this._eventBus.off('task:complete', this._onTaskComplete)
    this._eventBus.off('task:failed', this._onTaskFailed)
    this._routingCache.clear()
    logger.info('CostTrackerSubscriber shutdown complete')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a canonical provider name from a CLI agent name.
 */
function resolveProviderFromAgent(agent: string): string {
  return PROVIDER_ALIASES[agent.toLowerCase()] ?? agent.toLowerCase()
}

/**
 * Resolve a default model name for an agent when no specific model is set.
 */
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
  eventBus: TypedEventBus
  costTracker: CostTracker
  /** Session ID to use for all cost entries. Defaults to 'default' if not provided. */
  sessionId?: string
}

export function createCostTrackerSubscriber(options: CostTrackerSubscriberOptions): CostTrackerSubscriber {
  return new CostTrackerSubscriber(options.eventBus, options.costTracker, options.sessionId)
}
