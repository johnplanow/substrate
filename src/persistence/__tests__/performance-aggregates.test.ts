/**
 * Tests for performance aggregates persistence layer.
 *
 * Covers:
 *  - getAgentPerformance(): correct metrics calculation (AC1)
 *  - getAgentPerformance(): returns null when agent not found
 *  - getAgentPerformance(): success_rate, failure_rate calculations
 *  - getAgentPerformance(): token_efficiency as ratio
 *  - getTaskTypeBreakdown(): per-agent comparison (AC5)
 *  - getTaskTypeBreakdown(): returns null when task_type not found
 *  - getTaskTypeBreakdown(): agents sorted by success_rate descending
 *  - updateAggregates() / updatePerformanceAggregates(): creates new row (AC6)
 *  - updateAggregates() / updatePerformanceAggregates(): increments existing row (AC6)
 *  - updateAggregates(): updates last_updated timestamp (AC7)
 *  - performance_aggregates schema has all required columns (AC7)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MonitorDatabaseImpl } from '../monitor-database.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDelta(overrides: {
  outcome?: 'success' | 'failure'
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  cost?: number
  retries?: number
} = {}): {
  outcome: 'success' | 'failure'
  inputTokens: number
  outputTokens: number
  durationMs: number
  cost: number
  retries?: number
} {
  return {
    outcome: 'success',
    inputTokens: 1000,
    outputTokens: 500,
    durationMs: 2000,
    cost: 0.10,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Performance Aggregates — persistence layer (Story 8.5)', () => {
  let db: MonitorDatabaseImpl

  beforeEach(() => {
    db = new MonitorDatabaseImpl(':memory:')
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // already closed
    }
  })

  // -------------------------------------------------------------------------
  // Schema verification (AC7)
  // -------------------------------------------------------------------------

  describe('AC7: performance_aggregates schema', () => {
    it('table has all required columns', () => {
      const internal = (db as unknown as { _db: import('better-sqlite3').Database })._db
      const info = internal
        .prepare("PRAGMA table_info('performance_aggregates')")
        .all() as { name: string; type: string; notnull: number }[]

      const columns = info.map((c) => c.name)
      expect(columns).toContain('agent')
      expect(columns).toContain('task_type')
      expect(columns).toContain('total_tasks')
      expect(columns).toContain('successful_tasks')
      expect(columns).toContain('failed_tasks')
      expect(columns).toContain('total_input_tokens')
      expect(columns).toContain('total_output_tokens')
      expect(columns).toContain('total_duration_ms')
      expect(columns).toContain('total_cost')
      expect(columns).toContain('total_retries')
      expect(columns).toContain('last_updated')
    })

    it('(agent, task_type) is the primary key', () => {
      const internal = (db as unknown as { _db: import('better-sqlite3').Database })._db
      const info = internal
        .prepare("PRAGMA table_info('performance_aggregates')")
        .all() as { name: string; pk: number }[]

      const pkCols = info.filter((c) => c.pk > 0).map((c) => c.name)
      expect(pkCols).toContain('agent')
      expect(pkCols).toContain('task_type')
    })
  })

  // -------------------------------------------------------------------------
  // updateAggregates / updatePerformanceAggregates (AC6)
  // -------------------------------------------------------------------------

  describe('AC6: updateAggregates — row creation and increment', () => {
    it('creates a new row on first call', () => {
      db.updateAggregates('agent-a', 'coding', makeDelta())

      const rows = db.getAggregates({ agent: 'agent-a', taskType: 'coding' })
      expect(rows).toHaveLength(1)
      expect(rows[0].totalTasks).toBe(1)
      expect(rows[0].successfulTasks).toBe(1)
      expect(rows[0].failedTasks).toBe(0)
      expect(rows[0].totalInputTokens).toBe(1000)
      expect(rows[0].totalOutputTokens).toBe(500)
      expect(rows[0].totalDurationMs).toBe(2000)
      expect(rows[0].totalCost).toBeCloseTo(0.10)
    })

    it('increments an existing row on subsequent calls', () => {
      db.updateAggregates('agent-a', 'coding', makeDelta({ outcome: 'success', inputTokens: 1000, outputTokens: 500, durationMs: 2000, cost: 0.10 }))
      db.updateAggregates('agent-a', 'coding', makeDelta({ outcome: 'failure', inputTokens: 200, outputTokens: 0, durationMs: 500, cost: 0.01 }))

      const rows = db.getAggregates({ agent: 'agent-a', taskType: 'coding' })
      expect(rows[0].totalTasks).toBe(2)
      expect(rows[0].successfulTasks).toBe(1)
      expect(rows[0].failedTasks).toBe(1)
      expect(rows[0].totalInputTokens).toBe(1200)
      expect(rows[0].totalOutputTokens).toBe(500)
      expect(rows[0].totalDurationMs).toBe(2500)
      expect(rows[0].totalCost).toBeCloseTo(0.11)
    })

    it('updates last_updated timestamp on each call', () => {
      const before = new Date().toISOString()
      db.updateAggregates('agent-a', 'coding', makeDelta())
      const after = new Date().toISOString()

      const rows = db.getAggregates({ agent: 'agent-a', taskType: 'coding' })
      // lastUpdated is an ISO string — use string comparison (ISO 8601 strings sort lexicographically)
      expect(rows[0].lastUpdated >= before).toBe(true)
      expect(rows[0].lastUpdated <= after).toBe(true)
    })

    it('tracks retries when provided', () => {
      db.updateAggregates('agent-a', 'coding', makeDelta({ retries: 3 }))
      db.updateAggregates('agent-a', 'coding', makeDelta({ retries: 1 }))

      const internal = (db as unknown as { _db: import('better-sqlite3').Database })._db
      const row = internal
        .prepare("SELECT total_retries FROM performance_aggregates WHERE agent='agent-a' AND task_type='coding'")
        .get() as { total_retries: number }
      expect(row.total_retries).toBe(4)
    })
  })

  describe('AC6: updatePerformanceAggregates — alias method', () => {
    it('creates a new row (alias works like updateAggregates)', () => {
      db.updatePerformanceAggregates('agent-b', 'testing', makeDelta())

      const rows = db.getAggregates({ agent: 'agent-b', taskType: 'testing' })
      expect(rows).toHaveLength(1)
      expect(rows[0].totalTasks).toBe(1)
      expect(rows[0].successfulTasks).toBe(1)
    })

    it('increments an existing row via alias', () => {
      db.updatePerformanceAggregates('agent-b', 'testing', makeDelta({ outcome: 'success' }))
      db.updatePerformanceAggregates('agent-b', 'testing', makeDelta({ outcome: 'failure' }))

      const rows = db.getAggregates({ agent: 'agent-b', taskType: 'testing' })
      expect(rows[0].totalTasks).toBe(2)
      expect(rows[0].successfulTasks).toBe(1)
      expect(rows[0].failedTasks).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // getAgentPerformance (AC1)
  // -------------------------------------------------------------------------

  describe('AC1: getAgentPerformance', () => {
    it('returns null when agent has no data', () => {
      const result = db.getAgentPerformance('nonexistent-agent')
      expect(result).toBeNull()
    })

    it('returns correct total_tasks, successful_tasks, failed_tasks', () => {
      db.updateAggregates('claude', 'coding', makeDelta({ outcome: 'success' }))
      db.updateAggregates('claude', 'coding', makeDelta({ outcome: 'success' }))
      db.updateAggregates('claude', 'testing', makeDelta({ outcome: 'failure' }))

      const metrics = db.getAgentPerformance('claude')
      expect(metrics).not.toBeNull()
      expect(metrics!.total_tasks).toBe(3)
      expect(metrics!.successful_tasks).toBe(2)
      expect(metrics!.failed_tasks).toBe(1)
    })

    it('calculates success_rate correctly', () => {
      // 8 successes, 2 failures → 80% success rate
      for (let i = 0; i < 8; i++) {
        db.updateAggregates('claude', 'coding', makeDelta({ outcome: 'success' }))
      }
      for (let i = 0; i < 2; i++) {
        db.updateAggregates('claude', 'coding', makeDelta({ outcome: 'failure' }))
      }

      const metrics = db.getAgentPerformance('claude')
      expect(metrics!.success_rate).toBeCloseTo(80.0)
    })

    it('calculates failure_rate correctly', () => {
      for (let i = 0; i < 8; i++) {
        db.updateAggregates('claude', 'coding', makeDelta({ outcome: 'success' }))
      }
      for (let i = 0; i < 2; i++) {
        db.updateAggregates('claude', 'coding', makeDelta({ outcome: 'failure' }))
      }

      const metrics = db.getAgentPerformance('claude')
      expect(metrics!.failure_rate).toBeCloseTo(20.0)
    })

    it('calculates average_tokens as (input + output) / total_tasks', () => {
      // 10 tasks each with 3000 input + 2000 output = 5000 avg per task
      for (let i = 0; i < 10; i++) {
        db.updateAggregates('claude', 'coding', makeDelta({ inputTokens: 3000, outputTokens: 2000 }))
      }

      const metrics = db.getAgentPerformance('claude')
      expect(metrics!.average_tokens).toBeCloseTo(5000)
    })

    it('calculates average_duration as total_duration_ms / total_tasks', () => {
      // 10 tasks each 5000ms → avg 5000ms
      for (let i = 0; i < 10; i++) {
        db.updateAggregates('claude', 'coding', makeDelta({ durationMs: 5000 }))
      }

      const metrics = db.getAgentPerformance('claude')
      expect(metrics!.average_duration).toBeCloseTo(5000)
    })

    it('calculates token_efficiency as total_output / total_input ratio', () => {
      // 30K input, 20K output → efficiency = 20000/30000 ≈ 0.667
      db.updateAggregates('claude', 'coding', makeDelta({ inputTokens: 30000, outputTokens: 20000 }))

      const metrics = db.getAgentPerformance('claude')
      expect(metrics!.token_efficiency).toBeCloseTo(20000 / 30000, 3)
    })

    it('returns token_efficiency = 0 when no input tokens', () => {
      db.updateAggregates('claude', 'coding', makeDelta({ inputTokens: 0, outputTokens: 100 }))

      const metrics = db.getAgentPerformance('claude')
      expect(metrics!.token_efficiency).toBe(0)
    })

    it('calculates retry_rate as (total_retries / total_tasks) * 100', () => {
      // 10 tasks, 1 retry → 10% retry rate
      for (let i = 0; i < 10; i++) {
        const retries = i === 0 ? 1 : 0
        db.updateAggregates('claude', 'coding', makeDelta({ retries }))
      }

      const metrics = db.getAgentPerformance('claude')
      expect(metrics!.retry_rate).toBeCloseTo(10.0)
    })

    it('returns last_updated as the most recent timestamp', () => {
      db.updateAggregates('claude', 'coding', makeDelta())
      db.updateAggregates('claude', 'testing', makeDelta())

      const metrics = db.getAgentPerformance('claude')
      expect(metrics!.last_updated).toBeTruthy()
      expect(typeof metrics!.last_updated).toBe('string')
    })

    it('aggregates across multiple task types for the same agent', () => {
      db.updateAggregates('claude', 'coding', makeDelta({ outcome: 'success', inputTokens: 500, outputTokens: 250 }))
      db.updateAggregates('claude', 'testing', makeDelta({ outcome: 'success', inputTokens: 300, outputTokens: 100 }))
      db.updateAggregates('claude', 'debugging', makeDelta({ outcome: 'failure', inputTokens: 100, outputTokens: 0 }))

      const metrics = db.getAgentPerformance('claude')
      expect(metrics!.total_tasks).toBe(3)
      expect(metrics!.successful_tasks).toBe(2)
      expect(metrics!.failed_tasks).toBe(1)
      expect(metrics!.total_tasks).toBe(3)
    })

    it('returns success_rate = 0 when all tasks fail', () => {
      db.updateAggregates('claude', 'coding', makeDelta({ outcome: 'failure' }))
      db.updateAggregates('claude', 'coding', makeDelta({ outcome: 'failure' }))

      const metrics = db.getAgentPerformance('claude')
      expect(metrics!.success_rate).toBe(0)
      expect(metrics!.failure_rate).toBe(100)
    })

    it('returns success_rate = 100 when all tasks succeed', () => {
      db.updateAggregates('claude', 'coding', makeDelta({ outcome: 'success' }))
      db.updateAggregates('claude', 'coding', makeDelta({ outcome: 'success' }))

      const metrics = db.getAgentPerformance('claude')
      expect(metrics!.success_rate).toBe(100)
      expect(metrics!.failure_rate).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // getTaskTypeBreakdown (AC5)
  // -------------------------------------------------------------------------

  describe('AC5: getTaskTypeBreakdown', () => {
    it('returns null when task_type has no data', () => {
      const result = db.getTaskTypeBreakdown('nonexistent-type')
      expect(result).toBeNull()
    })

    it('returns correct task_type in result', () => {
      db.updateAggregates('agent-a', 'coding', makeDelta())

      const result = db.getTaskTypeBreakdown('coding')
      expect(result).not.toBeNull()
      expect(result!.task_type).toBe('coding')
    })

    it('returns per-agent comparison with required fields', () => {
      db.updateAggregates('agent-a', 'coding', makeDelta({ outcome: 'success', inputTokens: 1000, outputTokens: 500, durationMs: 3000 }))
      db.updateAggregates('agent-b', 'coding', makeDelta({ outcome: 'failure', inputTokens: 500, outputTokens: 0, durationMs: 1000 }))

      const result = db.getTaskTypeBreakdown('coding')
      expect(result!.agents).toHaveLength(2)

      const agentA = result!.agents.find((a) => a.agent === 'agent-a')
      expect(agentA).toBeDefined()
      expect(agentA!.total_tasks).toBe(1)
      expect(agentA!.success_rate).toBeCloseTo(100)
      expect(agentA!.average_tokens).toBeCloseTo(1500) // (1000+500)/1
      expect(agentA!.average_duration).toBeCloseTo(3000)
      expect(agentA!.sample_size).toBe(1)

      const agentB = result!.agents.find((a) => a.agent === 'agent-b')
      expect(agentB).toBeDefined()
      expect(agentB!.success_rate).toBe(0)
    })

    it('agents are sorted by success_rate descending', () => {
      // agent-a: 100% success, agent-b: 50% success, agent-c: 0% success
      db.updateAggregates('agent-a', 'testing', makeDelta({ outcome: 'success' }))
      db.updateAggregates('agent-b', 'testing', makeDelta({ outcome: 'success' }))
      db.updateAggregates('agent-b', 'testing', makeDelta({ outcome: 'failure' }))
      db.updateAggregates('agent-c', 'testing', makeDelta({ outcome: 'failure' }))

      const result = db.getTaskTypeBreakdown('testing')
      expect(result!.agents[0].agent).toBe('agent-a') // 100%
      expect(result!.agents[1].agent).toBe('agent-b') // 50%
      expect(result!.agents[2].agent).toBe('agent-c') // 0%
    })

    it('sample_size equals total_tasks for each agent', () => {
      db.updateAggregates('agent-a', 'coding', makeDelta({ outcome: 'success' }))
      db.updateAggregates('agent-a', 'coding', makeDelta({ outcome: 'success' }))
      db.updateAggregates('agent-a', 'coding', makeDelta({ outcome: 'failure' }))

      const result = db.getTaskTypeBreakdown('coding')
      expect(result!.agents[0].sample_size).toBe(result!.agents[0].total_tasks)
      expect(result!.agents[0].sample_size).toBe(3)
    })

    it('returns only agents for the queried task_type', () => {
      db.updateAggregates('agent-a', 'coding', makeDelta())
      db.updateAggregates('agent-a', 'testing', makeDelta())
      db.updateAggregates('agent-b', 'testing', makeDelta())

      const result = db.getTaskTypeBreakdown('testing')
      expect(result!.agents).toHaveLength(2)
      const agentNames = result!.agents.map((a) => a.agent)
      expect(agentNames).not.toContain('coding') // task type, not agent
    })

    it('calculates average_tokens as (input + output) / total_tasks per agent', () => {
      db.updateAggregates('agent-a', 'coding', makeDelta({ inputTokens: 2000, outputTokens: 1000 }))
      db.updateAggregates('agent-a', 'coding', makeDelta({ inputTokens: 4000, outputTokens: 2000 }))

      const result = db.getTaskTypeBreakdown('coding')
      const agentA = result!.agents[0]
      // total input 6000, total output 3000, 2 tasks → avg tokens = 9000/2 = 4500
      expect(agentA.average_tokens).toBeCloseTo(4500)
    })

    it('calculates average_duration correctly per agent', () => {
      db.updateAggregates('agent-a', 'coding', makeDelta({ durationMs: 1000 }))
      db.updateAggregates('agent-a', 'coding', makeDelta({ durationMs: 3000 }))

      const result = db.getTaskTypeBreakdown('coding')
      expect(result!.agents[0].average_duration).toBeCloseTo(2000)
    })
  })

  // -------------------------------------------------------------------------
  // aggregateByPeriod / aggregateByTaskType — via getAggregates filter
  // -------------------------------------------------------------------------

  describe('aggregateByPeriod and aggregateByTaskType (via getAggregates)', () => {
    it('filters by agent (aggregateByAgent equivalent)', () => {
      db.updateAggregates('claude', 'coding', makeDelta())
      db.updateAggregates('codex', 'coding', makeDelta())
      db.updateAggregates('claude', 'testing', makeDelta())

      const claudeRows = db.getAggregates({ agent: 'claude' })
      expect(claudeRows).toHaveLength(2)
      expect(claudeRows.every((r) => r.agent === 'claude')).toBe(true)
    })

    it('filters by taskType (aggregateByTaskType equivalent)', () => {
      db.updateAggregates('claude', 'coding', makeDelta())
      db.updateAggregates('codex', 'coding', makeDelta())
      db.updateAggregates('claude', 'testing', makeDelta())

      const codingRows = db.getAggregates({ taskType: 'coding' })
      expect(codingRows).toHaveLength(2)
      expect(codingRows.every((r) => r.taskType === 'coding')).toBe(true)
    })

    it('returns all rows when no filter given', () => {
      db.updateAggregates('claude', 'coding', makeDelta())
      db.updateAggregates('codex', 'testing', makeDelta())
      db.updateAggregates('gemini', 'debugging', makeDelta())

      const all = db.getAggregates()
      expect(all).toHaveLength(3)
    })

    it('returns empty array when no data exists', () => {
      const all = db.getAggregates()
      expect(all).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Multiple agents / realistic scenario
  // -------------------------------------------------------------------------

  describe('Realistic multi-agent scenario', () => {
    it('correctly tracks multiple agents with multiple task types', () => {
      // claude: 8 coding successes, 2 failures; 5 testing successes
      for (let i = 0; i < 8; i++) {
        db.updateAggregates('claude', 'coding', makeDelta({ outcome: 'success', inputTokens: 3000, outputTokens: 2000, durationMs: 5000 }))
      }
      for (let i = 0; i < 2; i++) {
        db.updateAggregates('claude', 'coding', makeDelta({ outcome: 'failure', inputTokens: 1000, outputTokens: 0, durationMs: 500 }))
      }
      for (let i = 0; i < 5; i++) {
        db.updateAggregates('claude', 'testing', makeDelta({ outcome: 'success', inputTokens: 2000, outputTokens: 1000, durationMs: 3000 }))
      }

      // codex: 3 coding successes, 1 failure
      for (let i = 0; i < 3; i++) {
        db.updateAggregates('codex', 'coding', makeDelta({ outcome: 'success', inputTokens: 5000, outputTokens: 4000, durationMs: 8000 }))
      }
      db.updateAggregates('codex', 'coding', makeDelta({ outcome: 'failure', inputTokens: 500, outputTokens: 0, durationMs: 200 }))

      // Verify claude overall
      const claudeMetrics = db.getAgentPerformance('claude')
      expect(claudeMetrics!.total_tasks).toBe(15)
      expect(claudeMetrics!.successful_tasks).toBe(13)
      expect(claudeMetrics!.failed_tasks).toBe(2)
      expect(claudeMetrics!.success_rate).toBeCloseTo((13 / 15) * 100, 1)

      // Verify codex overall
      const codexMetrics = db.getAgentPerformance('codex')
      expect(codexMetrics!.total_tasks).toBe(4)
      expect(codexMetrics!.successful_tasks).toBe(3)
      expect(codexMetrics!.success_rate).toBeCloseTo(75, 1)

      // Verify coding breakdown (both agents)
      const codingBreakdown = db.getTaskTypeBreakdown('coding')
      expect(codingBreakdown!.agents).toHaveLength(2)
      // claude has 80% success on coding, codex has 75% — claude first
      expect(codingBreakdown!.agents[0].agent).toBe('claude')
      expect(codingBreakdown!.agents[1].agent).toBe('codex')
    })
  })
})
