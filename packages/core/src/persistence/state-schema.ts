/**
 * Legacy state schema — pre-2026-Q1 orchestrator state tables.
 *
 * Owns: stories, contracts, metrics, dispatch_log, build_results,
 * review_verdicts.
 *
 * Empirical status: these tables had ZERO rows in every audited production
 * project (ynab, quant). The orchestrator wires `FileStateStore` (in-memory),
 * not DoltStateStore — so the write code paths that target these tables never
 * fired in production. Ship 1 excised the corresponding DoltStateStore CRUD
 * methods; Ship 3 ported the DDL out of schema.sql into initSchema; Ship 5
 * moved them to this module; Ship 7 (2026-05) deleted the vestigial
 * `_schema_version` table that used to live here.
 *
 * Ship 7 also added the `DROP TABLE IF EXISTS _schema_version` cleanup at the
 * start of this function so existing repos (ynab, quant) lose the table on
 * next `substrate run`. The cosmetic "version row lag" the user originally
 * flagged (ynab showed v=5 despite v=9 schema) is closed by removing the
 * table itself rather than maintaining a misleading version row.
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
] as const

export async function initStateSchema(adapter: DatabaseAdapter): Promise<void> {
  // Ship 7 cleanup: drop the vestigial `_schema_version` table for existing
  // repos. The table held 9 seed rows but was never read by any production
  // code path; the user-visible "version row lag" between ynab (v=5) and the
  // current v=9 schema was purely cosmetic. Idempotent on fresh repos.
  // Note: this is distinct from monitor-database.ts's `_schema_version` which
  // lives in `.substrate/monitor.db` with a different schema (version_id +
  // applied_at) and is managed independently.
  try { await adapter.exec('DROP TABLE IF EXISTS _schema_version') } catch { /* table absent or adapter lacks DROP support */ }

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

}
