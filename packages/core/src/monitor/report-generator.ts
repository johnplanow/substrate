/**
 * ReportGenerator — assembles MonitorReport from MonitorDatabase data.
 * Migrated to @substrate-ai/core (Story 41-7)
 */

import type { MonitorDatabase } from '../persistence/monitor-database.js'
import { RecommendationEngine } from './recommendation-engine.js'
import type { RecommendationExport } from './recommendation-types.js'

// ---------------------------------------------------------------------------
// MonitorReport
// ---------------------------------------------------------------------------

export interface MonitorReport {
  generated_at: string
  time_range?: {
    since: string
    until: string
  }
  summary: {
    total_tasks: number
    total_agents: number
    total_task_types: number
    date_range: {
      earliest: string | null
      latest: string | null
    }
  }
  agents: {
    agent: string
    total_tasks: number
    success_rate: number
    failure_rate: number
    average_tokens: number
    average_duration: number
    token_efficiency: number
  }[]
  task_types: {
    task_type: string
    total_tasks: number
    agents: {
      agent: string
      success_rate: number
      average_tokens: number
      sample_size: number
    }[]
  }[]
  recommendations?: RecommendationExport
}

// ---------------------------------------------------------------------------
// ReportGeneratorOptions
// ---------------------------------------------------------------------------

export interface ReportGeneratorOptions {
  sinceDate?: string
  includeRecommendations?: boolean
}

// ---------------------------------------------------------------------------
// generateMonitorReport
// ---------------------------------------------------------------------------

export function generateMonitorReport(
  monitorDb: MonitorDatabase,
  options: ReportGeneratorOptions = {},
): MonitorReport {
  const { sinceDate, includeRecommendations = false } = options
  const generatedAt = new Date().toISOString()

  const aggregates = monitorDb.getAggregates(sinceDate ? { sinceDate } : undefined)

  // Per-agent summaries
  const agentMap = new Map<string, {
    totalTasks: number
    successfulTasks: number
    failedTasks: number
    totalInputTokens: number
    totalOutputTokens: number
    totalDurationMs: number
    lastUpdated: string | null
  }>()

  for (const agg of aggregates) {
    const existing = agentMap.get(agg.agent)
    if (existing !== undefined) {
      existing.totalTasks += agg.totalTasks
      existing.successfulTasks += agg.successfulTasks
      existing.failedTasks += agg.failedTasks
      existing.totalInputTokens += agg.totalInputTokens
      existing.totalOutputTokens += agg.totalOutputTokens
      existing.totalDurationMs += agg.totalDurationMs
      if (
        existing.lastUpdated === null ||
        (agg.lastUpdated && agg.lastUpdated > existing.lastUpdated)
      ) {
        existing.lastUpdated = agg.lastUpdated
      }
    } else {
      agentMap.set(agg.agent, {
        totalTasks: agg.totalTasks,
        successfulTasks: agg.successfulTasks,
        failedTasks: agg.failedTasks,
        totalInputTokens: agg.totalInputTokens,
        totalOutputTokens: agg.totalOutputTokens,
        totalDurationMs: agg.totalDurationMs,
        lastUpdated: agg.lastUpdated,
      })
    }
  }

  const agentSummaries = Array.from(agentMap.entries()).map(([agent, stats]) => {
    const totalTasks = stats.totalTasks
    return {
      agent,
      total_tasks: totalTasks,
      success_rate: totalTasks > 0 ? (stats.successfulTasks / totalTasks) * 100 : 0,
      failure_rate: totalTasks > 0 ? (stats.failedTasks / totalTasks) * 100 : 0,
      average_tokens: totalTasks > 0 ? (stats.totalInputTokens + stats.totalOutputTokens) / totalTasks : 0,
      average_duration: totalTasks > 0 ? stats.totalDurationMs / totalTasks : 0,
      token_efficiency: stats.totalInputTokens > 0 ? stats.totalOutputTokens / stats.totalInputTokens : 0,
    }
  })

  agentSummaries.sort((a, b) => b.total_tasks - a.total_tasks)

  // Per-task-type breakdown
  const taskTypeMap = new Map<string, Map<string, {
    totalTasks: number
    successfulTasks: number
    totalInputTokens: number
    totalOutputTokens: number
  }>>()

  for (const agg of aggregates) {
    let agentsForType = taskTypeMap.get(agg.taskType)
    if (agentsForType === undefined) {
      agentsForType = new Map()
      taskTypeMap.set(agg.taskType, agentsForType)
    }

    const existing = agentsForType.get(agg.agent)
    if (existing !== undefined) {
      existing.totalTasks += agg.totalTasks
      existing.successfulTasks += agg.successfulTasks
      existing.totalInputTokens += agg.totalInputTokens
      existing.totalOutputTokens += agg.totalOutputTokens
    } else {
      agentsForType.set(agg.agent, {
        totalTasks: agg.totalTasks,
        successfulTasks: agg.successfulTasks,
        totalInputTokens: agg.totalInputTokens,
        totalOutputTokens: agg.totalOutputTokens,
      })
    }
  }

  const taskTypeSummaries = Array.from(taskTypeMap.entries()).map(([taskType, agentsForType]) => {
    const agentsArray = Array.from(agentsForType.entries()).map(([agent, stats]) => ({
      agent,
      success_rate: stats.totalTasks > 0 ? (stats.successfulTasks / stats.totalTasks) * 100 : 0,
      average_tokens:
        stats.totalTasks > 0
          ? (stats.totalInputTokens + stats.totalOutputTokens) / stats.totalTasks
          : 0,
      sample_size: stats.totalTasks,
    }))

    agentsArray.sort((a, b) => b.success_rate - a.success_rate)
    const totalTasksForType = agentsArray.reduce((sum, a) => sum + a.sample_size, 0)

    return {
      task_type: taskType,
      total_tasks: totalTasksForType,
      agents: agentsArray,
    }
  })

  taskTypeSummaries.sort((a, b) => b.total_tasks - a.total_tasks)

  // Summary
  const { earliest: earliestDate, latest: latestDate } = monitorDb.getTaskMetricsDateRange()
  const totalTasks = agentSummaries.reduce((sum, a) => sum + a.total_tasks, 0)

  const summary = {
    total_tasks: totalTasks,
    total_agents: agentSummaries.length,
    total_task_types: taskTypeSummaries.length,
    date_range: { earliest: earliestDate, latest: latestDate },
  }

  // Optional recommendations
  let recommendations: RecommendationExport | undefined
  if (includeRecommendations) {
    const engine = new RecommendationEngine(monitorDb)
    recommendations = engine.exportRecommendationsJson()
  }

  const timeRange = sinceDate
    ? { since: sinceDate, until: generatedAt }
    : undefined

  return {
    generated_at: generatedAt,
    ...(timeRange !== undefined ? { time_range: timeRange } : {}),
    summary,
    agents: agentSummaries,
    task_types: taskTypeSummaries,
    ...(recommendations !== undefined ? { recommendations } : {}),
  }
}
