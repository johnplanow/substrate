/**
 * Migration 002: Cost tracker schema extensions.
 *
 * Extends the cost_entries table from migration 001 with additional columns
 * required for the CostTracker module (Story 4.2):
 *  - provider: identifies the LLM provider (e.g., 'anthropic', 'openai')
 *  - savings_usd: calculated savings when billing_mode = 'subscription'
 *
 * Also adds performance indexes required for AC6 (NFR2: <100ms queries):
 *  - idx_cost_entries_session_task: composite index on (session_id, task_id)
 *  - idx_cost_entries_provider: index on provider
 *  - idx_cost_agent: index on agent for per-agent breakdown queries
 *
 * Uses CREATE INDEX IF NOT EXISTS for idempotency.
 * Uses ALTER TABLE ADD COLUMN IF NOT EXISTS pattern (SQLite 3.37+) — falls back
 * gracefully on older SQLite by catching the "duplicate column" error.
 *
 * WAL journal mode and foreign_keys are set at the connection level by
 * DatabaseWrapper; this migration only modifies schema structure.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { Migration } from './index.js'

export const costTrackerSchemaMigration: Migration = {
  version: 2,
  name: '002-cost-tracker-schema',

  up(db: BetterSqlite3Database): void {
    // Add provider column (if not already present)
    try {
      db.exec(`ALTER TABLE cost_entries ADD COLUMN provider TEXT NOT NULL DEFAULT 'unknown'`)
    } catch {
      // Column already exists — safe to continue (idempotent)
    }

    // Add savings_usd column (if not already present)
    try {
      db.exec(`ALTER TABLE cost_entries ADD COLUMN savings_usd REAL NOT NULL DEFAULT 0.0`)
    } catch {
      // Column already exists — safe to continue (idempotent)
    }

    // Composite index on (session_id, task_id) for AC6 / NFR2
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_cost_entries_session_task ON cost_entries(session_id, task_id)`,
    )

    // Index on provider for provider-level queries
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_cost_entries_provider ON cost_entries(provider)`,
    )

    // Composite index on (session_id, agent) for getAgentCostBreakdown queries
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_cost_session_agent ON cost_entries(session_id, agent)`,
    )

    // Standalone agent index for agent-only queries
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_cost_agent ON cost_entries(agent)`,
    )

    // Ensure the existing indexes match story requirements
    // idx_cost_session covers session_id queries
    // idx_cost_task covers task_id queries
    // Both were already created in migration 001
  },
}
