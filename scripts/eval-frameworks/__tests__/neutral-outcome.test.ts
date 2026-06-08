import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs module, no types
import { computeNeutralOutcome } from '../neutral-outcome.mjs'

const truth = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'diff --git a/src/bar.ts b/src/bar.ts',
].join('\n')

describe('computeNeutralOutcome — framework-agnostic success oracle', () => {
  it('succeeds when build + tests pass and overlap meets threshold', () => {
    const onTarget = 'diff --git a/src/foo.ts b/src/foo.ts\ndiff --git a/src/bar.ts b/src/bar.ts'
    const o = computeNeutralOutcome({ buildPassed: true, testsPassed: true, runDiff: onTarget, groundTruthDiff: truth })
    expect(o.success).toBe(true)
    expect(o.file_overlap).toBe(1)
    expect(o.reason).toBe('all-gates-passed')
  })

  it('fails on build first, regardless of overlap', () => {
    const o = computeNeutralOutcome({ buildPassed: false, testsPassed: true, runDiff: truth, groundTruthDiff: truth })
    expect(o.success).toBe(false)
    expect(o.reason).toBe('build-failed')
  })

  it('fails on tests when build passes', () => {
    const o = computeNeutralOutcome({ buildPassed: true, testsPassed: false, runDiff: truth, groundTruthDiff: truth })
    expect(o.success).toBe(false)
    expect(o.reason).toBe('tests-failed')
  })

  it('fails below the overlap threshold (wrong files touched)', () => {
    const offTarget = 'diff --git a/src/unrelated.ts b/src/unrelated.ts'
    const o = computeNeutralOutcome({ buildPassed: true, testsPassed: true, runDiff: offTarget, groundTruthDiff: truth })
    expect(o.success).toBe(false)
    expect(o.reason).toBe('below-overlap-threshold')
    expect(o.file_overlap).toBe(0)
  })

  it('partial overlap respects a custom threshold', () => {
    // produced touches 1 of 2 truth files → jaccard(1 ∩ over union 2) = 1/2 = 0.5
    const half = 'diff --git a/src/foo.ts b/src/foo.ts'
    expect(computeNeutralOutcome({ buildPassed: true, testsPassed: true, runDiff: half, groundTruthDiff: truth, overlapThreshold: 0.5 }).overlap_met).toBe(true)
    expect(computeNeutralOutcome({ buildPassed: true, testsPassed: true, runDiff: half, groundTruthDiff: truth, overlapThreshold: 0.6 }).overlap_met).toBe(false)
  })

  it('skips the overlap gate when no ground truth is supplied (build+test only)', () => {
    const o = computeNeutralOutcome({ buildPassed: true, testsPassed: true, runDiff: 'anything', groundTruthDiff: null })
    expect(o.success).toBe(true)
    expect(o.file_overlap).toBeNull()
    expect(o.overlap_met).toBe(true)
  })

  it('treats a ground truth that resolves to no files as no-signal (overlap N/A, not a fail)', () => {
    const o = computeNeutralOutcome({ buildPassed: true, testsPassed: true, runDiff: 'diff --git a/x b/x', groundTruthDiff: 'prose with no diff headers' })
    expect(o.file_overlap).toBeNull()
    expect(o.success).toBe(true)
  })

  it('does not treat truthy-but-non-boolean build/test signals as pass', () => {
    // @ts-expect-error intentional: only strict true counts
    const o = computeNeutralOutcome({ buildPassed: 1, testsPassed: 'yes', runDiff: truth, groundTruthDiff: truth })
    expect(o.build_passed).toBe(false)
    expect(o.success).toBe(false)
  })
})
