/**
 * SatisfactionScorer — computes a satisfaction score from ScenarioRunResult.
 *
 * Supports both unweighted (computeSatisfactionScore) and weighted
 * (createSatisfactionScorer) scoring modes with per-scenario breakdown.
 *
 * Stories 44-5, 46-1 (Epic 46 — Satisfaction Scoring).
 */

import type { ScenarioRunResult } from '../events.js'
// Re-export for test and consumer convenience (story 46-8 integration test imports this from scorer)
export type { ScenarioRunResult } from '../events.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-scenario contribution detail in a SatisfactionScore.
 */
export interface ScenarioScoreDetail {
  /** Scenario file name (e.g., 'scenario-login.sh') */
  name: string
  /** Whether this scenario passed (exit code 0) */
  passed: boolean
  /** Weight assigned to this scenario (default 1.0) */
  weight: number
  /**
   * Normalised contribution: weight * (passed ? 1 : 0) / totalWeight.
   * Sum of all contributions equals the overall score.
   */
  contribution: number
}

/** Maps scenario name to its weight multiplier. Default weight is 1.0. */
export type ScenarioWeights = Record<string, number>

/**
 * Satisfaction score computed from a ScenarioRunResult.
 */
export interface SatisfactionScore {
  /** Ratio of weighted-passing scenarios: 0.0 when total weight is 0. */
  score: number
  /** Whether score meets or exceeds the threshold. */
  passes: boolean
  /** The threshold used for the passes comparison. */
  threshold: number
  /** Per-scenario score detail. Empty array when no scenarios ran. */
  breakdown: ScenarioScoreDetail[]
}

// ---------------------------------------------------------------------------
// SatisfactionScorer interface and factory
// ---------------------------------------------------------------------------

export interface SatisfactionScorer {
  /**
   * Compute a weighted satisfaction score from a ScenarioRunResult.
   *
   * @param results  - The aggregated scenario run result.
   * @param weights  - Optional per-scenario weight map. Missing entries default to 1.0.
   * @returns A SatisfactionScore with weighted score, passes, threshold, and breakdown.
   */
  compute(results: ScenarioRunResult, weights?: ScenarioWeights): SatisfactionScore
}

/**
 * Create a SatisfactionScorer that computes weighted average scores.
 *
 * @param threshold - Minimum score to consider passing (default 0.8).
 */
export function createSatisfactionScorer(threshold = 0.8): SatisfactionScorer {
  return {
    compute(results: ScenarioRunResult, weights?: ScenarioWeights): SatisfactionScore {
      const scenarios = results.scenarios
      if (scenarios.length === 0) {
        return { score: 0, passes: false, threshold, breakdown: [] }
      }

      // Resolve weights and compute totalWeight in a single pass
      const resolved = scenarios.map(s => ({
        scenario: s,
        weight: (weights?.[s.name] ?? 1.0) as number,
      }))
      const totalWeight = resolved.reduce((sum, r) => sum + r.weight, 0)

      if (totalWeight === 0) {
        return { score: 0, passes: false, threshold, breakdown: [] }
      }

      // Build breakdown and compute score
      const breakdown: ScenarioScoreDetail[] = resolved.map(r => {
        const passed = r.scenario.status === 'pass'
        const contribution = r.weight * (passed ? 1 : 0) / totalWeight
        return { name: r.scenario.name, passed, weight: r.weight, contribution }
      })

      const score = breakdown.reduce((sum, d) => sum + d.contribution, 0)

      return { score, passes: score >= threshold, threshold, breakdown }
    },
  }
}

// ---------------------------------------------------------------------------
// Public API (backward-compatible)
// ---------------------------------------------------------------------------

/**
 * Compute a satisfaction score from a ScenarioRunResult.
 *
 * All scenarios are weighted equally (weight 1.0). The result includes a
 * `breakdown` array with one entry per scenario (added in Epic 46, story 46-1).
 *
 * @param result    - The aggregated scenario run result.
 * @param threshold - Minimum score to consider passing (default 0.8).
 * @returns A SatisfactionScore with score, passes, threshold, and breakdown.
 */
export function computeSatisfactionScore(
  result: ScenarioRunResult,
  threshold = 0.8,
): SatisfactionScore {
  const scenarios = result.scenarios
  const totalWeight = scenarios.length

  const breakdown: ScenarioScoreDetail[] = scenarios.map(s => {
    const passed = s.status === 'pass'
    const contribution = totalWeight > 0 ? (passed ? 1.0 / totalWeight : 0) : 0
    return { name: s.name, passed, weight: 1.0, contribution }
  })

  const { total, passed } = result.summary
  const score = total === 0 ? 0 : passed / total
  return { score, passes: score >= threshold, threshold, breakdown }
}
