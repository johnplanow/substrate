/**
 * Migration 008: Amendment Schema
 *
 * Extends pipeline_runs and decisions tables to support amendment workflow:
 * - Adds parent_run_id to pipeline_runs (self-referencing FK, nullable)
 * - Updates status CHECK constraint to include 'stopped'
 * - Adds superseded_by to decisions (FK to decisions(id), SET NULL on delete)
 * - Creates indexes for amendment chain queries and active-decision filtering
 *
 * Uses SQLite table-recreation pattern since SQLite does not support ALTER TABLE
 * to modify CHECK constraints or add FK references to existing columns.
 *
 * FK checks are disabled OUTSIDE the transaction during recreation so that
 * dropping pipeline_runs (while decisions still references it) does not raise
 * a FK constraint error.  SQLite silently ignores "PRAGMA foreign_keys = OFF"
 * when issued inside a transaction, so this migration sets
 * managesOwnTransaction = true and wraps only the DDL work in an explicit
 * transaction — with FK enforcement toggled before/after that transaction.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { Migration } from './index.js'

export const migration008AmendmentSchema: Migration = {
  version: 8,
  name: '008-amendment-schema',
  /**
   * This migration must disable FK enforcement before the transaction begins
   * (PRAGMA foreign_keys = OFF is a no-op inside a transaction in SQLite).
   * Setting managesOwnTransaction = true tells the runner to call up() directly
   * instead of wrapping it in db.transaction().  The migration itself wraps the
   * DDL work in an explicit transaction for atomicity.
   */
  managesOwnTransaction: true,
  up(db: BetterSqlite3Database): void {
    // Disable FK enforcement OUTSIDE any transaction so the PRAGMA takes effect.
    // This allows dropping pipeline_runs while decisions still holds a FK to it.
    db.pragma('foreign_keys = OFF')

    try {
      // Wrap all DDL inside an explicit transaction for atomicity.
      db.transaction(() => {
        // -------------------------------------------------------------------
        // Step 1: Recreate pipeline_runs with parent_run_id + 'stopped' status
        // -------------------------------------------------------------------

        // 1a. Clean up any stale temp table from a prior crash
        db.exec(`DROP TABLE IF EXISTS pipeline_runs_new`)

        // 1b. Create new table with updated schema
        db.exec(`
          CREATE TABLE pipeline_runs_new (
            id               TEXT PRIMARY KEY,
            methodology      TEXT NOT NULL,
            current_phase    TEXT,
            status           TEXT NOT NULL DEFAULT 'running'
                               CHECK(status IN ('running','paused','completed','failed','stopped')),
            config_json      TEXT,
            token_usage_json TEXT,
            parent_run_id    TEXT REFERENCES pipeline_runs_new(id) ON DELETE CASCADE,
            created_at       TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `)

        // 1c. Copy data from old table (parent_run_id defaults to NULL)
        db.exec(`
          INSERT INTO pipeline_runs_new
            (id, methodology, current_phase, status, config_json, token_usage_json, parent_run_id, created_at, updated_at)
          SELECT id, methodology, current_phase, status, config_json, token_usage_json, NULL, created_at, updated_at
          FROM pipeline_runs
        `)

        // 1d. Drop old table (FK off so decisions FK to pipeline_runs won't block this)
        db.exec(`DROP TABLE pipeline_runs`)

        // 1e. Rename new table to canonical name
        db.exec(`ALTER TABLE pipeline_runs_new RENAME TO pipeline_runs`)

        // 1f. Recreate indexes on pipeline_runs
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status
            ON pipeline_runs(status);

          CREATE INDEX IF NOT EXISTS idx_pipeline_runs_parent_run_id
            ON pipeline_runs(parent_run_id);
        `)

        // -------------------------------------------------------------------
        // Step 2: Recreate decisions with superseded_by column
        // -------------------------------------------------------------------

        // 2a. Clean up any stale temp table from a prior crash
        db.exec(`DROP TABLE IF EXISTS decisions_new`)

        // 2b. Create new decisions table with superseded_by
        db.exec(`
          CREATE TABLE decisions_new (
            id              TEXT PRIMARY KEY,
            pipeline_run_id TEXT REFERENCES pipeline_runs(id),
            phase           TEXT NOT NULL,
            category        TEXT NOT NULL,
            key             TEXT NOT NULL,
            value           TEXT NOT NULL,
            rationale       TEXT,
            superseded_by   TEXT REFERENCES decisions_new(id) ON DELETE SET NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `)

        // 2c. Copy data from old decisions table (superseded_by defaults to NULL)
        db.exec(`
          INSERT INTO decisions_new
            (id, pipeline_run_id, phase, category, key, value, rationale, superseded_by, created_at, updated_at)
          SELECT id, pipeline_run_id, phase, category, key, value, rationale, NULL, created_at, updated_at
          FROM decisions
        `)

        // 2d. Drop old decisions table
        db.exec(`DROP TABLE decisions`)

        // 2e. Rename new table to canonical name
        db.exec(`ALTER TABLE decisions_new RENAME TO decisions`)

        // 2f. Recreate indexes on decisions
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_decisions_phase
            ON decisions(phase);

          CREATE INDEX IF NOT EXISTS idx_decisions_key
            ON decisions(phase, key);

          CREATE INDEX IF NOT EXISTS idx_decisions_superseded_by
            ON decisions(superseded_by);
        `)
      })()
    } finally {
      // Always re-enable FK enforcement after recreation
      db.pragma('foreign_keys = ON')
    }
  },
}
