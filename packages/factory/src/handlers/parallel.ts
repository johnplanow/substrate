/**
 * Parallel handler — fan-out with isolated branch contexts and configurable
 * join policies.
 *
 * Executes all outgoing branches of a `parallel` node (shape=component)
 * concurrently, each in its own cloned context so mutations never leak
 * between branches or back to the parent context.
 *
 * Join policies (story 50-3, read from `node.joinPolicy` or `node.attrs`):
 *   - `wait_all` (default) — all branches complete before fan-in
 *   - `first_success`      — fan-in resolves on first SUCCESS; rest cancelled
 *   - `quorum`             — fan-in resolves after `quorum_size` SUCCESSes; rest cancelled
 *
 * Context outputs:
 *   - `parallel.results`        — `BranchResult[]` for every branch
 *   - `parallel.winner_index`   — winning branch index (first_success policy)
 *   - `parallel.quorum_reached` — number of successes (quorum policy)
 *   - `parallel.join_error`     — failure reason when join condition cannot be met
 *
 * Story 50-1 (AC1–AC7), extended by Story 50-3 (AC1–AC5).
 */

import type { Graph, GraphEdge, GraphNode, IGraphContext, Outcome } from '../graph/types.js'
import type { NodeHandler, ParallelHandlerOptions, FanInBranchResult } from './types.js'
import {
  evaluateJoinPolicy,
  BranchCancellationManager,
} from './join-policy.js'
import type { BranchResult, JoinPolicyConfig, JoinPolicy } from './join-policy.js'
import type { StageStatus } from '../events.js'

// ---------------------------------------------------------------------------
// Branch outcome → StageStatus conversion helper (story 50-9)
// ---------------------------------------------------------------------------

/**
 * Maps a BranchResult outcome string to a StageStatus for event payloads.
 *
 * BranchResult.outcome: 'SUCCESS' | 'FAIL' | 'CANCELLED'
 * StageStatus:          'SUCCESS' | 'FAIL' | 'PARTIAL_SUCCESS' | 'RETRY' | 'SKIPPED'
 *
 * Mapping:
 *   'SUCCESS'   → 'SUCCESS'
 *   'CANCELLED' → 'SKIPPED'
 *   'FAIL'      → 'FAIL'
 */
function branchOutcomeToStatus(outcome: BranchResult['outcome']): StageStatus {
  if (outcome === 'SUCCESS') return 'SUCCESS'
  if (outcome === 'CANCELLED') return 'SKIPPED'
  return 'FAIL'
}

// ---------------------------------------------------------------------------
// Fan-in bridge helper (story 50-3 fix)
// ---------------------------------------------------------------------------

/**
 * Enrich a join-policy `BranchResult` with fan-in-compatible fields so that
 * `fan-in.ts` can read `parallel.results` without type-shape mismatch.
 *
 * The returned object is a superset of `BranchResult` — it preserves every
 * original field (index, outcome, contextSnapshot, error) AND adds the fields
 * that `fan-in.ts` requires (branch_id, status, context_updates, failure_reason).
 *
 * Mapping:
 *   index          → branch_id        (same numeric value)
 *   outcome        → status           ('SUCCESS' | 'FAIL'/'CANCELLED' → 'SUCCESS' | 'FAILURE')
 *   contextSnapshot → context_updates  (shallow context snapshot)
 *   error          → failure_reason   (human-readable failure description)
 */
function toBridgeBranchResult(result: BranchResult): FanInBranchResult {
  return {
    ...result,
    branch_id: result.index,
    status: result.outcome === 'SUCCESS' ? 'SUCCESS' : 'FAILURE',
    context_updates: result.contextSnapshot,
    failure_reason: result.error,
  }
}

// ---------------------------------------------------------------------------
// Bounded concurrency helper (AC2 — story 50-1)
// ---------------------------------------------------------------------------

/**
 * Run an array of async task factories with at most `limit` executing
 * concurrently at any point in time, preserving result order.
 */
async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  const executing = new Set<Promise<void>>()
  for (let i = 0; i < tasks.length; i++) {
    const idx = i
    const p: Promise<void> = tasks[idx]!()
      .then((r) => {
        results[idx] = r as T
      })
      .finally(() => {
        executing.delete(p)
      })
    executing.add(p)
    if (executing.size >= limit) await Promise.race(executing)
  }
  await Promise.all(executing)
  return results
}

// ---------------------------------------------------------------------------
// Join policy parsing helpers (story 50-3)
// ---------------------------------------------------------------------------

function parseJoinPolicyConfig(node: GraphNode): JoinPolicyConfig {
  const policyRaw = node.attrs?.['join_policy'] ?? node.joinPolicy ?? 'wait_all'
  const policy: JoinPolicy =
    policyRaw === 'first_success' || policyRaw === 'quorum' ? policyRaw : 'wait_all'

  const quorumSizeRaw = node.attrs?.['quorum_size']
  const quorum_size =
    quorumSizeRaw !== undefined ? parseInt(quorumSizeRaw, 10) : undefined

  const drainRaw = node.attrs?.['cancel_drain_timeout_ms']
  const cancel_drain_timeout_ms =
    drainRaw !== undefined ? parseInt(drainRaw, 10) : undefined

  return {
    policy,
    ...(quorum_size !== undefined && { quorum_size }),
    ...(cancel_drain_timeout_ms !== undefined && { cancel_drain_timeout_ms }),
  }
}

// ---------------------------------------------------------------------------
// Branch execution helper (shared by all join policies)
// ---------------------------------------------------------------------------

/**
 * Build an async task that executes a single branch node and returns a
 * `BranchResult`. Isolation is guaranteed via `context.clone()`.
 */
function makeBranchTask(
  edge: GraphEdge,
  index: number,
  signal: AbortSignal,
  context: IGraphContext,
  graph: Graph,
  options: ParallelHandlerOptions,
): () => Promise<BranchResult> {
  return async (): Promise<BranchResult> => {
    if (signal.aborted) {
      return { index, outcome: 'CANCELLED' }
    }

    const branchNode = graph.nodes.get(edge.toNode)
    if (!branchNode) {
      return {
        index,
        outcome: 'FAIL',
        error: `Branch node "${edge.toNode}" not found in graph`,
      }
    }

    // AC3 (story 50-1): each branch gets its own independent context copy
    const branchCtx = context.clone()
    branchCtx.set('_branch.abort_signal', signal as unknown)
    branchCtx.set('_branch.index', index)

    const handler = options.handlerRegistry.resolve(branchNode)

    let branchOutcome: Outcome
    try {
      branchOutcome = await handler(branchNode, branchCtx, graph)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        index,
        outcome: 'FAIL',
        error: msg,
        contextSnapshot: branchCtx.snapshot(),
      }
    }

    if (signal.aborted) {
      return { index, outcome: 'CANCELLED', contextSnapshot: branchCtx.snapshot() }
    }

    const isSuccess =
      branchOutcome.status === 'SUCCESS' || branchOutcome.status === 'PARTIAL_SUCCESS'

    const result: BranchResult = {
      index,
      outcome: isSuccess ? 'SUCCESS' : 'FAIL',
      contextSnapshot: branchCtx.snapshot(),
    }
    if (!isSuccess) {
      const reason = branchOutcome.failureReason
      if (reason !== undefined) result.error = reason
    }
    return result
  }
}

// ---------------------------------------------------------------------------
// Parallel handler factory
// ---------------------------------------------------------------------------

/**
 * Create a `parallel` node handler that fans out to all outgoing branch nodes
 * concurrently, applies a configurable join policy, and writes results to context.
 *
 * @param options.handlerRegistry  Registry used to resolve each branch node's
 *   handler at invocation time.
 */
export function createParallelHandler(options: ParallelHandlerOptions): NodeHandler {
  return async (node: GraphNode, context: IGraphContext, graph: Graph): Promise<Outcome> => {
    const branchEdges = graph.outgoingEdges(node.id)
    const branchCount = branchEdges.length

    if (branchCount === 0) {
      context.set('parallel.results', [])
      return { status: 'SUCCESS' }
    }

    const config = parseJoinPolicyConfig(node)
    const maxParallel = node.maxParallel ?? 0
    const drainMs = config.cancel_drain_timeout_ms ?? 5000

    const cancellationManager = new BranchCancellationManager(branchCount)

    // Read runId from context (written by executor, story 50-9 AC4)
    const runId = context.getString('__runId', 'unknown')

    // Emit graph:parallel-started once before any branch launches (story 50-9 AC1)
    options.eventBus?.emit('graph:parallel-started', {
      runId,
      nodeId: node.id,
      branchCount,
      maxParallel: maxParallel > 0 ? maxParallel : branchCount,
      policy: config.policy,
    })

    // -----------------------------------------------------------------------
    // wait_all — all branches must complete (supports maxParallel semaphore)
    // -----------------------------------------------------------------------
    if (config.policy === 'wait_all') {
      const tasks = branchEdges.map((edge, index) => {
        const baseTask = makeBranchTask(
          edge, index, cancellationManager.getSignal(index), context, graph, options
        )
        // Wrap with event emission (story 50-9 AC1)
        return async (): Promise<BranchResult> => {
          options.eventBus?.emit('graph:parallel-branch-started', {
            runId,
            nodeId: node.id,
            branchIndex: index,
          })
          const branchStart = Date.now()
          const result = await baseTask()
          const durationMs = Date.now() - branchStart
          options.eventBus?.emit('graph:parallel-branch-completed', {
            runId,
            nodeId: node.id,
            branchIndex: index,
            status: branchOutcomeToStatus(result.outcome),
            durationMs,
          })
          return result
        }
      })

      const results: BranchResult[] =
        maxParallel > 0
          ? await runWithConcurrencyLimit(tasks, maxParallel)
          : await Promise.all(tasks.map((t) => t()))

      context.set('parallel.results', results.map(toBridgeBranchResult))

      const completedCount = results.filter(r => r.outcome === 'SUCCESS').length
      const cancelledCount = results.filter(r => r.outcome === 'CANCELLED').length
      options.eventBus?.emit('graph:parallel-completed', {
        runId,
        nodeId: node.id,
        completedCount,
        cancelledCount,
        policy: config.policy,
      })

      return { status: 'SUCCESS' }
    }

    // -----------------------------------------------------------------------
    // first_success / quorum — incremental fan-out with early termination
    // -----------------------------------------------------------------------

    const completed: BranchResult[] = []
    const completedIndices = new Set<number>()

    type CompletionEvent = { result: BranchResult }
    const pendingEvents: CompletionEvent[] = []
    const waiters: Array<(e: CompletionEvent) => void> = []

    function push(event: CompletionEvent): void {
      const w = waiters.shift()
      if (w !== undefined) {
        w(event)
      } else {
        pendingEvents.push(event)
      }
    }

    function waitForNext(): Promise<CompletionEvent> {
      return new Promise(resolve => {
        const e = pendingEvents.shift()
        if (e !== undefined) {
          resolve(e)
        } else {
          waiters.push(resolve)
        }
      })
    }

    // Launch all branches immediately, emitting branch-started and branch-completed (story 50-9)
    const branchStarts = new Map<number, number>()
    const activeTasks: Promise<void>[] = branchEdges.map((edge, index) => {
      const task = makeBranchTask(
        edge, index, cancellationManager.getSignal(index), context, graph, options
      )
      options.eventBus?.emit('graph:parallel-branch-started', {
        runId,
        nodeId: node.id,
        branchIndex: index,
      })
      branchStarts.set(index, Date.now())
      return task().then(result => {
        const branchStart = branchStarts.get(index) ?? Date.now()
        const durationMs = Date.now() - branchStart
        options.eventBus?.emit('graph:parallel-branch-completed', {
          runId,
          nodeId: node.id,
          branchIndex: index,
          status: branchOutcomeToStatus(result.outcome),
          durationMs,
        })
        push({ result })
      })
    })

    let joinOutcome: 'SUCCESS' | 'FAIL' = 'SUCCESS'
    let settled = false
    let joinErrorMsg: string | undefined

    for (let i = 0; i < branchCount; i++) {
      const { result } = await waitForNext()

      if (completedIndices.has(result.index)) continue
      completed.push(result)
      completedIndices.add(result.index)

      const decision = evaluateJoinPolicy(config, completed, branchCount)
      if (decision.action === 'wait') continue

      settled = true
      joinOutcome = decision.action === 'continue' ? 'SUCCESS' : 'FAIL'
      if (decision.action === 'fail') joinErrorMsg = decision.reason

      const uncancelledCount = branchCount - completedIndices.size
      cancellationManager.cancelRemaining(completedIndices)

      if (uncancelledCount > 0) {
        await cancellationManager.drainAsync(drainMs)

        // Collect results that arrived during drain window
        while (pendingEvents.length > 0) {
          const e = pendingEvents.shift()
          if (e !== undefined && !completedIndices.has(e.result.index)) {
            completed.push(e.result)
            completedIndices.add(e.result.index)
          }
        }

        // Synthetic CANCELLED for branches still outstanding after drain
        for (let j = 0; j < branchCount; j++) {
          if (!completedIndices.has(j)) {
            completed.push({ index: j, outcome: 'CANCELLED' })
            completedIndices.add(j)
          }
        }
      }

      context.set('parallel.results', completed.map(toBridgeBranchResult))

      if (decision.action === 'continue') {
        if (config.policy === 'first_success') {
          const winner = completed.find(r => r.outcome === 'SUCCESS')
          if (winner !== undefined) {
            context.set('parallel.winner_index', winner.index)
          }
        }
        if (config.policy === 'quorum') {
          const successCount = completed.filter(r => r.outcome === 'SUCCESS').length
          context.set('parallel.quorum_reached', successCount)
        }
      } else {
        context.set('parallel.join_error', joinErrorMsg ?? decision.reason)
      }

      break
    }

    // Do not block on cancelled branches — fire and forget
    void Promise.allSettled(activeTasks)

    if (!settled) {
      context.set('parallel.results', completed.map(toBridgeBranchResult))
    }

    // Emit graph:parallel-completed with final branch counts (story 50-9 AC1)
    const finalCompletedCount = completed.filter(r => r.outcome === 'SUCCESS').length
    const finalCancelledCount = completed.filter(r => r.outcome === 'CANCELLED').length
    options.eventBus?.emit('graph:parallel-completed', {
      runId,
      nodeId: node.id,
      completedCount: finalCompletedCount,
      cancelledCount: finalCancelledCount,
      policy: config.policy,
    })

    return { status: joinOutcome === 'SUCCESS' ? 'SUCCESS' : 'FAILURE' }
  }
}
