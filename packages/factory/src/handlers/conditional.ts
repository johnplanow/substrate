/**
 * Handler for conditional/branching nodes.
 * Routing is delegated entirely to edge selection (story 42-12).
 * This handler does nothing — it simply returns SUCCESS so the executor
 * can proceed to edge evaluation.
 *
 * Story 42-9.
 */

import type { NodeHandler } from './types.js'

/**
 * Handler for conditional/branching nodes; routing is delegated entirely to
 * edge selection (story 42-12); this handler does nothing.
 */
export const conditionalHandler: NodeHandler = async (_node, _context, _graph) => {
  return { status: 'SUCCESS' as const }
}
