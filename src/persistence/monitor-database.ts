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
    }
  ): void

  /** Retrieve aggregated performance stats, optionally filtered */
  getAggregates(filter?: { agent?: string; taskType?: string }): AggregateStats[]

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
        total_input_tokens, total_output_tokens, total_duration_ms, total_cost, last_updated
      ) VALUES (
        @agent, @taskType, @totalTasks, @successfulTasks, @failedTasks,
        @inputTokens, @outputTokens, @durationMs, @cost, @lastUpdated
      )
      ON CONFLICT(agent, task_type) DO UPDATE SET
        total_tasks         = total_tasks + @totalTasks,
        successful_tasks    = successful_tasks + @successfulTasks,
        failed_tasks        = failed_tasks + @failedTasks,
        total_input_tokens  = total_input_tokens + @inputTokens,
        total_output_tokens = total_output_tokens + @outputTokens,
        total_duration_ms   = total_duration_ms + @durationMs,
        total_cost          = total_cost + @cost,
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
      lastUpdated: new Date().toISOString(),
    })
  }

  getAggregates(filter?: { agent?: string; taskType?: string }): AggregateStats[] {
    const db = this._assertOpen()

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
