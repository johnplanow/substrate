/**
 * RoutingRecommender — analyzes per-phase token breakdown history and generates
 * model routing recommendations.
 *
 * High output ratios (output / (input + output) > 0.40) indicate the model is
 * doing more generation work than context consumption, suggesting an upgrade may
 * be justified.  Low output ratios (< 0.15) indicate mostly context-reading work
 * where a cheaper model should suffice, triggering a downgrade recommendation.
 *
 * References:
 *  - Epic 28, Story 28-8: Feedback Loop — Telemetry-Driven Routing Tuning
 */

import type { ILogger } from '../dispatch/types.js'
import type { ModelRoutingConfig } from './model-routing-config.js'
import type {
  PhaseTokenBreakdown,
  PhaseTokenEntry,
  RoutingAnalysis,
  RoutingRecommendation,
} from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Ordered tier list: index 0 = cheapest / smallest, index N = most expensive / largest.
 * Tiers are determined by substring matching — e.g. 'claude-haiku-4-5' → tier 1.
 */
const TIER_KEYWORDS: Array<{ keyword: string; tier: number }> = [
  { keyword: 'haiku', tier: 1 },
  { keyword: 'sonnet', tier: 2 },
  { keyword: 'opus', tier: 3 },
]

/** Minimum historical breakdowns required before any recommendations are generated. */
const MIN_BREAKDOWNS = 3

/** Output ratio below this threshold triggers a downgrade recommendation. */
const DOWNGRADE_THRESHOLD = 0.15

/** Output ratio above this threshold triggers an upgrade recommendation. */
const UPGRADE_THRESHOLD = 0.40

/** Ordered list of model name fragments by tier (cheapest → most expensive). */
const TIER_TO_MODEL_FRAGMENT: Record<number, string> = {
  1: 'haiku',
  2: 'sonnet',
  3: 'opus',
}

// ---------------------------------------------------------------------------
// RoutingRecommender
// ---------------------------------------------------------------------------

/**
 * Analyzes phase-level token breakdown history and produces routing
 * recommendations based on observed output ratios.
 *
 * This class is stateless: call `analyze()` with historical breakdowns to
 * get fresh recommendations each time.
 */
export class RoutingRecommender {
  private readonly _logger: ILogger

  constructor(logger: ILogger) {
    this._logger = logger
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Determine the model tier (1=haiku, 2=sonnet, 3=opus) for a given model name.
   * Defaults to tier 2 (sonnet) when no keyword matches.
   */
  private _getTier(model: string): number {
    const lower = model.toLowerCase()
    for (const { keyword, tier } of TIER_KEYWORDS) {
      if (lower.includes(keyword)) return tier
    }
    return 2 // default: sonnet tier
  }

  /**
   * Get the canonical model keyword fragment for a given tier.
   */
  private _getTierKeyword(tier: number): string {
    return TIER_TO_MODEL_FRAGMENT[tier] ?? 'sonnet'
  }

  /**
   * Compute the output ratio for a set of phase token entries:
   *   outputRatio = sum(outputTokens) / (sum(inputTokens) + sum(outputTokens))
   *
   * Returns 0.5 when the total token count is zero to avoid division by zero.
   */
  private _computeOutputRatio(entries: PhaseTokenEntry[]): number {
    let totalInput = 0
    let totalOutput = 0
    for (const entry of entries) {
      totalInput += entry.inputTokens
      totalOutput += entry.outputTokens
    }
    const total = totalInput + totalOutput
    if (total === 0) return 0.5
    return totalOutput / total
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Analyze historical phase token breakdowns and produce routing recommendations.
   *
   * @param breakdowns - Historical PhaseTokenBreakdown records (one per pipeline run)
   * @param config     - Current model routing configuration
   * @returns RoutingAnalysis with recommendations and per-phase output ratios
   */
  analyze(breakdowns: PhaseTokenBreakdown[], config: ModelRoutingConfig): RoutingAnalysis {
    if (breakdowns.length < MIN_BREAKDOWNS) {
      this._logger.debug(
        { dataPoints: breakdowns.length, threshold: MIN_BREAKDOWNS, reason: 'insufficient_data' },
        'Insufficient data for routing analysis',
      )
      return {
        recommendations: [],
        analysisRuns: breakdowns.length,
        insufficientData: true,
        phaseOutputRatios: {},
      }
    }

    // Group all entries by phase across all breakdowns
    const phaseEntries: Record<string, PhaseTokenEntry[]> = {}
    for (const breakdown of breakdowns) {
      for (const entry of breakdown.entries) {
        const phase = entry.phase
        if (phaseEntries[phase] === undefined) {
          phaseEntries[phase] = []
        }
        phaseEntries[phase].push(entry)
      }
    }

    // Compute output ratio per phase
    const phaseOutputRatios: Record<string, number> = {}
    for (const [phase, entries] of Object.entries(phaseEntries)) {
      phaseOutputRatios[phase] = this._computeOutputRatio(entries)
    }

    // Generate recommendations per phase
    const recommendations: RoutingRecommendation[] = []
    const confidence = Math.min(breakdowns.length / 10, 1)

    for (const [phase, outputRatio] of Object.entries(phaseOutputRatios)) {
      const currentModel = config.phases[phase as keyof typeof config.phases]?.model ?? config.baseline_model
      const currentTier = this._getTier(currentModel)

      if (outputRatio < DOWNGRADE_THRESHOLD) {
        // Candidate for downgrade
        const suggestedTier = currentTier - 1
        if (suggestedTier < 1) {
          this._logger.debug({ phase, currentTier }, 'Already at minimum tier — skipping downgrade')
          continue
        }
        const suggestedKeyword = this._getTierKeyword(suggestedTier)
        // Build suggested model name by replacing the tier keyword in the current model name.
        // Falls back to just the keyword fragment if no keyword found in current model.
        const suggestedModel = this._substituteTierKeyword(currentModel, currentTier, suggestedKeyword)
        const estimatedSavingsPct = ((currentTier - suggestedTier) / currentTier) * 50

        recommendations.push({
          phase,
          currentModel,
          suggestedModel,
          estimatedSavingsPct,
          confidence,
          dataPoints: breakdowns.length,
          direction: 'downgrade',
        })

        this._logger.debug(
          { phase, currentModel, suggestedModel, outputRatio, estimatedSavingsPct },
          'Downgrade recommendation generated',
        )
      } else if (outputRatio > UPGRADE_THRESHOLD) {
        // Candidate for upgrade
        const suggestedTier = currentTier + 1
        if (suggestedTier > 3) {
          this._logger.debug({ phase, currentTier }, 'Already at maximum tier — skipping upgrade')
          continue
        }
        const suggestedKeyword = this._getTierKeyword(suggestedTier)
        const suggestedModel = this._substituteTierKeyword(currentModel, currentTier, suggestedKeyword)
        const estimatedSavingsPct = ((currentTier - suggestedTier) / currentTier) * 50

        recommendations.push({
          phase,
          currentModel,
          suggestedModel,
          estimatedSavingsPct,
          confidence,
          dataPoints: breakdowns.length,
          direction: 'upgrade',
        })

        this._logger.debug(
          { phase, currentModel, suggestedModel, outputRatio, estimatedSavingsPct },
          'Upgrade recommendation generated',
        )
      }
      // Neutral zone (0.15..0.40): no recommendation
    }

    return {
      recommendations,
      analysisRuns: breakdowns.length,
      insufficientData: false,
      phaseOutputRatios,
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Replace the tier keyword in a model name string with a new keyword.
   *
   * e.g. ('claude-haiku-4-5', 1, 'sonnet') → 'claude-sonnet-4-5'
   *
   * If the current tier keyword is not found in the model name, returns
   * a synthesised name like 'claude-sonnet' using the new keyword.
   */
  private _substituteTierKeyword(
    currentModel: string,
    currentTier: number,
    newKeyword: string,
  ): string {
    const currentKeyword = this._getTierKeyword(currentTier)
    if (currentModel.toLowerCase().includes(currentKeyword)) {
      // Case-insensitive replacement
      return currentModel.replace(new RegExp(currentKeyword, 'i'), newKeyword)
    }
    // Fallback: synthesize from prefix
    const dashIdx = currentModel.indexOf('-')
    const prefix = dashIdx !== -1 ? currentModel.slice(0, dashIdx) : currentModel
    return `${prefix}-${newKeyword}`
  }
}
