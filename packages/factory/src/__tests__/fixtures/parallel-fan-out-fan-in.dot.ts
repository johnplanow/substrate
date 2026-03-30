/**
 * DOT fixture strings for parallel fan-out/fan-in integration tests.
 * Story 50-11.
 *
 * Node type strings verified via:
 *   grep -rn "registry.register" packages/factory/src/handlers/registry.ts
 *
 * Registered types used here:
 *   'parallel'       – fan-out node (story 50-1)
 *   'parallel.fan_in'– fan-in/merge node (story 50-2)
 *   'start'          – start node
 *   'exit'           – exit node
 *   'codergen'       – branch execution nodes
 *
 * Join policy is set via the DOT attribute `joinPolicy` (camelCase),
 * which the parser maps to `node.joinPolicy`. The parallel handler reads
 * `node.attrs?.['join_policy'] ?? node.joinPolicy ?? 'wait_all'`.
 */

/**
 * 3-branch wait_all parallel graph.
 * fan_out → [branch_a, branch_b, branch_c] → fan_in → exit
 */
export const PARALLEL_FAN_OUT_DOT = `
digraph parallel_wait_all {
  start    [type="start"];
  fan_out  [type="parallel"];
  branch_a [type="codergen", label="Branch A"];
  branch_b [type="codergen", label="Branch B"];
  branch_c [type="codergen", label="Branch C"];
  fan_in   [type="parallel.fan_in"];
  exit     [type="exit"];

  start    -> fan_out;
  fan_out  -> branch_a;
  fan_out  -> branch_b;
  fan_out  -> branch_c;
  branch_a -> fan_in;
  branch_b -> fan_in;
  branch_c -> fan_in;
  fan_in   -> exit;
}
`

/**
 * 2-branch first_success parallel graph.
 * fan_out → [branch_a, branch_b] → fan_in → exit
 * Policy: first_success — resolves on the first branch to return SUCCESS.
 */
export const FIRST_SUCCESS_POLICY_DOT = `
digraph parallel_first_success {
  start    [type="start"];
  fan_out  [type="parallel", joinPolicy="first_success"];
  branch_a [type="codergen", label="Branch A"];
  branch_b [type="codergen", label="Branch B"];
  fan_in   [type="parallel.fan_in"];
  exit     [type="exit"];

  start    -> fan_out;
  fan_out  -> branch_a;
  fan_out  -> branch_b;
  branch_a -> fan_in;
  branch_b -> fan_in;
  fan_in   -> exit;
}
`

/**
 * 3-branch quorum parallel graph.
 * fan_out → [branch_a, branch_b, branch_c] → fan_in → exit
 * Policy: quorum — resolves after quorum_size branches succeed.
 * quorum_size must be added to fan_out.attrs after parsing (parser does not populate attrs).
 */
export const QUORUM_POLICY_DOT = `
digraph parallel_quorum {
  start    [type="start"];
  fan_out  [type="parallel", joinPolicy="quorum"];
  branch_a [type="codergen", label="Branch A"];
  branch_b [type="codergen", label="Branch B"];
  branch_c [type="codergen", label="Branch C"];
  fan_in   [type="parallel.fan_in"];
  exit     [type="exit"];

  start    -> fan_out;
  fan_out  -> branch_a;
  fan_out  -> branch_b;
  fan_out  -> branch_c;
  branch_a -> fan_in;
  branch_b -> fan_in;
  branch_c -> fan_in;
  fan_in   -> exit;
}
`

/**
 * 4-branch bounded-concurrency graph.
 * maxParallel=2 limits concurrent branch execution to at most 2 at a time.
 */
export const BOUNDED_CONCURRENCY_DOT = `
digraph parallel_bounded {
  start    [type="start"];
  fan_out  [type="parallel", maxParallel=2];
  branch_a [type="codergen", label="Branch A"];
  branch_b [type="codergen", label="Branch B"];
  branch_c [type="codergen", label="Branch C"];
  branch_d [type="codergen", label="Branch D"];
  fan_in   [type="parallel.fan_in"];
  exit     [type="exit"];

  start    -> fan_out;
  fan_out  -> branch_a;
  fan_out  -> branch_b;
  fan_out  -> branch_c;
  fan_out  -> branch_d;
  branch_a -> fan_in;
  branch_b -> fan_in;
  branch_c -> fan_in;
  branch_d -> fan_in;
  fan_in   -> exit;
}
`
