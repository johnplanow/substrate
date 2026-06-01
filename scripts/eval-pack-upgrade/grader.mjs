/**
 * grader.mjs — Pack-upgrade four-axis grader (Story 81-3).
 *
 * Pure top-level grader: consumes per-case envelope pairs produced by the
 * 81-2 harness and produces a PackUpgradeGradeResult with four quality axes:
 *
 *   1. Code quality (reconstruction Δ) — 77-9 deterministic signal + gray-band judge
 *   2. Cost (turn count + tokens) — relative Δ against current pack mean
 *   3. Verdict distribution — TV distance between per-pack verdict distributions
 *   4. Recovery taxonomy — TV distance between per-pack recovery-strategy distributions
 *
 * PURE: no I/O, no async file reads, no live model calls.
 * The injectable `judgeFn` (options.judgeFn) is the sole non-pure dependency;
 * when absent, gray-band pairs fall back to the deterministic score.
 *
 * Ground-truth resolution (AC8): the caller (Story 81-4's CLI) reads ground
 * truths and adds `ground_truth_diff` to each pair before invoking gradeAll.
 *
 * Output shape: see AC7 / PackUpgradeGradeResult in the return of gradeAll.
 */

import {
  gradeCodeQualityAxis,
  gradeCostAxis,
  gradeVerdictAxis,
  gradeRecoveryAxis,
  aggregateOverallVerdict,
  DEFAULT_GRAY_BAND,
  DEFAULT_THRESHOLDS,
  DEFAULT_VERDICT_LADDER,
} from './grader-lib.mjs'

// ---------------------------------------------------------------------------
// gradeAll (AC1, AC7, AC9)
// ---------------------------------------------------------------------------

/**
 * Grade a corpus of pack-upgrade pair envelopes across four axes and produce
 * a PackUpgradeGradeResult.
 *
 * @param {object[]} pairs
 *   Array of per-case envelope pairs produced by the 81-2 harness.
 *   Each pair has: `{ current, candidate, ground_truth_diff? }`.
 *   `current` and `candidate` each have: `dispatch_outcome`, `diff`,
 *   `total_turns`, `total_tokens`, `verdict`, `recovery_history`.
 *   `ground_truth_diff` is added by the 81-4 caller (AC8).
 *
 * @param {object} [options]
 *   Configuration object (AC9):
 *   - thresholds: per-axis threshold config (AC6)
 *   - grayBand: { lo, hi } for code-quality judge trigger (AC2)
 *   - judgeFn: injectable LLM pairwise judge for code-quality axis
 *       signature: judgeFn(currentDiff, candidateDiff, groundTruthDiff)
 *                → { winner: 'current'|'candidate'|'tie', confidence: number }
 *   - verdictLadder: verdict ordering array (defaults to BMad ladder, AC4)
 *
 * @returns {Promise<PackUpgradeGradeResult>} (AC7)
 */
export async function gradeAll(pairs, options = {}) {
  const normalizedPairs = pairs ?? []

  // Merge provided thresholds with defaults (per-axis fallback handled inside each axis grader)
  const opts = {
    grayBand: options.grayBand ?? DEFAULT_GRAY_BAND,
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      ...(options.thresholds ?? {}),
    },
    judgeFn: options.judgeFn,
    verdictLadder: options.verdictLadder ?? DEFAULT_VERDICT_LADDER,
  }

  // Run four axes
  const [codeQuality, cost, verdictAxis, recovery] = await Promise.all([
    gradeCodeQualityAxis(normalizedPairs, opts),
    Promise.resolve(gradeCostAxis(normalizedPairs, opts)),
    Promise.resolve(gradeVerdictAxis(normalizedPairs, opts)),
    Promise.resolve(gradeRecoveryAxis(normalizedPairs, opts)),
  ])

  // Overall verdict: worst-axis-wins (AC6)
  const overallVerdict = aggregateOverallVerdict([
    codeQuality.verdict,
    cost.verdict,
    verdictAxis.verdict,
    recovery.verdict,
  ])

  // Summarize pair completion outcomes
  const pairOutcomes = {
    'both-completed': 0,
    'one-completed': 0,
    'both-incomplete': 0,
  }
  for (const pair of normalizedPairs) {
    const currentCompleted = pair?.current?.dispatch_outcome === 'completed'
    const candidateCompleted = pair?.candidate?.dispatch_outcome === 'completed'
    if (currentCompleted && candidateCompleted) {
      pairOutcomes['both-completed']++
    } else if (currentCompleted || candidateCompleted) {
      pairOutcomes['one-completed']++
    } else {
      pairOutcomes['both-incomplete']++
    }
  }

  return {
    overall_verdict: overallVerdict,
    axes: {
      code_quality: codeQuality,
      cost,
      verdict: verdictAxis,
      recovery,
    },
    thresholds_used: opts.thresholds,
    pair_count: normalizedPairs.length,
    pair_outcomes: pairOutcomes,
  }
}
