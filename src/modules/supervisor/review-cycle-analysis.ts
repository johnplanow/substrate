/**
 * Review Cycle Analysis — SDLC-specific analysis of review cycles.
 *
 * This function is SDLC-specific (story-phase semantics) and must NOT be
 * migrated to @substrate-ai/core. It remains in the monolith.
 *
 * ReviewCycleFinding and ReviewCycleAnalysis are defined here (not imported
 * from @substrate-ai/core) because they are SDLC-specific types. They are
 * structurally compatible with the internal types in core's analysis.ts.
 */

import type { StoryMetricsRow } from '../../persistence/queries/metrics.js'

// ---------------------------------------------------------------------------
// SDLC-specific types (defined locally, not from @substrate-ai/core)
// ---------------------------------------------------------------------------

export interface ReviewCycleFinding {
  story_key: string
  phase: string
  review_cycles: number
  /** Issue patterns extracted from available metadata (may be empty). */
  issue_patterns: string[]
}

export interface ReviewCycleAnalysis {
  /** Stories that required more than 2 review cycles. */
  high_cycle_stories: ReviewCycleFinding[]
  /** Average review cycles across all stories in the current run. */
  avg_cycles: number
  /** Average review cycles in the baseline run (null if no baseline). */
  avg_cycles_baseline: number | null
  /** Percentage change in avg_cycles vs baseline (null if no baseline). */
  delta_pct: number | null
}

// ---------------------------------------------------------------------------
// analyzeReviewCycles
// ---------------------------------------------------------------------------

/**
 * Analyse review cycles across all stories, identifying those that required
 * more than 2 cycles, and computing average cycles vs baseline.
 */
export function analyzeReviewCycles(
  stories: StoryMetricsRow[],
  baselineStories: StoryMetricsRow[],
): ReviewCycleAnalysis {
  const highCycleStories: ReviewCycleFinding[] = []

  for (const story of stories) {
    const cycles = story.review_cycles ?? 0
    if (cycles > 2) {
      highCycleStories.push({
        story_key: story.story_key,
        phase: 'code-review',
        review_cycles: cycles,
        issue_patterns: [],
      })
    }
  }

  highCycleStories.sort((a, b) => b.review_cycles - a.review_cycles)

  const avg_cycles = _computeAvg(stories.map(s => s.review_cycles ?? 0))
  const avg_cycles_baseline =
    baselineStories.length > 0
      ? _computeAvg(baselineStories.map(s => s.review_cycles ?? 0))
      : null

  const delta_pct =
    avg_cycles_baseline !== null && avg_cycles_baseline > 0
      ? Math.round(((avg_cycles - avg_cycles_baseline) / avg_cycles_baseline) * 100 * 10) / 10
      : null

  return {
    high_cycle_stories: highCycleStories,
    avg_cycles,
    avg_cycles_baseline,
    delta_pct,
  }
}

function _computeAvg(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}
