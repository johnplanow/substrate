/**
 * Join policy types, pure evaluator, and branch cancellation manager
 * for parallel node fan-out/fan-in coordination.
 *
 * Design constraints:
 *   - Zero external package imports (pure TypeScript/built-ins only)
 *   - `evaluateJoinPolicy` is a pure synchronous function (no I/O, no side effects)
 *   - `BranchCancellationManager` uses the globally-available AbortController (Node 18+)
 *
 * Story 50-3 (AC6).
 */

// ---------------------------------------------------------------------------
// JoinPolicy
// ---------------------------------------------------------------------------

/**
 * The coordination strategy used by a parallel node's fan-in stage.
 *
 * - `wait_all`      — all branches must complete before the parallel node resolves
 * - `first_success` — resolve as soon as the first branch succeeds; cancel the rest
 * - `quorum`        — resolve after `quorum_size` branches succeed; cancel the rest
 */
export type JoinPolicy = 'wait_all' | 'first_success' | 'quorum'

// ---------------------------------------------------------------------------
// BranchResult
// ---------------------------------------------------------------------------

/**
 * The result record produced when a single branch finishes execution.
 */
export interface BranchResult {
  /** Zero-based index of the branch within the parallel node's fan-out set. */
  index: number
  /** Terminal status for this branch. */
  outcome: 'SUCCESS' | 'FAIL' | 'CANCELLED'
  /**
   * Shallow snapshot of the branch's context values at completion time.
   * Omitted for CANCELLED branches that were aborted before producing output.
   */
  contextSnapshot?: Record<string, unknown>
  /** Human-readable error string when `outcome === 'FAIL'`. */
  error?: string
}

// ---------------------------------------------------------------------------
// JoinPolicyConfig
// ---------------------------------------------------------------------------

/**
 * Configuration parsed from a parallel node's DOT attributes.
 */
export interface JoinPolicyConfig {
  /** The coordination strategy to apply when fan-in branches complete. */
  policy: JoinPolicy
  /**
   * Minimum number of successful branches required before fan-in resolves.
   * Required when `policy === 'quorum'`; ignored for other policies.
   */
  quorum_size?: number
  /**
   * How long (ms) to wait for in-flight branches to clean up after cancellation.
   * Defaults to 5000 ms when omitted.
   */
  cancel_drain_timeout_ms?: number
}

// ---------------------------------------------------------------------------
// JoinDecision
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by `evaluateJoinPolicy` after each branch completes.
 *
 * - `continue` — the join condition is satisfied; proceed to fan-in output
 * - `wait`     — the join condition is not yet met; wait for the next branch
 * - `fail`     — the join condition can never be met; abort the parallel node
 */
export type JoinDecision =
  | { action: 'continue'; results: BranchResult[] }
  | { action: 'wait' }
  | { action: 'fail'; reason: string }

// ---------------------------------------------------------------------------
// evaluateJoinPolicy
// ---------------------------------------------------------------------------

/**
 * Pure synchronous function that decides what the parallel handler should do
 * after a set of branches has completed.
 *
 * Called incrementally after each branch finishes: pass the full `completed`
 * array (including all branches resolved so far) and the `total` branch count.
 *
 * @param config    - Join policy configuration parsed from the parallel node.
 * @param completed - All branch results collected so far (any order).
 * @param total     - Total number of branches in the fan-out set.
 * @returns A `JoinDecision` indicating whether to continue, wait, or fail.
 */
export function evaluateJoinPolicy(
  config: JoinPolicyConfig,
  completed: BranchResult[],
  total: number
): JoinDecision {
  const successes = completed.filter((r) => r.outcome === 'SUCCESS')
  const failures = completed.filter((r) => r.outcome === 'FAIL')

  switch (config.policy) {
    case 'wait_all': {
      if (completed.length < total) return { action: 'wait' }
      return { action: 'continue', results: completed }
    }

    case 'first_success': {
      // Any success → resolve immediately
      if (successes.length >= 1) return { action: 'continue', results: completed }
      // All non-CANCELLED slots have completed with FAIL (or total === 0)
      if (completed.length >= total) {
        return {
          action: 'fail',
          reason: `first_success: all ${total} branches failed`,
        }
      }
      return { action: 'wait' }
    }

    case 'quorum': {
      const needed = config.quorum_size ?? 1
      // Guard against nonsensical quorum_size values
      if (needed <= 0) {
        return { action: 'fail', reason: 'quorum_size must be >= 1' }
      }
      // Quorum met
      if (successes.length >= needed) return { action: 'continue', results: completed }
      // Can we still reach quorum?
      const remaining = total - completed.length
      if (successes.length + remaining < needed) {
        return {
          action: 'fail',
          reason: `quorum unreachable: ${failures.length} failed, needed ${needed} of ${total}`,
        }
      }
      return { action: 'wait' }
    }

    default: {
      // TypeScript exhaustiveness guard
      const _exhaustive: never = config.policy
      return { action: 'fail', reason: `unknown join policy: ${String(_exhaustive)}` }
    }
  }
}

// ---------------------------------------------------------------------------
// BranchCancellationManager
// ---------------------------------------------------------------------------

/**
 * Manages one `AbortController` per branch in a parallel fan-out execution.
 *
 * Typical usage:
 *   1. Construct with the total branch count.
 *   2. Pass `getSignal(i)` to the i-th branch executor.
 *   3. After the join condition is met, call `cancelRemaining(completedSet)`.
 *   4. Await `drainAsync(timeoutMs)` to give cancelled branches time to clean up.
 */
export class BranchCancellationManager {
  private readonly controllers: AbortController[]

  /**
   * @param branchCount - Total number of branches; allocates one AbortController per branch.
   */
  constructor(branchCount: number) {
    this.controllers = Array.from({ length: branchCount }, () => new AbortController())
  }

  /**
   * Return the AbortSignal for the branch at the given zero-based index.
   * The signal is not yet aborted; it becomes aborted when `cancelRemaining` includes the index.
   */
  getSignal(index: number): AbortSignal {
    const ctrl = this.controllers[index]
    if (ctrl === undefined) {
      throw new RangeError(
        `Branch index ${index} is out of range (branchCount=${this.controllers.length})`
      )
    }
    return ctrl.signal
  }

  /**
   * Abort all branches whose index is NOT in `completedIndices`.
   * Branches that have already completed are not re-aborted.
   *
   * @param completedIndices - Set of branch indices that finished successfully/naturally.
   */
  cancelRemaining(completedIndices: Set<number>): void {
    this.controllers.forEach((ctrl, i) => {
      if (!completedIndices.has(i)) {
        ctrl.abort()
      }
    })
  }

  /**
   * Wait `timeoutMs` milliseconds for in-flight branches to honour their AbortSignals
   * and finish any cleanup work before the parallel handler resolves.
   *
   * @param timeoutMs - Drain window in milliseconds (default 5000).
   */
  async drainAsync(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  }
}
