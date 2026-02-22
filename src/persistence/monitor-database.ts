/**
 * MonitorDatabase — interface and implementation for the monitor SQLite database.
 *
 * The monitor database is SEPARATE from the main orchestrator database (ADR-011, AC2):
 *  - Default location: ~/.substrate/monitor.db or {project}/.substrate/monitor.db
 *  - Uses WAL mode for concurrent reads during writes
 *  - Uses better-sqlite3 synchronous API for zero-latency writes (NFR22)
 *  - Independent lifecycle: open/close managed by MonitorAgentImpl
 *
 * Implements:
 *  - insertTaskMetrics()     — persist a task execution record
 *  - updateAggregates()      — upsert performance_aggregates row
 *  - getAggregates()         — retrieve aggregate stats
 *  - pruneOldData()          — delete records older than retention window
 *  - rebuildAggregates()     — recompute aggregates from remaining metrics
 *  - close()                 — close the database connection
 */

import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3'
import { applyMonitorSchema } from './migrations/001-monitor-schema.js'
import { createLogger } from '../utils/logger.js'
import type { AgentPerformanceMetrics, TaskTypeBreakdownResult } from '../modules/monitor/performance-aggregates.js'

const logger = createLogger('persistence:monitor-db')

// ---------------------------------------------------------------------------
// TaskMetricsRow (database row shape)
// ---------------------------------------------------------------------------

export interface TaskMetricsRow {
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
// AggregateStats
// ---------------------------------------------------------------------------

export interface AggregateStats {
  agent: string
  taskType: string
  totalTasks: number
  successfulTasks: number
  failedTasks: number
  totalInputTokens: number
  totalOutputTokens: number
  totalDurationMs: number
  totalCost: number
  lastUpdated: string
}

// ---------------------------------------------------------------------------
// MonitorDatabase interface
// ---------------------------------------------------------------------------

export interface MonitorDatabase {
  /** Persist a task execution metrics record */
  insertTaskMetrics(row: TaskMetricsRow): void

  /**
   * Upsert performance_aggregates for a given (agent, taskType) pair.
   * Delta values are added to existing totals.
   */
  updateAggregates(
    agent: string,
    taskType: string,
    delta: {
      outcome: 'success' | 'failure'
      inputTokens: number
      outputTokens: number
      durationMs: number
      cost: number
      retries?: number
    }
  ): void

  /**
   * Alias for updateAggregates — provided for API consistency (AC6).
   */
  updatePerformanceAggregates(
    agent: string,
    taskType: string,
    delta: {
      outcome: 'success' | 'failure'
      inputTokens: number
      outputTokens: number
      durationMs: number
      cost: number
      retries?: number
    }
  ): void

  /** Retrieve aggregated performance stats, optionally filtered */
  getAggregates(filter?: { agent?: string; taskType?: string; sinceDate?: string }): AggregateStats[]

  /**
   * Get aggregated performance metrics for a single agent across all task types (AC1).
   * Returns null if the agent has no data.
   */
  getAgentPerformance(agent: string): AgentPerformanceMetrics | null

  /**
   * Get per-agent breakdown for a single task type (AC5).
   * Returns null if the task type has no data.
   */
  getTaskTypeBreakdown(taskType: string): TaskTypeBreakdownResult | null

  /**
   * Delete task_metrics rows older than retentionDays from now.
   * Returns the number of rows deleted.
   */
  pruneOldData(retentionDays: number): number

  /**
   * Recompute performance_aggregates from remaining task_metrics rows.
   * Called after pruning to keep aggregates consistent.
   */
  rebuildAggregates(): void

  /**
   * Delete all data from task_metrics and performance_aggregates tables.
   * Used by the monitor reset command (AC7).
   */
  resetAllData(): void

  /** Close the underlying database connection */
  close(): void
}

// ---------------------------------------------------------------------------
// MonitorDatabaseImpl
// ---------------------------------------------------------------------------

export class MonitorDatabaseImpl implements MonitorDatabase {
  private _db: BetterSqlite3Database | null = null
  private readonly _path: string

  // Prepared statements (initialized on open)
  private _stmtInsertMetrics!: Statement
  private _stmtUpsertAggregates!: Statement

  constructor(databasePath: string) {
    this._path = databasePath
    this._open()
  }

  private _open(): void {
    logger.info({ path: this._path }, 'Opening monitor database')
    this._db = new BetterSqlite3(this._path)

    // WAL mode for concurrent reads (ADR-011, AC2)
    const walResult = this._db.pragma('journal_mode = WAL') as { journal_mode: string }[]
    if (walResult?.[0]?.journal_mode !== 'wal') {
      logger.warn(
        { result: walResult?.[0]?.journal_mode },
        'Monitor DB: WAL pragma did not confirm wal mode',
      )
    }
    this._db.pragma('synchronous = NORMAL')
    this._db.pragma('busy_timeout = 5000')
    this._db.pragma('foreign_keys = ON')

    // Apply schema
    applyMonitorSchema(this._db)

    // Prepare statements
    this._stmtInsertMetrics = this._db.prepare(`
      INSERT OR REPLACE INTO task_metrics (
        task_id, agent, task_type, outcome, failure_reason,
        input_tokens, output_tokens, duration_ms, cost, estimated_cost,
        billing_mode, recorded_at
      ) VALUES (
        @taskId, @agent, @taskType, @outcome, @failureReason,
        @inputTokens, @outputTokens, @durationMs, @cost, @estimatedCost,
        @billingMode, @recordedAt
      )
    `)

    this._stmtUpsertAggregates = this._db.prepare(`
      INSERT INTO performance_aggregates (
        agent, task_type, total_tasks, successful_tasks, failed_tasks,
        total_input_tokens, total_output_tokens, total_duration_ms, total_cost, total_retries, last_updated
      ) VALUES (
        @agent, @taskType, @totalTasks, @successfulTasks, @failedTasks,
        @inputTokens, @outputTokens, @durationMs, @cost, @retries, @lastUpdated
      )
      ON CONFLICT(agent, task_type) DO UPDATE SET
        total_tasks         = total_tasks + @totalTasks,
        successful_tasks    = successful_tasks + @successfulTasks,
        failed_tasks        = failed_tasks + @failedTasks,
        total_input_tokens  = total_input_tokens + @inputTokens,
        total_output_tokens = total_output_tokens + @outputTokens,
        total_duration_ms   = total_duration_ms + @durationMs,
        total_cost          = total_cost + @cost,
        total_retries       = total_retries + @retries,
        last_updated        = @lastUpdated
    `)

    logger.info({ path: this._path }, 'Monitor database ready')
  }

  private _assertOpen(): BetterSqlite3Database {
    if (this._db === null) {
      throw new Error('MonitorDatabase: connection is closed')
    }
    return this._db
  }

  insertTaskMetrics(row: TaskMetricsRow): void {
    this._assertOpen()
    this._stmtInsertMetrics.run({
      taskId: row.taskId,
      agent: row.agent,
      taskType: row.taskType,
      outcome: row.outcome,
      failureReason: row.failureReason ?? null,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      durationMs: row.durationMs,
      cost: row.cost,
      estimatedCost: row.estimatedCost,
      billingMode: row.billingMode,
      recordedAt: row.recordedAt,
    })
  }

  updateAggregates(
    agent: string,
    taskType: string,
    delta: {
      outcome: 'success' | 'failure'
      inputTokens: number
      outputTokens: number
      durationMs: number
      cost: number
      retries?: number
    }
  ): void {
    this._assertOpen()
    this._stmtUpsertAggregates.run({
      agent,
      taskType,
      totalTasks: 1,
      successfulTasks: delta.outcome === 'success' ? 1 : 0,
      failedTasks: delta.outcome === 'failure' ? 1 : 0,
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      durationMs: delta.durationMs,
      cost: delta.cost,
      retries: delta.retries ?? 0,
      lastUpdated: new Date().toISOString(),
    })
  }

  updatePerformanceAggregates(
    agent: string,
    taskType: string,
    delta: {
      outcome: 'success' | 'failure'
      inputTokens: number
      outputTokens: number
      durationMs: number
      cost: number
      retries?: number
    }
  ): void {
    this.updateAggregates(agent, taskType, delta)
  }

  getAggregates(filter?: { agent?: string; taskType?: string; sinceDate?: string }): AggregateStats[] {
    const db = this._assertOpen()

    // Query pre-computed performance_aggregates with optional filters.
    // When sinceDate is provided, filter by last_updated >= sinceDate so that only
    // aggregates that have been updated within the history window are returned (AC2/AC3).
    // This is the correct semantic for the recommendation engine: stale aggregate rows
    // (agent/task_type pairs with no activity in the window) are excluded.
    let sql = `
      SELECT agent, task_type, total_tasks, successful_tasks, failed_tasks,
             total_input_tokens, total_output_tokens, total_duration_ms, total_cost, last_updated
      FROM performance_aggregates
    `
    const conditions: string[] = []
    const params: Record<string, string> = {}

    if (filter?.agent) {
      conditions.push('agent = @agent')
      params.agent = filter.agent
    }
    if (filter?.taskType) {
      conditions.push('task_type = @taskType')
      params.taskType = filter.taskType
    }
    if (filter?.sinceDate) {
      conditions.push('last_updated >= @sinceDate')
      params.sinceDate = filter.sinceDate
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ')
    }

    const rows = db.prepare(sql).all(params) as {
      agent: string
      task_type: string
      total_tasks: number
      successful_tasks: number
      failed_tasks: number
      total_input_tokens: number
      total_output_tokens: number
      total_duration_ms: number
      total_cost: number
      last_updated: string
    }[]

    return rows.map((r) => ({
      agent: r.agent,
      taskType: r.task_type,
      totalTasks: r.total_tasks,
      successfulTasks: r.successful_tasks,
      failedTasks: r.failed_tasks,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      totalDurationMs: r.total_duration_ms,
      totalCost: r.total_cost,
      lastUpdated: r.last_updated,
    }))
  }

  getAgentPerformance(agent: string): AgentPerformanceMetrics | null {
    const db = this._assertOpen()

    const row = db.prepare(`
      SELECT
        SUM(total_tasks)         AS total_tasks,
        SUM(successful_tasks)    AS successful_tasks,
        SUM(failed_tasks)        AS failed_tasks,
        SUM(total_input_tokens)  AS total_input_tokens,
        SUM(total_output_tokens) AS total_output_tokens,
        SUM(total_duration_ms)   AS total_duration_ms,
        SUM(total_cost)          AS total_cost,
        SUM(total_retries)       AS total_retries,
        MAX(last_updated)        AS last_updated
      FROM performance_aggregates
      WHERE agent = @agent
    `).get({ agent }) as {
      total_tasks: number | null
      successful_tasks: number
      failed_tasks: number
      total_input_tokens: number
      total_output_tokens: number
      total_duration_ms: number
      total_cost: number
      total_retries: number
      last_updated: string | null
    } | undefined

    if (row == null || row.total_tasks == null || row.total_tasks === 0) {
      return null
    }

    const totalTasks = row.total_tasks
    const successfulTasks = row.successful_tasks ?? 0
    const failedTasks = row.failed_tasks ?? 0
    const totalInputTokens = row.total_input_tokens ?? 0
    const totalOutputTokens = row.total_output_tokens ?? 0
    const totalDurationMs = row.total_duration_ms ?? 0
    const totalRetries = row.total_retries ?? 0

    return {
      total_tasks: totalTasks,
      successful_tasks: successfulTasks,
      failed_tasks: failedTasks,
      success_rate: (successfulTasks / totalTasks) * 100,
      failure_rate: (failedTasks / totalTasks) * 100,
      average_tokens: (totalInputTokens + totalOutputTokens) / totalTasks,
      average_duration: totalDurationMs / totalTasks,
      token_efficiency: totalInputTokens > 0 ? totalOutputTokens / totalInputTokens : 0,
      retry_rate: (totalRetries / totalTasks) * 100,
      last_updated: row.last_updated ?? new Date().toISOString(),
    }
  }

  getTaskTypeBreakdown(taskType: string): TaskTypeBreakdownResult | null {
    const db = this._assertOpen()

    const rows = db.prepare(`
      SELECT
        agent,
        total_tasks,
        successful_tasks,
        failed_tasks,
        total_input_tokens,
        total_output_tokens,
        total_duration_ms,
        total_cost,
        last_updated
      FROM performance_aggregates
      WHERE task_type = @taskType
      ORDER BY (CAST(successful_tasks AS REAL) / NULLIF(total_tasks, 0)) DESC
    `).all({ taskType }) as {
      agent: string
      total_tasks: number
      successful_tasks: number
      failed_tasks: number
      total_input_tokens: number
      total_output_tokens: number
      total_duration_ms: number
      total_cost: number
      last_updated: string
    }[]

    if (rows.length === 0) {
      return null
    }

    return {
      task_type: taskType,
      agents: rows.map((r) => ({
        agent: r.agent,
        total_tasks: r.total_tasks,
        success_rate: r.total_tasks > 0 ? (r.successful_tasks / r.total_tasks) * 100 : 0,
        average_tokens: r.total_tasks > 0 ? (r.total_input_tokens + r.total_output_tokens) / r.total_tasks : 0,
        average_duration: r.total_tasks > 0 ? r.total_duration_ms / r.total_tasks : 0,
        sample_size: r.total_tasks,
      })),
    }
  }

  pruneOldData(retentionDays: number): number {
    const db = this._assertOpen()
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
    const result = db.prepare('DELETE FROM task_metrics WHERE recorded_at < @cutoff').run({
      cutoff,
    })
    logger.info({ cutoff, deleted: result.changes }, 'Pruned old task_metrics rows')
    return result.changes
  }

  rebuildAggregates(): void {
    const db = this._assertOpen()

    // Recompute from scratch using task_metrics as source of truth
    db.exec(`
      DELETE FROM performance_aggregates;

      INSERT INTO performance_aggregates (
        agent, task_type,
        total_tasks, successful_tasks, failed_tasks,
        total_input_tokens, total_output_tokens, total_duration_ms, total_cost,
        last_updated
      )
      SELECT
        agent,
        task_type,
        COUNT(*)                                                    AS total_tasks,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END)       AS successful_tasks,
        SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END)       AS failed_tasks,
        SUM(input_tokens)                                           AS total_input_tokens,
        SUM(output_tokens)                                          AS total_output_tokens,
        SUM(duration_ms)                                            AS total_duration_ms,
        SUM(cost)                                                   AS total_cost,
        datetime('now')                                             AS last_updated
      FROM task_metrics
      GROUP BY agent, task_type;
    `)

    logger.info('Rebuilt performance_aggregates from task_metrics')
  }

  resetAllData(): void {
    const db = this._assertOpen()
    db.exec('DELETE FROM task_metrics')
    db.exec('DELETE FROM performance_aggregates')
    logger.info({ path: this._path }, 'Monitor data reset — all rows deleted')
  }

  close(): void {
    if (this._db === null) return
    this._db.close()
    this._db = null
    logger.info({ path: this._path }, 'Monitor database closed')
  }

  /**
   * Access the raw underlying database for testing purposes only.
   * @internal
   */
  get rawDb(): BetterSqlite3Database {
    return this._assertOpen()
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a MonitorDatabaseImpl connected to the given database path.
 *
 * @param databasePath - Path to the SQLite file (use ':memory:' for tests)
 */
export function createMonitorDatabase(databasePath: string): MonitorDatabase {
  return new MonitorDatabaseImpl(databasePath)
}
