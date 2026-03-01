/**
 * Migration 010: Run metrics and story metrics tables.
 *
 * Creates tables for tracking pipeline run performance metrics
 * and per-story execution metrics (Story 17-2).
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { Migration } from './index.js'

export const migration010RunMetrics: Migration = {
  version: 10,
  name: 'run-metrics',
  up(db: BetterSqlite3Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS run_metrics (
        run_id              TEXT PRIMARY KEY,
        methodology         TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'running',
        started_at          TEXT NOT NULL,
        completed_at        TEXT,
        wall_clock_seconds  REAL DEFAULT 0,
        total_input_tokens  INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        total_cost_usd      REAL DEFAULT 0,
        stories_attempted   INTEGER DEFAULT 0,
        stories_succeeded   INTEGER DEFAULT 0,
        stories_failed      INTEGER DEFAULT 0,
        stories_escalated   INTEGER DEFAULT 0,
        total_review_cycles INTEGER DEFAULT 0,
        total_dispatches    INTEGER DEFAULT 0,
        concurrency_setting INTEGER DEFAULT 1,
        max_concurrent_actual INTEGER DEFAULT 1,
        restarts            INTEGER DEFAULT 0,
        is_baseline         INTEGER DEFAULT 0,
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS story_metrics (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id              TEXT NOT NULL,
        story_key           TEXT NOT NULL,
        result              TEXT NOT NULL DEFAULT 'pending',
        phase_durations_json TEXT,
        started_at          TEXT,
        completed_at        TEXT,
        wall_clock_seconds  REAL DEFAULT 0,
        input_tokens        INTEGER DEFAULT 0,
        output_tokens       INTEGER DEFAULT 0,
        cost_usd            REAL DEFAULT 0,
        review_cycles       INTEGER DEFAULT 0,
        dispatches          INTEGER DEFAULT 0,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(run_id, story_key)
      )
    `)
  },
}
