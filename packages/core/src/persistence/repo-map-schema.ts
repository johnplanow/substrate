/**
 * Repo-map schema — code-symbol index used by the context-engineering layer.
 *
 * Owns: repo_map_symbols, repo_map_meta + their indexes.
 *
 * Consumed by `src/modules/repo-map/storage.ts` (~10 query sites). Production
 * runtime DDL was previously in `dolt-store.ts._runMigrations` (the v5→v6
 * dependencies-column ALTER, which still runs there for repos predating
 * v0.20.94 — Ship 3 ported the CREATE TABLE here from schema.sql).
 *
 * Extracted from `schema.ts` in Ship 5 (2026-05).
 */

import type { DatabaseAdapter } from './types.js'

export async function initRepoMapSchema(adapter: DatabaseAdapter): Promise<void> {
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS repo_map_symbols (
      id          BIGINT AUTO_INCREMENT NOT NULL,
      file_path   VARCHAR(1000)         NOT NULL,
      symbol_name VARCHAR(500)          NOT NULL,
      symbol_kind VARCHAR(20)           NOT NULL,
      signature   TEXT,
      line_number INT                   NOT NULL DEFAULT 0,
      exported    TINYINT(1)            NOT NULL DEFAULT 0,
      file_hash   VARCHAR(64)           NOT NULL,
      dependencies JSON,
      PRIMARY KEY (id)
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_repo_map_symbols_file ON repo_map_symbols (file_path)')
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_repo_map_symbols_kind ON repo_map_symbols (symbol_kind)')

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS repo_map_meta (
      id          INT      NOT NULL DEFAULT 1,
      commit_sha  VARCHAR(64),
      updated_at  DATETIME,
      file_count  INT      NOT NULL DEFAULT 0,
      PRIMARY KEY (id)
    )
  `)
}
