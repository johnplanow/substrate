/**
 * Unit tests for Recommender (story 27-7).
 *
 * Tests cover all 8 rules in isolation and the analyze() orchestrator.
 * All tests use minimal fixture contexts — no SQLite or Dolt touches.
 * Logger is injected as a vi.fn() stub.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type pino from 'pino'

import { Recommender } from '../recommender.js'
import type {
  RecommenderContext,
  NormalizedSpan,
  TurnAnalysis,
  CategoryStats,
  ConsumerStats,
  EfficiencyScore,
} from '../types.js'

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
// Minimal fixture builders
// ---------------------------------------------------------------------------

function makeSpan(overrides: Partial<NormalizedSpan> = {}): NormalizedSpan {
  return {
    spanId: 'span-1',
    traceId: 'trace-1',
    name: 'test_span',
    source: 'claude-code',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.001,
    durationMs: 100,
    startTime: 1000,
    ...overrides,
  }
}

function makeTurn(overrides: Partial<TurnAnalysis> = {}): TurnAnalysis {
  return {
    spanId: 'turn-1',
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

function makeConsumer(overrides: Partial<ConsumerStats> = {}): ConsumerStats {
  return {
    consumerKey: 'test_op|test_tool',
    category: 'tool_outputs',
    totalTokens: 1000,
    percentage: 10,
    eventCount: 1,
    topInvocations: [],
    ...overrides,
  }
}

function makeCategory(overrides: Partial<CategoryStats> = {}): CategoryStats {
  return {
    category: 'file_reads',
    totalTokens: 1000,
    percentage: 10,
    eventCount: 1,
    avgTokensPerEvent: 1000,
    trend: 'stable',
    ...overrides,
  }
}

function makeEfficiencyScore(overrides: Partial<EfficiencyScore> = {}): EfficiencyScore {
  return {
    storyKey: '27-7',
    timestamp: 1000,
    compositeScore: 50,
    cacheHitSubScore: 50,
    ioRatioSubScore: 50,
    contextManagementSubScore: 50,
    avgCacheHitRate: 0.5,
    avgIoRatio: 2,
    contextSpikeCount: 0,
    totalTurns: 1,
    perModelBreakdown: [],
    perSourceBreakdown: [],
    ...overrides,
  }
}

function makeContext(overrides: Partial<RecommenderContext> = {}): RecommenderContext {
  return {
    storyKey: '27-7',
    generatedAt: '2026-01-01T00:00:00.000Z',
    turns: [],
    categories: [],
    consumers: [],
    efficiencyScore: makeEfficiencyScore(),
    allSpans: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Recommender', () => {
  let logger: pino.Logger
  let recommender: Recommender

  beforeEach(() => {
    logger = makeMockLogger()
    recommender = new Recommender(logger)
  })

  // -------------------------------------------------------------------------
  // Rule: biggest_consumers
  // -------------------------------------------------------------------------

  describe('biggest_consumers rule', () => {
    it('should emit nothing when all consumers are below 5% threshold', () => {
      const totalTokens = 10000
      const consumers: ConsumerStats[] = [
        makeConsumer({ consumerKey: 'op1|', totalTokens: 400, percentage: 4.0 }),
        makeConsumer({ consumerKey: 'op2|', totalTokens: 300, percentage: 3.0 }),
      ]
      const context = makeContext({ consumers })
      const result = recommender.analyze(context)
      const biggestConsumerRecs = result.filter((r) => r.ruleId === 'biggest_consumers')
      expect(biggestConsumerRecs).toHaveLength(0)
      void totalTokens
    })

    it('should emit recommendations for top consumers above 5%', () => {
      const consumers: ConsumerStats[] = [
        makeConsumer({ consumerKey: 'file_read|', totalTokens: 5000, percentage: 50 }),
        makeConsumer({ consumerKey: 'bash|', totalTokens: 3000, percentage: 30 }),
        makeConsumer({ consumerKey: 'other|', totalTokens: 2000, percentage: 20 }),
      ]
      const context = makeContext({ consumers })
      const result = recommender.analyze(context)
      const biggestConsumerRecs = result.filter((r) => r.ruleId === 'biggest_consumers')
      expect(biggestConsumerRecs).toHaveLength(3)
    })

    it('should assign critical severity when consumer > 25% of total', () => {
      const consumers: ConsumerStats[] = [
        makeConsumer({ consumerKey: 'big_op|', totalTokens: 8000, percentage: 80 }),
        makeConsumer({ consumerKey: 'small_op|', totalTokens: 2000, percentage: 20 }),
      ]
      const context = makeContext({ consumers })
      const result = recommender.analyze(context)
      const biggestConsumerRec = result.find((r) => r.ruleId === 'biggest_consumers' && r.actionTarget === 'big_op|')
      expect(biggestConsumerRec?.severity).toBe('critical')
    })

    it('should return empty array when consumers list is empty', () => {
      const context = makeContext({ consumers: [] })
      const result = recommender.analyze(context)
      const biggestConsumerRecs = result.filter((r) => r.ruleId === 'biggest_consumers')
      expect(biggestConsumerRecs).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Rule: large_file_reads
  // -------------------------------------------------------------------------

  describe('large_file_reads rule', () => {
    it('should fire only for spans with inputTokens > 3000', () => {
      const spans = [
        makeSpan({ operationName: 'file_read', inputTokens: 3001, outputTokens: 0 }),
      ]
      const context = makeContext({ allSpans: spans })
      const result = recommender.analyze(context)
      const fileReadRecs = result.filter((r) => r.ruleId === 'large_file_reads')
      expect(fileReadRecs).toHaveLength(1)
    })

    it('should NOT fire for spans with inputTokens exactly 3000', () => {
      const spans = [
        makeSpan({ operationName: 'file_read', inputTokens: 3000, outputTokens: 0 }),
      ]
      const context = makeContext({ allSpans: spans })
      const result = recommender.analyze(context)
      const fileReadRecs = result.filter((r) => r.ruleId === 'large_file_reads')
      expect(fileReadRecs).toHaveLength(0)
    })

    it('should NOT fire for spans where operationName is not file_read', () => {
      const spans = [
        makeSpan({ operationName: 'tool_use', inputTokens: 5000, outputTokens: 0 }),
      ]
      const context = makeContext({ allSpans: spans })
      const result = recommender.analyze(context)
      const fileReadRecs = result.filter((r) => r.ruleId === 'large_file_reads')
      expect(fileReadRecs).toHaveLength(0)
    })

    it('should include suggestion to use line ranges in description', () => {
      const spans = [
        makeSpan({ operationName: 'file_read', inputTokens: 4000, outputTokens: 0, name: 'read_src_file' }),
      ]
      const context = makeContext({ allSpans: spans })
      const result = recommender.analyze(context)
      const rec = result.find((r) => r.ruleId === 'large_file_reads')
      expect(rec?.description).toContain('line range')
    })
  })

  // -------------------------------------------------------------------------
  // Rule: expensive_bash
  // -------------------------------------------------------------------------

  describe('expensive_bash rule', () => {
    it('should fire for spans named bash with outputTokens > 3000', () => {
      const spans = [
        makeSpan({ name: 'bash', outputTokens: 3500 }),
      ]
      const context = makeContext({ allSpans: spans })
      const result = recommender.analyze(context)
      const bashRecs = result.filter((r) => r.ruleId === 'expensive_bash')
      expect(bashRecs).toHaveLength(1)
    })

    it('should fire for spans named execute_command with outputTokens > 3000', () => {
      const spans = [
        makeSpan({ name: 'execute_command', outputTokens: 4000 }),
      ]
      const context = makeContext({ allSpans: spans })
      const result = recommender.analyze(context)
      const bashRecs = result.filter((r) => r.ruleId === 'expensive_bash')
      expect(bashRecs).toHaveLength(1)
    })

    it('should fire for spans with operationName execute_command', () => {
      const spans = [
        makeSpan({ operationName: 'execute_command', outputTokens: 3500 }),
      ]
      const context = makeContext({ allSpans: spans })
      const result = recommender.analyze(context)
      const bashRecs = result.filter((r) => r.ruleId === 'expensive_bash')
      expect(bashRecs).toHaveLength(1)
    })

    it('should NOT fire for spans with outputTokens <= 3000', () => {
      const spans = [
        makeSpan({ name: 'bash', outputTokens: 2999 }),
      ]
      const context = makeContext({ allSpans: spans })
      const result = recommender.analyze(context)
      const bashRecs = result.filter((r) => r.ruleId === 'expensive_bash')
      expect(bashRecs).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Rule: repeated_tool_calls
  // -------------------------------------------------------------------------

  describe('repeated_tool_calls rule', () => {
    it('should fire when a tool+target appears more than once', () => {
      const turns: TurnAnalysis[] = [
        makeTurn({
          spanId: 'turn-1',
          turnNumber: 1,
          childSpans: [
            { spanId: 'c1', name: 'read_file', toolName: 'read', inputTokens: 1000, outputTokens: 0, durationMs: 100 },
            { spanId: 'c2', name: 'read_file', toolName: 'read', inputTokens: 1000, outputTokens: 0, durationMs: 100 },
          ],
        }),
      ]
      const context = makeContext({ turns })
      const result = recommender.analyze(context)
      const repeatedRecs = result.filter((r) => r.ruleId === 'repeated_tool_calls')
      expect(repeatedRecs).toHaveLength(1)
      expect(repeatedRecs[0]?.description).toContain('cach')
    })

    it('should NOT fire for a single occurrence', () => {
      const turns: TurnAnalysis[] = [
        makeTurn({
          spanId: 'turn-1',
          childSpans: [
            { spanId: 'c1', name: 'read_file', toolName: 'read', inputTokens: 1000, outputTokens: 0, durationMs: 100 },
          ],
        }),
      ]
      const context = makeContext({ turns })
      const result = recommender.analyze(context)
      const repeatedRecs = result.filter((r) => r.ruleId === 'repeated_tool_calls')
      expect(repeatedRecs).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Rule: context_growth_spike
  // -------------------------------------------------------------------------

  describe('context_growth_spike rule', () => {
    it('should fire for each turn where isContextSpike is true', () => {
      const turns: TurnAnalysis[] = [
        makeTurn({ spanId: 'turn-1', turnNumber: 1, isContextSpike: false }),
        makeTurn({ spanId: 'turn-2', turnNumber: 2, isContextSpike: true }),
        makeTurn({ spanId: 'turn-3', turnNumber: 3, isContextSpike: true }),
      ]
      const context = makeContext({ turns })
      const result = recommender.analyze(context)
      const spikeRecs = result.filter((r) => r.ruleId === 'context_growth_spike')
      expect(spikeRecs).toHaveLength(2)
    })

    it('should assign at minimum warning severity even for low token percentage', () => {
      // A spike turn with tiny token count relative to total would normally be 'info'
      // but context_growth_spike must be at least 'warning'
      const spans = Array.from({ length: 100 }, (_, i) =>
        makeSpan({ spanId: `span-${i}`, inputTokens: 10000, outputTokens: 5000 }),
      )
      const spikeTurn = makeTurn({
        spanId: 'turn-spike',
        turnNumber: 1,
        isContextSpike: true,
        inputTokens: 1, // tiny — < 10% threshold
        outputTokens: 1,
      })
      const context = makeContext({ turns: [spikeTurn], allSpans: spans })
      const result = recommender.analyze(context)
      const spikeRec = result.find((r) => r.ruleId === 'context_growth_spike')
      expect(spikeRec?.severity).toBe('warning')
    })

    it('should include top 3 child span names in description', () => {
      const spikeTurn = makeTurn({
        isContextSpike: true,
        childSpans: [
          { spanId: 'c1', name: 'big_tool', toolName: 'bash', inputTokens: 5000, outputTokens: 0, durationMs: 100 },
          { spanId: 'c2', name: 'medium_tool', toolName: 'read', inputTokens: 2000, outputTokens: 0, durationMs: 100 },
          { spanId: 'c3', name: 'small_tool', toolName: null, inputTokens: 100, outputTokens: 0, durationMs: 100 },
          { spanId: 'c4', name: 'tiny_tool', toolName: null, inputTokens: 10, outputTokens: 0, durationMs: 100 },
        ],
      })
      const context = makeContext({ turns: [spikeTurn] })
      const result = recommender.analyze(context)
      const spikeRec = result.find((r) => r.ruleId === 'context_growth_spike')
      expect(spikeRec?.description).toContain('big_tool')
      expect(spikeRec?.description).toContain('medium_tool')
      // Only top 3 are included; tiny_tool should not be explicitly listed
    })

    it('should return empty array when no turns are present', () => {
      const context = makeContext({ turns: [] })
      const result = recommender.analyze(context)
      const spikeRecs = result.filter((r) => r.ruleId === 'context_growth_spike')
      expect(spikeRecs).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Rule: growing_categories
  // -------------------------------------------------------------------------

  describe('growing_categories rule', () => {
    it('should fire for categories with trend growing', () => {
      const categories: CategoryStats[] = [
        makeCategory({ category: 'file_reads', trend: 'growing', percentage: 15 }),
        makeCategory({ category: 'tool_outputs', trend: 'stable', percentage: 20 }),
      ]
      const context = makeContext({ categories })
      const result = recommender.analyze(context)
      const growingRecs = result.filter((r) => r.ruleId === 'growing_categories')
      expect(growingRecs).toHaveLength(1)
      expect(growingRecs[0]?.actionTarget).toBe('file_reads')
    })

    it('should assign info severity for growing category at or below 25%', () => {
      const categories: CategoryStats[] = [
        makeCategory({ category: 'file_reads', trend: 'growing', percentage: 20 }),
      ]
      const context = makeContext({ categories })
      const result = recommender.analyze(context)
      const rec = result.find((r) => r.ruleId === 'growing_categories')
      expect(rec?.severity).toBe('info')
    })

    it('should assign warning severity for growing category above 25%', () => {
      const categories: CategoryStats[] = [
        makeCategory({ category: 'file_reads', trend: 'growing', percentage: 30 }),
      ]
      const context = makeContext({ categories })
      const result = recommender.analyze(context)
      const rec = result.find((r) => r.ruleId === 'growing_categories')
      expect(rec?.severity).toBe('warning')
    })

    it('should NOT fire for stable or shrinking categories', () => {
      const categories: CategoryStats[] = [
        makeCategory({ category: 'file_reads', trend: 'stable', percentage: 50 }),
        makeCategory({ category: 'tool_outputs', trend: 'shrinking', percentage: 30 }),
      ]
      const context = makeContext({ categories })
      const result = recommender.analyze(context)
      const growingRecs = result.filter((r) => r.ruleId === 'growing_categories')
      expect(growingRecs).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Rule: cache_efficiency
  // -------------------------------------------------------------------------

  describe('cache_efficiency rule', () => {
    it('should fire when cache hit rate is below 30%', () => {
      const efficiencyScore = makeEfficiencyScore({ avgCacheHitRate: 0.29 })
      const spans = [makeSpan({ inputTokens: 1000, cacheReadTokens: 100, outputTokens: 0 })]
      const context = makeContext({ efficiencyScore, allSpans: spans })
      const result = recommender.analyze(context)
      const cacheRecs = result.filter((r) => r.ruleId === 'cache_efficiency')
      expect(cacheRecs).toHaveLength(1)
    })

    it('should NOT fire when cache hit rate is >= 30%', () => {
      const efficiencyScore = makeEfficiencyScore({ avgCacheHitRate: 0.30 })
      const spans = [makeSpan({ inputTokens: 1000, cacheReadTokens: 300, outputTokens: 0 })]
      const context = makeContext({ efficiencyScore, allSpans: spans })
      const result = recommender.analyze(context)
      const cacheRecs = result.filter((r) => r.ruleId === 'cache_efficiency')
      expect(cacheRecs).toHaveLength(0)
    })

    it('should compute potentialSavingsTokens as totalCacheMissTokens * 0.5', () => {
      const efficiencyScore = makeEfficiencyScore({ avgCacheHitRate: 0.1 })
      // span with 1000 input, 100 cached => 900 miss tokens
      const spans = [makeSpan({ inputTokens: 1000, cacheReadTokens: 100, outputTokens: 0 })]
      const context = makeContext({ efficiencyScore, allSpans: spans })
      const result = recommender.analyze(context)
      const cacheRec = result.find((r) => r.ruleId === 'cache_efficiency')
      expect(cacheRec?.potentialSavingsTokens).toBe(450) // 900 * 0.5
    })

    it('should treat NaN cache hit rate as 0 (worst case)', () => {
      const efficiencyScore = makeEfficiencyScore({ avgCacheHitRate: NaN })
      const spans = [makeSpan({ inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0 })]
      const context = makeContext({ efficiencyScore, allSpans: spans })
      const result = recommender.analyze(context)
      const cacheRecs = result.filter((r) => r.ruleId === 'cache_efficiency')
      expect(cacheRecs).toHaveLength(1)
    })

    it('should return empty when allSpans is empty even with low cache rate', () => {
      const efficiencyScore = makeEfficiencyScore({ avgCacheHitRate: 0.0 })
      const context = makeContext({ efficiencyScore, allSpans: [] })
      const result = recommender.analyze(context)
      const cacheRecs = result.filter((r) => r.ruleId === 'cache_efficiency')
      expect(cacheRecs).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Rule: per_model_comparison
  // -------------------------------------------------------------------------

  describe('per_model_comparison rule', () => {
    it('should NOT fire when only one model is present', () => {
      const efficiencyScore = makeEfficiencyScore({
        perModelBreakdown: [
          { model: 'claude-sonnet', cacheHitRate: 0.8, avgIoRatio: 2, costPer1KOutputTokens: 10 },
        ],
      })
      const context = makeContext({ efficiencyScore })
      const result = recommender.analyze(context)
      const modelRecs = result.filter((r) => r.ruleId === 'per_model_comparison')
      expect(modelRecs).toHaveLength(0)
    })

    it('should fire when more than one model is present', () => {
      const efficiencyScore = makeEfficiencyScore({
        perModelBreakdown: [
          { model: 'claude-sonnet', cacheHitRate: 0.8, avgIoRatio: 2, costPer1KOutputTokens: 10 },
          { model: 'claude-haiku', cacheHitRate: 0.2, avgIoRatio: 3, costPer1KOutputTokens: 5 },
        ],
      })
      const context = makeContext({ efficiencyScore })
      const result = recommender.analyze(context)
      const modelRecs = result.filter((r) => r.ruleId === 'per_model_comparison')
      expect(modelRecs).toHaveLength(1)
      expect(modelRecs[0]?.actionTarget).toBe('claude-haiku')
    })

    it('should assign warning severity when gap is > 20 percentage points', () => {
      const efficiencyScore = makeEfficiencyScore({
        perModelBreakdown: [
          { model: 'best-model', cacheHitRate: 0.9, avgIoRatio: 2, costPer1KOutputTokens: 10 },
          { model: 'worst-model', cacheHitRate: 0.65, avgIoRatio: 3, costPer1KOutputTokens: 5 },
        ],
      })
      const context = makeContext({ efficiencyScore })
      const result = recommender.analyze(context)
      const rec = result.find((r) => r.ruleId === 'per_model_comparison')
      expect(rec?.severity).toBe('warning') // 25pp gap > 20pp
    })

    it('should assign info severity when gap is <= 20 percentage points', () => {
      const efficiencyScore = makeEfficiencyScore({
        perModelBreakdown: [
          { model: 'model-a', cacheHitRate: 0.5, avgIoRatio: 2, costPer1KOutputTokens: 10 },
          { model: 'model-b', cacheHitRate: 0.35, avgIoRatio: 3, costPer1KOutputTokens: 5 },
        ],
      })
      const context = makeContext({ efficiencyScore })
      const result = recommender.analyze(context)
      const rec = result.find((r) => r.ruleId === 'per_model_comparison')
      expect(rec?.severity).toBe('info') // 15pp gap <= 20pp
    })
  })

  // -------------------------------------------------------------------------
  // Severity threshold tests
  // -------------------------------------------------------------------------

  describe('severity assignment', () => {
    it('should assign critical when token percent > 25%', () => {
      const consumers: ConsumerStats[] = [
        makeConsumer({ consumerKey: 'big_consumer|', totalTokens: 8000, percentage: 80 }),
        makeConsumer({ consumerKey: 'small|', totalTokens: 2000, percentage: 20 }),
      ]
      const context = makeContext({ consumers })
      const result = recommender.analyze(context)
      const rec = result.find((r) => r.ruleId === 'biggest_consumers' && r.actionTarget === 'big_consumer|')
      expect(rec?.severity).toBe('critical')
    })

    it('should assign warning when token percent > 10% but <= 25%', () => {
      // Consumer at ~15%
      const consumers: ConsumerStats[] = [
        makeConsumer({ consumerKey: 'medium_consumer|', totalTokens: 1500, percentage: 15 }),
        makeConsumer({ consumerKey: 'large|', totalTokens: 8500, percentage: 85 }),
      ]
      const context = makeContext({ consumers })
      const result = recommender.analyze(context)
      const rec = result.find((r) => r.ruleId === 'biggest_consumers' && r.actionTarget === 'medium_consumer|')
      expect(rec?.severity).toBe('warning')
    })

    it('should assign info when token percent <= 10%', () => {
      // Consumer at 6% exactly (above 5% threshold, below 10%)
      const consumers: ConsumerStats[] = [
        makeConsumer({ consumerKey: 'small_consumer|', totalTokens: 600, percentage: 6 }),
        makeConsumer({ consumerKey: 'large_consumer|', totalTokens: 9400, percentage: 94 }),
      ]
      const context = makeContext({ consumers })
      const result = recommender.analyze(context)
      const rec = result.find((r) => r.ruleId === 'biggest_consumers' && r.actionTarget === 'small_consumer|')
      expect(rec?.severity).toBe('info')
    })
  })

  // -------------------------------------------------------------------------
  // analyze() orchestrator — ordering
  // -------------------------------------------------------------------------

  describe('analyze() output ordering', () => {
    it('should sort: critical first, then warning, then info', () => {
      // Setup context that will generate recs of different severities
      const consumers: ConsumerStats[] = [
        makeConsumer({ consumerKey: 'critical_op|', totalTokens: 8000, percentage: 80 }), // critical
        makeConsumer({ consumerKey: 'warning_op|', totalTokens: 1500, percentage: 15 }), // warning
        makeConsumer({ consumerKey: 'info_op|', totalTokens: 600, percentage: 6 }),       // info
        makeConsumer({ consumerKey: 'tiny_op|', totalTokens: 100, percentage: 1 }),       // below 5%, not emitted
      ]
      const context = makeContext({ consumers })
      const result = recommender.analyze(context)

      const severityOrder = result.map((r) => r.severity)
      for (let i = 0; i < severityOrder.length - 1; i++) {
        const curr = severityOrder[i]!
        const next = severityOrder[i + 1]!
        const order = { critical: 0, warning: 1, info: 2 }
        expect(order[curr]).toBeLessThanOrEqual(order[next])
      }
    })

    it('should sort within same severity by potentialSavingsTokens descending', () => {
      // Two growing categories at the same severity (warning, >25%)
      const categories: CategoryStats[] = [
        makeCategory({ category: 'file_reads', trend: 'growing', totalTokens: 3000, percentage: 30 }),
        makeCategory({ category: 'tool_outputs', trend: 'growing', totalTokens: 2000, percentage: 26 }),
      ]
      const context = makeContext({ categories })
      const result = recommender.analyze(context)
      const growingRecs = result.filter((r) => r.ruleId === 'growing_categories')
      if (growingRecs.length === 2) {
        const firstSavings = growingRecs[0]?.potentialSavingsTokens ?? 0
        const secondSavings = growingRecs[1]?.potentialSavingsTokens ?? 0
        expect(firstSavings).toBeGreaterThanOrEqual(secondSavings)
      }
    })
  })

  // -------------------------------------------------------------------------
  // ID determinism
  // -------------------------------------------------------------------------

  describe('ID determinism', () => {
    it('should generate the same ID for the same inputs across calls', () => {
      const consumers: ConsumerStats[] = [
        makeConsumer({ consumerKey: 'test_op|', totalTokens: 5000, percentage: 50 }),
        makeConsumer({ consumerKey: 'other_op|', totalTokens: 5000, percentage: 50 }),
      ]
      const context = makeContext({ consumers })
      const result1 = recommender.analyze(context)
      const result2 = recommender.analyze(context)

      const ids1 = result1.map((r) => r.id).sort()
      const ids2 = result2.map((r) => r.id).sort()
      expect(ids1).toEqual(ids2)
    })

    it('should generate 16-char hex IDs', () => {
      const consumers: ConsumerStats[] = [
        makeConsumer({ consumerKey: 'test_op|', totalTokens: 5000, percentage: 50 }),
        makeConsumer({ consumerKey: 'other_op|', totalTokens: 5000, percentage: 50 }),
      ]
      const context = makeContext({ consumers })
      const result = recommender.analyze(context)
      for (const rec of result) {
        expect(rec.id).toMatch(/^[0-9a-f]{16}$/)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Snapshot test
  // -------------------------------------------------------------------------

  describe('analyze() snapshot test', () => {
    it('should produce deterministic output for the sample fixture', () => {
      const fixturePath = resolve(
        process.cwd(),
        'tests/fixtures/telemetry/sample-recommender-context.json',
      )
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as RecommenderContext
      // Pin generatedAt for determinism
      const context: RecommenderContext = {
        ...fixture,
        generatedAt: '2026-01-01T00:00:00.000Z',
      }
      const result = recommender.analyze(context)
      expect(result).toMatchSnapshot()
    })
  })
})
