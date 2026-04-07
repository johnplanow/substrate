/**
 * CostGovernanceChecker — Story 53-3.
 *
 * Pure class (no I/O, no side effects) that computes cumulative run cost
 * from the run manifest and checks it against a configured ceiling.
 *
 * All I/O (reading the manifest, emitting events) stays in orchestrator-impl.ts.
 */

import type { RunManifestData } from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// CeilingCheckResult
// ---------------------------------------------------------------------------

/**
 * Result of a cost ceiling check.
 */
export interface CeilingCheckResult {
  /** 'ok' = < 80%, 'warning' = ≥ 80% and < 100%, 'exceeded' = ≥ 100% */
  status: 'ok' | 'warning' | 'exceeded'
  /** Sum of all per-story cost_usd values plus run_total retry cost */
  cumulative: number
  /** The ceiling value passed to checkCeiling */
  ceiling: number
  /** (cumulative / ceiling) * 100, rounded to two decimal places */
  percentUsed: number
  /** Estimated cost of the next story (average of completed stories) */
  estimatedNext: number
}

// ---------------------------------------------------------------------------
// CostGovernanceChecker
// ---------------------------------------------------------------------------

/**
 * Pure checker for run-level cost governance.
 *
 * Instantiate with `new CostGovernanceChecker()` — no constructor arguments.
 * All methods are stateless; results depend only on the manifest data passed in.
 */
export class CostGovernanceChecker {
  /**
   * Compute cumulative run cost from the manifest.
   *
   * Sums `per_story_state[key].cost_usd ?? 0` for all story keys, then adds
   * `manifest.cost_accumulation.run_total` (retry cost).
   */
  computeCumulativeCost(manifest: RunManifestData): number {
    const dispatchCost = Object.values(manifest.per_story_state).reduce(
      (sum, s) => sum + (s.cost_usd ?? 0),
      0,
    )
    return dispatchCost + manifest.cost_accumulation.run_total
  }

  /**
   * Estimate the cost of the next story.
   *
   * Returns the average `cost_usd` of stories that have a non-zero `cost_usd`.
   * Returns `0` if no completed stories with a cost exist.
   */
  estimateNextStoryCost(manifest: RunManifestData): number {
    const completed = Object.values(manifest.per_story_state)
      .map((s) => s.cost_usd)
      .filter((c): c is number => c !== undefined && c > 0)
    if (completed.length === 0) return 0
    return completed.reduce((s, c) => s + c, 0) / completed.length
  }

  /**
   * Check the cumulative run cost against the provided ceiling.
   *
   * @param manifest - Current run manifest data
   * @param ceiling - Cost ceiling in USD (must be > 0)
   * @returns CeilingCheckResult with status, cumulative, ceiling, percentUsed, estimatedNext
   */
  checkCeiling(manifest: RunManifestData, ceiling: number): CeilingCheckResult {
    const cumulative = this.computeCumulativeCost(manifest)
    const estimatedNext = this.estimateNextStoryCost(manifest)
    const percentUsed = Math.round((cumulative / ceiling) * 10000) / 100
    const status: CeilingCheckResult['status'] =
      percentUsed >= 100 ? 'exceeded' : percentUsed >= 80 ? 'warning' : 'ok'
    return { status, cumulative, ceiling, percentUsed, estimatedNext }
  }
}
