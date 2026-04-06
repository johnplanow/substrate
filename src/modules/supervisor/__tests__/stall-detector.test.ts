import { describe, it, expect } from 'vitest'
import {
  StallDetector,
  DEFAULT_STALL_THRESHOLDS,
  type StallThresholdConfig,
} from '../stall-detector.js'

// ---------------------------------------------------------------------------
// DEFAULT_STALL_THRESHOLDS shape
// ---------------------------------------------------------------------------
describe('DEFAULT_STALL_THRESHOLDS', () => {
  it('contains the four expected phases with correct values', () => {
    expect(DEFAULT_STALL_THRESHOLDS['create-story']).toBe(300)
    expect(DEFAULT_STALL_THRESHOLDS['dev-story']).toBe(900)
    expect(DEFAULT_STALL_THRESHOLDS['code-review']).toBe(900)
    expect(DEFAULT_STALL_THRESHOLDS['test-plan']).toBe(600)
  })
})

// ---------------------------------------------------------------------------
// getThreshold
// ---------------------------------------------------------------------------
describe('StallDetector.getThreshold', () => {
  const detector = new StallDetector(DEFAULT_STALL_THRESHOLDS)

  it('returns correct threshold for create-story', () => {
    expect(detector.getThreshold('create-story')).toBe(300)
  })

  it('returns correct threshold for dev-story', () => {
    expect(detector.getThreshold('dev-story')).toBe(900)
  })

  it('returns correct threshold for code-review', () => {
    expect(detector.getThreshold('code-review')).toBe(900)
  })

  it('returns correct threshold for test-plan', () => {
    expect(detector.getThreshold('test-plan')).toBe(600)
  })

  it('returns max value for unknown phase', () => {
    // max of {300, 900, 900, 600} = 900
    expect(detector.getThreshold('unknown-phase')).toBe(900)
  })

  it('returns max value for empty-string phase', () => {
    expect(detector.getThreshold('')).toBe(900)
  })
})

describe('StallDetector.getThreshold with custom config', () => {
  const customConfig: StallThresholdConfig = {
    alpha: 100,
    beta: 200,
    gamma: 50,
  }
  const detector = new StallDetector(customConfig)

  it('returns threshold for known phase', () => {
    expect(detector.getThreshold('alpha')).toBe(100)
    expect(detector.getThreshold('beta')).toBe(200)
    expect(detector.getThreshold('gamma')).toBe(50)
  })

  it('returns max (200) for unknown phase — no default values bleed through', () => {
    expect(detector.getThreshold('dev-story')).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// getEffectiveThreshold
// ---------------------------------------------------------------------------
describe('StallDetector.getEffectiveThreshold', () => {
  const detector = new StallDetector(DEFAULT_STALL_THRESHOLDS)

  it('multiplier 1.0 is identity for code-review', () => {
    expect(detector.getEffectiveThreshold('code-review', 1.0)).toBe(900)
  })

  it('multiplier 3.0 triples code-review threshold → 2700', () => {
    expect(detector.getEffectiveThreshold('code-review', 3.0)).toBe(2700)
  })

  it('multiplier 3.0 triples create-story threshold → 900', () => {
    expect(detector.getEffectiveThreshold('create-story', 3.0)).toBe(900)
  })

  it('multiplier 1.0 is identity for dev-story', () => {
    expect(detector.getEffectiveThreshold('dev-story', 1.0)).toBe(900)
  })

  it('multiplier 2.5 for test-plan → 1500', () => {
    expect(detector.getEffectiveThreshold('test-plan', 2.5)).toBe(1500)
  })
})

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------
describe('StallDetector.evaluate', () => {
  const detector = new StallDetector(DEFAULT_STALL_THRESHOLDS)

  it('is not stalled when staleness < threshold', () => {
    const result = detector.evaluate({
      phase: 'dev-story',
      staleness_seconds: 800,
      timeoutMultiplier: 1.0,
    })
    expect(result.isStalled).toBe(false)
    expect(result.effectiveThreshold).toBe(900)
    expect(result.phase).toBe('dev-story')
    expect(result.timeoutMultiplier).toBe(1.0)
  })

  it('is stalled when staleness >= threshold (boundary: equal)', () => {
    const result = detector.evaluate({
      phase: 'dev-story',
      staleness_seconds: 900,
      timeoutMultiplier: 1.0,
    })
    expect(result.isStalled).toBe(true)
    expect(result.effectiveThreshold).toBe(900)
  })

  it('is stalled when staleness > threshold (AC3 example: 950)', () => {
    const result = detector.evaluate({
      phase: 'dev-story',
      staleness_seconds: 950,
      timeoutMultiplier: 1.0,
    })
    expect(result.isStalled).toBe(true)
    expect(result.effectiveThreshold).toBe(900)
  })

  it('applies multiplier — not stalled at 800s with 3.0 multiplier (threshold = 2700)', () => {
    const result = detector.evaluate({
      phase: 'dev-story',
      staleness_seconds: 800,
      timeoutMultiplier: 3.0,
    })
    expect(result.isStalled).toBe(false)
    expect(result.effectiveThreshold).toBe(2700)
  })

  it('falls back to max threshold for unknown phase', () => {
    const result = detector.evaluate({
      phase: 'some-unknown-phase',
      staleness_seconds: 800,
      timeoutMultiplier: 1.0,
    })
    // max threshold is 900 (dev-story / code-review)
    expect(result.effectiveThreshold).toBe(900)
    expect(result.isStalled).toBe(false) // 800 < 900
  })

  it('unknown phase stalls when staleness equals max threshold', () => {
    const result = detector.evaluate({
      phase: 'some-unknown-phase',
      staleness_seconds: 900,
      timeoutMultiplier: 1.0,
    })
    expect(result.isStalled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getAdaptivePollInterval
// ---------------------------------------------------------------------------
describe('StallDetector.getAdaptivePollInterval', () => {
  const detector = new StallDetector(DEFAULT_STALL_THRESHOLDS)

  it('returns base interval unchanged for multiplier 1.0', () => {
    // min effective = min(300, 900, 900, 600) * 1.0 = 300 ≤ 600 → unchanged
    expect(detector.getAdaptivePollInterval(30, 1.0)).toBe(30)
  })

  it('returns base × 2 for multiplier 3.0 (all effective thresholds > 600)', () => {
    // min effective = 300 * 3.0 = 900 > 600 → doubled
    expect(detector.getAdaptivePollInterval(30, 3.0)).toBe(60)
  })

  it('returns base unchanged for multiplier 2.0 (min effective = 600 — not > 600)', () => {
    // min effective = 300 * 2.0 = 600 — NOT > 600, so stays at base
    expect(detector.getAdaptivePollInterval(30, 2.0)).toBe(30)
  })

  it('returns base × 2 for multiplier 2.1 (min effective = 630 > 600)', () => {
    expect(detector.getAdaptivePollInterval(30, 2.1)).toBe(60)
  })
})

describe('StallDetector.getAdaptivePollInterval with custom config', () => {
  it('no hardcoded defaults — uses only configured values', () => {
    const custom: StallThresholdConfig = { fast: 100, slow: 800 }
    const detector = new StallDetector(custom)
    // min effective with multiplier 7 = 100 * 7 = 700 > 600 → doubled
    expect(detector.getAdaptivePollInterval(30, 7)).toBe(60)
    // min effective with multiplier 1 = 100 * 1 = 100 ≤ 600 → unchanged
    expect(detector.getAdaptivePollInterval(30, 1)).toBe(30)
  })
})
