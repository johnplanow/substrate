/**
 * Cost query functions for the SQLite persistence layer.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Cost types
// ---------------------------------------------------------------------------

export interface CostEntry {
  id?: number
  session_id: string
  task_id?: string | null
  agent: string
  billing_mode: string
  category: string
  input_tokens: number
  output_tokens: number
  estimated_cost: number
  actual_cost?: number | null
  model?: string | null
  timestamp?: string
}

export type CreateCostEntryInput = Omit<CostEntry, 'id' | 'timestamp'> & {
  input_tokens?: number
  output_tokens?: number
  estimated_cost?: number
  category?: string
}

export interface SessionCostSummary {
  total_cost: number
  total_input_tokens: number
  total_output_tokens: number
  entry_count: number
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Insert a new cost entry record.
 */
export function recordCostEntry(db: BetterSqlite3Database, entry: CreateCostEntryInput): void {
  const stmt = db.prepare(`
    INSERT INTO cost_entries (
      session_id, task_id, agent, billing_mode, category,
      input_tokens, output_tokens, estimated_cost, actual_cost, model
    ) VALUES (
      @session_id, @task_id, @agent, @billing_mode, @category,
      @input_tokens, @output_tokens, @estimated_cost, @actual_cost, @model
    )
  `)

  stmt.run({
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost: 0.0,
    category: 'execution',
    task_id: null,
    actual_cost: null,
    model: null,
    ...entry,
  })
}

/**
 * Return aggregated cost totals for a session.
 */
export function getSessionCost(
  db: BetterSqlite3Database,
  sessionId: string,
): SessionCostSummary {
  const stmt = db.prepare(`
    SELECT
      COALESCE(SUM(COALESCE(actual_cost, estimated_cost)), 0) AS total_cost,
      COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COUNT(*) AS entry_count
    FROM cost_entries
    WHERE session_id = ?
  `)
  return stmt.get(sessionId) as SessionCostSummary
}

/**
 * Return aggregated cost totals for a specific task.
 */
export function getTaskCost(
  db: BetterSqlite3Database,
  taskId: string,
): SessionCostSummary {
  const stmt = db.prepare(`
    SELECT
      COALESCE(SUM(COALESCE(actual_cost, estimated_cost)), 0) AS total_cost,
      COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COUNT(*) AS entry_count
    FROM cost_entries
    WHERE task_id = ?
  `)
  return stmt.get(taskId) as SessionCostSummary
}
