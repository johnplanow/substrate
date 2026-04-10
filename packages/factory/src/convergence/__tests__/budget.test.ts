/**
 * Unit tests for per-node budget enforcement.
 * Story 45-3 — AC1 through AC7.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  checkNodeBudget,
  computeBackoffDelay,
  checkPipelineBudget,
  PipelineBudgetManager,
  checkSessionBudget,
  SessionBudgetManager,
} from '../budget.js'

// ---------------------------------------------------------------------------
// AC1 & AC2 & AC3: checkNodeBudget
// ---------------------------------------------------------------------------

describe('checkNodeBudget', () => {
  it('AC1: allows retry when retryCount < maxRetries (count=0)', () => {
    expect(checkNodeBudget('node-a', 0, 2)).toEqual({ allowed: true })
  })

  it('AC1: allows retry when retryCount < maxRetries (count=1)', () => {
    expect(checkNodeBudget('node-a', 1, 2)).toEqual({ allowed: true })
  })

  it('AC2: rejects retry when retryCount equals maxRetries', () => {
    expect(checkNodeBudget('node-a', 2, 2)).toEqual({
      allowed: false,
      reason: 'max retries exhausted',
    })
  })

  it('AC3: max_retries=0 rejects immediately (retryCount=0)', () => {
    expect(checkNodeBudget('node-a', 0, 0)).toEqual({
      allowed: false,
      reason: 'max retries exhausted',
    })
  })

  it('rejects when retryCount exceeds maxRetries', () => {
    expect(checkNodeBudget('node-a', 5, 2)).toEqual({
      allowed: false,
      reason: 'max retries exhausted',
    })
  })
})

// ---------------------------------------------------------------------------
// AC4 & AC5: computeBackoffDelay
// ---------------------------------------------------------------------------

describe('computeBackoffDelay', () => {
  it('AC4: index 0 returns 200ms with jitter disabled', () => {
    expect(computeBackoffDelay(0, { jitterFactor: 0 })).toBe(200)
  })

  it('AC4: index 1 returns 400ms with jitter disabled', () => {
    expect(computeBackoffDelay(1, { jitterFactor: 0 })).toBe(400)
  })

  it('AC4: index 2 returns 800ms with jitter disabled', () => {
    expect(computeBackoffDelay(2, { jitterFactor: 0 })).toBe(800)
  })

  it('AC4: index 8 returns 51200ms (below cap) with jitter disabled', () => {
    // 200 * 2^8 = 51200 — still below the 60000ms cap
    expect(computeBackoffDelay(8, { jitterFactor: 0 })).toBe(51_200)
  })

  it('AC4: high index (9) is capped at 60000ms with jitter disabled', () => {
    // 200 * 2^9 = 102400 — exceeds cap, so returns 60000
    expect(computeBackoffDelay(9, { jitterFactor: 0 })).toBe(60_000)
  })

  it('AC5: 100 samples with default jitter are all within ±50% of 800ms', () => {
    const results: number[] = []
    for (let i = 0; i < 100; i++) {
      results.push(computeBackoffDelay(2))
    }
    for (const v of results) {
      expect(v).toBeGreaterThanOrEqual(400)
      expect(v).toBeLessThanOrEqual(1200)
    }
    // Values must not all be identical — jitter is applied
    expect(new Set(results).size).toBeGreaterThan(1)
  })

  it('never returns a negative value', () => {
    for (let i = 0; i < 50; i++) {
      expect(computeBackoffDelay(0)).toBeGreaterThanOrEqual(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Per-pipeline budget enforcement — story 45-4
// ---------------------------------------------------------------------------

describe('checkPipelineBudget', () => {
  it('AC1: blocks when accumulated cost exceeds cap', () => {
    expect(checkPipelineBudget(5.01, 5.0)).toEqual({
      allowed: false,
      reason: 'pipeline budget exhausted: $5.01 > $5.00',
    })
  })

  it('AC2: allows when cap is 0 (unlimited)', () => {
    expect(checkPipelineBudget(9999.99, 0)).toEqual({ allowed: true })
  })

  it('AC3: allows when cost is within cap', () => {
    expect(checkPipelineBudget(5.0, 10.0)).toEqual({ allowed: true })
  })

  it('AC4: allows when cost exactly equals cap (boundary: equal is allowed)', () => {
    expect(checkPipelineBudget(5.0, 5.0)).toEqual({ allowed: true })
  })

  it('AC5: reason formats both values to two decimal places (rounding)', () => {
    const result = checkPipelineBudget(5.006, 5.0)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toContain('$5.01')
      expect(result.reason).toContain('$5.00')
    }
  })
})

describe('PipelineBudgetManager', () => {
  let mgr: PipelineBudgetManager

  beforeEach(() => {
    mgr = new PipelineBudgetManager()
  })

  it('AC6: accumulates cost across multiple addCost calls', () => {
    mgr.addCost(1.5)
    mgr.addCost(2.0)
    expect(mgr.getTotalCost()).toBe(3.5)
  })

  it('AC7: reset clears accumulated cost to 0', () => {
    mgr.addCost(10)
    mgr.reset()
    expect(mgr.getTotalCost()).toBe(0)
  })

  it('checkBudget delegates to checkPipelineBudget (cap exceeded → allowed: false)', () => {
    mgr.addCost(6.0)
    expect(mgr.checkBudget(5.0)).toEqual({
      allowed: false,
      reason: 'pipeline budget exhausted: $6.00 > $5.00',
    })
  })

  it('checkBudget delegates to checkPipelineBudget (cap 0 → allowed: true)', () => {
    mgr.addCost(999.99)
    expect(mgr.checkBudget(0)).toEqual({ allowed: true })
  })
})

// ---------------------------------------------------------------------------
// Per-session budget enforcement — story 45-5
// ---------------------------------------------------------------------------

describe('checkSessionBudget', () => {
  it('AC1: blocks when elapsed time exceeds cap', () => {
    expect(checkSessionBudget(3_601_000, 3_600_000)).toEqual({
      allowed: false,
      reason: 'wall clock budget exhausted',
    })
  })

  it('AC2: allows when cap is 0 (unlimited) with large elapsed', () => {
    expect(checkSessionBudget(999_999_999, 0)).toEqual({ allowed: true })
  })

  it('AC3: allows when elapsed time is within cap', () => {
    expect(checkSessionBudget(1_800_000, 3_600_000)).toEqual({ allowed: true })
  })

  it('AC4: allows when elapsed exactly equals cap (boundary: equal is allowed)', () => {
    expect(checkSessionBudget(3_600_000, 3_600_000)).toEqual({ allowed: true })
  })

  it('allows any elapsed when cap is 0 (small elapsed)', () => {
    expect(checkSessionBudget(1, 0)).toEqual({ allowed: true })
  })
})

describe('SessionBudgetManager', () => {
  it('AC5: getElapsedMs returns non-negative and is monotonically non-decreasing', () => {
    const mgr = new SessionBudgetManager()
    const e1 = mgr.getElapsedMs()
    const e2 = mgr.getElapsedMs()
    expect(e1).toBeGreaterThanOrEqual(0)
    expect(e2).toBeGreaterThanOrEqual(e1)
  })

  it('AC6: checkBudget with cap=0 returns allowed:true (unlimited)', () => {
    const mgr = new SessionBudgetManager()
    expect(mgr.checkBudget(0)).toEqual({ allowed: true })
  })

  it('AC6: checkBudget with large cap (3600s) returns allowed:true (well within cap)', () => {
    const mgr = new SessionBudgetManager()
    expect(mgr.checkBudget(3600)).toEqual({ allowed: true })
  })

  it('AC7: reset restarts elapsed timer to near zero', () => {
    const mgr = new SessionBudgetManager()
    // allow a tiny bit of time to pass
    const before = mgr.getElapsedMs()
    expect(before).toBeGreaterThanOrEqual(0)
    mgr.reset()
    const afterReset = mgr.getElapsedMs()
    expect(afterReset).toBeLessThan(50)
  })

  it('checkBudget delegates with seconds→ms conversion (mock getElapsedMs for exhausted case)', () => {
    const mgr = new SessionBudgetManager()
    // Spy on getElapsedMs to return 3601000ms (3601 seconds elapsed)
    const spy = vi.spyOn(mgr, 'getElapsedMs').mockReturnValue(3_601_000)
    const result = mgr.checkBudget(3600)
    expect(result).toEqual({ allowed: false, reason: 'wall clock budget exhausted' })
    spy.mockRestore()
  })
})
