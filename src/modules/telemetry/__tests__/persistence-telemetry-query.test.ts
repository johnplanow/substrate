/**
 * Integration tests for new TelemetryPersistence query methods (Story 27-8).
 *
 * Tests:
 * - getEfficiencyScores(limit?) — ordering by timestamp DESC, limit enforcement
 * - getEfficiencyScore(storyKey) — returns correct record and null for unknown key
 * - getAllRecommendations(limit?) — ordering: critical first, then by savings DESC
 *
 * Uses WASM SQLite (sql.js) in-memory database. No real Dolt required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { TelemetryPersistence } from '../persistence.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { createWasmSqliteAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import type { EfficiencyScore, ModelEfficiency, SourceEfficiency, Recommendation } from '../types.js'

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

async function createTestAdapter(): Promise<DatabaseAdapter> {
  const adapter = await createWasmSqliteAdapter()
  const persistence = new TelemetryPersistence(adapter)
  await persistence.initSchema()
  return adapter
}

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeEfficiencyScore(overrides: Partial<EfficiencyScore> = {}): EfficiencyScore {
  const perModelBreakdown: ModelEfficiency[] = [
    { model: 'claude-sonnet', cacheHitRate: 0.75, avgIoRatio: 2.0, costPer1KOutputTokens: 0.003 },
  ]
  const perSourceBreakdown: SourceEfficiency[] = [
    { source: 'claude-code', compositeScore: 88, turnCount: 10 },
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

// ---------------------------------------------------------------------------
// getEfficiencyScores tests
// ---------------------------------------------------------------------------

describe('TelemetryPersistence — getEfficiencyScores', () => {
  let adapter: DatabaseAdapter
  let persistence: TelemetryPersistence

  beforeEach(async () => {
    adapter = await createTestAdapter()
    persistence = new TelemetryPersistence(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('should return empty array when no scores exist', async () => {
    const scores = await persistence.getEfficiencyScores()
    expect(scores).toEqual([])
  })

  it('should return all scores ordered by timestamp DESC', async () => {
    const oldest = makeEfficiencyScore({ storyKey: '27-1', timestamp: 1000, compositeScore: 50 })
    const middle = makeEfficiencyScore({ storyKey: '27-2', timestamp: 2000, compositeScore: 60 })
    const newest = makeEfficiencyScore({ storyKey: '27-3', timestamp: 3000, compositeScore: 70 })

    await persistence.storeEfficiencyScore(middle)
    await persistence.storeEfficiencyScore(oldest)
    await persistence.storeEfficiencyScore(newest)

    const scores = await persistence.getEfficiencyScores()
    expect(scores).toHaveLength(3)
    expect(scores[0]!.timestamp).toBe(3000)
    expect(scores[1]!.timestamp).toBe(2000)
    expect(scores[2]!.timestamp).toBe(1000)
  })

  it('should apply default limit of 20', async () => {
    // Insert 25 scores with unique (storyKey, timestamp) combos
    for (let i = 0; i < 25; i++) {
      await persistence.storeEfficiencyScore(
        makeEfficiencyScore({ storyKey: `story-${i}`, timestamp: i + 1000, compositeScore: 50 }),
      )
    }

    const scores = await persistence.getEfficiencyScores()
    expect(scores).toHaveLength(20)
  })

  it('should apply custom limit', async () => {
    for (let i = 0; i < 10; i++) {
      await persistence.storeEfficiencyScore(
        makeEfficiencyScore({ storyKey: `story-${i}`, timestamp: i + 1000, compositeScore: 50 }),
      )
    }

    const scores = await persistence.getEfficiencyScores(5)
    expect(scores).toHaveLength(5)
  })

  it('should return fewer records than limit when fewer exist', async () => {
    await persistence.storeEfficiencyScore(makeEfficiencyScore({ storyKey: '27-6', timestamp: 1000 }))
    await persistence.storeEfficiencyScore(makeEfficiencyScore({ storyKey: '27-7', timestamp: 2000 }))

    const scores = await persistence.getEfficiencyScores(10)
    expect(scores).toHaveLength(2)
  })

  it('should validate each returned row with EfficiencyScoreSchema', async () => {
    await persistence.storeEfficiencyScore(makeEfficiencyScore())
    // If Zod validation fails, getEfficiencyScores() throws — reaching here means it passed
    const scores = await persistence.getEfficiencyScores()
    expect(scores[0]!.compositeScore).toBeGreaterThanOrEqual(0)
    expect(scores[0]!.compositeScore).toBeLessThanOrEqual(100)
  })

  it('should return the most recent score per story (not deduplicated — multiple timestamps per story are valid)', async () => {
    const score1 = makeEfficiencyScore({ storyKey: '27-6', timestamp: 1000, compositeScore: 50 })
    const score2 = makeEfficiencyScore({ storyKey: '27-6', timestamp: 2000, compositeScore: 90 })

    await persistence.storeEfficiencyScore(score1)
    await persistence.storeEfficiencyScore(score2)

    const scores = await persistence.getEfficiencyScores()
    expect(scores).toHaveLength(2)
    // Ordered by timestamp DESC — newest first
    expect(scores[0]!.compositeScore).toBe(90)
    expect(scores[1]!.compositeScore).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// getEfficiencyScore (single story) tests — also verifying existing method
// ---------------------------------------------------------------------------

describe('TelemetryPersistence — getEfficiencyScore (single story lookup)', () => {
  let adapter: DatabaseAdapter
  let persistence: TelemetryPersistence

  beforeEach(async () => {
    adapter = await createTestAdapter()
    persistence = new TelemetryPersistence(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('should return null for unknown story key', async () => {
    const result = await persistence.getEfficiencyScore('no-such-story')
    expect(result).toBeNull()
  })

  it('should return the most recent score for a story when multiple timestamps exist', async () => {
    await persistence.storeEfficiencyScore(makeEfficiencyScore({ storyKey: '27-6', timestamp: 500, compositeScore: 40 }))
    await persistence.storeEfficiencyScore(makeEfficiencyScore({ storyKey: '27-6', timestamp: 1000, compositeScore: 90 }))

    const result = await persistence.getEfficiencyScore('27-6')
    expect(result).not.toBeNull()
    expect(result!.compositeScore).toBe(90)
    expect(result!.timestamp).toBe(1000)
  })

  it('should return correct score for the queried story key and not another', async () => {
    await persistence.storeEfficiencyScore(makeEfficiencyScore({ storyKey: '27-6', compositeScore: 60 }))
    await persistence.storeEfficiencyScore(makeEfficiencyScore({ storyKey: '27-7', timestamp: 999_999, compositeScore: 80 }))

    const r6 = await persistence.getEfficiencyScore('27-6')
    const r7 = await persistence.getEfficiencyScore('27-7')

    expect(r6!.compositeScore).toBe(60)
    expect(r7!.compositeScore).toBe(80)
  })
})

// ---------------------------------------------------------------------------
// getAllRecommendations tests
// ---------------------------------------------------------------------------

describe('TelemetryPersistence — getAllRecommendations', () => {
  let adapter: DatabaseAdapter
  let persistence: TelemetryPersistence

  beforeEach(async () => {
    adapter = await createTestAdapter()
    persistence = new TelemetryPersistence(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('should return empty array when no recommendations exist', async () => {
    const recs = await persistence.getAllRecommendations()
    expect(recs).toEqual([])
  })

  it('should return recommendations ordered: critical first, then warning, then info', async () => {
    const recs: Recommendation[] = [
      makeRecommendation({ id: 'info0000info0000', severity: 'info', ruleId: 'growing_categories', potentialSavingsTokens: 100 }),
      makeRecommendation({ id: 'warn0000warn0000', severity: 'warning', ruleId: 'cache_efficiency', potentialSavingsTokens: 500 }),
      makeRecommendation({ id: 'crit0000crit0000', severity: 'critical', ruleId: 'biggest_consumers', potentialSavingsTokens: 1000 }),
    ]
    await persistence.saveRecommendations('27-7', recs)

    const retrieved = await persistence.getAllRecommendations()
    expect(retrieved).toHaveLength(3)
    expect(retrieved[0]!.severity).toBe('critical')
    expect(retrieved[1]!.severity).toBe('warning')
    expect(retrieved[2]!.severity).toBe('info')
  })

  it('should order within same severity by potentialSavingsTokens DESC', async () => {
    const recs: Recommendation[] = [
      makeRecommendation({ id: 'warn1111warn1111', severity: 'warning', ruleId: 'cache_efficiency', potentialSavingsTokens: 200 }),
      makeRecommendation({ id: 'warn2222warn2222', severity: 'warning', ruleId: 'large_file_reads', potentialSavingsTokens: 800 }),
      makeRecommendation({ id: 'warn3333warn3333', severity: 'warning', ruleId: 'expensive_bash', potentialSavingsTokens: 500 }),
    ]
    await persistence.saveRecommendations('27-7', recs)

    const retrieved = await persistence.getAllRecommendations()
    expect(retrieved).toHaveLength(3)
    const savings = retrieved.map((r) => r.potentialSavingsTokens ?? 0)
    expect(savings[0]).toBeGreaterThanOrEqual(savings[1]!)
    expect(savings[1]).toBeGreaterThanOrEqual(savings[2]!)
  })

  it('should apply default limit of 20', async () => {
    // Pad index to produce exactly 16-char hex IDs
    const recs: Recommendation[] = Array.from({ length: 25 }, (_, i) =>
      makeRecommendation({ id: `aa${String(i).padStart(14, '0')}`, ruleId: 'cache_efficiency' }),
    )
    await persistence.saveRecommendations('27-7', recs)

    const retrieved = await persistence.getAllRecommendations()
    expect(retrieved).toHaveLength(20)
  })

  it('should apply custom limit', async () => {
    const recs: Recommendation[] = Array.from({ length: 10 }, (_, i) =>
      makeRecommendation({ id: `bb${String(i).padStart(14, '0')}`, ruleId: 'cache_efficiency' }),
    )
    await persistence.saveRecommendations('27-7', recs)

    const retrieved = await persistence.getAllRecommendations(5)
    expect(retrieved).toHaveLength(5)
  })

  it('should include recommendations from multiple story keys', async () => {
    const rec1 = makeRecommendation({ id: 'story1rec1story1', storyKey: '27-7', severity: 'critical' })
    const rec2 = makeRecommendation({ id: 'story2rec2story2', storyKey: '27-8', severity: 'warning' })
    await persistence.saveRecommendations('27-7', [rec1])
    await persistence.saveRecommendations('27-8', [rec2])

    const retrieved = await persistence.getAllRecommendations()
    expect(retrieved).toHaveLength(2)
    const storyKeys = retrieved.map((r) => r.storyKey)
    expect(storyKeys).toContain('27-7')
    expect(storyKeys).toContain('27-8')
  })

  it('should validate each returned row with RecommendationSchema (id must be 16 chars)', async () => {
    const rec = makeRecommendation({ id: 'validid1validid1' })
    await persistence.saveRecommendations('27-7', [rec])
    // If Zod validation fails, getAllRecommendations() throws
    const retrieved = await persistence.getAllRecommendations()
    expect(retrieved[0]!.id).toHaveLength(16)
  })

  it('should return fewer records than limit when fewer exist', async () => {
    const rec1 = makeRecommendation({ id: 'fewer111fewer111' })
    const rec2 = makeRecommendation({ id: 'fewer222fewer222', ruleId: 'cache_efficiency' })
    await persistence.saveRecommendations('27-7', [rec1, rec2])

    const retrieved = await persistence.getAllRecommendations(10)
    expect(retrieved).toHaveLength(2)
  })
})
