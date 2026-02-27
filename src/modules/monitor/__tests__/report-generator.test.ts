/**
 * Unit tests for generateMonitorReport() (report-generator.ts).
 *
 * Covers:
 *  - Returns correct agent summary from aggregates (AC1)
 *  - Returns correct task_type breakdown (AC1)
 *  - With sinceDate passes filter to getAggregates() (AC2, AC3)
 *  - With includeRecommendations calls RecommendationEngine (AC5)
 *  - Returns empty agents and task_types when no data
 *  - Computes success_rate and failure_rate correctly from AggregateStats
 *  - Summary counts total_tasks, total_agents, total_task_types
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateMonitorReport } from '../report-generator.js'
import type { MonitorDatabase, AggregateStats } from '../../../persistence/monitor-database.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockMonitorDb(
  aggregates: AggregateStats[] = [],
): MonitorDatabase & {
  getAggregates: ReturnType<typeof vi.fn>
  getTaskMetricsDateRange: ReturnType<typeof vi.fn>
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
    getTaskMetricsDateRange: vi.fn().mockReturnValue({ earliest: null, latest: null }),
    getAgentPerformance: vi.fn().mockReturnValue(null),
    getTaskTypeBreakdown: vi.fn().mockReturnValue(null),
    pruneOldData: vi.fn().mockReturnValue(0),
    rebuildAggregates: vi.fn(),
    close: vi.fn(),
  }
}

function makeAggregate(
  overrides: Partial<AggregateStats> & { agent: string; taskType: string },
): AggregateStats {
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
    lastUpdated: overrides.lastUpdated ?? '2026-01-15T10:00:00.000Z',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateMonitorReport()', () => {
  // -------------------------------------------------------------------------
  // Empty / no-data cases
  // -------------------------------------------------------------------------

  describe('empty data', () => {
    it('returns empty agents and task_types when no aggregates', () => {
      const db = createMockMonitorDb([])
      const report = generateMonitorReport(db)

      expect(report.agents).toHaveLength(0)
      expect(report.task_types).toHaveLength(0)
    })

    it('returns zero summary counts when no data', () => {
      const db = createMockMonitorDb([])
      const report = generateMonitorReport(db)

      expect(report.summary.total_tasks).toBe(0)
      expect(report.summary.total_agents).toBe(0)
      expect(report.summary.total_task_types).toBe(0)
      expect(report.summary.date_range.earliest).toBeNull()
      expect(report.summary.date_range.latest).toBeNull()
    })

    it('sets generated_at to current ISO time', () => {
      const before = new Date().toISOString()
      const db = createMockMonitorDb([])
      const report = generateMonitorReport(db)
      const after = new Date().toISOString()

      expect(report.generated_at >= before).toBe(true)
      expect(report.generated_at <= after).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Per-agent summary (AC1)
  // -------------------------------------------------------------------------

  describe('per-agent summary (AC1)', () => {
    it('aggregates stats for a single agent across task types', () => {
      const aggregates = [
        makeAggregate({ agent: 'claude-sonnet', taskType: 'coding', totalTasks: 20, successfulTasks: 18, failedTasks: 2, totalInputTokens: 2000, totalOutputTokens: 1000, totalDurationMs: 10000 }),
        makeAggregate({ agent: 'claude-sonnet', taskType: 'testing', totalTasks: 10, successfulTasks: 9, failedTasks: 1, totalInputTokens: 1000, totalOutputTokens: 500, totalDurationMs: 5000 }),
      ]

      const db = createMockMonitorDb(aggregates)
      const report = generateMonitorReport(db)

      expect(report.agents).toHaveLength(1)
      const agent = report.agents[0]!

      expect(agent.agent).toBe('claude-sonnet')
      expect(agent.total_tasks).toBe(30)
      expect(agent.success_rate).toBeCloseTo((27 / 30) * 100, 1)
      expect(agent.failure_rate).toBeCloseTo((3 / 30) * 100, 1)
      expect(agent.average_tokens).toBeCloseTo((3000 + 1500) / 30, 0)
      expect(agent.average_duration).toBeCloseTo(15000 / 30, 0)
    })

    it('handles multiple agents', () => {
      const aggregates = [
        makeAggregate({ agent: 'claude-sonnet', taskType: 'coding', totalTasks: 20, successfulTasks: 16, failedTasks: 4 }),
        makeAggregate({ agent: 'claude-haiku', taskType: 'coding', totalTasks: 15, successfulTasks: 10, failedTasks: 5 }),
      ]

      const db = createMockMonitorDb(aggregates)
      const report = generateMonitorReport(db)

      expect(report.agents).toHaveLength(2)
      const agentNames = report.agents.map((a) => a.agent)
      expect(agentNames).toContain('claude-sonnet')
      expect(agentNames).toContain('claude-haiku')
    })

    it('computes success_rate as percentage (0-100)', () => {
      const aggregates = [
        makeAggregate({ agent: 'agent-a', taskType: 'coding', totalTasks: 10, successfulTasks: 7, failedTasks: 3 }),
      ]

      const db = createMockMonitorDb(aggregates)
      const report = generateMonitorReport(db)

      const agent = report.agents[0]!
      expect(agent.success_rate).toBeCloseTo(70, 0)
      expect(agent.failure_rate).toBeCloseTo(30, 0)
    })

    it('computes failure_rate correctly from AggregateStats', () => {
      const aggregates = [
        makeAggregate({ agent: 'agent-b', taskType: 'testing', totalTasks: 4, successfulTasks: 1, failedTasks: 3 }),
      ]

      const db = createMockMonitorDb(aggregates)
      const report = generateMonitorReport(db)

      const agent = report.agents[0]!
      expect(agent.success_rate).toBeCloseTo(25, 0)
      expect(agent.failure_rate).toBeCloseTo(75, 0)
    })

    it('computes token_efficiency correctly', () => {
      const aggregates = [
        makeAggregate({ agent: 'agent-c', taskType: 'coding', totalTasks: 1, successfulTasks: 1, failedTasks: 0, totalInputTokens: 1000, totalOutputTokens: 500 }),
      ]

      const db = createMockMonitorDb(aggregates)
      const report = generateMonitorReport(db)

      const agent = report.agents[0]!
      expect(agent.token_efficiency).toBeCloseTo(0.5, 2)
    })
  })

  // -------------------------------------------------------------------------
  // Per-task-type breakdown (AC1)
  // -------------------------------------------------------------------------

  describe('per-task-type breakdown (AC1)', () => {
    it('groups agents under their task type', () => {
      const aggregates = [
        makeAggregate({ agent: 'claude-sonnet', taskType: 'coding', totalTasks: 20, successfulTasks: 18, failedTasks: 2 }),
        makeAggregate({ agent: 'claude-haiku', taskType: 'coding', totalTasks: 15, successfulTasks: 10, failedTasks: 5 }),
        makeAggregate({ agent: 'claude-sonnet', taskType: 'testing', totalTasks: 10, successfulTasks: 9, failedTasks: 1 }),
      ]

      const db = createMockMonitorDb(aggregates)
      const report = generateMonitorReport(db)

      expect(report.task_types).toHaveLength(2)

      const codingType = report.task_types.find((tt) => tt.task_type === 'coding')!
      expect(codingType).toBeDefined()
      expect(codingType.total_tasks).toBe(35)
      expect(codingType.agents).toHaveLength(2)

      const testingType = report.task_types.find((tt) => tt.task_type === 'testing')!
      expect(testingType).toBeDefined()
      expect(testingType.total_tasks).toBe(10)
      expect(testingType.agents).toHaveLength(1)
    })

    it('sorts agents within task type by success_rate descending', () => {
      const aggregates = [
        makeAggregate({ agent: 'agent-low', taskType: 'coding', totalTasks: 10, successfulTasks: 6, failedTasks: 4 }),
        makeAggregate({ agent: 'agent-high', taskType: 'coding', totalTasks: 10, successfulTasks: 9, failedTasks: 1 }),
      ]

      const db = createMockMonitorDb(aggregates)
      const report = generateMonitorReport(db)

      const coding = report.task_types[0]!
      expect(coding.agents[0]!.agent).toBe('agent-high')
      expect(coding.agents[1]!.agent).toBe('agent-low')
    })

    it('includes sample_size matching total_tasks for each agent-type pair', () => {
      const aggregates = [
        makeAggregate({ agent: 'agent-x', taskType: 'coding', totalTasks: 42, successfulTasks: 40, failedTasks: 2 }),
      ]

      const db = createMockMonitorDb(aggregates)
      const report = generateMonitorReport(db)

      const coding = report.task_types[0]!
      expect(coding.agents[0]!.sample_size).toBe(42)
    })
  })

  // -------------------------------------------------------------------------
  // Summary counts (AC1)
  // -------------------------------------------------------------------------

  describe('summary counts (AC1)', () => {
    it('counts total_tasks as sum across all agents and task types', () => {
      const aggregates = [
        makeAggregate({ agent: 'a1', taskType: 'coding', totalTasks: 20, successfulTasks: 18, failedTasks: 2 }),
        makeAggregate({ agent: 'a2', taskType: 'coding', totalTasks: 15, successfulTasks: 10, failedTasks: 5 }),
        makeAggregate({ agent: 'a1', taskType: 'testing', totalTasks: 5, successfulTasks: 5, failedTasks: 0 }),
      ]

      const db = createMockMonitorDb(aggregates)
      const report = generateMonitorReport(db)

      expect(report.summary.total_tasks).toBe(40)
    })

    it('counts total_agents as number of distinct agents', () => {
      const aggregates = [
        makeAggregate({ agent: 'agent-1', taskType: 'coding', totalTasks: 10, successfulTasks: 8, failedTasks: 2 }),
        makeAggregate({ agent: 'agent-2', taskType: 'coding', totalTasks: 10, successfulTasks: 8, failedTasks: 2 }),
        makeAggregate({ agent: 'agent-1', taskType: 'testing', totalTasks: 5, successfulTasks: 4, failedTasks: 1 }),
      ]

      const db = createMockMonitorDb(aggregates)
      const report = generateMonitorReport(db)

      expect(report.summary.total_agents).toBe(2)
    })

    it('counts total_task_types as number of distinct task types', () => {
      const aggregates = [
        makeAggregate({ agent: 'agent-1', taskType: 'coding', totalTasks: 10, successfulTasks: 8, failedTasks: 2 }),
        makeAggregate({ agent: 'agent-1', taskType: 'testing', totalTasks: 5, successfulTasks: 4, failedTasks: 1 }),
        makeAggregate({ agent: 'agent-1', taskType: 'review', totalTasks: 3, successfulTasks: 3, failedTasks: 0 }),
      ]

      const db = createMockMonitorDb(aggregates)
      const report = generateMonitorReport(db)

      expect(report.summary.total_task_types).toBe(3)
    })
  })

  // -------------------------------------------------------------------------
  // Time range filtering (AC2, AC3)
  // -------------------------------------------------------------------------

  describe('time range filtering (AC2, AC3)', () => {
    it('passes sinceDate filter to getAggregates()', () => {
      const db = createMockMonitorDb([])
      const sinceDate = '2026-02-01T00:00:00.000Z'

      generateMonitorReport(db, { sinceDate })

      expect(db.getAggregates).toHaveBeenCalledWith({ sinceDate })
    })

    it('does not pass sinceDate filter when not provided', () => {
      const db = createMockMonitorDb([])

      generateMonitorReport(db)

      expect(db.getAggregates).toHaveBeenCalledWith(undefined)
    })

    it('sets time_range in the report when sinceDate is provided', () => {
      const db = createMockMonitorDb([])
      const sinceDate = '2026-02-01T00:00:00.000Z'

      const report = generateMonitorReport(db, { sinceDate })

      expect(report.time_range).toBeDefined()
      expect(report.time_range!.since).toBe(sinceDate)
      expect(report.time_range!.until).toBeDefined()
    })

    it('does not set time_range when no sinceDate is provided', () => {
      const db = createMockMonitorDb([])

      const report = generateMonitorReport(db)

      expect(report.time_range).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Recommendations (AC5)
  // -------------------------------------------------------------------------

  describe('recommendations (AC5)', () => {
    it('does not include recommendations when includeRecommendations is false (default)', () => {
      const db = createMockMonitorDb([])

      const report = generateMonitorReport(db)

      expect(report.recommendations).toBeUndefined()
    })

    it('includes recommendations field when includeRecommendations is true', () => {
      // Provide aggregates with >= 2 agents per task type and sufficient sample
      const aggregates = [
        makeAggregate({ agent: 'best-agent', taskType: 'coding', totalTasks: 60, successfulTasks: 55, failedTasks: 5, totalInputTokens: 6000, totalOutputTokens: 3000, totalDurationMs: 30000 }),
        makeAggregate({ agent: 'worse-agent', taskType: 'coding', totalTasks: 60, successfulTasks: 40, failedTasks: 20, totalInputTokens: 6000, totalOutputTokens: 3000, totalDurationMs: 30000 }),
      ]
      const db = createMockMonitorDb(aggregates)

      const report = generateMonitorReport(db, { includeRecommendations: true })

      expect(report.recommendations).toBeDefined()
      expect(report.recommendations).toHaveProperty('generated_at')
      expect(report.recommendations).toHaveProperty('count')
      expect(report.recommendations).toHaveProperty('recommendations')
    })

    it('recommendations.count is 0 when insufficient data for recommendations', () => {
      // Only one agent per task type — no comparison possible
      const aggregates = [
        makeAggregate({ agent: 'only-agent', taskType: 'coding', totalTasks: 100, successfulTasks: 90, failedTasks: 10 }),
      ]
      const db = createMockMonitorDb(aggregates)

      const report = generateMonitorReport(db, { includeRecommendations: true })

      expect(report.recommendations).toBeDefined()
      expect(report.recommendations!.count).toBe(0)
    })
  })
})
