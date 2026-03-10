/**
 * Migration 011: Telemetry schema tables.
 *
 * Creates tables for OTEL telemetry persistence: turn analysis,
 * efficiency scores, recommendations, category stats, and consumer stats
 * (Epic 27).
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { Migration } from './index.js'

export const migration011TelemetrySchema: Migration = {
  version: 11,
  name: 'telemetry-schema',
  up(db: BetterSqlite3Database): void {
    db.exec(`
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
        PRIMARY KEY (story_key, span_id)
      );

      CREATE INDEX IF NOT EXISTS idx_turn_analysis_story
        ON turn_analysis (story_key, turn_number);

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
        PRIMARY KEY (story_key, timestamp)
      );

      CREATE INDEX IF NOT EXISTS idx_efficiency_story
        ON efficiency_scores (story_key, timestamp DESC);

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
      );

      CREATE INDEX IF NOT EXISTS idx_recommendations_story
        ON recommendations (story_key, severity);

      CREATE TABLE IF NOT EXISTS category_stats (
        story_key            VARCHAR(100)   NOT NULL,
        category             VARCHAR(30)    NOT NULL,
        total_tokens         BIGINT         NOT NULL DEFAULT 0,
        percentage           DECIMAL(6,3)   NOT NULL DEFAULT 0,
        event_count          INTEGER        NOT NULL DEFAULT 0,
        avg_tokens_per_event DECIMAL(12,2)  NOT NULL DEFAULT 0,
        trend                VARCHAR(10)    NOT NULL DEFAULT 'stable',
        PRIMARY KEY (story_key, category)
      );

      CREATE INDEX IF NOT EXISTS idx_category_stats_story
        ON category_stats (story_key, total_tokens);

      CREATE TABLE IF NOT EXISTS consumer_stats (
        story_key            VARCHAR(100)   NOT NULL,
        consumer_key         VARCHAR(300)   NOT NULL,
        category             VARCHAR(30)    NOT NULL,
        total_tokens         BIGINT         NOT NULL DEFAULT 0,
        percentage           DECIMAL(6,3)   NOT NULL DEFAULT 0,
        event_count          INTEGER        NOT NULL DEFAULT 0,
        top_invocations_json TEXT,
        PRIMARY KEY (story_key, consumer_key)
      );

      CREATE INDEX IF NOT EXISTS idx_consumer_stats_story
        ON consumer_stats (story_key, total_tokens);
    `)
  },
}
