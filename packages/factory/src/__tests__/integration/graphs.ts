/**
 * DOT fixture strings for graph engine integration tests.
 * Story 42-15: Graph Engine Integration Tests.
 *
 * Design guidelines (from story dev notes):
 * - start node: shape=Mdiamond or id=start
 * - exit node:  shape=Msquare or id=exit
 * - Edge conditions use the `condition` attribute (evaluated by edge-selector against context)
 * - Node types: type=codergen, type=tool, type=conditional, type="wait.human"
 * - Graph-level stylesheet: graph [model_stylesheet="..."]
 */

// ---------------------------------------------------------------------------
// AC1: 5-node conditional pipeline
// ---------------------------------------------------------------------------

/**
 * 5-node conditional pipeline:
 *   start → analyze → [condition=status=success] → report → exit
 *                  → [condition=status=failure] → fallback → exit
 *
 * The `analyze` mock handler should return `contextUpdates: { status: 'success' }` to
 * route through report.
 */
export const FIVE_NODE_CONDITIONAL_DOT = `
digraph test_conditional {
  graph [goal="Conditional pipeline test"]
  start [shape=Mdiamond]
  analyze [type=codergen, prompt="Analyze input"]
  report  [type=codergen, prompt="Write report"]
  fallback [type=codergen, prompt="Handle failure"]
  exit [shape=Msquare]

  start -> analyze
  analyze -> report [condition="status=success"]
  analyze -> fallback [condition="status=failure"]
  report -> exit
  fallback -> exit
}
`

// ---------------------------------------------------------------------------
// AC2: 10-node multi-type graph
// ---------------------------------------------------------------------------

/**
 * 10-node graph covering all implemented handler types:
 *   start, codergen ×2, tool ×2, conditional ×1, wait.human ×1,
 *   2 intermediate routing nodes, exit.
 *
 * All edges are unconditional; all mock handlers return SUCCESS.
 * The wait_human handler should return preferredLabel: 'Yes' to simulate user selection.
 */
export const TEN_NODE_MULTI_TYPE_DOT = `
digraph test_multi_type {
  graph [goal="Multi-type graph test"]
  start      [shape=Mdiamond]
  cgen1      [type=codergen,   prompt="First code generation"]
  cgen2      [type=codergen,   prompt="Second code generation"]
  tool1      [type=tool,       tool_command="echo tool1", label="Tool 1"]
  tool2      [type=tool,       tool_command="echo tool2", label="Tool 2"]
  cond1      [type=conditional, label="Branch check"]
  wait_human [type="wait.human", label="Await human input"]
  router1    [label="Router 1"]
  router2    [label="Router 2"]
  exit       [shape=Msquare]

  start -> cgen1
  cgen1 -> cgen2
  cgen2 -> tool1
  tool1 -> tool2
  tool2 -> cond1
  cond1 -> wait_human
  wait_human -> router1
  router1 -> router2
  router2 -> exit
}
`

// ---------------------------------------------------------------------------
// AC3: Error-rule violation graph
// ---------------------------------------------------------------------------

/**
 * Graph that violates two error-level rules:
 *   - reachability:      `orphan` node is not reachable from start
 *   - start_no_incoming: `analyze -> start` edge points into the start node
 */
export const ERROR_RULE_VIOLATION_DOT = `
digraph test_error_violations {
  graph [goal="Error violation test"]
  start  [shape=Mdiamond]
  analyze [type=codergen, prompt="Analyze input"]
  orphan  [type=codergen, prompt="Orphan node not reachable from start"]
  exit   [shape=Msquare]

  start -> analyze
  analyze -> exit
  analyze -> start
}
`

// ---------------------------------------------------------------------------
// AC4: Warning-rule violation graph
// ---------------------------------------------------------------------------

/**
 * Graph that violates two warning-level rules (but zero error rules):
 *   - prompt_on_llm_nodes: `analyze` has type=codergen but no prompt or label
 *   - fidelity_valid:      `analyze` has fidelity=ultra (unrecognised value)
 */
export const WARNING_RULE_VIOLATION_DOT = `
digraph test_warning_violations {
  graph [goal="Warning violation test"]
  start   [shape=Mdiamond]
  analyze [type=codergen, fidelity=ultra]
  exit    [shape=Msquare]

  start -> analyze
  analyze -> exit
}
`

// ---------------------------------------------------------------------------
// AC5: 5-node linear graph for checkpoint resume
// ---------------------------------------------------------------------------

/**
 * Linear 5-node chain used for checkpoint-resume testing:
 *   start → node1 → node2 → node3 → exit
 *
 * With checkpoint seed `completedNodes: ['start', 'node1']`, the executor
 * should skip start and node1 and resume from node2.
 */
export const FIVE_NODE_LINEAR_DOT = `
digraph test_linear_resume {
  graph [goal="Linear checkpoint resume test"]
  start [shape=Mdiamond]
  node1 [type=codergen, prompt="Node 1 work"]
  node2 [type=codergen, prompt="Node 2 work"]
  node3 [type=codergen, prompt="Node 3 work"]
  exit  [shape=Msquare]

  start -> node1
  node1 -> node2
  node2 -> node3
  node3 -> exit
}
`

// ---------------------------------------------------------------------------
// AC6: Stylesheet application graph
// ---------------------------------------------------------------------------

/**
 * Graph with a `model_stylesheet` attribute that sets:
 *   - Universal rule: all nodes use claude-3-haiku-20240307
 *   - ID rule:        #analyze overrides to claude-opus-4-5
 *
 * Neither `analyze` nor `summarize` has an explicit `llm_model` attribute;
 * the stylesheet resolver should apply the correct per-node values.
 */
export const STYLESHEET_DOT = `
digraph test_stylesheet {
  graph [model_stylesheet="* { llm_model: claude-3-haiku-20240307 } #analyze { llm_model: claude-opus-4-5 }"]
  start    [shape=Mdiamond]
  analyze  [type=codergen, prompt="Analyze with opus"]
  summarize [type=codergen, prompt="Summarize with haiku"]
  exit     [shape=Msquare]

  start -> analyze
  analyze -> summarize
  summarize -> exit
}
`
