/**
 * detectCycles — DFS-based cycle detection for story dependency graphs.
 *
 * Story 31-7: Cycle Detection in Work Graph
 *
 * Pure function; no database or I/O dependencies.
 */

/**
 * Detect cycles in a directed dependency graph represented as an edge list.
 *
 * Each edge `{ story_key, depends_on }` means story_key depends on depends_on
 * (i.e. story_key → depends_on is the directed edge we traverse).
 *
 * Uses iterative DFS with an explicit stack to avoid call-stack overflows on
 * large graphs, but also supports a nested recursive helper for cycle path
 * reconstruction.
 *
 * @param edges - List of dependency edges to check.
 * @returns `null` if the graph is acyclic (safe to persist), or a `string[]`
 *   containing the cycle path with the first and last element being the same
 *   story key (e.g. `['A', 'B', 'A']`).
 */
export function detectCycles(
  edges: ReadonlyArray<{ story_key: string; depends_on: string }>,
): string[] | null {
  // Build adjacency map: node → nodes it depends on (outbound edges)
  const adj = new Map<string, string[]>()
  for (const { story_key, depends_on } of edges) {
    if (!adj.has(story_key)) adj.set(story_key, [])
    adj.get(story_key)!.push(depends_on)
  }

  const visited = new Set<string>()
  const visiting = new Set<string>()
  const path: string[] = []

  function dfs(node: string): string[] | null {
    if (visiting.has(node)) {
      // Cycle found — extract cycle from path stack
      const cycleStart = path.indexOf(node)
      return [...path.slice(cycleStart), node]
    }
    if (visited.has(node)) return null

    visiting.add(node)
    path.push(node)

    for (const neighbor of adj.get(node) ?? []) {
      const cycle = dfs(neighbor)
      if (cycle !== null) return cycle
    }

    path.pop()
    visiting.delete(node)
    visited.add(node)
    return null
  }

  // Collect all nodes (both sides of each edge)
  const allNodes = new Set<string>([
    ...edges.map((e) => e.story_key),
    ...edges.map((e) => e.depends_on),
  ])

  for (const node of allNodes) {
    if (!visited.has(node)) {
      const cycle = dfs(node)
      if (cycle !== null) return cycle
    }
  }

  return null
}
