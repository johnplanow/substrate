/**
 * RoutingDecision — type definition and factory for routing decisions.
 *
 * A RoutingDecision is the output of the RoutingEngine.routeTask() method.
 * It captures which agent was selected, the billing mode, and the rationale
 * for the routing choice (NFR7 — audit trail for cost tracking).
 */

import type { Recommendation } from '../monitor/recommendation-types.js'

// ---------------------------------------------------------------------------
// RoutingDecision interface
// ---------------------------------------------------------------------------

/**
 * The result of a routing decision for a task.
 *
 * @example
 * {
 *   taskId: 'task-1',
 *   agent: 'claude',
 *   billingMode: 'subscription',
 *   rationale: 'Subscription-first: Claude subscription available, tokens within limit',
 *   fallbackChain: ['claude', 'codex'],
 * }
 */
export interface RoutingDecision {
  /** Task identifier this decision was made for */
  taskId: string
  /** Selected CLI agent name (e.g., 'claude', 'codex', 'gemini') */
  agent: string
  /** Billing mode for this routing decision */
  billingMode: 'subscription' | 'api' | 'unavailable'
  /** Optional model preference if specified in routing policy */
  model?: string
  /** Human-readable rationale for the routing choice (required for NFR7 audit) */
  rationale: string
  /** Agents tried in order during fallback chain evaluation */
  fallbackChain?: string[]
  /** Estimated cost in USD for this task (if known) */
  estimatedCostUsd?: number
  /** Rate limit state at time of decision */
  rateLimit?: { tokensUsedInWindow: number; limit: number }
  /**
   * Advisory recommendation from monitor agent (AC5, Story 8.6).
   * Present when use_monitor_recommendations=true and a recommendation is available.
   * This is informational only — routing policy always takes precedence.
   */
  monitorRecommendation?: Recommendation
  /**
   * Whether the monitor agent was consulted for this routing decision (AC5).
   * True when use_monitor_recommendations=true, regardless of whether a
   * recommendation was available.
   */
  monitorInfluenced: boolean
}

// ---------------------------------------------------------------------------
// RoutingDecisionBuilder
// ---------------------------------------------------------------------------

/**
 * Builder for constructing RoutingDecision objects with a fluent API.
 *
 * @example
 * const decision = makeRoutingDecision('task-1')
 *   .withAgent('claude', 'subscription')
 *   .withRationale('Subscription-first: Claude subscription available')
 *   .withFallbackChain(['claude', 'codex'])
 *   .build()
 */
export class RoutingDecisionBuilder {
  private readonly _taskId: string
  private _agent = ''
  private _billingMode: 'subscription' | 'api' | 'unavailable' = 'unavailable'
  private _model?: string
  private _rationale = ''
  private _fallbackChain?: string[]
  private _estimatedCostUsd?: number
  private _rateLimit?: { tokensUsedInWindow: number; limit: number }
  private _monitorRecommendation?: Recommendation
  private _monitorInfluenced = false

  constructor(taskId: string) {
    this._taskId = taskId
  }

  withAgent(agent: string, billingMode: 'subscription' | 'api' | 'unavailable'): this {
    this._agent = agent
    this._billingMode = billingMode
    return this
  }

  withModel(model: string): this {
    this._model = model
    return this
  }

  withRationale(rationale: string): this {
    this._rationale = rationale
    return this
  }

  withFallbackChain(chain: string[]): this {
    this._fallbackChain = chain
    return this
  }

  withEstimatedCost(costUsd: number): this {
    this._estimatedCostUsd = costUsd
    return this
  }

  withRateLimit(tokensUsedInWindow: number, limit: number): this {
    this._rateLimit = { tokensUsedInWindow, limit }
    return this
  }

  withMonitorRecommendation(recommendation: Recommendation): this {
    this._monitorRecommendation = recommendation
    this._monitorInfluenced = true
    return this
  }

  withMonitorInfluenced(influenced: boolean): this {
    this._monitorInfluenced = influenced
    return this
  }

  unavailable(rationale: string): this {
    this._billingMode = 'unavailable'
    this._agent = 'none'
    this._rationale = rationale
    return this
  }

  build(): RoutingDecision {
    return {
      taskId: this._taskId,
      agent: this._agent,
      billingMode: this._billingMode,
      model: this._model,
      rationale: this._rationale,
      fallbackChain: this._fallbackChain,
      estimatedCostUsd: this._estimatedCostUsd,
      rateLimit: this._rateLimit,
      monitorRecommendation: this._monitorRecommendation,
      monitorInfluenced: this._monitorInfluenced,
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a new RoutingDecisionBuilder for the given taskId.
 *
 * @example
 * const decision = makeRoutingDecision(task.id)
 *   .withAgent('claude', 'subscription')
 *   .withRationale('Subscription-first: tokens within limit')
 *   .build()
 */
export function makeRoutingDecision(taskId: string): RoutingDecisionBuilder {
  return new RoutingDecisionBuilder(taskId)
}
