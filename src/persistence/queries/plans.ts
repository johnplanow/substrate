/**
 * Plan query functions for the SQLite persistence layer.
 *
 * Provides CRUD operations for the plans table.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Plan type
// ---------------------------------------------------------------------------

export interface Plan {
  id: string
  description: string
  task_count: number
  estimated_cost_usd: number
  planning_agent: string
  plan_yaml: string
  status: string
  current_version: number
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Insert a new plan record with status 'draft'.
 */
export function createPlan(
  db: BetterSqlite3Database,
  plan: Omit<Plan, 'created_at' | 'updated_at'>,
): void {
  const stmt = db.prepare(`
    INSERT INTO plans (id, description, task_count, estimated_cost_usd, planning_agent, plan_yaml, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    plan.id,
    plan.description,
    plan.task_count,
    plan.estimated_cost_usd,
    plan.planning_agent,
    plan.plan_yaml,
    plan.status,
  )
}

/**
 * Update a plan's status to 'approved' or 'rejected'.
 */
export function updatePlanStatus(
  db: BetterSqlite3Database,
  planId: string,
  status: 'approved' | 'rejected',
): void {
  const stmt = db.prepare(`
    UPDATE plans SET status = ?, updated_at = datetime('now') WHERE id = ?
  `)
  stmt.run(status, planId)
}

/**
 * List all plans ordered by creation date descending.
 */
export function listPlans(db: BetterSqlite3Database): Plan[] {
  const stmt = db.prepare('SELECT * FROM plans ORDER BY created_at DESC')
  return stmt.all() as Plan[]
}

/**
 * Get a plan by its exact ID. Returns undefined if not found.
 */
export function getPlanById(db: BetterSqlite3Database, planId: string): Plan | undefined {
  const stmt = db.prepare('SELECT * FROM plans WHERE id = ? LIMIT 1')
  return stmt.get(planId) as Plan | undefined
}

/**
 * Alias for getPlanById for consistency with story 7-4 naming.
 */
export function getPlan(db: BetterSqlite3Database, planId: string): Plan | undefined {
  return getPlanById(db, planId)
}

/**
 * Update a plan's status and/or current_version.
 */
export function updatePlan(
  db: BetterSqlite3Database,
  planId: string,
  updates: Partial<Pick<Plan, 'status' | 'current_version'>>,
): void {
  const setClauses: string[] = []
  const values: unknown[] = []

  if (updates.status !== undefined) {
    setClauses.push('status = ?')
    values.push(updates.status)
  }
  if (updates.current_version !== undefined) {
    setClauses.push('current_version = ?')
    values.push(updates.current_version)
  }

  if (setClauses.length === 0) return

  setClauses.push("updated_at = datetime('now')")
  values.push(planId)

  const stmt = db.prepare(`UPDATE plans SET ${setClauses.join(', ')} WHERE id = ?`)
  stmt.run(...values)
}

/**
 * Get a plan by ID prefix (partial match). Returns undefined if not found.
 * When multiple plans match the prefix, returns the most recently created.
 */
export function getPlanByPrefix(db: BetterSqlite3Database, prefix: string): Plan | undefined {
  const stmt = db.prepare(
    "SELECT * FROM plans WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1",
  )
  return stmt.get(prefix + '%') as Plan | undefined
}
