/**
 * RecommendationEngine — generates routing recommendations from performance aggregates.
 * Migrated to @substrate-ai/core (Story 41-7)
 */

import type { ILogger } from '../dispatch/types.js'
import type { MonitorDatabase } from '../persistence/monitor-database.js'
import type { Recommendation, ConfidenceLevel, RecommendationFilters, RecommendationExport } from './recommendation-types.js'

// ---------------------------------------------------------------------------
// MonitorRecommendationConfig
// ---------------------------------------------------------------------------

export interface MonitorRecommendationConfig {
  use_recommendations?: boolean
  recommendation_threshold_percentage?: number
  min_sample_size?: number
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
  private readonly _logger: ILogger

  constructor(monitorDb: MonitorDatabase, config: MonitorRecommendationConfig = {}, logger?: ILogger) {
    this._monitorDb = monitorDb
    this._filters = {
      threshold_percentage: config.recommendation_threshold_percentage ?? 5.0,
      min_sample_size: config.min_sample_size ?? 10,
    }
    this._historyDays = config.recommendation_history_days ?? 90
    this._logger = logger ?? console
  }

  generateRecommendations(): Recommendation[] {
    const sinceDate = new Date(
      Date.now() - this._historyDays * 24 * 60 * 60 * 1000,
    ).toISOString()
    const aggregates = this._monitorDb.getAggregates({ sinceDate })

    if (aggregates.length === 0) {
      this._logger.debug('No performance aggregates found — no recommendations to generate')
      return []
    }

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
      if (agents.length < 2) continue

      const eligibleAgents = agents.filter((a) => a.totalTasks >= this._filters.min_sample_size)
      if (eligibleAgents.length < 2) continue

      const sorted = [...eligibleAgents].sort((a, b) => b.successRate - a.successRate)
      const best = sorted[0]!

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

    const confidenceOrder: Record<ConfidenceLevel, number> = { high: 2, medium: 1, low: 0 }
    recommendations.sort((a, b) => {
      const confDiff = confidenceOrder[b.confidence] - confidenceOrder[a.confidence]
      if (confDiff !== 0) return confDiff
      return b.improvement_percentage - a.improvement_percentage
    })

    this._logger.debug(`Generated ${recommendations.length} routing recommendations`)
    return recommendations
  }

  getMonitorRecommendation(taskType: string): Recommendation | null {
    const all = this.generateRecommendations()
    const forType = all.filter((r) => r.task_type === taskType)
    return forType.length > 0 ? forType[0]! : null
  }

  exportRecommendationsJson(): RecommendationExport {
    const recommendations = this.generateRecommendations()
    return {
      generated_at: new Date().toISOString(),
      count: recommendations.length,
      recommendations,
    }
  }

  private _calculateConfidence(sampleSizeCurrent: number, sampleSizeRecommended: number): ConfidenceLevel {
    const minBoth = Math.min(sampleSizeCurrent, sampleSizeRecommended)
    const highThreshold = Math.max(50, this._filters.min_sample_size)
    const mediumThreshold = Math.max(20, this._filters.min_sample_size)

    if (minBoth >= highThreshold) return 'high'
    if (minBoth >= mediumThreshold) return 'medium'
    return 'low'
  }

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
  logger?: ILogger,
): RecommendationEngine {
  return new RecommendationEngine(monitorDb, config, logger)
}
