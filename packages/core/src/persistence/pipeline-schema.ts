/**
 * Pipeline schema — pipeline-run state and metrics.
 *
 * Owns: pipeline_runs, decisions, requirements, constraints, artifacts,
 * token_usage, run_metrics, story_metrics + the mesh-telemetry ALTER for
 * story_metrics.agent/model/dispatch columns.
 *
 * Extracted from `schema.ts` in Ship 5 (2026-05). DDL preserved byte-for-byte
 * from the pre-split version.
 */

import type { DatabaseAdapter } from './types.js'

/** Tables owned by this subsystem (Ship 6 ownership contract). */
export const pipelineSchemaTables = [
  'pipeline_runs',
  'decisions',
  'requirements',
  'constraints',
  'artifacts',
  'token_usage',
  'run_metrics',
  'story_metrics',
] as const

export async function initPipelineSchema(adapter: DatabaseAdapter): Promise<void> {
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
}
