/**
 * Unit tests for TelemetryPipeline (Story 27-12, updated for 27-15 dual-track).
 *
 * Tests the orchestration of the full analysis pipeline using mock dependencies.
 * Verifies that processBatch() routes spans and logs to the correct analyzers,
 * merges results, and persists correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TelemetryPipeline } from '../telemetry-pipeline.js'
import type { TelemetryPipelineDeps, RawOtlpPayload } from '../telemetry-pipeline.js'
import type { TelemetryNormalizer } from '../normalizer.js'
import type { TurnAnalyzer } from '../turn-analyzer.js'
import type { LogTurnAnalyzer } from '../log-turn-analyzer.js'
import type { Categorizer } from '../categorizer.js'
import type { ConsumerAnalyzer } from '../consumer-analyzer.js'
import type { EfficiencyScorer } from '../efficiency-scorer.js'
import type { Recommender } from '../recommender.js'
import type { ITelemetryPersistence } from '../persistence.js'
import type {
  NormalizedSpan,
  NormalizedLog,
  TurnAnalysis,
  CategoryStats,
  ConsumerStats,
  EfficiencyScore,
  Recommendation,
} from '../types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORY_KEY = 'test-27-12'

function makeSpan(overrides?: Partial<NormalizedSpan>): NormalizedSpan {
  return {
    spanId: 'span-1',
    traceId: 'trace-1',
    name: 'test-span',
    source: 'claude-code',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.001,
    durationMs: 500,
    startTime: 1000000,
    storyKey: STORY_KEY,
    ...overrides,
  }
}

function makeLog(overrides?: Partial<NormalizedLog>): NormalizedLog {
  return {
    logId: 'log-1',
    traceId: 'trace-1',
    spanId: 'log-span-1',
    timestamp: 1000000,
    inputTokens: 80,
    outputTokens: 40,
    cacheReadTokens: 10,
    costUsd: 0.0005,
    model: 'claude-3-5-sonnet',
    storyKey: STORY_KEY,
    ...overrides,
  }
}

function makeTurnAnalysis(overrides?: Partial<TurnAnalysis>): TurnAnalysis {
  return {
    spanId: 'span-1',
    turnNumber: 1,
    name: 'test-span',
    timestamp: 1000000,
    source: 'claude-code',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    freshTokens: 100,
    cacheHitRate: 0,
    costUsd: 0.001,
    durationMs: 500,
    contextSize: 100,
    contextDelta: 100,
    isContextSpike: false,
    childSpans: [],
    ...overrides,
  }
}

function makeLogTurnAnalysis(overrides?: Partial<TurnAnalysis>): TurnAnalysis {
  return {
    spanId: 'log-span-1',
    turnNumber: 1,
    name: 'log_turn',
    timestamp: 1000000,
    source: 'claude-code',
    inputTokens: 80,
    outputTokens: 40,
    cacheReadTokens: 10,
    freshTokens: 70,
    cacheHitRate: 0.125,
    costUsd: 0.0005,
    durationMs: 0,
    contextSize: 80,
    contextDelta: 80,
    isContextSpike: false,
    childSpans: [],
    ...overrides,
  }
}

function makeCategoryStats(): CategoryStats[] {
  return [{
    category: 'tool_outputs',
    totalTokens: 150,
    percentage: 100,
    eventCount: 1,
    avgTokensPerEvent: 150,
    trend: 'stable',
  }]
}

function makeConsumerStats(): ConsumerStats[] {
  return [{
    consumerKey: 'test-span|',
    category: 'tool_outputs',
    totalTokens: 150,
    percentage: 100,
    eventCount: 1,
    topInvocations: [],
  }]
}

function makeEfficiencyScore(): EfficiencyScore {
  return {
    storyKey: STORY_KEY,
    timestamp: Date.now(),
    compositeScore: 75,
    cacheHitSubScore: 0,
    ioRatioSubScore: 80,
    contextManagementSubScore: 100,
    tokenDensitySubScore: 50,
    avgCacheHitRate: 0,
    avgIoRatio: 2,
    contextSpikeCount: 0,
    totalTurns: 1,
    coldStartTurnsExcluded: 0,
    perModelBreakdown: [],
    perSourceBreakdown: [],
  }
}

function makeRecommendation(): Recommendation {
  return {
    id: 'abcd1234abcd1234',
    storyKey: STORY_KEY,
    ruleId: 'cache_efficiency',
    severity: 'warning',
    title: 'Improve cache efficiency',
    description: 'Cache hit rate is low',
    generatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockDeps(
  spans: NormalizedSpan[] = [makeSpan()],
  logs: NormalizedLog[] = [],
): TelemetryPipelineDeps & {
  normalizer: { normalizeSpan: ReturnType<typeof vi.fn>; normalizeLog: ReturnType<typeof vi.fn> }
  logTurnAnalyzer: { analyze: ReturnType<typeof vi.fn> }
  persistence: {
    storeTurnAnalysis: ReturnType<typeof vi.fn>
    storeCategoryStats: ReturnType<typeof vi.fn>
    storeConsumerStats: ReturnType<typeof vi.fn>
    storeEfficiencyScore: ReturnType<typeof vi.fn>
    saveRecommendations: ReturnType<typeof vi.fn>
  }
} {
  const turns = [makeTurnAnalysis()]
  const logTurns = logs.length > 0 ? [makeLogTurnAnalysis()] : []
  const categories = makeCategoryStats()
  const consumers = makeConsumerStats()
  const effScore = makeEfficiencyScore()
  const recommendations = [makeRecommendation()]

  return {
    normalizer: {
      normalizeSpan: vi.fn().mockReturnValue(spans),
      normalizeLog: vi.fn().mockReturnValue(logs),
    } as unknown as TelemetryNormalizer & { normalizeSpan: ReturnType<typeof vi.fn>; normalizeLog: ReturnType<typeof vi.fn> },

    turnAnalyzer: {
      analyze: vi.fn().mockReturnValue(turns),
    } as unknown as TurnAnalyzer,

    logTurnAnalyzer: {
      analyze: vi.fn().mockReturnValue(logTurns),
    } as unknown as LogTurnAnalyzer & { analyze: ReturnType<typeof vi.fn> },

    categorizer: {
      computeCategoryStats: vi.fn().mockReturnValue(categories),
      computeCategoryStatsFromTurns: vi.fn().mockReturnValue(categories),
      classify: vi.fn(),
    } as unknown as Categorizer,

    consumerAnalyzer: {
      analyze: vi.fn().mockReturnValue(consumers),
      analyzeFromTurns: vi.fn().mockReturnValue(consumers),
    } as unknown as ConsumerAnalyzer,

    efficiencyScorer: {
      score: vi.fn().mockReturnValue(effScore),
    } as unknown as EfficiencyScorer,

    recommender: {
      analyze: vi.fn().mockReturnValue(recommendations),
    } as unknown as Recommender,

    persistence: {
      storeTurnAnalysis: vi.fn().mockResolvedValue(undefined),
      getTurnAnalysis: vi.fn().mockResolvedValue([]),
      storeEfficiencyScore: vi.fn().mockResolvedValue(undefined),
      getEfficiencyScore: vi.fn().mockResolvedValue(null),
      getEfficiencyScores: vi.fn().mockResolvedValue([]),
      saveRecommendations: vi.fn().mockResolvedValue(undefined),
      getRecommendations: vi.fn().mockResolvedValue([]),
      getAllRecommendations: vi.fn().mockResolvedValue([]),
      storeCategoryStats: vi.fn().mockResolvedValue(undefined),
      getCategoryStats: vi.fn().mockResolvedValue([]),
      storeConsumerStats: vi.fn().mockResolvedValue(undefined),
      getConsumerStats: vi.fn().mockResolvedValue([]),
      purgeStoryTelemetry: vi.fn().mockResolvedValue(undefined),
    } as unknown as ITelemetryPersistence & {
      storeTurnAnalysis: ReturnType<typeof vi.fn>
      storeCategoryStats: ReturnType<typeof vi.fn>
      storeConsumerStats: ReturnType<typeof vi.fn>
      storeEfficiencyScore: ReturnType<typeof vi.fn>
      saveRecommendations: ReturnType<typeof vi.fn>
    },
  }
}

function makePayload(overrides?: Partial<RawOtlpPayload>): RawOtlpPayload {
  return {
    body: { resourceSpans: [] },
    source: 'claude-code',
    receivedAt: Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests — existing span-based behavior (AC4: unchanged)
// ---------------------------------------------------------------------------

describe('TelemetryPipeline', () => {
  let deps: ReturnType<typeof makeMockDeps>
  let pipeline: TelemetryPipeline

  beforeEach(() => {
    deps = makeMockDeps()
    pipeline = new TelemetryPipeline(deps)
  })

  // -- processBatch basics --

  it('does nothing for an empty batch', async () => {
    await pipeline.processBatch([])
    expect(deps.normalizer.normalizeSpan).not.toHaveBeenCalled()
  })

  it('calls normalizer.normalizeSpan for each item', async () => {
    const payloads = [makePayload(), makePayload()]
    await pipeline.processBatch(payloads)
    expect(deps.normalizer.normalizeSpan).toHaveBeenCalledTimes(2)
  })

  it('calls normalizer.normalizeLog for each item (AC2)', async () => {
    const payloads = [makePayload(), makePayload()]
    await pipeline.processBatch(payloads)
    expect(deps.normalizer.normalizeLog).toHaveBeenCalledTimes(2)
  })

  it('calls turnAnalyzer.analyze with normalized spans grouped by storyKey', async () => {
    await pipeline.processBatch([makePayload()])
    expect((deps.turnAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ storyKey: STORY_KEY })]))
  })

  it('calls categorizer.computeCategoryStats with spans and turns', async () => {
    await pipeline.processBatch([makePayload()])
    expect((deps.categorizer as unknown as { computeCategoryStats: ReturnType<typeof vi.fn> }).computeCategoryStats)
      .toHaveBeenCalled()
  })

  it('calls consumerAnalyzer.analyze with spans', async () => {
    await pipeline.processBatch([makePayload()])
    expect((deps.consumerAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .toHaveBeenCalled()
  })

  it('calls efficiencyScorer.score with storyKey and turns', async () => {
    await pipeline.processBatch([makePayload()])
    expect((deps.efficiencyScorer as unknown as { score: ReturnType<typeof vi.fn> }).score)
      .toHaveBeenCalledWith(STORY_KEY, expect.any(Array))
  })

  it('calls recommender.analyze with context including storyKey', async () => {
    await pipeline.processBatch([makePayload()])
    expect((deps.recommender as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .toHaveBeenCalledWith(expect.objectContaining({ storyKey: STORY_KEY }))
  })

  // -- persistence --

  it('calls persistence.storeTurnAnalysis for story with turns', async () => {
    await pipeline.processBatch([makePayload()])
    expect(deps.persistence.storeTurnAnalysis).toHaveBeenCalledWith(
      STORY_KEY,
      expect.any(Array),
    )
  })

  it('calls persistence.storeCategoryStats', async () => {
    await pipeline.processBatch([makePayload()])
    expect(deps.persistence.storeCategoryStats).toHaveBeenCalledWith(
      STORY_KEY,
      expect.any(Array),
    )
  })

  it('calls persistence.storeConsumerStats', async () => {
    await pipeline.processBatch([makePayload()])
    expect(deps.persistence.storeConsumerStats).toHaveBeenCalledWith(
      STORY_KEY,
      expect.any(Array),
    )
  })

  it('calls persistence.storeEfficiencyScore', async () => {
    await pipeline.processBatch([makePayload()])
    expect(deps.persistence.storeEfficiencyScore).toHaveBeenCalledWith(
      expect.objectContaining({ storyKey: STORY_KEY }),
    )
  })

  it('calls persistence.saveRecommendations', async () => {
    await pipeline.processBatch([makePayload()])
    expect(deps.persistence.saveRecommendations).toHaveBeenCalledWith(
      STORY_KEY,
      expect.any(Array),
    )
  })

  // -- spans without storyKey are skipped --

  it('skips analysis for spans without storyKey', async () => {
    deps = makeMockDeps([makeSpan({ storyKey: undefined })])
    pipeline = new TelemetryPipeline(deps)

    await pipeline.processBatch([makePayload()])

    // Normalizer called, but analysis stages should not be called
    expect(deps.normalizer.normalizeSpan).toHaveBeenCalled()
    expect((deps.turnAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .not.toHaveBeenCalled()
    expect(deps.persistence.storeTurnAnalysis).not.toHaveBeenCalled()
  })

  // -- error resilience --

  it('does not throw when normalizer throws', async () => {
    deps.normalizer.normalizeSpan
      .mockImplementation(() => { throw new Error('normalizer error') })

    await expect(pipeline.processBatch([makePayload()])).resolves.not.toThrow()
  })

  it('does not throw when persistence.storeTurnAnalysis rejects', async () => {
    deps.persistence.storeTurnAnalysis.mockRejectedValue(new Error('db error'))
    await expect(pipeline.processBatch([makePayload()])).resolves.not.toThrow()
  })

  it('does not throw when persistence.storeEfficiencyScore rejects', async () => {
    deps.persistence.storeEfficiencyScore.mockRejectedValue(new Error('db error'))
    await expect(pipeline.processBatch([makePayload()])).resolves.not.toThrow()
  })

  // -- multi-story batches --

  it('processes spans for multiple stories independently', async () => {
    const span1 = makeSpan({ spanId: 'span-1', storyKey: '27-1' })
    const span2 = makeSpan({ spanId: 'span-2', storyKey: '27-2' })
    deps = makeMockDeps([span1, span2])
    pipeline = new TelemetryPipeline(deps)

    await pipeline.processBatch([makePayload()])

    // turnAnalyzer should be called once per story
    expect((deps.turnAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .toHaveBeenCalledTimes(2)
  })

  // -- empty spans from normalizer --

  it('does nothing for a batch where normalizer returns no spans and no logs', async () => {
    deps = makeMockDeps([])
    pipeline = new TelemetryPipeline(deps)

    await pipeline.processBatch([makePayload()])

    expect((deps.turnAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .not.toHaveBeenCalled()
    expect(deps.persistence.storeTurnAnalysis).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests — Dual-track behavior (Story 27-15)
// ---------------------------------------------------------------------------

describe('TelemetryPipeline dual-track (Story 27-15)', () => {
  // -- AC1: No early return on zero spans --

  it('AC1: processes logs when spans are empty (no early return)', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)
    const pipeline = new TelemetryPipeline(deps)

    await pipeline.processBatch([makePayload()])

    // LogTurnAnalyzer should be called
    expect(deps.logTurnAnalyzer.analyze).toHaveBeenCalledWith(logs)
    // TurnAnalyzer should NOT be called (no spans)
    expect((deps.turnAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .not.toHaveBeenCalled()
  })

  // -- AC2: Dual-track turn analysis --

  it('AC2: calls both analyzers when batch has spans and logs', async () => {
    const spans = [makeSpan()]
    const logs = [makeLog()]
    const deps = makeMockDeps(spans, logs)
    const pipeline = new TelemetryPipeline(deps)

    await pipeline.processBatch([makePayload()])

    // Both analyzers called
    expect((deps.turnAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .toHaveBeenCalledWith(spans)
    expect(deps.logTurnAnalyzer.analyze).toHaveBeenCalledWith(logs)
  })

  it('AC2: merges span and log turns, deduplicating by spanId', async () => {
    // Span and log share a spanId → span turn should win
    const sharedSpanId = 'shared-span-id'
    const spans = [makeSpan({ spanId: sharedSpanId })]
    const logs = [makeLog({ spanId: sharedSpanId })]

    const spanTurn = makeTurnAnalysis({ spanId: sharedSpanId, inputTokens: 200 })
    const logTurn = makeLogTurnAnalysis({ spanId: sharedSpanId, inputTokens: 80 })

    const deps = makeMockDeps(spans, logs)
    ;(deps.turnAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze
      .mockReturnValue([spanTurn])
    deps.logTurnAnalyzer.analyze.mockReturnValue([logTurn])

    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    // Efficiency scorer should be called with merged turns (only 1, span wins)
    const scoreCall = (deps.efficiencyScorer as unknown as { score: ReturnType<typeof vi.fn> }).score
    expect(scoreCall).toHaveBeenCalledWith(STORY_KEY, expect.any(Array))
    const actualTurns = scoreCall.mock.calls[0][1] as TurnAnalysis[]
    expect(actualTurns).toHaveLength(1)
    expect(actualTurns[0].inputTokens).toBe(200) // Span turn wins
  })

  it('AC2: merged turns include unique log turns alongside span turns', async () => {
    const spans = [makeSpan({ spanId: 'span-only' })]
    const logs = [makeLog({ spanId: 'log-only' })]

    const spanTurn = makeTurnAnalysis({ spanId: 'span-only', timestamp: 1000000 })
    const logTurn = makeLogTurnAnalysis({ spanId: 'log-only', timestamp: 2000000 })

    const deps = makeMockDeps(spans, logs)
    ;(deps.turnAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze
      .mockReturnValue([spanTurn])
    deps.logTurnAnalyzer.analyze.mockReturnValue([logTurn])

    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    const scoreCall = (deps.efficiencyScorer as unknown as { score: ReturnType<typeof vi.fn> }).score
    const actualTurns = scoreCall.mock.calls[0][1] as TurnAnalysis[]
    expect(actualTurns).toHaveLength(2)
    // Should be sorted by timestamp and renumbered
    expect(actualTurns[0].spanId).toBe('span-only')
    expect(actualTurns[0].turnNumber).toBe(1)
    expect(actualTurns[1].spanId).toBe('log-only')
    expect(actualTurns[1].turnNumber).toBe(2)
  })

  // -- AC3: Log-only path produces complete analysis --

  it('AC3: log-only batch produces turn analysis and efficiency score', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)
    const pipeline = new TelemetryPipeline(deps)

    await pipeline.processBatch([makePayload()])

    // Persistence called for turns and efficiency
    expect(deps.persistence.storeTurnAnalysis).toHaveBeenCalledWith(
      STORY_KEY,
      expect.any(Array),
    )
    expect(deps.persistence.storeEfficiencyScore).toHaveBeenCalledWith(
      expect.objectContaining({ storyKey: STORY_KEY }),
    )
  })

  it('AC3: log-only path calls computeCategoryStatsFromTurns and analyzeFromTurns but NOT span-based categorizer or consumer analyzer', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)
    const pipeline = new TelemetryPipeline(deps)

    await pipeline.processBatch([makePayload()])

    // Span-based categorizer and consumer not called
    expect((deps.categorizer as unknown as { computeCategoryStats: ReturnType<typeof vi.fn> }).computeCategoryStats)
      .not.toHaveBeenCalled()
    expect((deps.consumerAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .not.toHaveBeenCalled()
    // Turn-based category stats IS called
    expect((deps.categorizer as unknown as { computeCategoryStatsFromTurns: ReturnType<typeof vi.fn> }).computeCategoryStatsFromTurns)
      .toHaveBeenCalled()
    // Turn-based consumer stats IS called (AC2 — Story 30-4)
    expect((deps.consumerAnalyzer as unknown as { analyzeFromTurns: ReturnType<typeof vi.fn> }).analyzeFromTurns)
      .toHaveBeenCalled()
  })

  // -- AC4: Span-only path unchanged --

  it('AC4: span-only batch uses turnAnalyzer only (logTurnAnalyzer not called)', async () => {
    const spans = [makeSpan()]
    const deps = makeMockDeps(spans) // no logs
    const pipeline = new TelemetryPipeline(deps)

    await pipeline.processBatch([makePayload()])

    expect((deps.turnAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .toHaveBeenCalledWith(spans)
    expect(deps.logTurnAnalyzer.analyze).not.toHaveBeenCalled()

    // Full analysis path runs
    expect((deps.categorizer as unknown as { computeCategoryStats: ReturnType<typeof vi.fn> }).computeCategoryStats)
      .toHaveBeenCalled()
    expect((deps.consumerAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .toHaveBeenCalled()
    expect(deps.persistence.storeTurnAnalysis).toHaveBeenCalled()
    expect(deps.persistence.storeEfficiencyScore).toHaveBeenCalled()
  })

  // -- AC5: Log story key grouping --

  it('AC5: logs from multiple stories are grouped and analyzed independently', async () => {
    const log1 = makeLog({ logId: 'log-1', spanId: 'ls1', storyKey: '27-a' })
    const log2 = makeLog({ logId: 'log-2', spanId: 'ls2', storyKey: '27-b' })
    const deps = makeMockDeps([], [log1, log2])
    // Return different turns for each call
    deps.logTurnAnalyzer.analyze
      .mockReturnValueOnce([makeLogTurnAnalysis({ spanId: 'ls1' })])
      .mockReturnValueOnce([makeLogTurnAnalysis({ spanId: 'ls2' })])

    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    // LogTurnAnalyzer called twice (once per story)
    expect(deps.logTurnAnalyzer.analyze).toHaveBeenCalledTimes(2)
    // Each story's logs analyzed independently
    expect(deps.logTurnAnalyzer.analyze).toHaveBeenCalledWith([log1])
    expect(deps.logTurnAnalyzer.analyze).toHaveBeenCalledWith([log2])
  })

  // -- AC6: Persistence called for log-derived turns --

  it('AC6: persistence.storeTurnAnalysis and storeEfficiencyScore called for log-derived turns', async () => {
    const logTurn = makeLogTurnAnalysis()
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)
    deps.logTurnAnalyzer.analyze.mockReturnValue([logTurn])

    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    expect(deps.persistence.storeTurnAnalysis).toHaveBeenCalledWith(
      STORY_KEY,
      [logTurn],
    )
    expect(deps.persistence.storeEfficiencyScore).toHaveBeenCalledWith(
      expect.objectContaining({ storyKey: STORY_KEY }),
    )
  })

  // -- Edge cases --

  it('empty batch (no spans, no logs) returns early', async () => {
    const deps = makeMockDeps([], [])
    const pipeline = new TelemetryPipeline(deps)

    await pipeline.processBatch([makePayload()])

    expect((deps.turnAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .not.toHaveBeenCalled()
    expect(deps.logTurnAnalyzer.analyze).not.toHaveBeenCalled()
    expect(deps.persistence.storeTurnAnalysis).not.toHaveBeenCalled()
  })

  it('logs without storyKey are skipped for analysis', async () => {
    const logs = [makeLog({ storyKey: undefined })]
    const deps = makeMockDeps([], logs)
    const pipeline = new TelemetryPipeline(deps)

    await pipeline.processBatch([makePayload()])

    expect(deps.logTurnAnalyzer.analyze).not.toHaveBeenCalled()
    expect(deps.persistence.storeTurnAnalysis).not.toHaveBeenCalled()
  })

  it('does not throw when logTurnAnalyzer returns empty array', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)
    deps.logTurnAnalyzer.analyze.mockReturnValue([])
    const pipeline = new TelemetryPipeline(deps)

    await expect(pipeline.processBatch([makePayload()])).resolves.not.toThrow()
    // No turns → _processStoryFromTurns returns early
    expect(deps.persistence.storeTurnAnalysis).not.toHaveBeenCalled()
  })

  it('does not throw when persistence rejects in log-only path', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)
    deps.logTurnAnalyzer.analyze.mockReturnValue([makeLogTurnAnalysis()])
    deps.persistence.storeTurnAnalysis.mockRejectedValue(new Error('db error'))
    deps.persistence.storeEfficiencyScore.mockRejectedValue(new Error('db error'))

    const pipeline = new TelemetryPipeline(deps)
    await expect(pipeline.processBatch([makePayload()])).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Tests — Log-only path parity (Story 30-4)
// ---------------------------------------------------------------------------

describe('TelemetryPipeline log-only path parity (Story 30-4)', () => {
  it('log-only path calls all 5 persistence methods (AC: 30-4)', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)

    // Ensure non-empty returns from all analyzers so persistence is called
    deps.logTurnAnalyzer.analyze.mockReturnValue([makeLogTurnAnalysis()])
    ;(deps.categorizer as unknown as { computeCategoryStatsFromTurns: ReturnType<typeof vi.fn> }).computeCategoryStatsFromTurns
      .mockReturnValue(makeCategoryStats())
    ;(deps.consumerAnalyzer as unknown as { analyzeFromTurns: ReturnType<typeof vi.fn> }).analyzeFromTurns
      .mockReturnValue(makeConsumerStats())
    ;(deps.recommender as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze
      .mockReturnValue([makeRecommendation()])

    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    // All 5 persistence methods called with the correct story key
    expect(deps.persistence.storeTurnAnalysis).toHaveBeenCalledWith(STORY_KEY, expect.any(Array))
    expect(deps.persistence.storeEfficiencyScore).toHaveBeenCalledWith(
      expect.objectContaining({ storyKey: STORY_KEY }),
    )
    expect(deps.persistence.storeCategoryStats).toHaveBeenCalledWith(STORY_KEY, expect.any(Array))
    expect(deps.persistence.storeConsumerStats).toHaveBeenCalledWith(STORY_KEY, expect.any(Array))
    expect(deps.persistence.saveRecommendations).toHaveBeenCalledWith(STORY_KEY, expect.any(Array))
  })

  it('log-only path passes analyzeFromTurns result to storeConsumerStats', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)
    const expectedConsumers = makeConsumerStats()

    deps.logTurnAnalyzer.analyze.mockReturnValue([makeLogTurnAnalysis()])
    ;(deps.consumerAnalyzer as unknown as { analyzeFromTurns: ReturnType<typeof vi.fn> }).analyzeFromTurns
      .mockReturnValue(expectedConsumers)

    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    expect(deps.persistence.storeConsumerStats).toHaveBeenCalledWith(STORY_KEY, expectedConsumers)
  })

  it('log-only path passes recommender.analyze result to saveRecommendations', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)
    const expectedRec = makeRecommendation()

    deps.logTurnAnalyzer.analyze.mockReturnValue([makeLogTurnAnalysis()])
    ;(deps.recommender as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze
      .mockReturnValue([expectedRec])

    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    expect(deps.persistence.saveRecommendations).toHaveBeenCalledWith(STORY_KEY, [expectedRec])
  })

  it('log-only path calls recommender.analyze with allSpans: [] (AC3)', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)
    deps.logTurnAnalyzer.analyze.mockReturnValue([makeLogTurnAnalysis()])

    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    expect((deps.recommender as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .toHaveBeenCalledWith(expect.objectContaining({ allSpans: [], storyKey: STORY_KEY }))
  })

  it('persistence errors in consumer stats and recommendations do not throw', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)
    deps.logTurnAnalyzer.analyze.mockReturnValue([makeLogTurnAnalysis()])
    ;(deps.consumerAnalyzer as unknown as { analyzeFromTurns: ReturnType<typeof vi.fn> }).analyzeFromTurns
      .mockReturnValue(makeConsumerStats())
    ;(deps.recommender as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze
      .mockReturnValue([makeRecommendation()])
    deps.persistence.storeConsumerStats.mockRejectedValue(new Error('consumer db error'))
    deps.persistence.saveRecommendations.mockRejectedValue(new Error('recs db error'))

    const pipeline = new TelemetryPipeline(deps)
    await expect(pipeline.processBatch([makePayload()])).resolves.not.toThrow()
  })

  it('skips storeConsumerStats when analyzeFromTurns returns empty array', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)
    deps.logTurnAnalyzer.analyze.mockReturnValue([makeLogTurnAnalysis()])
    ;(deps.consumerAnalyzer as unknown as { analyzeFromTurns: ReturnType<typeof vi.fn> }).analyzeFromTurns
      .mockReturnValue([])

    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    expect(deps.persistence.storeConsumerStats).not.toHaveBeenCalled()
  })

  it('skips saveRecommendations when recommender returns empty array', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)
    deps.logTurnAnalyzer.analyze.mockReturnValue([makeLogTurnAnalysis()])
    ;(deps.recommender as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze
      .mockReturnValue([])

    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    expect(deps.persistence.saveRecommendations).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests — Per-dispatch efficiency scoring (Story 30-3)
// ---------------------------------------------------------------------------

describe('TelemetryPipeline per-dispatch efficiency scoring (Story 30-3)', () => {
  // Helper that creates turns with a dispatchId
  function makeTurnWithDispatch(overrides?: Partial<TurnAnalysis>): TurnAnalysis {
    return makeTurnAnalysis(overrides)
  }

  it('produces 3 storeEfficiencyScore calls when turns have 2 distinct dispatchIds (log-only path)', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)

    // 3 turns with dispatch-1, 2 with dispatch-2, 1 with no dispatchId
    const dispatchedTurns: TurnAnalysis[] = [
      makeTurnWithDispatch({ spanId: 'ls1', dispatchId: 'dispatch-1', taskType: 'dev-story', phase: 'implementation' }),
      makeTurnWithDispatch({ spanId: 'ls2', dispatchId: 'dispatch-1', taskType: 'dev-story', phase: 'implementation' }),
      makeTurnWithDispatch({ spanId: 'ls3', dispatchId: 'dispatch-1', taskType: 'dev-story', phase: 'implementation' }),
      makeTurnWithDispatch({ spanId: 'ls4', dispatchId: 'dispatch-2', taskType: 'code-review', phase: 'review' }),
      makeTurnWithDispatch({ spanId: 'ls5', dispatchId: 'dispatch-2', taskType: 'code-review', phase: 'review' }),
      makeTurnWithDispatch({ spanId: 'ls6' }), // no dispatchId
    ]
    deps.logTurnAnalyzer.analyze.mockReturnValue(dispatchedTurns)
    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    // 1 story aggregate + 2 dispatch scores = 3 total calls
    expect(deps.persistence.storeEfficiencyScore).toHaveBeenCalledTimes(3)
  })

  it('dispatch score objects carry correct dispatchId, taskType, phase', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)

    const dispatchedTurns: TurnAnalysis[] = [
      makeTurnWithDispatch({ spanId: 'ls1', dispatchId: 'dispatch-1', taskType: 'dev-story', phase: 'implementation' }),
      makeTurnWithDispatch({ spanId: 'ls2', dispatchId: 'dispatch-1', taskType: 'dev-story', phase: 'implementation' }),
      makeTurnWithDispatch({ spanId: 'ls3', dispatchId: 'dispatch-2', taskType: 'code-review', phase: 'review' }),
      makeTurnWithDispatch({ spanId: 'ls4', dispatchId: 'dispatch-2', taskType: 'code-review', phase: 'review' }),
    ]
    deps.logTurnAnalyzer.analyze.mockReturnValue(dispatchedTurns)
    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    const calls = deps.persistence.storeEfficiencyScore.mock.calls as [TurnAnalysis][]
    // First call is story aggregate (no dispatchId)
    expect((calls[0]![0] as EfficiencyScore).dispatchId).toBeUndefined()
    // Subsequent calls have dispatchId
    const dispatchCalls = calls.slice(1).map((c) => c[0] as EfficiencyScore)
    const dispatchIds = dispatchCalls.map((s) => s.dispatchId)
    expect(dispatchIds).toContain('dispatch-1')
    expect(dispatchIds).toContain('dispatch-2')

    const d1 = dispatchCalls.find((s) => s.dispatchId === 'dispatch-1')!
    expect(d1.taskType).toBe('dev-story')
    expect(d1.phase).toBe('implementation')

    const d2 = dispatchCalls.find((s) => s.dispatchId === 'dispatch-2')!
    expect(d2.taskType).toBe('code-review')
    expect(d2.phase).toBe('review')
  })

  it('turns with no dispatchId at all → only 1 call to storeEfficiencyScore', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)

    const turns: TurnAnalysis[] = [
      makeTurnAnalysis({ spanId: 'ls1' }),
      makeTurnAnalysis({ spanId: 'ls2' }),
    ]
    deps.logTurnAnalyzer.analyze.mockReturnValue(turns)
    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    expect(deps.persistence.storeEfficiencyScore).toHaveBeenCalledTimes(1)
  })

  it('timestamp offsets are unique across story and dispatch scores', async () => {
    const logs = [makeLog()]
    const deps = makeMockDeps([], logs)

    const turns: TurnAnalysis[] = [
      makeTurnWithDispatch({ spanId: 'ls1', dispatchId: 'dispatch-1' }),
      makeTurnWithDispatch({ spanId: 'ls2', dispatchId: 'dispatch-2' }),
    ]
    deps.logTurnAnalyzer.analyze.mockReturnValue(turns)
    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    const calls = deps.persistence.storeEfficiencyScore.mock.calls as [EfficiencyScore][]
    const timestamps = calls.map((c) => c[0].timestamp)
    // All timestamps must be unique
    const unique = new Set(timestamps)
    expect(unique.size).toBe(timestamps.length)
    // Story aggregate is the smallest timestamp
    const storyTs = calls[0]![0].timestamp
    const dispatchTs = calls.slice(1).map((c) => c[0].timestamp)
    for (const ts of dispatchTs) {
      expect(ts).toBeGreaterThan(storyTs)
    }
  })

  it('span-path also produces dispatch scores when turns have dispatchIds', async () => {
    const spans = [makeSpan()]
    const deps = makeMockDeps(spans)

    // Override turnAnalyzer to return turns with dispatchIds
    const spannedTurns: TurnAnalysis[] = [
      makeTurnWithDispatch({ spanId: 'sp1', dispatchId: 'dispatch-A', taskType: 'dev-story', phase: 'implementation' }),
      makeTurnWithDispatch({ spanId: 'sp2', dispatchId: 'dispatch-A', taskType: 'dev-story', phase: 'implementation' }),
    ]
    ;(deps.turnAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze
      .mockReturnValue(spannedTurns)

    const pipeline = new TelemetryPipeline(deps)
    await pipeline.processBatch([makePayload()])

    // 1 story aggregate + 1 dispatch = 2 calls
    expect(deps.persistence.storeEfficiencyScore).toHaveBeenCalledTimes(2)
    const calls = deps.persistence.storeEfficiencyScore.mock.calls as [EfficiencyScore][]
    const dispatchScore = calls.find((c) => c[0].dispatchId !== undefined)![0]
    expect(dispatchScore.dispatchId).toBe('dispatch-A')
    expect(dispatchScore.taskType).toBe('dev-story')
    expect(dispatchScore.phase).toBe('implementation')
  })
})
