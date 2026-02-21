/**
 * Migration 006: Plan versions table.
 *
 * Adds the plan_versions table and adds current_version column to the plans table,
 * supporting iterative plan refinement with full version history.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { Migration } from './index.js'

export const migration006PlanVersions: Migration = {
  version: 6,
  name: '006-plan-versions',
  up(db: BetterSqlite3Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plan_versions (
        plan_id           TEXT NOT NULL REFERENCES plans(id),
        version           INTEGER NOT NULL,
        task_graph_yaml   TEXT NOT NULL,
        feedback_used     TEXT,
        planning_cost_usd REAL NOT NULL DEFAULT 0.0,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (plan_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_plan_versions_plan_id ON plan_versions(plan_id);
    `)

    // Add current_version column to plans if it doesn't exist
    // SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN, so we check first
    const cols = db.prepare("PRAGMA table_info(plans)").all() as { name: string }[]
    const hasCurrentVersion = cols.some((c) => c.name === 'current_version')
    if (!hasCurrentVersion) {
      db.exec(`ALTER TABLE plans ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1`)
    }
  },
}
