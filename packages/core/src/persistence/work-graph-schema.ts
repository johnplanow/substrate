/**
 * Work-graph schema — planning-level story nodes + dependencies + ready view.
 *
 * Owns: wg_stories, story_dependencies, ready_stories (view) + the v0.12.0
 * `created_at` idempotent ALTER migration.
 *
 * Extracted from `schema.ts` in Ship 5 (2026-05). Previously the schema lived
 * in BOTH `packages/core/src/persistence/schema.ts` (initSchema) AND
 * `src/modules/work-graph/schema.ts` (exported DDL constants). Ship 5
 * consolidates to this single module; the legacy constants file is now a
 * thin re-export shim.
 *
 * Composition root in initSchema MUST call this AFTER all dependent tables
 * exist (currently no dependencies — wg_stories and story_dependencies are
 * standalone). The `ready_stories` view depends on wg_stories +
 * story_dependencies, both created in this module, so the function is
 * fully self-contained.
 */

import type { DatabaseAdapter } from './types.js'

/** Tables owned by this subsystem (Ship 6 ownership contract). */
export const workGraphSchemaTables = [
  'wg_stories',
  'story_dependencies',
] as const

/** Views owned by this subsystem (Ship 6 ownership contract). */
export const workGraphSchemaViews = [
  'ready_stories',
] as const

export async function initWorkGraphSchema(adapter: DatabaseAdapter): Promise<void> {
  // -- wg_stories (Epic 31-1) ----------------------------------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS wg_stories (
      story_key    VARCHAR(20)   NOT NULL,
      epic         VARCHAR(20)   NOT NULL,
      title        VARCHAR(255),
      status       VARCHAR(30)   NOT NULL DEFAULT 'planned',
      spec_path    VARCHAR(500),
      created_at   DATETIME,
      updated_at   DATETIME,
      completed_at DATETIME,
      PRIMARY KEY (story_key)
    )
  `)
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_wg_stories_epic ON wg_stories (epic)')

  // -- story_dependencies (Epic 31-1) --------------------------------------
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS story_dependencies (
      story_key       VARCHAR(50)   NOT NULL,
      depends_on      VARCHAR(50)   NOT NULL,
      dependency_type VARCHAR(50)   NOT NULL DEFAULT 'blocks',
      source          VARCHAR(50)   NOT NULL DEFAULT 'explicit',
      created_at      DATETIME,
      PRIMARY KEY (story_key, depends_on)
    )
  `)

  // Migration (v0.12.0): add created_at to story_dependencies for repos that
  // pre-date the column. Idempotent try/catch — silently no-ops if present.
  try { await adapter.exec('ALTER TABLE story_dependencies ADD COLUMN created_at DATETIME') } catch { /* column already exists */ }

  // -- ready_stories view (Epic 31-1) --------------------------------------
  // Uses JOIN + correlated subquery. Works on Dolt; InMemoryDatabaseAdapter
  // explicitly no-ops `CREATE VIEW` (memory-adapter.ts:120-123), so the same
  // DDL works on both backends without a try/catch wrapper — and a wrapper
  // would hide genuine Dolt-side errors (v0.20.91 hot-fix lesson). Uses
  // `CREATE VIEW IF NOT EXISTS` rather than `CREATE OR REPLACE` to match
  // the existing ready_tasks pattern and avoid re-running the view
  // definition on every initSchema call.
  await adapter.exec(`
    CREATE VIEW IF NOT EXISTS ready_stories AS
      SELECT s.* FROM wg_stories s
      WHERE s.status IN ('planned', 'ready')
        AND NOT EXISTS (
          SELECT 1 FROM story_dependencies d
          JOIN wg_stories dep ON dep.story_key = d.depends_on
          WHERE d.story_key = s.story_key
            AND d.dependency_type = 'blocks'
            AND dep.status <> 'complete'
        )
  `)
}
