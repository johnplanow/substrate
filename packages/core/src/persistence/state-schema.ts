/**
 * Legacy state schema — pre-2026-Q1 orchestrator state tables.
 *
 * Owns: stories, contracts, metrics, dispatch_log, build_results,
 * review_verdicts, _schema_version + the 9 INSERT IGNORE seed rows.
 *
 * Empirical status: these tables had ZERO rows in every audited production
 * project (ynab, quant). The orchestrator wires `FileStateStore` (in-memory),
 * not DoltStateStore — so the write code paths that target these tables never
 * fired in production. Ship 1 excised the corresponding DoltStateStore CRUD
 * methods; Ship 3 ported the DDL out of schema.sql into initSchema; Ship 5
 * (this module) moves them to a dedicated file.
 *
 * Ship 7 will decide their final fate (keep, delete, or repurpose).
 */

import type { DatabaseAdapter } from './types.js'

/** Tables owned by this subsystem (Ship 6 ownership contract). */
export const stateSchemaTables = [
  'stories',
  'contracts',
  'metrics',
  'dispatch_log',
  'build_results',
  'review_verdicts',
  '_schema_version',
] as const

export async function initStateSchema(adapter: DatabaseAdapter): Promise<void> {
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS stories (
      story_key       VARCHAR(100)   NOT NULL,
      sprint          VARCHAR(50),
      status          VARCHAR(30)    NOT NULL DEFAULT 'PENDING',
      phase           VARCHAR(30)    NOT NULL DEFAULT 'PENDING',
      ac_results      JSON,
      error_message   TEXT,
      created_at      DATETIME,
      updated_at      DATETIME,
      completed_at    DATETIME,
      PRIMARY KEY (story_key)
    )
  `)

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS contracts (
      story_key    VARCHAR(100)   NOT NULL,
      name         VARCHAR(200)   NOT NULL,
      direction    VARCHAR(20)    NOT NULL,
      schema_path  VARCHAR(500),
      transport    VARCHAR(200),
      recorded_at  DATETIME,
      PRIMARY KEY (story_key, name, direction)
    )
  `)

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      story_key          VARCHAR(100)   NOT NULL,
      task_type          VARCHAR(100)   NOT NULL,
      recorded_at        DATETIME       NOT NULL,
      model              VARCHAR(100),
      tokens_in          BIGINT         NOT NULL DEFAULT 0,
      tokens_out         BIGINT         NOT NULL DEFAULT 0,
      cache_read_tokens  BIGINT         NOT NULL DEFAULT 0,
      cost_usd           DECIMAL(10,6)  NOT NULL DEFAULT 0,
      wall_clock_ms      BIGINT         NOT NULL DEFAULT 0,
      review_cycles      INT            NOT NULL DEFAULT 0,
      stall_count        INT            NOT NULL DEFAULT 0,
      result             VARCHAR(30),
      PRIMARY KEY (story_key, task_type, recorded_at)
    )
  `)

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_log (
      story_key      VARCHAR(100)   NOT NULL,
      dispatched_at  DATETIME       NOT NULL,
      branch         VARCHAR(200),
      worker_id      VARCHAR(100),
      result         VARCHAR(30),
      PRIMARY KEY (story_key, dispatched_at)
    )
  `)

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS build_results (
      story_key    VARCHAR(100)   NOT NULL,
      timestamp    DATETIME       NOT NULL,
      command      VARCHAR(500),
      exit_code    INT,
      stdout_hash  VARCHAR(64),
      PRIMARY KEY (story_key, timestamp)
    )
  `)

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS review_verdicts (
      story_key     VARCHAR(100)   NOT NULL,
      timestamp     DATETIME       NOT NULL,
      verdict       VARCHAR(30),
      issues_count  INT            NOT NULL DEFAULT 0,
      notes         TEXT,
      PRIMARY KEY (story_key, timestamp)
    )
  `)

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS _schema_version (
      version      INT            NOT NULL,
      applied_at   DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
      description  VARCHAR(500),
      PRIMARY KEY (version)
    )
  `)

  // _schema_version seed rows — preserved verbatim from schema.sql for
  // backward-compat with operators inspecting the version table. Ship 7
  // will decide whether to keep the table or delete it.
  const seeds: ReadonlyArray<readonly [number, string]> = [
    [1, 'Initial substrate state schema'],
    [2, 'Add turn_analysis table (Epic 27-4)'],
    [3, 'Add category_stats and consumer_stats tables (Epic 27-5)'],
    [4, 'Add recommendations table (Epic 27-7)'],
    [5, 'Add repo_map_symbols and repo_map_meta tables (Epic 28-2)'],
    [6, 'Add dependencies JSON column to repo_map_symbols (Epic 28-3)'],
    [7, 'Add wg_stories, story_dependencies tables and ready_stories view (Epic 31-1)'],
    [8, 'Add task_type, phase, dispatch_id columns to turn_analysis (Story 30-1)'],
    [9, 'Add dispatch_id, task_type, phase columns to efficiency_scores (Story 30-3)'],
  ]
  for (const [version, description] of seeds) {
    try {
      await adapter.exec(`INSERT IGNORE INTO _schema_version (version, description) VALUES (${version}, '${description.replace(/'/g, "''")}')`)
    } catch {
      // InMemory adapter does not support INSERT IGNORE — silently skip.
    }
  }
}
