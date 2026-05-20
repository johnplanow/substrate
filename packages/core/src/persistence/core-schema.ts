/**
 * Core schema — orchestrator session/task execution model.
 *
 * Owns: sessions, tasks, task_dependencies, execution_log, cost_entries,
 * session_signals, plans, plan_versions, schema_migrations + ready_tasks view
 * + session_cost_summary view.
 *
 * Extracted from `schema.ts` in Ship 5 (2026-05). DDL preserved byte-for-byte
 * from the pre-split version — any column/type/default change must be a
 * deliberate migration, not an accidental drift.
 */

import type { DatabaseAdapter } from './types.js'

/**
 * The base tables owned by this subsystem. Used by the Ship 6 meta-test
 * (test/persistence/schema-ownership.test.ts) to enforce that every table
 * created by `initCoreSchema` is declared here — and no table is owned by
 * more than one subsystem.
 */
export const coreSchemaTables = [
  'sessions',
  'tasks',
  'task_dependencies',
  'execution_log',
  'cost_entries',
  'session_signals',
  'plans',
  'plan_versions',
  'schema_migrations',
] as const

/**
 * Views owned by `initCoreViews`. Same ownership-contract role as `coreSchemaTables`.
 */
export const coreSchemaViews = [
  'ready_tasks',
  'session_cost_summary',
] as const

export async function initCoreSchema(adapter: DatabaseAdapter): Promise<void> {
  // -- Core tables (migration 001 + 003) ------------------------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                VARCHAR(255) PRIMARY KEY,
      name              TEXT,
      graph_file        TEXT NOT NULL,
      status            VARCHAR(32) NOT NULL DEFAULT 'active',
      budget_usd        DOUBLE,
      total_cost_usd    DOUBLE NOT NULL DEFAULT 0.0,
      planning_cost_usd DOUBLE NOT NULL DEFAULT 0.0,
      config_snapshot   TEXT,
      base_branch       TEXT NOT NULL DEFAULT 'main',
      plan_source       TEXT,
      planning_agent    TEXT,
      planning_costs_count_against_budget INTEGER NOT NULL DEFAULT 0,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id              VARCHAR(255) PRIMARY KEY,
      session_id      VARCHAR(255) NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT,
      prompt          TEXT NOT NULL,
      status          VARCHAR(32) NOT NULL DEFAULT 'pending',
      agent           VARCHAR(128),
      model           TEXT,
      billing_mode    VARCHAR(32),
      worktree_path   TEXT,
      worktree_branch TEXT,
      worktree_cleaned_at TEXT,
      worker_id       TEXT,
      budget_usd      DOUBLE,
      cost_usd        DOUBLE NOT NULL DEFAULT 0.0,
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
      merge_status    TEXT,
      merged_files    TEXT,
      conflict_files  TEXT,
      budget_exceeded INTEGER NOT NULL DEFAULT 0,
      started_at      TEXT,
      completed_at    TEXT,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_tasks_session_status ON tasks(session_id, status)')

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id    VARCHAR(255) NOT NULL,
      depends_on VARCHAR(255) NOT NULL,
      PRIMARY KEY (task_id, depends_on),
      CHECK (task_id != depends_on)
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON task_dependencies(depends_on)')

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS execution_log (
      id         INTEGER PRIMARY KEY AUTO_INCREMENT,
      session_id VARCHAR(255) NOT NULL,
      task_id    VARCHAR(255),
      event      VARCHAR(128) NOT NULL,
      old_status VARCHAR(32),
      new_status VARCHAR(32),
      agent      VARCHAR(128),
      cost_usd   DOUBLE,
      data       TEXT,
      timestamp  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_log_session ON execution_log(session_id)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_log_task ON execution_log(task_id)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_log_event ON execution_log(event)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_log_timestamp ON execution_log(timestamp)')

  // -- Cost entries (migration 001 + 002) -----------------------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS cost_entries (
      id             INTEGER PRIMARY KEY AUTO_INCREMENT,
      session_id     VARCHAR(255) NOT NULL,
      task_id        VARCHAR(255),
      agent          VARCHAR(128) NOT NULL,
      billing_mode   VARCHAR(32) NOT NULL,
      category       VARCHAR(64) NOT NULL DEFAULT 'execution',
      provider       VARCHAR(64) NOT NULL DEFAULT 'unknown',
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      estimated_cost DOUBLE NOT NULL DEFAULT 0.0,
      actual_cost    DOUBLE,
      savings_usd    DOUBLE NOT NULL DEFAULT 0.0,
      model          TEXT,
      timestamp      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_cost_session ON cost_entries(session_id)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_cost_task ON cost_entries(task_id)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_cost_category ON cost_entries(category)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_cost_entries_session_task ON cost_entries(session_id, task_id)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_cost_entries_provider ON cost_entries(provider)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_cost_session_agent ON cost_entries(session_id, agent)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_cost_agent ON cost_entries(agent)')

  // -- Session signals (migration 004) --------------------------------------
  // `signal` is a MySQL reserved word — backticks are mandatory in Dolt.
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS session_signals (
      id           INTEGER PRIMARY KEY AUTO_INCREMENT,
      session_id   VARCHAR(255) NOT NULL,
      \`signal\`   VARCHAR(16) NOT NULL CHECK(\`signal\` IN ('pause', 'resume', 'cancel')),
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT
    )
  `)

  // -- Plans (migration 005 + 006) ------------------------------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id                 VARCHAR(255) PRIMARY KEY,
      description        TEXT NOT NULL,
      task_count         INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd DOUBLE NOT NULL DEFAULT 0.0,
      planning_agent     VARCHAR(128) NOT NULL,
      plan_yaml          TEXT NOT NULL,
      status             VARCHAR(32) NOT NULL DEFAULT 'draft',
      current_version    INTEGER NOT NULL DEFAULT 1,
      created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_plans_created ON plans(created_at)')

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS plan_versions (
      plan_id           VARCHAR(255) NOT NULL,
      version           INTEGER NOT NULL,
      task_graph_yaml   TEXT NOT NULL,
      feedback_used     TEXT,
      planning_cost_usd DOUBLE NOT NULL DEFAULT 0.0,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (plan_id, version)
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_plan_versions_plan_id ON plan_versions(plan_id)')

  // -- Schema migration tracking table (for future use) --------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

/**
 * Initialize the views that depend on core tables (`tasks`, `task_dependencies`,
 * `sessions`). Must be called AFTER `initCoreSchema` (defines the tables).
 *
 * NOTE: Views use JOINs/aggregation. Dolt supports them; InMemoryDatabaseAdapter
 * silently no-ops `CREATE VIEW`, so the same DDL works on both backends without
 * a try/catch wrapper.
 */
export async function initCoreViews(adapter: DatabaseAdapter): Promise<void> {
  await adapter.exec(`
    CREATE VIEW IF NOT EXISTS ready_tasks AS
    SELECT t.* FROM tasks t
    WHERE t.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies td
        JOIN tasks dep ON dep.id = td.depends_on
        WHERE td.task_id = t.id
          AND dep.status NOT IN ('completed', 'cancelled')
      )
  `)

  await adapter.exec(`
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
    GROUP BY s.id
  `)
}
