/**
 * Unit tests for PlateauDetector and checkPlateauAndEmit.
 * Story 45-6.
 */

import { describe, it, expect, vi } from 'vitest'
import { createPlateauDetector, checkPlateauAndEmit } from '../plateau.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'

// ---------------------------------------------------------------------------
// createPlateauDetector
// ---------------------------------------------------------------------------

describe('createPlateauDetector', () => {
  it('AC1: detects plateau when score spread falls below threshold (default window=3, threshold=0.05)', () => {
    const detector = createPlateauDetector()
    detector.recordScore(1, 0.6)
    detector.recordScore(2, 0.61)
    detector.recordScore(3, 0.59)
    // max−min = 0.61 − 0.59 = 0.02 < 0.05 → plateau
    expect(detector.isPlateaued()).toBe(true)
  })

  it('AC2: does not detect plateau when scores are still improving', () => {
    const detector = createPlateauDetector()
    detector.recordScore(1, 0.6)
    detector.recordScore(2, 0.7)
    detector.recordScore(3, 0.8)
    // max−min = 0.8 − 0.6 = 0.2 > 0.05 → no plateau
    expect(detector.isPlateaued()).toBe(false)
  })

  it('AC3: returns false with 0 scores (insufficient data)', () => {
    const detector = createPlateauDetector()
    expect(detector.isPlateaued()).toBe(false)
  })

  it('AC3: returns false with 1 score (insufficient data)', () => {
    const detector = createPlateauDetector()
    detector.recordScore(1, 0.6)
    expect(detector.isPlateaued()).toBe(false)
  })

  it('AC3: returns false with 2 scores (insufficient data, window=3)', () => {
    const detector = createPlateauDetector()
    detector.recordScore(1, 0.6)
    detector.recordScore(2, 0.61)
    expect(detector.isPlateaued()).toBe(false)
  })

  it('AC4: sliding window — only last N scores are considered', () => {
    const detector = createPlateauDetector() // window=3
    detector.recordScore(1, 0.1)
    detector.recordScore(2, 0.9)
    detector.recordScore(3, 0.6)
    detector.recordScore(4, 0.61)
    detector.recordScore(5, 0.59)
    // Early scores 0.1, 0.9 should be discarded; only [0.6, 0.61, 0.59] counted
    // max−min = 0.61 − 0.59 = 0.02 < 0.05 → plateau
    expect(detector.isPlateaued()).toBe(true)
  })

  it('AC4: getScores() returns only the last window entries after sliding', () => {
    const detector = createPlateauDetector() // window=3
    detector.recordScore(1, 0.1)
    detector.recordScore(2, 0.9)
    detector.recordScore(3, 0.6)
    detector.recordScore(4, 0.61)
    detector.recordScore(5, 0.59)
    expect(detector.getScores()).toEqual([0.6, 0.61, 0.59])
  })

  it('AC5: strict threshold boundary — equal delta is NOT a plateau (delta === threshold)', () => {
    const detector = createPlateauDetector() // threshold=0.05
    detector.recordScore(1, 0.60)
    detector.recordScore(2, 0.65)
    detector.recordScore(3, 0.60)
    // max−min = 0.65 − 0.60 = 0.05 === threshold → strict < fails → not a plateau
    expect(detector.isPlateaued()).toBe(false)
  })

  it('AC6: custom window and threshold are used for detection', () => {
    const detector = createPlateauDetector({ window: 5, threshold: 0.02 })
    // Need 5 scores; 4 scores → false
    detector.recordScore(1, 0.5)
    detector.recordScore(2, 0.51)
    detector.recordScore(3, 0.50)
    detector.recordScore(4, 0.51)
    expect(detector.isPlateaued()).toBe(false)
    // Now add 5th tight score → window is full
    detector.recordScore(5, 0.505)
    // max−min = 0.51 − 0.50 = 0.01 < 0.02 → plateau
    expect(detector.isPlateaued()).toBe(true)
  })

  it('AC6: defaults — getWindow() returns 3 when no options provided', () => {
    const detector = createPlateauDetector()
    expect(detector.getWindow()).toBe(3)
  })

  it('AC6: getWindow() returns configured window size', () => {
    const detector = createPlateauDetector({ window: 5 })
    expect(detector.getWindow()).toBe(5)
  })

  it('getScores() returns a defensive copy — mutating the result does not affect plateau detection', () => {
    const detector = createPlateauDetector()
    detector.recordScore(1, 0.6)
    detector.recordScore(2, 0.61)
    detector.recordScore(3, 0.59)
    // Confirms plateau before mutation
    expect(detector.isPlateaued()).toBe(true)

    // Mutate the returned copy
    const copy = detector.getScores()
    copy[0] = 0.0
    copy[1] = 1.0
    copy[2] = 1.0

    // Internal state is unchanged — still a plateau
    expect(detector.isPlateaued()).toBe(true)
    expect(detector.getScores()).toEqual([0.6, 0.61, 0.59])
  })
})

// ---------------------------------------------------------------------------
// checkPlateauAndEmit
// ---------------------------------------------------------------------------

describe('checkPlateauAndEmit', () => {
  it('AC7: emits convergence:plateau-detected when plateau is detected', () => {
    const detector = createPlateauDetector()
    detector.recordScore(1, 0.6)
    detector.recordScore(2, 0.61)
    detector.recordScore(3, 0.59)

    const mockEmit = vi.fn()
    const mockBus = { emit: mockEmit } as unknown as TypedEventBus<FactoryEvents>

    const result = checkPlateauAndEmit(detector, {
      runId: 'run-1',
      nodeId: 'score-node',
      eventBus: mockBus,
    })

    expect(mockEmit).toHaveBeenCalledOnce()
    expect(mockEmit).toHaveBeenCalledWith('convergence:plateau-detected', {
      runId: 'run-1',
      nodeId: 'score-node',
      scores: [0.6, 0.61, 0.59],
      window: 3,
    })
    expect(result).toEqual({ plateaued: true, scores: [0.6, 0.61, 0.59] })
  })

  it('AC7: does NOT emit event when not yet plateaued (insufficient scores)', () => {
    const detector = createPlateauDetector()
    detector.recordScore(1, 0.6)
    // Only 1 score — insufficient

    const mockEmit = vi.fn()
    const mockBus = { emit: mockEmit } as unknown as TypedEventBus<FactoryEvents>

    const result = checkPlateauAndEmit(detector, {
      runId: 'run-1',
      nodeId: 'score-node',
      eventBus: mockBus,
    })

    expect(mockEmit).not.toHaveBeenCalled()
    expect(result.plateaued).toBe(false)
    expect(result.scores).toEqual([0.6])
  })

  it('AC7: works with no eventBus — does not throw when eventBus is omitted', () => {
    const detector = createPlateauDetector()
    detector.recordScore(1, 0.6)
    detector.recordScore(2, 0.61)
    detector.recordScore(3, 0.59)

    expect(() =>
      checkPlateauAndEmit(detector, { runId: 'run-1', nodeId: 'score-node' }),
    ).not.toThrow()

    const result = checkPlateauAndEmit(detector, { runId: 'run-1', nodeId: 'score-node' })
    expect(result).toEqual({ plateaued: true, scores: [0.6, 0.61, 0.59] })
  })

  it('returns plateaued: false with empty scores when no scores recorded and no eventBus', () => {
    const detector = createPlateauDetector()
    const result = checkPlateauAndEmit(detector, { runId: 'run-1', nodeId: 'score-node' })
    expect(result).toEqual({ plateaued: false, scores: [] })
  })
})
