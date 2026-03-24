/**
 * Factory schema DDL for graph execution and scenario validation tables.
 * Companion to `@substrate-ai/core`'s `initSchema` — call both during factory initialization.
 */

import type { DatabaseAdapter } from '@substrate-ai/core'

/**
 * Initialize all factory-specific persistence tables on the given adapter.
 * Idempotent — safe to call multiple times.
 *
 * Creates:
 *   - graph_runs: top-level graph execution run records
 *   - graph_node_results: per-node execution results within a run
 *   - scenario_results: scenario validation outcomes within a run
 */
export async function factorySchema(adapter: DatabaseAdapter): Promise<void> {
  // -- graph_runs (AC1) -------------------------------------------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS graph_runs (
      id              VARCHAR(255) PRIMARY KEY,
      graph_file      TEXT NOT NULL,
      graph_goal      TEXT,
      status          VARCHAR(32) NOT NULL DEFAULT 'running',
      started_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at    DATETIME,
      total_cost_usd  DOUBLE NOT NULL DEFAULT 0.0,
      node_count      INTEGER NOT NULL DEFAULT 0,
      final_outcome   VARCHAR(32),
      checkpoint_path TEXT
    )
  `)

  // -- graph_node_results (AC2, AC4) ------------------------------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS graph_node_results (
      id               INTEGER PRIMARY KEY AUTO_INCREMENT,
      run_id           VARCHAR(255) NOT NULL ,
      node_id          VARCHAR(255) NOT NULL,
      attempt          INTEGER NOT NULL DEFAULT 1,
      status           VARCHAR(32) NOT NULL,
      started_at       DATETIME NOT NULL,
      completed_at     DATETIME,
      duration_ms      INTEGER,
      cost_usd         DOUBLE NOT NULL DEFAULT 0.0,
      failure_reason   TEXT,
      context_snapshot TEXT
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_graph_node_results_run ON graph_node_results(run_id)')

  // -- scenario_results (AC3, AC4) --------------------------------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS scenario_results (
      id                 INTEGER PRIMARY KEY AUTO_INCREMENT,
      run_id             VARCHAR(255) NOT NULL ,
      node_id            VARCHAR(255) NOT NULL,
      iteration          INTEGER NOT NULL DEFAULT 1,
      total_scenarios    INTEGER NOT NULL,
      passed             INTEGER NOT NULL,
      failed             INTEGER NOT NULL,
      satisfaction_score DOUBLE NOT NULL,
      threshold          DOUBLE NOT NULL DEFAULT 0.8,
      passes             BOOLEAN NOT NULL,
      details            TEXT,
      executed_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_scenario_results_run ON scenario_results(run_id)')

  // -- twin_runs (AC1) --------------------------------------------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS twin_runs (
      id          VARCHAR(255) PRIMARY KEY,
      run_id      VARCHAR(255),
      twin_name   VARCHAR(255) NOT NULL,
      started_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      stopped_at  DATETIME,
      status      VARCHAR(32) NOT NULL DEFAULT 'running',
      ports_json  TEXT
    )
  `)

  // -- twin_health_failures (AC2) ---------------------------------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS twin_health_failures (
      id            INTEGER PRIMARY KEY AUTO_INCREMENT,
      twin_name     VARCHAR(255) NOT NULL,
      run_id        VARCHAR(255),
      checked_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      error_message TEXT NOT NULL
    )
  `)
  await adapter.exec(
    'CREATE INDEX IF NOT EXISTS idx_twin_health_failures_twin ON twin_health_failures(twin_name)',
  )
}
