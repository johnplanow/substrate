/**
 * TelemetryPipeline — orchestrates the full telemetry analysis pipeline.
 *
 * Processing flow for each batch of raw OTLP payloads:
 *   1. Normalize raw OTLP → NormalizedSpan[] / NormalizedLog[] (TelemetryNormalizer)
 *   2. Analyze turns via dual-track:
 *      a. Span-based: TurnAnalyzer.analyze(spans) → TurnAnalysis[]
 *      b. Log-based:  LogTurnAnalyzer.analyze(logs) → TurnAnalysis[]
 *      c. Merge & deduplicate by spanId (prefer span-derived)
 *   3. Compute category stats → CategoryStats[] (Categorizer)
 *   4. Compute consumer stats → ConsumerStats[] (ConsumerAnalyzer)
 *   5. Score efficiency → EfficiencyScore (EfficiencyScorer) — from merged turns
 *   6. Generate recommendations → Recommendation[] (Recommender) — from merged turns
 *   7. Persist all results (ITelemetryPersistence)
 *
 * Design invariants:
 *   - Constructor injection for all dependencies
 *   - Never throws from processBatch() — errors are caught per-item and logged
 *   - Grouping by storyKey; payloads without a storyKey are skipped at the
 *     analysis stage (normalised data is still stored)
 *   - Log-only path: when no spans are present, LogTurnAnalyzer produces turns.
 *     Category stats: computeCategoryStatsFromTurns(). Consumer stats: analyzeFromTurns().
 *     Recommendations: Recommender.analyze() with allSpans: [].
 *
 * ============================================================================
 * Persistence parity audit (Story 30-4)
 * ============================================================================
 * Both _processStory (span path) and _processStoryFromTurns (log-only path)
 * call all 5 persistence methods via the shared _persistStoryData() helper:
 *
 *   1. storeTurnAnalysis    — turns from TurnAnalyzer or LogTurnAnalyzer
 *   2. storeEfficiencyScore — composite score from EfficiencyScorer
 *   3. storeCategoryStats   — span: computeCategoryStats(); log: computeCategoryStatsFromTurns()
 *   4. storeConsumerStats   — span: consumerAnalyzer.analyze(); log: analyzeFromTurns()
 *   5. saveRecommendations  — Recommender.analyze() with allSpans: spans (span) or [] (log)
 *
 * Additionally: per-dispatch storeEfficiencyScore calls mirror across both paths.
 *
 * Span-only Recommender rules (return [] when allSpans.length === 0, accepted limitation):
 *   - large_file_reads  — requires span.operationName === 'file_read' (not in log turns)
 *   - expensive_bash    — requires span attribute tool.name === 'bash' (not in log turns)
 *   - cache_efficiency  — explicitly checks if (allSpans.length === 0) return []
 * ============================================================================
 */

import { createLogger } from '../../utils/logger.js'
import type { TelemetryNormalizer } from './normalizer.js'
import type { TurnAnalyzer } from './turn-analyzer.js'
import type { LogTurnAnalyzer } from './log-turn-analyzer.js'
import type { Categorizer } from './categorizer.js'
import type { ConsumerAnalyzer } from './consumer-analyzer.js'
import type { EfficiencyScorer } from './efficiency-scorer.js'
import type { Recommender } from './recommender.js'
import type { ITelemetryPersistence } from './persistence.js'
import type { OtlpSource } from './source-detector.js'
import type { DispatchContext } from './ingestion-server.js'
import type {
  NormalizedSpan,
  NormalizedLog,
  TurnAnalysis,
  RecommenderContext,
  CategoryStats,
  ConsumerStats,
  Recommendation,
  EfficiencyScore,
} from './types.js'

const logger = createLogger('telemetry:pipeline')

// ---------------------------------------------------------------------------
// RawOtlpPayload
// ---------------------------------------------------------------------------

/**
 * A single raw OTLP payload as received by the ingestion server.
 */
export interface RawOtlpPayload {
  /** The parsed JSON body of the OTLP request */
  body: unknown
  /** Source detected at ingestion time */
  source: OtlpSource
  /** Unix milliseconds when the payload was received */
  receivedAt: number
  /** Optional dispatch context stamped at ingestion time (Story 30-1) */
  dispatchContext?: DispatchContext
  /** Story key extracted from OTLP resource attributes (substrate.story_key) */
  storyKey?: string
}

// ---------------------------------------------------------------------------
// TelemetryPipelineDeps
// ---------------------------------------------------------------------------

/**
 * All injected dependencies for the TelemetryPipeline.
 */
export interface TelemetryPipelineDeps {
  normalizer: TelemetryNormalizer
  turnAnalyzer: TurnAnalyzer
  logTurnAnalyzer: LogTurnAnalyzer
  categorizer: Categorizer
  consumerAnalyzer: ConsumerAnalyzer
  efficiencyScorer: EfficiencyScorer
  recommender: Recommender
  persistence: ITelemetryPersistence
}

// ---------------------------------------------------------------------------
// StoryPersistenceData
// ---------------------------------------------------------------------------

/**
 * Data bag passed to _persistStoryData — shared by both analysis paths.
 */
interface StoryPersistenceData {
  turns: TurnAnalysis[]
  efficiencyScore: EfficiencyScore
  categoryStats: CategoryStats[]
  consumerStats: ConsumerStats[]
  recommendations: Recommendation[]
  dispatchScores: EfficiencyScore[]
}

// ---------------------------------------------------------------------------
// TelemetryPipeline
// ---------------------------------------------------------------------------

/**
 * Wires together the full OTLP analysis and persistence pipeline.
 *
 * Usage:
 *   const pipeline = new TelemetryPipeline(deps)
 *   await pipeline.processBatch(items)
 */
export class TelemetryPipeline {
  private readonly _normalizer: TelemetryNormalizer
  private readonly _turnAnalyzer: TurnAnalyzer
  private readonly _logTurnAnalyzer: LogTurnAnalyzer
  private readonly _categorizer: Categorizer
  private readonly _consumerAnalyzer: ConsumerAnalyzer
  private readonly _efficiencyScorer: EfficiencyScorer
  private readonly _recommender: Recommender
  private readonly _persistence: ITelemetryPersistence
  /** Stories that have had stale telemetry purged this pipeline lifetime. */
  private readonly _purgedStories = new Set<string>()

  constructor(deps: TelemetryPipelineDeps) {
    this._normalizer = deps.normalizer
    this._turnAnalyzer = deps.turnAnalyzer
    this._logTurnAnalyzer = deps.logTurnAnalyzer
    this._categorizer = deps.categorizer
    this._consumerAnalyzer = deps.consumerAnalyzer
    this._efficiencyScorer = deps.efficiencyScorer
    this._recommender = deps.recommender
    this._persistence = deps.persistence
  }

  // ---------------------------------------------------------------------------
  // processBatch
  // ---------------------------------------------------------------------------

  /**
   * Process a batch of raw OTLP payloads through the full analysis pipeline.
   *
   * Each payload is normalized independently. Spans and logs are grouped by
   * storyKey for per-story analysis. Items that fail normalization are skipped
   * with a warning.
   *
   * Dual-track analysis (Story 27-15):
   *   - Span-derived turns via TurnAnalyzer
   *   - Log-derived turns via LogTurnAnalyzer
   *   - Merged (deduplicated by spanId) before downstream analysis
   */
  async processBatch(items: RawOtlpPayload[]): Promise<void> {
    if (items.length === 0) return

    logger.debug({ count: items.length }, 'TelemetryPipeline.processBatch start')

    // -- Step 1: Normalize all payloads --

    const allSpans: NormalizedSpan[] = []
    const allLogs: NormalizedLog[] = []

    for (const item of items) {
      try {
        const spans = this._normalizer.normalizeSpan(item.body)
        allSpans.push(...spans)
      } catch (err) {
        logger.warn({ err }, 'TelemetryPipeline: normalizeSpan failed — skipping payload')
      }
      try {
        const logs = this._normalizer.normalizeLog(item.body, item.dispatchContext)
        allLogs.push(...logs)
      } catch (err) {
        logger.warn({ err }, 'TelemetryPipeline: normalizeLog failed — skipping payload')
      }
    }

    logger.debug({ spans: allSpans.length, logs: allLogs.length }, 'TelemetryPipeline: normalized batch')

    // AC1: No early return on zero spans — only return if BOTH are empty
    if (allSpans.length === 0 && allLogs.length === 0) {
      logger.debug('TelemetryPipeline: no spans or logs normalized from batch')
      return
    }

    // -- Step 2: Group by storyKey --

    const unknownStoryKey = '__unknown__'

    const spansByStory = new Map<string, NormalizedSpan[]>()
    for (const span of allSpans) {
      const key = span.storyKey ?? unknownStoryKey
      const existing = spansByStory.get(key)
      if (existing !== undefined) {
        existing.push(span)
      } else {
        spansByStory.set(key, [span])
      }
    }

    // AC5: Group logs by storyKey using same extraction logic as spans
    const logsByStory = new Map<string, NormalizedLog[]>()
    for (const log of allLogs) {
      const key = log.storyKey ?? unknownStoryKey
      const existing = logsByStory.get(key)
      if (existing !== undefined) {
        existing.push(log)
      } else {
        logsByStory.set(key, [log])
      }
    }

    // Collect all unique story keys from both sources
    const allStoryKeys = new Set<string>()
    for (const key of spansByStory.keys()) allStoryKeys.add(key)
    for (const key of logsByStory.keys()) allStoryKeys.add(key)

    // -- Step 3: Per-story dual-track analysis and persistence --

    for (const storyKey of allStoryKeys) {
      // Skip data without a story key for the analysis stages
      if (storyKey === unknownStoryKey) {
        const spanCount = spansByStory.get(unknownStoryKey)?.length ?? 0
        const logCount = logsByStory.get(unknownStoryKey)?.length ?? 0
        logger.debug(
          { spanCount, logCount },
          'TelemetryPipeline: data without storyKey — skipping analysis',
        )
        continue
      }

      try {
        const spans = spansByStory.get(storyKey) ?? []
        const logs = logsByStory.get(storyKey) ?? []

        // Dual-track turn analysis (AC2)
        const spanTurns = spans.length > 0 ? this._turnAnalyzer.analyze(spans) : []
        const logTurns = logs.length > 0 ? this._logTurnAnalyzer.analyze(logs) : []
        const mergedTurns = this._mergeTurns(spanTurns, logTurns)

        if (spans.length > 0) {
          // Has spans: full analysis with span-based categorizer/consumer (AC4 compatible)
          await this._processStory(storyKey, spans, mergedTurns)
        } else {
          // Log-only path: efficiency + persistence only (AC3, AC6)
          await this._processStoryFromTurns(storyKey, mergedTurns)
        }
      } catch (err) {
        logger.warn({ err, storyKey }, 'TelemetryPipeline: story processing failed — skipping')
      }
    }

    logger.debug({ storyCount: allStoryKeys.size }, 'TelemetryPipeline.processBatch complete')
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Group turns by dispatchId for per-dispatch scoring.
   * Only turns with a non-empty dispatchId are included.
   */
  private _groupTurnsByDispatchId(turns: TurnAnalysis[]): Map<string, TurnAnalysis[]> {
    const groups = new Map<string, TurnAnalysis[]>()
    for (const turn of turns) {
      if (turn.dispatchId === undefined || turn.dispatchId === '') continue
      const existing = groups.get(turn.dispatchId)
      if (existing !== undefined) {
        existing.push(turn)
      } else {
        groups.set(turn.dispatchId, [turn])
      }
    }
    return groups
  }

  /**
   * Merge span-derived and log-derived turns, deduplicating by spanId.
   * When a span and a log share the same spanId, the span-derived turn is preferred
   * (richer data). The merged result is sorted chronologically and renumbered.
   */
  private _mergeTurns(spanTurns: TurnAnalysis[], logTurns: TurnAnalysis[]): TurnAnalysis[] {
    if (logTurns.length === 0) return spanTurns
    if (spanTurns.length === 0) return logTurns

    const spanTurnIds = new Set(spanTurns.map((t) => t.spanId))
    const uniqueLogTurns = logTurns.filter((t) => !spanTurnIds.has(t.spanId))
    return [...spanTurns, ...uniqueLogTurns]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((t, i) => ({ ...t, turnNumber: i + 1 }))
  }

  /**
   * Full span-based analysis path (unchanged behavior when no logs present — AC4).
   * When mergedTurns is provided, uses those instead of computing from spans alone.
   */
  private async _processStory(
    storyKey: string,
    spans: NormalizedSpan[],
    mergedTurns: TurnAnalysis[],
  ): Promise<void> {
    // Step 2: Turn analysis — use pre-merged turns
    const turns = mergedTurns

    // Step 3: Category stats (span-based — categorizer remains span-only per dev notes)
    const categories = this._categorizer.computeCategoryStats(spans, turns)

    // Step 4: Consumer stats (span-based — consumer analyzer remains span-only per dev notes)
    const consumers = this._consumerAnalyzer.analyze(spans)

    // Step 5: Efficiency score (from merged turns)
    const baseTimestamp = Date.now()
    const storyScore = this._efficiencyScorer.score(storyKey, turns)
    const efficiencyScore = { ...storyScore, timestamp: baseTimestamp }

    // Per-dispatch scoring
    const dispatchGroups = this._groupTurnsByDispatchId(turns)
    const dispatchScores = Array.from(dispatchGroups.entries()).map(([dispatchId, dispatchTurns], idx) => {
      const firstTurn = dispatchTurns[0]
      const scored = this._efficiencyScorer.score(storyKey, dispatchTurns)
      return {
        ...scored,
        timestamp: baseTimestamp + 1 + idx,
        dispatchId,
        taskType: firstTurn?.taskType,
        phase: firstTurn?.phase,
      }
    })

    // Step 6: Recommendations
    const generatedAt = new Date().toISOString()
    const context: RecommenderContext = {
      storyKey,
      generatedAt,
      turns,
      categories,
      consumers,
      efficiencyScore,
      allSpans: spans,
      dispatchScores,
    }
    const recommendations = this._recommender.analyze(context)

    // Step 7: Persist (shared helper — mirrors log-only path)
    await this._persistStoryData(storyKey, {
      turns,
      efficiencyScore,
      categoryStats: categories,
      consumerStats: consumers,
      recommendations,
      dispatchScores,
    })

    logger.info(
      {
        storyKey,
        turns: turns.length,
        compositeScore: efficiencyScore.compositeScore,
        recommendations: recommendations.length,
        dispatchScores: dispatchScores.length,
      },
      'TelemetryPipeline: story analysis complete',
    )
  }

  /**
   * Log-only analysis path: processes turns from LogTurnAnalyzer through full
   * analysis and persistence — mirrors span path via _persistStoryData (Story 30-4).
   */
  private async _processStoryFromTurns(storyKey: string, turns: TurnAnalysis[]): Promise<void> {
    if (turns.length === 0) return

    // Efficiency score from log-derived turns
    const baseTimestamp = Date.now()
    const storyScore = this._efficiencyScorer.score(storyKey, turns)
    const efficiencyScore = { ...storyScore, timestamp: baseTimestamp }

    // Category stats from turns (no raw spans needed)
    const categoryStats = this._categorizer.computeCategoryStatsFromTurns(turns)

    // Consumer stats from turns (AC2 — analyzeFromTurns already exists on ConsumerAnalyzer)
    const consumerStats = this._consumerAnalyzer.analyzeFromTurns(turns)

    // Per-dispatch scoring
    const dispatchGroups = this._groupTurnsByDispatchId(turns)
    const dispatchScores = Array.from(dispatchGroups.entries()).map(([dispatchId, dispatchTurns], idx) => {
      const firstTurn = dispatchTurns[0]
      const scored = this._efficiencyScorer.score(storyKey, dispatchTurns)
      return {
        ...scored,
        timestamp: baseTimestamp + 1 + idx,
        dispatchId,
        taskType: firstTurn?.taskType,
        phase: firstTurn?.phase,
      }
    })

    // Recommendations via Recommender with allSpans: [] (AC3)
    // Rules that require span attributes (large_file_reads, expensive_bash, cache_efficiency)
    // return [] when allSpans is empty — accepted limitation documented in file header.
    const generatedAt = new Date().toISOString()
    const context: RecommenderContext = {
      storyKey,
      generatedAt,
      turns,
      categories: categoryStats,
      consumers: consumerStats,
      efficiencyScore,
      allSpans: [],
      dispatchScores,
    }
    const recommendations = this._recommender.analyze(context)

    // Persist all 5 methods via shared helper (AC4, AC5)
    await this._persistStoryData(storyKey, {
      turns,
      efficiencyScore,
      categoryStats,
      consumerStats,
      recommendations,
      dispatchScores,
    })

    logger.info(
      {
        storyKey,
        turns: turns.length,
        compositeScore: efficiencyScore.compositeScore,
        categories: categoryStats.length,
        recommendations: recommendations.length,
        dispatchScores: dispatchScores.length,
      },
      'TelemetryPipeline: story analysis from turns complete',
    )
  }

  /**
   * Shared persistence helper — called by both _processStory and _processStoryFromTurns.
   * All 5 persistence calls are made here with individual error guards so a single
   * failure does not abort the others (AC5).
   */
  private async _persistStoryData(storyKey: string, data: StoryPersistenceData): Promise<void> {
    const { turns, efficiencyScore, categoryStats, consumerStats, recommendations, dispatchScores } = data

    // Purge stale telemetry from prior runs (once per story per pipeline lifetime)
    if (!this._purgedStories.has(storyKey)) {
      this._purgedStories.add(storyKey)
      await this._persistence.purgeStoryTelemetry(storyKey).catch((err: unknown) =>
        logger.warn({ err, storyKey }, 'Failed to purge stale telemetry — continuing with persist'),
      )
    }

    await Promise.all([
      turns.length > 0
        ? this._persistence.storeTurnAnalysis(storyKey, turns).catch((err: unknown) =>
            logger.warn({ err, storyKey }, 'Failed to store turn analysis'),
          )
        : Promise.resolve(),
      this._persistence.storeEfficiencyScore(efficiencyScore).catch((err: unknown) =>
        logger.warn({ err, storyKey }, 'Failed to store efficiency score'),
      ),
      categoryStats.length > 0
        ? this._persistence.storeCategoryStats(storyKey, categoryStats).catch((err: unknown) =>
            logger.warn({ err, storyKey }, 'Failed to store category stats'),
          )
        : Promise.resolve(),
      consumerStats.length > 0
        ? this._persistence.storeConsumerStats(storyKey, consumerStats).catch((err: unknown) =>
            logger.warn({ err, storyKey }, 'Failed to store consumer stats'),
          )
        : Promise.resolve(),
      recommendations.length > 0
        ? this._persistence.saveRecommendations(storyKey, recommendations).catch((err: unknown) =>
            logger.warn({ err, storyKey }, 'Failed to save recommendations'),
          )
        : Promise.resolve(),
      ...dispatchScores.map((ds) =>
        this._persistence.storeEfficiencyScore(ds).catch((err: unknown) =>
          logger.warn({ err, storyKey, dispatchId: ds.dispatchId }, 'Failed to store dispatch efficiency score'),
        ),
      ),
    ])
  }
}
