/**
 * MonitorAgent interface — public contract for the monitor agent module.
 *
 * The monitor agent is a passive observer that collects execution metrics
 * from every completed task. It makes zero LLM calls; all processing is
 * purely statistical and heuristic-based (FR69).
 *
 * Lifecycle: initialize() → recordTaskMetrics() [called automatically on events] → shutdown()
 */

import type { BaseService } from '../../core/di.js'

// ---------------------------------------------------------------------------
// TaskMetrics
// ---------------------------------------------------------------------------

/**
 * Full metrics record for a single task execution.
 */
export interface TaskMetrics {
  taskId: string
  agent: string
  taskType: string
  outcome: 'success' | 'failure'
  failureReason?: string
  inputTokens: number
  outputTokens: number
  durationMs: number
  cost: number
  estimatedCost: number
  billingMode: string
  recordedAt: string
}

// ---------------------------------------------------------------------------
// MonitorAgent interface
// ---------------------------------------------------------------------------

/**
 * Monitor agent — collects and persists task execution metrics automatically.
 *
 * Subscribes to `task:complete` and `task:failed` events via the event bus
 * and records metrics to a dedicated SQLite database (monitor.db).
 */
export interface MonitorAgent extends BaseService {
  /**
   * Record metrics for a completed or failed task.
   * Executes synchronously using better-sqlite3 to ensure zero latency impact
   * on the task execution pipeline (NFR22).
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
  ): void
}
