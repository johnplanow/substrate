/**
 * Migration 001: Monitor schema.
 *
 * Creates the dedicated monitor database schema per Architecture section 5 / ADR-011:
 *  - task_metrics: per-task execution metrics
 *  - performance_aggregates: rollup stats per (agent, task_type)
 *  - routing_recommendations: LLM-free routing suggestions (for story 8.6)
 *  - _schema_version: migration versioning table
 *
 * PRAGMAs set at the connection level (WAL, synchronous=NORMAL) by MonitorDatabase.
 *
 * NOTE: This is the monitor-database-specific migration — versioned separately
 * from the main database migration runner in src/persistence/migrations/index.ts.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'

/**
 * Apply the monitor schema to the given database connection.
 * Idempotent — uses CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS.
 */
export function applyMonitorSchema(db: BetterSqlite3Database): void {
  db.exec(`
    -- Migration versioning
    CREATE TABLE IF NOT EXISTS _schema_version (
      version_id  INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Task-level execution metrics (AC1)
    CREATE TABLE IF NOT EXISTS task_metrics (
      task_id        TEXT    NOT NULL,
      agent          TEXT    NOT NULL,
      task_type      TEXT    NOT NULL,
      outcome        TEXT    NOT NULL CHECK(outcome IN ('success', 'failure')),
      failure_reason TEXT,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      duration_ms    INTEGER NOT NULL DEFAULT 0,
      cost           REAL    NOT NULL DEFAULT 0.0,
      estimated_cost REAL    NOT NULL DEFAULT 0.0,
      billing_mode   TEXT    NOT NULL DEFAULT 'api',
      recorded_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, recorded_at)
    );
    CREATE INDEX IF NOT EXISTS idx_tm_agent        ON task_metrics(agent);
    CREATE INDEX IF NOT EXISTS idx_tm_task_type    ON task_metrics(task_type);
    CREATE INDEX IF NOT EXISTS idx_tm_recorded_at  ON task_metrics(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_tm_agent_type   ON task_metrics(agent, task_type);

    -- Aggregate performance stats per (agent, task_type) (for story 8.5)
    CREATE TABLE IF NOT EXISTS performance_aggregates (
      agent              TEXT    NOT NULL,
      task_type          TEXT    NOT NULL,
      total_tasks        INTEGER NOT NULL DEFAULT 0,
      successful_tasks   INTEGER NOT NULL DEFAULT 0,
      failed_tasks       INTEGER NOT NULL DEFAULT 0,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_duration_ms  INTEGER NOT NULL DEFAULT 0,
      total_cost         REAL    NOT NULL DEFAULT 0.0,
      total_retries      INTEGER NOT NULL DEFAULT 0,
      last_updated       TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (agent, task_type)
    );

    -- Routing recommendations (for story 8.6)
    CREATE TABLE IF NOT EXISTS routing_recommendations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type         TEXT    NOT NULL,
      current_agent     TEXT    NOT NULL,
      recommended_agent TEXT    NOT NULL,
      reason            TEXT,
      confidence        REAL    NOT NULL DEFAULT 0.0,
      supporting_data   TEXT,
      generated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at        TEXT
    );
  `)
}
