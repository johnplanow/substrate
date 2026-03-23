/**
 * Handler for exit/terminal nodes.
 * Signals successful graph completion with no side effects.
 *
 * Story 42-9.
 */

import type { NodeHandler } from './types.js'

/** Handler for exit/terminal nodes; signals successful graph completion. */
export const exitHandler: NodeHandler = async (_node, _context, _graph) => {
  return { status: 'SUCCESS' as const }
}
