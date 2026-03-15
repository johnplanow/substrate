/**
 * AdapterTelemetryPersistence — DatabaseAdapter-backed persistence for telemetry data.
 *
 * Implements ITelemetryPersistence using the generic DatabaseAdapter interface
 * (async query/exec/transaction).
 *
 * This enables telemetry persistence on any backend (Dolt, InMemory, or WASM SQLite).
 *
 * SQL conversions from the original TelemetryPersistence:
 *  - INSERT OR REPLACE → DELETE + INSERT (adapter-compatible across all backends)
 *  - INSERT OR IGNORE  → try/catch around INSERT (silently skip duplicates)
 *  - .prepare(sql).run/all/get → adapter.query()
 *  - db.transaction()  → adapter.transaction()
 *  - db.exec()         → adapter.exec()
 */

import type { DatabaseAdapter } from '../../persistence/adapter.js'
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
import type { ITelemetryPersistence } from './persistence.js'

const logger = createLogger('telemetry:adapter-persistence')

// ---------------------------------------------------------------------------
// Row shapes (mirrored from persistence.ts for DB ↔ domain mapping)
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
  is_context_spike: number // SQL stores BOOLEAN as 0/1
  child_spans_json: string
  task_type: string | null
  phase: string | null
  dispatch_id: string | null
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
  dispatch_id: string | null
  task_type: string | null
  phase: string | null
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
// AdapterTelemetryPersistence
// ---------------------------------------------------------------------------

/**
 * Concrete DatabaseAdapter-backed telemetry persistence.
 *
 * Call `initSchema()` before using if the tables may not exist yet.
 */
export class AdapterTelemetryPersistence implements ITelemetryPersistence {
  private readonly _adapter: DatabaseAdapter

  constructor(adapter: DatabaseAdapter) {
    this._adapter = adapter
  }

  // ---------------------------------------------------------------------------
  // Schema initialization
  // ---------------------------------------------------------------------------

  /**
   * Apply the telemetry schema DDL to the database.
   * Idempotent — uses CREATE TABLE IF NOT EXISTS.
   */
  async initSchema(): Promise<void> {
    await this._adapter.exec(`
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

    await this._adapter.exec(`
      CREATE INDEX IF NOT EXISTS idx_turn_analysis_story
        ON turn_analysis (story_key, turn_number)
    `)

    await this._adapter.exec(`
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

    await this._adapter.exec(`
      CREATE INDEX IF NOT EXISTS idx_efficiency_story
        ON efficiency_scores (story_key, timestamp DESC)
    `)

    await this._adapter.exec(`
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

    await this._adapter.exec(`
      CREATE INDEX IF NOT EXISTS idx_recommendations_story
        ON recommendations (story_key, severity)
    `)

    await this._adapter.exec(`
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

    await this._adapter.exec(`
      CREATE INDEX IF NOT EXISTS idx_category_stats_story
        ON category_stats (story_key, total_tokens)
    `)

    await this._adapter.exec(`
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

    await this._adapter.exec(`
      CREATE INDEX IF NOT EXISTS idx_consumer_stats_story
        ON consumer_stats (story_key, total_tokens)
    `)
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — turn analysis
  // ---------------------------------------------------------------------------

  async storeTurnAnalysis(storyKey: string, turns: TurnAnalysis[]): Promise<void> {
    if (turns.length === 0) return

    await this._adapter.transaction(async (adapter) => {
      for (const turn of turns) {
        // DELETE + INSERT instead of INSERT OR REPLACE
        await adapter.query(
          `DELETE FROM turn_analysis WHERE story_key = ? AND span_id = ?`,
          [storyKey, turn.spanId],
        )
        await adapter.query(
          `INSERT INTO turn_analysis (
            story_key, span_id, turn_number, name, timestamp, source, model,
            input_tokens, output_tokens, cache_read_tokens, fresh_tokens,
            cache_hit_rate, cost_usd, duration_ms, context_size, context_delta,
            tool_name, is_context_spike, child_spans_json,
            task_type, phase, dispatch_id
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?
          )`,
          [
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
            turn.taskType ?? null,
            turn.phase ?? null,
            turn.dispatchId ?? null,
          ],
        )
      }
    })

    logger.debug({ storyKey, count: turns.length }, 'Stored turn analysis')
  }

  async getTurnAnalysis(storyKey: string): Promise<TurnAnalysis[]> {
    const rows = await this._adapter.query<TurnAnalysisRow>(
      `SELECT * FROM turn_analysis WHERE story_key = ? ORDER BY turn_number ASC`,
      [storyKey],
    )
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
        taskType: row.task_type ?? undefined,
        phase: row.phase ?? undefined,
        dispatchId: row.dispatch_id ?? undefined,
      }
      return TurnAnalysisSchema.parse(raw)
    })
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — efficiency scores
  // ---------------------------------------------------------------------------

  async storeEfficiencyScore(score: EfficiencyScore): Promise<void> {
    // DELETE + INSERT instead of INSERT OR REPLACE
    await this._adapter.query(
      `DELETE FROM efficiency_scores WHERE story_key = ? AND timestamp = ?`,
      [score.storyKey, score.timestamp],
    )
    await this._adapter.query(
      `INSERT INTO efficiency_scores (
        story_key, timestamp, composite_score,
        cache_hit_sub_score, io_ratio_sub_score, context_management_sub_score,
        avg_cache_hit_rate, avg_io_ratio, context_spike_count, total_turns,
        per_model_json, per_source_json,
        dispatch_id, task_type, phase
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?
      )`,
      [
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
        score.dispatchId ?? null,
        score.taskType ?? null,
        score.phase ?? null,
      ],
    )
    logger.debug(
      { storyKey: score.storyKey, compositeScore: score.compositeScore },
      'Stored efficiency score',
    )
  }

  private _rowToEfficiencyScore(row: EfficiencyScoreRow): EfficiencyScore {
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
      ...(row.dispatch_id != null && { dispatchId: row.dispatch_id }),
      ...(row.task_type != null && { taskType: row.task_type }),
      ...(row.phase != null && { phase: row.phase }),
    }
    return EfficiencyScoreSchema.parse(raw)
  }

  async getEfficiencyScore(storyKey: string): Promise<EfficiencyScore | null> {
    const rows = await this._adapter.query<EfficiencyScoreRow>(
      `SELECT * FROM efficiency_scores WHERE story_key = ? AND dispatch_id IS NULL ORDER BY timestamp DESC LIMIT 1`,
      [storyKey],
    )
    if (rows.length === 0) return null

    return this._rowToEfficiencyScore(rows[0]!)
  }

  async getEfficiencyScores(limit = 20): Promise<EfficiencyScore[]> {
    const rows = await this._adapter.query<EfficiencyScoreRow>(
      `SELECT * FROM efficiency_scores WHERE dispatch_id IS NULL ORDER BY timestamp DESC LIMIT ?`,
      [limit],
    )
    if (rows.length === 0) return []

    return rows.map((row) => this._rowToEfficiencyScore(row))
  }

  async getDispatchEfficiencyScores(storyKey: string): Promise<EfficiencyScore[]> {
    const rows = await this._adapter.query<EfficiencyScoreRow>(
      `SELECT * FROM efficiency_scores WHERE story_key = ? AND dispatch_id IS NOT NULL ORDER BY timestamp ASC`,
      [storyKey],
    )
    if (rows.length === 0) return []

    return rows.map((row) => this._rowToEfficiencyScore(row))
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — recommendations
  // ---------------------------------------------------------------------------

  async saveRecommendations(storyKey: string, recs: Recommendation[]): Promise<void> {
    if (recs.length === 0) return

    await this._adapter.transaction(async (adapter) => {
      for (const rec of recs) {
        // DELETE + INSERT instead of INSERT OR REPLACE
        await adapter.query(
          `DELETE FROM recommendations WHERE id = ?`,
          [rec.id],
        )
        await adapter.query(
          `INSERT INTO recommendations (
            id, story_key, sprint_id, rule_id, severity, title, description,
            potential_savings_tokens, potential_savings_usd, action_target, generated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?
          )`,
          [
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
          ],
        )
      }
    })

    logger.debug({ storyKey, count: recs.length }, 'Saved recommendations')
  }

  async getRecommendations(storyKey: string): Promise<Recommendation[]> {
    const rows = await this._adapter.query<RecommendationRow>(
      `SELECT * FROM recommendations
       WHERE story_key = ?
       ORDER BY
         CASE severity
           WHEN 'critical' THEN 1
           WHEN 'warning' THEN 2
           ELSE 3
         END,
         COALESCE(potential_savings_tokens, 0) DESC`,
      [storyKey],
    )
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

  async getAllRecommendations(limit = 20): Promise<Recommendation[]> {
    const rows = await this._adapter.query<RecommendationRow>(
      `SELECT * FROM recommendations
       ORDER BY
         CASE severity
           WHEN 'critical' THEN 1
           WHEN 'warning' THEN 2
           ELSE 3
         END,
         COALESCE(potential_savings_tokens, 0) DESC
       LIMIT ?`,
      [limit],
    )
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
  // ITelemetryPersistence — category stats
  // ---------------------------------------------------------------------------

  async storeCategoryStats(storyKey: string, stats: CategoryStats[]): Promise<void> {
    if (stats.length === 0) return

    await this._adapter.transaction(async (adapter) => {
      for (const stat of stats) {
        // try/catch around INSERT to emulate INSERT OR IGNORE
        try {
          await adapter.query(
            `INSERT INTO category_stats (
              story_key, category, total_tokens, percentage, event_count,
              avg_tokens_per_event, trend
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              storyKey,
              stat.category,
              stat.totalTokens,
              stat.percentage,
              stat.eventCount,
              stat.avgTokensPerEvent,
              stat.trend,
            ],
          )
        } catch {
          // Row already exists for (story_key, category) — skip (INSERT OR IGNORE semantics)
        }
      }
    })

    logger.debug({ storyKey, count: stats.length }, 'Stored category stats')
  }

  async getCategoryStats(storyKey: string): Promise<CategoryStats[]> {
    // Empty string means "all stories" — use the aggregate query
    const rows = storyKey === ''
      ? await this._adapter.query<CategoryStatsRow>(
          `SELECT category, SUM(total_tokens) AS total_tokens,
                  AVG(percentage) AS percentage,
                  SUM(event_count) AS event_count,
                  AVG(avg_tokens_per_event) AS avg_tokens_per_event,
                  MAX(trend) AS trend
           FROM category_stats
           GROUP BY category
           ORDER BY total_tokens DESC`,
        )
      : await this._adapter.query<CategoryStatsRow>(
          `SELECT * FROM category_stats WHERE story_key = ? ORDER BY total_tokens DESC`,
          [storyKey],
        )
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
  // ITelemetryPersistence — consumer stats
  // ---------------------------------------------------------------------------

  async storeConsumerStats(storyKey: string, consumers: ConsumerStats[]): Promise<void> {
    if (consumers.length === 0) return

    await this._adapter.transaction(async (adapter) => {
      for (const consumer of consumers) {
        // try/catch around INSERT to emulate INSERT OR IGNORE
        try {
          await adapter.query(
            `INSERT INTO consumer_stats (
              story_key, consumer_key, category, total_tokens, percentage,
              event_count, top_invocations_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              storyKey,
              consumer.consumerKey,
              consumer.category,
              consumer.totalTokens,
              consumer.percentage,
              consumer.eventCount,
              JSON.stringify(consumer.topInvocations),
            ],
          )
        } catch {
          // Row already exists for (story_key, consumer_key) — skip (INSERT OR IGNORE semantics)
        }
      }
    })

    logger.debug({ storyKey, count: consumers.length }, 'Stored consumer stats')
  }

  async getConsumerStats(storyKey: string): Promise<ConsumerStats[]> {
    const rows = await this._adapter.query<ConsumerStatsRow>(
      `SELECT * FROM consumer_stats WHERE story_key = ? ORDER BY total_tokens DESC`,
      [storyKey],
    )
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
  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — stale data cleanup (v0.5.9)
  // ---------------------------------------------------------------------------

  /**
   * Delete all telemetry data for a story across all 5 telemetry tables.
   * Used to purge stale data from prior runs before persisting new data.
   */
  async purgeStoryTelemetry(storyKey: string): Promise<void> {
    await this._adapter.transaction(async (adapter) => {
      await adapter.query('DELETE FROM turn_analysis WHERE story_key = ?', [storyKey])
      await adapter.query('DELETE FROM efficiency_scores WHERE story_key = ?', [storyKey])
      await adapter.query('DELETE FROM recommendations WHERE story_key = ?', [storyKey])
      await adapter.query('DELETE FROM category_stats WHERE story_key = ?', [storyKey])
      await adapter.query('DELETE FROM consumer_stats WHERE story_key = ?', [storyKey])
    })
    logger.debug({ storyKey }, 'Purged stale telemetry data for story')
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — OTEL span recording (no-op)
  // ---------------------------------------------------------------------------

  /**
   * Record a named span with arbitrary attributes.
   * Currently logs the span at debug level; no DB persistence.
   */
  recordSpan(span: { name: string; attributes: Record<string, unknown> }): void {
    logger.debug({ span }, 'recordSpan')
  }
}
