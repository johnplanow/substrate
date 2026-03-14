/**
 * Integration tests for TelemetryPersistence efficiency_scores.
 *
 * Uses WASM SQLite (sql.js) in-memory database with schema applied
 * before each test. No better-sqlite3 or real Dolt binary required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { TelemetryPersistence } from '../persistence.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { createWasmSqliteAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import type {
  EfficiencyScore,
  ModelEfficiency,
  SourceEfficiency,
  Recommendation,
  CategoryStats,
  ConsumerStats,
  TopInvocation,
} from '../types.js'

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

async function createTestAdapter(): Promise<DatabaseAdapter> {
  const adapter = await createWasmSqliteAdapter()
  // Apply the telemetry schema
  const persistence = new TelemetryPersistence(adapter)
  await persistence.initSchema()
  return adapter
}

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function makeEfficiencyScore(overrides: Partial<EfficiencyScore> = {}): EfficiencyScore {
  const perModelBreakdown: ModelEfficiency[] = [
    { model: 'claude-sonnet', cacheHitRate: 0.75, avgIoRatio: 2.0, costPer1KOutputTokens: 0.003 },
    { model: 'unknown', cacheHitRate: 0.2, avgIoRatio: 5.0, costPer1KOutputTokens: 0.001 },
  ]
  const perSourceBreakdown: SourceEfficiency[] = [
    { source: 'claude-code', compositeScore: 88, turnCount: 10 },
    { source: 'unknown', compositeScore: 42, turnCount: 3 },
  ]

  return {
    storyKey: '27-6',
    timestamp: 1_700_000_000_000,
    compositeScore: 75,
    cacheHitSubScore: 80,
    ioRatioSubScore: 70,
    contextManagementSubScore: 75,
    avgCacheHitRate: 0.8,
    avgIoRatio: 2.0,
    contextSpikeCount: 1,
    totalTurns: 13,
    perModelBreakdown,
    perSourceBreakdown,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelemetryPersistence efficiency_scores', () => {
  let adapter: DatabaseAdapter
  let persistence: TelemetryPersistence

  beforeEach(async () => {
    adapter = await createTestAdapter()
    persistence = new TelemetryPersistence(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  describe('storeEfficiencyScore / getEfficiencyScore', () => {
    it('should round-trip all scalar fields correctly', async () => {
      const score = makeEfficiencyScore()
      await persistence.storeEfficiencyScore(score)
      const retrieved = await persistence.getEfficiencyScore('27-6')

      expect(retrieved).not.toBeNull()
      expect(retrieved!.storyKey).toBe('27-6')
      expect(retrieved!.timestamp).toBe(1_700_000_000_000)
      expect(retrieved!.compositeScore).toBe(75)
      expect(retrieved!.cacheHitSubScore).toBeCloseTo(80, 5)
      expect(retrieved!.ioRatioSubScore).toBeCloseTo(70, 5)
      expect(retrieved!.contextManagementSubScore).toBeCloseTo(75, 5)
      expect(retrieved!.avgCacheHitRate).toBeCloseTo(0.8, 5)
      expect(retrieved!.avgIoRatio).toBeCloseTo(2.0, 5)
      expect(retrieved!.contextSpikeCount).toBe(1)
      expect(retrieved!.totalTurns).toBe(13)
    })

    it('should round-trip perModelBreakdown JSON array correctly', async () => {
      const score = makeEfficiencyScore()
      await persistence.storeEfficiencyScore(score)
      const retrieved = await persistence.getEfficiencyScore('27-6')

      expect(retrieved!.perModelBreakdown).toHaveLength(2)
      const sonnet = retrieved!.perModelBreakdown.find((m) => m.model === 'claude-sonnet')
      expect(sonnet).toBeDefined()
      expect(sonnet!.cacheHitRate).toBeCloseTo(0.75, 5)
      expect(sonnet!.avgIoRatio).toBeCloseTo(2.0, 5)
      expect(sonnet!.costPer1KOutputTokens).toBeCloseTo(0.003, 5)
    })

    it('should round-trip perSourceBreakdown JSON array correctly', async () => {
      const score = makeEfficiencyScore()
      await persistence.storeEfficiencyScore(score)
      const retrieved = await persistence.getEfficiencyScore('27-6')

      expect(retrieved!.perSourceBreakdown).toHaveLength(2)
      const cc = retrieved!.perSourceBreakdown.find((s) => s.source === 'claude-code')
      expect(cc).toBeDefined()
      expect(cc!.compositeScore).toBe(88)
      expect(cc!.turnCount).toBe(10)
    })

    it('should return null for unknown storyKey', async () => {
      const result = await persistence.getEfficiencyScore('no-such-story')
      expect(result).toBeNull()
    })

    it('should replace existing row when same story_key is stored again (upsert)', async () => {
      const first = makeEfficiencyScore({ compositeScore: 50, timestamp: 1_000 })
      const second = makeEfficiencyScore({ compositeScore: 90, timestamp: 2_000 })

      await persistence.storeEfficiencyScore(first)
      await persistence.storeEfficiencyScore(second)

      // getEfficiencyScore returns the most recent (highest timestamp)
      const retrieved = await persistence.getEfficiencyScore('27-6')
      expect(retrieved).not.toBeNull()
      expect(retrieved!.compositeScore).toBe(90)
      expect(retrieved!.timestamp).toBe(2_000)
    })

    it('should replace row in-place when same (story_key, timestamp) composite PK is stored twice', async () => {
      const SHARED_TIMESTAMP = 5_000
      const first = makeEfficiencyScore({ compositeScore: 50, timestamp: SHARED_TIMESTAMP })
      const second = makeEfficiencyScore({ compositeScore: 99, timestamp: SHARED_TIMESTAMP })

      await persistence.storeEfficiencyScore(first)
      await persistence.storeEfficiencyScore(second)

      // Only one row should exist for the composite PK
      const retrieved = await persistence.getEfficiencyScore('27-6')
      expect(retrieved).not.toBeNull()
      expect(retrieved!.timestamp).toBe(SHARED_TIMESTAMP)
      expect(retrieved!.compositeScore).toBe(99)

      // Confirm exactly one row exists in the DB for this story+timestamp
      const rows = await adapter.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM efficiency_scores WHERE story_key = ? AND timestamp = ?`,
        ['27-6', SHARED_TIMESTAMP],
      )
      expect(rows[0]!.cnt).toBe(1)
    })

    it('should return the most recent score when multiple timestamps exist for same story', async () => {
      const older = makeEfficiencyScore({ compositeScore: 40, timestamp: 500 })
      const newer = makeEfficiencyScore({ compositeScore: 95, timestamp: 1000 })

      await persistence.storeEfficiencyScore(older)
      await persistence.storeEfficiencyScore(newer)

      const retrieved = await persistence.getEfficiencyScore('27-6')
      expect(retrieved!.compositeScore).toBe(95)
    })

    it('should preserve empty arrays in perModelBreakdown and perSourceBreakdown', async () => {
      const score = makeEfficiencyScore({
        perModelBreakdown: [],
        perSourceBreakdown: [],
      })
      await persistence.storeEfficiencyScore(score)
      const retrieved = await persistence.getEfficiencyScore('27-6')

      expect(retrieved!.perModelBreakdown).toEqual([])
      expect(retrieved!.perSourceBreakdown).toEqual([])
    })

    it('should validate the retrieved row with Zod schema (compositeScore in 0-100 range)', async () => {
      const score = makeEfficiencyScore({ compositeScore: 100 })
      await persistence.storeEfficiencyScore(score)
      const retrieved = await persistence.getEfficiencyScore('27-6')
      expect(retrieved!.compositeScore).toBe(100)
    })

    it('should store and retrieve scores for multiple different story keys independently', async () => {
      const score1 = makeEfficiencyScore({ storyKey: '27-1', compositeScore: 60 })
      const score2 = makeEfficiencyScore({ storyKey: '27-2', compositeScore: 80 })

      await persistence.storeEfficiencyScore(score1)
      await persistence.storeEfficiencyScore(score2)

      const r1 = await persistence.getEfficiencyScore('27-1')
      const r2 = await persistence.getEfficiencyScore('27-2')

      expect(r1!.compositeScore).toBe(60)
      expect(r2!.compositeScore).toBe(80)
    })
  })
})

// ---------------------------------------------------------------------------
// Recommendations persistence tests (story 27-7)
// ---------------------------------------------------------------------------

function makeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: 'abcd1234abcd1234',
    storyKey: '27-7',
    ruleId: 'biggest_consumers',
    severity: 'warning',
    title: 'High token consumer',
    description: 'A consumer used many tokens.',
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('TelemetryPersistence recommendations', () => {
  let adapter: DatabaseAdapter
  let persistence: TelemetryPersistence

  beforeEach(async () => {
    adapter = await createTestAdapter()
    persistence = new TelemetryPersistence(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  describe('saveRecommendations / getRecommendations', () => {
    it('should round-trip all required fields', async () => {
      const rec = makeRecommendation()
      await persistence.saveRecommendations('27-7', [rec])
      const retrieved = await persistence.getRecommendations('27-7')

      expect(retrieved).toHaveLength(1)
      const r = retrieved[0]!
      expect(r.id).toBe(rec.id)
      expect(r.storyKey).toBe('27-7')
      expect(r.ruleId).toBe('biggest_consumers')
      expect(r.severity).toBe('warning')
      expect(r.title).toBe(rec.title)
      expect(r.description).toBe(rec.description)
      expect(r.generatedAt).toBe(rec.generatedAt)
    })

    it('should round-trip optional fields: sprintId, potentialSavingsTokens, potentialSavingsUsd, actionTarget', async () => {
      const rec = makeRecommendation({
        id: 'aaaa1111aaaa1111',
        sprintId: 'sprint-3',
        potentialSavingsTokens: 1500,
        potentialSavingsUsd: 0.003,
        actionTarget: 'read_file|read',
      })
      await persistence.saveRecommendations('27-7', [rec])
      const retrieved = await persistence.getRecommendations('27-7')

      expect(retrieved).toHaveLength(1)
      const r = retrieved[0]!
      expect(r.sprintId).toBe('sprint-3')
      expect(r.potentialSavingsTokens).toBe(1500)
      expect(r.potentialSavingsUsd).toBeCloseTo(0.003, 5)
      expect(r.actionTarget).toBe('read_file|read')
    })

    it('should return empty array when no recommendations exist for storyKey', async () => {
      const result = await persistence.getRecommendations('no-such-story')
      expect(result).toEqual([])
    })

    it('should save multiple recommendations in a single transaction', async () => {
      const recs: Recommendation[] = [
        makeRecommendation({ id: 'rec1rec1rec1rec1', severity: 'critical', ruleId: 'biggest_consumers' }),
        makeRecommendation({ id: 'rec2rec2rec2rec2', severity: 'warning', ruleId: 'cache_efficiency' }),
        makeRecommendation({ id: 'rec3rec3rec3rec3', severity: 'info', ruleId: 'growing_categories' }),
      ]
      await persistence.saveRecommendations('27-7', recs)
      const retrieved = await persistence.getRecommendations('27-7')
      expect(retrieved).toHaveLength(3)
    })

    it('should order results: critical first, warning second, info third', async () => {
      const recs: Recommendation[] = [
        makeRecommendation({ id: 'info0000info0000', severity: 'info', ruleId: 'growing_categories', potentialSavingsTokens: 100 }),
        makeRecommendation({ id: 'warn0000warn0000', severity: 'warning', ruleId: 'cache_efficiency', potentialSavingsTokens: 500 }),
        makeRecommendation({ id: 'crit0000crit0000', severity: 'critical', ruleId: 'biggest_consumers', potentialSavingsTokens: 1000 }),
      ]
      await persistence.saveRecommendations('27-7', recs)
      const retrieved = await persistence.getRecommendations('27-7')

      expect(retrieved).toHaveLength(3)
      expect(retrieved[0]!.severity).toBe('critical')
      expect(retrieved[1]!.severity).toBe('warning')
      expect(retrieved[2]!.severity).toBe('info')
    })

    it('should order within same severity by potentialSavingsTokens descending', async () => {
      const recs: Recommendation[] = [
        makeRecommendation({ id: 'warn1111warn1111', severity: 'warning', ruleId: 'cache_efficiency', potentialSavingsTokens: 200 }),
        makeRecommendation({ id: 'warn2222warn2222', severity: 'warning', ruleId: 'large_file_reads', potentialSavingsTokens: 800 }),
        makeRecommendation({ id: 'warn3333warn3333', severity: 'warning', ruleId: 'expensive_bash', potentialSavingsTokens: 500 }),
      ]
      await persistence.saveRecommendations('27-7', recs)
      const retrieved = await persistence.getRecommendations('27-7')

      expect(retrieved).toHaveLength(3)
      const savings = retrieved.map((r) => r.potentialSavingsTokens ?? 0)
      expect(savings[0]).toBeGreaterThanOrEqual(savings[1]!)
      expect(savings[1]).toBeGreaterThanOrEqual(savings[2]!)
    })

    it('should validate each retrieved row with RecommendationSchema.parse() (id must be 16 chars)', async () => {
      const rec = makeRecommendation({ id: 'validid1validid1' })
      await persistence.saveRecommendations('27-7', [rec])
      // If Zod validation fails, getRecommendations() throws — so reaching here means it passed
      const retrieved = await persistence.getRecommendations('27-7')
      expect(retrieved[0]!.id).toHaveLength(16)
    })

    it('should be idempotent: reinserting same ID replaces the row', async () => {
      const rec = makeRecommendation({ id: 'idem1234idem1234', title: 'First title' })
      const recUpdated = makeRecommendation({ id: 'idem1234idem1234', title: 'Updated title' })
      await persistence.saveRecommendations('27-7', [rec])
      await persistence.saveRecommendations('27-7', [recUpdated])
      const retrieved = await persistence.getRecommendations('27-7')
      expect(retrieved).toHaveLength(1)
      expect(retrieved[0]!.title).toBe('Updated title')
    })

    it('should return empty array when saveRecommendations called with empty array', async () => {
      await persistence.saveRecommendations('27-7', [])
      const retrieved = await persistence.getRecommendations('27-7')
      expect(retrieved).toEqual([])
    })

    it('should isolate recommendations by storyKey', async () => {
      const rec1 = makeRecommendation({ id: 'story1rec1story1', storyKey: '27-7' })
      const rec2 = makeRecommendation({ id: 'story2rec2story2', storyKey: '27-8' })
      await persistence.saveRecommendations('27-7', [rec1])
      await persistence.saveRecommendations('27-8', [rec2])

      const r1 = await persistence.getRecommendations('27-7')
      const r2 = await persistence.getRecommendations('27-8')

      expect(r1).toHaveLength(1)
      expect(r1[0]!.id).toBe('story1rec1story1')
      expect(r2).toHaveLength(1)
      expect(r2[0]!.id).toBe('story2rec2story2')
    })
  })
})

// ---------------------------------------------------------------------------
// Category stats persistence tests (story 27-5)
// ---------------------------------------------------------------------------

function makeCategoryStats(overrides: Partial<CategoryStats> = {}): CategoryStats {
  return {
    category: 'tool_outputs',
    totalTokens: 5000,
    percentage: 50.0,
    eventCount: 10,
    avgTokensPerEvent: 500,
    trend: 'stable',
    ...overrides,
  }
}

describe('TelemetryPersistence category_stats', () => {
  let adapter: DatabaseAdapter
  let persistence: TelemetryPersistence

  beforeEach(async () => {
    adapter = await createTestAdapter()
    persistence = new TelemetryPersistence(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  describe('storeCategoryStats / getCategoryStats', () => {
    it('should round-trip all scalar fields correctly', async () => {
      const stat = makeCategoryStats({
        category: 'file_reads',
        totalTokens: 3000,
        percentage: 30.5,
        eventCount: 5,
        avgTokensPerEvent: 600,
        trend: 'growing',
      })
      await persistence.storeCategoryStats('27-5', [stat])
      const retrieved = await persistence.getCategoryStats('27-5')

      expect(retrieved).toHaveLength(1)
      const r = retrieved[0]!
      expect(r.category).toBe('file_reads')
      expect(r.totalTokens).toBe(3000)
      expect(r.percentage).toBeCloseTo(30.5, 3)
      expect(r.eventCount).toBe(5)
      expect(r.avgTokensPerEvent).toBeCloseTo(600, 2)
      expect(r.trend).toBe('growing')
    })

    it('should return empty array for unknown storyKey', async () => {
      const result = await persistence.getCategoryStats('no-such-story')
      expect(result).toEqual([])
    })

    it('should return results ordered by total_tokens descending', async () => {
      const stats: CategoryStats[] = [
        makeCategoryStats({ category: 'system_prompts', totalTokens: 1000 }),
        makeCategoryStats({ category: 'tool_outputs', totalTokens: 5000 }),
        makeCategoryStats({ category: 'file_reads', totalTokens: 3000 }),
      ]
      await persistence.storeCategoryStats('27-5', stats)
      const retrieved = await persistence.getCategoryStats('27-5')

      expect(retrieved).toHaveLength(3)
      expect(retrieved[0]!.category).toBe('tool_outputs')
      expect(retrieved[1]!.category).toBe('file_reads')
      expect(retrieved[2]!.category).toBe('system_prompts')
    })

    it('should be INSERT OR IGNORE: second store call preserves existing rows', async () => {
      const original = makeCategoryStats({ category: 'tool_outputs', totalTokens: 1000 })
      const duplicate = makeCategoryStats({ category: 'tool_outputs', totalTokens: 9999 })

      await persistence.storeCategoryStats('27-5', [original])
      await persistence.storeCategoryStats('27-5', [duplicate])

      const retrieved = await persistence.getCategoryStats('27-5')
      expect(retrieved).toHaveLength(1)
      expect(retrieved[0]!.totalTokens).toBe(1000) // original preserved
    })

    it('should store all 6 semantic categories and retrieve them', async () => {
      const allCategories: CategoryStats[] = [
        makeCategoryStats({ category: 'tool_outputs', totalTokens: 6000 }),
        makeCategoryStats({ category: 'file_reads', totalTokens: 3000 }),
        makeCategoryStats({ category: 'system_prompts', totalTokens: 500 }),
        makeCategoryStats({ category: 'conversation_history', totalTokens: 300 }),
        makeCategoryStats({ category: 'user_prompts', totalTokens: 150 }),
        makeCategoryStats({ category: 'other', totalTokens: 50 }),
      ]
      await persistence.storeCategoryStats('27-5', allCategories)
      const retrieved = await persistence.getCategoryStats('27-5')

      expect(retrieved).toHaveLength(6)
      const cats = retrieved.map((r) => r.category)
      expect(cats).toContain('tool_outputs')
      expect(cats).toContain('file_reads')
      expect(cats).toContain('system_prompts')
      expect(cats).toContain('conversation_history')
      expect(cats).toContain('user_prompts')
      expect(cats).toContain('other')
    })

    it('should validate each retrieved row with CategoryStatsSchema (Zod validation)', async () => {
      const stat = makeCategoryStats({ trend: 'shrinking' })
      await persistence.storeCategoryStats('27-5', [stat])
      // If Zod validation fails, getCategoryStats() throws — reaching here means pass
      const retrieved = await persistence.getCategoryStats('27-5')
      expect(retrieved[0]!.trend).toBe('shrinking')
    })

    it('should isolate stats by storyKey', async () => {
      const s1 = makeCategoryStats({ category: 'tool_outputs', totalTokens: 100 })
      const s2 = makeCategoryStats({ category: 'file_reads', totalTokens: 200 })
      await persistence.storeCategoryStats('story-a', [s1])
      await persistence.storeCategoryStats('story-b', [s2])

      const r1 = await persistence.getCategoryStats('story-a')
      const r2 = await persistence.getCategoryStats('story-b')

      expect(r1).toHaveLength(1)
      expect(r1[0]!.category).toBe('tool_outputs')
      expect(r2).toHaveLength(1)
      expect(r2[0]!.category).toBe('file_reads')
    })

    it('should return empty array when called with empty stats array', async () => {
      await persistence.storeCategoryStats('27-5', [])
      const retrieved = await persistence.getCategoryStats('27-5')
      expect(retrieved).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// Consumer stats persistence tests (story 27-5)
// ---------------------------------------------------------------------------

function makeTopInvocation(overrides: Partial<TopInvocation> = {}): TopInvocation {
  return {
    spanId: 'span-1',
    name: 'bash_op',
    toolName: 'bash',
    totalTokens: 300,
    inputTokens: 200,
    outputTokens: 100,
    ...overrides,
  }
}

function makeConsumerStats(overrides: Partial<ConsumerStats> = {}): ConsumerStats {
  return {
    consumerKey: 'bash|',
    category: 'tool_outputs',
    totalTokens: 5000,
    percentage: 50.0,
    eventCount: 10,
    topInvocations: [],
    ...overrides,
  }
}

describe('TelemetryPersistence consumer_stats', () => {
  let adapter: DatabaseAdapter
  let persistence: TelemetryPersistence

  beforeEach(async () => {
    adapter = await createTestAdapter()
    persistence = new TelemetryPersistence(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  describe('storeConsumerStats / getConsumerStats', () => {
    it('should round-trip all scalar fields correctly', async () => {
      const consumer = makeConsumerStats({
        consumerKey: 'read_file|read',
        category: 'file_reads',
        totalTokens: 8000,
        percentage: 80.0,
        eventCount: 20,
        topInvocations: [],
      })
      await persistence.storeConsumerStats('27-5', [consumer])
      const retrieved = await persistence.getConsumerStats('27-5')

      expect(retrieved).toHaveLength(1)
      const r = retrieved[0]!
      expect(r.consumerKey).toBe('read_file|read')
      expect(r.category).toBe('file_reads')
      expect(r.totalTokens).toBe(8000)
      expect(r.percentage).toBeCloseTo(80.0, 3)
      expect(r.eventCount).toBe(20)
    })

    it('should round-trip topInvocations JSON array correctly', async () => {
      const invocations: TopInvocation[] = [
        makeTopInvocation({ spanId: 'inv-1', name: 'bash_op', toolName: 'bash', totalTokens: 500, inputTokens: 300, outputTokens: 200 }),
        makeTopInvocation({ spanId: 'inv-2', name: 'read_op', toolName: undefined, totalTokens: 200, inputTokens: 200, outputTokens: 0 }),
      ]
      const consumer = makeConsumerStats({ topInvocations: invocations })
      await persistence.storeConsumerStats('27-5', [consumer])
      const retrieved = await persistence.getConsumerStats('27-5')

      expect(retrieved[0]!.topInvocations).toHaveLength(2)
      const first = retrieved[0]!.topInvocations[0]!
      expect(first.spanId).toBe('inv-1')
      expect(first.totalTokens).toBe(500)
      expect(first.inputTokens).toBe(300)
      expect(first.outputTokens).toBe(200)
    })

    it('should handle null topInvocations gracefully (deserializes as [])', async () => {
      // Directly insert a row with NULL top_invocations_json via adapter
      await adapter.query(
        `INSERT INTO consumer_stats (story_key, consumer_key, category, total_tokens, percentage, event_count, top_invocations_json)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        ['27-5', 'null_test|', 'other', 100, 1.0, 1],
      )

      const retrieved = await persistence.getConsumerStats('27-5')
      expect(retrieved).toHaveLength(1)
      expect(retrieved[0]!.topInvocations).toEqual([])
    })

    it('should return empty array for unknown storyKey', async () => {
      const result = await persistence.getConsumerStats('no-such-story')
      expect(result).toEqual([])
    })

    it('should return results ordered by total_tokens descending', async () => {
      const consumers: ConsumerStats[] = [
        makeConsumerStats({ consumerKey: 'low_op|', totalTokens: 100 }),
        makeConsumerStats({ consumerKey: 'high_op|', totalTokens: 9000 }),
        makeConsumerStats({ consumerKey: 'mid_op|', totalTokens: 3000 }),
      ]
      await persistence.storeConsumerStats('27-5', consumers)
      const retrieved = await persistence.getConsumerStats('27-5')

      expect(retrieved).toHaveLength(3)
      expect(retrieved[0]!.consumerKey).toBe('high_op|')
      expect(retrieved[1]!.consumerKey).toBe('mid_op|')
      expect(retrieved[2]!.consumerKey).toBe('low_op|')
    })

    it('should be INSERT OR IGNORE: second store call preserves existing rows', async () => {
      const original = makeConsumerStats({ consumerKey: 'bash|', totalTokens: 100 })
      const duplicate = makeConsumerStats({ consumerKey: 'bash|', totalTokens: 9999 })

      await persistence.storeConsumerStats('27-5', [original])
      await persistence.storeConsumerStats('27-5', [duplicate])

      const retrieved = await persistence.getConsumerStats('27-5')
      expect(retrieved).toHaveLength(1)
      expect(retrieved[0]!.totalTokens).toBe(100) // original preserved
    })

    it('should validate each retrieved row with ConsumerStatsSchema (Zod validation)', async () => {
      const consumer = makeConsumerStats({ category: 'system_prompts' })
      await persistence.storeConsumerStats('27-5', [consumer])
      // If Zod validation fails, getConsumerStats() throws — reaching here means pass
      const retrieved = await persistence.getConsumerStats('27-5')
      expect(retrieved[0]!.category).toBe('system_prompts')
    })

    it('should isolate stats by storyKey', async () => {
      const c1 = makeConsumerStats({ consumerKey: 'op_a|', totalTokens: 100 })
      const c2 = makeConsumerStats({ consumerKey: 'op_b|', totalTokens: 200 })
      await persistence.storeConsumerStats('story-a', [c1])
      await persistence.storeConsumerStats('story-b', [c2])

      const r1 = await persistence.getConsumerStats('story-a')
      const r2 = await persistence.getConsumerStats('story-b')

      expect(r1).toHaveLength(1)
      expect(r1[0]!.consumerKey).toBe('op_a|')
      expect(r2).toHaveLength(1)
      expect(r2[0]!.consumerKey).toBe('op_b|')
    })

    it('should return empty array when called with empty consumers array', async () => {
      await persistence.storeConsumerStats('27-5', [])
      const retrieved = await persistence.getConsumerStats('27-5')
      expect(retrieved).toEqual([])
    })

    it('should store multiple consumers in a single transaction', async () => {
      const consumers: ConsumerStats[] = [
        makeConsumerStats({ consumerKey: 'bash|', totalTokens: 5000 }),
        makeConsumerStats({ consumerKey: 'read_file|', totalTokens: 3000 }),
        makeConsumerStats({ consumerKey: 'system_prompt|', totalTokens: 2000 }),
      ]
      await persistence.storeConsumerStats('27-5', consumers)
      const retrieved = await persistence.getConsumerStats('27-5')
      expect(retrieved).toHaveLength(3)
    })
  })
})
