/**
 * TelemetryPipeline — orchestrates the full telemetry analysis pipeline.
 *
 * Processing flow for each batch of raw OTLP payloads:
 *   1. Normalize raw OTLP → NormalizedSpan[] / NormalizedLog[] (TelemetryNormalizer)
 *   2. Analyze turns via dual-track:
 *      a. Span-based: ITurnAnalyzer.analyze(spans) → TurnAnalysis[]
 *      b. Log-based:  ILogTurnAnalyzer.analyze(logs) → TurnAnalysis[]
 *      c. Merge & deduplicate by spanId (prefer span-derived)
 *   3. Compute category stats → CategoryStats[] (ICategorizer)
 *   4. Compute consumer stats → ConsumerStats[] (IConsumerAnalyzer)
 *   5. Score efficiency → EfficiencyScore (IEfficiencyScorer) — from merged turns
 *   6. Generate recommendations → Recommendation[] (IRecommender) — from merged turns
 *   7. Persist all results (ITelemetryPersistence)
 *
 * Design invariants:
 *   - Constructor injection for all dependencies
 *   - Never throws from processBatch() — errors are caught per-item and logged
 *   - Grouping by storyKey; payloads without a storyKey are skipped at the
 *     analysis stage (normalised data is still stored)
 *   - Log-only path: when no spans are present, ILogTurnAnalyzer produces turns.
 *
 * Duck-typed interfaces for scoring deps (implementations migrate in 41-6b).
 * This allows the core package to be self-contained without importing from
 * the monolith's scoring modules.
 */

import type { ILogger } from '../dispatch/types.js'
import type { TelemetryNormalizer } from './normalizer.js'
import type {
  NormalizedSpan,
  NormalizedLog,
  TurnAnalysis,
  RecommenderContext,
  CategoryStats,
  ConsumerStats,
  Recommendation,
  EfficiencyScore,
  RawOtlpPayload,
  ITelemetryPersistence,
  IRecommender,
} from './types.js'

// ---------------------------------------------------------------------------
// Duck-typed scoring interfaces (implementations in story 41-6b)
// ---------------------------------------------------------------------------

export interface ITurnAnalyzer {
  analyze(spans: NormalizedSpan[]): TurnAnalysis[]
}

export interface ILogTurnAnalyzer {
  analyze(logs: NormalizedLog[]): TurnAnalysis[]
}

export interface ICategorizer {
  computeCategoryStats(spans: NormalizedSpan[], turns: TurnAnalysis[]): CategoryStats[]
  computeCategoryStatsFromTurns(turns: TurnAnalysis[]): CategoryStats[]
}

export interface IConsumerAnalyzer {
  analyze(spans: NormalizedSpan[]): ConsumerStats[]
  analyzeFromTurns(turns: TurnAnalysis[]): ConsumerStats[]
}

export interface IEfficiencyScorer {
  score(storyKey: string, turns: TurnAnalysis[]): EfficiencyScore
}

// ---------------------------------------------------------------------------
// TelemetryPipelineDeps
// ---------------------------------------------------------------------------

/**
 * All injected dependencies for the TelemetryPipeline.
 * Concrete implementations satisfy these duck-typed interfaces structurally.
 */
export interface TelemetryPipelineDeps {
  normalizer: TelemetryNormalizer
  turnAnalyzer: ITurnAnalyzer
  logTurnAnalyzer: ILogTurnAnalyzer
  categorizer: ICategorizer
  consumerAnalyzer: IConsumerAnalyzer
  efficiencyScorer: IEfficiencyScorer
  recommender: IRecommender
  persistence: ITelemetryPersistence
  logger?: ILogger
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
  private readonly _turnAnalyzer: ITurnAnalyzer
  private readonly _logTurnAnalyzer: ILogTurnAnalyzer
  private readonly _categorizer: ICategorizer
  private readonly _consumerAnalyzer: IConsumerAnalyzer
  private readonly _efficiencyScorer: IEfficiencyScorer
  private readonly _recommender: IRecommender
  private readonly _persistence: ITelemetryPersistence
  private readonly _logger: ILogger
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
    this._logger = deps.logger ?? console
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
   * Dual-track analysis:
   *   - Span-derived turns via ITurnAnalyzer
   *   - Log-derived turns via ILogTurnAnalyzer
   *   - Merged (deduplicated by spanId) before downstream analysis
   */
  async processBatch(items: RawOtlpPayload[]): Promise<void> {
    if (items.length === 0) return

    this._logger.debug({ count: items.length }, 'TelemetryPipeline.processBatch start')

    // -- Step 1: Normalize all payloads --

    const allSpans: NormalizedSpan[] = []
    const allLogs: NormalizedLog[] = []

    for (const item of items) {
      try {
        const spans = this._normalizer.normalizeSpan(item.body)
        allSpans.push(...spans)
      } catch (err) {
        this._logger.warn({ err }, 'TelemetryPipeline: normalizeSpan failed — skipping payload')
      }
      try {
        const logs = this._normalizer.normalizeLog(item.body, item.dispatchContext)
        allLogs.push(...logs)
      } catch (err) {
        this._logger.warn({ err }, 'TelemetryPipeline: normalizeLog failed — skipping payload')
      }
    }

    this._logger.debug(
      { spans: allSpans.length, logs: allLogs.length },
      'TelemetryPipeline: normalized batch'
    )

    // AC1: No early return on zero spans — only return if BOTH are empty
    if (allSpans.length === 0 && allLogs.length === 0) {
      this._logger.debug('TelemetryPipeline: no spans or logs normalized from batch')
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
        this._logger.debug(
          { spanCount, logCount },
          'TelemetryPipeline: data without storyKey — skipping analysis'
        )
        continue
      }

      try {
        const spans = spansByStory.get(storyKey) ?? []
        const logs = logsByStory.get(storyKey) ?? []

        // Dual-track turn analysis
        const spanTurns = spans.length > 0 ? this._turnAnalyzer.analyze(spans) : []
        const logTurns = logs.length > 0 ? this._logTurnAnalyzer.analyze(logs) : []
        const mergedTurns = this._mergeTurns(spanTurns, logTurns)

        if (spans.length > 0) {
          // Has spans: full analysis with span-based categorizer/consumer
          await this._processStory(storyKey, spans, mergedTurns)
        } else {
          // Log-only path: efficiency + persistence only
          await this._processStoryFromTurns(storyKey, mergedTurns)
        }
      } catch (err) {
        this._logger.warn(
          { err, storyKey },
          'TelemetryPipeline: story processing failed — skipping'
        )
      }
    }

    this._logger.debug({ storyCount: allStoryKeys.size }, 'TelemetryPipeline.processBatch complete')
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
   * Full span-based analysis path.
   */
  private async _processStory(
    storyKey: string,
    spans: NormalizedSpan[],
    mergedTurns: TurnAnalysis[]
  ): Promise<void> {
    // Step 2: Turn analysis — use pre-merged turns
    const turns = mergedTurns

    // Step 3: Category stats (span-based)
    const categories = this._categorizer.computeCategoryStats(spans, turns)

    // Step 4: Consumer stats (span-based)
    const consumers = this._consumerAnalyzer.analyze(spans)

    // Step 5: Efficiency score (from merged turns)
    const baseTimestamp = Date.now()
    const storyScore = this._efficiencyScorer.score(storyKey, turns)
    const efficiencyScore = { ...storyScore, timestamp: baseTimestamp }

    // Per-dispatch scoring
    const dispatchGroups = this._groupTurnsByDispatchId(turns)
    const dispatchScores = Array.from(dispatchGroups.entries()).map(
      ([dispatchId, dispatchTurns], idx) => {
        const firstTurn = dispatchTurns[0]
        const scored = this._efficiencyScorer.score(storyKey, dispatchTurns)
        return {
          ...scored,
          timestamp: baseTimestamp + 1 + idx,
          dispatchId,
          taskType: firstTurn?.taskType,
          phase: firstTurn?.phase,
        }
      }
    )

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

    this._logger.info(
      {
        storyKey,
        turns: turns.length,
        compositeScore: efficiencyScore.compositeScore,
        recommendations: recommendations.length,
        dispatchScores: dispatchScores.length,
      },
      'TelemetryPipeline: story analysis complete'
    )
  }

  /**
   * Log-only analysis path: processes turns from ILogTurnAnalyzer through full
   * analysis and persistence.
   */
  private async _processStoryFromTurns(storyKey: string, turns: TurnAnalysis[]): Promise<void> {
    if (turns.length === 0) return

    // Efficiency score from log-derived turns
    const baseTimestamp = Date.now()
    const storyScore = this._efficiencyScorer.score(storyKey, turns)
    const efficiencyScore = { ...storyScore, timestamp: baseTimestamp }

    // Category stats from turns (no raw spans needed)
    const categoryStats = this._categorizer.computeCategoryStatsFromTurns(turns)

    // Consumer stats from turns
    const consumerStats = this._consumerAnalyzer.analyzeFromTurns(turns)

    // Per-dispatch scoring
    const dispatchGroups = this._groupTurnsByDispatchId(turns)
    const dispatchScores = Array.from(dispatchGroups.entries()).map(
      ([dispatchId, dispatchTurns], idx) => {
        const firstTurn = dispatchTurns[0]
        const scored = this._efficiencyScorer.score(storyKey, dispatchTurns)
        return {
          ...scored,
          timestamp: baseTimestamp + 1 + idx,
          dispatchId,
          taskType: firstTurn?.taskType,
          phase: firstTurn?.phase,
        }
      }
    )

    // Recommendations via Recommender with allSpans: []
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

    // Persist all 5 methods via shared helper
    await this._persistStoryData(storyKey, {
      turns,
      efficiencyScore,
      categoryStats,
      consumerStats,
      recommendations,
      dispatchScores,
    })

    this._logger.info(
      {
        storyKey,
        turns: turns.length,
        compositeScore: efficiencyScore.compositeScore,
        categories: categoryStats.length,
        recommendations: recommendations.length,
        dispatchScores: dispatchScores.length,
      },
      'TelemetryPipeline: story analysis from turns complete'
    )
  }

  /**
   * Shared persistence helper — called by both _processStory and _processStoryFromTurns.
   * All 5 persistence calls are made here with individual error guards so a single
   * failure does not abort the others.
   */
  private async _persistStoryData(storyKey: string, data: StoryPersistenceData): Promise<void> {
    const {
      turns,
      efficiencyScore,
      categoryStats,
      consumerStats,
      recommendations,
      dispatchScores,
    } = data

    // Purge stale telemetry from prior runs (once per story per pipeline lifetime)
    if (!this._purgedStories.has(storyKey)) {
      this._purgedStories.add(storyKey)
      await this._persistence
        .purgeStoryTelemetry(storyKey)
        .catch((err: unknown) =>
          this._logger.warn(
            { err, storyKey },
            'Failed to purge stale telemetry — continuing with persist'
          )
        )
    }

    await Promise.all([
      turns.length > 0
        ? this._persistence
            .storeTurnAnalysis(storyKey, turns)
            .catch((err: unknown) =>
              this._logger.warn({ err, storyKey }, 'Failed to store turn analysis')
            )
        : Promise.resolve(),
      this._persistence
        .storeEfficiencyScore(efficiencyScore)
        .catch((err: unknown) =>
          this._logger.warn({ err, storyKey }, 'Failed to store efficiency score')
        ),
      categoryStats.length > 0
        ? this._persistence
            .storeCategoryStats(storyKey, categoryStats)
            .catch((err: unknown) =>
              this._logger.warn({ err, storyKey }, 'Failed to store category stats')
            )
        : Promise.resolve(),
      consumerStats.length > 0
        ? this._persistence
            .storeConsumerStats(storyKey, consumerStats)
            .catch((err: unknown) =>
              this._logger.warn({ err, storyKey }, 'Failed to store consumer stats')
            )
        : Promise.resolve(),
      recommendations.length > 0
        ? this._persistence
            .saveRecommendations(storyKey, recommendations)
            .catch((err: unknown) =>
              this._logger.warn({ err, storyKey }, 'Failed to save recommendations')
            )
        : Promise.resolve(),
      ...dispatchScores.map((ds) =>
        this._persistence
          .storeEfficiencyScore(ds)
          .catch((err: unknown) =>
            this._logger.warn(
              { err, storyKey, dispatchId: ds.dispatchId },
              'Failed to store dispatch efficiency score'
            )
          )
      ),
    ])
  }
}
