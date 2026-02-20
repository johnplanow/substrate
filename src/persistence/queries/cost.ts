/**
 * Cost query functions for the SQLite persistence layer.
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
 */

import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3'
import type {
  CostEntry,
  SessionCostSummary,
  TaskCostSummary,
  AgentCostBreakdown,
} from '../../modules/cost-tracker/types.js'

// ---------------------------------------------------------------------------
// PreparedStatement cache (per DB instance, lazy-init)
// ---------------------------------------------------------------------------

interface StmtCache {
  recordCostEntry?: Statement
  getCostEntryById?: Statement
  incrementTaskCost?: Statement
  getTaskCostSummary?: Statement
  getSessionCostSummaryTotals?: Statement
  getSessionCostSummaryAgents?: Statement
  getAgentCostBreakdown?: Statement
  getAllCostEntriesNoLimit?: Statement
  getAllCostEntriesWithLimit?: Statement
  getSessionCostSummaryFilteredTotals?: Statement
  getSessionCostSummaryFilteredAgents?: Statement
  getSessionCostSummaryUnfilteredTotals?: Statement
  getSessionCostSummaryUnfilteredAgents?: Statement
  getPlanningCostTotal?: Statement
}

const stmtCache = new WeakMap<BetterSqlite3Database, StmtCache>()

function getCache(db: BetterSqlite3Database): StmtCache {
  let cache = stmtCache.get(db)
  if (!cache) {
    cache = {}
    stmtCache.set(db, cache)
  }
  return cache
}

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
 * Uses a cached prepared statement (lazy-init per DB instance) to avoid
 * re-compiling the SQL on every call (NFR22 performance requirement).
 */
export function recordCostEntry(db: BetterSqlite3Database, entry: CreateCostEntryInput): number {
  const cache = getCache(db)
  if (!cache.recordCostEntry) {
    cache.recordCostEntry = db.prepare(`
      INSERT INTO cost_entries (
        session_id, task_id, agent, billing_mode, category,
        input_tokens, output_tokens, estimated_cost, actual_cost, model,
        provider, savings_usd
      ) VALUES (
        @session_id, @task_id, @agent, @billing_mode, @category,
        @input_tokens, @output_tokens, @estimated_cost, @actual_cost, @model,
        @provider, @savings_usd
      )
    `)
  }
  const stmt = cache.recordCostEntry

  const result = stmt.run({
    session_id: entry.session_id,
    task_id: entry.task_id,
    agent: entry.agent,
    billing_mode: entry.billing_mode,
    category: 'execution',
    input_tokens: entry.tokens_input,
    output_tokens: entry.tokens_output,
    estimated_cost: entry.cost_usd,
    actual_cost: null,
    model: entry.model,
    provider: entry.provider,
    savings_usd: entry.savings_usd,
  })

  return Number(result.lastInsertRowid)
}

/**
 * Retrieve a single cost entry by its DB-assigned id.
 *
 * Uses a cached prepared statement (lazy-init per DB instance).
 * Returns null if no row is found for the given id.
 */
export function getCostEntryById(db: BetterSqlite3Database, id: number): CostEntry | null {
  const cache = getCache(db)
  if (!cache.getCostEntryById) {
    cache.getCostEntryById = db.prepare(`SELECT * FROM cost_entries WHERE id = ?`)
  }
  const row = cache.getCostEntryById.get(id) as {
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
  } | undefined

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
 * Uses a cached prepared statement (lazy-init per DB instance).
 */
export function incrementTaskCost(
  db: BetterSqlite3Database,
  taskId: string,
  costDelta: number,
): void {
  const cache = getCache(db)
  if (!cache.incrementTaskCost) {
    cache.incrementTaskCost = db.prepare(`
      UPDATE tasks
      SET cost_usd = cost_usd + @costDelta,
          updated_at = datetime('now')
      WHERE id = @taskId
    `)
  }
  cache.incrementTaskCost.run({ taskId, costDelta })
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
export function getSessionCostSummary(
  db: BetterSqlite3Database,
  sessionId: string,
): SessionCostSummary {
  const cache = getCache(db)

  // Aggregate totals including the earliest recorded_at timestamp
  if (!cache.getSessionCostSummaryTotals) {
    cache.getSessionCostSummaryTotals = db.prepare(`
    SELECT
      COALESCE(SUM(estimated_cost), 0) AS total_cost_usd,
      COALESCE(SUM(CASE WHEN billing_mode = 'subscription' THEN COALESCE(estimated_cost, 0) ELSE 0 END), 0) AS subscription_cost_usd,
      COALESCE(SUM(CASE WHEN billing_mode = 'api' THEN COALESCE(estimated_cost, 0) ELSE 0 END), 0)          AS api_cost_usd,
      COALESCE(SUM(savings_usd), 0)   AS savings_usd,
      COUNT(*)                         AS task_count,
      SUM(CASE WHEN billing_mode = 'subscription' THEN 1 ELSE 0 END) AS subscription_task_count,
      SUM(CASE WHEN billing_mode = 'api' THEN 1 ELSE 0 END)          AS api_task_count,
      MIN(timestamp)                   AS earliest_recorded_at
    FROM cost_entries
    WHERE session_id = @sessionId
  `)
  }
  const totalsRow = cache.getSessionCostSummaryTotals.get({ sessionId }) as {
    total_cost_usd: number
    subscription_cost_usd: number
    api_cost_usd: number
    savings_usd: number
    task_count: number
    subscription_task_count: number
    api_task_count: number
    earliest_recorded_at: string | null
  }

  // Per-agent breakdown
  if (!cache.getSessionCostSummaryAgents) {
    cache.getSessionCostSummaryAgents = db.prepare(`
    SELECT
      agent,
      COUNT(*) AS task_count,
      COALESCE(SUM(estimated_cost), 0) AS cost_usd,
      COALESCE(SUM(savings_usd), 0)    AS savings_usd,
      SUM(CASE WHEN billing_mode = 'subscription' THEN 1 ELSE 0 END) AS subscription_tasks,
      SUM(CASE WHEN billing_mode = 'api' THEN 1 ELSE 0 END)          AS api_tasks
    FROM cost_entries
    WHERE session_id = @sessionId
    GROUP BY agent
    ORDER BY cost_usd DESC
  `)
  }
  const agentRows = cache.getSessionCostSummaryAgents.all({ sessionId }) as {
    agent: string
    task_count: number
    cost_usd: number
    savings_usd: number
    subscription_tasks: number
    api_tasks: number
  }[]

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
export function getSessionCostSummaryFiltered(
  db: BetterSqlite3Database,
  sessionId: string,
  includePlanning: boolean,
): SessionCostSummary {
  const cache = getCache(db)

  // Use separate cached prepared statements for the filtered (no planning) and
  // unfiltered (all categories) variants — avoids re-compiling SQL on every call.
  let totalsRow: {
    total_cost_usd: number
    subscription_cost_usd: number
    api_cost_usd: number
    savings_usd: number
    task_count: number
    subscription_task_count: number
    api_task_count: number
    earliest_recorded_at: string | null
  }

  let agentRows: {
    agent: string
    task_count: number
    cost_usd: number
    savings_usd: number
    subscription_tasks: number
    api_tasks: number
  }[]

  if (!includePlanning) {
    if (!cache.getSessionCostSummaryFilteredTotals) {
      cache.getSessionCostSummaryFilteredTotals = db.prepare(`
        SELECT
          COALESCE(SUM(estimated_cost), 0) AS total_cost_usd,
          COALESCE(SUM(CASE WHEN billing_mode = 'subscription' THEN COALESCE(estimated_cost, 0) ELSE 0 END), 0) AS subscription_cost_usd,
          COALESCE(SUM(CASE WHEN billing_mode = 'api' THEN COALESCE(estimated_cost, 0) ELSE 0 END), 0)          AS api_cost_usd,
          COALESCE(SUM(savings_usd), 0)   AS savings_usd,
          COUNT(*)                         AS task_count,
          SUM(CASE WHEN billing_mode = 'subscription' THEN 1 ELSE 0 END) AS subscription_task_count,
          SUM(CASE WHEN billing_mode = 'api' THEN 1 ELSE 0 END)          AS api_task_count,
          MIN(timestamp)                   AS earliest_recorded_at
        FROM cost_entries
        WHERE session_id = @sessionId AND category != 'planning'
      `)
    }
    if (!cache.getSessionCostSummaryFilteredAgents) {
      cache.getSessionCostSummaryFilteredAgents = db.prepare(`
        SELECT
          agent,
          COUNT(*) AS task_count,
          COALESCE(SUM(estimated_cost), 0) AS cost_usd,
          COALESCE(SUM(savings_usd), 0)    AS savings_usd,
          SUM(CASE WHEN billing_mode = 'subscription' THEN 1 ELSE 0 END) AS subscription_tasks,
          SUM(CASE WHEN billing_mode = 'api' THEN 1 ELSE 0 END)          AS api_tasks
        FROM cost_entries
        WHERE session_id = @sessionId AND category != 'planning'
        GROUP BY agent
        ORDER BY cost_usd DESC
      `)
    }
    totalsRow = cache.getSessionCostSummaryFilteredTotals.get({ sessionId }) as typeof totalsRow
    agentRows = cache.getSessionCostSummaryFilteredAgents.all({ sessionId }) as typeof agentRows
  } else {
    if (!cache.getSessionCostSummaryUnfilteredTotals) {
      cache.getSessionCostSummaryUnfilteredTotals = db.prepare(`
        SELECT
          COALESCE(SUM(estimated_cost), 0) AS total_cost_usd,
          COALESCE(SUM(CASE WHEN billing_mode = 'subscription' THEN COALESCE(estimated_cost, 0) ELSE 0 END), 0) AS subscription_cost_usd,
          COALESCE(SUM(CASE WHEN billing_mode = 'api' THEN COALESCE(estimated_cost, 0) ELSE 0 END), 0)          AS api_cost_usd,
          COALESCE(SUM(savings_usd), 0)   AS savings_usd,
          COUNT(*)                         AS task_count,
          SUM(CASE WHEN billing_mode = 'subscription' THEN 1 ELSE 0 END) AS subscription_task_count,
          SUM(CASE WHEN billing_mode = 'api' THEN 1 ELSE 0 END)          AS api_task_count,
          MIN(timestamp)                   AS earliest_recorded_at
        FROM cost_entries
        WHERE session_id = @sessionId
      `)
    }
    if (!cache.getSessionCostSummaryUnfilteredAgents) {
      cache.getSessionCostSummaryUnfilteredAgents = db.prepare(`
        SELECT
          agent,
          COUNT(*) AS task_count,
          COALESCE(SUM(estimated_cost), 0) AS cost_usd,
          COALESCE(SUM(savings_usd), 0)    AS savings_usd,
          SUM(CASE WHEN billing_mode = 'subscription' THEN 1 ELSE 0 END) AS subscription_tasks,
          SUM(CASE WHEN billing_mode = 'api' THEN 1 ELSE 0 END)          AS api_tasks
        FROM cost_entries
        WHERE session_id = @sessionId
        GROUP BY agent
        ORDER BY cost_usd DESC
      `)
    }
    totalsRow = cache.getSessionCostSummaryUnfilteredTotals.get({ sessionId }) as typeof totalsRow
    agentRows = cache.getSessionCostSummaryUnfilteredAgents.all({ sessionId }) as typeof agentRows
  }

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
export function getTaskCostSummary(
  db: BetterSqlite3Database,
  taskId: string,
): TaskCostSummary {
  const cache = getCache(db)
  if (!cache.getTaskCostSummary) {
    cache.getTaskCostSummary = db.prepare(`
    SELECT
      COALESCE(SUM(estimated_cost), 0) AS cost_usd,
      COALESCE(SUM(input_tokens), 0)   AS tokens_input,
      COALESCE(SUM(output_tokens), 0)  AS tokens_output,
      COALESCE(SUM(savings_usd), 0)    AS savings_usd,
      COUNT(DISTINCT billing_mode)     AS billing_mode_count,
      MAX(billing_mode)                AS last_billing_mode
    FROM cost_entries
    WHERE task_id = @taskId
  `)
  }

  const row = cache.getTaskCostSummary.get({ taskId }) as {
    cost_usd: number
    tokens_input: number
    tokens_output: number
    savings_usd: number
    billing_mode_count: number
    last_billing_mode: string | null
  }

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
export function getAgentCostBreakdown(
  db: BetterSqlite3Database,
  sessionId: string,
  agent: string,
): AgentCostBreakdown {
  const cache = getCache(db)
  if (!cache.getAgentCostBreakdown) {
    cache.getAgentCostBreakdown = db.prepare(`
    SELECT
      COUNT(*) AS task_count,
      COALESCE(SUM(estimated_cost), 0) AS cost_usd,
      COALESCE(SUM(savings_usd), 0)    AS savings_usd,
      SUM(CASE WHEN billing_mode = 'subscription' THEN 1 ELSE 0 END) AS subscription_tasks,
      SUM(CASE WHEN billing_mode = 'api' THEN 1 ELSE 0 END)          AS api_tasks
    FROM cost_entries
    WHERE session_id = @sessionId AND agent = @agent
  `)
  }
  const row = cache.getAgentCostBreakdown.get({ sessionId, agent }) as {
    task_count: number
    cost_usd: number
    savings_usd: number
    subscription_tasks: number
    api_tasks: number
  }

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
export function getAllCostEntries(
  db: BetterSqlite3Database,
  sessionId: string,
  limit?: number,
): CostEntry[] {
  const cache = getCache(db)
  let rows: {
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
  }[]

  if (limit !== undefined) {
    if (!cache.getAllCostEntriesWithLimit) {
      cache.getAllCostEntriesWithLimit = db.prepare(
        `SELECT * FROM cost_entries WHERE session_id = @sessionId ORDER BY timestamp DESC LIMIT @limit`,
      )
    }
    rows = cache.getAllCostEntriesWithLimit.all({ sessionId, limit }) as typeof rows
  } else {
    if (!cache.getAllCostEntriesNoLimit) {
      cache.getAllCostEntriesNoLimit = db.prepare(
        `SELECT * FROM cost_entries WHERE session_id = @sessionId ORDER BY timestamp DESC`,
      )
    }
    rows = cache.getAllCostEntriesNoLimit.all({ sessionId }) as typeof rows
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
export function getAllCostEntriesFiltered(
  db: BetterSqlite3Database,
  sessionId: string,
  includePlanning: boolean,
): CostEntry[] {
  const categoryFilter = includePlanning ? '' : "AND category != 'planning'"

  const rows = db.prepare(`
    SELECT * FROM cost_entries
    WHERE session_id = @sessionId ${categoryFilter}
    ORDER BY timestamp DESC
  `).all({ sessionId }) as {
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
  }[]

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
export function getPlanningCostTotal(
  db: BetterSqlite3Database,
  sessionId: string,
): number {
  const cache = getCache(db)
  if (!cache.getPlanningCostTotal) {
    cache.getPlanningCostTotal = db.prepare(`
      SELECT COALESCE(SUM(estimated_cost), 0) AS planning_cost
      FROM cost_entries
      WHERE session_id = @sessionId AND category = 'planning'
    `)
  }
  const row = cache.getPlanningCostTotal.get({ sessionId }) as { planning_cost: number }
  return row.planning_cost
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
export function getSessionCost(
  db: BetterSqlite3Database,
  sessionId: string,
): { total_cost: number; total_input_tokens: number; total_output_tokens: number; entry_count: number } {
  const stmt = db.prepare(`
    SELECT
      COALESCE(SUM(COALESCE(actual_cost, estimated_cost)), 0) AS total_cost,
      COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COUNT(*) AS entry_count
    FROM cost_entries
    WHERE session_id = ?
  `)
  return stmt.get(sessionId) as {
    total_cost: number
    total_input_tokens: number
    total_output_tokens: number
    entry_count: number
  }
}

/** @deprecated Use getTaskCostSummary instead */
export function getTaskCost(
  db: BetterSqlite3Database,
  taskId: string,
): { total_cost: number; total_input_tokens: number; total_output_tokens: number; entry_count: number } {
  const stmt = db.prepare(`
    SELECT
      COALESCE(SUM(COALESCE(actual_cost, estimated_cost)), 0) AS total_cost,
      COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COUNT(*) AS entry_count
    FROM cost_entries
    WHERE task_id = ?
  `)
  return stmt.get(taskId) as {
    total_cost: number
    total_input_tokens: number
    total_output_tokens: number
    entry_count: number
  }
}
