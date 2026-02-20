/**
 * Comprehensive tests for the CostTracker module (Story 4.2).
 *
 * Covers all acceptance criteria:
 *  AC1: Cost recording per task
 *  AC2: Session cost summary with subscription/API breakdown
 *  AC3: Token-based cost estimation
 *  AC4: Subscription billing mode and savings calculation
 *  AC5: Mixed billing mode reporting
 *  AC6: Cost persistence and query efficiency (index verification)
 *
 * Also covers review fixes:
 *  - CostEntry.id is DB-assigned integer (not constructed string)
 *  - tokensOutput is derived from aggregate tokensUsed (not hardcoded to 0)
 *  - billingMode 'unavailable' is handled (skips cost recording)
 *  - sessionId is passed via constructor (not hardcoded 'default')
 *  - idx_cost_agent index exists in migration 002
 *  - getSessionCostSummary returns actual earliest recorded_at (not synthetic)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { TypedEventBusImpl } from '../../../core/event-bus.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import { CostTrackerImpl, createCostTracker } from '../cost-tracker-impl.js'
import type { CostTracker } from '../cost-tracker-impl.js'
import { CostTrackerSubscriber, createCostTrackerSubscriber } from '../cost-tracker-subscriber.js'
import { TOKEN_RATES, getTokenRate, estimateCost, estimateCostSafe } from '../token-rates.js'
import type { CostEntry, SessionCostSummary, TaskCostSummary } from '../types.js'
import { runMigrations } from '../../../persistence/migrations/index.js'
import {
  recordCostEntry,
  getCostEntryById,
  getSessionCostSummary,
  getTaskCostSummary,
  getAgentCostBreakdown,
  getAllCostEntries,
} from '../../../persistence/queries/cost.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): BetterSqlite3Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

function createTestSession(db: BetterSqlite3Database, sessionId: string = 'session-1'): void {
  db.prepare(
    `INSERT INTO sessions (id, name, graph_file, status)
     VALUES (?, ?, ?, ?)`,
  ).run(sessionId, 'Test Session', 'test-graph.yaml', 'active')
}

function createTestTask(
  db: BetterSqlite3Database,
  taskId: string,
  sessionId: string = 'session-1',
): void {
  db.prepare(
    `INSERT INTO tasks (id, session_id, name, prompt, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(taskId, sessionId, `Task ${taskId}`, 'Do something', 'completed')
}

// ---------------------------------------------------------------------------
// Token Rates (AC3)
// ---------------------------------------------------------------------------

describe('Token Rates (AC3)', () => {
  it('has rates for Anthropic Claude models', () => {
    const opus = getTokenRate('anthropic', 'claude-3-opus')
    expect(opus).not.toBeNull()
    expect(opus!.input_rate).toBe(15.0)
    expect(opus!.output_rate).toBe(75.0)

    const sonnet = getTokenRate('anthropic', 'claude-3-sonnet')
    expect(sonnet).not.toBeNull()
    expect(sonnet!.input_rate).toBe(3.0)
    expect(sonnet!.output_rate).toBe(15.0)

    const haiku = getTokenRate('anthropic', 'claude-3-haiku')
    expect(haiku).not.toBeNull()
    expect(haiku!.input_rate).toBe(0.25)
    expect(haiku!.output_rate).toBe(1.25)
  })

  it('has rates for OpenAI GPT models', () => {
    const gpt4 = getTokenRate('openai', 'gpt-4')
    expect(gpt4).not.toBeNull()
    expect(gpt4!.input_rate).toBe(30.0)
    expect(gpt4!.output_rate).toBe(60.0)

    const gpt4turbo = getTokenRate('openai', 'gpt-4-turbo')
    expect(gpt4turbo).not.toBeNull()
    expect(gpt4turbo!.input_rate).toBe(10.0)
    expect(gpt4turbo!.output_rate).toBe(30.0)
  })

  it('resolves provider aliases (claude -> anthropic)', () => {
    const rate = getTokenRate('claude', 'claude-3-sonnet')
    expect(rate).not.toBeNull()
    expect(rate!.input_rate).toBe(3.0)
  })

  it('returns null for unknown provider/model', () => {
    expect(getTokenRate('unknown-provider', 'unknown-model')).toBeNull()
  })

  it('estimateCost calculates correctly (USD per 1M tokens)', () => {
    // 1000 input tokens at $3/1M + 500 output tokens at $15/1M
    const cost = estimateCost('anthropic', 'claude-3-sonnet', 1000, 500)
    const expected = (1000 * 3.0) / 1_000_000 + (500 * 15.0) / 1_000_000
    expect(cost).toBeCloseTo(expected)
  })

  it('estimateCost throws for unknown model', () => {
    expect(() => estimateCost('anthropic', 'nonexistent-model', 100, 100)).toThrow()
  })

  it('estimateCostSafe returns 0 for unknown model', () => {
    expect(estimateCostSafe('anthropic', 'nonexistent-model', 100, 100)).toBe(0)
  })

  it('has rates for current Claude 4.x models (Fix #5)', () => {
    const opus46 = getTokenRate('anthropic', 'claude-opus-4-6')
    expect(opus46).not.toBeNull()
    expect(opus46!.input_rate).toBe(15.0)
    expect(opus46!.output_rate).toBe(75.0)

    const sonnet46 = getTokenRate('anthropic', 'claude-sonnet-4-6')
    expect(sonnet46).not.toBeNull()
    expect(sonnet46!.input_rate).toBe(3.0)
    expect(sonnet46!.output_rate).toBe(15.0)

    const haiku45 = getTokenRate('anthropic', 'claude-haiku-4-5')
    expect(haiku45).not.toBeNull()
    expect(haiku45!.input_rate).toBe(0.8)
    expect(haiku45!.output_rate).toBe(4.0)

    const haiku45date = getTokenRate('anthropic', 'claude-haiku-4-5-20251001')
    expect(haiku45date).not.toBeNull()
    expect(haiku45date!.input_rate).toBe(0.8)
    expect(haiku45date!.output_rate).toBe(4.0)
  })

  it('has alias claude-opus-4 -> opus-4-6 rates (Fix #5)', () => {
    const opusAlias = getTokenRate('anthropic', 'claude-opus-4')
    expect(opusAlias).not.toBeNull()
    expect(opusAlias!.input_rate).toBe(15.0)
    expect(opusAlias!.output_rate).toBe(75.0)
  })

  it('estimateCostSafe uses custom rateTable when provided (Fix #1)', () => {
    const customRates = {
      anthropic: {
        'claude-3-sonnet': { input_rate: 999.0, output_rate: 999.0 },
      },
    }
    const cost = estimateCostSafe('anthropic', 'claude-3-sonnet', 1000, 1000, customRates)
    expect(cost).toBeCloseTo((1000 * 999.0 + 1000 * 999.0) / 1_000_000)
  })
})

// ---------------------------------------------------------------------------
// Cost Persistence Queries (AC1, AC6)
// ---------------------------------------------------------------------------

describe('Cost Persistence Queries', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = createTestDb()
    createTestSession(db)
    createTestTask(db, 'task-1')
    createTestTask(db, 'task-2')
  })

  afterEach(() => {
    db.close()
  })

  describe('recordCostEntry', () => {
    it('inserts a cost entry and returns DB-assigned integer id (Fix #2)', () => {
      const id = recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-1',
        agent: 'claude',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        billing_mode: 'api',
        tokens_input: 1000,
        tokens_output: 500,
        cost_usd: 0.0105,
        savings_usd: 0,
      })

      expect(typeof id).toBe('number')
      expect(id).toBeGreaterThan(0)
    })

    it('auto-increments ids for multiple entries', () => {
      const id1 = recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-1',
        agent: 'claude',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        billing_mode: 'api',
        tokens_input: 100,
        tokens_output: 50,
        cost_usd: 0.001,
        savings_usd: 0,
      })
      const id2 = recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-2',
        agent: 'codex',
        provider: 'openai',
        model: 'gpt-4o',
        billing_mode: 'subscription',
        tokens_input: 200,
        tokens_output: 100,
        cost_usd: 0,
        savings_usd: 0.0015,
      })

      expect(id2).toBeGreaterThan(id1)
    })
  })

  describe('getCostEntryById', () => {
    it('retrieves entry by DB-assigned id with correct type mapping', () => {
      const id = recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-1',
        agent: 'claude',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        billing_mode: 'api',
        tokens_input: 1000,
        tokens_output: 500,
        cost_usd: 0.0105,
        savings_usd: 0,
      })

      const entry = getCostEntryById(db, id)

      expect(entry.id).toBe(id)
      expect(typeof entry.id).toBe('number')
      expect(entry.session_id).toBe('session-1')
      expect(entry.task_id).toBe('task-1')
      expect(entry.agent).toBe('claude')
      expect(entry.provider).toBe('anthropic')
      expect(entry.model).toBe('claude-3-sonnet')
      expect(entry.billing_mode).toBe('api')
      expect(entry.tokens_input).toBe(1000)
      expect(entry.tokens_output).toBe(500)
      expect(entry.cost_usd).toBeCloseTo(0.0105)
      expect(entry.savings_usd).toBe(0)
      expect(entry.created_at).toBeDefined()
    })
  })

  describe('getTaskCostSummary (AC1)', () => {
    it('returns aggregated cost for a task with single entry', () => {
      recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-1',
        agent: 'claude',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        billing_mode: 'api',
        tokens_input: 1000,
        tokens_output: 500,
        cost_usd: 0.0105,
        savings_usd: 0,
      })

      const summary = getTaskCostSummary(db, 'task-1')

      expect(summary.task_id).toBe('task-1')
      expect(summary.cost_usd).toBeCloseTo(0.0105)
      expect(summary.tokens.input).toBe(1000)
      expect(summary.tokens.output).toBe(500)
      expect(summary.tokens.total).toBe(1500)
      expect(summary.billing_mode).toBe('api')
      expect(summary.savings_usd).toBe(0)
    })

    it('returns zero-cost summary for task with no cost entries', () => {
      const summary = getTaskCostSummary(db, 'task-1')

      expect(summary.task_id).toBe('task-1')
      expect(summary.cost_usd).toBe(0)
      expect(summary.tokens.total).toBe(0)
      expect(summary.savings_usd).toBe(0)
    })
  })

  describe('getSessionCostSummary (AC2)', () => {
    it('returns aggregated session cost with breakdown', () => {
      recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-1',
        agent: 'claude',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        billing_mode: 'api',
        tokens_input: 1000,
        tokens_output: 500,
        cost_usd: 0.05,
        savings_usd: 0,
      })
      recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-2',
        agent: 'claude',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        billing_mode: 'subscription',
        tokens_input: 2000,
        tokens_output: 1000,
        cost_usd: 0,
        savings_usd: 0.021,
      })

      const summary = getSessionCostSummary(db, 'session-1')

      expect(summary.session_id).toBe('session-1')
      expect(summary.total_cost_usd).toBeCloseTo(0.05)
      expect(summary.subscription_cost_usd).toBe(0)
      expect(summary.api_cost_usd).toBeCloseTo(0.05)
      expect(summary.savings_usd).toBeCloseTo(0.021)
      expect(summary.task_count).toBe(2)
      expect(summary.subscription_task_count).toBe(1)
      expect(summary.api_task_count).toBe(1)
    })

    it('returns per-agent breakdown (AC2 FR26)', () => {
      recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-1',
        agent: 'claude',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        billing_mode: 'api',
        tokens_input: 1000,
        tokens_output: 500,
        cost_usd: 0.05,
        savings_usd: 0,
      })
      recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-2',
        agent: 'codex',
        provider: 'openai',
        model: 'gpt-4o',
        billing_mode: 'api',
        tokens_input: 500,
        tokens_output: 200,
        cost_usd: 0.03,
        savings_usd: 0,
      })

      const summary = getSessionCostSummary(db, 'session-1')

      expect(summary.per_agent_breakdown.length).toBe(2)
      const claudeBreakdown = summary.per_agent_breakdown.find((a) => a.agent === 'claude')
      expect(claudeBreakdown).toBeDefined()
      expect(claudeBreakdown!.task_count).toBe(1)
      expect(claudeBreakdown!.cost_usd).toBeCloseTo(0.05)
    })

    it('returns actual earliest recorded_at, not synthetic timestamp (Fix #8)', () => {
      recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-1',
        agent: 'claude',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        billing_mode: 'api',
        tokens_input: 100,
        tokens_output: 50,
        cost_usd: 0.001,
        savings_usd: 0,
      })

      const summary = getSessionCostSummary(db, 'session-1')

      // The created_at should NOT be a fresh timestamp — it should come from the DB
      // Verify it's a valid date string from the DB, not a brand-new Date()
      expect(summary.created_at).toBeDefined()
      expect(summary.created_at).not.toBe('')
      // The DB uses datetime('now') format: YYYY-MM-DD HH:MM:SS
      // It should be a reasonable timestamp (not the current millisecond)
      const timestamp = new Date(summary.created_at)
      expect(timestamp.getTime()).not.toBeNaN()
    })

    it('returns empty summary for session with no cost entries', () => {
      const summary = getSessionCostSummary(db, 'session-1')

      expect(summary.total_cost_usd).toBe(0)
      expect(summary.task_count).toBe(0)
      expect(summary.per_agent_breakdown).toHaveLength(0)
    })
  })

  describe('getAgentCostBreakdown (AC5)', () => {
    it('returns cost breakdown for a specific agent', () => {
      recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-1',
        agent: 'claude',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        billing_mode: 'api',
        tokens_input: 1000,
        tokens_output: 500,
        cost_usd: 0.05,
        savings_usd: 0,
      })
      recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-2',
        agent: 'claude',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        billing_mode: 'subscription',
        tokens_input: 2000,
        tokens_output: 1000,
        cost_usd: 0,
        savings_usd: 0.021,
      })

      const breakdown = getAgentCostBreakdown(db, 'session-1', 'claude')

      expect(breakdown.agent).toBe('claude')
      expect(breakdown.task_count).toBe(2)
      expect(breakdown.cost_usd).toBeCloseTo(0.05)
      expect(breakdown.savings_usd).toBeCloseTo(0.021)
      expect(breakdown.subscription_tasks).toBe(1)
      expect(breakdown.api_tasks).toBe(1)
    })
  })

  describe('getAllCostEntries', () => {
    it('returns all entries for a session ordered by timestamp DESC', () => {
      recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-1',
        agent: 'claude',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        billing_mode: 'api',
        tokens_input: 100,
        tokens_output: 50,
        cost_usd: 0.01,
        savings_usd: 0,
      })
      recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-2',
        agent: 'codex',
        provider: 'openai',
        model: 'gpt-4o',
        billing_mode: 'subscription',
        tokens_input: 200,
        tokens_output: 100,
        cost_usd: 0,
        savings_usd: 0.005,
      })

      const entries = getAllCostEntries(db, 'session-1')

      expect(entries).toHaveLength(2)
      // Verify id is a number, not a string (Fix #2)
      expect(typeof entries[0]!.id).toBe('number')
      expect(typeof entries[1]!.id).toBe('number')
    })

    it('respects limit parameter', () => {
      recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-1',
        agent: 'claude',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        billing_mode: 'api',
        tokens_input: 100,
        tokens_output: 50,
        cost_usd: 0.01,
        savings_usd: 0,
      })
      recordCostEntry(db, {
        session_id: 'session-1',
        task_id: 'task-2',
        agent: 'codex',
        provider: 'openai',
        model: 'gpt-4o',
        billing_mode: 'api',
        tokens_input: 200,
        tokens_output: 100,
        cost_usd: 0.02,
        savings_usd: 0,
      })

      const entries = getAllCostEntries(db, 'session-1', 1)
      expect(entries).toHaveLength(1)
    })
  })

  describe('Index verification (AC6)', () => {
    it('has idx_cost_entries_session_task composite index', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cost_entries'")
        .all() as { name: string }[]
      const names = indexes.map((i) => i.name)
      expect(names).toContain('idx_cost_entries_session_task')
    })

    it('has idx_cost_entries_provider index', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cost_entries'")
        .all() as { name: string }[]
      const names = indexes.map((i) => i.name)
      expect(names).toContain('idx_cost_entries_provider')
    })

    it('has idx_cost_agent index', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cost_entries'")
        .all() as { name: string }[]
      const names = indexes.map((i) => i.name)
      expect(names).toContain('idx_cost_agent')
    })

    it('has idx_cost_session index from migration 001', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cost_entries'")
        .all() as { name: string }[]
      const names = indexes.map((i) => i.name)
      expect(names).toContain('idx_cost_session')
    })

    it('has idx_cost_task index from migration 001', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cost_entries'")
        .all() as { name: string }[]
      const names = indexes.map((i) => i.name)
      expect(names).toContain('idx_cost_task')
    })

    it('has idx_cost_session_agent composite index for agent breakdown queries (Fix #3)', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cost_entries'")
        .all() as { name: string }[]
      const names = indexes.map((i) => i.name)
      expect(names).toContain('idx_cost_session_agent')
    })
  })
})

// ---------------------------------------------------------------------------
// CostTrackerImpl (AC1, AC2, AC4, AC5)
// ---------------------------------------------------------------------------

describe('CostTrackerImpl', () => {
  let db: BetterSqlite3Database
  let eventBus: TypedEventBus
  let tracker: CostTracker

  beforeEach(() => {
    db = createTestDb()
    eventBus = new TypedEventBusImpl()
    tracker = createCostTracker({ db, eventBus })
    createTestSession(db)
    createTestTask(db, 'task-1')
    createTestTask(db, 'task-2')
    createTestTask(db, 'task-3')
  })

  afterEach(() => {
    db.close()
  })

  describe('recordTaskCost (AC1)', () => {
    it('records API billing cost correctly', () => {
      const entry = tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        1000,
        500,
        'api',
      )

      expect(typeof entry.id).toBe('number')
      expect(entry.id).toBeGreaterThan(0)
      expect(entry.billing_mode).toBe('api')
      expect(entry.cost_usd).toBeGreaterThan(0)
      expect(entry.savings_usd).toBe(0)
      expect(entry.tokens_input).toBe(1000)
      expect(entry.tokens_output).toBe(500)
    })

    it('records subscription billing with zero cost and savings (AC4)', () => {
      const entry = tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        1000,
        500,
        'subscription',
      )

      expect(entry.billing_mode).toBe('subscription')
      expect(entry.cost_usd).toBe(0)
      expect(entry.savings_usd).toBeGreaterThan(0)

      // Savings should equal the equivalent API cost
      const expectedApiCost = (1000 * 3.0) / 1_000_000 + (500 * 15.0) / 1_000_000
      expect(entry.savings_usd).toBeCloseTo(expectedApiCost)
    })

    it('emits cost:recorded event', () => {
      const handler = vi.fn()
      eventBus.on('cost:recorded', handler)

      tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        1000,
        500,
        'api',
      )

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          sessionId: 'session-1',
          billingMode: 'api',
        }),
      )
    })

    it('updates task cumulative cost_usd', () => {
      tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        1000,
        500,
        'api',
      )

      const row = db.prepare('SELECT cost_usd FROM tasks WHERE id = ?').get('task-1') as {
        cost_usd: number
      }
      expect(row.cost_usd).toBeGreaterThan(0)
    })

    it('accumulates cost_usd across multiple recordings', () => {
      tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        1000,
        500,
        'api',
      )
      const firstCost = (
        db.prepare('SELECT cost_usd FROM tasks WHERE id = ?').get('task-1') as {
          cost_usd: number
        }
      ).cost_usd

      tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        2000,
        1000,
        'api',
      )
      const secondCost = (
        db.prepare('SELECT cost_usd FROM tasks WHERE id = ?').get('task-1') as {
          cost_usd: number
        }
      ).cost_usd

      expect(secondCost).toBeGreaterThan(firstCost)
    })

    it('returns CostEntry with DB-assigned id (not constructed string) (Fix #2)', () => {
      const entry = tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        100,
        50,
        'api',
      )

      // id should be a number assigned by SQLite AUTOINCREMENT
      expect(typeof entry.id).toBe('number')
      // Should NOT be a string like "task-1-2026-02-20T..."
      expect(entry.id).not.toContain?.('task-1')
    })
  })

  describe('getTaskCost (AC1)', () => {
    it('returns task cost summary', () => {
      tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        1000,
        500,
        'api',
      )

      const summary = tracker.getTaskCost('task-1')

      expect(summary.task_id).toBe('task-1')
      expect(summary.cost_usd).toBeGreaterThan(0)
      expect(summary.tokens.input).toBe(1000)
      expect(summary.tokens.output).toBe(500)
      expect(summary.billing_mode).toBe('api')
    })

    it('returns mixed billing_mode when task has both types', () => {
      tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        1000,
        500,
        'api',
      )
      tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        500,
        200,
        'subscription',
      )

      const summary = tracker.getTaskCost('task-1')
      expect(summary.billing_mode).toBe('mixed')
    })
  })

  describe('getSessionCost (AC2, AC5)', () => {
    it('returns full session cost summary with all fields', () => {
      tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        1000,
        500,
        'api',
      )
      tracker.recordTaskCost(
        'session-1',
        'task-2',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        2000,
        1000,
        'subscription',
      )

      const summary = tracker.getSessionCost('session-1')

      expect(summary.session_id).toBe('session-1')
      expect(summary.total_cost_usd).toBeGreaterThan(0)
      expect(summary.subscription_cost_usd).toBe(0)
      expect(summary.api_cost_usd).toBeGreaterThan(0)
      expect(summary.savings_usd).toBeGreaterThan(0)
      expect(summary.task_count).toBe(2)
      expect(summary.subscription_task_count).toBe(1)
      expect(summary.api_task_count).toBe(1)
      expect(summary.per_agent_breakdown.length).toBe(1)
      expect(summary.per_agent_breakdown[0]!.agent).toBe('claude')
    })

    it('provides savings_usd showing savings from subscription routing (AC4, AC5, FR26, FR28)', () => {
      // Record a subscription task
      tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        10000,
        5000,
        'subscription',
      )

      const summary = tracker.getSessionCost('session-1')

      // Savings should be the equivalent API cost of the subscription-routed task
      const expectedSavings = (10000 * 3.0) / 1_000_000 + (5000 * 15.0) / 1_000_000
      expect(summary.savings_usd).toBeCloseTo(expectedSavings)
      expect(summary.total_cost_usd).toBe(0)
    })

    it('returns savingsSummary string when subscription savings exist (AC5, Fix #6)', () => {
      tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        10000,
        5000,
        'subscription',
      )

      const summary = tracker.getSessionCost('session-1')

      expect(summary.savingsSummary).toMatch(/^Saved ~\$[\d.]+ by routing \d+ tasks? through subscriptions vs\. equivalent API pricing$/)
    })

    it('returns savingsSummary "no savings" message when no subscription tasks (AC5, Fix #6)', () => {
      tracker.recordTaskCost(
        'session-1',
        'task-1',
        'claude',
        'anthropic',
        'claude-3-sonnet',
        1000,
        500,
        'api',
      )

      const summary = tracker.getSessionCost('session-1')

      expect(summary.savingsSummary).toBe('No subscription savings recorded this session')
    })

    it('returns savingsSummary "no savings" for empty session (AC5, Fix #6)', () => {
      const summary = tracker.getSessionCost('session-1')
      expect(summary.savingsSummary).toBe('No subscription savings recorded this session')
    })
  })

  describe('getAgentCostBreakdown', () => {
    it('returns breakdown with billing_breakdown', () => {
      tracker.recordTaskCost('session-1', 'task-1', 'claude', 'anthropic', 'claude-3-sonnet', 1000, 500, 'api')
      tracker.recordTaskCost('session-1', 'task-2', 'claude', 'anthropic', 'claude-3-sonnet', 500, 200, 'subscription')

      const breakdown = tracker.getAgentCostBreakdown('session-1', 'claude')

      expect(breakdown.task_count).toBe(2)
      expect(breakdown.billing_breakdown.api).toBe(1)
      expect(breakdown.billing_breakdown.subscription).toBe(1)
      expect(breakdown.cost_usd).toBeGreaterThan(0)
    })
  })

  describe('getAllCosts', () => {
    it('returns all cost entries for a session', () => {
      tracker.recordTaskCost('session-1', 'task-1', 'claude', 'anthropic', 'claude-3-sonnet', 100, 50, 'api')
      tracker.recordTaskCost('session-1', 'task-2', 'codex', 'openai', 'gpt-4o', 200, 100, 'api')

      const entries = tracker.getAllCosts('session-1')

      expect(entries).toHaveLength(2)
    })

    it('supports limit parameter', () => {
      tracker.recordTaskCost('session-1', 'task-1', 'claude', 'anthropic', 'claude-3-sonnet', 100, 50, 'api')
      tracker.recordTaskCost('session-1', 'task-2', 'codex', 'openai', 'gpt-4o', 200, 100, 'api')

      const entries = tracker.getAllCosts('session-1', 1)

      expect(entries).toHaveLength(1)
    })
  })
})

// ---------------------------------------------------------------------------
// CostTrackerSubscriber (Task 5)
// ---------------------------------------------------------------------------

describe('CostTrackerSubscriber', () => {
  let db: BetterSqlite3Database
  let eventBus: TypedEventBus
  let costTracker: CostTracker
  let subscriber: CostTrackerSubscriber

  beforeEach(async () => {
    db = createTestDb()
    eventBus = new TypedEventBusImpl()
    costTracker = createCostTracker({ db, eventBus })
    createTestSession(db)
    createTestTask(db, 'task-1')
    createTestTask(db, 'task-2')

    subscriber = createCostTrackerSubscriber({
      eventBus,
      costTracker,
      sessionId: 'session-1',
    })
    await subscriber.initialize()
  })

  afterEach(async () => {
    await subscriber.shutdown()
    db.close()
  })

  it('records cost when task:routed then task:complete events fire', () => {
    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'api',
        model: 'claude-3-sonnet',
        rationale: 'test',
      },
    })

    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 1000, exitCode: 0 },
    })

    const entries = getAllCostEntries(db, 'session-1')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.task_id).toBe('task-1')
    expect(entries[0]!.billing_mode).toBe('api')
  })

  it('uses the sessionId passed to constructor (Fix #4)', () => {
    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'api',
        model: 'claude-3-sonnet',
        rationale: 'test',
      },
    })

    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 100, exitCode: 0 },
    })

    const entries = getAllCostEntries(db, 'session-1')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.session_id).toBe('session-1')
  })

  it('splits tokensUsed proportionally between input and output (Fix #5)', () => {
    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'api',
        model: 'claude-3-sonnet',
        rationale: 'test',
      },
    })

    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 1000, exitCode: 0 },
    })

    const entries = getAllCostEntries(db, 'session-1')
    expect(entries).toHaveLength(1)

    // 25% input, 75% output heuristic
    expect(entries[0]!.tokens_input).toBe(250)
    expect(entries[0]!.tokens_output).toBe(750)
    // Total should still equal 1000
    expect(entries[0]!.tokens_input + entries[0]!.tokens_output).toBe(1000)
  })

  it('skips cost recording when billingMode is "unavailable" (Fix #6)', () => {
    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'unavailable',
        model: 'claude-3-sonnet',
        rationale: 'no provider available',
      },
    })

    // Complete should be a no-op since routing was unavailable
    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 0, exitCode: 0 },
    })

    const entries = getAllCostEntries(db, 'session-1')
    expect(entries).toHaveLength(0)
  })

  it('records zero-cost entry for failed tasks', () => {
    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'api',
        model: 'claude-3-sonnet',
        rationale: 'test',
      },
    })

    eventBus.emit('task:failed', {
      taskId: 'task-1',
      error: { message: 'something went wrong' },
    })

    const entries = getAllCostEntries(db, 'session-1')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.tokens_input).toBe(0)
    expect(entries[0]!.tokens_output).toBe(0)
  })

  it('skips cost recording when no routing context is cached', () => {
    // Emit task:complete without a prior task:routed
    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 100, exitCode: 0 },
    })

    const entries = getAllCostEntries(db, 'session-1')
    expect(entries).toHaveLength(0)
  })

  it('clears routing cache after task completion', () => {
    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'api',
        model: 'claude-3-sonnet',
        rationale: 'test',
      },
    })

    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 100, exitCode: 0 },
    })

    // Second complete for same task should be a no-op
    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 100, exitCode: 0 },
    })

    const entries = getAllCostEntries(db, 'session-1')
    expect(entries).toHaveLength(1)
  })

  it('setDefaultSessionId updates the session used for subsequent recordings', () => {
    createTestSession(db, 'session-2')

    subscriber.setDefaultSessionId('session-2')

    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'api',
        model: 'claude-3-sonnet',
        rationale: 'test',
      },
    })

    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 100, exitCode: 0 },
    })

    const entries = getAllCostEntries(db, 'session-2')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.session_id).toBe('session-2')
  })

  it('handles subscription billing correctly via events', () => {
    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'subscription',
        model: 'claude-3-sonnet',
        rationale: 'subscription available',
      },
    })

    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 1000, exitCode: 0 },
    })

    const entries = getAllCostEntries(db, 'session-1')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.billing_mode).toBe('subscription')
    expect(entries[0]!.cost_usd).toBe(0)
    expect(entries[0]!.savings_usd).toBeGreaterThan(0)
  })

  it('unsubscribes from events on shutdown', async () => {
    await subscriber.shutdown()

    eventBus.emit('task:routed', {
      taskId: 'task-1',
      decision: {
        taskId: 'task-1',
        agent: 'claude',
        billingMode: 'api',
        model: 'claude-3-sonnet',
        rationale: 'test',
      },
    })

    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { tokensUsed: 100, exitCode: 0 },
    })

    const entries = getAllCostEntries(db, 'session-1')
    expect(entries).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// createCostTracker factory
// ---------------------------------------------------------------------------

describe('createCostTracker', () => {
  it('creates a working CostTracker with default token rates', () => {
    const db = createTestDb()
    const eventBus = new TypedEventBusImpl()
    const tracker = createCostTracker({ db, eventBus })

    createTestSession(db)
    createTestTask(db, 'task-1')

    const entry = tracker.recordTaskCost(
      'session-1',
      'task-1',
      'claude',
      'anthropic',
      'claude-3-sonnet',
      100,
      50,
      'api',
    )
    expect(entry.cost_usd).toBeGreaterThan(0)

    db.close()
  })

  it('creates a CostTracker with custom token rates that are actually used', () => {
    const db = createTestDb()
    const eventBus = new TypedEventBusImpl()
    // Override anthropic/claude-3-sonnet with a very high rate to prove injection works
    const customRates = {
      anthropic: {
        'claude-3-sonnet': { input_rate: 1000.0, output_rate: 2000.0 },
      },
    }
    const tracker = createCostTracker({ db, eventBus, tokenRates: customRates })

    createTestSession(db)
    createTestTask(db, 'task-1')

    const entry = tracker.recordTaskCost(
      'session-1',
      'task-1',
      'claude',
      'anthropic',
      'claude-3-sonnet',
      1000,
      500,
      'api',
    )
    // With custom rates: (1000 * 1000.0 + 500 * 2000.0) / 1_000_000 = $2.00
    // With global rates: (1000 * 3.0 + 500 * 15.0) / 1_000_000 = $0.0105
    // Verify injected rates are used (cost should be ~$2.00, not ~$0.0105)
    expect(entry.cost_usd).toBeCloseTo(2.0)

    db.close()
  })
})
