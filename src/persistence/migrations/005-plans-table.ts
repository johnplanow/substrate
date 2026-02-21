/**
 * Migration 005: Plans table.
 *
 * Adds the plans table used by the `substrate plan` command to persist
 * generated plan records and track approval/rejection status.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { Migration } from './index.js'

export const migration005PlansTable: Migration = {
  version: 5,
  name: '005-plans-table',
  up(db: BetterSqlite3Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id                 TEXT PRIMARY KEY,
        description        TEXT NOT NULL,
        task_count         INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
        planning_agent     TEXT NOT NULL,
        plan_yaml          TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'draft',
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
      CREATE INDEX IF NOT EXISTS idx_plans_created ON plans(created_at);
    `)
  },
}
