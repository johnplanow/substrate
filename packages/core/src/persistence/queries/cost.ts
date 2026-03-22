/**
 * Cost query functions for the persistence layer.
 *
 * Provides read and write access to the cost_entries table.
 * All queries use indexed columns to meet NFR2 (<100ms response time).
 *
 * Indexes available (from migrations 001 + 002):
 *  - idx_cost_session              : (session_id)
 *  - idx_cost_task                 : (task_id)
 *  - idx_cost_category             : (category)
 *  - idx_cost_entries_session_task  : (session_id, task_id)
 *  - idx_cost_entries_provider      : (provider)
 *  - idx_cost_session_agent         : (session_id, agent)  — getAgentCostBreakdown
 *  - idx_cost_agent                 : (agent)
 *
 * All functions are async and accept a DatabaseAdapter, making them
 * compatible with both the SqliteDatabaseAdapter and DoltDatabaseAdapter.
 * Prepared statement caching has been removed — adapter handles statement
 * lifecycle internally.
 */

import type { DatabaseAdapter } from '../types.js'
import type {
  CostEntry,
  SessionCostSummary,
  TaskCostSummary,
  AgentCostBreakdown,
} from '../cost-types.js'

// ---------------------------------------------------------------------------
// CreateCostEntryInput
// ---------------------------------------------------------------------------

export type CreateCostEntryInput = Omit<CostEntry, 'id' | 'created_at'>

// ---------------------------------------------------------------------------
// Write functions
// ---------------------------------------------------------------------------

/**
 * Insert a new cost entry record.
 *
 * Maps from the CostEntry interface to the cost_entries table schema.
 * Returns the DB-assigned autoincrement id.
 *
 * Uses SELECT MAX(id) instead of last_insert_rowid() / LAST_INSERT_ID()
 * for portability across both SQLite and MySQL/Dolt backends.
 */
export async function recordCostEntry(adapter: DatabaseAdapter, entry: CreateCostEntryInput): Promise<number> {
  await adapter.query(
    `INSERT INTO cost_entries (
      session_id, task_id, agent, billing_mode, category,
      input_tokens, output_tokens, estimated_cost, actual_cost, model,
      provider, savings_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.session_id,
      entry.task_id,
      entry.agent,
      entry.billing_mode,
      'execution',
      entry.tokens_input,
      entry.tokens_output,
      entry.cost_usd,
      null,
      entry.model,
      entry.provider,
      entry.savings_usd,
    ],
  )

  const idRows = await adapter.query<{ id: number }>('SELECT MAX(id) AS id FROM cost_entries')
  return idRows[0]?.id ?? 0
}

/**
 * Retrieve a single cost entry by its DB-assigned id.
 *
 * Returns null if no row is found for the given id.
 */
export async function getCostEntryById(adapter: DatabaseAdapter, id: number): Promise<CostEntry | null> {
  const rows = await adapter.query<{
    id: number
    session_id: string
    task_id: string | null
    agent: string
    billing_mode: string
    input_tokens: number
    output_tokens: number
    estimated_cost: number
    actual_cost: number | null
    model: string | null
    provider: string | null
    savings_usd: number | null
    timestamp: string
  }>('SELECT * FROM cost_entries WHERE id = ?', [id])

  const row = rows[0]
  if (row == null) {
    return null
  }

  return {
    id: row.id,
    session_id: row.session_id,
    task_id: row.task_id,
    agent: row.agent,
    provider: row.provider ?? 'unknown',
    model: row.model ?? 'unknown',
    billing_mode: (row.billing_mode as 'subscription' | 'api') ?? 'api',
    tokens_input: row.input_tokens,
    tokens_output: row.output_tokens,
    cost_usd: row.actual_cost ?? row.estimated_cost,
    savings_usd: row.savings_usd ?? 0,
    created_at: row.timestamp,
  }
}

/**
 * Atomically increment a task's cumulative cost_usd field.
 *
 * Uses a single UPDATE with arithmetic to avoid race conditions.
 */
export async function incrementTaskCost(
  adapter: DatabaseAdapter,
  taskId: string,
  costDelta: number,
): Promise<void> {
  await adapter.query(
    'UPDATE tasks SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?',
    [costDelta, new Date().toISOString(), taskId],
  )
}

// ---------------------------------------------------------------------------
// Read functions (AC6 — all use indexed columns)
// ---------------------------------------------------------------------------

/**
 * Return aggregated cost totals for a session (AC2).
 *
 * Returns a SessionCostSummary with subscription/API breakdown and savings.
 * Uses idx_cost_entries_session_task index.
 */
export async function getSessionCostSummary(
  adapter: DatabaseAdapter,
  sessionId: string,
): Promise<SessionCostSummary> {
  // Aggregate totals including the earliest recorded_at timestamp
  const totalsRows = await adapter.query<{
    total_cost_usd: number
    subscription_cost_usd: number
    api_cost_usd: number
    savings_usd: number
    task_count: number
    subscription_task_count: number
    api_task_count: number
    earliest_recorded_at: string | null
  }>(
    `SELECT
      COALESCE(SUM(estimated_cost), 0) AS total_cost_usd,
      COALESCE(SUM(CASE WHEN billing_mode = 'subscription' THEN COALESCE(estimated_cost, 0) ELSE 0 END), 0) AS subscription_cost_usd,
      COALESCE(SUM(CASE WHEN billing_mode = 'api' THEN COALESCE(estimated_cost, 0) ELSE 0 END), 0)          AS api_cost_usd,
      COALESCE(SUM(savings_usd), 0)   AS savings_usd,
      COUNT(*)                         AS task_count,
      SUM(CASE WHEN billing_mode = 'subscription' THEN 1 ELSE 0 END) AS subscription_task_count,
      SUM(CASE WHEN billing_mode = 'api' THEN 1 ELSE 0 END)          AS api_task_count,
      MIN(timestamp)                   AS earliest_recorded_at
    FROM cost_entries
    WHERE session_id = ?`,
    [sessionId],
  )
  const totalsRow = totalsRows[0]
  if (totalsRow === undefined) throw new Error('getSessionCostSummary: aggregate query returned no rows')

  // Per-agent breakdown
  const agentRows = await adapter.query<{
    agent: string
    task_count: number
    cost_usd: number
    savings_usd: number
    subscription_tasks: number
    api_tasks: number
  }>(
    `SELECT
      agent,
      COUNT(*) AS task_count,
      COALESCE(SUM(estimated_cost), 0) AS cost_usd,
      COALESCE(SUM(savings_usd), 0)    AS savings_usd,
      SUM(CASE WHEN billing_mode = 'subscription' THEN 1 ELSE 0 END) AS subscription_tasks,
      SUM(CASE WHEN billing_mode = 'api' THEN 1 ELSE 0 END)          AS api_tasks
    FROM cost_entries
    WHERE session_id = ?
    GROUP BY agent
    ORDER BY cost_usd DESC`,
    [sessionId],
  )

  const perAgentBreakdown: AgentCostBreakdown[] = agentRows.map((row) => ({
    agent: row.agent,
    task_count: row.task_count,
    cost_usd: row.cost_usd,
    savings_usd: row.savings_usd,
    subscription_tasks: row.subscription_tasks,
    api_tasks: row.api_tasks,
  }))

  const savingsUsd = totalsRow.savings_usd
  const subscriptionTaskCount = totalsRow.subscription_task_count
  const savingsSummary =
    savingsUsd > 0
      ? `Saved ~$${savingsUsd.toFixed(2)} by routing ${subscriptionTaskCount} task${subscriptionTaskCount === 1 ? '' : 's'} through subscriptions vs. equivalent API pricing`
      : 'No subscription savings recorded this session'

  return {
    session_id: sessionId,
    total_cost_usd: totalsRow.total_cost_usd,
    subscription_cost_usd: totalsRow.subscription_cost_usd,
    api_cost_usd: totalsRow.api_cost_usd,
    savings_usd: savingsUsd,
    savingsSummary,
    per_agent_breakdown: perAgentBreakdown,
    task_count: totalsRow.task_count,
    subscription_task_count: subscriptionTaskCount,
    api_task_count: totalsRow.api_task_count,
    created_at: totalsRow.earliest_recorded_at ?? new Date().toISOString(),
  }
}

/**
 * Return aggregated cost totals for a session, optionally excluding planning entries.
 *
 * When includePlanning=false (the default for `substrate cost`), entries with
 * category='planning' are excluded from the summary.
 *
 * This is the variant used by the Cost Report CLI command (story 4.4) to support
 * the --include-planning flag.
 *
 * Uses idx_cost_entries_session_task index.
 */
export async function getSessionCostSummaryFiltered(
  adapter: DatabaseAdapter,
  sessionId: string,
  includePlanning: boolean,
): Promise<SessionCostSummary> {
  const categoryFilter = includePlanning ? '' : "AND category != 'planning'"

  const totalsRows = await adapter.query<{
    total_cost_usd: number
    subscription_cost_usd: number
    api_cost_usd: number
    savings_usd: number
    task_count: number
    subscription_task_count: number
    api_task_count: number
    earliest_recorded_at: string | null
  }>(
    `SELECT
      COALESCE(SUM(estimated_cost), 0) AS total_cost_usd,
      COALESCE(SUM(CASE WHEN billing_mode = 'subscription' THEN COALESCE(estimated_cost, 0) ELSE 0 END), 0) AS subscription_cost_usd,
      COALESCE(SUM(CASE WHEN billing_mode = 'api' THEN COALESCE(estimated_cost, 0) ELSE 0 END), 0)          AS api_cost_usd,
      COALESCE(SUM(savings_usd), 0)   AS savings_usd,
      COUNT(*)                         AS task_count,
      SUM(CASE WHEN billing_mode = 'subscription' THEN 1 ELSE 0 END) AS subscription_task_count,
      SUM(CASE WHEN billing_mode = 'api' THEN 1 ELSE 0 END)          AS api_task_count,
      MIN(timestamp)                   AS earliest_recorded_at
    FROM cost_entries
    WHERE session_id = ? ${categoryFilter}`,
    [sessionId],
  )
  const totalsRow = totalsRows[0]
  if (totalsRow === undefined) throw new Error('getSessionCostSummaryFiltered: aggregate query returned no rows')

  const agentRows = await adapter.query<{
    agent: string
    task_count: number
    cost_usd: number
    savings_usd: number
    subscription_tasks: number
    api_tasks: number
  }>(
    `SELECT
      agent,
      COUNT(*) AS task_count,
      COALESCE(SUM(estimated_cost), 0) AS cost_usd,
      COALESCE(SUM(savings_usd), 0)    AS savings_usd,
      SUM(CASE WHEN billing_mode = 'subscription' THEN 1 ELSE 0 END) AS subscription_tasks,
      SUM(CASE WHEN billing_mode = 'api' THEN 1 ELSE 0 END)          AS api_tasks
    FROM cost_entries
    WHERE session_id = ? ${categoryFilter}
    GROUP BY agent
    ORDER BY cost_usd DESC`,
    [sessionId],
  )

  const perAgentBreakdown: AgentCostBreakdown[] = agentRows.map((row) => ({
    agent: row.agent,
    task_count: row.task_count,
    cost_usd: row.cost_usd,
    savings_usd: row.savings_usd,
    subscription_tasks: row.subscription_tasks,
    api_tasks: row.api_tasks,
  }))

  const savingsUsd = totalsRow.savings_usd
  const subscriptionTaskCount = totalsRow.subscription_task_count
  const savingsSummary =
    savingsUsd > 0
      ? `Saved ~$${savingsUsd.toFixed(2)} by routing ${subscriptionTaskCount} task${subscriptionTaskCount === 1 ? '' : 's'} through subscriptions vs. equivalent API pricing`
      : 'No subscription savings recorded this session'

  return {
    session_id: sessionId,
    total_cost_usd: totalsRow.total_cost_usd,
    subscription_cost_usd: totalsRow.subscription_cost_usd,
    api_cost_usd: totalsRow.api_cost_usd,
    savings_usd: savingsUsd,
    savingsSummary,
    per_agent_breakdown: perAgentBreakdown,
    task_count: totalsRow.task_count,
    subscription_task_count: subscriptionTaskCount,
    api_task_count: totalsRow.api_task_count,
    created_at: totalsRow.earliest_recorded_at ?? new Date().toISOString(),
  }
}

/**
 * Return aggregated cost data for a single task (AC1).
 *
 * Uses idx_cost_task index.
 */
export async function getTaskCostSummary(
  adapter: DatabaseAdapter,
  taskId: string,
): Promise<TaskCostSummary> {
  const rows = await adapter.query<{
    cost_usd: number
    tokens_input: number
    tokens_output: number
    savings_usd: number
    billing_mode_count: number
    last_billing_mode: string | null
  }>(
    `SELECT
      COALESCE(SUM(estimated_cost), 0) AS cost_usd,
      COALESCE(SUM(input_tokens), 0)   AS tokens_input,
      COALESCE(SUM(output_tokens), 0)  AS tokens_output,
      COALESCE(SUM(savings_usd), 0)    AS savings_usd,
      COUNT(DISTINCT billing_mode)     AS billing_mode_count,
      MAX(billing_mode)                AS last_billing_mode
    FROM cost_entries
    WHERE task_id = ?`,
    [taskId],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('getTaskCostSummary: aggregate query returned no rows')

  let billingMode: 'subscription' | 'api' | 'mixed' | null = null
  if (row.billing_mode_count > 1) {
    billingMode = 'mixed'
  } else if (row.last_billing_mode === 'subscription') {
    billingMode = 'subscription'
  } else if (row.last_billing_mode === 'api') {
    billingMode = 'api'
  }

  return {
    task_id: taskId,
    cost_usd: row.cost_usd,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      total: row.tokens_input + row.tokens_output,
    },
    billing_mode: billingMode ?? 'api',
    savings_usd: row.savings_usd,
  }
}

/**
 * Return cost breakdown for a specific agent within a session.
 *
 * Uses idx_cost_session index (session_id filter) + agent filter.
 */
export async function getAgentCostBreakdown(
  adapter: DatabaseAdapter,
  sessionId: string,
  agent: string,
): Promise<AgentCostBreakdown> {
  const rows = await adapter.query<{
    task_count: number
    cost_usd: number
    savings_usd: number
    subscription_tasks: number
    api_tasks: number
  }>(
    `SELECT
      COUNT(*) AS task_count,
      COALESCE(SUM(estimated_cost), 0) AS cost_usd,
      COALESCE(SUM(savings_usd), 0)    AS savings_usd,
      SUM(CASE WHEN billing_mode = 'subscription' THEN 1 ELSE 0 END) AS subscription_tasks,
      SUM(CASE WHEN billing_mode = 'api' THEN 1 ELSE 0 END)          AS api_tasks
    FROM cost_entries
    WHERE session_id = ? AND agent = ?`,
    [sessionId, agent],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('getAgentCostBreakdown: aggregate query returned no rows')

  return {
    agent,
    task_count: row.task_count,
    cost_usd: row.cost_usd,
    savings_usd: row.savings_usd,
    subscription_tasks: row.subscription_tasks,
    api_tasks: row.api_tasks,
  }
}

/**
 * Return all cost entries for a session, ordered by timestamp descending.
 *
 * Supports optional pagination via limit.
 * Uses idx_cost_entries_session_task index.
 */
export async function getAllCostEntries(
  adapter: DatabaseAdapter,
  sessionId: string,
  limit?: number,
): Promise<CostEntry[]> {
  type RawRow = {
    id: number
    session_id: string
    task_id: string | null
    agent: string
    billing_mode: string
    category: string
    input_tokens: number
    output_tokens: number
    estimated_cost: number
    actual_cost: number | null
    model: string | null
    provider: string | null
    savings_usd: number | null
    timestamp: string
  }

  let rows: RawRow[]

  if (limit !== undefined) {
    rows = await adapter.query<RawRow>(
      'SELECT * FROM cost_entries WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?',
      [sessionId, limit],
    )
  } else {
    rows = await adapter.query<RawRow>(
      'SELECT * FROM cost_entries WHERE session_id = ? ORDER BY timestamp DESC',
      [sessionId],
    )
  }

  return rows.map((row) => ({
    id: row.id,
    session_id: row.session_id,
    task_id: row.task_id,
    agent: row.agent,
    provider: row.provider ?? 'unknown',
    model: row.model ?? 'unknown',
    billing_mode: (row.billing_mode as 'subscription' | 'api') ?? 'api',
    tokens_input: row.input_tokens,
    tokens_output: row.output_tokens,
    cost_usd: row.actual_cost ?? row.estimated_cost,
    savings_usd: row.savings_usd ?? 0,
    created_at: row.timestamp,
  }))
}

/**
 * Return all cost entries for a session, optionally excluding planning entries.
 *
 * When `includePlanning` is false, entries with `category = 'planning'` are
 * excluded from the result set. This supports the `--include-planning` flag
 * in the Cost Report CLI command (story 4.4).
 *
 * Uses idx_cost_entries_session_task index.
 */
export async function getAllCostEntriesFiltered(
  adapter: DatabaseAdapter,
  sessionId: string,
  includePlanning: boolean,
): Promise<CostEntry[]> {
  const categoryFilter = includePlanning ? '' : "AND category != 'planning'"

  const rows = await adapter.query<{
    id: number
    session_id: string
    task_id: string | null
    agent: string
    billing_mode: string
    category: string
    input_tokens: number
    output_tokens: number
    estimated_cost: number
    actual_cost: number | null
    model: string | null
    provider: string | null
    savings_usd: number | null
    timestamp: string
  }>(
    `SELECT * FROM cost_entries
    WHERE session_id = ? ${categoryFilter}
    ORDER BY timestamp DESC`,
    [sessionId],
  )

  return rows.map((row) => ({
    id: row.id,
    session_id: row.session_id,
    task_id: row.task_id,
    agent: row.agent,
    provider: row.provider ?? 'unknown',
    model: row.model ?? 'unknown',
    billing_mode: (row.billing_mode as 'subscription' | 'api') ?? 'api',
    tokens_input: row.input_tokens,
    tokens_output: row.output_tokens,
    cost_usd: row.actual_cost ?? row.estimated_cost,
    savings_usd: row.savings_usd ?? 0,
    created_at: row.timestamp,
  }))
}

/**
 * Return the total cost of planning entries for a session.
 *
 * Used by the Cost Report CLI command to show excluded planning costs
 * without requiring a second full summary query.
 *
 * Uses idx_cost_category index.
 */
export async function getPlanningCostTotal(
  adapter: DatabaseAdapter,
  sessionId: string,
): Promise<number> {
  const rows = await adapter.query<{ planning_cost: number }>(
    `SELECT COALESCE(SUM(estimated_cost), 0) AS planning_cost
    FROM cost_entries
    WHERE session_id = ? AND category = 'planning'`,
    [sessionId],
  )
  return rows[0]?.planning_cost ?? 0
}

// ---------------------------------------------------------------------------
// Legacy compatibility — kept for existing callers from Epic 2
// ---------------------------------------------------------------------------

/** @deprecated Use recordCostEntry instead */
export type LegacyCostEntryInput = {
  session_id: string
  task_id?: string | null
  agent: string
  billing_mode: string
  category?: string
  input_tokens?: number
  output_tokens?: number
  estimated_cost?: number
  actual_cost?: number | null
  model?: string | null
}

/** @deprecated Use getSessionCostSummary instead */
export async function getSessionCost(
  adapter: DatabaseAdapter,
  sessionId: string,
): Promise<{ total_cost: number; total_input_tokens: number; total_output_tokens: number; entry_count: number }> {
  const rows = await adapter.query<{
    total_cost: number
    total_input_tokens: number
    total_output_tokens: number
    entry_count: number
  }>(
    `SELECT
      COALESCE(SUM(COALESCE(actual_cost, estimated_cost)), 0) AS total_cost,
      COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COUNT(*) AS entry_count
    FROM cost_entries
    WHERE session_id = ?`,
    [sessionId],
  )
  const sessionRow = rows[0]
  if (sessionRow === undefined) throw new Error('getSessionCost: aggregate query returned no rows')
  return sessionRow
}

/** @deprecated Use getTaskCostSummary instead */
export async function getTaskCost(
  adapter: DatabaseAdapter,
  taskId: string,
): Promise<{ total_cost: number; total_input_tokens: number; total_output_tokens: number; entry_count: number }> {
  const rows = await adapter.query<{
    total_cost: number
    total_input_tokens: number
    total_output_tokens: number
    entry_count: number
  }>(
    `SELECT
      COALESCE(SUM(COALESCE(actual_cost, estimated_cost)), 0) AS total_cost,
      COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COUNT(*) AS entry_count
    FROM cost_entries
    WHERE task_id = ?`,
    [taskId],
  )
  const taskRow = rows[0]
  if (taskRow === undefined) throw new Error('getTaskCost: aggregate query returned no rows')
  return taskRow
}
