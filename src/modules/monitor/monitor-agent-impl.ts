/**
 * MonitorAgentImpl — concrete implementation of the MonitorAgent interface.
 *
 * Responsibilities:
 *  - Subscribe to task:complete and task:failed events
 *  - Record metrics synchronously to the monitor database (no latency)
 *  - Run daily retention pruning cron job
 *  - Make ZERO LLM calls (FR69) — pure statistical processing
 *
 * Architecture constraints:
 *  - Uses better-sqlite3 synchronous API for zero-latency writes (NFR22)
 *  - All event subscriptions use synchronous handlers
 *  - Depends on TypedEventBus, MonitorDatabase, and TaskTypeClassifier
 */

import type { TypedEventBus } from '../../core/event-bus.js'
import type { MonitorAgent } from './monitor-agent.js'
import type { MonitorDatabase } from '../../persistence/monitor-database.js'
import { TaskTypeClassifier } from './task-type-classifier.js'
import { RecommendationEngine } from './recommendation-engine.js'
import type { Recommendation } from './recommendation-types.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('monitor:agent')

// ---------------------------------------------------------------------------
// MonitorConfig
// ---------------------------------------------------------------------------

export interface MonitorConfig {
  /** Number of days to retain task metrics (default: 90) */
  retentionDays?: number
  /** Hour of day (UTC) to run retention pruning (default: 0) */
  retentionHourUtc?: number
  /** Custom task type taxonomy override */
  customTaxonomy?: Record<string, string[]>
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
// MonitorAgentImpl
// ---------------------------------------------------------------------------

export class MonitorAgentImpl implements MonitorAgent {
  private readonly _eventBus: TypedEventBus
  private readonly _monitorDb: MonitorDatabase
  private readonly _classifier: TaskTypeClassifier
  private readonly _retentionDays: number
  private readonly _retentionHourUtc: number
  private _retentionTimer: ReturnType<typeof setInterval> | null = null
  private readonly _recommendationEngine: RecommendationEngine | null

  // Bound handlers stored for clean unsubscription
  private readonly _onTaskComplete: (payload: {
    taskId: string
    result: {
      output?: string
      exitCode?: number
      tokensUsed?: number
      costUsd?: number
    }
  }) => void

  private readonly _onTaskFailed: (payload: {
    taskId: string
    error: { message: string; code?: string; stack?: string }
  }) => void

  constructor(eventBus: TypedEventBus, monitorDb: MonitorDatabase, config: MonitorConfig = {}) {
    this._eventBus = eventBus
    this._monitorDb = monitorDb
    this._retentionDays = config.retentionDays ?? 90
    this._retentionHourUtc = config.retentionHourUtc ?? 0
    this._classifier = new TaskTypeClassifier(config.customTaxonomy)

    // Initialize recommendation engine if enabled
    if (config.use_recommendations) {
      this._recommendationEngine = new RecommendationEngine(monitorDb, {
        use_recommendations: config.use_recommendations,
        recommendation_threshold_percentage: config.recommendation_threshold_percentage,
        min_sample_size: config.min_sample_size,
        recommendation_history_days: config.recommendation_history_days,
      })
    } else {
      this._recommendationEngine = null
    }

    // Bind handlers once so we can reference the same function for off()
    this._onTaskComplete = (payload) => {
      const { taskId, result } = payload
      this.recordTaskMetrics(taskId, '', 'success', {
        inputTokens: result.tokensUsed,
        outputTokens: 0,
        cost: result.costUsd,
        estimatedCost: result.costUsd,
        billingMode: 'api',
      })
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
    logger.info('MonitorAgent initializing')

    // Subscribe to task lifecycle events
    this._eventBus.on('task:complete', this._onTaskComplete)
    this._eventBus.on('task:failed', this._onTaskFailed)

    // Start daily retention cron
    this._startRetentionCron()

    logger.info(
      { retentionDays: this._retentionDays },
      'MonitorAgent initialized — subscribed to task:complete and task:failed',
    )
  }

  async shutdown(): Promise<void> {
    logger.info('MonitorAgent shutting down')

    // Unsubscribe from all events
    this._eventBus.off('task:complete', this._onTaskComplete)
    this._eventBus.off('task:failed', this._onTaskFailed)

    // Stop retention cron
    if (this._retentionTimer !== null) {
      clearInterval(this._retentionTimer)
      this._retentionTimer = null
    }

    // Close database connection
    this._monitorDb.close()

    logger.info('MonitorAgent shutdown complete')
  }

  /**
   * Record metrics for a completed or failed task.
   * Executes synchronously (better-sqlite3) for zero-latency impact (NFR22).
   */
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
      const taskType = this._classifier.classify({ taskType: data.taskType })
      const now = new Date().toISOString()

      this._monitorDb.insertTaskMetrics({
        taskId,
        agent: agent || 'unknown',
        taskType,
        outcome,
        failureReason: data.failureReason,
        inputTokens: data.inputTokens ?? 0,
        outputTokens: data.outputTokens ?? 0,
        durationMs: data.durationMs ?? 0,
        cost: data.cost ?? 0,
        estimatedCost: data.estimatedCost ?? 0,
        billingMode: data.billingMode ?? 'api',
        recordedAt: now,
      })

      // Update performance aggregates
      this._monitorDb.updateAggregates(agent || 'unknown', taskType, {
        outcome,
        inputTokens: data.inputTokens ?? 0,
        outputTokens: data.outputTokens ?? 0,
        durationMs: data.durationMs ?? 0,
        cost: data.cost ?? 0,
      })

      // Emit monitor event
      this._eventBus.emit('monitor:metrics_recorded', {
        taskId,
        agent: agent || 'unknown',
        taskType,
      })

      logger.debug({ taskId, taskType, outcome }, 'Task metrics recorded')
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to record task metrics')
    }
  }

  /**
   * Get a routing recommendation for a specific task type (AC5, Story 8.6).
   * Returns null if no meaningful recommendation is available (e.g., insufficient data
   * or recommendations not enabled).
   */
  getRecommendation(taskType: string): Recommendation | null {
    if (this._recommendationEngine === null) {
      return null
    }
    return this._recommendationEngine.getMonitorRecommendation(taskType)
  }

  /**
   * Get all current routing recommendations (AC5, Story 8.6).
   * Returns an empty array if no recommendations are available or not enabled.
   */
  getRecommendations(): Recommendation[] {
    if (this._recommendationEngine === null) {
      return []
    }
    return this._recommendationEngine.generateRecommendations()
  }

  /**
   * Start the daily retention cron job.
   * Runs every 24 hours to prune data older than retentionDays.
   */
  private _startRetentionCron(): void {
    const intervalMs = 24 * 60 * 60 * 1000 // 24 hours

    this._retentionTimer = setInterval(() => {
      logger.info({ retentionDays: this._retentionDays }, 'Running retention pruning')
      try {
        const deleted = this._monitorDb.pruneOldData(this._retentionDays)
        logger.info({ deleted }, 'Retention pruning complete')

        if (deleted > 0) {
          // Rebuild aggregates after pruning to keep them consistent
          this._monitorDb.rebuildAggregates()
        }
      } catch (err) {
        logger.error({ err }, 'Retention pruning failed')
      }
    }, intervalMs)

    logger.debug({ intervalMs }, 'Retention cron started')
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface MonitorAgentOptions {
  eventBus: TypedEventBus
  monitorDb: MonitorDatabase
  config?: MonitorConfig
}

export function createMonitorAgent(options: MonitorAgentOptions): MonitorAgent {
  return new MonitorAgentImpl(options.eventBus, options.monitorDb, options.config)
}
