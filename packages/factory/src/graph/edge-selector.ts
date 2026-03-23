/**
 * Edge selection algorithm for the factory graph engine.
 *
 * Implements the 5-step Attractor spec priority order (Section 3.3):
 *   1. Condition-matched edges (highest priority)
 *   2. Preferred label match on unconditional edges
 *   3. Suggested next IDs on unconditional edges
 *   4. Highest weight among unconditional edges
 *   5. Lexically-first target ID as tiebreak for Step 4
 *
 * Story 42-12.
 */

import type { GraphNode, GraphEdge, Graph, IGraphContext, Outcome } from './types.js'
import { evaluateCondition } from './condition-parser.js'

// ---------------------------------------------------------------------------
// normalizeLabel
// ---------------------------------------------------------------------------

/**
 * Normalize an edge label for preferred-label matching.
 *
 * Lowercases and trims the input, then strips an accelerator prefix if present:
 *   - `[K] ` — bracket-enclosed single character followed by whitespace
 *   - `K) `  — single character followed by `)` and whitespace
 *   - `K - ` — single character followed by optional whitespace, `-`, optional whitespace
 *
 * Patterns are matched after lowercasing, so the regex uses only `[a-z]`.
 *
 * @param label - Raw edge label string.
 * @returns Normalized label string.
 */
export function normalizeLabel(label: string): string {
  const s = label.toLowerCase().trim()
  // Apply accelerator prefix strips in order; only one will match per label.
  return s
    .replace(/^[a-z]\)\s+/, '')
    .replace(/^\[[a-z]\]\s+/, '')
    .replace(/^[a-z]\s*-\s*/, '')
    .trim()
}

// ---------------------------------------------------------------------------
// bestByWeightThenLexical
// ---------------------------------------------------------------------------

/**
 * Return the "best" edge from a non-empty array:
 *   - highest `weight` (treating missing weight as 0)
 *   - lexically-first `toNode` as a tiebreak (ascending alphabetical)
 *
 * Does not mutate the input array.
 *
 * @param edges - Non-empty array of candidate edges (caller guarantees length ≥ 1).
 * @returns The winning `GraphEdge`.
 */
export function bestByWeightThenLexical(edges: GraphEdge[]): GraphEdge {
  const sorted = [...edges].sort((a, b) => {
    // Descending by weight
    const weightDiff = (b.weight ?? 0) - (a.weight ?? 0)
    if (weightDiff !== 0) return weightDiff
    // Ascending by target node ID (lexical)
    return a.toNode.localeCompare(b.toNode)
  })
  return sorted[0]!
}

// ---------------------------------------------------------------------------
// selectEdge
// ---------------------------------------------------------------------------

/**
 * Select the best outgoing edge from `node` according to the 5-step Attractor spec.
 *
 * Step 1: Condition-matched edges — highest weight, lexical tiebreak.
 * Step 2: Preferred label match on unconditional edges — first match wins.
 * Step 3: Suggested next IDs on unconditional edges — first suggestedNextId wins.
 * Step 4: Highest weight among all unconditional edges.
 * Step 5: Lexically-first target node ID as tiebreak for Step 4.
 *
 * @param node    - The current graph node.
 * @param outcome - The outcome returned by the node's handler.
 * @param context - The current execution context (used for condition evaluation).
 * @param graph   - The full graph (source of edges).
 * @returns The selected `GraphEdge`, or `null` if no outgoing edges exist.
 */
export function selectEdge(
  node: GraphNode,
  outcome: Outcome,
  context: IGraphContext,
  graph: Graph,
): GraphEdge | null {
  // Collect all edges originating from this node.
  const outgoing = graph.edges.filter((e) => e.fromNode === node.id)

  // AC5: No outgoing edges → return null immediately.
  if (outgoing.length === 0) return null

  // Step 1: Condition-matched edges (AC1, AC7).
  const conditionMatches: GraphEdge[] = []
  const snapshot = context.snapshot()
  for (const edge of outgoing) {
    if (edge.condition && edge.condition.trim() !== '') {
      try {
        if (evaluateCondition(edge.condition, snapshot)) {
          conditionMatches.push(edge)
        }
      } catch {
        // Parse errors or evaluation errors → treat as non-matching.
      }
    }
  }
  if (conditionMatches.length > 0) {
    return bestByWeightThenLexical(conditionMatches)
  }

  // Step 2: Preferred label match on unconditional edges (AC2).
  if (outcome.preferredLabel && outcome.preferredLabel.trim() !== '') {
    const normalizedPreferred = normalizeLabel(outcome.preferredLabel)
    for (const edge of outgoing) {
      if (!edge.condition && normalizeLabel(edge.label) === normalizedPreferred) {
        return edge
      }
    }
  }

  // Step 3: Suggested next IDs on unconditional edges (AC3).
  if (outcome.suggestedNextIds && outcome.suggestedNextIds.length > 0) {
    for (const id of outcome.suggestedNextIds) {
      const match = outgoing.find((e) => !e.condition && e.toNode === id)
      if (match !== undefined) return match
    }
  }

  // Steps 4 & 5: Highest weight with lexical tiebreak among unconditional edges (AC4).
  const unconditional = outgoing.filter((e) => !e.condition)
  if (unconditional.length > 0) {
    return bestByWeightThenLexical(unconditional)
  }

  return null
}
