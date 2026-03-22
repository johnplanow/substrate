/**
 * RoutingDecision — type definition for routing decisions.
 *
 * A RoutingDecision is the output of the RoutingEngine.routeTask() method.
 * It captures which agent was selected, the billing mode, and the rationale
 * for the routing choice (NFR7 — audit trail for cost tracking).
 */

// ---------------------------------------------------------------------------
// MonitorRecommendation (minimal local interface — avoids importing monitor module)
// ---------------------------------------------------------------------------

/**
 * Minimal advisory recommendation from monitor agent.
 * Defined locally to avoid importing the monitor module into core.
 */
export interface MonitorRecommendation {
  model?: string
  rationale?: string
  confidence?: number
}

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
  monitorRecommendation?: MonitorRecommendation
  /**
   * Whether the monitor agent was consulted for this routing decision (AC5).
   * True when use_monitor_recommendations=true, regardless of whether a
   * recommendation was available.
   */
  monitorInfluenced: boolean
}
