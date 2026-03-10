/**
 * TelemetryPersistence — SQLite-backed persistence for telemetry data.
 *
 * Implements ITelemetryPersistence with better-sqlite3 prepared statements.
 * All INSERT statements use INSERT OR REPLACE (upsert semantics) and are
 * prepared once at construction time. All reads are validated with Zod.
 *
 * Note: This implementation targets better-sqlite3 (synchronous API) which is
 * used in the project's FileStateStore context. For Dolt/MySQL wire protocol,
 * use DoltClient-based adapters (see story 27-3 full scope).
 */

import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3'

import { createLogger } from '../../utils/logger.js'
import type {
  TurnAnalysis,
  EfficiencyScore,
  Recommendation,
  CategoryStats,
  ConsumerStats,
} from './types.js'
import {
  TurnAnalysisSchema,
  EfficiencyScoreSchema,
  RecommendationSchema,
  CategoryStatsSchema,
  ConsumerStatsSchema,
} from './types.js'

const logger = createLogger('telemetry:persistence')

// ---------------------------------------------------------------------------
// ITelemetryPersistence interface
// ---------------------------------------------------------------------------

/**
 * Interface for telemetry data persistence.
 * Implementations may target SQLite, Dolt, or in-memory storage.
 */
export interface ITelemetryPersistence {
  // -- Turn analysis (story 27-4) -------------------------------------------

  /** Batch-insert all turns for a story, serializing childSpans to JSON. */
  storeTurnAnalysis(storyKey: string, turns: TurnAnalysis[]): Promise<void>

  /** Retrieve all turns for a story in ascending turn_number order. */
  getTurnAnalysis(storyKey: string): Promise<TurnAnalysis[]>

  // -- Efficiency scores (story 27-6) ----------------------------------------

  /** Insert or replace the efficiency score for a story. */
  storeEfficiencyScore(score: EfficiencyScore): Promise<void>

  /** Retrieve the most recent efficiency score for a story, or null. */
  getEfficiencyScore(storyKey: string): Promise<EfficiencyScore | null>

  /**
   * Retrieve multiple efficiency scores ordered by timestamp DESC.
   * Returns up to `limit` records (default 20).
   */
  getEfficiencyScores(limit?: number): Promise<EfficiencyScore[]>

  // -- Recommendations (story 27-7) ------------------------------------------

  /** Batch-insert all recommendations for a story in a single transaction. */
  saveRecommendations(storyKey: string, recs: Recommendation[]): Promise<void>

  /**
   * Retrieve recommendations for a story ordered by severity (critical first)
   * then by potentialSavingsTokens descending.
   */
  getRecommendations(storyKey: string): Promise<Recommendation[]>

  /**
   * Retrieve all recommendations across all stories, ordered by severity (critical first)
   * then by potentialSavingsTokens descending. Returns up to `limit` records (default 20).
   */
  getAllRecommendations(limit?: number): Promise<Recommendation[]>

  // -- Category stats (story 27-5) -------------------------------------------

  /** Batch-insert category stats for a story (INSERT OR IGNORE — skip if already present). */
  storeCategoryStats(storyKey: string, stats: CategoryStats[]): Promise<void>

  /** Retrieve category stats for a story ordered by total_tokens descending. */
  getCategoryStats(storyKey: string): Promise<CategoryStats[]>

  // -- Consumer stats (story 27-5) -------------------------------------------

  /** Batch-insert consumer stats for a story (INSERT OR IGNORE — skip if already present). */
  storeConsumerStats(storyKey: string, consumers: ConsumerStats[]): Promise<void>

  /** Retrieve consumer stats for a story ordered by total_tokens descending. */
  getConsumerStats(storyKey: string): Promise<ConsumerStats[]>

  // -- OTEL span recording (story 28-6) --------------------------------------

  /**
   * Record a named span with arbitrary attributes.
   * Used by RoutingTelemetry and RepoMapTelemetry to emit routing/repo-map spans.
   * Implementations may persist to DB, log, or no-op.
   */
  recordSpan(span: { name: string; attributes: Record<string, unknown> }): void
}

// ---------------------------------------------------------------------------
// Row shapes for SQLite queries
// ---------------------------------------------------------------------------

interface TurnAnalysisRow {
  story_key: string
  span_id: string
  turn_number: number
  name: string
  timestamp: number
  source: string
  model: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  fresh_tokens: number
  cache_hit_rate: number
  cost_usd: number
  duration_ms: number
  context_size: number
  context_delta: number
  tool_name: string | null
  is_context_spike: number  // SQLite stores BOOLEAN as 0/1
  child_spans_json: string
}

interface EfficiencyScoreRow {
  story_key: string
  timestamp: number
  composite_score: number
  cache_hit_sub_score: number
  io_ratio_sub_score: number
  context_management_sub_score: number
  avg_cache_hit_rate: number
  avg_io_ratio: number
  context_spike_count: number
  total_turns: number
  per_model_json: string
  per_source_json: string
}

interface RecommendationRow {
  id: string
  story_key: string
  sprint_id: string | null
  rule_id: string
  severity: string
  title: string
  description: string
  potential_savings_tokens: number | null
  potential_savings_usd: number | null
  action_target: string | null
  generated_at: string
}

interface CategoryStatsRow {
  story_key: string
  category: string
  total_tokens: number
  percentage: number
  event_count: number
  avg_tokens_per_event: number
  trend: string
}

interface ConsumerStatsRow {
  story_key: string
  consumer_key: string
  category: string
  total_tokens: number
  percentage: number
  event_count: number
  top_invocations_json: string | null
}

// ---------------------------------------------------------------------------
// TelemetryPersistence
// ---------------------------------------------------------------------------

/**
 * Concrete SQLite-backed telemetry persistence.
 *
 * All prepared statements are compiled once at construction time.
 * Call `initSchema()` before using if the tables may not exist yet.
 */
export class TelemetryPersistence implements ITelemetryPersistence {
  private readonly _db: BetterSqlite3Database
  private readonly _insertTurnAnalysis: Statement
  private readonly _getTurnAnalysis: Statement
  private readonly _insertEfficiencyScore: Statement
  private readonly _getEfficiencyScore: Statement
  private readonly _getEfficiencyScores: Statement
  private readonly _insertRecommendation: Statement
  private readonly _getRecommendations: Statement
  private readonly _getAllRecommendations: Statement
  private readonly _insertCategoryStats: Statement
  private readonly _getCategoryStats: Statement
  private readonly _getAllCategoryStats: Statement
  private readonly _insertConsumerStats: Statement
  private readonly _getConsumerStats: Statement

  constructor(db: BetterSqlite3Database) {
    this._db = db

    // Prepare statements at construction time (fail-fast on schema issues).
    this._insertTurnAnalysis = this._db.prepare(`
      INSERT OR REPLACE INTO turn_analysis (
        story_key, span_id, turn_number, name, timestamp, source, model,
        input_tokens, output_tokens, cache_read_tokens, fresh_tokens,
        cache_hit_rate, cost_usd, duration_ms, context_size, context_delta,
        tool_name, is_context_spike, child_spans_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `)

    this._getTurnAnalysis = this._db.prepare(`
      SELECT * FROM turn_analysis
      WHERE story_key = ?
      ORDER BY turn_number ASC
    `)

    this._insertEfficiencyScore = this._db.prepare(`
      INSERT OR REPLACE INTO efficiency_scores (
        story_key, timestamp, composite_score,
        cache_hit_sub_score, io_ratio_sub_score, context_management_sub_score,
        avg_cache_hit_rate, avg_io_ratio, context_spike_count, total_turns,
        per_model_json, per_source_json
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )
    `)

    this._getEfficiencyScore = this._db.prepare(`
      SELECT * FROM efficiency_scores
      WHERE story_key = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `)

    this._getEfficiencyScores = this._db.prepare(`
      SELECT * FROM efficiency_scores
      ORDER BY timestamp DESC
      LIMIT ?
    `)

    this._insertRecommendation = this._db.prepare(`
      INSERT OR REPLACE INTO recommendations (
        id, story_key, sprint_id, rule_id, severity, title, description,
        potential_savings_tokens, potential_savings_usd, action_target, generated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `)

    this._getRecommendations = this._db.prepare(`
      SELECT * FROM recommendations
      WHERE story_key = ?
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 1
          WHEN 'warning' THEN 2
          ELSE 3
        END,
        COALESCE(potential_savings_tokens, 0) DESC
    `)

    this._getAllRecommendations = this._db.prepare(`
      SELECT * FROM recommendations
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 1
          WHEN 'warning' THEN 2
          ELSE 3
        END,
        COALESCE(potential_savings_tokens, 0) DESC
      LIMIT ?
    `)

    this._insertCategoryStats = this._db.prepare(`
      INSERT OR IGNORE INTO category_stats (
        story_key, category, total_tokens, percentage, event_count,
        avg_tokens_per_event, trend
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    this._getCategoryStats = this._db.prepare(`
      SELECT * FROM category_stats
      WHERE story_key = ?
      ORDER BY total_tokens DESC
    `)

    this._getAllCategoryStats = this._db.prepare(`
      SELECT category, SUM(total_tokens) AS total_tokens,
             AVG(percentage) AS percentage,
             SUM(event_count) AS event_count,
             AVG(avg_tokens_per_event) AS avg_tokens_per_event,
             MAX(trend) AS trend
      FROM category_stats
      GROUP BY category
      ORDER BY total_tokens DESC
    `)

    this._insertConsumerStats = this._db.prepare(`
      INSERT OR IGNORE INTO consumer_stats (
        story_key, consumer_key, category, total_tokens, percentage,
        event_count, top_invocations_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    this._getConsumerStats = this._db.prepare(`
      SELECT * FROM consumer_stats
      WHERE story_key = ?
      ORDER BY total_tokens DESC
    `)
  }

  // ---------------------------------------------------------------------------
  // Schema initialization
  // ---------------------------------------------------------------------------

  /**
   * Apply the telemetry schema DDL to the database.
   * Idempotent — uses CREATE TABLE IF NOT EXISTS.
   */
  initSchema(): void {
    this._db.exec(`
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
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — turn analysis
  // ---------------------------------------------------------------------------

  async storeTurnAnalysis(storyKey: string, turns: TurnAnalysis[]): Promise<void> {
    if (turns.length === 0) return

    const insertAll = this._db.transaction((rows: TurnAnalysis[]) => {
      for (const turn of rows) {
        this._insertTurnAnalysis.run(
          storyKey,
          turn.spanId,
          turn.turnNumber,
          turn.name,
          turn.timestamp,
          turn.source,
          turn.model ?? null,
          turn.inputTokens,
          turn.outputTokens,
          turn.cacheReadTokens,
          turn.freshTokens,
          turn.cacheHitRate,
          turn.costUsd,
          turn.durationMs,
          turn.contextSize,
          turn.contextDelta,
          turn.toolName ?? null,
          turn.isContextSpike ? 1 : 0,
          JSON.stringify(turn.childSpans),
        )
      }
    })

    insertAll(turns)
    logger.debug({ storyKey, count: turns.length }, 'Stored turn analysis')
  }

  async getTurnAnalysis(storyKey: string): Promise<TurnAnalysis[]> {
    const rows = this._getTurnAnalysis.all(storyKey) as TurnAnalysisRow[]
    if (rows.length === 0) return []

    return rows.map((row) => {
      const raw = {
        spanId: row.span_id,
        turnNumber: row.turn_number,
        name: row.name,
        timestamp: row.timestamp,
        source: row.source,
        model: row.model ?? undefined,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        freshTokens: row.fresh_tokens,
        cacheHitRate: row.cache_hit_rate,
        costUsd: row.cost_usd,
        durationMs: row.duration_ms,
        contextSize: row.context_size,
        contextDelta: row.context_delta,
        toolName: row.tool_name ?? undefined,
        isContextSpike: row.is_context_spike === 1,
        childSpans: JSON.parse(row.child_spans_json) as unknown[],
      }
      return TurnAnalysisSchema.parse(raw)
    })
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — efficiency scores
  // ---------------------------------------------------------------------------

  async storeEfficiencyScore(score: EfficiencyScore): Promise<void> {
    this._insertEfficiencyScore.run(
      score.storyKey,
      score.timestamp,
      score.compositeScore,
      score.cacheHitSubScore,
      score.ioRatioSubScore,
      score.contextManagementSubScore,
      score.avgCacheHitRate,
      score.avgIoRatio,
      score.contextSpikeCount,
      score.totalTurns,
      JSON.stringify(score.perModelBreakdown),
      JSON.stringify(score.perSourceBreakdown),
    )
    logger.debug(
      { storyKey: score.storyKey, compositeScore: score.compositeScore },
      'Stored efficiency score',
    )
  }

  async getEfficiencyScore(storyKey: string): Promise<EfficiencyScore | null> {
    const row = this._getEfficiencyScore.get(storyKey) as EfficiencyScoreRow | undefined
    if (row === undefined) return null

    const raw = {
      storyKey: row.story_key,
      timestamp: row.timestamp,
      compositeScore: row.composite_score,
      cacheHitSubScore: row.cache_hit_sub_score,
      ioRatioSubScore: row.io_ratio_sub_score,
      contextManagementSubScore: row.context_management_sub_score,
      avgCacheHitRate: row.avg_cache_hit_rate,
      avgIoRatio: row.avg_io_ratio,
      contextSpikeCount: row.context_spike_count,
      totalTurns: row.total_turns,
      perModelBreakdown: JSON.parse(row.per_model_json) as unknown[],
      perSourceBreakdown: JSON.parse(row.per_source_json) as unknown[],
    }

    return EfficiencyScoreSchema.parse(raw)
  }

  /**
   * Retrieve multiple efficiency scores ordered by timestamp DESC.
   * Returns up to `limit` records (default 20).
   */
  async getEfficiencyScores(limit = 20): Promise<EfficiencyScore[]> {
    const rows = this._getEfficiencyScores.all(limit) as EfficiencyScoreRow[]
    if (rows.length === 0) return []

    return rows.map((row) => {
      const raw = {
        storyKey: row.story_key,
        timestamp: row.timestamp,
        compositeScore: row.composite_score,
        cacheHitSubScore: row.cache_hit_sub_score,
        ioRatioSubScore: row.io_ratio_sub_score,
        contextManagementSubScore: row.context_management_sub_score,
        avgCacheHitRate: row.avg_cache_hit_rate,
        avgIoRatio: row.avg_io_ratio,
        contextSpikeCount: row.context_spike_count,
        totalTurns: row.total_turns,
        perModelBreakdown: JSON.parse(row.per_model_json) as unknown[],
        perSourceBreakdown: JSON.parse(row.per_source_json) as unknown[],
      }
      return EfficiencyScoreSchema.parse(raw)
    })
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — recommendations (story 27-7)
  // ---------------------------------------------------------------------------

  /**
   * Batch-insert all recommendations for a story in a single transaction.
   * Uses INSERT OR REPLACE for idempotency (IDs are deterministic hashes).
   */
  async saveRecommendations(storyKey: string, recs: Recommendation[]): Promise<void> {
    if (recs.length === 0) return

    const insertAll = this._db.transaction((rows: Recommendation[]) => {
      for (const rec of rows) {
        this._insertRecommendation.run(
          rec.id,
          rec.storyKey,
          rec.sprintId ?? null,
          rec.ruleId,
          rec.severity,
          rec.title,
          rec.description,
          rec.potentialSavingsTokens ?? null,
          rec.potentialSavingsUsd ?? null,
          rec.actionTarget ?? null,
          rec.generatedAt,
        )
      }
    })

    insertAll(recs)
    logger.debug({ storyKey, count: recs.length }, 'Saved recommendations')
  }

  /**
   * Retrieve recommendations for a story ordered by severity (critical first)
   * then by potentialSavingsTokens descending.
   * Each row is validated with RecommendationSchema.parse().
   */
  async getRecommendations(storyKey: string): Promise<Recommendation[]> {
    const rows = this._getRecommendations.all(storyKey) as RecommendationRow[]
    if (rows.length === 0) return []

    return rows.map((row) => {
      const raw = {
        id: row.id,
        storyKey: row.story_key,
        sprintId: row.sprint_id ?? undefined,
        ruleId: row.rule_id,
        severity: row.severity,
        title: row.title,
        description: row.description,
        potentialSavingsTokens: row.potential_savings_tokens != null ? Number(row.potential_savings_tokens) : undefined,
        potentialSavingsUsd: row.potential_savings_usd != null ? Number(row.potential_savings_usd) : undefined,
        actionTarget: row.action_target ?? undefined,
        generatedAt: row.generated_at,
      }
      return RecommendationSchema.parse(raw)
    })
  }

  /**
   * Retrieve all recommendations across all stories, ordered by severity (critical first)
   * then by potentialSavingsTokens descending. Returns up to `limit` records (default 20).
   */
  async getAllRecommendations(limit = 20): Promise<Recommendation[]> {
    const rows = this._getAllRecommendations.all(limit) as RecommendationRow[]
    if (rows.length === 0) return []

    return rows.map((row) => {
      const raw = {
        id: row.id,
        storyKey: row.story_key,
        sprintId: row.sprint_id ?? undefined,
        ruleId: row.rule_id,
        severity: row.severity,
        title: row.title,
        description: row.description,
        potentialSavingsTokens: row.potential_savings_tokens != null ? Number(row.potential_savings_tokens) : undefined,
        potentialSavingsUsd: row.potential_savings_usd != null ? Number(row.potential_savings_usd) : undefined,
        actionTarget: row.action_target ?? undefined,
        generatedAt: row.generated_at,
      }
      return RecommendationSchema.parse(raw)
    })
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — category stats (story 27-5)
  // ---------------------------------------------------------------------------

  /**
   * Batch-insert category stats for a story.
   * Uses INSERT OR IGNORE — existing rows for the same (story_key, category) are preserved.
   */
  async storeCategoryStats(storyKey: string, stats: CategoryStats[]): Promise<void> {
    if (stats.length === 0) return

    const insertAll = this._db.transaction((rows: CategoryStats[]) => {
      for (const stat of rows) {
        this._insertCategoryStats.run(
          storyKey,
          stat.category,
          stat.totalTokens,
          stat.percentage,
          stat.eventCount,
          stat.avgTokensPerEvent,
          stat.trend,
        )
      }
    })

    insertAll(stats)
    logger.debug({ storyKey, count: stats.length }, 'Stored category stats')
  }

  /**
   * Retrieve category stats for a story ordered by total_tokens descending.
   * Each row is validated with CategoryStatsSchema.parse().
   * Returns [] when no rows exist for the given storyKey.
   */
  async getCategoryStats(storyKey: string): Promise<CategoryStats[]> {
    // Empty string means "all stories" — use the aggregate query
    const rows = storyKey === ''
      ? (this._getAllCategoryStats.all() as CategoryStatsRow[])
      : (this._getCategoryStats.all(storyKey) as CategoryStatsRow[])
    if (rows.length === 0) return []

    return rows.map((row) => {
      const raw = {
        category: row.category,
        totalTokens: Number(row.total_tokens),
        percentage: Number(row.percentage),
        eventCount: Number(row.event_count),
        avgTokensPerEvent: Number(row.avg_tokens_per_event),
        trend: row.trend,
      }
      return CategoryStatsSchema.parse(raw)
    })
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — consumer stats (story 27-5)
  // ---------------------------------------------------------------------------

  /**
   * Batch-insert consumer stats for a story.
   * topInvocations is serialized to JSON.
   * Uses INSERT OR IGNORE — existing rows for the same (story_key, consumer_key) are preserved.
   */
  async storeConsumerStats(storyKey: string, consumers: ConsumerStats[]): Promise<void> {
    if (consumers.length === 0) return

    const insertAll = this._db.transaction((rows: ConsumerStats[]) => {
      for (const consumer of rows) {
        this._insertConsumerStats.run(
          storyKey,
          consumer.consumerKey,
          consumer.category,
          consumer.totalTokens,
          consumer.percentage,
          consumer.eventCount,
          JSON.stringify(consumer.topInvocations),
        )
      }
    })

    insertAll(consumers)
    logger.debug({ storyKey, count: consumers.length }, 'Stored consumer stats')
  }

  /**
   * Retrieve consumer stats for a story ordered by total_tokens descending.
   * Deserializes top_invocations_json back to TopInvocation[].
   * Each row is validated with ConsumerStatsSchema.parse().
   * Returns [] when no rows exist for the given storyKey.
   */
  async getConsumerStats(storyKey: string): Promise<ConsumerStats[]> {
    const rows = this._getConsumerStats.all(storyKey) as ConsumerStatsRow[]
    if (rows.length === 0) return []

    return rows.map((row) => {
      const raw = {
        consumerKey: row.consumer_key,
        category: row.category,
        totalTokens: Number(row.total_tokens),
        percentage: Number(row.percentage),
        eventCount: Number(row.event_count),
        topInvocations: JSON.parse(row.top_invocations_json ?? '[]') as unknown[],
      }
      return ConsumerStatsSchema.parse(raw)
    })
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — OTEL span recording (story 28-6)
  // ---------------------------------------------------------------------------

  /**
   * Record a named span with arbitrary attributes.
   * Currently logs the span at debug level; future migrations may persist to DB.
   */
  recordSpan(span: { name: string; attributes: Record<string, unknown> }): void {
    logger.debug({ span }, 'recordSpan')
  }
}
