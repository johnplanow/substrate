/**
 * Core type definitions for the handler registry.
 * Story 42-9.
 */

import type { GraphNode, Graph, IGraphContext, Outcome } from '../graph/types.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../events.js'

/**
 * A function that handles a single graph node during execution.
 * Must be async — the executor always awaits handlers.
 */
export type NodeHandler = (
  node: GraphNode,
  context: IGraphContext,
  graph: Graph
) => Promise<Outcome>

/**
 * Interface for the handler registry that maps node types and shapes to
 * handler functions. The executor uses this to dispatch nodes without being
 * coupled to individual handler implementations.
 */
export interface IHandlerRegistry {
  /**
   * Register a handler for the given node type.
   * Overwrites any previously registered handler for the same type.
   */
  register(type: string, handler: NodeHandler): void
  /**
   * Register a shape-to-type mapping so that nodes lacking an explicit type
   * can still be resolved via their DOT shape attribute.
   * Overwrites any previously registered mapping for the same shape.
   */
  registerShape(shape: string, type: string): void
  /**
   * Set the default handler, used when no type or shape match is found.
   */
  setDefault(handler: NodeHandler): void
  /**
   * Resolve the handler for the given node using the 3-step priority chain:
   * 1. Explicit type match
   * 2. Shape-based fallback
   * 3. Default handler (throws if not set)
   */
  resolve(node: GraphNode): NodeHandler
}

// ---------------------------------------------------------------------------
// Parallel handler types (story 50-1)
// ---------------------------------------------------------------------------

/**
 * Result of a single branch execution inside a parallel node.
 * Written into `parallel.results` by the parallel handler; consumed by the
 * fan-in handler (story 50-2) for candidate ranking.
 */
export interface ParallelBranchResult {
  /** The branch start node ID (outgoing edge target from the parallel node). */
  nodeId: string
  /** Outcome status returned by the branch handler. */
  status: string
  /** Snapshot of the branch's isolated context after execution. */
  contextSnapshot: Record<string, unknown>
  /** Populated when status is 'FAILURE' (or a failure-class string). */
  failureReason?: string
}

/**
 * Canonical result type stored in `parallel.results` by the parallel handler.
 * This is the cross-story contract between parallel.ts (producer) and
 * fan-in.ts (consumer). The parallel handler bridges from the internal
 * join-policy BranchResult format into this shape.
 *
 * Fields branch_id, status, context_updates, score, failure_reason are the
 * fan-in consumer interface. Fields index, outcome, contextSnapshot, error
 * are the join-policy producer fields preserved through the bridge.
 */
export interface FanInBranchResult {
  /** Integer branch identifier assigned by the parallel handler. */
  branch_id: number
  /** Terminal outcome status for this branch. */
  status: string
  /** Context updates to merge when this branch wins. */
  context_updates?: Record<string, unknown> | undefined
  /** Optional numeric quality score (higher is better). */
  score?: number | undefined
  /** Human-readable failure description. */
  failure_reason?: string | undefined
  /** Zero-based index (join-policy field, present when produced by parallel handler). */
  index?: number | undefined
  /** Raw outcome from join-policy (present when produced by parallel handler). */
  outcome?: string | undefined
  /** Shallow snapshot of branch context at completion. */
  contextSnapshot?: Record<string, unknown> | undefined
  /** Error string from join-policy. */
  error?: string | undefined
}

/**
 * Options for the parallel handler factory function.
 */
export interface ParallelHandlerOptions {
  /** Registry used to resolve and invoke branch node handlers. */
  handlerRegistry: IHandlerRegistry
  /** Optional event bus for emitting parallel lifecycle events (story 50-9). */
  eventBus?: TypedEventBus<FactoryEvents>
  /** Optional run identifier threaded to event payloads (story 50-9). */
  runId?: string
}
