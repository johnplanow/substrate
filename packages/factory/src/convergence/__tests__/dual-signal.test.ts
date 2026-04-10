/**
 * Unit tests for dual-signal coordinator (story 46-5).
 *
 * Covers all ACs:
 *   AC1 — both signals pass → AGREE
 *   AC2 — code review passes, scenario fails → DISAGREE
 *   AC3 — code review fails, scenario passes → DISAGREE
 *   AC4 — code review is always authoritative decision
 *   AC5 — coordinator emits scenario:score-computed with full payload
 *   AC6 — LGTM_WITH_NOTES treated as code review pass
 *   AC7 — both signals fail → AGREE
 */

import { describe, it, expect, vi } from 'vitest'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'
import { evaluateDualSignal, createDualSignalCoordinator } from '../dual-signal.js'
import type { DualSignalVerdict, DualSignalResult } from '../dual-signal.js'

// ---------------------------------------------------------------------------
// Pure function tests — evaluateDualSignal
// ---------------------------------------------------------------------------

describe('evaluateDualSignal', () => {
  it('AC1 — SHIP_IT + score above threshold → AGREE both passed', () => {
    const result = evaluateDualSignal('SHIP_IT', 0.9, 0.8)
    expect(result.codeReviewPassed).toBe(true)
    expect(result.scenarioPassed).toBe(true)
    expect(result.agreement).toBe('AGREE')
    expect(result.authoritativeDecision).toBe('SHIP_IT')
    expect(result.score).toBe(0.9)
    expect(result.threshold).toBe(0.8)
  })

  it('AC7 — NEEDS_MAJOR_REWORK + score below threshold → AGREE both failed', () => {
    const result = evaluateDualSignal('NEEDS_MAJOR_REWORK', 0.5, 0.8)
    expect(result.codeReviewPassed).toBe(false)
    expect(result.scenarioPassed).toBe(false)
    expect(result.agreement).toBe('AGREE')
    expect(result.authoritativeDecision).toBe('NEEDS_MAJOR_REWORK')
  })

  it('AC2 — SHIP_IT + score below threshold → DISAGREE, code review passed, scenario failed', () => {
    const result = evaluateDualSignal('SHIP_IT', 0.6, 0.8)
    expect(result.agreement).toBe('DISAGREE')
    expect(result.codeReviewPassed).toBe(true)
    expect(result.scenarioPassed).toBe(false)
    expect(result.authoritativeDecision).toBe('SHIP_IT')
  })

  it('AC3 — NEEDS_MINOR_FIXES + score above threshold → DISAGREE, code review failed, scenario passed', () => {
    const result = evaluateDualSignal('NEEDS_MINOR_FIXES', 0.9, 0.8)
    expect(result.agreement).toBe('DISAGREE')
    expect(result.codeReviewPassed).toBe(false)
    expect(result.scenarioPassed).toBe(true)
    expect(result.authoritativeDecision).toBe('NEEDS_MINOR_FIXES')
  })

  it('AC4 — SHIP_IT is authoritative even when scenario fails badly', () => {
    const result = evaluateDualSignal('SHIP_IT', 0.3, 0.8)
    expect(result.authoritativeDecision).toBe('SHIP_IT')
  })

  it('AC6 — LGTM_WITH_NOTES treated as code review pass', () => {
    const result = evaluateDualSignal('LGTM_WITH_NOTES', 0.7, 0.8)
    expect(result.codeReviewPassed).toBe(true)
    expect(result.scenarioPassed).toBe(false)
    expect(result.agreement).toBe('DISAGREE')
  })

  it('threshold boundary — score exactly at threshold → scenarioPassed true', () => {
    const result = evaluateDualSignal('SHIP_IT', 0.8, 0.8)
    expect(result.scenarioPassed).toBe(true)
    expect(result.agreement).toBe('AGREE')
  })

  it('NEEDS_MAJOR_REWORK authoritative even when scenario passes', () => {
    const result = evaluateDualSignal('NEEDS_MAJOR_REWORK', 0.95, 0.8)
    expect(result.authoritativeDecision).toBe('NEEDS_MAJOR_REWORK')
    expect(result.codeReviewPassed).toBe(false)
    expect(result.scenarioPassed).toBe(true)
    expect(result.agreement).toBe('DISAGREE')
  })

  it('NEEDS_MINOR_FIXES is not a passing verdict', () => {
    const result = evaluateDualSignal('NEEDS_MINOR_FIXES', 0.5, 0.8)
    expect(result.codeReviewPassed).toBe(false)
    expect(result.agreement).toBe('AGREE')
  })
})

// ---------------------------------------------------------------------------
// Coordinator tests — createDualSignalCoordinator
// ---------------------------------------------------------------------------

describe('createDualSignalCoordinator', () => {
  function makeMockBus() {
    return { emit: vi.fn() } as unknown as TypedEventBus<FactoryEvents>
  }

  it('AC5 — emits scenario:score-computed with full payload', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({ eventBus: mockBus, threshold: 0.8 })

    coordinator.evaluate('SHIP_IT', 0.6, 'run-1')

    expect(mockBus.emit).toHaveBeenCalledWith('scenario:score-computed', {
      runId: 'run-1',
      score: 0.6,
      threshold: 0.8,
      passes: false,
      agreement: 'DISAGREE',
      codeReviewPassed: true,
      scenarioPassed: false,
      authoritativeDecision: 'SHIP_IT',
    })
  })

  it('emits exactly once per call', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({ eventBus: mockBus, threshold: 0.8 })

    coordinator.evaluate('SHIP_IT', 0.9, 'run-1')

    expect(mockBus.emit).toHaveBeenCalledTimes(1)
  })

  it('returns the DualSignalResult matching the emitted payload', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({ eventBus: mockBus, threshold: 0.8 })

    const result = coordinator.evaluate('SHIP_IT', 0.85, 'run-1')

    expect(result.codeReviewPassed).toBe(true)
    expect(result.scenarioPassed).toBe(true)
    expect(result.agreement).toBe('AGREE')
    expect(result.authoritativeDecision).toBe('SHIP_IT')
    expect(result.score).toBe(0.85)
    expect(result.threshold).toBe(0.8)
  })

  it('passes runId correctly into emitted event payload', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({ eventBus: mockBus, threshold: 0.8 })

    coordinator.evaluate('NEEDS_MINOR_FIXES', 0.5, 'run-42')

    expect(mockBus.emit).toHaveBeenCalledWith(
      'scenario:score-computed',
      expect.objectContaining({ runId: 'run-42' })
    )
  })
})
