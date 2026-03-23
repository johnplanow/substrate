/**
 * Unit tests for scenario-primary quality mode — story 46-6.
 *
 * Covers:
 *   AC2 — scenario passes, code review fails → gate passes (score-driven)
 *   AC3 — scenario fails, code review passes → gate fails (score-driven)
 *   AC4 — code review result emitted as scenario:advisory-computed in scenario-primary mode
 *   AC5 — dual-signal mode (default) emits NO advisory event
 *
 * Tests coordinator-level advisory emission and payload correctness.
 */

import { describe, it, expect, vi } from 'vitest'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'
import {
  createDualSignalCoordinator,
  CONTEXT_KEY_CODE_REVIEW_VERDICT,
} from '../dual-signal.js'
import type { DualSignalVerdict } from '../dual-signal.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockBus() {
  return { emit: vi.fn() } as unknown as TypedEventBus<FactoryEvents>
}

// ---------------------------------------------------------------------------
// CONTEXT_KEY_CODE_REVIEW_VERDICT constant
// ---------------------------------------------------------------------------

describe('CONTEXT_KEY_CODE_REVIEW_VERDICT', () => {
  it('equals the expected context key string', () => {
    expect(CONTEXT_KEY_CODE_REVIEW_VERDICT).toBe('factory.codeReviewVerdict')
  })
})

// ---------------------------------------------------------------------------
// createDualSignalCoordinator — scenario-primary mode advisory emission
// ---------------------------------------------------------------------------

describe('createDualSignalCoordinator — scenario-primary mode', () => {
  it('AC4 — emits scenario:advisory-computed when qualityMode is scenario-primary', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'scenario-primary',
    })

    coordinator.evaluate('NEEDS_MAJOR_REWORK', 0.9, 'run-1')

    expect(mockBus.emit).toHaveBeenCalledWith(
      'scenario:advisory-computed',
      expect.objectContaining({
        runId: 'run-1',
        verdict: 'NEEDS_MAJOR_REWORK',
        codeReviewPassed: false,
        score: 0.9,
        threshold: 0.8,
        agreement: 'DISAGREE',
      }),
    )
  })

  it('AC4 — advisory payload: NEEDS_MAJOR_REWORK + score 0.9 → codeReviewPassed:false, agreement:DISAGREE', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'scenario-primary',
    })

    coordinator.evaluate('NEEDS_MAJOR_REWORK' as DualSignalVerdict, 0.9, 'run-1')

    expect(mockBus.emit).toHaveBeenCalledWith(
      'scenario:advisory-computed',
      expect.objectContaining({
        verdict: 'NEEDS_MAJOR_REWORK',
        codeReviewPassed: false,
        score: 0.9,
        threshold: 0.8,
        agreement: 'DISAGREE',
      }),
    )
  })

  it('AC4 — advisory payload: SHIP_IT + score 0.3 → codeReviewPassed:true, agreement:DISAGREE', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'scenario-primary',
    })

    coordinator.evaluate('SHIP_IT', 0.3, 'run-42')

    expect(mockBus.emit).toHaveBeenCalledWith(
      'scenario:advisory-computed',
      expect.objectContaining({
        runId: 'run-42',
        verdict: 'SHIP_IT',
        codeReviewPassed: true,
        score: 0.3,
        threshold: 0.8,
        agreement: 'DISAGREE',
      }),
    )
  })

  it('dual emission — both scenario:score-computed AND scenario:advisory-computed emitted in scenario-primary', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'scenario-primary',
    })

    coordinator.evaluate('NEEDS_MAJOR_REWORK', 0.9, 'run-dual')

    expect(mockBus.emit).toHaveBeenCalledTimes(2)
    const eventNames = vi.mocked(mockBus.emit).mock.calls.map(([event]) => event)
    expect(eventNames).toContain('scenario:score-computed')
    expect(eventNames).toContain('scenario:advisory-computed')
  })

  it('scenario:score-computed still emitted first in scenario-primary mode', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'scenario-primary',
    })

    coordinator.evaluate('SHIP_IT', 0.6, 'run-order')

    expect(mockBus.emit).toHaveBeenNthCalledWith(1, 'scenario:score-computed', expect.any(Object))
    expect(mockBus.emit).toHaveBeenNthCalledWith(2, 'scenario:advisory-computed', expect.any(Object))
  })

  it('score-computed uses scenarioPassed (not codeReviewPassed) for passes field', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'scenario-primary',
    })

    // score 0.9 ≥ threshold 0.8 → scenarioPassed = true
    coordinator.evaluate('NEEDS_MAJOR_REWORK', 0.9, 'run-passes')

    expect(mockBus.emit).toHaveBeenCalledWith(
      'scenario:score-computed',
      expect.objectContaining({ passes: true, scenarioPassed: true, codeReviewPassed: false }),
    )
  })

  it('advisory verdict matches authoritativeDecision from evaluateDualSignal', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'scenario-primary',
    })

    coordinator.evaluate('LGTM_WITH_NOTES', 0.7, 'run-lgtm')

    expect(mockBus.emit).toHaveBeenCalledWith(
      'scenario:advisory-computed',
      expect.objectContaining({
        verdict: 'LGTM_WITH_NOTES',
        codeReviewPassed: true,
        agreement: 'DISAGREE', // scenario 0.7 < threshold 0.8 → disagree
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// createDualSignalCoordinator — dual-signal mode (default) — no advisory
// ---------------------------------------------------------------------------

describe('createDualSignalCoordinator — dual-signal mode (default)', () => {
  it('AC5 — does NOT emit scenario:advisory-computed in dual-signal mode', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      // qualityMode omitted → defaults to undefined (dual-signal behavior)
    })

    coordinator.evaluate('NEEDS_MAJOR_REWORK', 0.9, 'run-default')

    const eventNames = vi.mocked(mockBus.emit).mock.calls.map(([event]) => event)
    expect(eventNames).not.toContain('scenario:advisory-computed')
    expect(mockBus.emit).toHaveBeenCalledTimes(1)
  })

  it('AC5 — only scenario:score-computed emitted when qualityMode is omitted', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
    })

    coordinator.evaluate('SHIP_IT', 0.9, 'run-omit')

    expect(mockBus.emit).toHaveBeenCalledTimes(1)
    expect(mockBus.emit).toHaveBeenCalledWith('scenario:score-computed', expect.any(Object))
  })

  it('AC5 — explicit dual-signal qualityMode also emits no advisory', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'dual-signal',
    })

    coordinator.evaluate('NEEDS_MAJOR_REWORK', 0.9, 'run-explicit-dual')

    expect(mockBus.emit).toHaveBeenCalledTimes(1)
    const eventNames = vi.mocked(mockBus.emit).mock.calls.map(([event]) => event)
    expect(eventNames).not.toContain('scenario:advisory-computed')
  })

  it('code-review qualityMode also emits no advisory', () => {
    const mockBus = makeMockBus()
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'code-review',
    })

    coordinator.evaluate('SHIP_IT', 0.5, 'run-code-review')

    expect(mockBus.emit).toHaveBeenCalledTimes(1)
    const eventNames = vi.mocked(mockBus.emit).mock.calls.map(([event]) => event)
    expect(eventNames).not.toContain('scenario:advisory-computed')
  })
})
