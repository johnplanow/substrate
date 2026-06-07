/**
 * grader.mjs — Pack-upgrade five-axis grader (Stories 81-3 + 81-10).
 *
 * Pure top-level grader: consumes per-case envelope pairs produced by the
 * 81-2 harness and produces a PackUpgradeGradeResult with five quality axes:
 *
 *   1. Code quality (reconstruction Δ) — 77-9 deterministic signal + gray-band judge
 *   2. Cost (turn count + tokens) — relative Δ against current pack mean
 *   3. Verdict distribution — TV distance between per-pack verdict distributions
 *   4. Recovery taxonomy — TV distance between per-pack recovery-strategy distributions
 *   5. Work quality (test-presence) — detects quality regressions invisible to file-set
 *      metrics (e.g. TDD-removal: candidate drops test files) (Story 81-10)
 *
 * PURE: no I/O, no async file reads, no live model calls.
 * The injectable `judgeFn` (options.judgeFn) is the sole non-pure dependency;
 * when absent, gray-band pairs fall back to the deterministic score.
 *
 * Ground-truth resolution (AC8): the caller (Story 81-4's CLI) reads ground
 * truths and adds `ground_truth_diff` to each pair before invoking gradeAll.
 *
 * Output shape: see AC7 / PackUpgradeGradeResult in the return of gradeAll.
 * Note: gradeAll returns a Promise with `work_quality` attached as an own
 * property so Object.keys(gradeAll(pairs)) includes 'work_quality' without
 * awaiting. Callers using `await gradeAll(pairs)` receive the full result.
 */

import {
  gradeCodeQualityAxis,
  gradeCostAxis,
  gradeVerdictAxis,
  gradeRecoveryAxis,
  gradeWorkQualityAxis,
  aggregateOverallVerdict,
  DEFAULT_GRAY_BAND,
  DEFAULT_THRESHOLDS,
  DEFAULT_VERDICT_LADDER,
} from './grader-lib.mjs'

// ---------------------------------------------------------------------------
// gradeAll (AC1, AC7, AC9) — five axes (Story 81-10 adds work_quality)
// ---------------------------------------------------------------------------

/**
 * Grade a corpus of pack-upgrade pair envelopes across five axes and produce
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
 *   - thresholds: per-axis threshold config (AC6); may include workQuality { warn, fail }
 *   - grayBand: { lo, hi } for code-quality judge trigger (AC2)
 *   - judgeFn: injectable LLM pairwise judge for code-quality axis
 *       signature: judgeFn(currentDiff, candidateDiff, groundTruthDiff)
 *                → { winner: 'current'|'candidate'|'tie', confidence: number }
 *   - verdictLadder: verdict ordering array (defaults to BMad ladder, AC4)
 *
 * @returns {Promise<PackUpgradeGradeResult>} (AC7)
 *   The returned Promise also has `work_quality` attached as an own property
 *   so `Object.keys(gradeAll(pairs))` finds it without awaiting (Story 81-10 probe).
 */
export function gradeAll(pairs, options = {}) {
  const normalizedPairs = pairs ?? []

  // Merge provided thresholds with defaults (per-axis fallback handled inside each axis grader)
  const opts = {
    grayBand: options.grayBand ?? DEFAULT_GRAY_BAND,
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      ...(options.thresholds ?? {}),
    },
    judgeFn: options.judgeFn,
    /** judgeAlways: invoke judge for all pairs regardless of gray band (Story 81-11 AC1). */
    judgeAlways: options.judgeAlways ?? false,
    verdictLadder: options.verdictLadder ?? DEFAULT_VERDICT_LADDER,
  }

  // Compute work_quality synchronously — it is a cheap deterministic signal
  // that does not require the async judgeFn path.
  // This also makes it immediately available on the returned Promise object
  // (probe: Object.keys(gradeAll(pairs)) must include 'work_quality').
  const workQuality = gradeWorkQualityAxis(normalizedPairs, opts)

  // Kick off the async computation (code quality may invoke judgeFn).
  const promise = _gradeAllAsync(normalizedPairs, opts, workQuality)

  // Attach work_quality as an own enumerable property on the Promise so that
  // callers that do NOT await still see it via Object.keys().
  promise.work_quality = workQuality

  return promise
}

/**
 * Internal async computation for gradeAll.
 * @private
 */
async function _gradeAllAsync(normalizedPairs, opts, workQuality) {
  // Run four async-capable axes (code quality may invoke judgeFn)
  const [codeQuality, cost, verdictAxis, recovery] = await Promise.all([
    gradeCodeQualityAxis(normalizedPairs, opts),
    Promise.resolve(gradeCostAxis(normalizedPairs, opts)),
    Promise.resolve(gradeVerdictAxis(normalizedPairs, opts)),
    Promise.resolve(gradeRecoveryAxis(normalizedPairs, opts)),
  ])

  // Overall verdict: worst-axis-wins across all five axes (AC6)
  const overallVerdict = aggregateOverallVerdict([
    codeQuality.verdict,
    cost.verdict,
    verdictAxis.verdict,
    recovery.verdict,
    workQuality.verdict,
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
    work_quality: workQuality,
    thresholds_used: opts.thresholds,
    pair_count: normalizedPairs.length,
    pair_outcomes: pairOutcomes,
  }
}
