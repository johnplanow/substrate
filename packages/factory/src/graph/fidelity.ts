/**
 * Fidelity resolution functions for pre-dispatch context summarization.
 *
 * Pure module — no async, no I/O, no class state. Only exported pure functions.
 * Story 49-5.
 */
import type { SummaryLevel } from '../context/summary-types.js'
import type { GraphNode, GraphEdge, Graph } from './types.js'

/**
 * Map a raw fidelity string to a SummaryLevel for context compression.
 *
 * Returns null when no summarization should be applied (fidelity is 'full',
 * empty, or an unrecognized value). Used by the executor before every node
 * dispatch to determine whether to call summaryEngine.summarize().
 */
export function parseFidelityLevel(fidelity: string): SummaryLevel | null {
  const FIDELITY_MAP: Record<string, SummaryLevel> = {
    high: 'high',
    'summary:high': 'high',
    medium: 'medium',
    'summary:medium': 'medium',
    low: 'low',
    draft: 'low',
    'summary:low': 'low',
  }
  return FIDELITY_MAP[fidelity] ?? null
}

/**
 * Resolve the effective fidelity string for a node about to be dispatched.
 *
 * Precedence (highest to lowest):
 *   1. incomingEdge.fidelity (non-empty)
 *   2. node.fidelity (non-empty)
 *   3. graph.defaultFidelity (non-empty)
 *   4. '' (no fidelity set — parseFidelityLevel will return null)
 */
export function resolveFidelity(
  node: GraphNode,
  incomingEdge: GraphEdge | undefined,
  graph: Graph,
): string {
  if (incomingEdge?.fidelity) return incomingEdge.fidelity
  if (node.fidelity) return node.fidelity
  if (graph.defaultFidelity) return graph.defaultFidelity
  return ''
}
