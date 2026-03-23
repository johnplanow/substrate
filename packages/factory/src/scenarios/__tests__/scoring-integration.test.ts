/**
 * scoring-integration.test.ts
 *
 * Weighted scoring accuracy integration tests for SatisfactionScorer.
 * Story 46-8, AC1.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createSatisfactionScorer,
  computeSatisfactionScore,
} from '../scorer.js'
import type { ScenarioRunResult, ScenarioWeights, SatisfactionScore } from '../scorer.js'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeRunResult(
  scenarios: Array<{ name: string; status: 'pass' | 'fail' }>,
): ScenarioRunResult {
  const passedCount = scenarios.filter(s => s.status === 'pass').length
  return {
    scenarios: scenarios.map(s => ({
      name: s.name,
      status: s.status,
      exitCode: s.status === 'pass' ? 0 : 1,
      stdout: '',
      stderr: s.status === 'fail' ? 'assertion failed' : '',
      durationMs: 100,
    })),
    summary: { total: scenarios.length, passed: passedCount, failed: scenarios.length - passedCount },
    durationMs: 300,
  }
}

// ---------------------------------------------------------------------------
// Weighted scoring accuracy tests (AC1)
// ---------------------------------------------------------------------------

describe('Weighted scoring accuracy', () => {
  // 3 scenarios: critical (weight=3.0), standard-1 (weight=1.0), standard-2 (weight=1.0)
  // critical passes, standard-1 passes, standard-2 fails → totalWeight=5, score=4/5=0.80
  const scorer08 = createSatisfactionScorer(0.8)
  const weights: ScenarioWeights = { critical: 3.0, 'standard-1': 1.0, 'standard-2': 1.0 }

  it('computes exactly 4/5 = 0.80 when critical+standard-1 pass and standard-2 fails', () => {
    const runResult = makeRunResult([
      { name: 'critical', status: 'pass' },
      { name: 'standard-1', status: 'pass' },
      { name: 'standard-2', status: 'fail' },
    ])
    const result = scorer08.compute(runResult, weights)

    expect(Math.abs(result.score - 0.80)).toBeLessThan(1e-10)
    expect(result.passes).toBe(true)
    expect(result.breakdown).toHaveLength(3)
  })

  it('returns per-scenario contributions: critical=0.60, standard-1=0.20, standard-2=0.00', () => {
    const runResult = makeRunResult([
      { name: 'critical', status: 'pass' },
      { name: 'standard-1', status: 'pass' },
      { name: 'standard-2', status: 'fail' },
    ])
    const result = scorer08.compute(runResult, weights)

    const critical = result.breakdown.find(b => b.name === 'critical')!
    const std1 = result.breakdown.find(b => b.name === 'standard-1')!
    const std2 = result.breakdown.find(b => b.name === 'standard-2')!

    expect(critical).toBeDefined()
    expect(std1).toBeDefined()
    expect(std2).toBeDefined()

    expect(critical.contribution).toBeCloseTo(0.60, 10)
    expect(std1.contribution).toBeCloseTo(0.20, 10)
    expect(std2.contribution).toBeCloseTo(0.00, 10)
  })

  it('returns score=2/5=0.40 and passes=false when critical fails', () => {
    const runResult = makeRunResult([
      { name: 'critical', status: 'fail' },
      { name: 'standard-1', status: 'pass' },
      { name: 'standard-2', status: 'pass' },
    ])
    const result = scorer08.compute(runResult, weights)

    expect(result.score).toBeCloseTo(0.40, 10)
    expect(result.passes).toBe(false)
  })

  it('returns score=1.0 and passes=true when all three scenarios pass', () => {
    const runResult = makeRunResult([
      { name: 'critical', status: 'pass' },
      { name: 'standard-1', status: 'pass' },
      { name: 'standard-2', status: 'pass' },
    ])
    const result = scorer08.compute(runResult, weights)

    expect(result.score).toBeCloseTo(1.0, 10)
    expect(result.passes).toBe(true)
  })

  it('returns score=0.0 and passes=false when all three scenarios fail', () => {
    const runResult = makeRunResult([
      { name: 'critical', status: 'fail' },
      { name: 'standard-1', status: 'fail' },
      { name: 'standard-2', status: 'fail' },
    ])
    const result = scorer08.compute(runResult, weights)

    expect(result.score).toBeCloseTo(0.0, 10)
    expect(result.passes).toBe(false)
  })

  it('returns { score: 0, passes: false, breakdown: [] } when totalWeight === 0', () => {
    const runResult = makeRunResult([
      { name: 'critical', status: 'pass' },
    ])
    // All weights explicitly set to 0
    const zeroWeights: ScenarioWeights = { critical: 0 }
    const result = scorer08.compute(runResult, zeroWeights)

    expect(result.score).toBe(0)
    expect(result.passes).toBe(false)
    expect(result.breakdown).toEqual([])
  })

  it('returns score=1.0 for a single scenario with weight=1.0 that passes', () => {
    const runResult = makeRunResult([{ name: 'only', status: 'pass' }])
    const result = scorer08.compute(runResult, { only: 1.0 })

    expect(result.score).toBeCloseTo(1.0, 10)
    expect(result.passes).toBe(true)
    expect(result.breakdown).toHaveLength(1)
    expect(result.breakdown[0]!.contribution).toBeCloseTo(1.0, 10)
  })

  it('passes === true when score exactly equals threshold (boundary condition)', () => {
    // With 4 scenarios of equal weight (1.0 each) and 4/5 passing → score = 0.80 = threshold
    const runResult = makeRunResult([
      { name: 's1', status: 'pass' },
      { name: 's2', status: 'pass' },
      { name: 's3', status: 'pass' },
      { name: 's4', status: 'pass' },
      { name: 's5', status: 'fail' },
    ])
    // totalWeight = 5.0, passed = 4, score = 4/5 = 0.80 exactly
    const result = scorer08.compute(runResult)
    expect(result.score).toBeCloseTo(0.80, 10)
    expect(result.passes).toBe(true)
  })

  it('computeSatisfactionScore backward-compat: no weights, all-pass returns score=1.0 with breakdown', () => {
    const runResult = makeRunResult([
      { name: 'a', status: 'pass' },
      { name: 'b', status: 'pass' },
      { name: 'c', status: 'pass' },
    ])
    const result = computeSatisfactionScore(runResult)

    expect(result.score).toBeCloseTo(1.0, 10)
    expect(result.passes).toBe(true)
    expect(result.breakdown).toBeDefined()
    expect(result.breakdown).toHaveLength(3)
  })

  it('passes=false when score=0.85 with custom threshold=0.9', () => {
    const scorer09 = createSatisfactionScorer(0.9)
    // 17 pass out of 20 = 0.85
    const scenarios = Array.from({ length: 20 }, (_, i) => ({
      name: `s${i}`,
      status: (i < 17 ? 'pass' : 'fail') as 'pass' | 'fail',
    }))
    const runResult = makeRunResult(scenarios)
    const result = scorer09.compute(runResult)

    expect(result.score).toBeCloseTo(0.85, 10)
    expect(result.passes).toBe(false)
  })

  it('uniform weights compute score as fraction of passing scenarios', () => {
    const runResult = makeRunResult([
      { name: 'a', status: 'pass' },
      { name: 'b', status: 'pass' },
      { name: 'c', status: 'fail' },
      { name: 'd', status: 'fail' },
    ])
    const uniformWeights: ScenarioWeights = { a: 1.0, b: 1.0, c: 1.0, d: 1.0 }
    const result = scorer08.compute(runResult, uniformWeights)

    expect(result.score).toBeCloseTo(0.5, 10)
    expect(result.passes).toBe(false)
    expect(result.breakdown).toHaveLength(4)
  })

  it('returns correct breakdown fields: name, passed, weight, contribution', () => {
    const runResult = makeRunResult([
      { name: 'critical', status: 'pass' },
      { name: 'standard-1', status: 'pass' },
      { name: 'standard-2', status: 'fail' },
    ])
    const result = scorer08.compute(runResult, weights)

    for (const entry of result.breakdown) {
      expect(typeof entry.name).toBe('string')
      expect(typeof entry.passed).toBe('boolean')
      expect(typeof entry.weight).toBe('number')
      expect(typeof entry.contribution).toBe('number')
    }
  })
})
