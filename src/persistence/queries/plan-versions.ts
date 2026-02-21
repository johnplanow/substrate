/**
 * Plan version query functions for the SQLite persistence layer.
 *
 * Provides CRUD operations for the plan_versions table.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// PlanVersion type
// ---------------------------------------------------------------------------

export interface PlanVersion {
  plan_id: string
  version: number
  task_graph_yaml: string
  feedback_used: string | null
  planning_cost_usd: number
  created_at: string
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Insert a new plan version record.
 */
export function createPlanVersion(
  db: BetterSqlite3Database,
  pv: Omit<PlanVersion, 'created_at'>,
): void {
  const stmt = db.prepare(`
    INSERT INTO plan_versions (plan_id, version, task_graph_yaml, feedback_used, planning_cost_usd)
    VALUES (?, ?, ?, ?, ?)
  `)
  stmt.run(pv.plan_id, pv.version, pv.task_graph_yaml, pv.feedback_used ?? null, pv.planning_cost_usd)
}

/**
 * Get a specific version of a plan. Returns undefined if not found.
 */
export function getPlanVersion(
  db: BetterSqlite3Database,
  planId: string,
  version: number,
): PlanVersion | undefined {
  const stmt = db.prepare(
    'SELECT * FROM plan_versions WHERE plan_id = ? AND version = ? LIMIT 1',
  )
  return stmt.get(planId, version) as PlanVersion | undefined
}

/**
 * Get full version history for a plan, ordered by version ASC.
 */
export function getPlanVersionHistory(
  db: BetterSqlite3Database,
  planId: string,
): PlanVersion[] {
  const stmt = db.prepare(
    'SELECT * FROM plan_versions WHERE plan_id = ? ORDER BY version ASC',
  )
  return stmt.all(planId) as PlanVersion[]
}

/**
 * Get the latest (highest version number) version for a plan.
 * Returns undefined if no versions exist.
 */
export function getLatestPlanVersion(
  db: BetterSqlite3Database,
  planId: string,
): PlanVersion | undefined {
  const stmt = db.prepare(
    'SELECT * FROM plan_versions WHERE plan_id = ? ORDER BY version DESC LIMIT 1',
  )
  return stmt.get(planId) as PlanVersion | undefined
}
