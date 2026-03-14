/**
 * Work-graph schema DDL constants.
 *
 * Story 31-1 placeholder — defines the `stories`, `story_dependencies`, and
 * `ready_stories` DDL used by the EpicIngester and downstream consumers.
 *
 * NOTE: This file is a minimal placeholder created by story 31-2 because story
 * 31-1 (schema creation) had not yet run.  If story 31-1 produces a richer
 * schema, merge carefully and remove this note.
 */

// ---------------------------------------------------------------------------
// stories table
// ---------------------------------------------------------------------------

export const CREATE_STORIES_TABLE = `
CREATE TABLE IF NOT EXISTS stories (
  story_key VARCHAR(50) NOT NULL,
  epic_num INT NOT NULL,
  story_num INT NOT NULL,
  title VARCHAR(500) NOT NULL,
  priority VARCHAR(10) NOT NULL,
  size VARCHAR(50) NOT NULL,
  sprint INT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'planned',
  PRIMARY KEY (story_key)
)
`.trim()

// ---------------------------------------------------------------------------
// story_dependencies table
// ---------------------------------------------------------------------------
// story_key   = the story that has this dependency (the downstream/blocked story)
// depends_on  = the prerequisite story that must complete first
// dependency_type = relationship type; currently always 'blocks'
// source      = 'explicit' for parser-derived deps; 'computed' for inferred ones

export const CREATE_STORY_DEPENDENCIES_TABLE = `
CREATE TABLE IF NOT EXISTS story_dependencies (
  story_key VARCHAR(50) NOT NULL,
  depends_on VARCHAR(50) NOT NULL,
  dependency_type VARCHAR(50) NOT NULL DEFAULT 'blocks',
  source VARCHAR(50) NOT NULL DEFAULT 'explicit',
  PRIMARY KEY (story_key, depends_on)
)
`.trim()

// ---------------------------------------------------------------------------
// ready_stories view
// ---------------------------------------------------------------------------
// A story is "ready" when it is in 'planned' status and none of its explicit
// prerequisites are still in progress or planned.

export const CREATE_READY_STORIES_VIEW = `
CREATE VIEW IF NOT EXISTS ready_stories AS
SELECT s.*
FROM stories s
WHERE s.status = 'planned'
  AND NOT EXISTS (
    SELECT 1 FROM story_dependencies sd
    JOIN stories blocking ON sd.depends_on = blocking.story_key
    WHERE sd.story_key = s.story_key
      AND blocking.status != 'done'
  )
`.trim()
