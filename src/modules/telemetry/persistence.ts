/**
 * TelemetryPersistence — DatabaseAdapter-backed persistence for telemetry data.
 *
 * Implements ITelemetryPersistence using the generic DatabaseAdapter interface
 * (async query/exec/transaction). Telemetry can be persisted to any backend
 * (Dolt, InMemory, or WASM SQLite in tests).
 *
 * Note: This class now delegates to AdapterTelemetryPersistence.
 */

import type { DatabaseAdapter } from '../../persistence/adapter.js'
import { AdapterTelemetryPersistence } from './adapter-persistence.js'
import type {
  TurnAnalysis,
  EfficiencyScore,
  Recommendation,
  CategoryStats,
  ConsumerStats,
} from './types.js'

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
   * Only returns story-aggregate scores (dispatch_id IS NULL).
   */
  getEfficiencyScores(limit?: number): Promise<EfficiencyScore[]>

  /**
   * Retrieve per-dispatch efficiency scores for a specific story.
   * Returns only scores where dispatch_id IS NOT NULL, ordered by timestamp ASC.
   */
  getDispatchEfficiencyScores(storyKey: string): Promise<EfficiencyScore[]>

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

  // -- Stale data cleanup (v0.5.9) --------------------------------------------

  /**
   * Delete all telemetry data for a story (turn_analysis, efficiency_scores,
   * recommendations, category_stats, consumer_stats).
   * Called before persisting new data for a re-run story to prevent stale
   * rows from prior runs lingering in the database.
   */
  purgeStoryTelemetry(storyKey: string): Promise<void>

  // -- OTEL span recording (story 28-6) --------------------------------------

  /**
   * Record a named span with arbitrary attributes.
   * Used by RoutingTelemetry and RepoMapTelemetry to emit routing/repo-map spans.
   * Implementations may persist to DB, log, or no-op.
   */
  recordSpan(span: { name: string; attributes: Record<string, unknown> }): void
}

// ---------------------------------------------------------------------------
// TelemetryPersistence
// ---------------------------------------------------------------------------

/**
 * Concrete DatabaseAdapter-backed telemetry persistence.
 *
 * Accepts a DatabaseAdapter and delegates all operations to
 * AdapterTelemetryPersistence. Provides schema initialization via initSchema().
 *
 * Accepts a DatabaseAdapter and uses it for all persistence operations.
 */
export class TelemetryPersistence implements ITelemetryPersistence {
  private readonly _impl: AdapterTelemetryPersistence

  constructor(adapter: DatabaseAdapter) {
    this._impl = new AdapterTelemetryPersistence(adapter)
  }

  // ---------------------------------------------------------------------------
  // Schema initialization
  // ---------------------------------------------------------------------------

  /**
   * Apply the telemetry schema DDL to the database.
   * Idempotent — uses CREATE TABLE IF NOT EXISTS.
   */
  async initSchema(): Promise<void> {
    await this._impl.initSchema()
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — turn analysis
  // ---------------------------------------------------------------------------

  async storeTurnAnalysis(storyKey: string, turns: TurnAnalysis[]): Promise<void> {
    return this._impl.storeTurnAnalysis(storyKey, turns)
  }

  async getTurnAnalysis(storyKey: string): Promise<TurnAnalysis[]> {
    return this._impl.getTurnAnalysis(storyKey)
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — efficiency scores
  // ---------------------------------------------------------------------------

  async storeEfficiencyScore(score: EfficiencyScore): Promise<void> {
    return this._impl.storeEfficiencyScore(score)
  }

  async getEfficiencyScore(storyKey: string): Promise<EfficiencyScore | null> {
    return this._impl.getEfficiencyScore(storyKey)
  }

  async getEfficiencyScores(limit = 20): Promise<EfficiencyScore[]> {
    return this._impl.getEfficiencyScores(limit)
  }

  async getDispatchEfficiencyScores(storyKey: string): Promise<EfficiencyScore[]> {
    return this._impl.getDispatchEfficiencyScores(storyKey)
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — recommendations (story 27-7)
  // ---------------------------------------------------------------------------

  async saveRecommendations(storyKey: string, recs: Recommendation[]): Promise<void> {
    return this._impl.saveRecommendations(storyKey, recs)
  }

  async getRecommendations(storyKey: string): Promise<Recommendation[]> {
    return this._impl.getRecommendations(storyKey)
  }

  async getAllRecommendations(limit = 20): Promise<Recommendation[]> {
    return this._impl.getAllRecommendations(limit)
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — category stats (story 27-5)
  // ---------------------------------------------------------------------------

  async storeCategoryStats(storyKey: string, stats: CategoryStats[]): Promise<void> {
    return this._impl.storeCategoryStats(storyKey, stats)
  }

  async getCategoryStats(storyKey: string): Promise<CategoryStats[]> {
    return this._impl.getCategoryStats(storyKey)
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — consumer stats (story 27-5)
  // ---------------------------------------------------------------------------

  async storeConsumerStats(storyKey: string, consumers: ConsumerStats[]): Promise<void> {
    return this._impl.storeConsumerStats(storyKey, consumers)
  }

  async getConsumerStats(storyKey: string): Promise<ConsumerStats[]> {
    return this._impl.getConsumerStats(storyKey)
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — stale data cleanup (v0.5.9)
  // ---------------------------------------------------------------------------

  async purgeStoryTelemetry(storyKey: string): Promise<void> {
    return this._impl.purgeStoryTelemetry(storyKey)
  }

  // ---------------------------------------------------------------------------
  // ITelemetryPersistence — OTEL span recording (story 28-6)
  // ---------------------------------------------------------------------------

  /**
   * Record a named span with arbitrary attributes.
   * Currently logs the span at debug level; no DB persistence.
   */
  recordSpan(span: { name: string; attributes: Record<string, unknown> }): void {
    this._impl.recordSpan(span)
  }
}
