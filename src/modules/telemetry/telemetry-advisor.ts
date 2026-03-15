/**
 * TelemetryAdvisor — reads persisted efficiency scores to inform retry decisions.
 *
 * Provides a thin query façade over ITelemetryPersistence for use by
 * CLI commands that need efficiency data before dispatching (Story 30-8).
 *
 * Architecture:
 *   - Constructor-injected DatabaseAdapter
 *   - Zero LLM calls — pure DB reads
 *   - Returns null when no data is available (graceful degradation)
 */

import type { DatabaseAdapter } from '../../persistence/adapter.js'
import { TelemetryPersistence } from './persistence.js'
import type { EfficiencyScore, Recommendation } from './types.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('telemetry-advisor')

// ---------------------------------------------------------------------------
// TelemetryAdvisorDeps
// ---------------------------------------------------------------------------

export interface TelemetryAdvisorDeps {
  /** Database adapter used to read telemetry data */
  db: DatabaseAdapter
}

// ---------------------------------------------------------------------------
// EfficiencyProfile
// ---------------------------------------------------------------------------

/**
 * A condensed efficiency profile for a story, derived from its stored
 * EfficiencyScore. Provides the sub-scores needed for gate decisions.
 */
export interface EfficiencyProfile {
  /** Story key this profile belongs to */
  storyKey: string
  /** Composite 0-100 efficiency score */
  compositeScore: number
  /** Cache hit sub-score 0-100 */
  cacheHitSubScore: number
  /** I/O ratio sub-score 0-100 */
  ioRatioSubScore: number
  /** Context management sub-score 0-100 */
  contextManagementSubScore: number
  /** Total number of turns analyzed */
  totalTurns: number
  /** Number of context spike events */
  contextSpikeCount: number
}

// ---------------------------------------------------------------------------
// TelemetryAdvisor
// ---------------------------------------------------------------------------

/**
 * Reads telemetry efficiency data to support retry gate decisions.
 */
export class TelemetryAdvisor {
  private readonly _persistence: TelemetryPersistence

  constructor(deps: TelemetryAdvisorDeps) {
    this._persistence = new TelemetryPersistence(deps.db)
  }

  /**
   * Retrieve the efficiency profile for a story.
   *
   * Returns null when no efficiency score has been persisted for the story
   * (e.g. first run, telemetry disabled, or no turns recorded).
   *
   * @param storyKey - The story identifier (e.g. "30-5")
   * @returns EfficiencyProfile or null
   */
  async getEfficiencyProfile(storyKey: string): Promise<EfficiencyProfile | null> {
    try {
      const score: EfficiencyScore | null = await this._persistence.getEfficiencyScore(storyKey)
      if (score === null) {
        logger.debug({ storyKey }, 'No efficiency score found for story')
        return null
      }

      return {
        storyKey: score.storyKey,
        compositeScore: score.compositeScore,
        cacheHitSubScore: score.cacheHitSubScore,
        ioRatioSubScore: score.ioRatioSubScore,
        contextManagementSubScore: score.contextManagementSubScore,
        totalTurns: score.totalTurns,
        contextSpikeCount: score.contextSpikeCount,
      }
    } catch (err) {
      logger.warn({ err, storyKey }, 'Failed to retrieve efficiency score')
      return null
    }
  }

  /**
   * Aggregate recommendations across all completed stories in a run.
   *
   * Queries getRecommendations() for each storyKey in parallel, merges results,
   * deduplicates by recommendation id (first occurrence wins), and sorts by
   * severity: critical → warning → info.
   *
   * Returns an empty array when completedStoryKeys is empty or no recommendations exist.
   *
   * @param completedStoryKeys - Story keys that have already finished in this run
   * @returns Merged, deduplicated, sorted recommendations
   */
  async getRecommendationsForRun(completedStoryKeys: string[]): Promise<Recommendation[]> {
    if (completedStoryKeys.length === 0) return []

    try {
      const results = await Promise.all(
        completedStoryKeys.map((key) => this._persistence.getRecommendations(key)),
      )

      const seen = new Set<string>()
      const merged: Recommendation[] = []
      for (const recs of results) {
        for (const rec of recs) {
          if (!seen.has(rec.id)) {
            seen.add(rec.id)
            merged.push(rec)
          }
        }
      }

      const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 }
      merged.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3))

      return merged
    } catch (err) {
      logger.warn({ err }, 'Failed to retrieve recommendations for run — returning empty')
      return []
    }
  }

  /**
   * Format a list of recommendations as optimization directives for prompt injection.
   *
   * Filters to only critical and warning items, formats each as a natural-language
   * OPTIMIZATION line, and truncates to a maximum of 2000 characters at a word boundary.
   *
   * Returns an empty string when no critical or warning recommendations are present.
   *
   * @param recommendations - Recommendations to format (typically from getRecommendationsForRun)
   * @returns Formatted directives string, or "" if nothing actionable
   */
  formatOptimizationDirectives(recommendations: Recommendation[]): string {
    const MAX_CHARS = 2000
    const actionable = recommendations.filter(
      (r) => r.severity === 'critical' || r.severity === 'warning',
    )
    if (actionable.length === 0) return ''

    const lines = actionable.map(
      (r) => `OPTIMIZATION (${r.severity}): ${r.title}. ${r.description}`,
    )
    const full = lines.join('\n')

    if (full.length <= MAX_CHARS) {
      logger.debug({ count: actionable.length, chars: full.length }, 'Formatting optimization directives')
      return full
    }

    // Truncate at word boundary to avoid mid-word cuts
    const cutAt = full.lastIndexOf(' ', MAX_CHARS)
    const truncated = (cutAt > 0 ? full.slice(0, cutAt) : full.slice(0, MAX_CHARS)) + '…'
    logger.debug(
      { count: actionable.length, chars: truncated.length },
      'Optimization directives truncated to budget',
    )
    return truncated
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a TelemetryAdvisor for the given database adapter.
 */
export function createTelemetryAdvisor(deps: TelemetryAdvisorDeps): TelemetryAdvisor {
  return new TelemetryAdvisor(deps)
}
