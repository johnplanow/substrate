/**
 * TelemetryPipeline — orchestrates the full telemetry analysis pipeline.
 *
 * Processing flow for each batch of raw OTLP payloads:
 *   1. Normalize raw OTLP → NormalizedSpan[] / NormalizedLog[] (TelemetryNormalizer)
 *   2. Analyze spans per story → TurnAnalysis[] (TurnAnalyzer)
 *   3. Compute category stats → CategoryStats[] (Categorizer)
 *   4. Compute consumer stats → ConsumerStats[] (ConsumerAnalyzer)
 *   5. Score efficiency → EfficiencyScore (EfficiencyScorer)
 *   6. Generate recommendations → Recommendation[] (Recommender)
 *   7. Persist all results (ITelemetryPersistence)
 *
 * Design invariants:
 *   - Constructor injection for all dependencies
 *   - Never throws from processBatch() — errors are caught per-item and logged
 *   - Grouping by storyKey; payloads without a storyKey are skipped at the
 *     analysis stage (normalised data is still stored)
 */

import { createLogger } from '../../utils/logger.js'
import type { TelemetryNormalizer } from './normalizer.js'
import type { TurnAnalyzer } from './turn-analyzer.js'
import type { Categorizer } from './categorizer.js'
import type { ConsumerAnalyzer } from './consumer-analyzer.js'
import type { EfficiencyScorer } from './efficiency-scorer.js'
import type { Recommender } from './recommender.js'
import type { ITelemetryPersistence } from './persistence.js'
import type { OtlpSource } from './source-detector.js'
import type { NormalizedSpan, NormalizedLog, RecommenderContext } from './types.js'

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
  categorizer: Categorizer
  consumerAnalyzer: ConsumerAnalyzer
  efficiencyScorer: EfficiencyScorer
  recommender: Recommender
  persistence: ITelemetryPersistence
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
  private readonly _categorizer: Categorizer
  private readonly _consumerAnalyzer: ConsumerAnalyzer
  private readonly _efficiencyScorer: EfficiencyScorer
  private readonly _recommender: Recommender
  private readonly _persistence: ITelemetryPersistence

  constructor(deps: TelemetryPipelineDeps) {
    this._normalizer = deps.normalizer
    this._turnAnalyzer = deps.turnAnalyzer
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
   * Each payload is normalized independently. Spans are then grouped by storyKey
   * for per-story analysis. Items that fail normalization are skipped with a warning.
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
        const logs = this._normalizer.normalizeLog(item.body)
        allLogs.push(...logs)
      } catch (err) {
        logger.warn({ err }, 'TelemetryPipeline: normalizeLog failed — skipping payload')
      }
    }

    logger.debug({ spans: allSpans.length, logs: allLogs.length }, 'TelemetryPipeline: normalized batch')

    if (allSpans.length === 0) {
      logger.debug('TelemetryPipeline: no spans normalized from batch')
      return
    }

    // -- Step 2: Group by storyKey --

    const spansByStory = new Map<string, NormalizedSpan[]>()
    const unknownStoryKey = '__unknown__'

    for (const span of allSpans) {
      const key = span.storyKey ?? unknownStoryKey
      const existing = spansByStory.get(key)
      if (existing !== undefined) {
        existing.push(span)
      } else {
        spansByStory.set(key, [span])
      }
    }

    // -- Step 3: Per-story analysis and persistence --

    for (const [storyKey, spans] of spansByStory) {
      // Skip spans without a story key for the analysis stages
      if (storyKey === unknownStoryKey) {
        logger.debug({ spanCount: spans.length }, 'TelemetryPipeline: spans without storyKey — skipping analysis')
        continue
      }

      try {
        await this._processStory(storyKey, spans)
      } catch (err) {
        logger.warn({ err, storyKey }, 'TelemetryPipeline: story processing failed — skipping')
      }
    }

    logger.debug({ storyCount: spansByStory.size }, 'TelemetryPipeline.processBatch complete')
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _processStory(storyKey: string, spans: NormalizedSpan[]): Promise<void> {
    // Step 2: Turn analysis
    const turns = this._turnAnalyzer.analyze(spans)

    // Step 3: Category stats
    const categories = this._categorizer.computeCategoryStats(spans, turns)

    // Step 4: Consumer stats
    const consumers = this._consumerAnalyzer.analyze(spans)

    // Step 5: Efficiency score
    const efficiencyScore = this._efficiencyScorer.score(storyKey, turns)

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
    }
    const recommendations = this._recommender.analyze(context)

    // Step 7: Persist
    await Promise.all([
      turns.length > 0
        ? this._persistence.storeTurnAnalysis(storyKey, turns).catch((err: unknown) =>
            logger.warn({ err, storyKey }, 'Failed to store turn analysis'),
          )
        : Promise.resolve(),
      categories.length > 0
        ? this._persistence.storeCategoryStats(storyKey, categories).catch((err: unknown) =>
            logger.warn({ err, storyKey }, 'Failed to store category stats'),
          )
        : Promise.resolve(),
      consumers.length > 0
        ? this._persistence.storeConsumerStats(storyKey, consumers).catch((err: unknown) =>
            logger.warn({ err, storyKey }, 'Failed to store consumer stats'),
          )
        : Promise.resolve(),
      this._persistence.storeEfficiencyScore(efficiencyScore).catch((err: unknown) =>
        logger.warn({ err, storyKey }, 'Failed to store efficiency score'),
      ),
      recommendations.length > 0
        ? this._persistence.saveRecommendations(storyKey, recommendations).catch((err: unknown) =>
            logger.warn({ err, storyKey }, 'Failed to save recommendations'),
          )
        : Promise.resolve(),
    ])

    logger.info(
      {
        storyKey,
        turns: turns.length,
        compositeScore: efficiencyScore.compositeScore,
        recommendations: recommendations.length,
      },
      'TelemetryPipeline: story analysis complete',
    )
  }
}
