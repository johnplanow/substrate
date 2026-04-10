/**
 * Per-node retry budget enforcement for the convergence loop.
 * Story 45-3: provides pure budget primitives — no I/O, no side effects.
 *
 * Consumed by:
 *   - Story 45-4 (per-pipeline budget enforcement)
 *   - Story 45-8 (convergence controller integration)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by `checkNodeBudget`.
 *
 * - `{ allowed: true }` — the node may attempt another retry.
 * - `{ allowed: false; reason: string }` — the budget is exhausted; the
 *   executor should not schedule another attempt.
 */
export type BudgetCheckResult = { allowed: true } | { allowed: false; reason: string }

/**
 * Options controlling the exponential-backoff delay calculation.
 *
 * All fields are optional; the defaults produce delays of 200 ms, 400 ms,
 * 800 ms … capped at 60 000 ms, with ±50 % jitter.
 */
export interface BackoffOptions {
  /** Initial delay in milliseconds for attempt index 0. Default: 200. */
  initialDelay?: number
  /** Multiplicative factor applied each attempt. Default: 2. */
  factor?: number
  /** Maximum delay in milliseconds before jitter is applied. Default: 60000. */
  maxDelay?: number
  /**
   * Fraction of the capped delay used as the jitter amplitude.
   * A value of 0.5 produces ±50 % variance; 0 disables jitter entirely.
   * Default: 0.5.
   */
  jitterFactor?: number
}

// ---------------------------------------------------------------------------
// Budget check
// ---------------------------------------------------------------------------

/**
 * Determine whether a node is permitted to make another retry attempt.
 *
 * @param nodeId    - Identifier of the node (used only for future diagnostics;
 *                    not examined by this function).
 * @param retryCount - Number of retries already consumed (0 on first failure).
 * @param maxRetries - Maximum number of retries allowed for the node.
 * @returns `{ allowed: true }` when `retryCount < maxRetries`, otherwise
 *          `{ allowed: false, reason: 'max retries exhausted' }`.
 */
export function checkNodeBudget(
  nodeId: string,
  retryCount: number,
  maxRetries: number
): BudgetCheckResult {
  if (retryCount < maxRetries) {
    return { allowed: true }
  }
  return { allowed: false, reason: 'max retries exhausted' }
}

// ---------------------------------------------------------------------------
// Exponential backoff
// ---------------------------------------------------------------------------

const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  initialDelay: 200,
  factor: 2,
  maxDelay: 60_000,
  jitterFactor: 0.5,
}

/**
 * Compute the delay (in milliseconds) before the next retry attempt.
 *
 * Formula (before jitter):
 *   `baseDelay = initialDelay * factor^attemptIndex`
 *   `cappedDelay = Math.min(baseDelay, maxDelay)`
 *
 * Jitter:
 *   `jitter = (Math.random() * 2 - 1) * jitterFactor * cappedDelay`
 *   `delay = Math.max(0, Math.round(cappedDelay + jitter))`
 *
 * Passing `{ jitterFactor: 0 }` disables jitter for deterministic tests.
 *
 * @param attemptIndex - Zero-based index of the current attempt (0 = first retry).
 * @param options      - Optional overrides for the backoff parameters.
 */
export function computeBackoffDelay(attemptIndex: number, options?: BackoffOptions): number {
  const { initialDelay, factor, maxDelay, jitterFactor } = {
    ...DEFAULT_BACKOFF,
    ...options,
  }

  const baseDelay = initialDelay * Math.pow(factor, attemptIndex)
  const cappedDelay = Math.min(baseDelay, maxDelay)
  const jitter = (Math.random() * 2 - 1) * jitterFactor * cappedDelay
  return Math.max(0, Math.round(cappedDelay + jitter))
}

// ---------------------------------------------------------------------------
// Per-pipeline budget enforcement — story 45-4
// ---------------------------------------------------------------------------

/**
 * Determine whether a pipeline is permitted to dispatch the next node.
 *
 * **Unlimited mode:** When `cap === 0` the function returns `{ allowed: true }`
 * immediately, regardless of `accumulatedCost`. This matches the
 * `FactoryConfigSchema` default of `budget_cap_usd: 0` which means "no limit".
 *
 * **Strict greater-than boundary:** Enforcement triggers only when
 * `accumulatedCost > cap`. A cost that exactly equals the cap is still allowed,
 * consistent with the PRD wording "halts *before* dispatching further nodes
 * when accumulated cost **exceeds** the cap."
 *
 * @param accumulatedCost - Total cost (USD) spent so far during this pipeline run.
 * @param cap             - Maximum allowed cost (USD). `0` disables enforcement.
 * @returns `{ allowed: true }` when the pipeline may continue, or
 *          `{ allowed: false, reason: '...' }` when the budget is exhausted.
 */
export function checkPipelineBudget(accumulatedCost: number, cap: number): BudgetCheckResult {
  if (cap === 0) {
    return { allowed: true }
  }
  if (accumulatedCost > cap) {
    return {
      allowed: false,
      reason: `pipeline budget exhausted: $${accumulatedCost.toFixed(2)} > $${cap.toFixed(2)}`,
    }
  }
  return { allowed: true }
}

// ---------------------------------------------------------------------------
// PipelineBudgetManager
// ---------------------------------------------------------------------------

/**
 * Tracks accumulated cost for a single pipeline run and enforces a configurable
 * spending cap via `checkPipelineBudget`.
 *
 * **Lifecycle:** Create one instance per pipeline run. Story 45-8 will call
 * `addCost()` after each node dispatch completes and `checkBudget()` before
 * the next dispatch. Call `reset()` between pipeline runs or in tests to clear
 * accumulated state.
 */
export class PipelineBudgetManager {
  private totalCost = 0

  /**
   * Add `amount` USD to the running total for this pipeline run.
   *
   * @param amount - Cost (USD) for the just-completed node dispatch.
   */
  addCost(amount: number): void {
    this.totalCost += amount
  }

  /**
   * Return the total cost (USD) accumulated so far during this pipeline run.
   */
  getTotalCost(): number {
    return this.totalCost
  }

  /**
   * Reset the accumulated cost to zero.
   * Useful for test isolation and future pipeline reuse scenarios.
   */
  reset(): void {
    this.totalCost = 0
  }

  /**
   * Determine whether the pipeline may dispatch the next node, delegating to
   * `checkPipelineBudget` with the current accumulated cost.
   *
   * @param cap - Maximum allowed cost (USD). `0` disables enforcement.
   */
  checkBudget(cap: number): BudgetCheckResult {
    return checkPipelineBudget(this.totalCost, cap)
  }
}

// ---------------------------------------------------------------------------
// Per-session budget enforcement — story 45-5
// ---------------------------------------------------------------------------

/**
 * Determine whether a pipeline session is permitted to dispatch the next node
 * based on wall-clock elapsed time.
 *
 * **Unlimited mode:** When `capMs === 0` the function returns `{ allowed: true }`
 * immediately, regardless of `elapsedMs`. This matches the `FactoryConfigSchema`
 * default of `wall_clock_cap_seconds: 0` which means "no limit".
 *
 * **Strict greater-than boundary:** Enforcement triggers only when
 * `elapsedMs > capMs`. An elapsed time that exactly equals the cap is still
 * allowed, consistent with the PRD wording "halts *before* dispatching further
 * nodes when elapsed time **exceeds** the cap."
 *
 * @param elapsedMs - Milliseconds elapsed since the pipeline session started.
 * @param capMs     - Maximum allowed elapsed time in milliseconds. `0` disables
 *                    enforcement (unlimited mode).
 * @returns `{ allowed: true }` when the session may continue, or
 *          `{ allowed: false, reason: 'wall clock budget exhausted' }` when the
 *          cap has been exceeded.
 */
export function checkSessionBudget(elapsedMs: number, capMs: number): BudgetCheckResult {
  if (capMs === 0) {
    return { allowed: true }
  }
  if (elapsedMs > capMs) {
    return { allowed: false, reason: 'wall clock budget exhausted' }
  }
  return { allowed: true }
}

/**
 * Tracks wall-clock elapsed time for a single pipeline session and enforces a
 * configurable time cap via `checkSessionBudget`.
 *
 * **Lifecycle:** Create one instance per pipeline run, constructed at pipeline
 * launch. Story 45-8 will call `checkBudget()` before each node dispatch as
 * the highest-priority budget check (before `PipelineBudgetManager`).
 * Call `reset()` between pipeline runs or in tests for
 * isolation.
 *
 * **Cap 0 means unlimited:** A `capSeconds` value of `0` passed to `checkBudget`
 * disables all wall-clock enforcement and always returns `{ allowed: true }`.
 */
export class SessionBudgetManager {
  private startTime: number

  constructor() {
    this.startTime = Date.now()
  }

  /**
   * Return the number of milliseconds elapsed since this manager was constructed
   * (or since the last `reset()` call). Always returns a non-negative number.
   */
  getElapsedMs(): number {
    return Date.now() - this.startTime
  }

  /**
   * Reset the session start timestamp to the current time. Subsequent calls to
   * `getElapsedMs()` will measure from this new baseline. Useful for test
   * isolation and future pipeline reuse scenarios.
   */
  reset(): void {
    this.startTime = Date.now()
  }

  /**
   * Determine whether the pipeline session may dispatch the next node, delegating
   * to `checkSessionBudget` with the current elapsed time converted from seconds
   * to milliseconds.
   *
   * @param capSeconds - Maximum allowed elapsed time in **seconds** (as stored in
   *                     `FactoryConfig.wall_clock_cap_seconds`). A value of `0`
   *                     disables enforcement.
   */
  checkBudget(capSeconds: number): BudgetCheckResult {
    return checkSessionBudget(this.getElapsedMs(), capSeconds * 1000)
  }
}
