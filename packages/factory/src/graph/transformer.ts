/**
 * Graph stylesheet transformer — applies model_stylesheet rules to all nodes
 * in a graph, with support for inherited parent stylesheet rules.
 *
 * Story 50-6.
 */

import { parseStylesheet } from '../stylesheet/parser.js'
import { resolveNodeStyles } from '../stylesheet/resolver.js'
import type { Graph, ParsedStylesheet } from './types.js'

// ---------------------------------------------------------------------------
// applyStylesheet
// ---------------------------------------------------------------------------

/**
 * Apply stylesheet rules to all nodes in the given graph.
 *
 * Merges `inheritedStylesheet` (parent rules) with the graph's own
 * `modelStylesheet` rules, parent rules first so that local child rules win at
 * equal specificity via source-order tie-breaking (later rule wins).
 *
 * For each node, the resolved properties are applied only if the node does NOT
 * already have a non-empty explicit value (explicit values are preserved).
 *
 * This function **mutates** graph nodes in-place — consistent with how the
 * DOT parser sets node fields after parsing.
 *
 * **Idempotency**: calling `applyStylesheet` twice on the same graph is safe
 * because nodes with an existing non-empty `llmModel` (or `llmProvider` /
 * `reasoningEffort`) are never overwritten.
 *
 * @param graph               - The graph whose nodes should be styled.
 * @param inheritedStylesheet - Optional stylesheet rules inherited from a
 *   parent graph. Prepended before the graph's own rules so that child local
 *   rules win at equal specificity. Pass `undefined` when there is no parent.
 */
export function applyStylesheet(graph: Graph, inheritedStylesheet?: ParsedStylesheet): void {
  // Parse the graph's own local stylesheet rules (if any)
  const localRules: ParsedStylesheet = graph.modelStylesheet
    ? parseStylesheet(graph.modelStylesheet)
    : []

  // Merge: parent rules first, child local rules second.
  // Because resolveNodeStyles uses source-order tie-breaking (later rule wins at
  // equal specificity), placing parent rules first ensures that local rules win.
  const effectiveStylesheet: ParsedStylesheet = [...(inheritedStylesheet ?? []), ...localRules]

  // Early exit if there are no rules to apply
  if (effectiveStylesheet.length === 0) {
    return
  }

  // Apply resolved styles to each node, preserving explicit values
  for (const node of graph.nodes.values()) {
    const resolved = resolveNodeStyles(node, effectiveStylesheet)

    if (!node.llmModel && resolved.llmModel) {
      node.llmModel = resolved.llmModel
    }

    if (!node.llmProvider && resolved.llmProvider) {
      node.llmProvider = resolved.llmProvider
    }

    if (!node.reasoningEffort && resolved.reasoningEffort) {
      node.reasoningEffort = resolved.reasoningEffort
    }
  }
}
