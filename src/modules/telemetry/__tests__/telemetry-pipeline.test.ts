/**
 * Unit tests for TelemetryPipeline (Story 27-12, Task 6).
 *
 * Tests the orchestration of the full analysis pipeline using mock dependencies.
 * Verifies that processBatch() routes spans to normalizer, analyzer, scorer,
 * and persistence correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TelemetryPipeline } from '../telemetry-pipeline.js'
import type { TelemetryPipelineDeps, RawOtlpPayload } from '../telemetry-pipeline.js'
import type { TelemetryNormalizer } from '../normalizer.js'
import type { TurnAnalyzer } from '../turn-analyzer.js'
import type { Categorizer } from '../categorizer.js'
import type { ConsumerAnalyzer } from '../consumer-analyzer.js'
import type { EfficiencyScorer } from '../efficiency-scorer.js'
import type { Recommender } from '../recommender.js'
import type { ITelemetryPersistence } from '../persistence.js'
import type {
  NormalizedSpan,
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

function makeTurnAnalysis(): TurnAnalysis {
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
    avgCacheHitRate: 0,
    avgIoRatio: 2,
    contextSpikeCount: 0,
    totalTurns: 1,
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

function makeMockDeps(spans: NormalizedSpan[] = [makeSpan()]): TelemetryPipelineDeps & {
  normalizer: { normalizeSpan: ReturnType<typeof vi.fn> }
  persistence: {
    storeTurnAnalysis: ReturnType<typeof vi.fn>
    storeCategoryStats: ReturnType<typeof vi.fn>
    storeConsumerStats: ReturnType<typeof vi.fn>
    storeEfficiencyScore: ReturnType<typeof vi.fn>
    saveRecommendations: ReturnType<typeof vi.fn>
  }
} {
  const turns = [makeTurnAnalysis()]
  const categories = makeCategoryStats()
  const consumers = makeConsumerStats()
  const effScore = makeEfficiencyScore()
  const recommendations = [makeRecommendation()]

  return {
    normalizer: {
      normalizeSpan: vi.fn().mockReturnValue(spans),
      normalizeLog: vi.fn().mockReturnValue([]),
    } as unknown as TelemetryNormalizer & { normalizeSpan: ReturnType<typeof vi.fn> },

    turnAnalyzer: {
      analyze: vi.fn().mockReturnValue(turns),
    } as unknown as TurnAnalyzer,

    categorizer: {
      computeCategoryStats: vi.fn().mockReturnValue(categories),
      classify: vi.fn(),
    } as unknown as Categorizer,

    consumerAnalyzer: {
      analyze: vi.fn().mockReturnValue(consumers),
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
// Tests
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
    expect((deps.normalizer as unknown as { normalizeLog: ReturnType<typeof vi.fn> }).normalizeLog)
      .toHaveBeenCalledTimes(2)
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
    (deps.normalizer as unknown as { normalizeSpan: ReturnType<typeof vi.fn> }).normalizeSpan
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

  it('does nothing for a batch where normalizer returns no spans', async () => {
    deps = makeMockDeps([])
    pipeline = new TelemetryPipeline(deps)

    await pipeline.processBatch([makePayload()])

    expect((deps.turnAnalyzer as unknown as { analyze: ReturnType<typeof vi.fn> }).analyze)
      .not.toHaveBeenCalled()
    expect(deps.persistence.storeTurnAnalysis).not.toHaveBeenCalled()
  })
})
