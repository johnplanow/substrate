/**
 * DOT fixture strings for the advanced cross-project validation test.
 * Story 50-12.
 *
 * Node type strings verified via:
 *   grep -rn "registry.register" packages/factory/src/handlers/registry.ts
 *
 * Registered types used here:
 *   'stack.manager_loop' – outer supervisor (story 50-8)
 *   'parallel'           – fan-out node (story 50-1)
 *   'parallel.fan_in'    – fan-in/merge node (story 50-2)
 *   'subgraph'           – nested subgraph execution node (story 50-5)
 *   'codergen'           – branch execution nodes
 *   'start'              – start node
 *   'exit'               – exit node
 *
 * Architecture note:
 *   The manager_loop handler requires a `graph_file` attribute pointing to a
 *   separate body DOT file. `parseGraph` does NOT populate `node.attrs`, so tests
 *   must post-process the parsed graph:
 *     outerGraph.nodes.get('manager_loop')!.attrs = {
 *       graph_file: 'body.dot',
 *       max_cycles: '3',
 *       stop_condition: 'llm:has the implementation satisfied the acceptance criteria?',
 *     }
 *
 *   Similarly, subgraph nodes require:
 *     bodyGraph.nodes.get('subgraph_node')!.attrs = { graph_file: 'child.dot' }
 *   (handled by mock subgraph handler in tests — no post-processing needed).
 */

import { parseGraph } from '../../graph/parser.js'

// ---------------------------------------------------------------------------
// ADVANCED_VALIDATION_DOT — outer graph (manager_loop wrapper)
// ---------------------------------------------------------------------------

/**
 * Outer graph: start → manager_loop → exit [condition="llm:..."]
 *
 * The manager_loop acts as the outermost supervisor. Its body (BODY_GRAPH_DOT)
 * is loaded via a mock graphFileLoader and contains the parallel fan-out/fan-in
 * with subgraph integration.
 *
 * Post-process after parseGraph:
 *   graph.nodes.get('manager_loop')!.attrs = {
 *     graph_file: 'body.dot',
 *     max_cycles: '3',
 *     stop_condition: 'llm:has the implementation satisfied the acceptance criteria?',
 *   }
 */
export const ADVANCED_VALIDATION_DOT = `
digraph advanced_cross_project {
  start        [type="start"];
  manager_loop [type="stack.manager_loop", label="Supervised Loop"];
  exit         [type="exit"];

  start        -> manager_loop;
  manager_loop -> exit [condition="llm:has the implementation satisfied the acceptance criteria?"];
}
`

// ---------------------------------------------------------------------------
// BODY_GRAPH_DOT — body graph executed by manager_loop each cycle
// ---------------------------------------------------------------------------

/**
 * Body graph: parallel fan-out/fan-in with subgraph integration.
 *
 * start → parallel_node fans out to [branch_a, branch_b]
 * branch_a runs, then main executor traverses branch_a → subgraph_node → fan_in
 * branch_b result is collected by fan_in
 * fan_in → exit [condition="llm:..."] — LLM-evaluated exit edge
 *
 * Handler types present: parallel, codergen, subgraph, parallel.fan_in
 */
export const BODY_GRAPH_DOT = `
digraph manager_body {
  start         [type="start"];
  parallel_node [type="parallel", label="Fan-out Branches"];
  branch_a      [type="codergen", label="Implement approach A"];
  subgraph_node [type="subgraph", label="Run child pipeline"];
  branch_b      [type="codergen", label="Implement approach B"];
  fan_in        [type="parallel.fan_in", label="Best Candidate"];
  exit          [type="exit"];

  start         -> parallel_node;
  parallel_node -> branch_a;
  parallel_node -> branch_b;
  branch_a      -> subgraph_node;
  subgraph_node -> fan_in;
  branch_b      -> fan_in;
  fan_in        -> exit [condition="llm:has the implementation satisfied the acceptance criteria?"];
}
`

// ---------------------------------------------------------------------------
// CHILD_GRAPH_DOT — minimal child graph executed by subgraph handler
// ---------------------------------------------------------------------------

/**
 * Minimal child graph: child_start → child_work → child_exit
 * Returned by mock graphFileLoader when subgraph_node requests 'child.dot'.
 */
export const CHILD_GRAPH_DOT = `
digraph child_branch {
  child_start [type="start"];
  child_work  [type="codergen", label="Implement in child context"];
  child_exit  [type="exit"];

  child_start -> child_work;
  child_work  -> child_exit;
}
`

// ---------------------------------------------------------------------------
// validateFixtures — test helper for AC1
// ---------------------------------------------------------------------------

/**
 * Parse all three fixture DOT strings and throw if any parse fails.
 * Returns the three parsed graphs for downstream assertions.
 */
export function validateFixtures(): {
  outerGraph: ReturnType<typeof parseGraph>
  bodyGraph: ReturnType<typeof parseGraph>
  childGraph: ReturnType<typeof parseGraph>
} {
  const outerGraph = parseGraph(ADVANCED_VALIDATION_DOT)
  const bodyGraph = parseGraph(BODY_GRAPH_DOT)
  const childGraph = parseGraph(CHILD_GRAPH_DOT)
  return { outerGraph, bodyGraph, childGraph }
}
