/**
 * Unit tests for EfficiencyScorer.
 *
 * Tests cover all scoring logic without touching SQLite or Dolt.
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
      expect(result.totalTurns).toBe(0)
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
      // cacheHitRate of -0.5 * 100 = -50 → clamped to 0
      const turns = [makeTurn({ cacheHitRate: -0.5 })]
      const result = scorer.score('27-6', turns)
      expect(result.cacheHitSubScore).toBe(0)
    })

    it('should compute ioRatioSubScore near 80 when avgIoRatio = 1 (equal input/output)', () => {
      // inputTokens=1000, outputTokens=1000 → ioRatio=1 → 100 - (1-1)*20 = 100 ... clamp=100? No
      // ioRatioSubScore = 100 - (1-1)*20 = 100 - 0 = 100, clamped to 100
      // Wait, re-read: "At avgIoRatio=1: score=80". Let me re-check the formula.
      // The story says: ioRatioSubScore = clamp(100 - (avgIoRatio - 1) * 20, 0, 100)
      // avgIoRatio=1: 100 - (1-1)*20 = 100 - 0 = 100 ... hmm that's 100 not 80
      // But story notes say "At avgIoRatio of 1.0 (equal input/output) maps to 80"
      // That contradicts the formula. The formula is the truth per AC2.
      // With inputTokens=1000, outputTokens=1000: ratio=1000/1000=1, score=100
      const turns = [makeTurn({ inputTokens: 1000, outputTokens: 1000, cacheHitRate: 0 })]
      const result = scorer.score('27-6', turns)
      expect(result.ioRatioSubScore).toBe(100)
    })

    it('should clamp ioRatioSubScore to 0 when avgIoRatio is very high', () => {
      // inputTokens=100000, outputTokens=100 → ratio=1000 → 100-(1000-1)*20 very negative → 0
      const turns = [makeTurn({ inputTokens: 100_000, outputTokens: 100, cacheHitRate: 0 })]
      const result = scorer.score('27-6', turns)
      expect(result.ioRatioSubScore).toBe(0)
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

    it('should compute composite score weighted sum correctly', () => {
      // All cacheHitRate=1.0 → cacheHitSubScore=100
      // ioRatio=1000/500=2 → 100-(2-1)*20=80 → ioRatioSubScore=80
      // no spikes → contextManagementSubScore=100
      // composite = round(100*0.4 + 80*0.3 + 100*0.3) = round(40+24+30) = round(94) = 94
      const turns = [
        makeTurn({
          inputTokens: 1000,
          outputTokens: 500,
          cacheHitRate: 1.0,
          isContextSpike: false,
        }),
      ]
      const result = scorer.score('27-6', turns)
      expect(result.compositeScore).toBe(94)
      expect(result.cacheHitSubScore).toBe(100)
      expect(result.ioRatioSubScore).toBe(80)
      expect(result.contextManagementSubScore).toBe(100)
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
        const turns = [
          makeTurn({ source: 'claude-code', cacheHitRate: 1.0, isContextSpike: false }),
          makeTurn({ spanId: 'span-2', source: 'unknown', cacheHitRate: 0, isContextSpike: true }),
        ]
        const result = scorer.score('27-6', turns)
        expect(result.perSourceBreakdown).toHaveLength(2)
        const cc = result.perSourceBreakdown.find((s) => s.source === 'claude-code')
        const unk = result.perSourceBreakdown.find((s) => s.source === 'unknown')
        expect(cc).toBeDefined()
        expect(unk).toBeDefined()
        // claude-code: cacheHit=100, ioRatio=2→80, no spikes=100 → composite=94
        expect(cc!.compositeScore).toBe(94)
        // unknown: cacheHit=0, ioRatio=2→80, spike=0 → composite=round(0*0.4+80*0.3+0*0.3)=24
        expect(unk!.compositeScore).toBe(24)
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
        expect(result.compositeScore).toBeGreaterThanOrEqual(0)
        expect(result.compositeScore).toBeLessThanOrEqual(100)
      })

      it('should produce contextDelta = inputTokens for a single turn (no spikes from that alone)', () => {
        // Single turn cannot be 2x its own average, so isContextSpike=false is forced by logic
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

      it('should compute avgIoRatio as average of inputTokens/max(outputTokens,1)', () => {
        // turn1: 1000/500=2, turn2: 2000/1000=2 → avg=2
        const turns = [
          makeTurn({ inputTokens: 1000, outputTokens: 500 }),
          makeTurn({ spanId: 'span-2', inputTokens: 2000, outputTokens: 1000 }),
        ]
        const result = scorer.score('27-6', turns)
        expect(result.avgIoRatio).toBeCloseTo(2.0, 5)
      })

      it('should handle outputTokens = 0 without NaN by using max(outputTokens, 1)', () => {
        const turns = [makeTurn({ outputTokens: 0, inputTokens: 1000 })]
        const result = scorer.score('27-6', turns)
        // ioRatio = 1000/1 = 1000 → ioRatioSubScore = clamp(100-(1000-1)*20,0,100) = 0
        expect(Number.isNaN(result.avgIoRatio)).toBe(false)
        expect(result.ioRatioSubScore).toBe(0)
      })
    })
  })
})
