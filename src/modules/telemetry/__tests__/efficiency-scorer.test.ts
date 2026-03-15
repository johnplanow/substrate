/**
 * Unit tests for EfficiencyScorer (Epic 35 — Telemetry Scoring v2).
 *
 * Tests cover:
 *   - Story 35-1: Logarithmic io_ratio curve
 *   - Story 35-2: Per-task-type baseline profiles
 *   - Story 35-3: Cold-start turn exclusion
 *   - Story 35-4: Token density sub-score
 *   - Story 35-5: Composite score revalidation
 *
 * Logger is injected as a vi.fn() stub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type pino from 'pino'

import { EfficiencyScorer } from '../efficiency-scorer.js'
import type { TurnAnalysis } from '../types.js'

// ---------------------------------------------------------------------------
// Mock logger factory
// ---------------------------------------------------------------------------

function makeMockLogger(): pino.Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as pino.Logger
}

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function makeTurn(overrides: Partial<TurnAnalysis> = {}): TurnAnalysis {
  return {
    spanId: 'span-1',
    turnNumber: 1,
    name: 'assistant_turn',
    timestamp: 1000,
    source: 'claude-code',
    model: 'claude-sonnet',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 500,
    freshTokens: 500,
    cacheHitRate: 0.5,
    costUsd: 0.001,
    durationMs: 1000,
    contextSize: 1000,
    contextDelta: 1000,
    isContextSpike: false,
    childSpans: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EfficiencyScorer', () => {
  let logger: pino.Logger
  let scorer: EfficiencyScorer

  beforeEach(() => {
    logger = makeMockLogger()
    scorer = new EfficiencyScorer(logger)
  })

  describe('score()', () => {
    it('should return zeroed score for empty turns array', () => {
      const result = scorer.score('27-6', [])
      expect(result.compositeScore).toBe(0)
      expect(result.cacheHitSubScore).toBe(0)
      expect(result.ioRatioSubScore).toBe(0)
      expect(result.contextManagementSubScore).toBe(0)
      expect(result.tokenDensitySubScore).toBe(0)
      expect(result.totalTurns).toBe(0)
      expect(result.coldStartTurnsExcluded).toBe(0)
      expect(result.avgCacheHitRate).toBe(0)
      expect(result.avgIoRatio).toBe(0)
      expect(result.contextSpikeCount).toBe(0)
      expect(result.perModelBreakdown).toEqual([])
      expect(result.perSourceBreakdown).toEqual([])
    })

    it('should include storyKey and non-zero timestamp in result', () => {
      const result = scorer.score('27-6', [makeTurn()])
      expect(result.storyKey).toBe('27-6')
      expect(result.timestamp).toBeGreaterThan(0)
    })

    it('should compute cacheHitSubScore = 100 when all turns have cacheHitRate = 1.0', () => {
      const turns = [
        makeTurn({ cacheHitRate: 1.0 }),
        makeTurn({ spanId: 'span-2', cacheHitRate: 1.0 }),
      ]
      const result = scorer.score('27-6', turns)
      expect(result.cacheHitSubScore).toBe(100)
    })

    it('should compute cacheHitSubScore = 0 when all turns have cacheHitRate = 0', () => {
      const turns = [
        makeTurn({ cacheHitRate: 0 }),
        makeTurn({ spanId: 'span-2', cacheHitRate: 0 }),
      ]
      const result = scorer.score('27-6', turns)
      expect(result.cacheHitSubScore).toBe(0)
    })

    it('should clamp cacheHitSubScore to 0 when cacheHitRate is negative (invalid)', () => {
      const turns = [makeTurn({ cacheHitRate: -0.5 })]
      const result = scorer.score('27-6', turns)
      expect(result.cacheHitSubScore).toBe(0)
    })

    // Story 35-1: Logarithmic io_ratio curve
    describe('ioRatioSubScore (logarithmic curve)', () => {
      it('should score 0 when io_ratio = 1 (log10(1) = 0)', () => {
        // output/freshInput = 1000/1000 = 1.0 → log10(1)/log10(100)*100 = 0
        const turns = [makeTurn({ inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheHitRate: 0 })]
        const result = scorer.score('27-6', turns)
        expect(result.ioRatioSubScore).toBe(0)
      })

      it('should score 50 when io_ratio = 10 (default TARGET=100)', () => {
        // output/freshInput = 1000/100 = 10 → log10(10)/log10(100)*100 = 1/2*100 = 50
        const turns = [makeTurn({ inputTokens: 100, outputTokens: 1000, cacheReadTokens: 0, cacheHitRate: 0 })]
        const result = scorer.score('27-6', turns)
        expect(result.ioRatioSubScore).toBeCloseTo(50, 1)
      })

      it('should score 100 when io_ratio = TARGET (100)', () => {
        // output/freshInput = 1000/10 = 100 → log10(100)/log10(100)*100 = 100
        const turns = [makeTurn({ inputTokens: 10, outputTokens: 1000, cacheReadTokens: 0, cacheHitRate: 0 })]
        const result = scorer.score('27-6', turns)
        expect(result.ioRatioSubScore).toBe(100)
      })

      it('should clamp to 100 when io_ratio exceeds TARGET', () => {
        // output/freshInput = 10000/10 = 1000 → log10(1000)/log10(100)*100 = 3/2*100 = 150 → clamped 100
        const turns = [makeTurn({ inputTokens: 10, outputTokens: 10000, cacheReadTokens: 0, cacheHitRate: 0 })]
        const result = scorer.score('27-6', turns)
        expect(result.ioRatioSubScore).toBe(100)
      })

      it('should score 0 when io_ratio < 1 (output < freshInput)', () => {
        // output/freshInput = 100/100000 = 0.001 → log10(0.001) = -3 → negative → clamped to 0
        const turns = [makeTurn({ inputTokens: 100_000, outputTokens: 100, cacheHitRate: 0 })]
        const result = scorer.score('27-6', turns)
        expect(result.ioRatioSubScore).toBe(0)
      })

      it('should score 0 when outputTokens = 0', () => {
        const turns = [makeTurn({ outputTokens: 0, inputTokens: 1000 })]
        const result = scorer.score('27-6', turns)
        expect(result.ioRatioSubScore).toBe(0)
      })
    })

    it('should compute contextManagementSubScore = 100 when no spikes', () => {
      const turns = [
        makeTurn({ isContextSpike: false }),
        makeTurn({ spanId: 'span-2', isContextSpike: false }),
        makeTurn({ spanId: 'span-3', isContextSpike: false }),
      ]
      const result = scorer.score('27-6', turns)
      expect(result.contextManagementSubScore).toBe(100)
    })

    it('should compute contextManagementSubScore = 50 when half of turns are spikes', () => {
      const turns = [
        makeTurn({ isContextSpike: true }),
        makeTurn({ spanId: 'span-2', isContextSpike: false }),
      ]
      const result = scorer.score('27-6', turns)
      // spikeRatio = 1/2 = 0.5 → 100 - 0.5*100 = 50
      expect(result.contextManagementSubScore).toBe(50)
    })

    it('should compute contextManagementSubScore = 0 when all turns are spikes', () => {
      const turns = [
        makeTurn({ isContextSpike: true }),
        makeTurn({ spanId: 'span-2', isContextSpike: true }),
      ]
      const result = scorer.score('27-6', turns)
      expect(result.contextManagementSubScore).toBe(0)
    })

    // Story 35-4: Token density sub-score
    describe('tokenDensitySubScore', () => {
      it('should score 100 when avg output equals default baseline (800)', () => {
        // Default baseline expectedOutputPerTurn = 800
        const turns = [makeTurn({ outputTokens: 800 })]
        const result = scorer.score('27-6', turns)
        expect(result.tokenDensitySubScore).toBe(100)
      })

      it('should score 50 when avg output is half of baseline', () => {
        const turns = [makeTurn({ outputTokens: 400 })]
        const result = scorer.score('27-6', turns)
        expect(result.tokenDensitySubScore).toBe(50)
      })

      it('should clamp to 100 when avg output exceeds baseline', () => {
        const turns = [makeTurn({ outputTokens: 1600 })]
        const result = scorer.score('27-6', turns)
        expect(result.tokenDensitySubScore).toBe(100)
      })

      it('should score near 0 when output is minimal', () => {
        const turns = [makeTurn({ outputTokens: 1 })]
        const result = scorer.score('27-6', turns)
        expect(result.tokenDensitySubScore).toBeCloseTo(0.125, 2) // 1/800*100
      })

      it('should use task-type specific baseline when all turns share a taskType', () => {
        // code-review baseline: expectedOutputPerTurn = 3900
        const turns = [
          makeTurn({ outputTokens: 3900, taskType: 'code-review' }),
          makeTurn({ spanId: 'span-2', outputTokens: 3900, taskType: 'code-review' }),
        ]
        const result = scorer.score('27-6', turns)
        expect(result.tokenDensitySubScore).toBe(100) // 3900/3900 = 1.0 → 100
      })

      it('should use default baseline when turns have mixed taskTypes', () => {
        // Mixed types → default baseline (800)
        const turns = [
          makeTurn({ outputTokens: 800, taskType: 'dev-story' }),
          makeTurn({ spanId: 'span-2', outputTokens: 800, taskType: 'code-review' }),
        ]
        const result = scorer.score('27-6', turns)
        expect(result.tokenDensitySubScore).toBe(100) // 800/800 = 1.0 → 100
      })
    })

    // Story 35-5: Composite score with new weights (25% each)
    it('should compute composite score with 4 equal weights of 25%', () => {
      // Design a turn with predictable sub-scores:
      //   cacheHitRate = 1.0 → cacheHitSubScore = 100
      //   output/fresh = 800/1 = 800 >> TARGET(100) → ioRatioSubScore = 100 (clamped)
      //   no spikes → contextManagementSubScore = 100
      //   output = 800, default baseline = 800 → tokenDensitySubScore = 100
      // composite = round(100*0.25 + 100*0.25 + 100*0.25 + 100*0.25) = 100
      const turns = [
        makeTurn({
          inputTokens: 1,
          outputTokens: 800,
          cacheHitRate: 1.0,
          isContextSpike: false,
        }),
      ]
      const result = scorer.score('27-6', turns)
      expect(result.compositeScore).toBe(100)
      expect(result.cacheHitSubScore).toBe(100)
      expect(result.ioRatioSubScore).toBe(100)
      expect(result.contextManagementSubScore).toBe(100)
      expect(result.tokenDensitySubScore).toBe(100)
    })

    it('should produce gradient composite with varied sub-scores', () => {
      // cacheHitRate = 0.8 → cache = 80
      // output/fresh = 500/50 = 10 → ioRatio = log10(10)/log10(100)*100 = 50
      // no spikes → context = 100
      // output = 500, baseline = 800 → density = 500/800*100 = 62.5
      // composite = round(80*0.25 + 50*0.25 + 100*0.25 + 62.5*0.25) = round(73.125) = 73
      const turns = [
        makeTurn({
          inputTokens: 50,
          outputTokens: 500,
          cacheHitRate: 0.8,
          isContextSpike: false,
        }),
      ]
      const result = scorer.score('27-6', turns)
      expect(result.compositeScore).toBe(73)
    })

    it('should correctly set totalTurns and contextSpikeCount', () => {
      const turns = [
        makeTurn({ isContextSpike: true }),
        makeTurn({ spanId: 'span-2', isContextSpike: false }),
        makeTurn({ spanId: 'span-3', isContextSpike: true }),
      ]
      const result = scorer.score('27-6', turns)
      expect(result.totalTurns).toBe(3)
      expect(result.contextSpikeCount).toBe(2)
    })

    it('should log an info message with storyKey and compositeScore', () => {
      scorer.score('27-6', [makeTurn()])
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ storyKey: '27-6' }),
        expect.any(String),
      )
    })

    // Story 35-3: Cold-start turn exclusion
    describe('cold-start turn exclusion', () => {
      it('should exclude first turn per dispatchId from scoring', () => {
        // 2 dispatches, each with 2 turns. First turn of each = cold-start
        const turns = [
          makeTurn({ spanId: 'cold-1', dispatchId: 'dispatch-a', cacheHitRate: 0.0, outputTokens: 10 }),
          makeTurn({ spanId: 'warm-1', dispatchId: 'dispatch-a', cacheHitRate: 1.0, outputTokens: 800 }),
          makeTurn({ spanId: 'cold-2', dispatchId: 'dispatch-b', cacheHitRate: 0.0, outputTokens: 10 }),
          makeTurn({ spanId: 'warm-2', dispatchId: 'dispatch-b', cacheHitRate: 1.0, outputTokens: 800 }),
        ]
        const result = scorer.score('27-6', turns)
        expect(result.coldStartTurnsExcluded).toBe(2)
        expect(result.totalTurns).toBe(4) // all turns counted
        // Scoring uses only warm turns: cacheHitRate=1.0 → cache=100
        expect(result.cacheHitSubScore).toBe(100)
      })

      it('should not exclude turns without dispatchId', () => {
        const turns = [
          makeTurn({ spanId: 'no-dispatch-1', cacheHitRate: 0.5 }),
          makeTurn({ spanId: 'no-dispatch-2', cacheHitRate: 0.5 }),
        ]
        const result = scorer.score('27-6', turns)
        expect(result.coldStartTurnsExcluded).toBe(0)
        expect(result.cacheHitSubScore).toBe(50)
      })

      it('should fallback to all turns when all are cold-starts (single-turn dispatches)', () => {
        const turns = [
          makeTurn({ spanId: 'only-1', dispatchId: 'dispatch-x', cacheHitRate: 0.8 }),
          makeTurn({ spanId: 'only-2', dispatchId: 'dispatch-y', cacheHitRate: 0.6 }),
        ]
        const result = scorer.score('27-6', turns)
        // Both are cold-starts, but fallback uses all turns
        expect(result.coldStartTurnsExcluded).toBe(2)
        expect(result.cacheHitSubScore).toBeCloseTo(70, 0) // avg(0.8, 0.6) * 100
      })
    })

    // Story 35-2: Per-task-type baseline profiles
    describe('per-task-type baselines', () => {
      it('should use dev-story baseline when all turns have taskType=dev-story', () => {
        // dev-story: expectedOutputPerTurn=550, targetIoRatio=100
        const turns = [
          makeTurn({
            taskType: 'dev-story',
            outputTokens: 550,
            inputTokens: 10, // ratio = 550/10 = 55
          }),
          makeTurn({
            spanId: 'span-2',
            taskType: 'dev-story',
            outputTokens: 550,
            inputTokens: 10,
          }),
        ]
        const result = scorer.score('27-6', turns)
        expect(result.tokenDensitySubScore).toBe(100) // 550/550 = 1.0 → 100
        // ioRatio: ratio=55, log10(55)/log10(100)*100 = 1.740/2 * 100 ≈ 87
        expect(result.ioRatioSubScore).toBeCloseTo(87, 0)
      })

      it('should use code-review baseline (lower targetIoRatio) for code-review', () => {
        // code-review: targetIoRatio=50, expectedOutputPerTurn=3900
        const turns = [
          makeTurn({
            taskType: 'code-review',
            outputTokens: 3900,
            inputTokens: 100, // ratio = 3900/100 = 39
          }),
        ]
        const result = scorer.score('27-6', turns)
        // ioRatio: ratio=39, log10(39)/log10(50)*100 = 1.591/1.699 * 100 ≈ 93.6
        expect(result.ioRatioSubScore).toBeCloseTo(93.6, 0)
        expect(result.tokenDensitySubScore).toBe(100) // 3900/3900 = 1.0 → 100
      })

      it('should use default baseline for unknown task types', () => {
        const turns = [
          makeTurn({ taskType: 'custom-task', outputTokens: 800 }),
        ]
        const result = scorer.score('27-6', turns)
        expect(result.tokenDensitySubScore).toBe(100) // 800/800 (default) = 1.0 → 100
      })
    })

    describe('per-model breakdown', () => {
      it('should group turns by model correctly', () => {
        const turns = [
          makeTurn({ model: 'claude-opus', inputTokens: 2000, outputTokens: 1000, cacheHitRate: 0.8 }),
          makeTurn({ spanId: 'span-2', model: 'claude-sonnet', inputTokens: 1000, outputTokens: 500, cacheHitRate: 0.6 }),
          makeTurn({ spanId: 'span-3', model: 'claude-opus', inputTokens: 1500, outputTokens: 750, cacheHitRate: 0.7 }),
        ]
        const result = scorer.score('27-6', turns)
        expect(result.perModelBreakdown).toHaveLength(2)
        const opus = result.perModelBreakdown.find((m) => m.model === 'claude-opus')
        const sonnet = result.perModelBreakdown.find((m) => m.model === 'claude-sonnet')
        expect(opus).toBeDefined()
        expect(sonnet).toBeDefined()
        // opus cacheHitRate = (0.8 + 0.7) / 2 = 0.75
        expect(opus!.cacheHitRate).toBeCloseTo(0.75, 5)
        expect(sonnet!.cacheHitRate).toBeCloseTo(0.6, 5)
      })

      it('should group turns with null/undefined model under "unknown"', () => {
        const turns = [
          makeTurn({ model: undefined }),
          makeTurn({ spanId: 'span-2', model: '' }),
          makeTurn({ spanId: 'span-3', model: 'claude-sonnet' }),
        ]
        const result = scorer.score('27-6', turns)
        const unknown = result.perModelBreakdown.find((m) => m.model === 'unknown')
        expect(unknown).toBeDefined()
        expect(unknown!.cacheHitRate).toBeDefined()
        // 2 turns in unknown group
        const sonnet = result.perModelBreakdown.find((m) => m.model === 'claude-sonnet')
        expect(sonnet).toBeDefined()
        expect(result.perModelBreakdown).toHaveLength(2)
      })

      it('should compute costPer1KOutputTokens correctly', () => {
        // totalCostUsd = 0.002, totalOutputTokens = 1000 → 0.002 / 1000 * 1000 = 0.002
        const turns = [
          makeTurn({ model: 'claude-sonnet', costUsd: 0.001, outputTokens: 500 }),
          makeTurn({ spanId: 'span-2', model: 'claude-sonnet', costUsd: 0.001, outputTokens: 500 }),
        ]
        const result = scorer.score('27-6', turns)
        const entry = result.perModelBreakdown.find((m) => m.model === 'claude-sonnet')
        expect(entry!.costPer1KOutputTokens).toBeCloseTo(0.002, 5)
      })

      it('should produce exactly 3 entries: 2 named models + unknown', () => {
        const turns = [
          makeTurn({ model: 'model-a' }),
          makeTurn({ spanId: 'span-2', model: 'model-b' }),
          makeTurn({ spanId: 'span-3', model: undefined }),
        ]
        const result = scorer.score('27-6', turns)
        expect(result.perModelBreakdown).toHaveLength(3)
        const modelNames = result.perModelBreakdown.map((m) => m.model)
        expect(modelNames).toContain('model-a')
        expect(modelNames).toContain('model-b')
        expect(modelNames).toContain('unknown')
      })
    })

    describe('per-source breakdown', () => {
      it('should group turns by source and compute per-group composite score', () => {
        // Use predictable values for each source
        const turns = [
          makeTurn({
            source: 'claude-code',
            cacheHitRate: 1.0,
            isContextSpike: false,
            inputTokens: 10,
            outputTokens: 800,
          }),
          makeTurn({
            spanId: 'span-2',
            source: 'unknown',
            cacheHitRate: 0,
            isContextSpike: true,
            inputTokens: 10,
            outputTokens: 800,
          }),
        ]
        const result = scorer.score('27-6', turns)
        expect(result.perSourceBreakdown).toHaveLength(2)
        const cc = result.perSourceBreakdown.find((s) => s.source === 'claude-code')
        const unk = result.perSourceBreakdown.find((s) => s.source === 'unknown')
        expect(cc).toBeDefined()
        expect(unk).toBeDefined()
        // claude-code: cache=100, ioRatio(80→~95), context=100, density=100 → high composite
        expect(cc!.compositeScore).toBeGreaterThan(90)
        // unknown: cache=0, ioRatio(80→~95), context=0, density=100 → lower composite
        expect(unk!.compositeScore).toBeLessThan(60)
      })

      it('should include correct turnCount per source', () => {
        const turns = [
          makeTurn({ source: 'source-a' }),
          makeTurn({ spanId: 'span-2', source: 'source-a' }),
          makeTurn({ spanId: 'span-3', source: 'source-b' }),
        ]
        const result = scorer.score('27-6', turns)
        const a = result.perSourceBreakdown.find((s) => s.source === 'source-a')
        const b = result.perSourceBreakdown.find((s) => s.source === 'source-b')
        expect(a!.turnCount).toBe(2)
        expect(b!.turnCount).toBe(1)
      })
    })

    describe('single-turn edge case', () => {
      it('should produce a valid non-NaN score for a single turn', () => {
        const turn = makeTurn({
          spanId: 'span-single',
          inputTokens: 500,
          outputTokens: 100,
          cacheHitRate: 0.5,
          isContextSpike: false,
        })
        const result = scorer.score('27-6', [turn])
        expect(Number.isNaN(result.compositeScore)).toBe(false)
        expect(Number.isNaN(result.cacheHitSubScore)).toBe(false)
        expect(Number.isNaN(result.ioRatioSubScore)).toBe(false)
        expect(Number.isNaN(result.contextManagementSubScore)).toBe(false)
        expect(Number.isNaN(result.tokenDensitySubScore)).toBe(false)
        expect(result.compositeScore).toBeGreaterThanOrEqual(0)
        expect(result.compositeScore).toBeLessThanOrEqual(100)
      })

      it('should produce contextDelta = inputTokens for a single turn (no spikes from that alone)', () => {
        const turn = makeTurn({ isContextSpike: false })
        const result = scorer.score('27-6', [turn])
        expect(result.contextManagementSubScore).toBe(100)
        expect(result.contextSpikeCount).toBe(0)
      })
    })

    describe('determinism', () => {
      it('should return identical compositeScore for identical inputs', () => {
        const turns = [
          makeTurn({ inputTokens: 2000, outputTokens: 800, cacheHitRate: 0.6, isContextSpike: false }),
          makeTurn({ spanId: 'span-2', inputTokens: 3000, outputTokens: 500, cacheHitRate: 0.4, isContextSpike: true }),
        ]
        const result1 = scorer.score('27-6', turns)
        const result2 = scorer.score('27-6', turns)
        expect(result1.compositeScore).toBe(result2.compositeScore)
        expect(result1.cacheHitSubScore).toBe(result2.cacheHitSubScore)
        expect(result1.ioRatioSubScore).toBe(result2.ioRatioSubScore)
        expect(result1.contextManagementSubScore).toBe(result2.contextManagementSubScore)
        expect(result1.tokenDensitySubScore).toBe(result2.tokenDensitySubScore)
      })
    })

    describe('avgCacheHitRate and avgIoRatio', () => {
      it('should compute avgCacheHitRate as average of all turns', () => {
        const turns = [
          makeTurn({ cacheHitRate: 0.2 }),
          makeTurn({ spanId: 'span-2', cacheHitRate: 0.8 }),
        ]
        const result = scorer.score('27-6', turns)
        expect(result.avgCacheHitRate).toBeCloseTo(0.5, 5)
      })

      it('should compute avgIoRatio as average of totalInput/max(outputTokens,1)', () => {
        // turn1: (1000+500)/500=3, turn2: (2000+500)/1000=2.5 → avg=2.75
        const turns = [
          makeTurn({ inputTokens: 1000, outputTokens: 500 }),
          makeTurn({ spanId: 'span-2', inputTokens: 2000, outputTokens: 1000 }),
        ]
        const result = scorer.score('27-6', turns)
        expect(result.avgIoRatio).toBeCloseTo(2.75, 5)
      })

      it('should handle outputTokens = 0 without NaN by using max(outputTokens, 1)', () => {
        const turns = [makeTurn({ outputTokens: 0, inputTokens: 1000 })]
        const result = scorer.score('27-6', turns)
        expect(Number.isNaN(result.avgIoRatio)).toBe(false)
        expect(result.ioRatioSubScore).toBe(0)
      })
    })
  })
})
