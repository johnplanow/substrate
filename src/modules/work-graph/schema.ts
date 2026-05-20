/**
 * Work-graph schema — legacy DDL constant exports.
 *
 * The canonical DDL lives in packages/core/src/persistence/work-graph-schema.ts
 * as `initWorkGraphSchema(adapter)`. This file is preserved as a thin shim
 * so the existing callers in `ingest-epic.ts` and `epic-status.ts` keep
 * working — they `await adapter.exec(CREATE_STORIES_TABLE)` directly rather
 * than invoking the function form.
 *
 * Post-Ship-5 (2026-05): the legacy constants here MUST stay in sync with
 * the function form in @substrate-ai/core. Future ports should consider
 * migrating callers to `initWorkGraphSchema(adapter)` and deleting this file
 * entirely.
 */

export const CREATE_STORIES_TABLE = `
CREATE TABLE IF NOT EXISTS wg_stories (
  story_key VARCHAR(20) NOT NULL,
  epic VARCHAR(20) NOT NULL,
  title VARCHAR(255),
  status VARCHAR(30) NOT NULL DEFAULT 'planned',
  spec_path VARCHAR(500),
  created_at DATETIME,
  updated_at DATETIME,
  completed_at DATETIME,
  PRIMARY KEY (story_key)
)
`.trim()

export const CREATE_STORY_DEPENDENCIES_TABLE = `
CREATE TABLE IF NOT EXISTS story_dependencies (
  story_key VARCHAR(50) NOT NULL,
  depends_on VARCHAR(50) NOT NULL,
  dependency_type VARCHAR(50) NOT NULL DEFAULT 'blocks',
  source VARCHAR(50) NOT NULL DEFAULT 'explicit',
  created_at DATETIME,
  PRIMARY KEY (story_key, depends_on)
)
`.trim()

export const CREATE_READY_STORIES_VIEW = `
CREATE VIEW IF NOT EXISTS ready_stories AS
SELECT s.*
FROM wg_stories s
WHERE s.status IN ('planned', 'ready')
  AND NOT EXISTS (
    SELECT 1 FROM story_dependencies sd
    JOIN wg_stories blocking ON sd.depends_on = blocking.story_key
    WHERE sd.story_key = s.story_key
      AND sd.dependency_type = 'blocks'
      AND blocking.status <> 'complete'
  )
`.trim()

// Re-export the modern function form for callers that want a single-call API.
export { initWorkGraphSchema } from '@substrate-ai/core'
