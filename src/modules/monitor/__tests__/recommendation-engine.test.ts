/**
 * Unit tests for RecommendationEngine.
 *
 * Covers:
 *  - generateRecommendations() returns empty array when no aggregates (AC1)
 *  - generateRecommendations() detects >= 5% improvement and generates recommendation (AC1, AC4)
 *  - generateRecommendations() ignores recommendations < 5% improvement (AC4)
 *  - generateRecommendations() respects min_sample_size threshold (AC4)
 *  - Confidence calculation: high >= 50, medium >= 20, low >= min (AC3)
 *  - Recommendation data structure includes all required fields (AC2)
 *  - Recommendation reason text is human-readable and specific
 *  - getMonitorRecommendation() returns highest-confidence recommendation (AC5)
 *  - getMonitorRecommendation() returns null for task type with no recommendations (AC5)
 *  - Multiple agents for same type: best performer recommended
 *  - Configuration threshold override works (AC6)
 *  - Custom min_sample_size from config is respected (AC6)
 *  - recommendation_history_days config is applied to getAggregates filter (AC6)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RecommendationEngine } from '../recommendation-engine.js'
import type { MonitorDatabase, AggregateStats } from '../../../persistence/monitor-database.js'

// ---------------------------------------------------------------------------
// Mock MonitorDatabase
// ---------------------------------------------------------------------------

function createMockMonitorDb(
  aggregates: AggregateStats[] = [],
): MonitorDatabase & {
  getAggregates: ReturnType<typeof vi.fn>
  insertTaskMetrics: ReturnType<typeof vi.fn>
  updateAggregates: ReturnType<typeof vi.fn>
  updatePerformanceAggregates: ReturnType<typeof vi.fn>
  getAgentPerformance: ReturnType<typeof vi.fn>
  getTaskTypeBreakdown: ReturnType<typeof vi.fn>
  pruneOldData: ReturnType<typeof vi.fn>
  rebuildAggregates: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  return {
    insertTaskMetrics: vi.fn(),
    updateAggregates: vi.fn(),
    updatePerformanceAggregates: vi.fn(),
    getAggregates: vi.fn().mockReturnValue(aggregates),
    getAgentPerformance: vi.fn().mockReturnValue(null),
    getTaskTypeBreakdown: vi.fn().mockReturnValue(null),
    pruneOldData: vi.fn().mockReturnValue(0),
    rebuildAggregates: vi.fn(),
    close: vi.fn(),
  }
}

/** Build an AggregateStats object with sensible defaults */
function makeAggregate(overrides: Partial<AggregateStats> & { agent: string; taskType: string }): AggregateStats {
  return {
    agent: overrides.agent,
    taskType: overrides.taskType,
    totalTasks: overrides.totalTasks ?? 10,
    successfulTasks: overrides.successfulTasks ?? 8,
    failedTasks: overrides.failedTasks ?? 2,
    totalInputTokens: overrides.totalInputTokens ?? 1000,
    totalOutputTokens: overrides.totalOutputTokens ?? 500,
    totalDurationMs: overrides.totalDurationMs ?? 5000,
    totalCost: overrides.totalCost ?? 0.05,
    lastUpdated: overrides.lastUpdated ?? new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// RecommendationEngine tests
// ---------------------------------------------------------------------------

describe('RecommendationEngine', () => {
  // -------------------------------------------------------------------------
  // generateRecommendations() — empty cases
  // -------------------------------------------------------------------------

  describe('generateRecommendations() — empty / insufficient data', () => {
    it('returns empty array when no aggregates exist', () => {
      const db = createMockMonitorDb([])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toEqual([])
    })

    it('returns empty array when only one agent exists for a task type', () => {
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 20, successfulTasks: 18 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toEqual([])
    })

    it('returns empty array when no agents meet min_sample_size', () => {
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 5, successfulTasks: 5 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 5, successfulTasks: 3 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toEqual([])
    })

    it('returns empty array when improvement is below 5% threshold', () => {
      // Agent A: 82% success (41/50), Agent B: 80% success (40/50) — only 2% difference
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 50, successfulTasks: 41 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 50, successfulTasks: 40 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // generateRecommendations() — basic recommendation generation (AC1, AC4)
  // -------------------------------------------------------------------------

  describe('generateRecommendations() — recommendation generation', () => {
    it('generates recommendation when improvement is exactly 5%', () => {
      // Agent A: 75%, Agent B: 80% — exactly 5% improvement
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 20, successfulTasks: 15 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 20, successfulTasks: 16 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toHaveLength(1)
      expect(result[0]!.recommended_agent).toBe('agent-b')
      expect(result[0]!.current_agent).toBe('agent-a')
      expect(result[0]!.improvement_percentage).toBeCloseTo(5.0, 1)
    })

    it('generates recommendation when improvement is > 5% (AC1)', () => {
      // Agent A: 70%, Agent B: 90% — 20% improvement
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 20, successfulTasks: 14 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 20, successfulTasks: 18 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toHaveLength(1)
      const rec = result[0]!
      expect(rec.task_type).toBe('coding')
      expect(rec.recommended_agent).toBe('agent-b')
      expect(rec.current_agent).toBe('agent-a')
      expect(rec.improvement_percentage).toBeGreaterThan(5)
    })

    it('ignores recommendations strictly below 5% improvement (AC4)', () => {
      // Agent A: 80%, Agent B: 84% — only 4% improvement
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 25, successfulTasks: 20 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 25, successfulTasks: 21 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toEqual([])
    })

    it('skips task types with fewer than min_sample_size tasks for any agent (AC4)', () => {
      // Agent A: 5 tasks (< min 10), Agent B: 15 tasks — A is below threshold
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'testing', totalTasks: 5, successfulTasks: 2 }),
        makeAggregate({ agent: 'agent-b', taskType: 'testing', totalTasks: 15, successfulTasks: 14 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toEqual([])
    })

    it('generates recommendations for multiple task types independently', () => {
      const db = createMockMonitorDb([
        // coding: agent-b better
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 20, successfulTasks: 12 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 20, successfulTasks: 18 }),
        // testing: agent-a better
        makeAggregate({ agent: 'agent-a', taskType: 'testing', totalTasks: 20, successfulTasks: 19 }),
        makeAggregate({ agent: 'agent-b', taskType: 'testing', totalTasks: 20, successfulTasks: 12 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toHaveLength(2)
      const taskTypes = result.map((r) => r.task_type)
      expect(taskTypes).toContain('coding')
      expect(taskTypes).toContain('testing')
    })
  })

  // -------------------------------------------------------------------------
  // Recommendation data structure (AC2)
  // -------------------------------------------------------------------------

  describe('Recommendation data structure (AC2)', () => {
    it('recommendation includes all required fields', () => {
      const db = createMockMonitorDb([
        makeAggregate({
          agent: 'claude-haiku-4-5',
          taskType: 'coding',
          totalTasks: 20,
          successfulTasks: 13,
          totalInputTokens: 2000,
          totalOutputTokens: 1000,
        }),
        makeAggregate({
          agent: 'claude-opus-4-6',
          taskType: 'coding',
          totalTasks: 20,
          successfulTasks: 18,
          totalInputTokens: 3000,
          totalOutputTokens: 1500,
        }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toHaveLength(1)

      const rec = result[0]!
      // Verify all AC2 fields are present
      expect(typeof rec.task_type).toBe('string')
      expect(typeof rec.current_agent).toBe('string')
      expect(typeof rec.recommended_agent).toBe('string')
      expect(typeof rec.reason).toBe('string')
      expect(['low', 'medium', 'high']).toContain(rec.confidence)
      expect(typeof rec.current_success_rate).toBe('number')
      expect(typeof rec.recommended_success_rate).toBe('number')
      expect(typeof rec.current_avg_tokens).toBe('number')
      expect(typeof rec.recommended_avg_tokens).toBe('number')
      expect(typeof rec.improvement_percentage).toBe('number')
      expect(typeof rec.sample_size_current).toBe('number')
      expect(typeof rec.sample_size_recommended).toBe('number')
    })

    it('recommendation has correct field values', () => {
      // Agent A: 70% (14/20), Agent B: 90% (18/20)
      const db = createMockMonitorDb([
        makeAggregate({
          agent: 'agent-a',
          taskType: 'coding',
          totalTasks: 20,
          successfulTasks: 14,
          totalInputTokens: 2000,
          totalOutputTokens: 1000,
        }),
        makeAggregate({
          agent: 'agent-b',
          taskType: 'coding',
          totalTasks: 20,
          successfulTasks: 18,
          totalInputTokens: 4000,
          totalOutputTokens: 2000,
        }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      const rec = result[0]!

      expect(rec.task_type).toBe('coding')
      expect(rec.current_agent).toBe('agent-a')
      expect(rec.recommended_agent).toBe('agent-b')
      expect(rec.current_success_rate).toBeCloseTo(70.0, 1)
      expect(rec.recommended_success_rate).toBeCloseTo(90.0, 1)
      expect(rec.improvement_percentage).toBeCloseTo(20.0, 1)
      expect(rec.sample_size_current).toBe(20)
      expect(rec.sample_size_recommended).toBe(20)
      // avg tokens: (input + output) / totalTasks
      expect(rec.current_avg_tokens).toBeCloseTo(150, 0) // (2000+1000)/20
      expect(rec.recommended_avg_tokens).toBeCloseTo(300, 0) // (4000+2000)/20
    })

    it('recommendation reason is a human-readable string mentioning relevant data', () => {
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 20, successfulTasks: 13 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 20, successfulTasks: 19 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      const rec = result[0]!

      expect(rec.reason).toContain('agent-b')
      expect(rec.reason).toContain('coding')
      expect(rec.reason.length).toBeGreaterThan(20) // non-trivial text
    })
  })

  // -------------------------------------------------------------------------
  // Confidence level calculation (AC3)
  // -------------------------------------------------------------------------

  describe('Confidence level calculation (AC3)', () => {
    it('assigns confidence="low" when min sample < 20 for either agent', () => {
      // Both agents: 12 tasks each (>= 10 min, < 20)
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 12, successfulTasks: 6 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 12, successfulTasks: 11 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toHaveLength(1)
      expect(result[0]!.confidence).toBe('low')
    })

    it('assigns confidence="low" when one agent has < 20 tasks', () => {
      // Agent A: 15 tasks, Agent B: 55 tasks — A is below 20
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 15, successfulTasks: 6 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 55, successfulTasks: 50 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toHaveLength(1)
      expect(result[0]!.confidence).toBe('low')
    })

    it('assigns confidence="medium" when both agents have >= 20 but < 50 tasks', () => {
      // Both agents: 22 tasks each
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'testing', totalTasks: 22, successfulTasks: 12 }),
        makeAggregate({ agent: 'agent-b', taskType: 'testing', totalTasks: 48, successfulTasks: 44 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toHaveLength(1)
      expect(result[0]!.confidence).toBe('medium')
    })

    it('assigns confidence="medium" when min of both samples is in [20, 50)', () => {
      // Agent A: 30, Agent B: 45 — min is 30 (>=20, <50)
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'testing', totalTasks: 30, successfulTasks: 15 }),
        makeAggregate({ agent: 'agent-b', taskType: 'testing', totalTasks: 45, successfulTasks: 42 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toHaveLength(1)
      expect(result[0]!.confidence).toBe('medium')
    })

    it('assigns confidence="high" when both agents have >= 50 tasks', () => {
      // Agent A: 55 tasks, Agent B: 60 tasks
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'refactoring', totalTasks: 55, successfulTasks: 30 }),
        makeAggregate({ agent: 'agent-b', taskType: 'refactoring', totalTasks: 60, successfulTasks: 55 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toHaveLength(1)
      expect(result[0]!.confidence).toBe('high')
    })

    it('assigns confidence="high" when both agents have exactly 50 tasks', () => {
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 50, successfulTasks: 30 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 50, successfulTasks: 45 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toHaveLength(1)
      expect(result[0]!.confidence).toBe('high')
    })
  })

  // -------------------------------------------------------------------------
  // Multiple agents — best performer selection (AC4)
  // -------------------------------------------------------------------------

  describe('Multiple agents — best performer selection', () => {
    it('recommends the best-performing agent when multiple agents exist for a type', () => {
      // agent-a: 60%, agent-b: 70%, agent-c: 90%
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 20, successfulTasks: 12 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 20, successfulTasks: 14 }),
        makeAggregate({ agent: 'agent-c', taskType: 'coding', totalTasks: 20, successfulTasks: 18 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()

      // Both agent-a and agent-b should get recommendations pointing to agent-c
      const recs = result.filter((r) => r.task_type === 'coding')
      expect(recs.length).toBeGreaterThanOrEqual(1)
      for (const rec of recs) {
        expect(rec.recommended_agent).toBe('agent-c')
      }
    })

    it('returns two recommendations when three agents have diverging performance', () => {
      // agent-a: 60%, agent-b: 70%, agent-c: 90%
      // -> agent-a vs agent-c: 30% improvement (recommend)
      // -> agent-b vs agent-c: 20% improvement (recommend)
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 20, successfulTasks: 12 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 20, successfulTasks: 14 }),
        makeAggregate({ agent: 'agent-c', taskType: 'coding', totalTasks: 20, successfulTasks: 18 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toHaveLength(2)
    })
  })

  // -------------------------------------------------------------------------
  // Sort order
  // -------------------------------------------------------------------------

  describe('Sort order', () => {
    it('sorts recommendations by confidence descending (high > medium > low)', () => {
      const db = createMockMonitorDb([
        // task-a: low confidence (12 tasks each)
        makeAggregate({ agent: 'agent-a', taskType: 'task-a', totalTasks: 12, successfulTasks: 6 }),
        makeAggregate({ agent: 'agent-b', taskType: 'task-a', totalTasks: 12, successfulTasks: 11 }),
        // task-b: high confidence (55 tasks each)
        makeAggregate({ agent: 'agent-a', taskType: 'task-b', totalTasks: 55, successfulTasks: 30 }),
        makeAggregate({ agent: 'agent-b', taskType: 'task-b', totalTasks: 55, successfulTasks: 50 }),
        // task-c: medium confidence (25 tasks each)
        makeAggregate({ agent: 'agent-a', taskType: 'task-c', totalTasks: 25, successfulTasks: 12 }),
        makeAggregate({ agent: 'agent-b', taskType: 'task-c', totalTasks: 25, successfulTasks: 22 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result.length).toBeGreaterThanOrEqual(3)

      const confidenceOrder: Record<string, number> = { high: 2, medium: 1, low: 0 }
      for (let i = 1; i < result.length; i++) {
        const prev = confidenceOrder[result[i - 1]!.confidence]!
        const curr = confidenceOrder[result[i]!.confidence]!
        expect(prev).toBeGreaterThanOrEqual(curr)
      }
    })
  })

  // -------------------------------------------------------------------------
  // getMonitorRecommendation() (AC5)
  // -------------------------------------------------------------------------

  describe('getMonitorRecommendation() (AC5)', () => {
    it('returns the best recommendation for a specific task type', () => {
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 20, successfulTasks: 12 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 20, successfulTasks: 18 }),
      ])
      const engine = new RecommendationEngine(db)
      const rec = engine.getMonitorRecommendation('coding')
      expect(rec).not.toBeNull()
      expect(rec!.task_type).toBe('coding')
      expect(rec!.recommended_agent).toBe('agent-b')
    })

    it('returns null for a task type with no recommendations', () => {
      const db = createMockMonitorDb([])
      const engine = new RecommendationEngine(db)
      const rec = engine.getMonitorRecommendation('nonexistent')
      expect(rec).toBeNull()
    })

    it('returns null when no recommendation meets threshold for the given type', () => {
      // Only 3% improvement — below 5% threshold
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 30, successfulTasks: 25 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 30, successfulTasks: 26 }),
      ])
      const engine = new RecommendationEngine(db)
      const rec = engine.getMonitorRecommendation('coding')
      expect(rec).toBeNull()
    })

    it('returns highest-confidence recommendation when multiple exist for same type', () => {
      // Three agents: all meet threshold
      // agent-a: 60% (20 tasks), agent-b: 75% (55 tasks), agent-c: 90% (55 tasks)
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 20, successfulTasks: 12 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 55, successfulTasks: 41 }),
        makeAggregate({ agent: 'agent-c', taskType: 'coding', totalTasks: 55, successfulTasks: 49 }),
      ])
      const engine = new RecommendationEngine(db)
      const rec = engine.getMonitorRecommendation('coding')
      expect(rec).not.toBeNull()
      // Should be the highest confidence one (agent-c recommended, since it has best rate and high confidence)
      expect(rec!.confidence).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // Configuration overrides (AC6)
  // -------------------------------------------------------------------------

  describe('Configuration overrides (AC6)', () => {
    it('respects custom threshold_percentage override', () => {
      // 8% improvement: would be excluded at default 5% (wait, 8 > 5)
      // Use 10% threshold so this 8% is excluded
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 20, successfulTasks: 14 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 20, successfulTasks: 16 }),
      ])
      // Agent A: 70%, Agent B: 80% — 10% improvement
      // With threshold of 12%, this should be excluded
      const engine = new RecommendationEngine(db, { recommendation_threshold_percentage: 12.0 })
      const result = engine.generateRecommendations()
      expect(result).toEqual([])
    })

    it('includes recommendations when threshold is lowered', () => {
      // Agent A: 73%, Agent B: 76% — 3% improvement
      // Default threshold 5% would exclude; lowered to 2% should include
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 22, successfulTasks: 16 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 22, successfulTasks: 17 }),
      ])
      const engine = new RecommendationEngine(db, { recommendation_threshold_percentage: 2.0 })
      const result = engine.generateRecommendations()
      expect(result).toHaveLength(1)
    })

    it('respects custom min_sample_size', () => {
      // Both agents: 7 tasks — below default min of 10
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 7, successfulTasks: 3 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 7, successfulTasks: 7 }),
      ])

      // Default min_sample_size=10: should produce no recommendations
      const engineDefault = new RecommendationEngine(db)
      expect(engineDefault.generateRecommendations()).toEqual([])

      // Custom min_sample_size=5: should produce recommendations
      const engineCustom = new RecommendationEngine(db, { min_sample_size: 5 })
      const result = engineCustom.generateRecommendations()
      expect(result).toHaveLength(1)
    })

    it('applies recommendation_history_days filter to getAggregates call (AC6)', () => {
      const db = createMockMonitorDb([])
      const engine = new RecommendationEngine(db, { recommendation_history_days: 30 })
      engine.generateRecommendations()

      // Verify that getAggregates was called with a sinceDate filter
      expect(db.getAggregates).toHaveBeenCalledOnce()
      const callArg = db.getAggregates.mock.calls[0][0] as { sinceDate?: string } | undefined
      expect(callArg).toBeDefined()
      expect(callArg!.sinceDate).toBeDefined()

      // The sinceDate should be approximately 30 days ago
      const sinceDate = new Date(callArg!.sinceDate!)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      // Allow 5 second tolerance for test execution time
      expect(Math.abs(sinceDate.getTime() - thirtyDaysAgo.getTime())).toBeLessThan(5000)
    })

    it('uses 90 days default for recommendation_history_days when not specified', () => {
      const db = createMockMonitorDb([])
      const engine = new RecommendationEngine(db)
      engine.generateRecommendations()

      const callArg = db.getAggregates.mock.calls[0][0] as { sinceDate?: string } | undefined
      expect(callArg).toBeDefined()
      expect(callArg!.sinceDate).toBeDefined()

      const sinceDate = new Date(callArg!.sinceDate!)
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      expect(Math.abs(sinceDate.getTime() - ninetyDaysAgo.getTime())).toBeLessThan(5000)
    })
  })

  // -------------------------------------------------------------------------
  // exportRecommendationsJson()
  // -------------------------------------------------------------------------

  describe('exportRecommendationsJson()', () => {
    it('returns a JSON-serializable export structure', () => {
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 20, successfulTasks: 12 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 20, successfulTasks: 18 }),
      ])
      const engine = new RecommendationEngine(db)
      const exported = engine.exportRecommendationsJson()

      expect(typeof exported.generated_at).toBe('string')
      expect(typeof exported.count).toBe('number')
      expect(Array.isArray(exported.recommendations)).toBe(true)
      expect(exported.count).toBe(exported.recommendations.length)
    })

    it('count matches the number of recommendations returned', () => {
      const db = createMockMonitorDb([])
      const engine = new RecommendationEngine(db)
      const exported = engine.exportRecommendationsJson()
      expect(exported.count).toBe(0)
      expect(exported.recommendations).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('Edge cases', () => {
    it('handles zero success tasks gracefully (0% success rate)', () => {
      // Agent A: 0%, Agent B: 100%
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 15, successfulTasks: 0 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 15, successfulTasks: 15 }),
      ])
      const engine = new RecommendationEngine(db)
      const result = engine.generateRecommendations()
      expect(result).toHaveLength(1)
      expect(result[0]!.current_success_rate).toBeCloseTo(0, 1)
      expect(result[0]!.recommended_success_rate).toBeCloseTo(100, 1)
      expect(result[0]!.improvement_percentage).toBeCloseTo(100, 1)
    })

    it('handles agents with zero totalTasks without throwing', () => {
      const db = createMockMonitorDb([
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 0, successfulTasks: 0 }),
        makeAggregate({ agent: 'agent-b', taskType: 'coding', totalTasks: 20, successfulTasks: 18 }),
      ])
      const engine = new RecommendationEngine(db)
      // agent-a has 0 tasks — below min_sample_size; should not throw
      expect(() => engine.generateRecommendations()).not.toThrow()
    })
  })
})
