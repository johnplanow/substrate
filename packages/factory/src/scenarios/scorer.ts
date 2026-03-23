/**
 * SatisfactionScorer — computes a satisfaction score from ScenarioRunResult.
 *
 * Score = passed / total (0.0 when total === 0).
 * Passes = score >= threshold (default 0.8).
 *
 * Story 44-5.
 */

import type { ScenarioRunResult } from '../events.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Satisfaction score computed from a ScenarioRunResult.
 */
export interface SatisfactionScore {
  /** Ratio of passing scenarios: passed / total. 0.0 when total is 0. */
  score: number
  /** Whether score meets or exceeds the threshold. */
  passes: boolean
  /** The threshold used for the passes comparison. */
  threshold: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a satisfaction score from a ScenarioRunResult.
 *
 * @param result    - The aggregated scenario run result.
 * @param threshold - Minimum score to consider passing (default 0.8).
 * @returns A SatisfactionScore with score, passes, and threshold.
 */
export function computeSatisfactionScore(
  result: ScenarioRunResult,
  threshold = 0.8,
): SatisfactionScore {
  const { total, passed } = result.summary
  const score = total === 0 ? 0 : passed / total
  return { score, passes: score >= threshold, threshold }
}
