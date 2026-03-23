/**
 * Unit tests for the satisfaction scorer (story 44-5).
 *
 * Covers:
 *   AC3 — 3/4 pass → score 0.75, passes false (below 0.8 default threshold)
 *   AC4 — 0/2 pass → score 0.0, passes false, status SUCCESS
 *   AC7 — computeSatisfactionScore exported and accepts optional threshold
 */

import { describe, it, expect } from 'vitest'
import { computeSatisfactionScore } from '../scorer.js'
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
