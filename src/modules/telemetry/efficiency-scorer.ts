/**
 * EfficiencyScorer — computes composite 0-100 efficiency scores for story runs.
 *
 * The composite score combines three sub-scores:
 *   - cacheHitSubScore    (weight 40%): how well the story leverages prompt caching
 *   - ioRatioSubScore     (weight 30%): whether agents produce proportional output
 *   - contextManagement   (weight 30%): frequency of context spikes
 *
 * Architecture constraints:
 *   - Constructor injection: accepts pino.Logger via constructor
 *   - Zero LLM calls — pure statistical computation
 *   - No external dependencies beyond types from this module
 */

import type pino from 'pino'

import type { TurnAnalysis, EfficiencyScore, ModelEfficiency, SourceEfficiency } from './types.js'

// ---------------------------------------------------------------------------
// EfficiencyScorer
// ---------------------------------------------------------------------------

export class EfficiencyScorer {
  private readonly _logger: pino.Logger

  constructor(logger: pino.Logger) {
    this._logger = logger
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Compute an efficiency score for a story given its turn analyses.
   *
   * Returns a zeroed `EfficiencyScore` immediately when `turns` is empty.
   *
   * @param storyKey - The story identifier (e.g. "27-6")
   * @param turns    - Turn analysis records from `TurnAnalyzer.analyze()`
   */
  score(storyKey: string, turns: TurnAnalysis[]): EfficiencyScore {
    if (turns.length === 0) {
      return {
        storyKey,
        timestamp: Date.now(),
        compositeScore: 0,
        cacheHitSubScore: 0,
        ioRatioSubScore: 0,
        contextManagementSubScore: 0,
        avgCacheHitRate: 0,
        avgIoRatio: 0,
        contextSpikeCount: 0,
        totalTurns: 0,
        perModelBreakdown: [],
        perSourceBreakdown: [],
      }
    }

    const avgCacheHitRate = this._computeAvgCacheHitRate(turns)
    const avgIoRatio = this._computeAvgIoRatio(turns)
    const contextSpikeCount = turns.filter((t) => t.isContextSpike).length
    const totalTurns = turns.length

    const cacheHitSubScore = this._computeCacheHitSubScore(turns)
    const ioRatioSubScore = this._computeIoRatioSubScore(turns)
    const contextManagementSubScore = this._computeContextManagementSubScore(turns)

    const compositeScore = Math.round(
      cacheHitSubScore * 0.4 + ioRatioSubScore * 0.3 + contextManagementSubScore * 0.3,
    )

    const perModelBreakdown = this._buildPerModelBreakdown(turns)
    const perSourceBreakdown = this._buildPerSourceBreakdown(turns)

    this._logger.info(
      { storyKey, compositeScore, contextSpikeCount },
      'Computed efficiency score',
    )

    return {
      storyKey,
      timestamp: Date.now(),
      compositeScore,
      cacheHitSubScore,
      ioRatioSubScore,
      contextManagementSubScore,
      avgCacheHitRate,
      avgIoRatio,
      contextSpikeCount,
      totalTurns,
      perModelBreakdown,
      perSourceBreakdown,
    }
  }

  // ---------------------------------------------------------------------------
  // Private sub-score methods
  // ---------------------------------------------------------------------------

  /**
   * Average cache hit rate across all turns, clamped to [0, 100].
   * Formula: clamp(avgCacheHitRate × 100, 0, 100)
   */
  private _computeCacheHitSubScore(turns: TurnAnalysis[]): number {
    const avg = this._computeAvgCacheHitRate(turns)
    return this._clamp(avg * 100, 0, 100)
  }

  /**
   * I/O ratio sub-score: lower ratio = better = higher score.
   * Formula: clamp(100 - (avgIoRatio - 1) × 20, 0, 100)
   *
   * At avgIoRatio=1: score=80 (equal input/output tokens)
   * At avgIoRatio=5: score=20
   * At avgIoRatio≥6: clamped to 0
   */
  private _computeIoRatioSubScore(turns: TurnAnalysis[]): number {
    const avg = this._computeAvgIoRatio(turns)
    return this._clamp(100 - (avg - 1) * 20, 0, 100)
  }

  /**
   * Context management sub-score: penalizes context spike frequency.
   * Formula: clamp(100 - spikeRatio × 100, 0, 100)
   * where spikeRatio = contextSpikeCount / max(totalTurns, 1)
   */
  private _computeContextManagementSubScore(turns: TurnAnalysis[]): number {
    const totalTurns = Math.max(turns.length, 1)
    const spikeCount = turns.filter((t) => t.isContextSpike).length
    const spikeRatio = spikeCount / totalTurns
    return this._clamp(100 - spikeRatio * 100, 0, 100)
  }

  // ---------------------------------------------------------------------------
  // Private average helpers
  // ---------------------------------------------------------------------------

  private _computeAvgCacheHitRate(turns: TurnAnalysis[]): number {
    if (turns.length === 0) return 0
    const sum = turns.reduce((acc, t) => acc + t.cacheHitRate, 0)
    return sum / turns.length
  }

  /**
   * Average I/O ratio: inputTokens / max(outputTokens, 1) per turn.
   */
  private _computeAvgIoRatio(turns: TurnAnalysis[]): number {
    if (turns.length === 0) return 0
    const sum = turns.reduce((acc, t) => acc + t.inputTokens / Math.max(t.outputTokens, 1), 0)
    return sum / turns.length
  }

  // ---------------------------------------------------------------------------
  // Per-model breakdown
  // ---------------------------------------------------------------------------

  /**
   * Group turns by model, computing per-group efficiency metrics.
   * Turns with null/undefined model are grouped under "unknown".
   */
  private _buildPerModelBreakdown(turns: TurnAnalysis[]): ModelEfficiency[] {
    const groups = new Map<string, TurnAnalysis[]>()

    for (const turn of turns) {
      const key = (turn.model != null && turn.model !== '') ? turn.model : 'unknown'
      const existing = groups.get(key)
      if (existing !== undefined) {
        existing.push(turn)
      } else {
        groups.set(key, [turn])
      }
    }

    const result: ModelEfficiency[] = []

    for (const [model, groupTurns] of groups) {
      const cacheHitRate =
        groupTurns.reduce((acc, t) => acc + t.cacheHitRate, 0) / groupTurns.length

      const avgIoRatio =
        groupTurns.reduce((acc, t) => acc + t.inputTokens / Math.max(t.outputTokens, 1), 0) /
        groupTurns.length

      const totalCostUsd = groupTurns.reduce((acc, t) => acc + t.costUsd, 0)
      const totalOutputTokens = groupTurns.reduce((acc, t) => acc + t.outputTokens, 0)
      const costPer1KOutputTokens =
        (totalCostUsd / Math.max(totalOutputTokens, 1)) * 1000

      result.push({ model, cacheHitRate, avgIoRatio, costPer1KOutputTokens })
    }

    return result
  }

  // ---------------------------------------------------------------------------
  // Per-source breakdown
  // ---------------------------------------------------------------------------

  /**
   * Group turns by source, computing a per-group composite score using the
   * same formula as the overall score. Sources with zero turns are excluded.
   */
  private _buildPerSourceBreakdown(turns: TurnAnalysis[]): SourceEfficiency[] {
    const groups = new Map<string, TurnAnalysis[]>()

    for (const turn of turns) {
      const key = turn.source
      const existing = groups.get(key)
      if (existing !== undefined) {
        existing.push(turn)
      } else {
        groups.set(key, [turn])
      }
    }

    const result: SourceEfficiency[] = []

    for (const [source, groupTurns] of groups) {
      if (groupTurns.length === 0) continue

      const cacheHitSub = this._computeCacheHitSubScoreForGroup(groupTurns)
      const ioRatioSub = this._computeIoRatioSubScoreForGroup(groupTurns)
      const contextSub = this._computeContextManagementSubScoreForGroup(groupTurns)

      const compositeScore = Math.round(
        cacheHitSub * 0.4 + ioRatioSub * 0.3 + contextSub * 0.3,
      )

      result.push({ source, compositeScore, turnCount: groupTurns.length })
    }

    return result
  }

  // Reusable group-level sub-score helpers
  private _computeCacheHitSubScoreForGroup(turns: TurnAnalysis[]): number {
    if (turns.length === 0) return 0
    const avg = turns.reduce((acc, t) => acc + t.cacheHitRate, 0) / turns.length
    return this._clamp(avg * 100, 0, 100)
  }

  private _computeIoRatioSubScoreForGroup(turns: TurnAnalysis[]): number {
    if (turns.length === 0) return 0
    const avg =
      turns.reduce((acc, t) => acc + t.inputTokens / Math.max(t.outputTokens, 1), 0) /
      turns.length
    return this._clamp(100 - (avg - 1) * 20, 0, 100)
  }

  private _computeContextManagementSubScoreForGroup(turns: TurnAnalysis[]): number {
    if (turns.length === 0) return 0
    const spikeCount = turns.filter((t) => t.isContextSpike).length
    const spikeRatio = spikeCount / turns.length
    return this._clamp(100 - spikeRatio * 100, 0, 100)
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  private _clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value))
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an EfficiencyScorer with the given logger.
 */
export function createEfficiencyScorer(logger: pino.Logger): EfficiencyScorer {
  return new EfficiencyScorer(logger)
}
