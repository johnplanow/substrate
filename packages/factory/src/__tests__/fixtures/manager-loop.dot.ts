/**
 * DOT fixture strings for manager loop handler integration tests.
 * Story 50-11.
 *
 * Manager loop handler attributes (verified from manager-loop.ts):
 *   node.attrs['graph_file']   — path to body .dot file (required)
 *   node.attrs['max_cycles']   — maximum loop iterations (default: 10)
 *   node.attrs['stop_condition'] — context key or 'llm:' prefix question
 *
 * IMPORTANT: `parseGraph` does NOT populate `node.attrs`, so tests must
 * construct nodes manually or post-process parsed graphs.
 *
 * Registered type: 'stack.manager_loop' (story 50-8)
 */

/**
 * Parent graph with a manager loop node.
 * start → manager_loop → exit
 *
 * Note: The manager loop node needs attrs set manually in tests:
 *   node.attrs = { graph_file: '/test/body.dot', max_cycles: '3' }
 */
export const MANAGER_LOOP_DOT = `
digraph manager_loop_test {
  start        [type="start"];
  manager_loop [type="stack.manager_loop", label="Supervised Loop"];
  exit         [type="exit"];

  start        -> manager_loop;
  manager_loop -> exit;
}
`

/**
 * Body graph for the manager loop: start → work → exit
 * Used as the content returned by the mock graphFileLoader.
 */
export const MANAGER_LOOP_BODY_DOT = `
digraph loop_body {
  start [type="start"];
  work  [type="codergen", label="Do Work"];
  exit  [type="exit"];

  start -> work;
  work  -> exit;
}
`

/**
 * Body graph with a stop condition key written to context.
 * The work node sets context key 'task_complete' = true.
 * Used to test context-key-based stop conditions.
 */
export const BODY_WITH_STOP_CONDITION_DOT = `
digraph loop_body_stop {
  start [type="start"];
  work  [type="codergen", label="Complete Task"];
  exit  [type="exit"];

  start -> work;
  work  -> exit;
}
`
