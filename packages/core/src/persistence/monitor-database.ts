/**
 * MonitorDatabase — interface and implementation for the monitor database.
 * Migrated to @substrate-ai/core (Story 41-7)
 *
 * Accepts a DatabaseAdapter for persistence, allowing the same interface to
 * work with Dolt, InMemory, or WASM SQLite backends.
 */

import type { DatabaseAdapter, SyncAdapter } from './types.js'
import { isSyncAdapter } from './types.js'
import type { ILogger } from '../dispatch/types.js'
import type { AgentPerformanceMetrics, TaskTypeBreakdownResult } from '../monitor/performance-aggregates.js'

const _logger: ILogger = console

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
  insertTaskMetrics(row: TaskMetricsRow): void

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

  getAggregates(filter?: { agent?: string; taskType?: string; sinceDate?: string }): AggregateStats[]

  getAgentPerformance(agent: string): AgentPerformanceMetrics | null

  getTaskTypeBreakdown(taskType: string): TaskTypeBreakdownResult | null

  pruneOldData(retentionDays: number): number

  rebuildAggregates(): void

  resetAllData(): void

  getTaskMetricsDateRange(): { earliest: string | null; latest: string | null }

  close(): void
}

// ---------------------------------------------------------------------------
// MonitorDatabaseImpl
// ---------------------------------------------------------------------------

export class MonitorDatabaseImpl implements MonitorDatabase {
  protected _adapter: DatabaseAdapter | null
  private _syncAdapter: (DatabaseAdapter & SyncAdapter) | null
  private readonly _path: string

  constructor(databasePathOrAdapter: string | DatabaseAdapter) {
    if (typeof databasePathOrAdapter === 'string') {
      throw new Error(
        'MonitorDatabaseImpl: string path constructor is no longer supported. ' +
        'Pass a DatabaseAdapter directly: new MonitorDatabaseImpl(new InMemoryDatabaseAdapter())',
      )
    } else {
      this._path = '<adapter>'
      this._adapter = databasePathOrAdapter
    }

    this._syncAdapter = isSyncAdapter(this._adapter) ? this._adapter : null

    if (this._syncAdapter === null) {
      throw new Error(
        'MonitorDatabaseImpl: adapter must implement SyncAdapter (querySync/execSync). ' +
        'Use InMemoryDatabaseAdapter or another SyncAdapter-compatible adapter.'
      )
    }

    this._applySchemaSync()
    _logger.info('Monitor database ready')
  }

  private _applySchemaSync(): void {
    if (this._syncAdapter === null) return
    this._syncAdapter.execSync(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version_id  INTEGER PRIMARY KEY,
        applied_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    const existing = this._syncAdapter.querySync<{ version_id: number }>(
      'SELECT version_id FROM _schema_version WHERE version_id = 1',
    )
    if (existing.length === 0) {
      this._syncAdapter.querySync('INSERT INTO _schema_version (version_id) VALUES (1)')
    }
    this._syncAdapter.execSync(`
      CREATE TABLE IF NOT EXISTS task_metrics (
        task_id        VARCHAR(255) NOT NULL,
        agent          VARCHAR(128) NOT NULL,
        task_type      VARCHAR(128) NOT NULL,
        outcome        VARCHAR(16)  NOT NULL CHECK(outcome IN ('success', 'failure')),
        failure_reason TEXT,
        input_tokens   INTEGER NOT NULL DEFAULT 0,
        output_tokens  INTEGER NOT NULL DEFAULT 0,
        duration_ms    INTEGER NOT NULL DEFAULT 0,
        cost           DOUBLE  NOT NULL DEFAULT 0.0,
        estimated_cost DOUBLE  NOT NULL DEFAULT 0.0,
        billing_mode   VARCHAR(32) NOT NULL DEFAULT 'api',
        retries        INTEGER NOT NULL DEFAULT 0,
        recorded_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (task_id, recorded_at)
      )
    `)
    this._syncAdapter.execSync(`CREATE INDEX IF NOT EXISTS idx_tm_agent       ON task_metrics(agent)`)
    this._syncAdapter.execSync(`CREATE INDEX IF NOT EXISTS idx_tm_task_type   ON task_metrics(task_type)`)
    this._syncAdapter.execSync(`CREATE INDEX IF NOT EXISTS idx_tm_recorded_at ON task_metrics(recorded_at)`)
    this._syncAdapter.execSync(`CREATE INDEX IF NOT EXISTS idx_tm_agent_type  ON task_metrics(agent, task_type)`)
    this._syncAdapter.execSync(`
      CREATE TABLE IF NOT EXISTS performance_aggregates (
        agent              VARCHAR(255) NOT NULL,
        task_type          VARCHAR(255) NOT NULL,
        total_tasks        INTEGER NOT NULL DEFAULT 0,
        successful_tasks   INTEGER NOT NULL DEFAULT 0,
        failed_tasks       INTEGER NOT NULL DEFAULT 0,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_duration_ms  INTEGER NOT NULL DEFAULT 0,
        total_cost         DOUBLE  NOT NULL DEFAULT 0.0,
        total_retries      INTEGER NOT NULL DEFAULT 0,
        last_updated       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (agent, task_type)
      )
    `)
    this._syncAdapter.execSync(`
      CREATE TABLE IF NOT EXISTS routing_recommendations (
        id                INTEGER PRIMARY KEY AUTO_INCREMENT,
        task_type         VARCHAR(128) NOT NULL,
        current_agent     VARCHAR(128) NOT NULL,
        recommended_agent VARCHAR(128) NOT NULL,
        reason            TEXT,
        confidence        DOUBLE  NOT NULL DEFAULT 0.0,
        supporting_data   TEXT,
        generated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at        TEXT
      )
    `)
  }

  private _assertOpen(): DatabaseAdapter & SyncAdapter {
    if (this._syncAdapter === null || this._adapter === null) {
      throw new Error('MonitorDatabase: connection is closed')
    }
    return this._syncAdapter
  }

  private _querySync<T = unknown>(sql: string, params?: unknown[]): T[] {
    const adapter = this._assertOpen()
    return adapter.querySync<T>(sql, params)
  }

  private _mutateSync(sql: string, params?: unknown[]): void {
    const adapter = this._assertOpen()
    adapter.querySync(sql, params)
  }

  insertTaskMetrics(row: TaskMetricsRow): void {
    const dup = this._querySync<{ task_id: string }>(
      'SELECT task_id FROM task_metrics WHERE task_id = ? AND recorded_at = ?',
      [row.taskId, row.recordedAt],
    )
    if (dup.length > 0) return

    this._mutateSync(
      `INSERT INTO task_metrics (
        task_id, agent, task_type, outcome, failure_reason,
        input_tokens, output_tokens, duration_ms, cost, estimated_cost,
        billing_mode, recorded_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?
      )`,
      [
        row.taskId,
        row.agent,
        row.taskType,
        row.outcome,
        row.failureReason ?? null,
        row.inputTokens,
        row.outputTokens,
        row.durationMs,
        row.cost,
        row.estimatedCost,
        row.billingMode,
        row.recordedAt,
      ],
    )
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
    const now = new Date().toISOString()
    const successfulTasks = delta.outcome === 'success' ? 1 : 0
    const failedTasks = delta.outcome === 'failure' ? 1 : 0
    const retries = delta.retries ?? 0

    const existing = this._querySync<{ agent: string }>(
      `SELECT agent FROM performance_aggregates WHERE agent = ? AND task_type = ?`,
      [agent, taskType],
    )

    if (existing.length === 0) {
      this._mutateSync(
        `INSERT INTO performance_aggregates (
          agent, task_type, total_tasks, successful_tasks, failed_tasks,
          total_input_tokens, total_output_tokens, total_duration_ms, total_cost, total_retries, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          agent, taskType, 1, successfulTasks, failedTasks,
          delta.inputTokens, delta.outputTokens, delta.durationMs, delta.cost, retries, now,
        ],
      )
    } else {
      this._mutateSync(
        `UPDATE performance_aggregates SET
          total_tasks = total_tasks + 1,
          successful_tasks = successful_tasks + ?,
          failed_tasks = failed_tasks + ?,
          total_input_tokens = total_input_tokens + ?,
          total_output_tokens = total_output_tokens + ?,
          total_duration_ms = total_duration_ms + ?,
          total_cost = total_cost + ?,
          total_retries = total_retries + ?,
          last_updated = ?
        WHERE agent = ? AND task_type = ?`,
        [
          successfulTasks, failedTasks, delta.inputTokens, delta.outputTokens,
          delta.durationMs, delta.cost, retries, now, agent, taskType,
        ],
      )
    }
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
    let sql = `
      SELECT agent, task_type, total_tasks, successful_tasks, failed_tasks,
             total_input_tokens, total_output_tokens, total_duration_ms, total_cost, last_updated
      FROM performance_aggregates
    `
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter?.agent) {
      conditions.push('agent = ?')
      params.push(filter.agent)
    }
    if (filter?.taskType) {
      conditions.push('task_type = ?')
      params.push(filter.taskType)
    }
    if (filter?.sinceDate) {
      conditions.push('last_updated >= ?')
      params.push(filter.sinceDate)
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ')
    }

    const rows = this._querySync<{
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
    }>(sql, params)

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
    const rows = this._querySync<{
      total_tasks: number | null
      successful_tasks: number
      failed_tasks: number
      total_input_tokens: number
      total_output_tokens: number
      total_duration_ms: number
      total_cost: number
      total_retries: number
      last_updated: string | null
    }>(
      `SELECT
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
      WHERE agent = ?`,
      [agent],
    )

    const row = rows[0]
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
    const rows = this._querySync<{
      agent: string
      total_tasks: number
      successful_tasks: number
      total_input_tokens: number
      total_output_tokens: number
      total_duration_ms: number
      total_cost: number
      last_updated: string
    }>(
      `SELECT
        agent, total_tasks, successful_tasks,
        total_input_tokens, total_output_tokens, total_duration_ms, total_cost, last_updated
      FROM performance_aggregates
      WHERE task_type = ?
      ORDER BY (CAST(successful_tasks AS DOUBLE) / NULLIF(total_tasks, 0)) DESC`,
      [taskType],
    )

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
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

    const countRows = this._querySync<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM task_metrics WHERE recorded_at < ?`,
      [cutoff],
    )
    const count = countRows[0]?.cnt ?? 0

    this._mutateSync(`DELETE FROM task_metrics WHERE recorded_at < ?`, [cutoff])

    _logger.info(`Pruned ${count} old task_metrics rows (cutoff=${cutoff})`)
    return count
  }

  rebuildAggregates(): void {
    const adapter = this._assertOpen()

    try {
      adapter.execSync(`BEGIN`)

      this._mutateSync(`DELETE FROM performance_aggregates`)

      const rows = this._querySync<{
        agent: string
        task_type: string
        total_tasks: number
        successful_tasks: number
        failed_tasks: number
        total_input_tokens: number
        total_output_tokens: number
        total_duration_ms: number
        total_cost: number
        total_retries: number
      }>(
        `SELECT
          agent, task_type,
          COUNT(*) AS total_tasks,
          SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successful_tasks,
          SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failed_tasks,
          SUM(input_tokens) AS total_input_tokens,
          SUM(output_tokens) AS total_output_tokens,
          SUM(duration_ms) AS total_duration_ms,
          SUM(cost) AS total_cost,
          COALESCE(SUM(retries), 0) AS total_retries
        FROM task_metrics
        GROUP BY agent, task_type`,
      )

      const now = new Date().toISOString()
      for (const r of rows) {
        this._mutateSync(
          `INSERT INTO performance_aggregates (
            agent, task_type,
            total_tasks, successful_tasks, failed_tasks,
            total_input_tokens, total_output_tokens, total_duration_ms, total_cost, total_retries,
            last_updated
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            r.agent, r.task_type,
            r.total_tasks, r.successful_tasks, r.failed_tasks,
            r.total_input_tokens, r.total_output_tokens, r.total_duration_ms, r.total_cost, r.total_retries,
            now,
          ],
        )
      }

      adapter.execSync(`COMMIT`)
      _logger.info('Rebuilt performance_aggregates from task_metrics')
    } catch (err) {
      try { adapter.execSync(`ROLLBACK`) } catch { /* already rolled back */ }
      throw err
    }
  }

  resetAllData(): void {
    this._mutateSync(`DELETE FROM task_metrics`)
    this._mutateSync(`DELETE FROM performance_aggregates`)
    _logger.info('Monitor data reset — all rows deleted')
  }

  getTaskMetricsDateRange(): { earliest: string | null; latest: string | null } {
    const rows = this._querySync<{ earliest: string | null; latest: string | null }>(
      `SELECT MIN(recorded_at) AS earliest, MAX(recorded_at) AS latest FROM task_metrics`,
    )
    return { earliest: rows[0]?.earliest ?? null, latest: rows[0]?.latest ?? null }
  }

  close(): void {
    if (this._adapter === null) return
    void this._adapter.close()
    this._adapter = null
    this._syncAdapter = null
    _logger.info('Monitor database closed')
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMonitorDatabase(adapter: DatabaseAdapter): MonitorDatabase {
  return new MonitorDatabaseImpl(adapter)
}
