/**
 * DOT fixture strings for subgraph execution integration tests.
 * Story 50-11.
 *
 * The `subgraph` handler type reads `node.attrs['graph_file']` for the
 * path to the child .dot file. Since `parseGraph` does not populate
 * `node.attrs`, tests must post-process the parsed graph to add attrs:
 *   const graph = parseGraph(SUBGRAPH_PARENT_DOT)
 *   graph.nodes.get('sg_node')!.attrs = { graph_file: '/test/child.dot' }
 *
 * Registered type: 'subgraph' (story 50-5)
 */

/**
 * Parent graph with a single subgraph node.
 * start → sg_node (subgraph) → exit
 *
 * Note: `graph_file` attribute must be added via post-processing after parsing:
 *   parentGraph.nodes.get('sg_node')!.attrs = { graph_file: '/test/child.dot' }
 */
export const SUBGRAPH_PARENT_DOT = `
digraph subgraph_parent_test {
  start   [type="start"];
  sg_node [type="subgraph", label="Child Pipeline"];
  exit    [type="exit"];

  start   -> sg_node;
  sg_node -> exit;
}
`

/**
 * Minimal child graph: start → codergen → exit
 * Used as the body graph loaded by the mock graphFileLoader.
 */
export const CHILD_GRAPH_DOT = `
digraph child_graph {
  start  [type="start"];
  work   [type="codergen", label="Child Work"];
  exit   [type="exit"];

  start -> work;
  work  -> exit;
}
`

/**
 * Child graph that itself contains a subgraph node (for nested depth tests).
 * The grandchild subgraph node needs attrs post-processing in tests too.
 */
export const CHILD_WITH_SUBGRAPH_DOT = `
digraph child_with_subgraph {
  start        [type="start"];
  nested_sg    [type="subgraph", label="Grandchild Pipeline"];
  exit         [type="exit"];

  start     -> nested_sg;
  nested_sg -> exit;
}
`

/**
 * Minimal grandchild graph: start → exit (no codergen needed)
 */
export const GRANDCHILD_GRAPH_DOT = `
digraph grandchild_graph {
  start [type="start"];
  exit  [type="exit"];

  start -> exit;
}
`
