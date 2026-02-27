/**
 * ReportGenerator — assembles MonitorReport from MonitorDatabase data.
 *
 * Responsibilities:
 *  - Query MonitorDatabase for aggregate stats
 *  - Compute per-agent summaries (grouped by agent across task types)
 *  - Compute per-task-type breakdown (grouped by task type across agents)
 *  - Optionally include routing recommendations from RecommendationEngine
 *  - Return a complete MonitorReport structure ready for CLI output
 *
 * Architecture constraints:
 *  - Zero LLM calls (FR69) — pure query + computation
 *  - No asynchronous operations — all computation is synchronous
 *  - Depends on MonitorDatabase.getAggregates() (from Story 8.5)
 *  - Optionally depends on RecommendationEngine (from Story 8.6)
 */

import type { MonitorDatabase } from '../../persistence/monitor-database.js'
import { RecommendationEngine } from './recommendation-engine.js'
import type { RecommendationExport } from './recommendation-types.js'

// ---------------------------------------------------------------------------
// MonitorReport
// ---------------------------------------------------------------------------

/**
 * Full monitor report structure returned by generateMonitorReport().
 */
export interface MonitorReport {
  /** ISO timestamp of when the report was generated */
  generated_at: string

  /** Optional time range filter applied to this report */
  time_range?: {
    since: string
    until: string
  }

  /** High-level summary counts */
  summary: {
    total_tasks: number
    total_agents: number
    total_task_types: number
    date_range: {
      earliest: string | null
      latest: string | null
    }
  }

  /** Per-agent performance summary (aggregated across all task types) */
  agents: {
    agent: string
    total_tasks: number
    success_rate: number
    failure_rate: number
    average_tokens: number
    average_duration: number
    token_efficiency: number
  }[]

  /** Per-task-type breakdown showing top agents per type */
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

  /** Optional routing recommendations (included when includeRecommendations is true) */
  recommendations?: RecommendationExport
}

// ---------------------------------------------------------------------------
// ReportGeneratorOptions
// ---------------------------------------------------------------------------

/**
 * Options for generateMonitorReport().
 */
export interface ReportGeneratorOptions {
  /** ISO date string: only include data from this date forward */
  sinceDate?: string
  /** Whether to include routing recommendations in the report */
  includeRecommendations?: boolean
}

// ---------------------------------------------------------------------------
// generateMonitorReport
// ---------------------------------------------------------------------------

/**
 * Generate a comprehensive monitor report from the given MonitorDatabase.
 *
 * @param monitorDb - MonitorDatabase instance (must be open)
 * @param options   - Optional filtering and inclusion options
 * @returns Complete MonitorReport ready for CLI output
 */
export function generateMonitorReport(
  monitorDb: MonitorDatabase,
  options: ReportGeneratorOptions = {},
): MonitorReport {
  const { sinceDate, includeRecommendations = false } = options
  const generatedAt = new Date().toISOString()

  // Query all performance aggregates, optionally filtered by date
  const aggregates = monitorDb.getAggregates(sinceDate ? { sinceDate } : undefined)

  // -------------------------------------------------------------------------
  // Compute per-agent summaries (group by agent, sum across task types)
  // -------------------------------------------------------------------------
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
      // Keep most recent lastUpdated
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

  // Sort by total_tasks descending for a useful default ordering
  agentSummaries.sort((a, b) => b.total_tasks - a.total_tasks)

  // -------------------------------------------------------------------------
  // Compute per-task-type breakdown (group by task_type)
  // -------------------------------------------------------------------------
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

    // Sort agents by success_rate descending
    agentsArray.sort((a, b) => b.success_rate - a.success_rate)

    const totalTasksForType = agentsArray.reduce((sum, a) => sum + a.sample_size, 0)

    return {
      task_type: taskType,
      total_tasks: totalTasksForType,
      agents: agentsArray,
    }
  })

  // Sort by total_tasks descending
  taskTypeSummaries.sort((a, b) => b.total_tasks - a.total_tasks)

  // -------------------------------------------------------------------------
  // Compute summary
  // -------------------------------------------------------------------------
  const { earliest: earliestDate, latest: latestDate } = monitorDb.getTaskMetricsDateRange()

  const totalTasks = agentSummaries.reduce((sum, a) => sum + a.total_tasks, 0)

  const summary = {
    total_tasks: totalTasks,
    total_agents: agentSummaries.length,
    total_task_types: taskTypeSummaries.length,
    date_range: {
      earliest: earliestDate,
      latest: latestDate,
    },
  }

  // -------------------------------------------------------------------------
  // Optional recommendations
  // -------------------------------------------------------------------------
  let recommendations: RecommendationExport | undefined

  if (includeRecommendations) {
    const engine = new RecommendationEngine(monitorDb)
    recommendations = engine.exportRecommendationsJson()
  }

  // -------------------------------------------------------------------------
  // Build time_range if sinceDate was provided
  // -------------------------------------------------------------------------
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
