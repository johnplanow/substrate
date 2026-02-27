/**
 * RecommendationEngine — generates routing recommendations from performance aggregates.
 *
 * Responsibilities:
 *  - Load all performance aggregates from the MonitorDatabase
 *  - Group data by task_type and compare agent success rates
 *  - Generate recommendations when one agent shows >= threshold improvement (AC1, AC4)
 *  - Assign confidence levels based on sample size (AC3)
 *  - Return advisory-only recommendations; never override explicit routing policy (FR68)
 *
 * Architecture constraints:
 *  - Zero LLM calls (FR69) — pure statistical computation
 *  - No asynchronous operations — all computation is synchronous
 *  - Depends on MonitorDatabase.getAggregates() (from Story 8.5)
 */

import type { MonitorDatabase } from '../../persistence/monitor-database.js'
import type { Recommendation, ConfidenceLevel, RecommendationFilters, RecommendationExport } from './recommendation-types.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('monitor:recommendations')

// ---------------------------------------------------------------------------
// OrchestratorConfig monitor sub-section (mirror of types/config additions)
// ---------------------------------------------------------------------------

export interface MonitorRecommendationConfig {
  /** Enable advisory recommendations (default: false) */
  use_recommendations?: boolean
  /** Min improvement % to generate a recommendation (default: 5.0) */
  recommendation_threshold_percentage?: number
  /** Min tasks per (agent, task_type) pair (default: 10) */
  min_sample_size?: number
  /** How many days of history to analyze (default: 90) */
  recommendation_history_days?: number
}

// ---------------------------------------------------------------------------
// Internal data structures
// ---------------------------------------------------------------------------

interface AgentStats {
  agent: string
  totalTasks: number
  successfulTasks: number
  successRate: number
  avgTokens: number
}

// ---------------------------------------------------------------------------
// RecommendationEngine
// ---------------------------------------------------------------------------

export class RecommendationEngine {
  private readonly _monitorDb: MonitorDatabase
  private readonly _filters: RecommendationFilters
  private readonly _historyDays: number

  constructor(monitorDb: MonitorDatabase, config: MonitorRecommendationConfig = {}) {
    this._monitorDb = monitorDb
    this._filters = {
      threshold_percentage: config.recommendation_threshold_percentage ?? 5.0,
      min_sample_size: config.min_sample_size ?? 10,
    }
    this._historyDays = config.recommendation_history_days ?? 90
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Generate routing recommendations by comparing agent performance per task type.
   *
   * Algorithm (from Dev Notes):
   * 1. Load all performance_aggregates rows
   * 2. Group by task_type
   * 3. For each task_type:
   *    a. Identify all agents used for that type with their success rates
   *    b. Find the best-performing agent (max success rate)
   *    c. For each agent below max:
   *       - improvement = max_success_rate - agent_success_rate
   *       - If improvement >= threshold AND both sample sizes >= min: create recommendation
   * 4. Sort by confidence descending, then improvement descending
   *
   * @returns Array of recommendations, empty if none meet threshold
   */
  generateRecommendations(): Recommendation[] {
    // Apply history window filter: only include aggregates updated within the configured window
    const sinceDate = new Date(
      Date.now() - this._historyDays * 24 * 60 * 60 * 1000,
    ).toISOString()
    const aggregates = this._monitorDb.getAggregates({ sinceDate })

    if (aggregates.length === 0) {
      logger.debug('No performance aggregates found — no recommendations to generate')
      return []
    }

    // Group aggregates by task_type
    const byTaskType = new Map<string, AgentStats[]>()

    for (const agg of aggregates) {
      const successRate = agg.totalTasks > 0
        ? (agg.successfulTasks / agg.totalTasks) * 100
        : 0
      const avgTokens = agg.totalTasks > 0
        ? (agg.totalInputTokens + agg.totalOutputTokens) / agg.totalTasks
        : 0

      const stats: AgentStats = {
        agent: agg.agent,
        totalTasks: agg.totalTasks,
        successfulTasks: agg.successfulTasks,
        successRate,
        avgTokens,
      }

      const existing = byTaskType.get(agg.taskType)
      if (existing !== undefined) {
        existing.push(stats)
      } else {
        byTaskType.set(agg.taskType, [stats])
      }
    }

    const recommendations: Recommendation[] = []

    for (const [taskType, agents] of byTaskType) {
      // Skip task types with fewer than 2 agents (no comparison possible)
      if (agents.length < 2) continue

      // Find best-performing agent (max success rate) with sufficient sample
      const eligibleAgents = agents.filter((a) => a.totalTasks >= this._filters.min_sample_size)
      if (eligibleAgents.length < 2) continue

      // Sort by success rate descending
      const sorted = [...eligibleAgents].sort((a, b) => b.successRate - a.successRate)
      const best = sorted[0]!

      // For each agent below best, check if improvement meets threshold
      for (let i = 1; i < sorted.length; i++) {
        const current = sorted[i]!
        const improvement = best.successRate - current.successRate

        if (improvement < this._filters.threshold_percentage) continue

        const confidence = this._calculateConfidence(current.totalTasks, best.totalTasks)
        const reason = this._formatRecommendationReason({
          taskType,
          recommendedAgent: best.agent,
          currentAgent: current.agent,
          improvement,
          recommendedSuccessRate: best.successRate,
          currentSuccessRate: current.successRate,
          sampleSize: Math.min(current.totalTasks, best.totalTasks),
        })

        recommendations.push({
          task_type: taskType,
          current_agent: current.agent,
          recommended_agent: best.agent,
          reason,
          confidence,
          current_success_rate: current.successRate,
          recommended_success_rate: best.successRate,
          current_avg_tokens: current.avgTokens,
          recommended_avg_tokens: best.avgTokens,
          improvement_percentage: improvement,
          sample_size_current: current.totalTasks,
          sample_size_recommended: best.totalTasks,
        })
      }
    }

    // Sort by confidence descending (high > medium > low), then improvement descending
    const confidenceOrder: Record<ConfidenceLevel, number> = { high: 2, medium: 1, low: 0 }
    recommendations.sort((a, b) => {
      const confDiff = confidenceOrder[b.confidence] - confidenceOrder[a.confidence]
      if (confDiff !== 0) return confDiff
      return b.improvement_percentage - a.improvement_percentage
    })

    logger.debug({ count: recommendations.length }, 'Generated routing recommendations')
    return recommendations
  }

  /**
   * Get the highest-confidence recommendation for a specific task type.
   *
   * @param taskType - The task type to get a recommendation for
   * @returns The best recommendation or null if none available
   */
  getMonitorRecommendation(taskType: string): Recommendation | null {
    const all = this.generateRecommendations()
    const forType = all.filter((r) => r.task_type === taskType)
    return forType.length > 0 ? forType[0]! : null
  }

  /**
   * Export all recommendations as a JSON-serializable structure (Task 7 — for Story 8.7 CLI).
   */
  exportRecommendationsJson(): RecommendationExport {
    const recommendations = this.generateRecommendations()
    return {
      generated_at: new Date().toISOString(),
      count: recommendations.length,
      recommendations,
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Calculate confidence tier based on sample sizes for both agents (AC3):
   *  - "high": both >= 50
   *  - "medium": both >= 20
   *  - "low": both >= min_sample_size (but < 20 for at least one)
   */
  private _calculateConfidence(sampleSizeCurrent: number, sampleSizeRecommended: number): ConfidenceLevel {
    const minBoth = Math.min(sampleSizeCurrent, sampleSizeRecommended)
    // Use the larger of the configured min or the default tier thresholds,
    // so custom min_sample_size >= 50 still yields 'high' when both agents meet it.
    const highThreshold = Math.max(50, this._filters.min_sample_size)
    const mediumThreshold = Math.max(20, this._filters.min_sample_size)

    if (minBoth >= highThreshold) return 'high'
    if (minBoth >= mediumThreshold) return 'medium'
    return 'low'
  }

  /**
   * Generate a human-readable recommendation reason string (Dev Notes example):
   * "claude-opus-4-6 shows 15% higher success rate for coding tasks (82% vs 67%, based on 52 tasks)"
   */
  private _formatRecommendationReason(data: {
    taskType: string
    recommendedAgent: string
    currentAgent: string
    improvement: number
    recommendedSuccessRate: number
    currentSuccessRate: number
    sampleSize: number
  }): string {
    const improvementRounded = Math.round(data.improvement * 10) / 10
    const recommendedRounded = Math.round(data.recommendedSuccessRate * 10) / 10
    const currentRounded = Math.round(data.currentSuccessRate * 10) / 10

    return (
      `${data.recommendedAgent} shows ${improvementRounded}% higher success rate for ` +
      `${data.taskType} tasks (${recommendedRounded}% vs ${currentRounded}%, ` +
      `based on ${data.sampleSize} tasks)`
    )
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRecommendationEngine(
  monitorDb: MonitorDatabase,
  config?: MonitorRecommendationConfig,
): RecommendationEngine {
  return new RecommendationEngine(monitorDb, config)
}
