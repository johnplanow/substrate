/**
 * Unit tests for join-policy.ts (story 50-3, AC7).
 *
 * Tests the pure `evaluateJoinPolicy` function and `BranchCancellationManager`
 * class with at least 20 `it(...)` cases covering all join policy behaviors,
 * cancellation signal delivery, and edge cases.
 */

import { describe, it, expect } from 'vitest'
import {
  evaluateJoinPolicy,
  BranchCancellationManager,
} from '../join-policy.js'
import type { BranchResult, JoinPolicyConfig } from '../join-policy.js'

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const success = (index: number): BranchResult => ({ index, outcome: 'SUCCESS' })
const fail    = (index: number): BranchResult => ({ index, outcome: 'FAIL' })
const cancelled = (index: number): BranchResult => ({ index, outcome: 'CANCELLED' })

// ---------------------------------------------------------------------------
// wait_all tests (4 cases)
// ---------------------------------------------------------------------------

describe('evaluateJoinPolicy — wait_all', () => {
  it('returns wait when only 1 of 3 branches complete', () => {
    const cfg: JoinPolicyConfig = { policy: 'wait_all' }
    expect(evaluateJoinPolicy(cfg, [success(0)], 3)).toEqual({ action: 'wait' })
  })

  it('returns wait when 2 of 3 branches complete', () => {
    const cfg: JoinPolicyConfig = { policy: 'wait_all' }
    expect(evaluateJoinPolicy(cfg, [success(0), success(1)], 3)).toEqual({ action: 'wait' })
  })

  it('returns continue when all 3 branches complete (all success)', () => {
    const cfg: JoinPolicyConfig = { policy: 'wait_all' }
    const result = evaluateJoinPolicy(cfg, [success(0), success(1), success(2)], 3)
    expect(result.action).toBe('continue')
    if (result.action === 'continue') expect(result.results).toHaveLength(3)
  })

  it('returns continue when all 3 branches complete (mixed success/fail)', () => {
    const cfg: JoinPolicyConfig = { policy: 'wait_all' }
    const result = evaluateJoinPolicy(cfg, [success(0), fail(1), success(2)], 3)
    expect(result.action).toBe('continue')
    if (result.action === 'continue') {
      expect(result.results).toHaveLength(3)
      expect(result.results.find(r => r.outcome === 'FAIL')).toBeDefined()
    }
  })

  it('returns continue for single branch that completes', () => {
    const cfg: JoinPolicyConfig = { policy: 'wait_all' }
    const result = evaluateJoinPolicy(cfg, [success(0)], 1)
    expect(result.action).toBe('continue')
  })

  it('returns continue vacuously when total=0', () => {
    const cfg: JoinPolicyConfig = { policy: 'wait_all' }
    const result = evaluateJoinPolicy(cfg, [], 0)
    expect(result.action).toBe('continue')
  })
})

// ---------------------------------------------------------------------------
// first_success tests (5 cases)
// ---------------------------------------------------------------------------

describe('evaluateJoinPolicy — first_success', () => {
  it('returns continue immediately when first branch succeeds', () => {
    const cfg: JoinPolicyConfig = { policy: 'first_success' }
    const result = evaluateJoinPolicy(cfg, [success(0)], 3)
    expect(result.action).toBe('continue')
  })

  it('returns continue when second branch succeeds (first failed)', () => {
    const cfg: JoinPolicyConfig = { policy: 'first_success' }
    const result = evaluateJoinPolicy(cfg, [fail(0), success(1)], 3)
    expect(result.action).toBe('continue')
  })

  it('returns wait when only failures so far (more branches remaining)', () => {
    const cfg: JoinPolicyConfig = { policy: 'first_success' }
    const result = evaluateJoinPolicy(cfg, [fail(0)], 3)
    expect(result.action).toBe('wait')
  })

  it('returns fail when all branches have completed with FAIL', () => {
    const cfg: JoinPolicyConfig = { policy: 'first_success' }
    const result = evaluateJoinPolicy(cfg, [fail(0), fail(1), fail(2)], 3)
    expect(result.action).toBe('fail')
    if (result.action === 'fail') {
      expect(result.reason).toMatch(/all 3 branches failed/)
    }
  })

  it('returns fail when all complete and none succeed (mix of FAIL+CANCELLED)', () => {
    const cfg: JoinPolicyConfig = { policy: 'first_success' }
    // 3 completed, 3 total, no SUCCESS → all completed, all failed
    const result = evaluateJoinPolicy(cfg, [fail(0), cancelled(1), fail(2)], 3)
    expect(result.action).toBe('fail')
  })

  it('returns continue for single-branch first_success when it succeeds', () => {
    const cfg: JoinPolicyConfig = { policy: 'first_success' }
    const result = evaluateJoinPolicy(cfg, [success(0)], 1)
    expect(result.action).toBe('continue')
  })
})

// ---------------------------------------------------------------------------
// quorum tests (5 cases)
// ---------------------------------------------------------------------------

describe('evaluateJoinPolicy — quorum', () => {
  it('returns continue when exactly quorum_size branches succeed', () => {
    const cfg: JoinPolicyConfig = { policy: 'quorum', quorum_size: 2 }
    const result = evaluateJoinPolicy(cfg, [success(0), fail(1), success(2)], 4)
    expect(result.action).toBe('continue')
  })

  it('returns continue when more than quorum_size branches succeed', () => {
    const cfg: JoinPolicyConfig = { policy: 'quorum', quorum_size: 2 }
    const result = evaluateJoinPolicy(cfg, [success(0), success(1), success(2)], 4)
    expect(result.action).toBe('continue')
  })

  it('returns wait when quorum_size=2 but only 1 success with more branches remaining', () => {
    const cfg: JoinPolicyConfig = { policy: 'quorum', quorum_size: 2 }
    const result = evaluateJoinPolicy(cfg, [success(0)], 4)
    expect(result.action).toBe('wait')
  })

  it('returns fail when quorum is unreachable (failed > total - quorum_size)', () => {
    const cfg: JoinPolicyConfig = { policy: 'quorum', quorum_size: 3 }
    // 3 failed, needed 3 of 4 → 0 successes + 1 remaining < 3 needed → unreachable
    const result = evaluateJoinPolicy(cfg, [fail(0), fail(1), fail(2)], 4)
    expect(result.action).toBe('fail')
    if (result.action === 'fail') {
      expect(result.reason).toMatch(/quorum unreachable/)
    }
  })

  it('returns fail with descriptive reason for quorum unreachable', () => {
    const cfg: JoinPolicyConfig = { policy: 'quorum', quorum_size: 3 }
    const result = evaluateJoinPolicy(cfg, [fail(0), fail(1), fail(2)], 4)
    expect(result.action).toBe('fail')
    if (result.action === 'fail') {
      // Reason should mention failure counts and what was needed
      expect(result.reason).toContain('3')  // failed count
      expect(result.reason).toContain('4')  // total
    }
  })

  it('returns fail when quorum_size=0 (guard)', () => {
    const cfg: JoinPolicyConfig = { policy: 'quorum', quorum_size: 0 }
    const result = evaluateJoinPolicy(cfg, [], 3)
    expect(result.action).toBe('fail')
    if (result.action === 'fail') {
      expect(result.reason).toMatch(/quorum_size must be >= 1/)
    }
  })

  it('returns wait for quorum when no branches completed yet', () => {
    const cfg: JoinPolicyConfig = { policy: 'quorum', quorum_size: 2 }
    const result = evaluateJoinPolicy(cfg, [], 4)
    expect(result.action).toBe('wait')
  })
})

// ---------------------------------------------------------------------------
// BranchCancellationManager tests (4 cases)
// ---------------------------------------------------------------------------

describe('BranchCancellationManager', () => {
  it('getSignal returns an AbortSignal', () => {
    const mgr = new BranchCancellationManager(3)
    const signal = mgr.getSignal(0)
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('signal is not aborted before cancelRemaining is called', () => {
    const mgr = new BranchCancellationManager(3)
    expect(mgr.getSignal(0).aborted).toBe(false)
    expect(mgr.getSignal(1).aborted).toBe(false)
    expect(mgr.getSignal(2).aborted).toBe(false)
  })

  it('cancelRemaining aborts signals for non-completed branches only', () => {
    const mgr = new BranchCancellationManager(3)
    // Branch 0 is "completed"; branches 1 and 2 should be cancelled
    mgr.cancelRemaining(new Set([0]))
    expect(mgr.getSignal(0).aborted).toBe(false)  // completed — not cancelled
    expect(mgr.getSignal(1).aborted).toBe(true)
    expect(mgr.getSignal(2).aborted).toBe(true)
  })

  it('signal for a completed branch is NOT aborted after cancelRemaining', () => {
    const mgr = new BranchCancellationManager(4)
    mgr.cancelRemaining(new Set([1, 3]))  // completedIndices: branches 1 and 3 finished
    // cancelRemaining cancels branches NOT in the set (0 and 2)
    expect(mgr.getSignal(0).aborted).toBe(true)
    expect(mgr.getSignal(1).aborted).toBe(false)
    expect(mgr.getSignal(2).aborted).toBe(true)
    expect(mgr.getSignal(3).aborted).toBe(false)
  })

  it('drainAsync resolves after the specified timeout', async () => {
    const mgr = new BranchCancellationManager(1)
    const start = Date.now()
    await mgr.drainAsync(20)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(15)  // allow minor timing variance
  })
})

// ---------------------------------------------------------------------------
// Edge case tests (2 cases)
// ---------------------------------------------------------------------------

describe('evaluateJoinPolicy — edge cases', () => {
  it('first_success with total=1 and single success → continue', () => {
    const cfg: JoinPolicyConfig = { policy: 'first_success' }
    const result = evaluateJoinPolicy(cfg, [success(0)], 1)
    expect(result.action).toBe('continue')
  })

  it('wait_all with 0 completed and total=0 → continue (vacuous)', () => {
    const cfg: JoinPolicyConfig = { policy: 'wait_all' }
    const result = evaluateJoinPolicy(cfg, [], 0)
    expect(result.action).toBe('continue')
  })
})
