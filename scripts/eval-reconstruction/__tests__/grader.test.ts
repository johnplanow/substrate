/**
 * Unit tests for scripts/eval-reconstruction/grader.mjs (Story 77-9).
 *
 * Two-signal grader: deterministic file-set/test overlap ALWAYS, LLM pairwise
 * judge ONLY in the configurable gray band. The judge is injected so the
 * gray-band path is exercised without a real model. Capability-tier: the grader
 * must NEVER be wired into the /ship gate (AC4) — asserted via everyShipGate.
 */

import { describe, it, expect, vi } from 'vitest'

// @ts-expect-error — importing JS module from TS test (vitest handles the cross-load)
import {
  jaccard,
  testOverlap,
  deterministicSignal,
  isGrayBand,
  combineScore,
  caseVerdict,
  gradeCase,
  gradeAll,
  ReconstructionGraderCheck,
  DEFAULT_GRAY_BAND,
} from '../grader.mjs'

// ---------------------------------------------------------------------------
// Pure scoring helpers
// ---------------------------------------------------------------------------

describe('jaccard', () => {
  it('is 1 for identical sets', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1)
  })
  it('is 0 for disjoint sets', () => {
    expect(jaccard(['a'], ['b'])).toBe(0)
  })
  it('is the intersection-over-union for partial overlap', () => {
    // {a,b,c} vs {b,c,d}: inter=2, union=4 → 0.5
    expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(0.5)
  })
  it('treats two empty sets as identical (1)', () => {
    expect(jaccard([], [])).toBe(1)
    expect(jaccard(undefined, undefined)).toBe(1)
  })
})

describe('testOverlap', () => {
  it('is neutral (1) when the actual commit touched no tests', () => {
    expect(testOverlap(['t1'], [])).toBe(1)
  })
  it('is the pass-set Jaccard when the actual commit has tests', () => {
    expect(testOverlap(['t1', 't2'], ['t2', 't3'])).toBe(1 / 3)
  })
})

describe('deterministicSignal', () => {
  it('blends file Jaccard and test overlap at 0.5/0.5', () => {
    const sig = deterministicSignal(
      { reconstructed_files: ['a', 'b'], passing_tests: ['t1'] },
      { changed_files: ['a', 'b'], passing_tests: ['t1'] },
    )
    expect(sig.fileJaccard).toBe(1)
    expect(sig.testOverlap).toBe(1)
    expect(sig.detScore).toBe(1)
  })

  it('produces an intermediate score on partial file overlap', () => {
    const sig = deterministicSignal(
      { reconstructed_files: ['a', 'b', 'c'], passing_tests: [] },
      { changed_files: ['b', 'c', 'd'], passing_tests: [] },
    )
    // file Jaccard 0.5, test overlap neutral 1 → 0.5*0.5 + 0.5*1 = 0.75
    expect(sig.detScore).toBe(0.75)
  })
})

describe('isGrayBand', () => {
  it('is true inside the inclusive band and false outside', () => {
    expect(isGrayBand(0.4)).toBe(true) // low boundary inclusive
    expect(isGrayBand(0.8)).toBe(true) // high boundary inclusive
    expect(isGrayBand(0.6)).toBe(true)
    expect(isGrayBand(0.39)).toBe(false)
    expect(isGrayBand(0.81)).toBe(false)
  })
  it('respects a custom band', () => {
    expect(isGrayBand(0.55, { low: 0.5, high: 0.6 })).toBe(true)
    expect(isGrayBand(0.45, { low: 0.5, high: 0.6 })).toBe(false)
  })
})

describe('combineScore', () => {
  it('returns the deterministic score when the judge did not run', () => {
    expect(combineScore(0.9, undefined)).toBe(0.9)
  })
  it('blends deterministic and judge scores 0.5/0.5 when judged', () => {
    expect(combineScore(0.6, 0.8)).toBeCloseTo(0.7, 6)
  })
})

describe('caseVerdict', () => {
  it('passes at or above the threshold, fails below', () => {
    expect(caseVerdict(0.7)).toBe('pass')
    expect(caseVerdict(0.69)).toBe('fail')
  })
})

// ---------------------------------------------------------------------------
// gradeCase — judge-trigger boundary (AC2)
// ---------------------------------------------------------------------------

describe('gradeCase', () => {
  const reconstructed = (files: string[], tests: string[] = []) => ({
    story_key: 'g-1',
    phase: 'dev-story',
    status: 'reconstructed',
    reconstructed_files: files,
    passing_tests: tests,
  })

  it('skips the LLM judge on a clear PASS (deterministic above the band)', async () => {
    const judgeFn = vi.fn(async () => ({ score: 0.0 }))
    const grade = await gradeCase(
      reconstructed(['a', 'b']),
      { changed_files: ['a', 'b'] },
      { judgeFn },
    )
    expect(grade.det_score).toBe(1)
    expect(grade.judge_invoked).toBe(false)
    expect(judgeFn).not.toHaveBeenCalled()
    expect(grade.verdict).toBe('pass')
  })

  it('skips the LLM judge on a clear FAIL (deterministic below the band)', async () => {
    const judgeFn = vi.fn(async () => ({ score: 1.0 }))
    const grade = await gradeCase(
      reconstructed(['x']),
      { changed_files: ['y'] }, // file Jaccard 0; test neutral 1 → det 0.5? -> need below 0.4
      { judgeFn },
      { grayBand: { low: 0.6, high: 0.8 } }, // narrow band so 0.5 is a clear fail
    )
    expect(grade.judge_invoked).toBe(false)
    expect(judgeFn).not.toHaveBeenCalled()
  })

  it('invokes the LLM judge in the gray band and blends the score (AC2)', async () => {
    const judgeFn = vi.fn(async () => ({ score: 1.0, rationale: 'semantically equivalent' }))
    // file Jaccard 0.5, no tests → det 0.75, which is in [0.4, 0.8]
    const grade = await gradeCase(
      reconstructed(['a', 'b', 'c']),
      { changed_files: ['b', 'c', 'd'] },
      { judgeFn },
    )
    expect(grade.det_score).toBe(0.75)
    expect(grade.judge_invoked).toBe(true)
    expect(judgeFn).toHaveBeenCalledOnce()
    expect(grade.judge_score).toBe(1.0)
    expect(grade.judge_rationale).toBe('semantically equivalent')
    // blended 0.5*0.75 + 0.5*1.0 = 0.875
    expect(grade.score).toBeCloseTo(0.875, 6)
  })

  it('falls back to deterministic-only in the gray band when no judgeFn is provided', async () => {
    const grade = await gradeCase(
      reconstructed(['a', 'b', 'c']),
      { changed_files: ['b', 'c', 'd'] },
      {}, // no judgeFn
    )
    expect(isGrayBand(grade.det_score, DEFAULT_GRAY_BAND)).toBe(true)
    expect(grade.judge_invoked).toBe(false)
    expect(grade.score).toBe(0.75)
  })
})

// ---------------------------------------------------------------------------
// gradeAll — rollup
// ---------------------------------------------------------------------------

describe('gradeAll', () => {
  it('rolls up the rubric over reconstructed cases and excludes ungradable ones', async () => {
    const reconstructions = [
      { story_key: 'p-1', status: 'reconstructed', reconstructed_files: ['a'], passing_tests: [] },
      { story_key: 'p-2', status: 'reconstructed', reconstructed_files: ['b'], passing_tests: [] },
      { story_key: 's-1', status: 'skipped', reason: 'bad triple' },
      { story_key: 'e-1', status: 'dispatch-error' },
    ]
    const actuals = {
      'p-1': { changed_files: ['a'] }, // det 1.0 → pass
      'p-2': { changed_files: ['z'] }, // file 0, test neutral → det 0.5 → fail (threshold 0.7)
    }
    const report = await gradeAll(reconstructions, actuals, {}, { threshold: 0.95 })

    expect(report.graded).toBe(2)
    expect(report.passed).toBe(1)
    expect(report.ungradable).toBe(2)
    expect(report.pass_rate).toBe(0.5)
    expect(report.rubric).toBe('RED') // 0.5 < 0.85
    expect(report.tier).toBe('1 capability')
    expect(report.every_ship_gate).toBe(false)
  })

  it('is YELLOW (not a false GREEN/RED) when nothing is gradable', async () => {
    const report = await gradeAll(
      [{ story_key: 's-1', status: 'skipped' }],
      {},
    )
    expect(report.graded).toBe(0)
    expect(report.rubric).toBe('YELLOW')
    expect(report.pass_rate).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ReconstructionGraderCheck — VerificationCheck contract + never-ship marker
// ---------------------------------------------------------------------------

describe('ReconstructionGraderCheck', () => {
  it('exposes the VerificationCheck shape and is flagged NOT an every-ship gate (AC4)', () => {
    const check = new ReconstructionGraderCheck()
    expect(check.name).toBe('reconstruction-grader')
    expect(check.tier).toBe('B')
    expect(check.everyShipGate).toBe(false)
    expect(typeof check.run).toBe('function')
  })

  it('run() grades and returns warn when nothing is gradable', async () => {
    const check = new ReconstructionGraderCheck({ reconstructions: [], actuals: {} })
    const result = await check.run()
    expect(result.status).toBe('warn')
    expect(result.details).toContain('tier=1 capability')
    expect(result.report.rubric).toBe('YELLOW')
  })

  it('run() returns pass when reconstructed cases clear the rubric', async () => {
    const check = new ReconstructionGraderCheck({
      reconstructions: [
        { story_key: 'p-1', status: 'reconstructed', reconstructed_files: ['a'], passing_tests: [] },
      ],
      actuals: { 'p-1': { changed_files: ['a'] } },
      opts: { threshold: 0.95 },
    })
    const result = await check.run()
    expect(result.status).toBe('pass')
    expect(result.report.rubric).toBe('GREEN')
  })
})
