/**
 * Migration 003: Budget enforcer schema extensions.
 *
 * Adds the planning_costs_count_against_budget column to the sessions table
 * and a budget_exceeded flag to the tasks table for budget enforcement (Story 4.3).
 *
 * Also adds a performance index on (budget_usd) for sessions budget queries.
 *
 * Uses ALTER TABLE ADD COLUMN pattern — falls back gracefully on older SQLite
 * by catching the "duplicate column" error (idempotent).
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { Migration } from './index.js'

export const budgetEnforcerSchemaMigration: Migration = {
  version: 3,
  name: '003-budget-enforcer-schema',

  up(db: BetterSqlite3Database): void {
    // Add planning_costs_count_against_budget to sessions table
    try {
      db.exec(
        `ALTER TABLE sessions ADD COLUMN planning_costs_count_against_budget INTEGER NOT NULL DEFAULT 0`,
      )
    } catch {
      // Column already exists — safe to continue (idempotent)
    }

    // Add budget_exceeded flag to tasks table
    try {
      db.exec(`ALTER TABLE tasks ADD COLUMN budget_exceeded INTEGER NOT NULL DEFAULT 0`)
    } catch {
      // Column already exists — safe to continue (idempotent)
    }

    // Index on sessions.budget_usd for efficient budget cap queries
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_budget ON sessions(budget_usd)`,
    )
  },
}
