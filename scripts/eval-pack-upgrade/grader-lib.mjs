/**
 * grader-lib.mjs — Pure helper functions for the pack-upgrade grader (Story 81-3).
 *
 * All functions are pure: no I/O, no async file reads, no live model calls.
 * The injectable `judgeFn` (in gradeCodeQualityAxis) is the sole external
 * dependency, and it is called only in the gray-band case (AC2 cost-bounding).
 *
 * Verdict ladder coupling note (AC4, Epic 81 Design Principle 7):
 *   The default verdict ladder ['SHIP_IT', 'LGTM_WITH_NOTES', 'NEEDS_MINOR_FIXES',
 *   'NEEDS_MAJOR_REWORK'] is BMad-specific. Changing the ladder is a
 *   methodology-substitution concern, not a pack-upgrade concern; that work is
 *   explicitly out of scope for Epic 81. Use `options.verdictLadder` to substitute.
 *
 * TV distance rationale (Dev Notes):
 *   TV distance = 0.5 × Σ|p(x) - q(x)| over the union of classes.
 *   Bounded in [0, 1], symmetric, interpretable (0.10 TV = at most 10pp shift
 *   in any single category). Preferred over KL divergence (asymmetric, undefined
 *   when one distribution has zero) or chi-squared (sensitive to small denominators).
 */

import { deterministicSignal, isGrayBand } from '../eval-reconstruction/grader.mjs'

// ---------------------------------------------------------------------------
// Defaults (exported for grader.mjs and tests)
// ---------------------------------------------------------------------------

/** Default gray band for code-quality judge trigger (AC2, AC9). Uses lo/hi per story spec. */
export const DEFAULT_GRAY_BAND = { lo: 0.4, hi: 0.8 }

/**
 * Default verdict ladder — BMad vocabulary in descending quality order.
 * Index 0 = best (SHIP_IT), last index = worst (NEEDS_MAJOR_REWORK).
 * Configurable via options.verdictLadder (AC9).
 */
export const DEFAULT_VERDICT_LADDER = [
  'SHIP_IT',
  'LGTM_WITH_NOTES',
  'NEEDS_MINOR_FIXES',
  'NEEDS_MAJOR_REWORK',
]

/** Default per-axis thresholds (AC6). */
export const DEFAULT_THRESHOLDS = {
  codeQuality: { warn: 0.05, fail: 0.15 },
  cost: { warnTurns: 0.10, failTurns: 0.25, warnTokens: 0.15, failTokens: 0.30 },
  verdict: { warnTV: 0.10, failTV: 0.20 },
  recovery: { warnTV: 0.10, failTV: 0.20 },
}

// ---------------------------------------------------------------------------
// totalVariationDistance (AC10)
// ---------------------------------------------------------------------------

/**
 * Total-variation distance between two discrete distributions represented as
 * `{ [class]: count }` objects.
 *
 * TV distance = 0.5 × Σ|p_a(class) - p_b(class)| over the union of classes.
 * Normalizes counts to probabilities before computing. Empty distributions on
 * both sides → 0 (no disagreement). Empty on one side → full mass on the other.
 *
 * @param {Record<string, number>} distributionA
 * @param {Record<string, number>} distributionB
 * @returns {number} TV distance in [0, 1]
 */
export function totalVariationDistance(distributionA, distributionB) {
  const allClasses = new Set([
    ...Object.keys(distributionA ?? {}),
    ...Object.keys(distributionB ?? {}),
  ])

  const totalA = Object.values(distributionA ?? {}).reduce((s, v) => s + v, 0)
  const totalB = Object.values(distributionB ?? {}).reduce((s, v) => s + v, 0)

  if (totalA === 0 && totalB === 0) return 0

  let sum = 0
  for (const cls of allClasses) {
    const pA = totalA === 0 ? 0 : ((distributionA ?? {})[cls] ?? 0) / totalA
    const pB = totalB === 0 ? 0 : ((distributionB ?? {})[cls] ?? 0) / totalB
    sum += Math.abs(pA - pB)
  }
  return 0.5 * sum
}

// ---------------------------------------------------------------------------
// verdictLadderPosition (AC10)
// ---------------------------------------------------------------------------

/**
 * Return the position (0-indexed) of a verdict in the configured ladder.
 * Returns -1 for unknown/unrecognized verdicts (→ 'other' bucket in AC4).
 *
 * @param {string} verdict
 * @param {string[]} [ladder=DEFAULT_VERDICT_LADDER]
 * @returns {number}
 */
export function verdictLadderPosition(verdict, ladder = DEFAULT_VERDICT_LADDER) {
  if (!verdict || !Array.isArray(ladder)) return -1
  return ladder.indexOf(verdict)
}

// ---------------------------------------------------------------------------
// computeAxisVerdict (AC10, AC6)
// ---------------------------------------------------------------------------

/**
 * Translate axis-specific metrics into a GREEN/YELLOW/RED verdict using the
 * axis's configured thresholds.
 *
 * Dispatches on the shape of `metrics`:
 *   - `{ meanDelta }` + `{ warn, fail }` → code-quality axis
 *   - `{ tvDistance }` + `{ warnTV, failTV }` → verdict or recovery axis
 *   - `{ relDeltaTurns, relDeltaInputTokens, relDeltaOutputTokens }` + cost thresholds → cost axis
 *
 * Per AC6: GREEN if all thresholds clear; YELLOW if warn-threshold crossed;
 * RED if fail-threshold crossed.
 *
 * @param {object} metrics  axis-specific metrics object
 * @param {object} thresholds  axis-specific threshold object
 * @returns {'GREEN'|'YELLOW'|'RED'}
 */
export function computeAxisVerdict(metrics, thresholds) {
  const m = metrics ?? {}
  const t = thresholds ?? {}

  // Code quality axis: meanDelta (negative = regression) + { warn, fail }
  if ('meanDelta' in m) {
    const regression = -(m.meanDelta) // positive regression magnitude
    if (regression >= (t.fail ?? Infinity)) return 'RED'
    if (regression >= (t.warn ?? Infinity)) return 'YELLOW'
    return 'GREEN'
  }

  // TV distance axis (verdict or recovery): { tvDistance } + { warnTV, failTV }
  if ('tvDistance' in m) {
    if (m.tvDistance >= (t.failTV ?? Infinity)) return 'RED'
    if (m.tvDistance >= (t.warnTV ?? Infinity)) return 'YELLOW'
    return 'GREEN'
  }

  // Cost axis: relative deltas per dimension + { warnTurns, failTurns, warnTokens, failTokens }
  if ('relDeltaTurns' in m) {
    const { relDeltaTurns = 0, relDeltaInputTokens = 0, relDeltaOutputTokens = 0 } = m
    const { warnTurns = Infinity, failTurns = Infinity, warnTokens = Infinity, failTokens = Infinity } = t
    if (
      relDeltaTurns >= failTurns ||
      relDeltaInputTokens >= failTokens ||
      relDeltaOutputTokens >= failTokens
    ) return 'RED'
    if (
      relDeltaTurns >= warnTurns ||
      relDeltaInputTokens >= warnTokens ||
      relDeltaOutputTokens >= warnTokens
    ) return 'YELLOW'
    return 'GREEN'
  }

  return 'GREEN'
}

// ---------------------------------------------------------------------------
// aggregateOverallVerdict (AC10)
// ---------------------------------------------------------------------------

/**
 * Aggregate per-axis verdicts into the overall verdict using worst-axis-wins.
 * RED > YELLOW > GREEN.
 *
 * @param {Array<'GREEN'|'YELLOW'|'RED'>} axisVerdicts
 * @returns {'GREEN'|'YELLOW'|'RED'}
 */
export function aggregateOverallVerdict(axisVerdicts) {
  if ((axisVerdicts ?? []).includes('RED')) return 'RED'
  if ((axisVerdicts ?? []).includes('YELLOW')) return 'YELLOW'
  return 'GREEN'
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the 95th percentile of a numeric array (sorted ascending).
 * Returns 0 for empty arrays.
 */
function percentile95(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.ceil(0.95 * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

/**
 * Compute the median of a numeric array.
 * Returns 0 for empty arrays.
 */
function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/**
 * True if a side has full cost telemetry (total_turns + total_tokens).
 * DO NOT zero-fill absent telemetry — absence ≠ zero (AC3).
 */
function hasCostTelemetry(side) {
  return (
    side != null &&
    side.total_turns != null &&
    side.total_tokens != null &&
    side.total_tokens.input != null &&
    side.total_tokens.output != null
  )
}

// ---------------------------------------------------------------------------
// gradeCodeQualityAxis (AC2, AC10)
// ---------------------------------------------------------------------------

/**
 * Grade the code-quality axis for a set of pair envelopes.
 *
 * For each pair where BOTH sides completed:
 *   - Compute currentScore and candidateScore via deterministicSignal from 77-9.
 *   - Per-pair Δ = candidateScore - currentScore (positive = candidate better).
 *   - If min(currentScore, candidateScore) is in the gray band AND judgeFn is
 *     provided, invoke the judge to confirm the relative ranking.
 *   - Pairs where one or both sides did NOT complete are excluded (AC2, AC3).
 *
 * The judge signature (AC9): judgeFn(currentDiff, candidateDiff, groundTruthDiff)
 *   → { winner: 'current'|'candidate'|'tie', confidence: number }
 *
 * @param {object[]} pairs  per-pair envelopes (with ground_truth_diff added by 81-4)
 * @param {object} [options]
 * @param {object} [options.grayBand]  { lo, hi } gray-band bounds (AC9)
 * @param {object} [options.thresholds]  axis thresholds (AC6)
 * @param {Function} [options.judgeFn]  injectable LLM pairwise judge (AC9)
 * @returns {Promise<object>} axis result
 */
export async function gradeCodeQualityAxis(pairs, options = {}) {
  const grayBand = options.grayBand ?? DEFAULT_GRAY_BAND
  const thresholds = options.thresholds?.codeQuality ?? DEFAULT_THRESHOLDS.codeQuality
  const judgeFn = options.judgeFn

  // isGrayBand from the reconstruction grader uses { low, high }; options uses { lo, hi }
  const band = { low: grayBand.lo, high: grayBand.hi }

  const perPair = []
  const deltas = []
  let ungradableCount = 0

  for (const pair of pairs ?? []) {
    const { current, candidate, ground_truth_diff } = pair ?? {}

    // Both sides must have completed (AC2)
    if (current?.dispatch_outcome !== 'completed' || candidate?.dispatch_outcome !== 'completed') {
      perPair.push({ gradable: false, reason: 'not-both-completed' })
      ungradableCount++
      continue
    }

    // Compute deterministic signals using the 77-9 helper
    const currentSig = deterministicSignal(current.diff, ground_truth_diff)
    const candidateSig = deterministicSignal(candidate.diff, ground_truth_diff)
    const currentScore = currentSig.detScore
    const candidateScore = candidateSig.detScore

    let delta = candidateScore - currentScore
    let judgeInvoked = false
    let judgeResult = null

    // Gray-band check: invoke judge when min score is in the ambiguous band (AC2)
    const minScore = Math.min(currentScore, candidateScore)
    if (isGrayBand(minScore, band) && typeof judgeFn === 'function') {
      judgeInvoked = true
      judgeResult = await judgeFn(current.diff, candidate.diff, ground_truth_diff)
      // Use judge's winner to confirm/adjust delta direction
      if (judgeResult?.winner === 'candidate') {
        delta = Math.abs(delta)
      } else if (judgeResult?.winner === 'current') {
        delta = -Math.abs(delta)
      } else if (judgeResult?.winner === 'tie') {
        delta = 0
      }
      // If judge winner is absent or unrecognized, keep the deterministic delta
    }

    deltas.push(delta)
    perPair.push({
      gradable: true,
      current_score: currentScore,
      candidate_score: candidateScore,
      delta,
      judge_invoked: judgeInvoked,
      ...(judgeInvoked ? { judge_result: judgeResult } : {}),
    })
  }

  const gradableCount = deltas.length
  const meanDelta = gradableCount === 0
    ? 0
    : deltas.reduce((s, d) => s + d, 0) / gradableCount
  const medianDelta = median(deltas)
  const regressionCount = deltas.filter((d) => d < 0).length
  const improvementCount = deltas.filter((d) => d > 0).length

  const verdict = computeAxisVerdict({ meanDelta }, thresholds)

  return {
    verdict,
    mean_delta: meanDelta,
    median_delta: medianDelta,
    regression_count: regressionCount,
    improvement_count: improvementCount,
    ungradable_count: ungradableCount,
    per_pair: perPair,
  }
}

// ---------------------------------------------------------------------------
// gradeCostAxis (AC3, AC10)
// ---------------------------------------------------------------------------

/**
 * Grade the cost axis (turn count + tokens) for a set of pair envelopes.
 *
 * For each pair where BOTH sides have full cost telemetry:
 *   - Per-pair Δ turns, Δ input tokens, Δ output tokens.
 *   - Corpus-aggregate: mean and p95 of each.
 *   - Verdict uses relative thresholds (Δ / current_mean) per AC6.
 *   - Pairs missing telemetry are EXCLUDED (AC3 — absence ≠ zero).
 *
 * @param {object[]} pairs
 * @param {object} [options]
 * @returns {object} axis result
 */
export function gradeCostAxis(pairs, options = {}) {
  const thresholds = options.thresholds?.cost ?? DEFAULT_THRESHOLDS.cost

  const perPair = []
  const deltaTurns = []
  const deltaInputTokens = []
  const deltaOutputTokens = []
  const currentTurnsArr = []
  const currentInputArr = []
  const currentOutputArr = []
  let ungradableCount = 0

  for (const pair of pairs ?? []) {
    const { current, candidate } = pair ?? {}

    if (!hasCostTelemetry(current) || !hasCostTelemetry(candidate)) {
      perPair.push({ gradable: false, reason: 'missing-telemetry' })
      ungradableCount++
      continue
    }

    const dTurns = candidate.total_turns - current.total_turns
    const dInput = candidate.total_tokens.input - current.total_tokens.input
    const dOutput = candidate.total_tokens.output - current.total_tokens.output

    deltaTurns.push(dTurns)
    deltaInputTokens.push(dInput)
    deltaOutputTokens.push(dOutput)
    currentTurnsArr.push(current.total_turns)
    currentInputArr.push(current.total_tokens.input)
    currentOutputArr.push(current.total_tokens.output)

    perPair.push({
      gradable: true,
      delta_turns: dTurns,
      delta_input_tokens: dInput,
      delta_output_tokens: dOutput,
    })
  }

  const n = deltaTurns.length

  if (n === 0) {
    return {
      verdict: 'GREEN',
      mean_delta_turns: 0,
      mean_delta_input_tokens: 0,
      mean_delta_output_tokens: 0,
      p95s: { turns: 0, input_tokens: 0, output_tokens: 0 },
      ungradable_count: ungradableCount,
      per_pair: perPair,
    }
  }

  const meanDeltaTurns = deltaTurns.reduce((s, v) => s + v, 0) / n
  const meanDeltaInputTokens = deltaInputTokens.reduce((s, v) => s + v, 0) / n
  const meanDeltaOutputTokens = deltaOutputTokens.reduce((s, v) => s + v, 0) / n

  // Current-pack means (for computing relative thresholds)
  const currentMeanTurns = currentTurnsArr.reduce((s, v) => s + v, 0) / n
  const currentMeanInput = currentInputArr.reduce((s, v) => s + v, 0) / n
  const currentMeanOutput = currentOutputArr.reduce((s, v) => s + v, 0) / n

  // Relative deltas: Δ / current_mean (AC6)
  const relDeltaTurns = currentMeanTurns > 0 ? meanDeltaTurns / currentMeanTurns : 0
  const relDeltaInputTokens = currentMeanInput > 0 ? meanDeltaInputTokens / currentMeanInput : 0
  const relDeltaOutputTokens = currentMeanOutput > 0 ? meanDeltaOutputTokens / currentMeanOutput : 0

  const verdict = computeAxisVerdict(
    { relDeltaTurns, relDeltaInputTokens, relDeltaOutputTokens },
    thresholds,
  )

  return {
    verdict,
    mean_delta_turns: meanDeltaTurns,
    mean_delta_input_tokens: meanDeltaInputTokens,
    mean_delta_output_tokens: meanDeltaOutputTokens,
    p95s: {
      turns: percentile95(deltaTurns),
      input_tokens: percentile95(deltaInputTokens),
      output_tokens: percentile95(deltaOutputTokens),
    },
    ungradable_count: ungradableCount,
    per_pair: perPair,
  }
}

// ---------------------------------------------------------------------------
// gradeVerdictAxis (AC4, AC10)
// ---------------------------------------------------------------------------

/**
 * Grade the verdict-distribution axis for a set of pair envelopes.
 *
 * For each pair where BOTH sides have a populated verdict:
 *   - Per-pair categorical shift: same | shifted-up | shifted-down | other.
 *   - "Up" = toward SHIP_IT (lower ladder index); "down" = toward NEEDS_MAJOR_REWORK.
 *   - Unknown verdicts go to the "other" bucket.
 *   - Corpus-aggregate: per-verdict distribution + TV distance.
 *   - Pairs missing verdict on either side are EXCLUDED (AC4).
 *
 * @param {object[]} pairs
 * @param {object} [options]
 * @returns {object} axis result
 */
export function gradeVerdictAxis(pairs, options = {}) {
  const thresholds = options.thresholds?.verdict ?? DEFAULT_THRESHOLDS.verdict
  const ladder = options.verdictLadder ?? DEFAULT_VERDICT_LADDER

  const perPair = []
  const currentDist = {}
  const candidateDist = {}
  let ungradableCount = 0

  for (const pair of pairs ?? []) {
    const { current, candidate } = pair ?? {}

    if (current?.verdict == null || candidate?.verdict == null) {
      perPair.push({ gradable: false, reason: 'missing-verdict' })
      ungradableCount++
      continue
    }

    const currentPos = verdictLadderPosition(current.verdict, ladder)
    const candidatePos = verdictLadderPosition(candidate.verdict, ladder)

    let shift
    if (current.verdict === candidate.verdict) {
      shift = 'same'
    } else if (currentPos === -1 || candidatePos === -1) {
      // Unknown verdict on either side → other
      shift = 'other'
    } else if (candidatePos < currentPos) {
      // Smaller ladder index = higher quality (SHIP_IT is index 0 = best)
      shift = 'shifted-up'
    } else {
      shift = 'shifted-down'
    }

    // Accumulate distributions
    currentDist[current.verdict] = (currentDist[current.verdict] ?? 0) + 1
    candidateDist[candidate.verdict] = (candidateDist[candidate.verdict] ?? 0) + 1

    perPair.push({
      gradable: true,
      current_verdict: current.verdict,
      candidate_verdict: candidate.verdict,
      shift,
    })
  }

  const tvDistance = totalVariationDistance(currentDist, candidateDist)
  const verdict = computeAxisVerdict({ tvDistance }, thresholds)

  return {
    verdict,
    current_distribution: currentDist,
    candidate_distribution: candidateDist,
    tv_distance: tvDistance,
    ungradable_count: ungradableCount,
    per_pair: perPair,
  }
}

// ---------------------------------------------------------------------------
// gradeRecoveryAxis (AC5, AC10)
// ---------------------------------------------------------------------------

/**
 * Grade the recovery-taxonomy axis for a set of pair envelopes.
 *
 * For each pair where at least one side has a non-empty recovery_history:
 *   - Extract recovery class names from each side's history using the
 *     `strategy` field of each RecoveryEntry (the recovery strategy vocabulary).
 *   - Per-pair: count actions by class per side.
 *   - Corpus-aggregate: total counts per class per pack + TV distance.
 *   - Pairs with empty recovery_history on BOTH sides are EXCLUDED (AC5 — no signal).
 *
 * @param {object[]} pairs
 * @param {object} [options]
 * @returns {object} axis result
 */
export function gradeRecoveryAxis(pairs, options = {}) {
  const thresholds = options.thresholds?.recovery ?? DEFAULT_THRESHOLDS.recovery

  const perPair = []
  const currentDist = {}
  const candidateDist = {}
  let ungradableCount = 0

  for (const pair of pairs ?? []) {
    const { current, candidate } = pair ?? {}

    const currentHistory = current?.recovery_history ?? []
    const candidateHistory = candidate?.recovery_history ?? []

    // Exclude pairs where both sides have no recovery signal (AC5)
    if (currentHistory.length === 0 && candidateHistory.length === 0) {
      perPair.push({ gradable: false, reason: 'empty-both' })
      ungradableCount++
      continue
    }

    // Count recovery actions by class (strategy field) per side
    const currentCounts = {}
    for (const entry of currentHistory) {
      const cls = entry?.strategy ?? entry?.class ?? 'unknown'
      currentCounts[cls] = (currentCounts[cls] ?? 0) + 1
    }

    const candidateCounts = {}
    for (const entry of candidateHistory) {
      const cls = entry?.strategy ?? entry?.class ?? 'unknown'
      candidateCounts[cls] = (candidateCounts[cls] ?? 0) + 1
    }

    // Accumulate aggregate distributions
    for (const [cls, count] of Object.entries(currentCounts)) {
      currentDist[cls] = (currentDist[cls] ?? 0) + count
    }
    for (const [cls, count] of Object.entries(candidateCounts)) {
      candidateDist[cls] = (candidateDist[cls] ?? 0) + count
    }

    perPair.push({
      gradable: true,
      current_counts: currentCounts,
      candidate_counts: candidateCounts,
    })
  }

  const tvDistance = totalVariationDistance(currentDist, candidateDist)
  const verdict = computeAxisVerdict({ tvDistance }, thresholds)

  return {
    verdict,
    current_distribution: currentDist,
    candidate_distribution: candidateDist,
    tv_distance: tvDistance,
    ungradable_count: ungradableCount,
    per_pair: perPair,
  }
}
