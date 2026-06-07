/**
 * Unit tests for the pack-upgrade grader (Story 81-3).
 *
 * Covers all AC11 scenarios:
 *   - Code-quality axis: better/worse/gray-band/ungradable/both-incomplete
 *   - Cost axis: per-pair Δ, missing telemetry exclusion, mean, p95
 *   - Verdict axis: same/shifted-up/shifted-down/unknown/TV distance
 *   - Recovery axis: empty-both exclusion, class distribution, TV distance
 *   - Per-axis verdict thresholds: GREEN/YELLOW/RED
 *   - Overall verdict aggregation: worst-axis-wins
 *   - gradeAll integration: 3-pair synthetic corpus
 *   - LLM judge mocked throughout (AC12)
 *
 * No I/O, no live model calls, no git ops.
 */

import { describe, it, expect, vi } from 'vitest'

// @ts-expect-error — importing JS modules from TS test (vitest handles cross-load)
import {
  totalVariationDistance,
  verdictLadderPosition,
  computeAxisVerdict,
  aggregateOverallVerdict,
  gradeCodeQualityAxis,
  gradeCostAxis,
  gradeVerdictAxis,
  gradeRecoveryAxis,
  extractFilesFromDiff,
  scorePackDiffAgainstGroundTruth,
  DEFAULT_GRAY_BAND,
  DEFAULT_VERDICT_LADDER,
  DEFAULT_THRESHOLDS,
} from '../grader-lib.mjs'

// @ts-expect-error
import { gradeAll } from '../grader.mjs'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a completed side with the given diff and optional telemetry/verdict/recovery. */
function completedSide(opts: {
  files?: string[]
  tests?: string[]
  totalTurns?: number
  totalTokens?: { input: number; output: number }
  verdict?: string
  recoveryHistory?: Array<{ strategy: string }>
}) {
  return {
    dispatch_outcome: 'completed',
    diff: {
      reconstructed_files: opts.files ?? [],
      passing_tests: opts.tests ?? [],
    },
    total_turns: opts.totalTurns,
    total_tokens: opts.totalTokens,
    verdict: opts.verdict,
    recovery_history: opts.recoveryHistory ?? [],
  }
}

/** Build a pair with an optional ground_truth_diff. */
function makePair(
  current: ReturnType<typeof completedSide>,
  candidate: ReturnType<typeof completedSide>,
  groundTruth?: { reconstructed_files?: string[]; passing_tests?: string[] } | null,
) {
  return {
    current,
    candidate,
    ground_truth_diff: groundTruth ?? {
      changed_files: current.diff?.reconstructed_files ?? [],
      passing_tests: current.diff?.passing_tests ?? [],
    },
  }
}

/** Pair where both sides completed, with matching ground truth for perfect scores. */
function perfectPair() {
  return {
    current: completedSide({ files: ['a.ts'], tests: ['t1'] }),
    candidate: completedSide({ files: ['a.ts', 'b.ts'], tests: ['t1', 't2'] }),
    ground_truth_diff: { changed_files: ['a.ts', 'b.ts'], passing_tests: ['t1', 't2'] },
  }
}

// ---------------------------------------------------------------------------
// totalVariationDistance
// ---------------------------------------------------------------------------

describe('totalVariationDistance', () => {
  it('is 0 for identical distributions', () => {
    expect(totalVariationDistance({ A: 2, B: 1 }, { A: 2, B: 1 })).toBeCloseTo(0, 6)
  })

  it('is 1 for completely disjoint distributions', () => {
    expect(totalVariationDistance({ A: 1 }, { B: 1 })).toBeCloseTo(1, 6)
  })

  it('is 0 for two empty distributions', () => {
    expect(totalVariationDistance({}, {})).toBe(0)
  })

  it('computes the correct TV distance for a known fixture', () => {
    // A: { X: 3, Y: 1 } → p(X)=0.75, p(Y)=0.25
    // B: { X: 1, Y: 3 } → p(X)=0.25, p(Y)=0.75
    // TV = 0.5 * (|0.75-0.25| + |0.25-0.75|) = 0.5 * (0.5 + 0.5) = 0.5
    expect(totalVariationDistance({ X: 3, Y: 1 }, { X: 1, Y: 3 })).toBeCloseTo(0.5, 6)
  })

  it('handles a class present in only one distribution', () => {
    // A: { X: 1 } → p(X)=1
    // B: { X: 1, Y: 1 } → p(X)=0.5, p(Y)=0.5
    // TV = 0.5 * (|1-0.5| + |0-0.5|) = 0.5 * 1 = 0.5
    expect(totalVariationDistance({ X: 1 }, { X: 1, Y: 1 })).toBeCloseTo(0.5, 6)
  })
})

// ---------------------------------------------------------------------------
// verdictLadderPosition
// ---------------------------------------------------------------------------

describe('verdictLadderPosition', () => {
  it('returns 0 for SHIP_IT (best)', () => {
    expect(verdictLadderPosition('SHIP_IT', DEFAULT_VERDICT_LADDER)).toBe(0)
  })

  it('returns 3 for NEEDS_MAJOR_REWORK (worst)', () => {
    expect(verdictLadderPosition('NEEDS_MAJOR_REWORK', DEFAULT_VERDICT_LADDER)).toBe(3)
  })

  it('returns -1 for an unknown verdict', () => {
    expect(verdictLadderPosition('UNKNOWN_CLASS', DEFAULT_VERDICT_LADDER)).toBe(-1)
    expect(verdictLadderPosition('', DEFAULT_VERDICT_LADDER)).toBe(-1)
  })

  it('respects a custom ladder', () => {
    const ladder = ['PASS', 'WARN', 'FAIL']
    expect(verdictLadderPosition('WARN', ladder)).toBe(1)
    expect(verdictLadderPosition('SHIP_IT', ladder)).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// computeAxisVerdict — code quality
// ---------------------------------------------------------------------------

describe('computeAxisVerdict — code quality axis', () => {
  const thresholds = DEFAULT_THRESHOLDS.codeQuality // { warn: 0.05, fail: 0.15 }

  it('GREEN at zero delta (no change)', () => {
    expect(computeAxisVerdict({ meanDelta: 0 }, thresholds)).toBe('GREEN')
  })

  it('GREEN for small positive delta (improvement)', () => {
    expect(computeAxisVerdict({ meanDelta: 0.10 }, thresholds)).toBe('GREEN')
  })

  it('YELLOW at warn threshold (regression of exactly warn)', () => {
    expect(computeAxisVerdict({ meanDelta: -0.05 }, thresholds)).toBe('YELLOW')
  })

  it('RED at fail threshold (regression of exactly fail)', () => {
    expect(computeAxisVerdict({ meanDelta: -0.15 }, thresholds)).toBe('RED')
  })

  it('YELLOW for regression between warn and fail', () => {
    expect(computeAxisVerdict({ meanDelta: -0.10 }, thresholds)).toBe('YELLOW')
  })
})

// ---------------------------------------------------------------------------
// computeAxisVerdict — TV distance (verdict / recovery axes)
// ---------------------------------------------------------------------------

describe('computeAxisVerdict — TV distance axis', () => {
  const thresholds = DEFAULT_THRESHOLDS.verdict // { warnTV: 0.10, failTV: 0.20 }

  it('GREEN at zero TV distance', () => {
    expect(computeAxisVerdict({ tvDistance: 0 }, thresholds)).toBe('GREEN')
  })

  it('YELLOW at warnTV (exactly)', () => {
    expect(computeAxisVerdict({ tvDistance: 0.10 }, thresholds)).toBe('YELLOW')
  })

  it('RED at failTV (exactly)', () => {
    expect(computeAxisVerdict({ tvDistance: 0.20 }, thresholds)).toBe('RED')
  })
})

// ---------------------------------------------------------------------------
// computeAxisVerdict — cost axis
// ---------------------------------------------------------------------------

describe('computeAxisVerdict — cost axis', () => {
  const thresholds = DEFAULT_THRESHOLDS.cost

  it('GREEN at zero relative deltas', () => {
    expect(computeAxisVerdict(
      { relDeltaTurns: 0, relDeltaInputTokens: 0, relDeltaOutputTokens: 0 },
      thresholds,
    )).toBe('GREEN')
  })

  it('YELLOW when relative turns delta reaches warnTurns', () => {
    expect(computeAxisVerdict(
      { relDeltaTurns: 0.10, relDeltaInputTokens: 0, relDeltaOutputTokens: 0 },
      thresholds,
    )).toBe('YELLOW')
  })

  it('RED when relative turns delta reaches failTurns', () => {
    expect(computeAxisVerdict(
      { relDeltaTurns: 0.25, relDeltaInputTokens: 0, relDeltaOutputTokens: 0 },
      thresholds,
    )).toBe('RED')
  })

  it('YELLOW when token delta reaches warnTokens', () => {
    expect(computeAxisVerdict(
      { relDeltaTurns: 0, relDeltaInputTokens: 0.15, relDeltaOutputTokens: 0 },
      thresholds,
    )).toBe('YELLOW')
  })
})

// ---------------------------------------------------------------------------
// aggregateOverallVerdict
// ---------------------------------------------------------------------------

describe('aggregateOverallVerdict', () => {
  it('GREEN when all axes are GREEN', () => {
    expect(aggregateOverallVerdict(['GREEN', 'GREEN', 'GREEN', 'GREEN'])).toBe('GREEN')
  })

  it('YELLOW when any axis is YELLOW (and none are RED)', () => {
    expect(aggregateOverallVerdict(['GREEN', 'YELLOW', 'GREEN', 'GREEN'])).toBe('YELLOW')
  })

  it('RED when any axis is RED (worst-axis-wins)', () => {
    expect(aggregateOverallVerdict(['GREEN', 'YELLOW', 'RED', 'GREEN'])).toBe('RED')
  })

  it('RED beats YELLOW (RED > YELLOW > GREEN)', () => {
    expect(aggregateOverallVerdict(['RED', 'YELLOW'])).toBe('RED')
  })
})

// ---------------------------------------------------------------------------
// gradeCodeQualityAxis — candidate clearly better
// ---------------------------------------------------------------------------

describe('gradeCodeQualityAxis — candidate clearly better', () => {
  it('produces a positive delta when candidate matches ground truth better', async () => {
    // current.diff has files: [a], groundTruth has files: [a, b] → current fileJaccard = 1/2=0.5
    // candidate.diff has files: [a, b], groundTruth has files: [a, b] → candidate fileJaccard = 1
    const pairs = [
      {
        current: completedSide({ files: ['a'] }),
        candidate: completedSide({ files: ['a', 'b'] }),
        ground_truth_diff: { changed_files: ['a', 'b'], passing_tests: [] },
      },
    ]
    const result = await gradeCodeQualityAxis(pairs, {})
    expect(result.per_pair[0].gradable).toBe(true)
    expect(result.per_pair[0].delta).toBeGreaterThan(0)
    expect(result.improvement_count).toBe(1)
    expect(result.regression_count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// gradeCodeQualityAxis — current clearly better
// ---------------------------------------------------------------------------

describe('gradeCodeQualityAxis — current clearly better', () => {
  it('produces a negative delta when current is closer to ground truth', async () => {
    const pairs = [
      {
        current: completedSide({ files: ['a', 'b'] }),
        candidate: completedSide({ files: ['a'] }),
        ground_truth_diff: { changed_files: ['a', 'b'], passing_tests: [] },
      },
    ]
    const result = await gradeCodeQualityAxis(pairs, {})
    expect(result.per_pair[0].delta).toBeLessThan(0)
    expect(result.regression_count).toBe(1)
    expect(result.improvement_count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// gradeCodeQualityAxis — gray-band triggers judge
// ---------------------------------------------------------------------------

describe('gradeCodeQualityAxis — gray-band pair triggers judge', () => {
  it('invokes judgeFn when min(currentScore, candidateScore) is in the gray band', async () => {
    // detScore = 0.5*fileJaccard + 0.5*testOverlap; with empty actual passing_tests, testOverlap = 1 (neutral)
    // current files: [a, b, c], groundTruth: [b, c, d] → fileJaccard = 2/4 = 0.5, detScore = 0.5*0.5 + 0.5*1 = 0.75 (in band)
    // candidate files: [b, c], groundTruth: [b, c, d] → fileJaccard = 2/3 ≈ 0.667, detScore ≈ 0.5*0.667 + 0.5*1 ≈ 0.833 (above band)
    // min(0.75, 0.833) = 0.75 ∈ [0.4, 0.8] → judge fires
    const judgeFn = vi.fn(async () => ({ winner: 'candidate', confidence: 0.9 }))
    const pairs = [
      {
        current: completedSide({ files: ['a', 'b', 'c'] }),
        candidate: completedSide({ files: ['b', 'c'] }),
        ground_truth_diff: { changed_files: ['b', 'c', 'd'], passing_tests: [] },
      },
    ]
    const result = await gradeCodeQualityAxis(pairs, { judgeFn })
    expect(judgeFn).toHaveBeenCalledOnce()
    expect(result.per_pair[0].judge_invoked).toBe(true)
    // judge says candidate → delta should be positive (absolute)
    expect(result.per_pair[0].delta).toBeGreaterThan(0)
  })

  it('does NOT invoke judgeFn for clear pass (both above gray band)', async () => {
    // Both sides produce score = 1.0 (exact match with ground truth)
    const judgeFn = vi.fn(async () => ({ winner: 'current', confidence: 1 }))
    const pairs = [
      {
        current: completedSide({ files: ['a', 'b'] }),
        candidate: completedSide({ files: ['a', 'b'] }),
        ground_truth_diff: { changed_files: ['a', 'b'], passing_tests: [] },
      },
    ]
    const result = await gradeCodeQualityAxis(pairs, { judgeFn })
    expect(judgeFn).not.toHaveBeenCalled()
    expect(result.per_pair[0].judge_invoked).toBe(false)
  })

  it('does NOT invoke judgeFn when absent (fallback to deterministic)', async () => {
    const pairs = [
      {
        current: completedSide({ files: ['a', 'b', 'c'] }),
        candidate: completedSide({ files: ['b', 'c'] }),
        ground_truth_diff: { changed_files: ['b', 'c', 'd'], passing_tests: [] },
      },
    ]
    // No judgeFn provided
    const result = await gradeCodeQualityAxis(pairs, {})
    expect(result.per_pair[0].judge_invoked).toBe(false)
    // Delta uses raw deterministic scores
    expect(typeof result.per_pair[0].delta).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// gradeCodeQualityAxis — ungradable pairs excluded
// ---------------------------------------------------------------------------

describe('gradeCodeQualityAxis — ungradable pairs excluded', () => {
  it('excludes pair where current did not complete', async () => {
    const pairs = [
      {
        current: { dispatch_outcome: 'failed', diff: null },
        candidate: completedSide({ files: ['a'] }),
        ground_truth_diff: { changed_files: ['a'], passing_tests: [] },
      },
    ]
    const result = await gradeCodeQualityAxis(pairs, {})
    expect(result.ungradable_count).toBe(1)
    expect(result.per_pair[0].gradable).toBe(false)
    expect(result.per_pair[0].reason).toBe('not-both-completed')
  })

  it('excludes pair where both sides did not complete', async () => {
    const pairs = [
      {
        current: { dispatch_outcome: 'failed', diff: null },
        candidate: { dispatch_outcome: 'failed', diff: null },
        ground_truth_diff: { changed_files: [], passing_tests: [] },
      },
    ]
    const result = await gradeCodeQualityAxis(pairs, {})
    expect(result.ungradable_count).toBe(1)
    // Mean delta defaults to 0 (no gradable pairs)
    expect(result.mean_delta).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// extractFilesFromDiff — edge cases (AC7, Story 81-7)
// ---------------------------------------------------------------------------

describe('extractFilesFromDiff — edge cases', () => {
  it('returns empty Set for null input', () => {
    expect(extractFilesFromDiff(null).size).toBe(0)
  })

  it('returns empty Set for undefined input', () => {
    expect(extractFilesFromDiff(undefined).size).toBe(0)
  })

  it('returns empty Set for empty array', () => {
    expect(extractFilesFromDiff([]).size).toBe(0)
  })

  it('returns Set of file paths for an array of strings', () => {
    const result = extractFilesFromDiff(['src/foo.ts', 'src/bar.ts'])
    expect(result).toEqual(new Set(['src/foo.ts', 'src/bar.ts']))
  })

  it('parses unified diff string and extracts b/ paths', () => {
    const unified = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc..def 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,2 @@',
      '+export const x = 1',
      'diff --git a/src/bar.ts b/src/bar.ts',
      'index 111..222 100644',
    ].join('\n')
    const result = extractFilesFromDiff(unified)
    expect(result).toEqual(new Set(['src/foo.ts', 'src/bar.ts']))
  })

  it('returns empty Set for an empty unified diff string', () => {
    expect(extractFilesFromDiff('').size).toBe(0)
  })

  it('extracts files from object with reconstructed_files array', () => {
    const result = extractFilesFromDiff({ reconstructed_files: ['a.ts', 'b.ts'] })
    expect(result).toEqual(new Set(['a.ts', 'b.ts']))
  })

  it('extracts files from object with changed_files array (fallback)', () => {
    const result = extractFilesFromDiff({ changed_files: ['x.ts'] })
    expect(result).toEqual(new Set(['x.ts']))
  })
})

// ---------------------------------------------------------------------------
// scorePackDiffAgainstGroundTruth — empty-empty produces null, NOT 1.000 (AC7, Story 81-7)
// ---------------------------------------------------------------------------

describe('scorePackDiffAgainstGroundTruth — empty-empty ungradable (Story 81-7 fix)', () => {
  it('returns null when both pack diff AND ground truth are empty arrays', () => {
    // This is the regression fixed in Story 81-7:
    // Previously deterministicSignal returned 1.000 for empty-vs-empty (Jaccard convention).
    // Post-fix: null signals "no measurable signal" → marks pair ungradable.
    const result = scorePackDiffAgainstGroundTruth([], [])
    expect(result).toBeNull()
  })

  it('returns null when both sides are null/undefined', () => {
    expect(scorePackDiffAgainstGroundTruth(null, null)).toBeNull()
    expect(scorePackDiffAgainstGroundTruth(undefined, undefined)).toBeNull()
  })

  it('returns null when pack diff is empty and ground truth is empty string', () => {
    expect(scorePackDiffAgainstGroundTruth([], '')).toBeNull()
  })

  it('returns a numeric score (not null) when pack diff is non-empty', () => {
    // When only one side is empty, jaccard = 0 (no overlap), NOT null
    const result = scorePackDiffAgainstGroundTruth(['src/a.ts'], [])
    expect(result).toBeTypeOf('number')
    expect(result).toBe(0) // jaccard of {'a'} and {} = 0/1 = 0
  })

  it('returns a numeric score (not null) when ground truth is non-empty', () => {
    const result = scorePackDiffAgainstGroundTruth([], ['src/a.ts'])
    expect(result).toBeTypeOf('number')
    expect(result).toBe(0)
  })

  it('returns 1.0 for identical non-empty file sets (normal case)', () => {
    expect(scorePackDiffAgainstGroundTruth(['a.ts', 'b.ts'], ['a.ts', 'b.ts'])).toBe(1)
  })

  it('returns correct Jaccard for partial overlap', () => {
    // packFiles = {'a', 'b'}, groundTruth = {'b', 'c'} → |{'b'}| / |{'a','b','c'}| = 1/3
    const result = scorePackDiffAgainstGroundTruth(['a.ts', 'b.ts'], ['b.ts', 'c.ts'])
    expect(result).toBeCloseTo(1 / 3, 6)
  })
})

// ---------------------------------------------------------------------------
// gradeCodeQualityAxis — no-measurable-diff ungradable reason (AC7, Story 81-7)
// ---------------------------------------------------------------------------

describe('gradeCodeQualityAxis — no-measurable-diff ungradable pairs', () => {
  it('marks a pair ungradable with no-measurable-diff when both completed sides AND ground truth have empty file sets', async () => {
    // The "no-measurable-diff" condition triggers when BOTH pack diffs AND the ground
    // truth have empty file sets — there is nothing to compare.
    // Pre-81-7: this would score 1.000 = 1.000 (Jaccard of empty sets = 1 by convention).
    // Post-81-7: marked ungradable with reason='no-measurable-diff'.
    const pairs = [
      {
        current: { dispatch_outcome: 'completed', diff: [] },
        candidate: { dispatch_outcome: 'completed', diff: [] },
        ground_truth_diff: [], // empty ground truth — no files to compare against
      },
    ]
    const result = await gradeCodeQualityAxis(pairs, {})
    expect(result.ungradable_count).toBe(1)
    expect(result.per_pair[0].gradable).toBe(false)
    expect(result.per_pair[0].reason).toBe('no-measurable-diff')
  })

  it('marks a pair ungradable with no-measurable-diff when both diffs are null', async () => {
    const pairs = [
      {
        current: { dispatch_outcome: 'completed', diff: null },
        candidate: { dispatch_outcome: 'completed', diff: null },
        ground_truth_diff: null,
      },
    ]
    const result = await gradeCodeQualityAxis(pairs, {})
    expect(result.ungradable_count).toBe(1)
    expect(result.per_pair[0].reason).toBe('no-measurable-diff')
  })

  it('does NOT mark a pair as no-measurable-diff when current has files but candidate is empty', async () => {
    // Only both-empty triggers no-measurable-diff; one-empty triggers a score of 0.
    const pairs = [
      {
        current: { dispatch_outcome: 'completed', diff: ['src/foo.ts'] },
        candidate: { dispatch_outcome: 'completed', diff: [] },
        ground_truth_diff: ['src/foo.ts'],
      },
    ]
    const result = await gradeCodeQualityAxis(pairs, {})
    // candidateScore = jaccard({}, {'src/foo.ts'}) = 0; currentScore = 1; delta = -1
    expect(result.per_pair[0].gradable).toBe(true)
    expect(result.per_pair[0].reason).toBeUndefined()
    expect(result.per_pair[0].delta).toBe(-1)
  })

  it('mean_delta defaults to 0 when all pairs are ungradable (no-measurable-diff)', async () => {
    const pairs = [
      {
        current: { dispatch_outcome: 'completed', diff: null },
        candidate: { dispatch_outcome: 'completed', diff: null },
        ground_truth_diff: null,
      },
    ]
    const result = await gradeCodeQualityAxis(pairs, {})
    expect(result.mean_delta).toBe(0)
    expect(result.verdict).toBe('GREEN') // 0 delta = GREEN
  })
})

// ---------------------------------------------------------------------------
// gradeCostAxis — per-pair Δ computation
// ---------------------------------------------------------------------------

describe('gradeCostAxis — per-pair delta computation', () => {
  it('computes correct per-pair turn and token deltas', () => {
    const pairs = [
      {
        current: completedSide({
          totalTurns: 10,
          totalTokens: { input: 1000, output: 200 },
        }),
        candidate: completedSide({
          totalTurns: 12,
          totalTokens: { input: 1100, output: 220 },
        }),
      },
      {
        current: completedSide({
          totalTurns: 8,
          totalTokens: { input: 800, output: 150 },
        }),
        candidate: completedSide({
          totalTurns: 7,
          totalTokens: { input: 750, output: 140 },
        }),
      },
    ]
    const result = gradeCostAxis(pairs, {})
    expect(result.per_pair[0].delta_turns).toBe(2)
    expect(result.per_pair[0].delta_input_tokens).toBe(100)
    expect(result.per_pair[0].delta_output_tokens).toBe(20)
    expect(result.per_pair[1].delta_turns).toBe(-1)
    // Mean delta turns: (2 + -1) / 2 = 0.5
    expect(result.mean_delta_turns).toBeCloseTo(0.5, 6)
  })
})

// ---------------------------------------------------------------------------
// gradeCostAxis — missing telemetry excludes pair
// ---------------------------------------------------------------------------

describe('gradeCostAxis — missing telemetry excludes pair', () => {
  it('excludes pairs where total_turns is missing', () => {
    const pairs = [
      {
        current: completedSide({}), // no totalTurns/totalTokens
        candidate: completedSide({ totalTurns: 5, totalTokens: { input: 100, output: 20 } }),
      },
    ]
    const result = gradeCostAxis(pairs, {})
    expect(result.ungradable_count).toBe(1)
    expect(result.per_pair[0].gradable).toBe(false)
    expect(result.per_pair[0].reason).toBe('missing-telemetry')
  })

  it('excludes pairs where total_tokens is partially absent', () => {
    const pairs = [
      {
        current: {
          dispatch_outcome: 'completed',
          diff: null,
          total_turns: 5,
          total_tokens: null, // missing tokens
          verdict: null,
          recovery_history: [],
        },
        candidate: completedSide({ totalTurns: 5, totalTokens: { input: 100, output: 20 } }),
      },
    ]
    const result = gradeCostAxis(pairs, {})
    expect(result.ungradable_count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// gradeCostAxis — aggregate mean and p95
// ---------------------------------------------------------------------------

describe('gradeCostAxis — aggregate mean and p95', () => {
  it('computes correct mean delta turns', () => {
    const pairs = [10, 20, 30].map((extra) => ({
      current: completedSide({ totalTurns: 10, totalTokens: { input: 1000, output: 200 } }),
      candidate: completedSide({
        totalTurns: 10 + extra,
        totalTokens: { input: 1000, output: 200 },
      }),
    }))
    const result = gradeCostAxis(pairs, {})
    // Deltas: [10, 20, 30], mean = 20
    expect(result.mean_delta_turns).toBeCloseTo(20, 6)
  })

  it('computes correct p95 of delta turns', () => {
    // 20 pairs with delta 1 each except one with delta 100
    const pairs = Array.from({ length: 19 }, () => ({
      current: completedSide({ totalTurns: 10, totalTokens: { input: 100, output: 20 } }),
      candidate: completedSide({ totalTurns: 11, totalTokens: { input: 100, output: 20 } }),
    }))
    pairs.push({
      current: completedSide({ totalTurns: 10, totalTokens: { input: 100, output: 20 } }),
      candidate: completedSide({ totalTurns: 110, totalTokens: { input: 100, output: 20 } }),
    })
    const result = gradeCostAxis(pairs, {})
    // p95 of 20 values: index = ceil(0.95 * 20) - 1 = ceil(19) - 1 = 18
    // sorted: [1,1,...(19 times), 100] → index 18 = 1
    expect(result.p95s.turns).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// gradeCostAxis — Story 81-9: becomes gradable when total_turns is populated
// ---------------------------------------------------------------------------

describe('gradeCostAxis — 81-9 cost axis becomes gradable with real total_turns', () => {
  it('(AC5c) produces gradable:true and real delta_turns when both sides carry total_turns', () => {
    // Simulate envelopes produced by the 81-9 totalTurns producer:
    // current pack used 12 turns, candidate pack used 8 turns → delta = -4 (regression reversed)
    const current   = { total_turns: 12, total_tokens: { input: 1500, output: 600 } }
    const candidate = { total_turns:  8, total_tokens: { input: 1200, output: 480 } }
    const result = gradeCostAxis([{ current, candidate }], {})
    const pair = result.per_pair[0]
    expect(pair.gradable).toBe(true)
    expect(pair.delta_turns).toBe(-4)         // candidate used fewer turns
    expect(result.ungradable_count).toBe(0)
    expect(result.mean_delta_turns).toBeCloseTo(-4, 6)
  })

  it('(AC5c) preserved: gradeCostAxis still returns missing-telemetry when total_turns is null', () => {
    // Confirm the baseline behavior is unchanged (AC4 forward-only constraint).
    // Dispatches without a turn count must remain ungradable — absence ≠ zero.
    const current   = { total_turns: null, total_tokens: null }
    const candidate = { total_turns: null, total_tokens: null }
    const result = gradeCostAxis([{ current, candidate }], {})
    const pair = result.per_pair[0]
    expect(pair.gradable).toBe(false)
    expect(pair.reason).toBe('missing-telemetry')
    expect(result.ungradable_count).toBe(1)
  })

  it('(AC3) normalizeDispatchEnvelope maps DispatchResult.totalTurns to total_turns', async () => {
    // Verify the producer → normalizer → grader input chain end-to-end.
    // If the dispatcher sets totalTurns on the DispatchResult, normalizeDispatchEnvelope
    // must surface it as total_turns in the grader's input envelope.
    // @ts-expect-error — importing JS module from TS test
    const { normalizeDispatchEnvelope } = await import('../lib.mjs')

    const rawResult = {
      status: 'completed',
      totalTurns: 9,           // ← set by 81-9 producer (ClaudeCodeAdapter.parseStreamOutput)
      durationMs: 1500,
      exitCode: 0,
      tokenEstimate: { input: 500, output: 150 },
    }
    const envelope = normalizeDispatchEnvelope(rawResult, 'current-pack', '/path/to/pack')
    expect(envelope.total_turns).toBe(9)

    // Now verify it flows through to gradeCostAxis as gradable
    const candidateResult = {
      status: 'completed',
      totalTurns: 6,
      durationMs: 1200,
      exitCode: 0,
      tokenEstimate: { input: 400, output: 120 },
    }
    const candidateEnvelope = normalizeDispatchEnvelope(candidateResult, 'candidate-pack', '/path/to/pack')

    const gradeResult = gradeCostAxis([{ current: envelope, candidate: candidateEnvelope }], {})
    expect(gradeResult.per_pair[0].gradable).toBe(true)
    expect(gradeResult.per_pair[0].delta_turns).toBe(-3)
  })
})

// ---------------------------------------------------------------------------
// gradeVerdictAxis — categorical shifts
// ---------------------------------------------------------------------------

describe('gradeVerdictAxis — categorical shift classification', () => {
  it('classifies identical verdicts as "same"', () => {
    const pairs = [
      {
        current: completedSide({ verdict: 'SHIP_IT' }),
        candidate: completedSide({ verdict: 'SHIP_IT' }),
      },
    ]
    const result = gradeVerdictAxis(pairs, {})
    expect(result.per_pair[0].shift).toBe('same')
  })

  it('classifies candidate moving toward SHIP_IT as "shifted-up"', () => {
    // current=NEEDS_MINOR_FIXES (pos 2), candidate=LGTM_WITH_NOTES (pos 1) → shifted-up
    const pairs = [
      {
        current: completedSide({ verdict: 'NEEDS_MINOR_FIXES' }),
        candidate: completedSide({ verdict: 'LGTM_WITH_NOTES' }),
      },
    ]
    const result = gradeVerdictAxis(pairs, {})
    expect(result.per_pair[0].shift).toBe('shifted-up')
  })

  it('classifies candidate moving toward NEEDS_MAJOR_REWORK as "shifted-down"', () => {
    // current=SHIP_IT (pos 0), candidate=NEEDS_MINOR_FIXES (pos 2) → shifted-down
    const pairs = [
      {
        current: completedSide({ verdict: 'SHIP_IT' }),
        candidate: completedSide({ verdict: 'NEEDS_MINOR_FIXES' }),
      },
    ]
    const result = gradeVerdictAxis(pairs, {})
    expect(result.per_pair[0].shift).toBe('shifted-down')
  })

  it('classifies unknown verdicts as "other"', () => {
    const pairs = [
      {
        current: completedSide({ verdict: 'SHIP_IT' }),
        candidate: completedSide({ verdict: 'UNKNOWN_CLASS' }),
      },
    ]
    const result = gradeVerdictAxis(pairs, {})
    expect(result.per_pair[0].shift).toBe('other')
  })

  it('excludes pair where verdict is missing on either side', () => {
    const pairs = [
      {
        current: completedSide({}), // no verdict
        candidate: completedSide({ verdict: 'SHIP_IT' }),
      },
    ]
    const result = gradeVerdictAxis(pairs, {})
    expect(result.ungradable_count).toBe(1)
    expect(result.per_pair[0].gradable).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// gradeVerdictAxis — TV distance on known fixture
// ---------------------------------------------------------------------------

describe('gradeVerdictAxis — TV distance', () => {
  it('computes correct TV distance between two known distributions', () => {
    // 2 pairs:
    //   pair 1: current=SHIP_IT, candidate=NEEDS_MINOR_FIXES (shifted-down)
    //   pair 2: current=NEEDS_MAJOR_REWORK, candidate=NEEDS_MAJOR_REWORK (same)
    // current dist: { SHIP_IT: 1, NEEDS_MAJOR_REWORK: 1 }
    // candidate dist: { NEEDS_MINOR_FIXES: 1, NEEDS_MAJOR_REWORK: 1 }
    // p_curr: SHIP_IT=0.5, NEEDS_MAJOR_REWORK=0.5
    // p_cand: NEEDS_MINOR_FIXES=0.5, NEEDS_MAJOR_REWORK=0.5
    // TV = 0.5 * (|0.5-0| + |0-0.5| + |0.5-0.5|) = 0.5 * (0.5+0.5+0) = 0.5
    const pairs = [
      {
        current: completedSide({ verdict: 'SHIP_IT' }),
        candidate: completedSide({ verdict: 'NEEDS_MINOR_FIXES' }),
      },
      {
        current: completedSide({ verdict: 'NEEDS_MAJOR_REWORK' }),
        candidate: completedSide({ verdict: 'NEEDS_MAJOR_REWORK' }),
      },
    ]
    const result = gradeVerdictAxis(pairs, {})
    expect(result.tv_distance).toBeCloseTo(0.5, 6)
  })
})

// ---------------------------------------------------------------------------
// gradeRecoveryAxis — empty-both excluded
// ---------------------------------------------------------------------------

describe('gradeRecoveryAxis — empty-both excluded', () => {
  it('excludes pairs where both sides have empty recovery_history', () => {
    const pairs = [
      {
        current: completedSide({ recoveryHistory: [] }),
        candidate: completedSide({ recoveryHistory: [] }),
      },
    ]
    const result = gradeRecoveryAxis(pairs, {})
    expect(result.ungradable_count).toBe(1)
    expect(result.per_pair[0].gradable).toBe(false)
    expect(result.per_pair[0].reason).toBe('empty-both')
  })

  it('includes pair where only one side has recovery_history', () => {
    const pairs = [
      {
        current: completedSide({ recoveryHistory: [{ strategy: 'build-failure' }] }),
        candidate: completedSide({ recoveryHistory: [] }),
      },
    ]
    const result = gradeRecoveryAxis(pairs, {})
    expect(result.ungradable_count).toBe(0)
    expect(result.per_pair[0].gradable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// gradeRecoveryAxis — class distribution
// ---------------------------------------------------------------------------

describe('gradeRecoveryAxis — class distribution', () => {
  it('counts recovery actions by strategy class', () => {
    const pairs = [
      {
        current: completedSide({
          recoveryHistory: [
            { strategy: 'build-failure' },
            { strategy: 'build-failure' },
            { strategy: 'ac-missing-evidence' },
          ],
        }),
        candidate: completedSide({
          recoveryHistory: [{ strategy: 'build-failure' }],
        }),
      },
    ]
    const result = gradeRecoveryAxis(pairs, {})
    expect(result.current_distribution['build-failure']).toBe(2)
    expect(result.current_distribution['ac-missing-evidence']).toBe(1)
    expect(result.candidate_distribution['build-failure']).toBe(1)
  })

  it('computes TV distance between recovery distributions', () => {
    // current: { build-failure: 1 }, candidate: { ac-missing-evidence: 1 }
    // fully disjoint → TV = 1
    const pairs = [
      {
        current: completedSide({ recoveryHistory: [{ strategy: 'build-failure' }] }),
        candidate: completedSide({ recoveryHistory: [{ strategy: 'ac-missing-evidence' }] }),
      },
    ]
    const result = gradeRecoveryAxis(pairs, {})
    expect(result.tv_distance).toBeCloseTo(1, 6)
  })
})

// ---------------------------------------------------------------------------
// gradeAll — integration test with 3-pair synthetic corpus
// ---------------------------------------------------------------------------

describe('gradeAll — integration', () => {
  it('produces correct per-axis and overall verdicts for a 3-pair corpus', async () => {
    // Pair 1: both completed, candidate better quality, same verdict, no recovery
    const pair1 = {
      current: {
        dispatch_outcome: 'completed',
        diff: { reconstructed_files: ['a.ts'], passing_tests: [] },
        total_turns: 10,
        total_tokens: { input: 1000, output: 200 },
        verdict: 'SHIP_IT',
        recovery_history: [],
      },
      candidate: {
        dispatch_outcome: 'completed',
        diff: { reconstructed_files: ['a.ts', 'b.ts'], passing_tests: [] },
        total_turns: 10,
        total_tokens: { input: 1000, output: 200 },
        verdict: 'SHIP_IT',
        recovery_history: [],
      },
      ground_truth_diff: { changed_files: ['a.ts', 'b.ts'], passing_tests: [] },
    }

    // Pair 2: both completed, equal quality, candidate has fewer turns, same verdict
    const pair2 = {
      current: {
        dispatch_outcome: 'completed',
        diff: { reconstructed_files: ['x.ts'], passing_tests: [] },
        total_turns: 20,
        total_tokens: { input: 2000, output: 400 },
        verdict: 'LGTM_WITH_NOTES',
        recovery_history: [],
      },
      candidate: {
        dispatch_outcome: 'completed',
        diff: { reconstructed_files: ['x.ts'], passing_tests: [] },
        total_turns: 18,
        total_tokens: { input: 1900, output: 380 },
        verdict: 'LGTM_WITH_NOTES',
        recovery_history: [],
      },
      ground_truth_diff: { changed_files: ['x.ts'], passing_tests: [] },
    }

    // Pair 3: current didn't complete → excluded from code-quality axis
    const pair3 = {
      current: {
        dispatch_outcome: 'failed',
        diff: null,
        total_turns: undefined,
        total_tokens: undefined,
        verdict: null,
        recovery_history: [],
      },
      candidate: {
        dispatch_outcome: 'completed',
        diff: { reconstructed_files: ['z.ts'], passing_tests: [] },
        total_turns: undefined,
        total_tokens: undefined,
        verdict: null,
        recovery_history: [],
      },
      ground_truth_diff: { changed_files: ['z.ts'], passing_tests: [] },
    }

    const result = await gradeAll([pair1, pair2, pair3], {})

    expect(result.pair_count).toBe(3)
    expect(result.pair_outcomes['both-completed']).toBe(2)
    expect(result.pair_outcomes['one-completed']).toBe(1)
    expect(result.pair_outcomes['both-incomplete']).toBe(0)

    // Code quality: 2 gradable (pair3 excluded), candidate better or same → positive or zero mean delta → GREEN
    expect(result.axes.code_quality.ungradable_count).toBe(1)
    expect(result.axes.code_quality.mean_delta).toBeGreaterThanOrEqual(0)

    // Verdict axis: 2 gradable (pair3 excluded), both same → TV = 0 → GREEN
    expect(result.axes.verdict.tv_distance).toBeCloseTo(0, 6)
    expect(result.axes.verdict.verdict).toBe('GREEN')

    // Overall verdict exists
    expect(['GREEN', 'YELLOW', 'RED']).toContain(result.overall_verdict)
    expect(result.thresholds_used).toBeDefined()
  })

  it('surfaces overall_verdict as RED when code quality regresses past fail threshold', async () => {
    // Create a pair where current is much better than candidate (large regression)
    const pairs = [
      {
        current: {
          dispatch_outcome: 'completed',
          diff: { reconstructed_files: ['a', 'b', 'c', 'd', 'e'], passing_tests: [] },
          total_turns: 10,
          total_tokens: { input: 1000, output: 200 },
          verdict: 'SHIP_IT',
          recovery_history: [],
        },
        candidate: {
          dispatch_outcome: 'completed',
          diff: { reconstructed_files: ['z'], passing_tests: [] }, // totally different → very low score
          total_turns: 10,
          total_tokens: { input: 1000, output: 200 },
          verdict: 'SHIP_IT',
          recovery_history: [],
        },
        ground_truth_diff: {
          changed_files: ['a', 'b', 'c', 'd', 'e'],
          passing_tests: [],
        },
      },
    ]
    // Use tight fail threshold so the regression triggers RED
    const result = await gradeAll(pairs, {
      thresholds: {
        codeQuality: { warn: 0.01, fail: 0.10 },
        cost: DEFAULT_THRESHOLDS.cost,
        verdict: DEFAULT_THRESHOLDS.verdict,
        recovery: DEFAULT_THRESHOLDS.recovery,
      },
    })
    expect(result.axes.code_quality.mean_delta).toBeLessThan(0)
    expect(result.axes.code_quality.verdict).toBe('RED')
    expect(result.overall_verdict).toBe('RED')
  })
})

// ---------------------------------------------------------------------------
// gradeAll — judge is mocked (AC12)
// ---------------------------------------------------------------------------

describe('gradeAll — LLM judge is mocked', () => {
  it('invokes the mocked judgeFn for gray-band pairs', async () => {
    const judgeFn = vi.fn(async () => ({ winner: 'tie', confidence: 0.6 }))

    // Pair where min(currentScore, candidateScore) is in the gray band:
    // detScore = 0.5*fileJaccard + 0.5*testOverlap; with empty actual passing_tests, testOverlap = 1 (neutral)
    // current files: [a, b, c], groundTruth: [b, c, d] → fileJaccard = 2/4 = 0.5, detScore = 0.75 (in band)
    // candidate files: [b, c], groundTruth: [b, c, d] → fileJaccard = 2/3 ≈ 0.667, detScore ≈ 0.833 (above band)
    // min(0.75, 0.833) = 0.75 ∈ [0.4, 0.8] → judge fires
    const pairs = [
      {
        current: {
          dispatch_outcome: 'completed',
          diff: { reconstructed_files: ['a', 'b', 'c'], passing_tests: [] },
          total_turns: undefined,
          total_tokens: undefined,
          verdict: undefined,
          recovery_history: [],
        },
        candidate: {
          dispatch_outcome: 'completed',
          diff: { reconstructed_files: ['b', 'c'], passing_tests: [] },
          total_turns: undefined,
          total_tokens: undefined,
          verdict: undefined,
          recovery_history: [],
        },
        ground_truth_diff: { changed_files: ['b', 'c', 'd'], passing_tests: [] },
      },
    ]

    const result = await gradeAll(pairs, { judgeFn })
    expect(judgeFn).toHaveBeenCalled()
    // judge returned 'tie' → delta should be 0
    expect(result.axes.code_quality.per_pair[0].delta).toBe(0)
  })
})
