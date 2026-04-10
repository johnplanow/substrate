/**
 * MonitorAgentImpl — concrete implementation of the MonitorAgent interface.
 * Migrated to @substrate-ai/core (Story 41-7)
 */

import type { ILogger } from '../dispatch/types.js'
import type { TypedEventBus, CoreEvents } from '../events/index.js'
import type { MonitorAgent } from './monitor-agent.js'
import type { MonitorDatabase, TaskMetricsRow } from '../persistence/monitor-database.js'
import { TaskTypeClassifier } from './task-type-classifier.js'
import { RecommendationEngine } from './recommendation-engine.js'
import type { Recommendation } from './recommendation-types.js'

export interface MonitorConfig {
  retentionDays?: number
  retentionHourUtc?: number
  customTaxonomy?: Record<string, string[]>
  use_recommendations?: boolean
  recommendation_threshold_percentage?: number
  min_sample_size?: number
  recommendation_history_days?: number
}

export class MonitorAgentImpl implements MonitorAgent {
  private readonly _eventBus: TypedEventBus<CoreEvents>
  private readonly _monitorDb: MonitorDatabase
  private readonly _classifier: TaskTypeClassifier
  private readonly _logger: ILogger
  private readonly _retentionDays: number
  private readonly _retentionHourUtc: number
  private _retentionTimer: ReturnType<typeof setTimeout> | null = null
  private _retentionIntervalTimer: ReturnType<typeof setInterval> | null = null
  private readonly _recommendationEngine: RecommendationEngine | null

  private readonly _onTaskComplete: (payload: {
    taskId: string
    result: {
      output?: string
      exitCode?: number
      tokensUsed?: number
      inputTokens?: number
      outputTokens?: number
      durationMs?: number
      costUsd?: number
      agent?: string
    }
    taskType?: string
  }) => void

  private readonly _onTaskFailed: (payload: {
    taskId: string
    error: { message: string; code?: string; stack?: string }
  }) => void

  constructor(
    eventBus: TypedEventBus<CoreEvents>,
    monitorDb: MonitorDatabase,
    config: MonitorConfig = {},
    logger?: ILogger
  ) {
    this._eventBus = eventBus
    this._monitorDb = monitorDb
    this._logger = logger ?? console
    this._retentionDays = config.retentionDays ?? 90
    this._retentionHourUtc = config.retentionHourUtc ?? 0
    this._classifier = new TaskTypeClassifier(config.customTaxonomy)

    if (config.use_recommendations) {
      const recConfig: ConstructorParameters<typeof RecommendationEngine>[1] = {
        use_recommendations: config.use_recommendations,
      }
      if (config.recommendation_threshold_percentage !== undefined) {
        recConfig.recommendation_threshold_percentage = config.recommendation_threshold_percentage
      }
      if (config.min_sample_size !== undefined) {
        recConfig.min_sample_size = config.min_sample_size
      }
      if (config.recommendation_history_days !== undefined) {
        recConfig.recommendation_history_days = config.recommendation_history_days
      }
      this._recommendationEngine = new RecommendationEngine(monitorDb, recConfig)
    } else {
      this._recommendationEngine = null
    }

    this._onTaskComplete = (payload) => {
      const { taskId, result, taskType } = payload
      const agent = result.agent ?? ''
      let inputTokens: number | undefined
      let outputTokens: number | undefined
      if (result.inputTokens !== undefined || result.outputTokens !== undefined) {
        inputTokens = result.inputTokens
        outputTokens = result.outputTokens
      } else if (result.tokensUsed !== undefined && result.tokensUsed > 0) {
        inputTokens = Math.max(1, Math.round(result.tokensUsed * 0.7))
        outputTokens = Math.max(0, result.tokensUsed - inputTokens)
      }
      const data: {
        failureReason?: string
        inputTokens?: number
        outputTokens?: number
        durationMs?: number
        cost?: number
        estimatedCost?: number
        billingMode?: string
        taskType?: string
      } = { billingMode: 'api' }
      if (inputTokens !== undefined) data.inputTokens = inputTokens
      if (outputTokens !== undefined) data.outputTokens = outputTokens
      if (result.durationMs !== undefined) data.durationMs = result.durationMs
      if (result.costUsd !== undefined) {
        data.cost = result.costUsd
        data.estimatedCost = result.costUsd
      }
      if (taskType !== undefined) data.taskType = taskType
      this.recordTaskMetrics(taskId, agent, 'success', data)
    }

    this._onTaskFailed = (payload) => {
      const { taskId, error } = payload
      this.recordTaskMetrics(taskId, '', 'failure', {
        failureReason: error.message,
        billingMode: 'api',
      })
    }
  }

  async initialize(): Promise<void> {
    this._logger.info('MonitorAgent initializing')
    this._eventBus.on('task:complete', this._onTaskComplete)
    this._eventBus.on('task:failed', this._onTaskFailed)
    this._startRetentionCron()
    this._logger.info('MonitorAgent initialized — subscribed to task:complete and task:failed')
  }

  async shutdown(): Promise<void> {
    this._logger.info('MonitorAgent shutting down')
    this._eventBus.off('task:complete', this._onTaskComplete)
    this._eventBus.off('task:failed', this._onTaskFailed)
    if (this._retentionTimer !== null) {
      clearTimeout(this._retentionTimer)
      this._retentionTimer = null
    }
    if (this._retentionIntervalTimer !== null) {
      clearInterval(this._retentionIntervalTimer)
      this._retentionIntervalTimer = null
    }
    this._monitorDb.close()
    this._logger.info('MonitorAgent shutdown complete')
  }

  recordTaskMetrics(
    taskId: string,
    agent: string,
    outcome: 'success' | 'failure',
    data: {
      failureReason?: string
      inputTokens?: number
      outputTokens?: number
      durationMs?: number
      cost?: number
      estimatedCost?: number
      billingMode?: string
      taskType?: string
    }
  ): void {
    try {
      const classifyInput: { taskType?: string } = {}
      if (data.taskType !== undefined) classifyInput.taskType = data.taskType
      const taskType = this._classifier.classify(classifyInput)
      const now = new Date().toISOString()

      const row: TaskMetricsRow = {
        taskId,
        agent: agent || 'unknown',
        taskType,
        outcome,
        inputTokens: data.inputTokens ?? 0,
        outputTokens: data.outputTokens ?? 0,
        durationMs: data.durationMs ?? 0,
        cost: data.cost ?? 0,
        estimatedCost: data.estimatedCost ?? 0,
        billingMode: data.billingMode ?? 'api',
        recordedAt: now,
      }
      if (data.failureReason !== undefined) row.failureReason = data.failureReason

      this._monitorDb.insertTaskMetrics(row)
      this._monitorDb.updateAggregates(agent || 'unknown', taskType, {
        outcome,
        inputTokens: data.inputTokens ?? 0,
        outputTokens: data.outputTokens ?? 0,
        durationMs: data.durationMs ?? 0,
        cost: data.cost ?? 0,
      })
      this._eventBus.emit('monitor:metrics_recorded', {
        taskId,
        agent: agent || 'unknown',
        taskType,
      })
      this._logger.debug(
        `Task metrics recorded: taskId=${taskId} taskType=${taskType} outcome=${outcome}`
      )
    } catch (err) {
      this._logger.error(`Failed to record task metrics: taskId=${taskId} err=${String(err)}`)
    }
  }

  getRecommendation(taskType: string): Recommendation | null {
    if (this._recommendationEngine === null) return null
    return this._recommendationEngine.getMonitorRecommendation(taskType)
  }

  getRecommendations(): Recommendation[] {
    if (this._recommendationEngine === null) return []
    return this._recommendationEngine.generateRecommendations()
  }

  setCustomTaxonomy(taxonomy: Record<string, string[]>): void {
    this._classifier.setTaxonomy(taxonomy)
  }

  private _startRetentionCron(): void {
    const intervalMs = 24 * 60 * 60 * 1000
    const runPruning = () => {
      this._logger.info(`Running retention pruning (retentionDays=${this._retentionDays})`)
      try {
        const deleted = this._monitorDb.pruneOldData(this._retentionDays)
        this._logger.info(`Retention pruning complete: deleted=${deleted}`)
        if (deleted > 0) this._monitorDb.rebuildAggregates()
      } catch (err) {
        this._logger.error(`Retention pruning failed: ${String(err)}`)
      }
    }
    const now = new Date()
    const nextRun = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        this._retentionHourUtc,
        0,
        0,
        0
      )
    )
    if (nextRun.getTime() <= now.getTime()) nextRun.setUTCDate(nextRun.getUTCDate() + 1)
    const delayMs = nextRun.getTime() - now.getTime()
    const firstRunTimer = setTimeout(() => {
      this._retentionTimer = null
      runPruning()
      this._retentionIntervalTimer = setInterval(runPruning, intervalMs)
      this._retentionIntervalTimer.unref()
    }, delayMs)
    firstRunTimer.unref()
    this._retentionTimer = firstRunTimer
  }
}

export interface MonitorAgentOptions {
  eventBus: TypedEventBus<CoreEvents>
  monitorDb: MonitorDatabase
  config?: MonitorConfig
  logger?: ILogger
}

export function createMonitorAgent(options: MonitorAgentOptions): MonitorAgent {
  return new MonitorAgentImpl(options.eventBus, options.monitorDb, options.config, options.logger)
}
