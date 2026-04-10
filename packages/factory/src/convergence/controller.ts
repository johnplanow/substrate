/**
 * ConvergenceController — tracks node outcomes and evaluates goal gates.
 *
 * Implements the Attractor spec's convergence semantics: at the exit node,
 * every node marked `goalGate=true` must have completed with either `SUCCESS`
 * or `PARTIAL_SUCCESS` for the pipeline to exit normally.
 *
 * Story 42-16.
 * Story 49-3: AutoSummarizer integration for long-running convergence loops.
 */

import type { Graph, GraphNode, IGraphContext, OutcomeStatus } from '../graph/types.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../events.js'
import type {
  AutoSummarizer,
  IterationContext,
  CompressedIterationContext,
} from '../context/auto-summarizer.js'

/**
 * Configuration for ConvergenceController.
 * All fields are optional; defaults are applied in createConvergenceController().
 */
export interface ConvergenceControllerConfig {
  /**
   * Optional AutoSummarizer for compressing older iteration contexts before
   * each iteration dispatch. When omitted, iteration context management is
   * a no-op and no summarization occurs.
   */
  autoSummarizer?: AutoSummarizer
}

/**
 * Options for checkGoalGates() — enables score-based gate evaluation.
 * Story 46-2.
 */
export interface CheckGoalGatesOptions {
  /** Pipeline context for reading satisfaction_score. Required when satisfactionThreshold is set. */
  context?: IGraphContext
  /** Threshold for satisfaction gate: gate passes when satisfaction_score >= satisfactionThreshold. */
  satisfactionThreshold?: number
}

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
   * NOTE: This is the simpler, event-free predecessor to `checkGoalGates()`.
   * The executor uses `checkGoalGates()` exclusively (which adds event emission
   * and score-based evaluation). `evaluateGates()` is retained for direct
   * controller unit tests and Attractor spec compliance tests (Section 3.4).
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
   *
   * When options.satisfactionThreshold and options.context are both provided,
   * satisfaction is determined by comparing satisfaction_score from context against
   * the threshold (score >= threshold). Otherwise falls back to outcome-status evaluation.
   */
  checkGoalGates(
    graph: Graph,
    runId: string,
    eventBus?: TypedEventBus<FactoryEvents>,
    options?: CheckGoalGatesOptions
  ): GoalGateResult

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

  /**
   * Record an iteration's output as context for potential auto-summarization.
   * Appends the context to the internal store.
   * No-op if called with an empty content string (but still stores the context).
   */
  recordIterationContext(ctx: IterationContext): void

  /**
   * Before dispatching the iteration at `currentIndex`, check if the accumulated
   * iteration contexts have grown beyond the auto-summarizer's threshold. If so,
   * all contexts with `index < currentIndex` are compressed, and the internal
   * store is replaced with the compressed result.
   *
   * Purely opt-in: if no `autoSummarizer` was provided in the config, this method
   * returns the current stored contexts without modification.
   *
   * @param currentIndex - The zero-based index of the iteration about to be dispatched
   * @returns The (possibly compressed) stored iteration contexts
   */
  prepareForIteration(
    currentIndex: number
  ): Promise<(IterationContext | CompressedIterationContext)[]>

  /**
   * Return a snapshot of the currently stored iteration contexts.
   * May include `CompressedIterationContext` objects if prepareForIteration()
   * has triggered compression.
   */
  getStoredContexts(): (IterationContext | CompressedIterationContext)[]
}

/**
 * Create a new `ConvergenceController` instance backed by an in-memory outcome map.
 *
 * @param config - Optional configuration. Pass `{ autoSummarizer }` to enable
 *                 automatic context compression in long-running convergence loops.
 */
export function createConvergenceController(
  config?: ConvergenceControllerConfig
): ConvergenceController {
  const outcomes = new Map<string, OutcomeStatus>()
  let storedContexts: (IterationContext | CompressedIterationContext)[] = []

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

    checkGoalGates(
      graph: Graph,
      runId: string,
      eventBus?: TypedEventBus<FactoryEvents>,
      options?: CheckGoalGatesOptions
    ): GoalGateResult {
      const failedGates: string[] = []

      for (const [id, node] of graph.nodes) {
        if (!node.goalGate) continue
        if (options?.satisfactionThreshold !== undefined && options?.context !== undefined) {
          const score = options.context.getNumber('satisfaction_score', 0)
          const satisfied = score >= options.satisfactionThreshold
          eventBus?.emit('graph:goal-gate-checked', { runId, nodeId: id, satisfied, score })
          if (!satisfied) failedGates.push(id)
        } else {
          const status = outcomes.get(id)
          const satisfied = status === 'SUCCESS' || status === 'PARTIAL_SUCCESS'
          eventBus?.emit('graph:goal-gate-checked', { runId, nodeId: id, satisfied })
          if (!satisfied) {
            failedGates.push(id)
          }
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

    recordIterationContext(ctx: IterationContext): void {
      storedContexts.push(ctx)
    },

    async prepareForIteration(
      currentIndex: number
    ): Promise<(IterationContext | CompressedIterationContext)[]> {
      if (!config?.autoSummarizer || storedContexts.length === 0) {
        return storedContexts
      }

      // Build an IterationContext[] from the stored plain contexts for the trigger check.
      // CompressedIterationContext entries are excluded from the token sum (already compressed).
      const uncompressedContexts = storedContexts.filter(
        (c): c is IterationContext => !('compressed' in c)
      )

      if (config.autoSummarizer.shouldTrigger(uncompressedContexts)) {
        const compressionResult = await config.autoSummarizer.compress(
          uncompressedContexts,
          currentIndex
        )
        // Merge compressed results back with any already-compressed contexts,
        // maintaining index ordering.
        const alreadyCompressed = storedContexts.filter(
          (c): c is CompressedIterationContext => 'compressed' in c
        )
        const merged = [...alreadyCompressed, ...compressionResult.iterations].sort(
          (a, b) => a.index - b.index
        )
        storedContexts = merged
      }

      return storedContexts
    },

    getStoredContexts(): (IterationContext | CompressedIterationContext)[] {
      return storedContexts
    },
  }
}
