/**
 * ConvergenceController — tracks node outcomes and evaluates goal gates.
 *
 * Implements the Attractor spec's convergence semantics: at the exit node,
 * every node marked `goalGate=true` must have completed with either `SUCCESS`
 * or `PARTIAL_SUCCESS` for the pipeline to exit normally.
 *
 * Story 42-16.
 */

import type { Graph, GraphNode, OutcomeStatus } from '../graph/types.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../events.js'

/**
 * Result of evaluating all goal gate nodes in a graph.
 */
export interface GoalGateResult {
  satisfied: boolean
  failedGates: string[]
}

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

  /**
   * Evaluate all goal gate nodes and emit graph:goal-gate-checked for each.
   * Returns satisfied=true only when every goalGate=true node recorded
   * SUCCESS or PARTIAL_SUCCESS. Graphs with no goal gate nodes are vacuously satisfied.
   */
  checkGoalGates(graph: Graph, runId: string, eventBus?: TypedEventBus<FactoryEvents>): GoalGateResult

  /**
   * Resolve the retry target after an unsatisfied goal gate by walking a
   * 4-level priority chain:
   *
   *   1. `failedNode.retryTarget`         — node-level explicit target
   *   2. `failedNode.fallbackRetryTarget`  — node-level fallback
   *   3. `graph.retryTarget`               — graph-level default
   *   4. `graph.fallbackRetryTarget`       — graph-level default fallback
   *
   * A candidate is valid only when the string is non-empty AND the node id
   * exists in `graph.nodes`. Both empty strings and non-existent node ids are
   * treated as absent and cause the resolution to fall through to the next level.
   *
   * @returns the first valid candidate node id, or `null` when no valid target
   *          exists at any level (signalling that the pipeline must FAIL).
   */
  resolveRetryTarget(failedNode: GraphNode, graph: Graph): string | null
}

/**
 * Create a new `ConvergenceController` instance backed by an in-memory outcome map.
 */
export function createConvergenceController(): ConvergenceController {
  const outcomes = new Map<string, OutcomeStatus>()

  /** Returns true only when id is non-empty AND exists in graph.nodes. */
  function isValidTarget(id: string, graph: Graph): boolean {
    return id !== '' && graph.nodes.has(id)
  }

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

    checkGoalGates(graph: Graph, runId: string, eventBus?: TypedEventBus<FactoryEvents>): GoalGateResult {
      const failedGates: string[] = []

      for (const [id, node] of graph.nodes) {
        if (!node.goalGate) continue
        const status = outcomes.get(id)
        const satisfied = status === 'SUCCESS' || status === 'PARTIAL_SUCCESS'
        eventBus?.emit('graph:goal-gate-checked', { runId, nodeId: id, satisfied })
        if (!satisfied) {
          failedGates.push(id)
        }
      }

      return { satisfied: failedGates.length === 0, failedGates }
    },

    resolveRetryTarget(failedNode: GraphNode, graph: Graph): string | null {
      const candidates = [
        failedNode.retryTarget,
        failedNode.fallbackRetryTarget,
        graph.retryTarget,
        graph.fallbackRetryTarget,
      ]

      for (const candidate of candidates) {
        if (isValidTarget(candidate, graph)) {
          return candidate
        }
      }

      return null
    },
  }
}
