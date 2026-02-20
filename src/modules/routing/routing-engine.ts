/**
 * RoutingEngine — interface and factory for task-to-agent routing.
 *
 * The RoutingEngine subscribes to task:ready events, makes routing decisions
 * using the configured routing policy, and emits task:routed events with
 * the full RoutingDecision including agent, billing mode, and rationale.
 *
 * Event subscriptions (Architecture Section 8):
 *  - Listens to task:ready events to trigger routing decisions
 *  - Listens to task:complete events to update rate limit tracking
 *  - Emits task:routed events with RoutingDecision
 *  - Emits provider:unavailable events when rate limits are exhausted
 */

import type { BaseService } from '../../core/di.js'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { ConfigSystem } from '../config/config-system.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import type { TaskNode } from '../../core/types.js'
import type { RoutingDecision } from './routing-decision.js'
import type { ProviderStatus } from './provider-status.js'
import { RoutingEngineImpl } from './routing-engine-impl.js'

// Re-export types for consumers
export type { RoutingDecision }
export type { ProviderStatus }

// ---------------------------------------------------------------------------
// RoutingEngine interface
// ---------------------------------------------------------------------------

/**
 * Full interface for the routing engine.
 */
export interface RoutingEngine extends BaseService {
  /**
   * Make a routing decision for a task.
   * Implements subscription-first algorithm per Architecture Section 8.
   *
   * @param task - TaskNode to route
   * @returns RoutingDecision with agent, billingMode, and rationale
   */
  routeTask(task: TaskNode): RoutingDecision

  /**
   * Get current status of a provider including rate limit state.
   *
   * @param provider - Provider name
   * @returns ProviderStatus snapshot or null if provider is not tracked
   */
  getProviderStatus(provider: string): ProviderStatus | null

  /**
   * Update rate limit tracking after task completion.
   *
   * @param provider - Provider name that executed the task
   * @param tokensUsed - Actual tokens consumed
   */
  updateRateLimit(provider: string, tokensUsed: number): void

  /**
   * Hot-reload the routing policy from disk without daemon restart (FR38).
   */
  reloadPolicy(): Promise<void>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface RoutingEngineOptions {
  eventBus: TypedEventBus
  configSystem?: ConfigSystem | null
  adapterRegistry?: AdapterRegistry | null
}

/**
 * Create a new RoutingEngine instance.
 *
 * @example
 * const engine = createRoutingEngine({ eventBus })
 * await engine.initialize()
 */
export function createRoutingEngine(options: RoutingEngineOptions): RoutingEngine {
  return new RoutingEngineImpl(
    options.eventBus,
    options.configSystem ?? null,
    options.adapterRegistry ?? null,
  )
}
