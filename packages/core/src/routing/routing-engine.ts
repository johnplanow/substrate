/**
 * RoutingEngine — interface definitions for task-to-agent routing.
 *
 * Defines the public contract for routing engines, resolvers, and related types.
 * Concrete implementations live in Epic 41.
 *
 * References:
 *  - Architecture Section 8: Subscription-first routing algorithm
 *  - Epic 40, Story 40-6: Routing Interface Extraction
 */

import type { RoutingDecision } from './routing-decision.js'
import type { ProviderStatus } from './provider-status.js'

// ---------------------------------------------------------------------------
// RoutingTask
// ---------------------------------------------------------------------------

/**
 * Minimal task shape required for routing decisions.
 * Structural subtype designed to accommodate both the core's simple RoutingTask usage
 * and the monolith's TaskNode (which has agentId and metadata).
 * All fields beyond `id` are optional to allow assignment from both sources.
 */
export interface RoutingTask {
  id: string
  /** Task type string. May also be provided via `metadata.taskType` for backward compat. */
  type?: string
  /** Optional explicit agent assignment (from TaskNode.agentId) */
  agentId?: string
  /** Arbitrary task metadata — RoutingEngineImpl reads `metadata.taskType` for routing */
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// ModelResolution
// ---------------------------------------------------------------------------

/**
 * The resolved model and routing metadata for a given task type.
 */
export interface ModelResolution {
  /** Resolved model identifier */
  model: string
  /** Optional max_tokens from the phase or override config */
  maxTokens?: number
  /** The pipeline phase that was resolved */
  phase: string
  /** Whether the resolution came from a phase config or a task-type override */
  source: 'phase' | 'override'
}

// ---------------------------------------------------------------------------
// IRoutingResolver
// ---------------------------------------------------------------------------

/**
 * Interface for resolving the appropriate model for each pipeline task type.
 */
export interface IRoutingResolver {
  resolveModel(taskType: string): ModelResolution | null
}

// ---------------------------------------------------------------------------
// RoutingEngine interface
// ---------------------------------------------------------------------------

/**
 * Full interface for the routing engine.
 */
export interface RoutingEngine {
  /**
   * Make a routing decision for a task.
   * Implements subscription-first algorithm per Architecture Section 8.
   *
   * @param task - RoutingTask to route
   * @returns RoutingDecision with agent, billingMode, and rationale
   */
  routeTask(task: RoutingTask): RoutingDecision

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
// Constants
// ---------------------------------------------------------------------------

/**
 * Maps known task types to their corresponding pipeline phase.
 * Unknown task types fall through to the 'generate' default.
 */
export const TASK_TYPE_PHASE_MAP: Record<string, 'explore' | 'generate' | 'review'> = {
  'create-story': 'generate',
  'dev-story': 'generate',
  'code-review': 'review',
  explore: 'explore',
}
