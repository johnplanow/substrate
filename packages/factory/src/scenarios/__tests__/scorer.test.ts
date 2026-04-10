/**
 * Unit tests for the satisfaction scorer (story 44-5, 46-1).
 *
 * Covers:
 *   AC3 — 3/4 pass → score 0.75, passes false (below 0.8 default threshold)
 *   AC4 — 0/2 pass → score 0.0, passes false, status SUCCESS
 *   AC7 — computeSatisfactionScore exported and accepts optional threshold
 *   AC1–AC7 (story 46-1) — createSatisfactionScorer with weighted scoring + breakdown
 */

import { describe, it, expect } from 'vitest'
import { computeSatisfactionScore, createSatisfactionScorer } from '../scorer.js'
import type { ScenarioRunResult } from '../../events.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(total: number, passed: number): ScenarioRunResult {
  return {
    scenarios: [],
    summary: { total, passed, failed: total - passed },
    durationMs: 10,
  }
}

function makeNamedResult(
  scenarios: Array<{ name: string; status: 'pass' | 'fail' }>
): ScenarioRunResult {
  const passed = scenarios.filter((s) => s.status === 'pass').length
  return {
    scenarios: scenarios.map((s) => ({
      name: s.name,
      status: s.status,
      exitCode: s.status === 'pass' ? 0 : 1,
      stdout: '',
      stderr: '',
      durationMs: 10,
    })),
    summary: { total: scenarios.length, passed, failed: scenarios.length - passed },
    durationMs: 50,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeSatisfactionScore', () => {
  it('returns score 0.0 and passes false when total is 0 (edge case)', () => {
    const result = computeSatisfactionScore(makeResult(0, 0))
    expect(result.score).toBe(0.0)
    expect(result.passes).toBe(false)
    expect(result.threshold).toBe(0.8)
  })

  it('returns score 0.75 and passes false when 3 of 4 pass (below default threshold 0.8)', () => {
    const result = computeSatisfactionScore(makeResult(4, 3))
    expect(result.score).toBe(0.75)
    expect(result.passes).toBe(false)
    expect(result.threshold).toBe(0.8)
  })

  it('returns score 1.0 and passes true when all scenarios pass', () => {
    const result = computeSatisfactionScore(makeResult(4, 4))
    expect(result.score).toBe(1.0)
    expect(result.passes).toBe(true)
    expect(result.threshold).toBe(0.8)
  })

  it('returns score 0.0 and passes false when 0 of 2 pass (AC4)', () => {
    const result = computeSatisfactionScore(makeResult(2, 0))
    expect(result.score).toBe(0.0)
    expect(result.passes).toBe(false)
    expect(result.threshold).toBe(0.8)
  })

  it('respects custom threshold: 3/4 pass with threshold 0.7 → passes true (AC7)', () => {
    const result = computeSatisfactionScore(makeResult(4, 3), 0.7)
    expect(result.score).toBe(0.75)
    expect(result.passes).toBe(true)
    expect(result.threshold).toBe(0.7)
  })

  it('returns score 0.5 when 1 of 2 pass', () => {
    const result = computeSatisfactionScore(makeResult(2, 1))
    expect(result.score).toBe(0.5)
    expect(result.passes).toBe(false)
  })

  it('score exactly at threshold passes: score 0.8, threshold 0.8 → passes true', () => {
    // 4/5 = 0.8 exactly
    const result = computeSatisfactionScore(makeResult(5, 4))
    expect(result.score).toBeCloseTo(0.8)
    expect(result.passes).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Story 46-1: createSatisfactionScorer with weighted scoring + breakdown
// ---------------------------------------------------------------------------

describe('createSatisfactionScorer', () => {
  // AC1: Unweighted Score — 3 of 5 passing
  it('AC1: 3 of 5 pass unweighted → score ≈ 0.6, passes false, breakdown.length === 5', () => {
    const scorer = createSatisfactionScorer()
    const result = makeNamedResult([
      { name: 's1', status: 'pass' },
      { name: 's2', status: 'pass' },
      { name: 's3', status: 'pass' },
      { name: 's4', status: 'fail' },
      { name: 's5', status: 'fail' },
    ])
    const score = scorer.compute(result)
    expect(score.score).toBeCloseTo(0.6)
    expect(score.passes).toBe(false)
    expect(score.breakdown).toHaveLength(5)
    expect(score.breakdown.every((d) => d.weight === 1.0)).toBe(true)
  })

  // AC2: Weighted Score — Unequal Weights
  it('AC2: login(w=3) passes, checkout/profile(w=1) fail → score ≈ 0.6, passes false', () => {
    const scorer = createSatisfactionScorer()
    const result = makeNamedResult([
      { name: 'login', status: 'pass' },
      { name: 'checkout', status: 'fail' },
      { name: 'profile', status: 'fail' },
    ])
    const score = scorer.compute(result, { login: 3.0, checkout: 1.0, profile: 1.0 })
    expect(score.score).toBeCloseTo(0.6)
    expect(score.passes).toBe(false)
  })

  // AC3: All Scenarios Pass
  it('AC3: all scenarios pass → score = 1.0, passes true', () => {
    const scorer = createSatisfactionScorer()
    const result = makeNamedResult([
      { name: 'a', status: 'pass' },
      { name: 'b', status: 'pass' },
      { name: 'c', status: 'pass' },
    ])
    const score = scorer.compute(result)
    expect(score.score).toBe(1.0)
    expect(score.passes).toBe(true)
  })

  // AC4: No Scenarios — Zero Score
  it('AC4: empty scenarios array → score = 0.0, passes false, breakdown = []', () => {
    const scorer = createSatisfactionScorer()
    const result: ScenarioRunResult = {
      scenarios: [],
      summary: { total: 0, passed: 0, failed: 0 },
      durationMs: 10,
    }
    const score = scorer.compute(result)
    expect(score.score).toBe(0.0)
    expect(score.passes).toBe(false)
    expect(score.breakdown).toEqual([])
  })

  // AC5: Breakdown Contains Per-Scenario Detail
  it('AC5: login contribution ≈ 0.6, checkout/profile contribution = 0.0', () => {
    const scorer = createSatisfactionScorer()
    const result = makeNamedResult([
      { name: 'login', status: 'pass' },
      { name: 'checkout', status: 'fail' },
      { name: 'profile', status: 'fail' },
    ])
    const score = scorer.compute(result, { login: 3.0, checkout: 1.0, profile: 1.0 })
    const loginEntry = score.breakdown.find((d) => d.name === 'login')!
    const checkoutEntry = score.breakdown.find((d) => d.name === 'checkout')!
    const profileEntry = score.breakdown.find((d) => d.name === 'profile')!

    expect(loginEntry.contribution).toBeCloseTo(0.6)
    expect(checkoutEntry.contribution).toBe(0.0)
    expect(profileEntry.contribution).toBe(0.0)

    expect(loginEntry.weight).toBe(3.0)
    expect(checkoutEntry.weight).toBe(1.0)
    expect(profileEntry.weight).toBe(1.0)
  })

  // AC5 detail: passed field per scenario
  it('AC5 detail: login has passed = true, checkout has passed = false', () => {
    const scorer = createSatisfactionScorer()
    const result = makeNamedResult([
      { name: 'login', status: 'pass' },
      { name: 'checkout', status: 'fail' },
    ])
    const score = scorer.compute(result)
    const first = score.breakdown.find((d) => d.name === 'login')!
    const second = score.breakdown.find((d) => d.name === 'checkout')!
    expect(first.passed).toBe(true)
    expect(second.passed).toBe(false)
  })

  // AC6: computeSatisfactionScore backward compatibility with breakdown
  it('AC6: computeSatisfactionScore returns breakdown with 3 entries, all weight 1.0', () => {
    const result = makeNamedResult([
      { name: 'a', status: 'pass' },
      { name: 'b', status: 'fail' },
      { name: 'c', status: 'fail' },
    ])
    const score = computeSatisfactionScore(result)
    expect(score.breakdown).toHaveLength(3)
    expect(score.breakdown.every((d) => d.weight === 1.0)).toBe(true)
    expect(score.score).toBeCloseTo(1 / 3)
  })

  // AC6 backward-compat: custom threshold
  it('AC6 backward-compat: computeSatisfactionScore with threshold 0.5 → passes true when score > 0.5', () => {
    const result = makeNamedResult([
      { name: 'a', status: 'pass' },
      { name: 'b', status: 'pass' },
      { name: 'c', status: 'fail' },
    ])
    const score = computeSatisfactionScore(result, 0.5)
    expect(score.score).toBeCloseTo(2 / 3)
    expect(score.passes).toBe(true)
  })

  // AC7: createSatisfactionScorer and SatisfactionScorer are callable
  it('AC7: createSatisfactionScorer is a function and scorer.compute is a function', () => {
    expect(typeof createSatisfactionScorer).toBe('function')
    const scorer = createSatisfactionScorer()
    expect(typeof scorer.compute).toBe('function')
  })

  // AC7: createSatisfactionScorer returns full SatisfactionScore with breakdown
  it('AC7: createSatisfactionScorer().compute() returns SatisfactionScore with breakdown', () => {
    const scorer = createSatisfactionScorer(0.8)
    const result = makeNamedResult([{ name: 'x', status: 'pass' }])
    const score = scorer.compute(result)
    expect(score).toHaveProperty('score')
    expect(score).toHaveProperty('passes')
    expect(score).toHaveProperty('threshold')
    expect(score).toHaveProperty('breakdown')
    expect(score.breakdown).toHaveLength(1)
  })

  // Extra: custom threshold with createSatisfactionScorer
  it('createSatisfactionScorer respects custom threshold', () => {
    const scorer = createSatisfactionScorer(0.5)
    const result = makeNamedResult([
      { name: 'a', status: 'pass' },
      { name: 'b', status: 'fail' },
    ])
    const score = scorer.compute(result)
    expect(score.score).toBeCloseTo(0.5)
    expect(score.passes).toBe(true) // score >= 0.5
    expect(score.threshold).toBe(0.5)
  })
})
