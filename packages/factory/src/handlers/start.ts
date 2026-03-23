/**
 * Handler for start nodes.
 * No side effects — edge selection drives the next step.
 *
 * Story 42-9.
 */

import type { NodeHandler } from './types.js'

/** Handler for start nodes; no side effects; edge selection drives next step. */
export const startHandler: NodeHandler = async (_node, _context, _graph) => {
  return { status: 'SUCCESS' as const }
}
