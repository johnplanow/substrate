/**
 * Specificity-based resolver for the model stylesheet.
 *
 * Given a parsed stylesheet and a graph node, `resolveNodeStyles` determines
 * which LLM routing properties apply to that node by:
 *   1. Filtering rules to only those whose selector matches the node.
 *   2. Sorting matching rules by specificity ascending (stable sort so that
 *      equal-specificity rules preserve source order).
 *   3. Iterating the sorted list and letting each rule overwrite properties
 *      — the last rule at the highest specificity wins; for ties the rule
 *      appearing later in the original stylesheet wins.
 *
 * **Caller contract**: `resolveNodeStyles` does NOT enforce the "explicit node
 * attribute wins" rule.  The caller (executor / node preparation layer) is
 * responsible for the final merge:
 * ```typescript
 * const resolved = resolveNodeStyles(node, stylesheet)
 * const finalModel = node.llmModel || resolved.llmModel || graph.defaultLlmModel || ''
 * ```
 *
 * Story 42-7.
 */

import type {
  GraphNode,
  ParsedStylesheet,
  ResolvedNodeStyles,
  StylesheetSelector,
} from '../graph/types.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return `true` if the given `selector` matches the provided `node`.
 *
 * Matching rules:
 * - `universal`: always matches every node.
 * - `shape`: matches when `node.shape === selector.value`.
 * - `class`: matches when the node's `class` field, split on commas and
 *   trimmed, contains `selector.value` (case-sensitive).
 * - `id`: matches when `node.id === selector.value`.
 */
function matchesNode(node: GraphNode, selector: StylesheetSelector): boolean {
  switch (selector.type) {
    case 'universal':
      return true

    case 'shape':
      return node.shape === selector.value

    case 'class': {
      // node.class is a comma-separated list of class tokens (e.g. "code,critical,fast")
      const tokens = node.class.split(',').map((t) => t.trim())
      return tokens.includes(selector.value)
    }

    case 'id':
      return node.id === selector.value

    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve LLM routing properties for a single graph node using the parsed stylesheet.
 *
 * @param node       - The graph node to resolve properties for.
 * @param stylesheet - A parsed stylesheet (array of `StylesheetRule` in source order).
 * @returns A `ResolvedNodeStyles` object containing only the properties that
 *   were resolved from matching rules.  Properties absent from matching rules
 *   are omitted (not set to `undefined` explicitly).
 *
 * **Important**: this function does NOT check the node's own attributes.
 * Callers must give explicit node attributes (`node.llmModel`, etc.) priority
 * over the values returned here.
 */
export function resolveNodeStyles(
  node: GraphNode,
  stylesheet: ParsedStylesheet
): ResolvedNodeStyles {
  // 1. Filter to rules whose selector matches this node
  const matchingRules = stylesheet.filter((rule) => matchesNode(node, rule.selector))

  // 2. Stable-sort by specificity ascending so higher-specificity rules come
  //    last and can overwrite lower-specificity values during iteration.
  //    Array.prototype.sort is stable (guaranteed since ES2019 / Node 12+),
  //    so equal-specificity rules remain in their original source order,
  //    meaning a later rule in the stylesheet will appear later in the sorted
  //    array and will correctly win by overwriting.
  matchingRules.sort((a, b) => a.selector.specificity - b.selector.specificity)

  // 3. Accumulate resolved properties — each rule overwrites earlier ones
  const resolved: ResolvedNodeStyles = {}

  for (const rule of matchingRules) {
    for (const decl of rule.declarations) {
      if (decl.property === 'llm_model') {
        resolved.llmModel = decl.value
      } else if (decl.property === 'llm_provider') {
        resolved.llmProvider = decl.value
      } else if (decl.property === 'reasoning_effort') {
        resolved.reasoningEffort = decl.value
      }
    }
  }

  return resolved
}
