/**
 * Core type definitions for the handler registry.
 * Story 42-9.
 */

import type { GraphNode, Graph, IGraphContext, Outcome } from '../graph/types.js'

/**
 * A function that handles a single graph node during execution.
 * Must be async — the executor always awaits handlers.
 */
export type NodeHandler = (node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>

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
