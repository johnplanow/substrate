/**
 * Unit tests for src/persistence/queries/cost.ts
 *
 * Uses in-memory SQLite database seeded with all migrations.
 * All test functions use InMemoryDatabaseAdapter, satisfying AC3 and AC6.
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
import { InMemoryDatabaseAdapter } from '../../memory-adapter.js'
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
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return adapter
}

/** Insert a session row (required FK for cost_entries.session_id). */
function insertSession(adapter: InMemoryDatabaseAdapter, id: string): void {
  adapter.querySync(
    `INSERT INTO sessions (id, graph_file, status, created_at, updated_at)
     VALUES (?, 'test.json', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id],
  )
}

/** Insert a task row (required FK when cost_entries.task_id is non-null). */
function insertTask(adapter: InMemoryDatabaseAdapter, sessionId: string, taskId: string): void {
  adapter.querySync(
    `INSERT INTO tasks (id, session_id, name, prompt, status, cost_usd, created_at, updated_at)
     VALUES (?, ?, 'test-task', 'test-prompt', 'completed', 0.0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [taskId, sessionId],
  )
}

/**
 * Insert a cost_entries row directly via raw SQL.
 * Used for test setup that needs to control the category field (e.g. planning)
 * or set values that are not exposed through recordCostEntry.
 */
function insertCostEntryDirect(
  adapter: InMemoryDatabaseAdapter,
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
  adapter.querySync(
    `INSERT INTO cost_entries
       (session_id, task_id, agent, billing_mode, category,
        input_tokens, output_tokens, estimated_cost, model, provider, savings_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, taskId, agent, billingMode, category, inputTokens, outputTokens, estimatedCost, model, provider, savingsUsd],
  )
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
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    insertSession(adapter, 'sess-rec')
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('AC1/AC2: accepts InMemoryDatabaseAdapter and returns a Promise<number>', async () => {
    const id = await recordCostEntry(adapter, makeEntry('sess-rec'))
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)
  })

  it('returns a positive integer ID for the inserted row', async () => {
    const id = await recordCostEntry(adapter, makeEntry('sess-rec'))
    expect(Number.isInteger(id)).toBe(true)
    expect(id).toBeGreaterThan(0)
  })

  it('returns incrementing IDs for subsequent inserts', async () => {
    const id1 = await recordCostEntry(adapter, makeEntry('sess-rec'))
    const id2 = await recordCostEntry(adapter, makeEntry('sess-rec'))
    expect(id2).toBeGreaterThan(id1)
  })

  it('inserted row is retrievable via getCostEntryById', async () => {
    const id = await recordCostEntry(adapter, makeEntry('sess-rec', { agent: 'my-agent', cost_usd: 0.042 }))
    const fetched = await getCostEntryById(adapter, id)
    expect(fetched).not.toBeNull()
    expect(fetched?.agent).toBe('my-agent')
    expect(fetched?.cost_usd).toBeCloseTo(0.042)
  })

  it('stores category as execution (hardcoded value)', async () => {
    const id = await recordCostEntry(adapter, makeEntry('sess-rec'))
    const row = adapter.querySync<{ category: string }>('SELECT category FROM cost_entries WHERE id = ?', [id])[0]
    expect(row?.category).toBe('execution')
  })
})

// ---------------------------------------------------------------------------
// getCostEntryById
// ---------------------------------------------------------------------------

describe('getCostEntryById()', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    insertSession(adapter, 'sess-get')
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns null for a nonexistent id', async () => {
    expect(await getCostEntryById(adapter, 999999)).toBeNull()
  })

  it('returns a correctly mapped CostEntry with all fields', async () => {
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
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    insertSession(adapter, 'sess-inc')
    insertTask(adapter, 'sess-inc', 'task-inc')
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('increments task cost_usd by the given delta', async () => {
    await incrementTaskCost(adapter, 'task-inc', 0.05)
    const row = adapter.querySync<{ cost_usd: number }>('SELECT cost_usd FROM tasks WHERE id = ?', ['task-inc'])[0]
    expect(row?.cost_usd).toBeCloseTo(0.05)
  })

  it('accumulates multiple increments correctly', async () => {
    await incrementTaskCost(adapter, 'task-inc', 0.01)
    await incrementTaskCost(adapter, 'task-inc', 0.02)
    await incrementTaskCost(adapter, 'task-inc', 0.03)
    const row = adapter.querySync<{ cost_usd: number }>('SELECT cost_usd FROM tasks WHERE id = ?', ['task-inc'])[0]
    expect(row?.cost_usd).toBeCloseTo(0.06)
  })
})

// ---------------------------------------------------------------------------
// getSessionCostSummary
// ---------------------------------------------------------------------------

describe('getSessionCostSummary()', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    insertSession(adapter, 'sess-sum')
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns zero totals for a session with no cost entries', async () => {
    const summary = await getSessionCostSummary(adapter, 'sess-sum')
    expect(summary.total_cost_usd).toBe(0)
    expect(summary.subscription_cost_usd).toBe(0)
    expect(summary.api_cost_usd).toBe(0)
    expect(summary.savings_usd).toBe(0)
    expect(summary.task_count).toBe(0)
    expect(summary.per_agent_breakdown).toEqual([])
  })

  it('returns correct totals for api billing entries', async () => {
    insertCostEntryDirect(adapter, 'sess-sum', { billingMode: 'api', estimatedCost: 0.01 })
    insertCostEntryDirect(adapter, 'sess-sum', { billingMode: 'api', estimatedCost: 0.02 })
    const summary = await getSessionCostSummary(adapter, 'sess-sum')
    expect(summary.total_cost_usd).toBeCloseTo(0.03)
    expect(summary.api_cost_usd).toBeCloseTo(0.03)
    expect(summary.subscription_cost_usd).toBe(0)
    expect(summary.task_count).toBe(2)
  })

  it('separates subscription and api costs correctly', async () => {
    insertCostEntryDirect(adapter, 'sess-sum', { billingMode: 'api', estimatedCost: 0.01 })
    insertCostEntryDirect(adapter, 'sess-sum', { billingMode: 'subscription', estimatedCost: 0.02, savingsUsd: 0.02 })
    const summary = await getSessionCostSummary(adapter, 'sess-sum')
    expect(summary.api_cost_usd).toBeCloseTo(0.01)
    expect(summary.subscription_cost_usd).toBeCloseTo(0.02)
    expect(summary.subscription_task_count).toBe(1)
    expect(summary.api_task_count).toBe(1)
    expect(summary.savings_usd).toBeCloseTo(0.02)
  })

  it('populates per_agent_breakdown with agent totals', async () => {
    insertCostEntryDirect(adapter, 'sess-sum', { agent: 'agent-a', estimatedCost: 0.01 })
    insertCostEntryDirect(adapter, 'sess-sum', { agent: 'agent-b', estimatedCost: 0.02 })
    const summary = await getSessionCostSummary(adapter, 'sess-sum')
    const agents = summary.per_agent_breakdown.map((b) => b.agent)
    expect(agents).toContain('agent-a')
    expect(agents).toContain('agent-b')
    expect(summary.per_agent_breakdown).toHaveLength(2)
  })

  it('returns a savingsSummary string', async () => {
    const summary = await getSessionCostSummary(adapter, 'sess-sum')
    expect(typeof summary.savingsSummary).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// getSessionCostSummaryFiltered
// ---------------------------------------------------------------------------

describe('getSessionCostSummaryFiltered()', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    insertSession(adapter, 'sess-filt')
    insertCostEntryDirect(adapter, 'sess-filt', { category: 'execution', estimatedCost: 0.01 })
    insertCostEntryDirect(adapter, 'sess-filt', { category: 'planning', estimatedCost: 0.05 })
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('excludes planning entries when includePlanning=false', async () => {
    const summary = await getSessionCostSummaryFiltered(adapter, 'sess-filt', false)
    expect(summary.total_cost_usd).toBeCloseTo(0.01)
    expect(summary.task_count).toBe(1)
  })

  it('includes all entries when includePlanning=true', async () => {
    const summary = await getSessionCostSummaryFiltered(adapter, 'sess-filt', true)
    expect(summary.total_cost_usd).toBeCloseTo(0.06)
    expect(summary.task_count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// getTaskCostSummary
// ---------------------------------------------------------------------------

describe('getTaskCostSummary()', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    insertSession(adapter, 'sess-task')
    insertTask(adapter, 'sess-task', 'task-t1')
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns zero cost and tokens for a task with no entries', async () => {
    const summary = await getTaskCostSummary(adapter, 'task-t1')
    expect(summary.cost_usd).toBe(0)
    expect(summary.tokens.input).toBe(0)
    expect(summary.tokens.output).toBe(0)
    expect(summary.tokens.total).toBe(0)
  })

  it('aggregates tokens and cost across multiple entries', async () => {
    insertCostEntryDirect(adapter, 'sess-task', { taskId: 'task-t1', inputTokens: 100, outputTokens: 50, estimatedCost: 0.01 })
    insertCostEntryDirect(adapter, 'sess-task', { taskId: 'task-t1', inputTokens: 200, outputTokens: 100, estimatedCost: 0.02 })
    const summary = await getTaskCostSummary(adapter, 'task-t1')
    expect(summary.tokens.input).toBe(300)
    expect(summary.tokens.output).toBe(150)
    expect(summary.tokens.total).toBe(450)
    expect(summary.cost_usd).toBeCloseTo(0.03)
  })

  it('returns billing_mode=mixed for entries with both api and subscription', async () => {
    insertCostEntryDirect(adapter, 'sess-task', { taskId: 'task-t1', billingMode: 'api' })
    insertCostEntryDirect(adapter, 'sess-task', { taskId: 'task-t1', billingMode: 'subscription' })
    const summary = await getTaskCostSummary(adapter, 'task-t1')
    expect(summary.billing_mode).toBe('mixed')
  })

  it('returns billing_mode=subscription for all-subscription entries', async () => {
    insertCostEntryDirect(adapter, 'sess-task', { taskId: 'task-t1', billingMode: 'subscription' })
    const summary = await getTaskCostSummary(adapter, 'task-t1')
    expect(summary.billing_mode).toBe('subscription')
  })

  it('returns billing_mode=api for all-api entries', async () => {
    insertCostEntryDirect(adapter, 'sess-task', { taskId: 'task-t1', billingMode: 'api' })
    const summary = await getTaskCostSummary(adapter, 'task-t1')
    expect(summary.billing_mode).toBe('api')
  })
})

// ---------------------------------------------------------------------------
// getAgentCostBreakdown
// ---------------------------------------------------------------------------

describe('getAgentCostBreakdown()', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    insertSession(adapter, 'sess-agt')
    insertCostEntryDirect(adapter, 'sess-agt', { agent: 'agt-x', billingMode: 'api', estimatedCost: 0.01 })
    insertCostEntryDirect(adapter, 'sess-agt', { agent: 'agt-x', billingMode: 'subscription', estimatedCost: 0.02, savingsUsd: 0.02 })
    insertCostEntryDirect(adapter, 'sess-agt', { agent: 'agt-y', estimatedCost: 0.05 })
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns correct task_count for the requested agent', async () => {
    const breakdown = await getAgentCostBreakdown(adapter, 'sess-agt', 'agt-x')
    expect(breakdown.task_count).toBe(2)
  })

  it('returns correct cost_usd for the requested agent', async () => {
    const breakdown = await getAgentCostBreakdown(adapter, 'sess-agt', 'agt-x')
    expect(breakdown.cost_usd).toBeCloseTo(0.03)
  })

  it('separates subscription_tasks and api_tasks counts correctly', async () => {
    const breakdown = await getAgentCostBreakdown(adapter, 'sess-agt', 'agt-x')
    expect(breakdown.subscription_tasks).toBe(1)
    expect(breakdown.api_tasks).toBe(1)
  })

  it('does not include entries from other agents in the session', async () => {
    const breakdown = await getAgentCostBreakdown(adapter, 'sess-agt', 'agt-x')
    // agt-y has a separate entry; agt-x total should still be 2
    expect(breakdown.task_count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// getAllCostEntries
// ---------------------------------------------------------------------------

describe('getAllCostEntries()', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    insertSession(adapter, 'sess-all')
    insertCostEntryDirect(adapter, 'sess-all', { estimatedCost: 0.01 })
    insertCostEntryDirect(adapter, 'sess-all', { estimatedCost: 0.02 })
    insertCostEntryDirect(adapter, 'sess-all', { estimatedCost: 0.03 })
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns all entries for the session', async () => {
    const entries = await getAllCostEntries(adapter, 'sess-all')
    expect(entries).toHaveLength(3)
  })

  it('respects the limit parameter', async () => {
    const entries = await getAllCostEntries(adapter, 'sess-all', 2)
    expect(entries).toHaveLength(2)
  })

  it('returns empty array for an unknown session', async () => {
    expect(await getAllCostEntries(adapter, 'unknown-session')).toHaveLength(0)
  })

  it('maps DB columns to CostEntry fields', async () => {
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
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    insertSession(adapter, 'sess-ef')
    insertCostEntryDirect(adapter, 'sess-ef', { category: 'execution', estimatedCost: 0.01 })
    insertCostEntryDirect(adapter, 'sess-ef', { category: 'planning', estimatedCost: 0.05 })
    insertCostEntryDirect(adapter, 'sess-ef', { category: 'execution', estimatedCost: 0.02 })
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('excludes planning entries when includePlanning=false', async () => {
    const entries = await getAllCostEntriesFiltered(adapter, 'sess-ef', false)
    expect(entries).toHaveLength(2)
  })

  it('includes all entries (including planning) when includePlanning=true', async () => {
    const entries = await getAllCostEntriesFiltered(adapter, 'sess-ef', true)
    expect(entries).toHaveLength(3)
  })

  it('returns empty array for an unknown session', async () => {
    expect(await getAllCostEntriesFiltered(adapter, 'unknown', false)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// getPlanningCostTotal
// ---------------------------------------------------------------------------

describe('getPlanningCostTotal()', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    insertSession(adapter, 'sess-plan')
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns 0 for a session with no entries', async () => {
    expect(await getPlanningCostTotal(adapter, 'sess-plan')).toBe(0)
  })

  it('returns 0 when there are only execution entries', async () => {
    insertCostEntryDirect(adapter, 'sess-plan', { category: 'execution', estimatedCost: 0.01 })
    expect(await getPlanningCostTotal(adapter, 'sess-plan')).toBe(0)
  })

  it('returns the sum of planning entry costs', async () => {
    insertCostEntryDirect(adapter, 'sess-plan', { category: 'planning', estimatedCost: 0.05 })
    insertCostEntryDirect(adapter, 'sess-plan', { category: 'planning', estimatedCost: 0.03 })
    insertCostEntryDirect(adapter, 'sess-plan', { category: 'execution', estimatedCost: 0.01 })
    const total = await getPlanningCostTotal(adapter, 'sess-plan')
    expect(total).toBeCloseTo(0.08)
  })
})

// ---------------------------------------------------------------------------
// getSessionCost (legacy)
// ---------------------------------------------------------------------------

describe('getSessionCost() [legacy]', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    insertSession(adapter, 'sess-leg')
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns zero totals for an empty session', async () => {
    const result = await getSessionCost(adapter, 'sess-leg')
    expect(result.total_cost).toBe(0)
    expect(result.total_input_tokens).toBe(0)
    expect(result.total_output_tokens).toBe(0)
    expect(result.entry_count).toBe(0)
  })

  it('returns correct aggregated totals', async () => {
    insertCostEntryDirect(adapter, 'sess-leg', { estimatedCost: 0.01, inputTokens: 100, outputTokens: 50 })
    insertCostEntryDirect(adapter, 'sess-leg', { estimatedCost: 0.02, inputTokens: 200, outputTokens: 80 })
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
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    insertSession(adapter, 'sess-tleg')
    insertTask(adapter, 'sess-tleg', 'task-tleg')
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns zero totals for a task with no entries', async () => {
    const result = await getTaskCost(adapter, 'task-tleg')
    expect(result.total_cost).toBe(0)
    expect(result.total_input_tokens).toBe(0)
    expect(result.total_output_tokens).toBe(0)
    expect(result.entry_count).toBe(0)
  })

  it('returns correct totals for task entries', async () => {
    insertCostEntryDirect(adapter, 'sess-tleg', { taskId: 'task-tleg', estimatedCost: 0.01, inputTokens: 100, outputTokens: 40 })
    const result = await getTaskCost(adapter, 'task-tleg')
    expect(result.total_cost).toBeCloseTo(0.01)
    expect(result.total_input_tokens).toBe(100)
    expect(result.total_output_tokens).toBe(40)
    expect(result.entry_count).toBe(1)
  })
})
