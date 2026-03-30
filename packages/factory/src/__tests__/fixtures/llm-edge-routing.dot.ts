/**
 * DOT fixture strings for LLM-evaluated edge integration tests.
 * Story 50-11.
 *
 * The `condition` DOT edge attribute maps to `GraphEdge.condition`.
 * Edges with `condition="llm:..."` are evaluated by `selectEdge` via the
 * LLM evaluator (`evaluateLlmCondition`).
 *
 * Graph structure: start → decision → exit
 * decision has two outgoing edges:
 *   1. condition="llm:should we iterate?" — LLM-evaluated (to refine node)
 *   2. label="done" — plain unconditional edge (to exit)
 *
 * The LLM edge is tested using `selectEdge` directly with a mock `llmCall`.
 */

/**
 * Decision graph with one LLM-evaluated edge and one plain forward edge.
 * start → decision → exit (via done edge)
 *                 → refine (via llm:should we iterate? edge)
 * refine → exit
 */
export const LLM_EDGE_ROUTING_DOT = `
digraph llm_edge_test {
  start    [type="start"];
  decision [type="codergen", label="Evaluate Progress"];
  refine   [type="codergen", label="Refine"];
  exit     [type="exit"];

  start    -> decision;
  decision -> refine [condition="llm:should we iterate?"];
  decision -> exit   [label="done"];
  refine   -> exit;
}
`

/**
 * Graph with multiple static label edges and one LLM edge.
 * Used to verify that static label matching still works alongside LLM edges.
 */
export const MIXED_EDGE_TYPES_DOT = `
digraph mixed_edges {
  start    [type="start"];
  router   [type="codergen", label="Route Decision"];
  path_a   [type="codergen", label="Path A"];
  path_b   [type="codergen", label="Path B"];
  exit     [type="exit"];

  start  -> router;
  router -> path_a [label="approved"];
  router -> path_b [label="revision_needed"];
  router -> exit   [condition="llm:is this complete?"];
  path_a -> exit;
  path_b -> exit;
}
`
