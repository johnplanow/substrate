/**
 * Tests for routing-recommender.ts
 *
 * AC1: Downgrade recommendation when outputRatio < 0.15
 * AC1: Upgrade recommendation when outputRatio > 0.40
 * AC1: No recommendation when ratio is in neutral zone (0.15–0.40)
 * AC2: Fewer than 3 breakdowns → insufficientData: true
 * Zero-denominator guard: all-zero token entries → outputRatio 0.5 (neutral)
 */

import { describe, it, expect, vi } from 'vitest'
import type pino from 'pino'

import { RoutingRecommender } from '../routing-recommender.js'
import type { ModelRoutingConfig } from '../model-routing-config.js'
import type { PhaseTokenBreakdown } from '../types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockLogger(): pino.Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(),
    level: 'debug',
  } as unknown as pino.Logger
}

/**
 * Build a minimal PhaseTokenBreakdown with a single entry for one phase.
 * `inputTokens` and `outputTokens` control the output ratio.
 */
function makeBreakdown(
  runId: string,
  phase: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): PhaseTokenBreakdown {
  return {
    runId,
    baselineModel: model,
    entries: [
      {
        phase: phase as 'explore' | 'generate' | 'review' | 'default',
        model,
        inputTokens,
        outputTokens,
        dispatchCount: 1,
      },
    ],
  }
}

/**
 * Repeat a single breakdown N times (each with a unique runId) to simulate
 * a history of N runs with identical token distributions.
 */
function repeatBreakdown(base: Omit<PhaseTokenBreakdown, 'runId'>, count: number): PhaseTokenBreakdown[] {
  return Array.from({ length: count }, (_, i) => ({
    ...base,
    runId: `run-${i}`,
  }))
}

/** Minimal routing config with all three phases pointing to sonnet. */
const BASE_CONFIG: ModelRoutingConfig = {
  version: 1,
  baseline_model: 'claude-sonnet-4-5',
  phases: {
    explore: { model: 'claude-sonnet-4-5' },
    generate: { model: 'claude-sonnet-4-5' },
    review: { model: 'claude-sonnet-4-5' },
  },
}

/** Config where explore phase uses haiku (already at floor). */
const HAIKU_EXPLORE_CONFIG: ModelRoutingConfig = {
  ...BASE_CONFIG,
  phases: {
    ...BASE_CONFIG.phases,
    explore: { model: 'claude-haiku-4-5' },
  },
}

/** Config where generate phase uses opus (already at ceiling). */
const OPUS_GENERATE_CONFIG: ModelRoutingConfig = {
  ...BASE_CONFIG,
  phases: {
    ...BASE_CONFIG.phases,
    generate: { model: 'claude-opus-4-6' },
  },
}

// ---------------------------------------------------------------------------
// AC2: Insufficient data
// ---------------------------------------------------------------------------

describe('RoutingRecommender.analyze — insufficient data (AC2)', () => {
  it('returns insufficientData:true when 0 breakdowns provided', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    const result = recommender.analyze([], BASE_CONFIG)

    expect(result.insufficientData).toBe(true)
    expect(result.recommendations).toHaveLength(0)
    expect(result.analysisRuns).toBe(0)
  })

  it('returns insufficientData:true when only 1 breakdown provided', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    const breakdown = makeBreakdown('r1', 'explore', 'claude-sonnet-4-5', 9000, 100)
    const result = recommender.analyze([breakdown], BASE_CONFIG)

    expect(result.insufficientData).toBe(true)
    expect(result.analysisRuns).toBe(1)
  })

  it('returns insufficientData:true when exactly 2 breakdowns provided', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    const breakdowns = repeatBreakdown(
      { baselineModel: 'claude-sonnet-4-5', entries: [] },
      2,
    )
    const result = recommender.analyze(breakdowns, BASE_CONFIG)

    expect(result.insufficientData).toBe(true)
    expect(result.analysisRuns).toBe(2)
  })

  it('does NOT return insufficientData when 3 breakdowns provided', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    // Neutral ratio: 0.25 output — in the 0.15..0.40 zone
    const breakdowns = repeatBreakdown(
      makeBreakdown('base', 'explore', 'claude-sonnet-4-5', 750, 250),
      3,
    )
    const result = recommender.analyze(breakdowns, BASE_CONFIG)

    expect(result.insufficientData).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC1: Downgrade path
// ---------------------------------------------------------------------------

describe('RoutingRecommender.analyze — downgrade recommendation (AC1)', () => {
  it('generates a downgrade when explore outputRatio < 0.15', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    // outputRatio = 100 / (1000 + 100) ≈ 0.091 → below 0.15
    const breakdowns = repeatBreakdown(
      makeBreakdown('base', 'explore', 'claude-sonnet-4-5', 1000, 100),
      5,
    )
    const result = recommender.analyze(breakdowns, BASE_CONFIG)

    expect(result.insufficientData).toBe(false)
    const rec = result.recommendations.find((r) => r.phase === 'explore')
    expect(rec).toBeDefined()
    expect(rec!.direction).toBe('downgrade')
    expect(rec!.currentModel).toBe('claude-sonnet-4-5')
    // Sonnet (tier 2) → haiku (tier 1)
    expect(rec!.suggestedModel.toLowerCase()).toContain('haiku')
    expect(rec!.estimatedSavingsPct).toBeGreaterThan(0)
    expect(rec!.confidence).toBeGreaterThan(0)
    expect(rec!.dataPoints).toBe(5)
  })

  it('skips downgrade when model is already at tier 1 (haiku)', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    // Low output ratio — would normally trigger downgrade, but we're already at haiku
    const breakdowns = repeatBreakdown(
      makeBreakdown('base', 'explore', 'claude-haiku-4-5', 1000, 50),
      5,
    )
    const result = recommender.analyze(breakdowns, HAIKU_EXPLORE_CONFIG)

    const rec = result.recommendations.find((r) => r.phase === 'explore')
    expect(rec).toBeUndefined()
  })

  it('computes estimatedSavingsPct correctly for sonnet→haiku (tier 2→1)', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    const breakdowns = repeatBreakdown(
      makeBreakdown('base', 'explore', 'claude-sonnet-4-5', 900, 50),
      4,
    )
    const result = recommender.analyze(breakdowns, BASE_CONFIG)

    const rec = result.recommendations.find((r) => r.phase === 'explore')
    expect(rec).toBeDefined()
    // ((2 - 1) / 2) * 50 = 25
    expect(rec!.estimatedSavingsPct).toBeCloseTo(25, 5)
  })
})

// ---------------------------------------------------------------------------
// AC1: Upgrade path
// ---------------------------------------------------------------------------

describe('RoutingRecommender.analyze — upgrade recommendation (AC1)', () => {
  it('generates an upgrade when generate outputRatio > 0.40', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    // outputRatio = 500 / (600 + 500) ≈ 0.455 → above 0.40
    const breakdowns = repeatBreakdown(
      makeBreakdown('base', 'generate', 'claude-sonnet-4-5', 600, 500),
      5,
    )
    const result = recommender.analyze(breakdowns, BASE_CONFIG)

    const rec = result.recommendations.find((r) => r.phase === 'generate')
    expect(rec).toBeDefined()
    expect(rec!.direction).toBe('upgrade')
    expect(rec!.currentModel).toBe('claude-sonnet-4-5')
    // Sonnet (tier 2) → opus (tier 3)
    expect(rec!.suggestedModel.toLowerCase()).toContain('opus')
    expect(rec!.dataPoints).toBe(5)
  })

  it('skips upgrade when model is already at tier 3 (opus)', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    // High output ratio — would trigger upgrade, but already at opus
    const breakdowns = repeatBreakdown(
      makeBreakdown('base', 'generate', 'claude-opus-4-6', 300, 500),
      5,
    )
    const result = recommender.analyze(breakdowns, OPUS_GENERATE_CONFIG)

    const rec = result.recommendations.find((r) => r.phase === 'generate')
    expect(rec).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC1: Neutral zone — no recommendation
// ---------------------------------------------------------------------------

describe('RoutingRecommender.analyze — neutral zone (AC1)', () => {
  it('emits no recommendation when outputRatio is exactly 0.25', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    // outputRatio = 250 / (750 + 250) = 0.25 → in neutral 0.15..0.40
    const breakdowns = repeatBreakdown(
      makeBreakdown('base', 'review', 'claude-sonnet-4-5', 750, 250),
      4,
    )
    const result = recommender.analyze(breakdowns, BASE_CONFIG)

    expect(result.insufficientData).toBe(false)
    expect(result.recommendations).toHaveLength(0)
  })

  it('emits no recommendation when outputRatio equals boundary 0.15 (not strictly less)', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    // outputRatio = 150 / 1000 = 0.15 → exactly at threshold, not < 0.15
    const breakdowns = repeatBreakdown(
      makeBreakdown('base', 'review', 'claude-sonnet-4-5', 850, 150),
      4,
    )
    const result = recommender.analyze(breakdowns, BASE_CONFIG)

    const rec = result.recommendations.find((r) => r.phase === 'review')
    expect(rec).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Zero-denominator guard
// ---------------------------------------------------------------------------

describe('RoutingRecommender — zero-denominator guard', () => {
  it('returns outputRatio 0.5 (defaults to 0.5 to avoid division by zero) when all entries have zero tokens', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    // All-zero entries — denominator is 0 → should fall back to 0.5
    const breakdowns = repeatBreakdown(
      {
        baselineModel: 'claude-sonnet-4-5',
        entries: [
          {
            phase: 'explore',
            model: 'claude-sonnet-4-5',
            inputTokens: 0,
            outputTokens: 0,
            dispatchCount: 0,
          },
        ],
      },
      4,
    )
    const result = recommender.analyze(breakdowns, BASE_CONFIG)

    // phaseOutputRatios should record 0.5
    expect(result.phaseOutputRatios['explore']).toBeCloseTo(0.5, 5)
    // 0.5 > 0.40 upgrade threshold → an upgrade recommendation is generated
    // (this is expected: zero-token phases look like generation-heavy phases)
    const rec = result.recommendations.find((r) => r.phase === 'explore')
    expect(rec).toBeDefined()
    expect(rec!.direction).toBe('upgrade')
  })
})

// ---------------------------------------------------------------------------
// phaseOutputRatios in result
// ---------------------------------------------------------------------------

describe('RoutingRecommender.analyze — phaseOutputRatios', () => {
  it('populates phaseOutputRatios for all phases present in breakdowns', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    const breakdowns: PhaseTokenBreakdown[] = Array.from({ length: 4 }, (_, i) => ({
      runId: `run-${i}`,
      baselineModel: 'claude-sonnet-4-5',
      entries: [
        { phase: 'explore', model: 'claude-sonnet-4-5', inputTokens: 800, outputTokens: 200, dispatchCount: 1 },
        { phase: 'generate', model: 'claude-sonnet-4-5', inputTokens: 400, outputTokens: 600, dispatchCount: 2 },
      ],
    }))

    const result = recommender.analyze(breakdowns, BASE_CONFIG)

    expect(result.phaseOutputRatios['explore']).toBeCloseTo(0.2, 5)
    expect(result.phaseOutputRatios['generate']).toBeCloseTo(0.6, 5)
  })
})

// ---------------------------------------------------------------------------
// Confidence calculation
// ---------------------------------------------------------------------------

describe('RoutingRecommender.analyze — confidence', () => {
  it('caps confidence at 1.0 when >= 10 breakdowns', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    const breakdowns = repeatBreakdown(
      makeBreakdown('base', 'explore', 'claude-sonnet-4-5', 1000, 50),
      12,
    )
    const result = recommender.analyze(breakdowns, BASE_CONFIG)

    const rec = result.recommendations.find((r) => r.phase === 'explore')
    expect(rec).toBeDefined()
    expect(rec!.confidence).toBe(1)
  })

  it('scales confidence linearly for fewer than 10 breakdowns', () => {
    const recommender = new RoutingRecommender(createMockLogger())
    const breakdowns = repeatBreakdown(
      makeBreakdown('base', 'explore', 'claude-sonnet-4-5', 1000, 50),
      5,
    )
    const result = recommender.analyze(breakdowns, BASE_CONFIG)

    const rec = result.recommendations.find((r) => r.phase === 'explore')
    expect(rec).toBeDefined()
    // Math.min(5 / 10, 1) = 0.5
    expect(rec!.confidence).toBeCloseTo(0.5, 5)
  })
})
