/**
 * EfficiencyScorer — computes composite 0-100 efficiency scores for story runs.
 *
 * The composite score combines four sub-scores (Epic 35 — Telemetry Scoring v2):
 *   - cacheHitSubScore        (weight 25%): how well the story leverages prompt caching
 *   - ioRatioSubScore         (weight 25%): logarithmic output/freshInput productivity curve
 *   - contextManagement       (weight 25%): frequency of context spikes
 *   - tokenDensitySubScore    (weight 25%): output tokens per turn vs task-type baseline
 *
 * Cold-start turns (first turn per dispatch) are excluded from sub-score
 * computation but included in totalTurns for observability (Story 35-3).
 *
 * Architecture constraints:
 *   - Constructor injection: accepts ILogger via constructor (defaults to console)
 *   - Zero LLM calls — pure statistical computation
 *   - No external dependencies beyond types from this module
 *
 * Migrated to @substrate-ai/core in story 41-6b.
 */

import type { ILogger } from '../dispatch/types.js'
import type { TurnAnalysis, EfficiencyScore, ModelEfficiency, SourceEfficiency } from './types.js'
import type { IEfficiencyScorer } from './telemetry-pipeline.js'
import { getBaseline } from './task-baselines.js'

// Sub-score weights (Epic 35 — equal weighting across 4 dimensions)
const W_CACHE = 0.25
const W_IO_RATIO = 0.25
const W_CONTEXT = 0.25
const W_TOKEN_DENSITY = 0.25

// ---------------------------------------------------------------------------
// EfficiencyScorer
// ---------------------------------------------------------------------------

export class EfficiencyScorer implements IEfficiencyScorer {
  private readonly _logger: ILogger

  constructor(logger?: ILogger) {
    this._logger = logger ?? console
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
        tokenDensitySubScore: 0,
        avgCacheHitRate: 0,
        avgIoRatio: 0,
        contextSpikeCount: 0,
        totalTurns: 0,
        coldStartTurnsExcluded: 0,
        perModelBreakdown: [],
        perSourceBreakdown: [],
      }
    }

    // Story 35-2: Infer task type from turns (unanimous → use type-specific baseline)
    const taskType = this._inferTaskType(turns)
    const baseline = getBaseline(taskType)

    // Story 35-3: Exclude cold-start turns (first turn per dispatchId) from scoring
    const coldStartIds = this._identifyColdStartTurns(turns)
    let scoringTurns = turns.filter((t) => !coldStartIds.has(t.spanId))
    // Fallback: if excluding cold-starts leaves nothing, use all turns
    if (scoringTurns.length === 0) scoringTurns = turns

    const avgCacheHitRate = this._computeAvgCacheHitRate(scoringTurns)
    const avgIoRatio = this._computeAvgIoRatio(scoringTurns)
    const contextSpikeCount = turns.filter((t) => t.isContextSpike).length
    const totalTurns = turns.length

    const cacheHitSubScore = this._computeCacheHitSubScore(scoringTurns)
    const ioRatioSubScore = this._computeIoRatioSubScore(scoringTurns, baseline.targetIoRatio)
    const contextManagementSubScore = this._computeContextManagementSubScore(scoringTurns)
    const tokenDensitySubScore = this._computeTokenDensitySubScore(
      scoringTurns,
      baseline.expectedOutputPerTurn,
    )

    const compositeScore = Math.round(
      cacheHitSubScore * W_CACHE +
      ioRatioSubScore * W_IO_RATIO +
      contextManagementSubScore * W_CONTEXT +
      tokenDensitySubScore * W_TOKEN_DENSITY,
    )

    const perModelBreakdown = this._buildPerModelBreakdown(scoringTurns)
    const perSourceBreakdown = this._buildPerSourceBreakdown(
      scoringTurns,
      baseline.targetIoRatio,
      baseline.expectedOutputPerTurn,
    )

    this._logger.info(
      { storyKey, compositeScore, contextSpikeCount, coldStartTurnsExcluded: coldStartIds.size },
      'Computed efficiency score',
    )

    return {
      storyKey,
      timestamp: Date.now(),
      compositeScore,
      cacheHitSubScore,
      ioRatioSubScore,
      contextManagementSubScore,
      tokenDensitySubScore,
      avgCacheHitRate,
      avgIoRatio,
      contextSpikeCount,
      totalTurns,
      coldStartTurnsExcluded: coldStartIds.size,
      perModelBreakdown,
      perSourceBreakdown,
    }
  }

  // ---------------------------------------------------------------------------
  // Private: cold-start identification (Story 35-3)
  // ---------------------------------------------------------------------------

  /**
   * Identify cold-start turns: the first turn per dispatchId.
   * Returns a set of spanIds that should be excluded from scoring.
   * Only considers turns with a non-empty dispatchId.
   */
  private _identifyColdStartTurns(turns: TurnAnalysis[]): Set<string> {
    const coldStarts = new Set<string>()
    const seenDispatches = new Set<string>()

    // Turns are in chronological order (by turnNumber); first seen per dispatch is cold-start
    for (const turn of turns) {
      if (turn.dispatchId !== undefined && turn.dispatchId !== '' && !seenDispatches.has(turn.dispatchId)) {
        seenDispatches.add(turn.dispatchId)
        coldStarts.add(turn.spanId)
      }
    }

    return coldStarts
  }

  // ---------------------------------------------------------------------------
  // Private: task type inference (Story 35-2)
  // ---------------------------------------------------------------------------

  /**
   * Infer the task type from turns. Returns the task type only when all turns
   * with a taskType agree (unanimous). For mixed task types (story-level
   * scoring across dispatches), returns undefined → default baseline.
   */
  private _inferTaskType(turns: TurnAnalysis[]): string | undefined {
    const types = new Set<string>()
    for (const turn of turns) {
      if (turn.taskType !== undefined && turn.taskType !== '') {
        types.add(turn.taskType)
      }
    }
    return types.size === 1 ? [...types][0] : undefined
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
   * I/O ratio sub-score: logarithmic output/freshInput productivity curve (Story 35-1).
   *
   * Replaces the old binary threshold (>=1 → 100) with a logarithmic curve
   * that provides gradient across the observed range:
   *   - score = clamp(log10(ratio) / log10(targetRatio) * 100, 0, 100)
   *   - ratio = avg(outputTokens / max(freshInputTokens, 1)) across turns
   *   - targetRatio is calibrated per task type (Story 35-2)
   *
   * Examples (TARGET=100): ratio 1→0, 10→50, 50→85, 100→100, 200→100(clamped)
   */
  private _computeIoRatioSubScore(turns: TurnAnalysis[], targetRatio: number): number {
    if (turns.length === 0) return 0
    const avg = turns.reduce((acc, t) => {
      const freshInput = Math.max(t.inputTokens, 1) // fresh tokens only, not cached
      return acc + t.outputTokens / freshInput
    }, 0) / turns.length

    if (avg <= 0) return 0
    const logTarget = Math.log10(Math.max(targetRatio, 2)) // guard against degenerate target
    const score = (Math.log10(avg) / logTarget) * 100
    return this._clamp(score, 0, 100)
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

  /**
   * Token density sub-score: output tokens per turn vs task-type baseline (Story 35-4).
   *
   * Measures whether the agent is producing useful output or spinning:
   *   - score = clamp(avgOutputPerTurn / expectedOutputPerTurn * 100, 0, 100)
   *   - expectedOutputPerTurn is calibrated per task type (Story 35-2)
   *
   * Below-baseline dispatches get proportionally lower scores.
   * At-or-above-baseline dispatches score 100.
   */
  private _computeTokenDensitySubScore(turns: TurnAnalysis[], expectedOutputPerTurn: number): number {
    if (turns.length === 0) return 0
    const avgOutput = turns.reduce((acc, t) => acc + t.outputTokens, 0) / turns.length
    const ratio = avgOutput / Math.max(expectedOutputPerTurn, 1)
    return this._clamp(ratio * 100, 0, 100)
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
   * Average I/O ratio: totalInput / max(outputTokens, 1) per turn.
   * Total input = inputTokens (fresh) + cacheReadTokens (cached).
   */
  private _computeAvgIoRatio(turns: TurnAnalysis[]): number {
    if (turns.length === 0) return 0
    const sum = turns.reduce((acc, t) => {
      const totalInput = t.inputTokens + (t.cacheReadTokens ?? 0)
      return acc + totalInput / Math.max(t.outputTokens, 1)
    }, 0)
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
        groupTurns.reduce((acc, t) => {
          const totalInput = t.inputTokens + (t.cacheReadTokens ?? 0)
          return acc + totalInput / Math.max(t.outputTokens, 1)
        }, 0) / groupTurns.length

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
  private _buildPerSourceBreakdown(
    turns: TurnAnalysis[],
    targetIoRatio: number,
    expectedOutputPerTurn: number,
  ): SourceEfficiency[] {
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

      const cacheHitSub = this._computeCacheHitSubScore(groupTurns)
      const ioRatioSub = this._computeIoRatioSubScore(groupTurns, targetIoRatio)
      const contextSub = this._computeContextManagementSubScore(groupTurns)
      const tokenDensitySub = this._computeTokenDensitySubScore(groupTurns, expectedOutputPerTurn)

      const compositeScore = Math.round(
        cacheHitSub * W_CACHE +
        ioRatioSub * W_IO_RATIO +
        contextSub * W_CONTEXT +
        tokenDensitySub * W_TOKEN_DENSITY,
      )

      result.push({ source, compositeScore, turnCount: groupTurns.length })
    }

    return result
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
export function createEfficiencyScorer(logger?: ILogger): EfficiencyScorer {
  return new EfficiencyScorer(logger)
}
