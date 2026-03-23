/**
 * ConvergenceController — tracks node outcomes and evaluates goal gates.
 *
 * Implements the Attractor spec's convergence semantics: at the exit node,
 * every node marked `goalGate=true` must have completed with either `SUCCESS`
 * or `PARTIAL_SUCCESS` for the pipeline to exit normally.
 *
 * Story 42-16.
 */

import type { Graph, OutcomeStatus } from '../graph/types.js'

/**
 * Tracks per-node outcomes and evaluates goal gate satisfaction.
 */
export interface ConvergenceController {
  /**
   * Record the final outcome status for a completed node.
   * Called by the executor after the allowPartial demotion check.
   */
  recordOutcome(nodeId: string, status: OutcomeStatus): void

  /**
   * Evaluate whether all `goalGate=true` nodes have been satisfied.
   *
   * A goal gate node is satisfied when its recorded outcome is `SUCCESS` or
   * `PARTIAL_SUCCESS`. Nodes with no recorded outcome are treated as unsatisfied.
   * Graphs with no goal gate nodes are vacuously satisfied.
   *
   * @returns `{ satisfied: true, failingNodes: [] }` if all gates pass;
   *          `{ satisfied: false, failingNodes: [id, ...] }` listing each
   *          gate node that was not satisfied.
   */
  evaluateGates(graph: Graph): { satisfied: boolean; failingNodes: string[] }
}

/**
 * Create a new `ConvergenceController` instance backed by an in-memory outcome map.
 */
export function createConvergenceController(): ConvergenceController {
  const outcomes = new Map<string, OutcomeStatus>()

  return {
    recordOutcome(nodeId: string, status: OutcomeStatus): void {
      outcomes.set(nodeId, status)
    },

    evaluateGates(graph: Graph): { satisfied: boolean; failingNodes: string[] } {
      const failingNodes: string[] = []

      for (const [id, node] of graph.nodes) {
        if (!node.goalGate) continue
        const status = outcomes.get(id)
        if (status !== 'SUCCESS' && status !== 'PARTIAL_SUCCESS') {
          failingNodes.push(id)
        }
      }

      return { satisfied: failingNodes.length === 0, failingNodes }
    },
  }
}
