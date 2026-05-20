/**
 * Telemetry schema — per-turn analysis + efficiency scoring + recommendations.
 *
 * Owns: turn_analysis, efficiency_scores, recommendations, category_stats,
 * consumer_stats + their indexes + the Story 30-1/30-3 ALTER migrations
 * (task_type/phase/dispatch_id columns on turn_analysis and efficiency_scores).
 *
 * Extracted from `schema.ts` in Ship 5 (2026-05). Pre-Ship-4 these tables had
 * DDL in 3 places (schema.sql, schema.ts, adapter-persistence.ts). Ship 4
 * consolidated to schema.ts; Ship 5 moves them to this dedicated module.
 */

import type { DatabaseAdapter } from './types.js'

export async function initTelemetrySchema(adapter: DatabaseAdapter): Promise<void> {
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

  // Migration: task_type/phase/dispatch_id columns added in Story 30-1.
  // Idempotent ALTER for existing repos predating that change.
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
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_efficiency_story ON efficiency_scores (story_key, timestamp DESC)')

  // Migration: dispatch_id/task_type/phase added in Story 30-3.
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
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_recommendations_story ON recommendations (story_key, severity)')

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
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_category_stats_story ON category_stats (story_key, total_tokens)')

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
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_consumer_stats_story ON consumer_stats (story_key, total_tokens)')
}
