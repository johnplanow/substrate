/**
 * Unit tests for the pack-upgrade grader (Stories 81-3 + 81-10).
 *
 * Covers all AC11 scenarios:
 *   - Code-quality axis: better/worse/gray-band/ungradable/both-incomplete
 *   - Cost axis: per-pair Δ, missing telemetry exclusion, mean, p95
 *   - Verdict axis: same/shifted-up/shifted-down/unknown/TV distance
 *   - Recovery axis: empty-both exclusion, class distribution, TV distance
 *   - Work-quality axis: regression/gradable/ungradable/threshold (Story 81-10 AC7)
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
  gradeWorkQualityAxis,
  isTestFile,
  computeTestPresenceScore,
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

// ---------------------------------------------------------------------------
// isTestFile helper (Story 81-10 AC7)
// ---------------------------------------------------------------------------

describe('isTestFile — test file detection', () => {
  it('returns true for *.test.js files', () => {
    expect(isTestFile('src/foo.test.js')).toBe(true)
    expect(isTestFile('foo.test.ts')).toBe(true)
    expect(isTestFile('bar.test.mjs')).toBe(true)
  })

  it('returns true for *.spec.ts files', () => {
    expect(isTestFile('src/bar.spec.ts')).toBe(true)
    expect(isTestFile('utils.spec.js')).toBe(true)
  })

  it('returns true for files inside __tests__/ directory', () => {
    expect(isTestFile('__tests__/foo.ts')).toBe(true)
    expect(isTestFile('src/__tests__/bar.ts')).toBe(true)
  })

  it('returns true for files inside tests/ directory', () => {
    expect(isTestFile('tests/foo.js')).toBe(true)
    expect(isTestFile('tests/unit/bar.ts')).toBe(true)
    // 'test/' (singular) also matches
    expect(isTestFile('test/foo.js')).toBe(true)
  })

  it('returns true for files inside spec/ directory', () => {
    expect(isTestFile('spec/foo.rb')).toBe(true)
    expect(isTestFile('specs/bar.js')).toBe(true)
  })

  it('returns true for *_test.js suffix', () => {
    expect(isTestFile('src/foo_test.js')).toBe(true)
    expect(isTestFile('bar_test.ts')).toBe(true)
  })

  it('returns false for regular source files', () => {
    expect(isTestFile('src/foo.js')).toBe(false)
    expect(isTestFile('lib/utils.ts')).toBe(false)
    expect(isTestFile('docs/readme.md')).toBe(false)
    expect(isTestFile('.github/workflows/ci.yml')).toBe(false)
  })

  it('returns false for empty/null/undefined input', () => {
    expect(isTestFile('')).toBe(false)
    expect(isTestFile(null as unknown as string)).toBe(false)
    expect(isTestFile(undefined as unknown as string)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeTestPresenceScore (Story 81-10 AC7)
// ---------------------------------------------------------------------------

describe('computeTestPresenceScore', () => {
  it('returns 1 when unified diff includes a test file', () => {
    const diff = [
      'diff --git a/src/foo.js b/src/foo.js',
      '+++ b/src/foo.js',
      '+code',
      'diff --git a/tests/foo.test.js b/tests/foo.test.js',
      '+++ b/tests/foo.test.js',
      '+test',
    ].join('\n')
    expect(computeTestPresenceScore(diff)).toBe(1)
  })

  it('returns 0 when unified diff has no test files', () => {
    const diff = [
      'diff --git a/src/foo.js b/src/foo.js',
      '+++ b/src/foo.js',
      '+code',
    ].join('\n')
    expect(computeTestPresenceScore(diff)).toBe(0)
  })

  it('returns 1 when array of files includes a test file', () => {
    expect(computeTestPresenceScore(['src/foo.ts', '__tests__/foo.test.ts'])).toBe(1)
  })

  it('returns 0 for an array of non-test files', () => {
    expect(computeTestPresenceScore(['src/foo.ts', 'docs/readme.md'])).toBe(0)
  })

  it('returns 0 for null/undefined/empty diff', () => {
    expect(computeTestPresenceScore(null)).toBe(0)
    expect(computeTestPresenceScore(undefined)).toBe(0)
    expect(computeTestPresenceScore('')).toBe(0)
    expect(computeTestPresenceScore([])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// gradeWorkQualityAxis — AC7 scenarios (a) (b) (c) (d)
// ---------------------------------------------------------------------------

describe('gradeWorkQualityAxis — AC7a: candidate drops test files → regression', () => {
  it('detects regression when current has tests but candidate does not', () => {
    const withTests = [
      'diff --git a/src/foo.js b/src/foo.js',
      '+++ b/src/foo.js',
      '+code',
      'diff --git a/tests/foo.test.js b/tests/foo.test.js',
      '+++ b/tests/foo.test.js',
      '+test',
    ].join('\n')
    const withoutTests = 'diff --git a/src/foo.js b/src/foo.js\n+++ b/src/foo.js\n+code'

    const pairs = [
      { id: 'p1', current: { diff: withTests }, candidate: { diff: withoutTests } },
      { id: 'p2', current: { diff: withTests }, candidate: { diff: withoutTests } },
    ]
    const result = gradeWorkQualityAxis(pairs)
    // Both pairs: current_score=1, candidate_score=0, delta=-1
    expect(result.per_pair).toHaveLength(2)
    expect(result.per_pair.every((p: { gradable: boolean }) => p.gradable)).toBe(true)
    expect(result.mean_delta).toBe(-1)
    // mean_delta = -1, regression = 1 >= fail=0.30 → RED
    expect(result.verdict).toBe('RED')
    expect(result.ungradable_count).toBe(0)
  })

  it('detects YELLOW when mean regression crosses warn but not fail threshold', () => {
    const withTests = 'diff --git a/tests/x.test.js b/tests/x.test.js\n+++ b/tests/x.test.js\n+test'
    const withoutTests = 'diff --git a/src/x.js b/src/x.js\n+++ b/src/x.js\n+code'

    // 1 regressing pair out of 10 → mean_delta = -1/10 = -0.10 → exactly at warn boundary
    const pairs = [
      { id: 'regress', current: { diff: withTests }, candidate: { diff: withoutTests } },
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `same-${i}`,
        current: { diff: withTests },
        candidate: { diff: withTests }, // no regression
      })),
    ]
    const result = gradeWorkQualityAxis(pairs, { thresholds: { workQuality: { warn: 0.10, fail: 0.30 } } })
    // mean_delta = -0.10, regression = 0.10 >= warn=0.10 → YELLOW
    expect(result.mean_delta).toBeCloseTo(-0.1, 6)
    expect(result.verdict).toBe('YELLOW')
  })
})

describe('gradeWorkQualityAxis — AC7b: both packs have tests → gradable', () => {
  it('marks pairs gradable and returns GREEN when both packs include test files', () => {
    const withTests = [
      'diff --git a/src/alpha.ts b/src/alpha.ts',
      '+++ b/src/alpha.ts',
      '+impl',
      'diff --git a/__tests__/alpha.test.ts b/__tests__/alpha.test.ts',
      '+++ b/__tests__/alpha.test.ts',
      '+test',
    ].join('\n')

    const pairs = [
      { id: 'alpha', current: { diff: withTests }, candidate: { diff: withTests } },
      { id: 'beta', current: { diff: withTests }, candidate: { diff: withTests } },
    ]
    const result = gradeWorkQualityAxis(pairs)
    expect(result.per_pair).toHaveLength(2)
    expect(result.per_pair.every((p: { gradable: boolean }) => p.gradable)).toBe(true)
    expect(result.mean_delta).toBeCloseTo(0, 6)
    expect(result.verdict).toBe('GREEN')
  })
})

describe('gradeWorkQualityAxis — AC7c: both packs have no tests → ungradable', () => {
  it('marks all pairs ungradable with no-quality-signal for docs/config-only stories', () => {
    const docsOnly = 'diff --git a/docs/readme.md b/docs/readme.md\n+++ b/docs/readme.md\n+# docs'
    const configOnly = 'diff --git a/.github/ci.yml b/.github/ci.yml\n+++ b/.github/ci.yml\n+name: CI'

    const pairs = [
      { id: 'docs', current: { diff: docsOnly }, candidate: { diff: docsOnly } },
      { id: 'config', current: { diff: configOnly }, candidate: { diff: configOnly } },
    ]
    const result = gradeWorkQualityAxis(pairs)
    expect(result.per_pair).toHaveLength(2)
    expect(result.per_pair.every((p: { gradable: boolean; reason?: string }) => !p.gradable && p.reason === 'no-quality-signal')).toBe(true)
    expect(result.ungradable_count).toBe(2)
    // No gradable pairs → mean_delta = 0 → GREEN (not penalised as regression)
    expect(result.mean_delta).toBe(0)
    expect(result.verdict).not.toBe('RED')
    expect(result.verdict).not.toBe('FAIL')
  })
})

describe('gradeWorkQualityAxis — AC7d: threshold boundary produces correct verdict', () => {
  it('returns GREEN when regression is below warn threshold', () => {
    const withTests = 'diff --git a/tests/x.test.js b/tests/x.test.js\n+++ b/tests/x.test.js\n+test'
    const noTests = 'diff --git a/src/x.js b/src/x.js\n+++ b/src/x.js\n+code'
    // 1 regressing pair, 19 stable → mean_delta = -1/20 = -0.05 < warn=0.10 → GREEN
    const pairs = [
      { id: 'regress', current: { diff: withTests }, candidate: { diff: noTests } },
      ...Array.from({ length: 19 }, (_, i) => ({
        id: `stable-${i}`,
        current: { diff: withTests },
        candidate: { diff: withTests },
      })),
    ]
    const result = gradeWorkQualityAxis(pairs, { thresholds: { workQuality: { warn: 0.10, fail: 0.30 } } })
    expect(result.mean_delta).toBeCloseTo(-0.05, 6)
    expect(result.verdict).toBe('GREEN')
  })

  it('returns RED when regression exceeds fail threshold', () => {
    const withTests = 'diff --git a/tests/x.test.js b/tests/x.test.js\n+++ b/tests/x.test.js\n+test'
    const noTests = 'diff --git a/src/x.js b/src/x.js\n+++ b/src/x.js\n+code'
    // 4 regressing, 6 stable → mean_delta = -4/10 = -0.40 >= fail=0.30 → RED
    const pairs = [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `regress-${i}`,
        current: { diff: withTests },
        candidate: { diff: noTests },
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `stable-${i}`,
        current: { diff: withTests },
        candidate: { diff: withTests },
      })),
    ]
    const result = gradeWorkQualityAxis(pairs, { thresholds: { workQuality: { warn: 0.10, fail: 0.30 } } })
    expect(result.mean_delta).toBeCloseTo(-0.4, 6)
    expect(result.verdict).toBe('RED')
  })
})

describe('gradeWorkQualityAxis — DEFAULT_THRESHOLDS includes workQuality', () => {
  it('DEFAULT_THRESHOLDS has workQuality warn and fail', () => {
    expect(DEFAULT_THRESHOLDS.workQuality).toBeDefined()
    expect(typeof DEFAULT_THRESHOLDS.workQuality.warn).toBe('number')
    expect(typeof DEFAULT_THRESHOLDS.workQuality.fail).toBe('number')
    expect(DEFAULT_THRESHOLDS.workQuality.warn).toBeGreaterThan(0)
    expect(DEFAULT_THRESHOLDS.workQuality.fail).toBeGreaterThan(DEFAULT_THRESHOLDS.workQuality.warn)
  })
})
