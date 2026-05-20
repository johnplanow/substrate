/**
 * Monitor schema — task-level metrics + routing recommendations.
 *
 * Owns: task_metrics, performance_aggregates, routing_recommendations.
 *
 * Note: these same tables are ALSO defined by `monitor-database.ts` for a
 * SEPARATE database (`.substrate/monitor.db`). That instance is managed
 * independently via the synchronous SyncAdapter API; the DDL here applies
 * to the main persistence DB only.
 *
 * Extracted from `schema.ts` in Ship 5 (2026-05). DDL preserved byte-for-byte.
 */

import type { DatabaseAdapter } from './types.js'

export async function initMonitorSchema(adapter: DatabaseAdapter): Promise<void> {
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
}
