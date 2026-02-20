/**
 * Migration 001: Initial schema.
 *
 * Creates the full database schema from Architecture Section 5:
 *  - sessions
 *  - tasks
 *  - task_dependencies
 *  - execution_log
 *  - cost_entries
 *  - All indexes
 *  - Views: ready_tasks, session_cost_summary
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { Migration } from './index.js'

export const initialSchemaMigration: Migration = {
  version: 1,
  name: '001-initial-schema',
  up(db: BetterSqlite3Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                TEXT PRIMARY KEY,
        name              TEXT,
        graph_file        TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'active',
        budget_usd        REAL,
        total_cost_usd    REAL NOT NULL DEFAULT 0.0,
        planning_cost_usd REAL NOT NULL DEFAULT 0.0,
        config_snapshot   TEXT,
        base_branch       TEXT NOT NULL DEFAULT 'main',
        plan_source       TEXT,
        planning_agent    TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES sessions(id),
        name            TEXT NOT NULL,
        description     TEXT,
        prompt          TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        agent           TEXT,
        model           TEXT,
        billing_mode    TEXT,
        worktree_path   TEXT,
        worktree_branch TEXT,
        worker_id       TEXT,
        budget_usd      REAL,
        cost_usd        REAL NOT NULL DEFAULT 0.0,
        input_tokens    INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0,
        result          TEXT,
        error           TEXT,
        exit_code       INTEGER,
        retry_count     INTEGER NOT NULL DEFAULT 0,
        max_retries     INTEGER NOT NULL DEFAULT 2,
        timeout_ms      INTEGER,
        task_type       TEXT,
        metadata        TEXT,
        started_at      TEXT,
        completed_at    TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_agent   ON tasks(agent);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_status ON tasks(session_id, status);

      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id    TEXT NOT NULL REFERENCES tasks(id),
        depends_on TEXT NOT NULL REFERENCES tasks(id),
        PRIMARY KEY (task_id, depends_on),
        CHECK (task_id != depends_on)
      );
      CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON task_dependencies(depends_on);

      CREATE TABLE IF NOT EXISTS execution_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        task_id    TEXT REFERENCES tasks(id),
        event      TEXT NOT NULL,
        old_status TEXT,
        new_status TEXT,
        agent      TEXT,
        cost_usd   REAL,
        data       TEXT,
        timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_log_session   ON execution_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_log_task      ON execution_log(task_id);
      CREATE INDEX IF NOT EXISTS idx_log_event     ON execution_log(event);
      CREATE INDEX IF NOT EXISTS idx_log_timestamp ON execution_log(timestamp);

      CREATE TABLE IF NOT EXISTS cost_entries (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     TEXT NOT NULL REFERENCES sessions(id),
        task_id        TEXT REFERENCES tasks(id),
        agent          TEXT NOT NULL,
        billing_mode   TEXT NOT NULL,
        category       TEXT NOT NULL DEFAULT 'execution',
        input_tokens   INTEGER NOT NULL DEFAULT 0,
        output_tokens  INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0.0,
        actual_cost    REAL,
        model          TEXT,
        timestamp      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_cost_session  ON cost_entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_cost_task     ON cost_entries(task_id);
      CREATE INDEX IF NOT EXISTS idx_cost_category ON cost_entries(category);

      CREATE VIEW IF NOT EXISTS ready_tasks AS
      SELECT t.* FROM tasks t
      WHERE t.status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          JOIN tasks dep ON dep.id = td.depends_on
          WHERE td.task_id = t.id
            AND dep.status NOT IN ('completed', 'cancelled')
        );

      CREATE VIEW IF NOT EXISTS session_cost_summary AS
      SELECT
        s.id   AS session_id,
        s.name AS session_name,
        COUNT(DISTINCT t.id) AS total_tasks,
        SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed_tasks,
        SUM(CASE WHEN t.status = 'failed'   THEN 1 ELSE 0 END) AS failed_tasks,
        SUM(CASE WHEN t.status = 'running'  THEN 1 ELSE 0 END) AS running_tasks,
        COALESCE(SUM(t.cost_usd), 0) AS total_cost_usd,
        SUM(CASE WHEN t.billing_mode = 'subscription' THEN t.cost_usd ELSE 0 END) AS subscription_cost_usd,
        SUM(CASE WHEN t.billing_mode = 'api'          THEN t.cost_usd ELSE 0 END) AS api_cost_usd,
        s.planning_cost_usd
      FROM sessions s
      LEFT JOIN tasks t ON t.session_id = s.id
      GROUP BY s.id;
    `)
  },
}
