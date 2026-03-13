/**
 * Unit tests for src/persistence/queries/cost.ts
 *
 * Uses in-memory SQLite database seeded with all migrations.
 * All test functions use SqliteDatabaseAdapter, satisfying AC3 and AC6.
 *
 * Covers:
 *  - recordCostEntry: inserts a row, returns portable auto-increment ID
 *  - getCostEntryById: retrieves and maps DB columns to CostEntry fields
 *  - incrementTaskCost: atomically increments task cost_usd
 *  - getSessionCostSummary: aggregated totals with per-agent breakdown
 *  - getSessionCostSummaryFiltered: planning-entry exclusion / inclusion
 *  - getTaskCostSummary: per-task token and cost aggregation
 *  - getAgentCostBreakdown: per-agent breakdown within a session
 *  - getAllCostEntries: ordered result set with optional pagination
 *  - getAllCostEntriesFiltered: planning-entry exclusion / inclusion
 *  - getPlanningCostTotal: sum of planning entries for a session
 *  - getSessionCost (legacy): total cost + token aggregation
 *  - getTaskCost (legacy): total cost + token aggregation per task
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { SyncDatabaseAdapter } from '../../wasm-sqlite-adapter.js'
import { initSchema } from '../../schema.js'
import {
  recordCostEntry,
  getCostEntryById,
  incrementTaskCost,
  getSessionCostSummary,
  getSessionCostSummaryFiltered,
  getTaskCostSummary,
  getAgentCostBreakdown,
  getAllCostEntries,
  getAllCostEntriesFiltered,
  getPlanningCostTotal,
  getSessionCost,
  getTaskCost,
} from '../cost.js'
import type { CreateCostEntryInput } from '../cost.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openDb() {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  await initSchema(new SyncDatabaseAdapter(db))
  return db
}

/** Insert a session row (required FK for cost_entries.session_id). */
function insertSession(db: InstanceType<typeof Database>, id: string): void {
  db.prepare(
    `INSERT INTO sessions (id, graph_file, status, created_at, updated_at)
     VALUES (?, 'test.json', 'active', datetime('now'), datetime('now'))`,
  ).run(id)
}

/** Insert a task row (required FK when cost_entries.task_id is non-null). */
function insertTask(db: InstanceType<typeof Database>, sessionId: string, taskId: string): void {
  db.prepare(
    `INSERT INTO tasks (id, session_id, name, prompt, status, cost_usd, created_at, updated_at)
     VALUES (?, ?, 'test-task', 'test-prompt', 'completed', 0.0, datetime('now'), datetime('now'))`,
  ).run(taskId, sessionId)
}

/**
 * Insert a cost_entries row directly via raw SQL.
 * Used for test setup that needs to control the category field (e.g. planning)
 * or set values that are not exposed through recordCostEntry.
 */
function insertCostEntryDirect(
  db: InstanceType<typeof Database>,
  sessionId: string,
  opts: {
    agent?: string
    billingMode?: string
    category?: string
    estimatedCost?: number
    savingsUsd?: number
    inputTokens?: number
    outputTokens?: number
    taskId?: string | null
    model?: string | null
    provider?: string
  } = {},
): void {
  const {
    agent = 'test-agent',
    billingMode = 'api',
    category = 'execution',
    estimatedCost = 0.01,
    savingsUsd = 0,
    inputTokens = 100,
    outputTokens = 50,
    taskId = null,
    model = 'claude-3',
    provider = 'anthropic',
  } = opts
  db.prepare(
    `INSERT INTO cost_entries
       (session_id, task_id, agent, billing_mode, category,
        input_tokens, output_tokens, estimated_cost, model, provider, savings_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, taskId, agent, billingMode, category, inputTokens, outputTokens, estimatedCost, model, provider, savingsUsd)
}

/** Build a minimal CreateCostEntryInput for recordCostEntry tests. */
function makeEntry(sessionId: string, overrides: Partial<CreateCostEntryInput> = {}): CreateCostEntryInput {
  return {
    session_id: sessionId,
    task_id: null,
    agent: 'test-agent',
    provider: 'anthropic',
    model: 'claude-3',
    billing_mode: 'api',
    tokens_input: 100,
    tokens_output: 50,
    cost_usd: 0.005,
    savings_usd: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// recordCostEntry
// ---------------------------------------------------------------------------

describe('recordCostEntry()', () => {
  let db: InstanceType<typeof Database>

  beforeEach(async () => {
    db = await openDb()
    insertSession(db, 'sess-rec')
  })

  afterEach(() => {
    db.close()
  })

  it('AC1/AC2: accepts SqliteDatabaseAdapter and returns a Promise<number>', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const id = await recordCostEntry(adapter, makeEntry('sess-rec'))
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)
  })

  it('returns a positive integer ID for the inserted row', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const id = await recordCostEntry(adapter, makeEntry('sess-rec'))
    expect(Number.isInteger(id)).toBe(true)
    expect(id).toBeGreaterThan(0)
  })

  it('returns incrementing IDs for subsequent inserts', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const id1 = await recordCostEntry(adapter, makeEntry('sess-rec'))
    const id2 = await recordCostEntry(adapter, makeEntry('sess-rec'))
    expect(id2).toBeGreaterThan(id1)
  })

  it('inserted row is retrievable via getCostEntryById', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const id = await recordCostEntry(adapter, makeEntry('sess-rec', { agent: 'my-agent', cost_usd: 0.042 }))
    const fetched = await getCostEntryById(adapter, id)
    expect(fetched).not.toBeNull()
    expect(fetched?.agent).toBe('my-agent')
    expect(fetched?.cost_usd).toBeCloseTo(0.042)
  })

  it('stores category as execution (hardcoded value)', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const id = await recordCostEntry(adapter, makeEntry('sess-rec'))
    const row = db.prepare('SELECT category FROM cost_entries WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('execution')
  })
})

// ---------------------------------------------------------------------------
// getCostEntryById
// ---------------------------------------------------------------------------

describe('getCostEntryById()', () => {
  let db: InstanceType<typeof Database>

  beforeEach(async () => {
    db = await openDb()
    insertSession(db, 'sess-get')
  })

  afterEach(() => {
    db.close()
  })

  it('returns null for a nonexistent id', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    expect(await getCostEntryById(adapter, 999999)).toBeNull()
  })

  it('returns a correctly mapped CostEntry with all fields', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const id = await recordCostEntry(
      adapter,
      makeEntry('sess-get', {
        agent: 'mapper-agent',
        provider: 'openai',
        model: 'gpt-4',
        billing_mode: 'api',
        tokens_input: 200,
        tokens_output: 100,
        cost_usd: 0.01,
        savings_usd: 0,
      }),
    )
    const entry = await getCostEntryById(adapter, id)
    expect(entry).not.toBeNull()
    expect(entry?.id).toBe(id)
    expect(entry?.session_id).toBe('sess-get')
    expect(entry?.agent).toBe('mapper-agent')
    expect(entry?.provider).toBe('openai')
    expect(entry?.model).toBe('gpt-4')
    expect(entry?.billing_mode).toBe('api')
    expect(entry?.tokens_input).toBe(200)
    expect(entry?.tokens_output).toBe(100)
    expect(entry?.cost_usd).toBeCloseTo(0.01)
    expect(entry?.savings_usd).toBe(0)
    expect(typeof entry?.created_at).toBe('string')
  })

  it('maps savings_usd correctly for subscription entries', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const id = await recordCostEntry(
      adapter,
      makeEntry('sess-get', { billing_mode: 'subscription', cost_usd: 0, savings_usd: 0.02 }),
    )
    const entry = await getCostEntryById(adapter, id)
    expect(entry?.billing_mode).toBe('subscription')
    expect(entry?.savings_usd).toBeCloseTo(0.02)
  })
})

// ---------------------------------------------------------------------------
// incrementTaskCost
// ---------------------------------------------------------------------------

describe('incrementTaskCost()', () => {
  let db: InstanceType<typeof Database>

  beforeEach(async () => {
    db = await openDb()
    insertSession(db, 'sess-inc')
    insertTask(db, 'sess-inc', 'task-inc')
  })

  afterEach(() => {
    db.close()
  })

  it('increments task cost_usd by the given delta', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    await incrementTaskCost(adapter, 'task-inc', 0.05)
    const row = db.prepare('SELECT cost_usd FROM tasks WHERE id = ?').get('task-inc') as { cost_usd: number }
    expect(row.cost_usd).toBeCloseTo(0.05)
  })

  it('accumulates multiple increments correctly', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    await incrementTaskCost(adapter, 'task-inc', 0.01)
    await incrementTaskCost(adapter, 'task-inc', 0.02)
    await incrementTaskCost(adapter, 'task-inc', 0.03)
    const row = db.prepare('SELECT cost_usd FROM tasks WHERE id = ?').get('task-inc') as { cost_usd: number }
    expect(row.cost_usd).toBeCloseTo(0.06)
  })
})

// ---------------------------------------------------------------------------
// getSessionCostSummary
// ---------------------------------------------------------------------------

describe('getSessionCostSummary()', () => {
  let db: InstanceType<typeof Database>

  beforeEach(async () => {
    db = await openDb()
    insertSession(db, 'sess-sum')
  })

  afterEach(() => {
    db.close()
  })

  it('returns zero totals for a session with no cost entries', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const summary = await getSessionCostSummary(adapter, 'sess-sum')
    expect(summary.total_cost_usd).toBe(0)
    expect(summary.subscription_cost_usd).toBe(0)
    expect(summary.api_cost_usd).toBe(0)
    expect(summary.savings_usd).toBe(0)
    expect(summary.task_count).toBe(0)
    expect(summary.per_agent_breakdown).toEqual([])
  })

  it('returns correct totals for api billing entries', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    insertCostEntryDirect(db, 'sess-sum', { billingMode: 'api', estimatedCost: 0.01 })
    insertCostEntryDirect(db, 'sess-sum', { billingMode: 'api', estimatedCost: 0.02 })
    const summary = await getSessionCostSummary(adapter, 'sess-sum')
    expect(summary.total_cost_usd).toBeCloseTo(0.03)
    expect(summary.api_cost_usd).toBeCloseTo(0.03)
    expect(summary.subscription_cost_usd).toBe(0)
    expect(summary.task_count).toBe(2)
  })

  it('separates subscription and api costs correctly', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    insertCostEntryDirect(db, 'sess-sum', { billingMode: 'api', estimatedCost: 0.01 })
    insertCostEntryDirect(db, 'sess-sum', { billingMode: 'subscription', estimatedCost: 0.02, savingsUsd: 0.02 })
    const summary = await getSessionCostSummary(adapter, 'sess-sum')
    expect(summary.api_cost_usd).toBeCloseTo(0.01)
    expect(summary.subscription_cost_usd).toBeCloseTo(0.02)
    expect(summary.subscription_task_count).toBe(1)
    expect(summary.api_task_count).toBe(1)
    expect(summary.savings_usd).toBeCloseTo(0.02)
  })

  it('populates per_agent_breakdown with agent totals', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    insertCostEntryDirect(db, 'sess-sum', { agent: 'agent-a', estimatedCost: 0.01 })
    insertCostEntryDirect(db, 'sess-sum', { agent: 'agent-b', estimatedCost: 0.02 })
    const summary = await getSessionCostSummary(adapter, 'sess-sum')
    const agents = summary.per_agent_breakdown.map((b) => b.agent)
    expect(agents).toContain('agent-a')
    expect(agents).toContain('agent-b')
    expect(summary.per_agent_breakdown).toHaveLength(2)
  })

  it('returns a savingsSummary string', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const summary = await getSessionCostSummary(adapter, 'sess-sum')
    expect(typeof summary.savingsSummary).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// getSessionCostSummaryFiltered
// ---------------------------------------------------------------------------

describe('getSessionCostSummaryFiltered()', () => {
  let db: InstanceType<typeof Database>

  beforeEach(async () => {
    db = await openDb()
    insertSession(db, 'sess-filt')
    insertCostEntryDirect(db, 'sess-filt', { category: 'execution', estimatedCost: 0.01 })
    insertCostEntryDirect(db, 'sess-filt', { category: 'planning', estimatedCost: 0.05 })
  })

  afterEach(() => {
    db.close()
  })

  it('excludes planning entries when includePlanning=false', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const summary = await getSessionCostSummaryFiltered(adapter, 'sess-filt', false)
    expect(summary.total_cost_usd).toBeCloseTo(0.01)
    expect(summary.task_count).toBe(1)
  })

  it('includes all entries when includePlanning=true', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const summary = await getSessionCostSummaryFiltered(adapter, 'sess-filt', true)
    expect(summary.total_cost_usd).toBeCloseTo(0.06)
    expect(summary.task_count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// getTaskCostSummary
// ---------------------------------------------------------------------------

describe('getTaskCostSummary()', () => {
  let db: InstanceType<typeof Database>

  beforeEach(async () => {
    db = await openDb()
    insertSession(db, 'sess-task')
    insertTask(db, 'sess-task', 'task-t1')
  })

  afterEach(() => {
    db.close()
  })

  it('returns zero cost and tokens for a task with no entries', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const summary = await getTaskCostSummary(adapter, 'task-t1')
    expect(summary.cost_usd).toBe(0)
    expect(summary.tokens.input).toBe(0)
    expect(summary.tokens.output).toBe(0)
    expect(summary.tokens.total).toBe(0)
  })

  it('aggregates tokens and cost across multiple entries', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    insertCostEntryDirect(db, 'sess-task', { taskId: 'task-t1', inputTokens: 100, outputTokens: 50, estimatedCost: 0.01 })
    insertCostEntryDirect(db, 'sess-task', { taskId: 'task-t1', inputTokens: 200, outputTokens: 100, estimatedCost: 0.02 })
    const summary = await getTaskCostSummary(adapter, 'task-t1')
    expect(summary.tokens.input).toBe(300)
    expect(summary.tokens.output).toBe(150)
    expect(summary.tokens.total).toBe(450)
    expect(summary.cost_usd).toBeCloseTo(0.03)
  })

  it('returns billing_mode=mixed for entries with both api and subscription', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    insertCostEntryDirect(db, 'sess-task', { taskId: 'task-t1', billingMode: 'api' })
    insertCostEntryDirect(db, 'sess-task', { taskId: 'task-t1', billingMode: 'subscription' })
    const summary = await getTaskCostSummary(adapter, 'task-t1')
    expect(summary.billing_mode).toBe('mixed')
  })

  it('returns billing_mode=subscription for all-subscription entries', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    insertCostEntryDirect(db, 'sess-task', { taskId: 'task-t1', billingMode: 'subscription' })
    const summary = await getTaskCostSummary(adapter, 'task-t1')
    expect(summary.billing_mode).toBe('subscription')
  })

  it('returns billing_mode=api for all-api entries', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    insertCostEntryDirect(db, 'sess-task', { taskId: 'task-t1', billingMode: 'api' })
    const summary = await getTaskCostSummary(adapter, 'task-t1')
    expect(summary.billing_mode).toBe('api')
  })
})

// ---------------------------------------------------------------------------
// getAgentCostBreakdown
// ---------------------------------------------------------------------------

describe('getAgentCostBreakdown()', () => {
  let db: InstanceType<typeof Database>

  beforeEach(async () => {
    db = await openDb()
    insertSession(db, 'sess-agt')
    insertCostEntryDirect(db, 'sess-agt', { agent: 'agt-x', billingMode: 'api', estimatedCost: 0.01 })
    insertCostEntryDirect(db, 'sess-agt', { agent: 'agt-x', billingMode: 'subscription', estimatedCost: 0.02, savingsUsd: 0.02 })
    insertCostEntryDirect(db, 'sess-agt', { agent: 'agt-y', estimatedCost: 0.05 })
  })

  afterEach(() => {
    db.close()
  })

  it('returns correct task_count for the requested agent', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const breakdown = await getAgentCostBreakdown(adapter, 'sess-agt', 'agt-x')
    expect(breakdown.task_count).toBe(2)
  })

  it('returns correct cost_usd for the requested agent', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const breakdown = await getAgentCostBreakdown(adapter, 'sess-agt', 'agt-x')
    expect(breakdown.cost_usd).toBeCloseTo(0.03)
  })

  it('separates subscription_tasks and api_tasks counts correctly', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const breakdown = await getAgentCostBreakdown(adapter, 'sess-agt', 'agt-x')
    expect(breakdown.subscription_tasks).toBe(1)
    expect(breakdown.api_tasks).toBe(1)
  })

  it('does not include entries from other agents in the session', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const breakdown = await getAgentCostBreakdown(adapter, 'sess-agt', 'agt-x')
    // agt-y has a separate entry; agt-x total should still be 2
    expect(breakdown.task_count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// getAllCostEntries
// ---------------------------------------------------------------------------

describe('getAllCostEntries()', () => {
  let db: InstanceType<typeof Database>

  beforeEach(async () => {
    db = await openDb()
    insertSession(db, 'sess-all')
    insertCostEntryDirect(db, 'sess-all', { estimatedCost: 0.01 })
    insertCostEntryDirect(db, 'sess-all', { estimatedCost: 0.02 })
    insertCostEntryDirect(db, 'sess-all', { estimatedCost: 0.03 })
  })

  afterEach(() => {
    db.close()
  })

  it('returns all entries for the session', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const entries = await getAllCostEntries(adapter, 'sess-all')
    expect(entries).toHaveLength(3)
  })

  it('respects the limit parameter', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const entries = await getAllCostEntries(adapter, 'sess-all', 2)
    expect(entries).toHaveLength(2)
  })

  it('returns empty array for an unknown session', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    expect(await getAllCostEntries(adapter, 'unknown-session')).toHaveLength(0)
  })

  it('maps DB columns to CostEntry fields', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const entries = await getAllCostEntries(adapter, 'sess-all')
    const entry = entries[0]
    expect(entry).toHaveProperty('id')
    expect(entry).toHaveProperty('session_id', 'sess-all')
    expect(entry).toHaveProperty('tokens_input')
    expect(entry).toHaveProperty('tokens_output')
    expect(entry).toHaveProperty('cost_usd')
    expect(entry).toHaveProperty('savings_usd')
    expect(entry).toHaveProperty('created_at')
  })
})

// ---------------------------------------------------------------------------
// getAllCostEntriesFiltered
// ---------------------------------------------------------------------------

describe('getAllCostEntriesFiltered()', () => {
  let db: InstanceType<typeof Database>

  beforeEach(async () => {
    db = await openDb()
    insertSession(db, 'sess-ef')
    insertCostEntryDirect(db, 'sess-ef', { category: 'execution', estimatedCost: 0.01 })
    insertCostEntryDirect(db, 'sess-ef', { category: 'planning', estimatedCost: 0.05 })
    insertCostEntryDirect(db, 'sess-ef', { category: 'execution', estimatedCost: 0.02 })
  })

  afterEach(() => {
    db.close()
  })

  it('excludes planning entries when includePlanning=false', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const entries = await getAllCostEntriesFiltered(adapter, 'sess-ef', false)
    expect(entries).toHaveLength(2)
  })

  it('includes all entries (including planning) when includePlanning=true', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const entries = await getAllCostEntriesFiltered(adapter, 'sess-ef', true)
    expect(entries).toHaveLength(3)
  })

  it('returns empty array for an unknown session', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    expect(await getAllCostEntriesFiltered(adapter, 'unknown', false)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// getPlanningCostTotal
// ---------------------------------------------------------------------------

describe('getPlanningCostTotal()', () => {
  let db: InstanceType<typeof Database>

  beforeEach(async () => {
    db = await openDb()
    insertSession(db, 'sess-plan')
  })

  afterEach(() => {
    db.close()
  })

  it('returns 0 for a session with no entries', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    expect(await getPlanningCostTotal(adapter, 'sess-plan')).toBe(0)
  })

  it('returns 0 when there are only execution entries', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    insertCostEntryDirect(db, 'sess-plan', { category: 'execution', estimatedCost: 0.01 })
    expect(await getPlanningCostTotal(adapter, 'sess-plan')).toBe(0)
  })

  it('returns the sum of planning entry costs', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    insertCostEntryDirect(db, 'sess-plan', { category: 'planning', estimatedCost: 0.05 })
    insertCostEntryDirect(db, 'sess-plan', { category: 'planning', estimatedCost: 0.03 })
    insertCostEntryDirect(db, 'sess-plan', { category: 'execution', estimatedCost: 0.01 })
    const total = await getPlanningCostTotal(adapter, 'sess-plan')
    expect(total).toBeCloseTo(0.08)
  })
})

// ---------------------------------------------------------------------------
// getSessionCost (legacy)
// ---------------------------------------------------------------------------

describe('getSessionCost() [legacy]', () => {
  let db: InstanceType<typeof Database>

  beforeEach(async () => {
    db = await openDb()
    insertSession(db, 'sess-leg')
  })

  afterEach(() => {
    db.close()
  })

  it('returns zero totals for an empty session', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const result = await getSessionCost(adapter, 'sess-leg')
    expect(result.total_cost).toBe(0)
    expect(result.total_input_tokens).toBe(0)
    expect(result.total_output_tokens).toBe(0)
    expect(result.entry_count).toBe(0)
  })

  it('returns correct aggregated totals', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    insertCostEntryDirect(db, 'sess-leg', { estimatedCost: 0.01, inputTokens: 100, outputTokens: 50 })
    insertCostEntryDirect(db, 'sess-leg', { estimatedCost: 0.02, inputTokens: 200, outputTokens: 80 })
    const result = await getSessionCost(adapter, 'sess-leg')
    expect(result.total_cost).toBeCloseTo(0.03)
    expect(result.total_input_tokens).toBe(300)
    expect(result.total_output_tokens).toBe(130)
    expect(result.entry_count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// getTaskCost (legacy)
// ---------------------------------------------------------------------------

describe('getTaskCost() [legacy]', () => {
  let db: InstanceType<typeof Database>

  beforeEach(async () => {
    db = await openDb()
    insertSession(db, 'sess-tleg')
    insertTask(db, 'sess-tleg', 'task-tleg')
  })

  afterEach(() => {
    db.close()
  })

  it('returns zero totals for a task with no entries', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    const result = await getTaskCost(adapter, 'task-tleg')
    expect(result.total_cost).toBe(0)
    expect(result.total_input_tokens).toBe(0)
    expect(result.total_output_tokens).toBe(0)
    expect(result.entry_count).toBe(0)
  })

  it('returns correct totals for task entries', async () => {
    const adapter = new SyncDatabaseAdapter(db)
    insertCostEntryDirect(db, 'sess-tleg', { taskId: 'task-tleg', estimatedCost: 0.01, inputTokens: 100, outputTokens: 40 })
    const result = await getTaskCost(adapter, 'task-tleg')
    expect(result.total_cost).toBeCloseTo(0.01)
    expect(result.total_input_tokens).toBe(100)
    expect(result.total_output_tokens).toBe(40)
    expect(result.entry_count).toBe(1)
  })
})
