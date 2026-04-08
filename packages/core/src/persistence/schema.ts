/**
 * Consolidated schema DDL for all persistence tables.
 *
 * Replaces the 11 separate SQLite migration files with a single
 * async function that creates all tables via DatabaseAdapter.
 *
 * All tables use CREATE TABLE IF NOT EXISTS for idempotency.
 * Indexes and views use IF NOT EXISTS.
 *
 * Schema covers:
 *   - Core: sessions, tasks, task_dependencies, execution_log
 *   - Cost: cost_entries
 *   - Pipeline: pipeline_runs, decisions, requirements, constraints, artifacts, token_usage
 *   - Plans: plans, plan_versions
 *   - Signals: session_signals
 *   - Metrics: run_metrics, story_metrics
 *   - Monitor: task_metrics, performance_aggregates, routing_recommendations
 *   - Telemetry: turn_analysis, efficiency_scores, recommendations, category_stats, consumer_stats
 */

import type { DatabaseAdapter } from './types.js'

/**
 * Initialize all persistence tables on the given adapter.
 * Idempotent — safe to call multiple times.
 */
export async function initSchema(adapter: DatabaseAdapter): Promise<void> {
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

  // -- Pipeline runs + decisions (migration 007 + 008 final shapes) ---------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id               VARCHAR(255) PRIMARY KEY,
      methodology      VARCHAR(128) NOT NULL,
      current_phase    VARCHAR(64),
      status           VARCHAR(32) NOT NULL DEFAULT 'running'
                       CHECK(status IN ('running','paused','completed','failed','stopped')),
      config_json      TEXT,
      token_usage_json TEXT,
      parent_run_id    VARCHAR(255),
      created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_pipeline_runs_parent_run_id ON pipeline_runs(parent_run_id)')

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id              VARCHAR(255) PRIMARY KEY,
      pipeline_run_id VARCHAR(255),
      phase           VARCHAR(64) NOT NULL,
      category        VARCHAR(64) NOT NULL,
      \`key\`         VARCHAR(255) NOT NULL,
      value           TEXT NOT NULL,
      rationale       TEXT,
      superseded_by   VARCHAR(255),
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_decisions_phase ON decisions(phase)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_decisions_key ON decisions(phase, `key`)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_decisions_superseded_by ON decisions(superseded_by)')

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS requirements (
      id              VARCHAR(255) PRIMARY KEY,
      pipeline_run_id VARCHAR(255),
      source          VARCHAR(128) NOT NULL,
      type            VARCHAR(32) NOT NULL CHECK(type IN ('functional','non_functional','constraint')),
      description     TEXT NOT NULL,
      priority        VARCHAR(16) NOT NULL CHECK(priority IN ('must','should','could','wont')),
      status          VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_requirements_type ON requirements(type)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements(status)')

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS constraints (
      id              VARCHAR(255) PRIMARY KEY,
      pipeline_run_id VARCHAR(255),
      category        VARCHAR(64) NOT NULL,
      description     TEXT NOT NULL,
      source          VARCHAR(128) NOT NULL,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id              VARCHAR(255) PRIMARY KEY,
      pipeline_run_id VARCHAR(255),
      phase           VARCHAR(64) NOT NULL,
      type            VARCHAR(128) NOT NULL,
      path            TEXT NOT NULL,
      content_hash    TEXT,
      summary         TEXT,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_artifacts_phase ON artifacts(phase)')

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id              INTEGER PRIMARY KEY AUTO_INCREMENT,
      pipeline_run_id VARCHAR(255),
      phase           VARCHAR(64) NOT NULL,
      agent           VARCHAR(128) NOT NULL,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      cost_usd        DOUBLE NOT NULL DEFAULT 0.0,
      metadata        TEXT,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_run ON token_usage(pipeline_run_id)')

  // -- Run metrics (migration 010) ------------------------------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS run_metrics (
      run_id              VARCHAR(255) PRIMARY KEY,
      methodology         VARCHAR(128) NOT NULL,
      status              VARCHAR(32) NOT NULL DEFAULT 'running',
      started_at          TEXT NOT NULL,
      completed_at        TEXT,
      wall_clock_seconds  DOUBLE DEFAULT 0,
      total_input_tokens  INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cost_usd      DOUBLE DEFAULT 0,
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
      created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS story_metrics (
      id                  INTEGER PRIMARY KEY AUTO_INCREMENT,
      run_id              VARCHAR(255) NOT NULL,
      story_key           VARCHAR(255) NOT NULL,
      result              VARCHAR(32) NOT NULL DEFAULT 'pending',
      phase_durations_json TEXT,
      started_at          TEXT,
      completed_at        TEXT,
      wall_clock_seconds  DOUBLE DEFAULT 0,
      input_tokens        INTEGER DEFAULT 0,
      output_tokens       INTEGER DEFAULT 0,
      cost_usd            DOUBLE DEFAULT 0,
      review_cycles       INTEGER DEFAULT 0,
      dispatches          INTEGER DEFAULT 0,
      created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, story_key)
    )
  `)

  // -- story_metrics agent/model columns (mesh telemetry enrichment) ---------
  for (const col of ['primary_agent_id VARCHAR(64)', 'primary_model VARCHAR(128)', 'dispatch_agents_json TEXT']) {
    try { await adapter.exec(`ALTER TABLE story_metrics ADD COLUMN ${col}`) } catch { /* column already exists */ }
  }

  // -- Monitor tables (from 001-monitor-schema) -----------------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS task_metrics (
      task_id        VARCHAR(255) NOT NULL,
      agent          VARCHAR(128) NOT NULL,
      task_type      VARCHAR(128) NOT NULL,
      outcome        VARCHAR(16)  NOT NULL CHECK(outcome IN ('success', 'failure')),
      failure_reason TEXT,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      duration_ms    INTEGER NOT NULL DEFAULT 0,
      cost           DOUBLE  NOT NULL DEFAULT 0.0,
      estimated_cost DOUBLE  NOT NULL DEFAULT 0.0,
      billing_mode   VARCHAR(32) NOT NULL DEFAULT 'api',
      retries        INTEGER NOT NULL DEFAULT 0,
      recorded_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (task_id, recorded_at)
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_tm_agent ON task_metrics(agent)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_tm_task_type ON task_metrics(task_type)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_tm_recorded_at ON task_metrics(recorded_at)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_tm_agent_type ON task_metrics(agent, task_type)')

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS performance_aggregates (
      agent              VARCHAR(255) NOT NULL,
      task_type          VARCHAR(255) NOT NULL,
      total_tasks        INTEGER NOT NULL DEFAULT 0,
      successful_tasks   INTEGER NOT NULL DEFAULT 0,
      failed_tasks       INTEGER NOT NULL DEFAULT 0,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_duration_ms  INTEGER NOT NULL DEFAULT 0,
      total_cost         DOUBLE  NOT NULL DEFAULT 0.0,
      total_retries      INTEGER NOT NULL DEFAULT 0,
      last_updated       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (agent, task_type)
    )
  `)

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS routing_recommendations (
      id                INTEGER PRIMARY KEY AUTO_INCREMENT,
      task_type         VARCHAR(128) NOT NULL,
      current_agent     VARCHAR(128) NOT NULL,
      recommended_agent VARCHAR(128) NOT NULL,
      reason            TEXT,
      confidence        DOUBLE  NOT NULL DEFAULT 0.0,
      supporting_data   TEXT,
      generated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at        TEXT
    )
  `)

  // -- Telemetry tables (migration 011) -------------------------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS turn_analysis (
      story_key         VARCHAR(64)    NOT NULL,
      span_id           VARCHAR(128)   NOT NULL,
      turn_number       INTEGER        NOT NULL,
      name              VARCHAR(255)   NOT NULL DEFAULT '',
      timestamp         BIGINT         NOT NULL DEFAULT 0,
      source            VARCHAR(32)    NOT NULL DEFAULT '',
      model             VARCHAR(64),
      input_tokens      INTEGER        NOT NULL DEFAULT 0,
      output_tokens     INTEGER        NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER        NOT NULL DEFAULT 0,
      fresh_tokens      INTEGER        NOT NULL DEFAULT 0,
      cache_hit_rate    DOUBLE         NOT NULL DEFAULT 0,
      cost_usd          DOUBLE         NOT NULL DEFAULT 0,
      duration_ms       INTEGER        NOT NULL DEFAULT 0,
      context_size      INTEGER        NOT NULL DEFAULT 0,
      context_delta     INTEGER        NOT NULL DEFAULT 0,
      tool_name         VARCHAR(128),
      is_context_spike  BOOLEAN        NOT NULL DEFAULT 0,
      child_spans_json  TEXT           NOT NULL DEFAULT '[]',
      task_type         VARCHAR(64),
      phase             VARCHAR(64),
      dispatch_id       VARCHAR(64),
      PRIMARY KEY (story_key, span_id)
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_turn_analysis_story ON turn_analysis (story_key, turn_number)')

  // Migration: add dispatch context columns for existing repos (Story 30-1)
  for (const col of ['task_type', 'phase', 'dispatch_id']) {
    try { await adapter.exec(`ALTER TABLE turn_analysis ADD COLUMN ${col} VARCHAR(64)`) } catch { /* column already exists */ }
  }

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS efficiency_scores (
      story_key                     VARCHAR(64)  NOT NULL,
      timestamp                     BIGINT       NOT NULL,
      composite_score               INTEGER      NOT NULL DEFAULT 0,
      cache_hit_sub_score           DOUBLE       NOT NULL DEFAULT 0,
      io_ratio_sub_score            DOUBLE       NOT NULL DEFAULT 0,
      context_management_sub_score  DOUBLE       NOT NULL DEFAULT 0,
      avg_cache_hit_rate            DOUBLE       NOT NULL DEFAULT 0,
      avg_io_ratio                  DOUBLE       NOT NULL DEFAULT 0,
      context_spike_count           INTEGER      NOT NULL DEFAULT 0,
      total_turns                   INTEGER      NOT NULL DEFAULT 0,
      per_model_json                TEXT         NOT NULL DEFAULT '[]',
      per_source_json               TEXT         NOT NULL DEFAULT '[]',
      dispatch_id                   TEXT,
      task_type                     TEXT,
      phase                         TEXT,
      PRIMARY KEY (story_key, timestamp)
    )
  `)

  // Migration: add dispatch context columns for existing repos (Story 30-3)
  for (const col of ['dispatch_id', 'task_type', 'phase']) {
    try { await adapter.exec(`ALTER TABLE efficiency_scores ADD COLUMN ${col} TEXT`) } catch { /* column already exists */ }
  }

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id                       VARCHAR(16)   NOT NULL,
      story_key                VARCHAR(64)   NOT NULL,
      sprint_id                VARCHAR(64),
      rule_id                  VARCHAR(64)   NOT NULL,
      severity                 VARCHAR(16)   NOT NULL,
      title                    TEXT          NOT NULL,
      description              TEXT          NOT NULL,
      potential_savings_tokens INTEGER,
      potential_savings_usd    DOUBLE,
      action_target            TEXT,
      generated_at             VARCHAR(32)   NOT NULL,
      PRIMARY KEY (id)
    )
  `)

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS category_stats (
      story_key            VARCHAR(100)   NOT NULL,
      category             VARCHAR(30)    NOT NULL,
      total_tokens         BIGINT         NOT NULL DEFAULT 0,
      percentage           DECIMAL(6,3)   NOT NULL DEFAULT 0,
      event_count          INTEGER        NOT NULL DEFAULT 0,
      avg_tokens_per_event DECIMAL(12,2)  NOT NULL DEFAULT 0,
      trend                VARCHAR(10)    NOT NULL DEFAULT 'stable',
      PRIMARY KEY (story_key, category)
    )
  `)

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS consumer_stats (
      story_key            VARCHAR(100)   NOT NULL,
      consumer_key         VARCHAR(300)   NOT NULL,
      category             VARCHAR(30)    NOT NULL,
      total_tokens         BIGINT         NOT NULL DEFAULT 0,
      percentage           DECIMAL(6,3)   NOT NULL DEFAULT 0,
      event_count          INTEGER        NOT NULL DEFAULT 0,
      top_invocations_json TEXT,
      PRIMARY KEY (story_key, consumer_key)
    )
  `)

  // -- Views ----------------------------------------------------------------
  // NOTE: Views use JOINs and aggregation. They work with Dolt
  // but NOT with InMemoryDatabaseAdapter. For InMemory backend, views are
  // skipped silently (CREATE VIEW is an unknown statement to InMemory).

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

  // -- Schema migration tracking table (for future use) --------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
}
