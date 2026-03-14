/**
 * MonitorDatabase — interface and implementation for the monitor database.
 *
 * The monitor database stores task execution metrics and performance aggregates.
 * MonitorDatabaseImpl now accepts a DatabaseAdapter instead of creating its own
 * better-sqlite3 connection. This decouples persistence from the specific backend
 * and allows the same interface to work with Dolt, InMemory, or WASM SQLite.
 *
 * Implements:
 *  - insertTaskMetrics()     — persist a task execution record
 *  - updateAggregates()      — upsert performance_aggregates row
 *  - getAggregates()         — retrieve aggregate stats
 *  - pruneOldData()          — delete records older than retention window
 *  - rebuildAggregates()     — recompute aggregates from remaining metrics
 *  - close()                 — close the database connection
 */

import type { DatabaseAdapter, SyncAdapter } from './adapter.js'
import { createDatabaseAdapter, isSyncAdapter } from './adapter.js'
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

  /**
   * Get the earliest and latest recorded_at timestamps from the task_metrics table.
   * Returns null for both when the table is empty.
   */
  getTaskMetricsDateRange(): { earliest: string | null; latest: string | null }

  /** Close the underlying database connection */
  close(): void
}

// ---------------------------------------------------------------------------
// MonitorDatabaseImpl
// ---------------------------------------------------------------------------

/**
 * DatabaseAdapter-backed MonitorDatabase implementation.
 *
 * All database operations are executed synchronously by calling the adapter's
 * sync-compatible query path. The adapter is accepted via constructor injection,
 * so any backend (better-sqlite3 via LegacySqliteAdapter, InMemory, Dolt) works.
 *
 * Schema is applied on construction via _applySchema().
 */
export class MonitorDatabaseImpl implements MonitorDatabase {
  protected _adapter: DatabaseAdapter | null
  private _syncAdapter: (DatabaseAdapter & SyncAdapter) | null
  private readonly _path: string

  constructor(databasePathOrAdapter: string | DatabaseAdapter) {
    if (typeof databasePathOrAdapter === 'string') {
      // Legacy: create a sqlite adapter from the path string
      this._path = databasePathOrAdapter
      this._adapter = createDatabaseAdapter({ backend: 'sqlite', databasePath: databasePathOrAdapter })
    } else {
      this._path = '<adapter>'
      this._adapter = databasePathOrAdapter
    }

    // Cache sync adapter reference if available (for MonitorDatabase's sync interface)
    this._syncAdapter = isSyncAdapter(this._adapter) ? this._adapter : null

    if (this._syncAdapter === null) {
      throw new Error(
        'MonitorDatabaseImpl: adapter must implement SyncAdapter (querySync/execSync). ' +
        'Use createWasmSqliteAdapter() or createDatabaseAdapter({ backend: "sqlite" }) for tests.'
      )
    }

    // Apply schema synchronously using the sync adapter
    this._applySchemaSync()
    logger.info({ path: this._path }, 'Monitor database ready')
  }

  private _applySchemaSync(): void {
    if (this._syncAdapter === null) return
    this._syncAdapter.execSync(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version_id  INTEGER PRIMARY KEY,
        applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    this._syncAdapter.execSync(`INSERT OR IGNORE INTO _schema_version (version_id) VALUES (1)`)
    this._syncAdapter.execSync(`
      CREATE TABLE IF NOT EXISTS task_metrics (
        task_id        TEXT    NOT NULL,
        agent          TEXT    NOT NULL,
        task_type      TEXT    NOT NULL,
        outcome        TEXT    NOT NULL CHECK(outcome IN ('success', 'failure')),
        failure_reason TEXT,
        input_tokens   INTEGER NOT NULL DEFAULT 0,
        output_tokens  INTEGER NOT NULL DEFAULT 0,
        duration_ms    INTEGER NOT NULL DEFAULT 0,
        cost           REAL    NOT NULL DEFAULT 0.0,
        estimated_cost REAL    NOT NULL DEFAULT 0.0,
        billing_mode   TEXT    NOT NULL DEFAULT 'api',
        retries        INTEGER NOT NULL DEFAULT 0,
        recorded_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task_id, recorded_at)
      )
    `)
    this._syncAdapter.execSync(`CREATE INDEX IF NOT EXISTS idx_tm_agent       ON task_metrics(agent)`)
    this._syncAdapter.execSync(`CREATE INDEX IF NOT EXISTS idx_tm_task_type   ON task_metrics(task_type)`)
    this._syncAdapter.execSync(`CREATE INDEX IF NOT EXISTS idx_tm_recorded_at ON task_metrics(recorded_at)`)
    this._syncAdapter.execSync(`CREATE INDEX IF NOT EXISTS idx_tm_agent_type  ON task_metrics(agent, task_type)`)
    this._syncAdapter.execSync(`
      CREATE TABLE IF NOT EXISTS performance_aggregates (
        agent              TEXT    NOT NULL,
        task_type          TEXT    NOT NULL,
        total_tasks        INTEGER NOT NULL DEFAULT 0,
        successful_tasks   INTEGER NOT NULL DEFAULT 0,
        failed_tasks       INTEGER NOT NULL DEFAULT 0,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_duration_ms  INTEGER NOT NULL DEFAULT 0,
        total_cost         REAL    NOT NULL DEFAULT 0.0,
        total_retries      INTEGER NOT NULL DEFAULT 0,
        last_updated       TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent, task_type)
      )
    `)
    this._syncAdapter.execSync(`
      CREATE TABLE IF NOT EXISTS routing_recommendations (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        task_type         TEXT    NOT NULL,
        current_agent     TEXT    NOT NULL,
        recommended_agent TEXT    NOT NULL,
        reason            TEXT,
        confidence        REAL    NOT NULL DEFAULT 0.0,
        supporting_data   TEXT,
        generated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
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

  /**
   * Execute a query synchronously and return results.
   * Uses the SyncAdapter interface for guaranteed synchronous execution.
   */
  private _querySync<T = unknown>(sql: string, params?: unknown[]): T[] {
    const adapter = this._assertOpen()
    return adapter.querySync<T>(sql, params)
  }

  /**
   * Execute a mutation (INSERT/UPDATE/DELETE) synchronously.
   * Uses the SyncAdapter interface for guaranteed synchronous execution.
   */
  private _mutateSync(sql: string, params?: unknown[]): void {
    const adapter = this._assertOpen()
    adapter.querySync(sql, params)
  }

  insertTaskMetrics(row: TaskMetricsRow): void {
    this._mutateSync(
      `INSERT OR IGNORE INTO task_metrics (
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

    // Try INSERT first, then UPDATE on conflict
    // We need to handle UPSERT without ON CONFLICT...DO UPDATE since InMemoryAdapter
    // may not support that syntax. Use a check-then-insert/update approach.
    const existing = this._querySync<{ agent: string }>(
      `SELECT agent FROM performance_aggregates WHERE agent = ? AND task_type = ?`,
      [agent, taskType],
    )

    if (existing.length === 0) {
      // Insert new row
      this._mutateSync(
        `INSERT INTO performance_aggregates (
          agent, task_type, total_tasks, successful_tasks, failed_tasks,
          total_input_tokens, total_output_tokens, total_duration_ms, total_cost, total_retries, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          agent,
          taskType,
          1,
          successfulTasks,
          failedTasks,
          delta.inputTokens,
          delta.outputTokens,
          delta.durationMs,
          delta.cost,
          retries,
          now,
        ],
      )
    } else {
      // Update existing row by incrementing values
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
          successfulTasks,
          failedTasks,
          delta.inputTokens,
          delta.outputTokens,
          delta.durationMs,
          delta.cost,
          retries,
          now,
          agent,
          taskType,
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
      failed_tasks: number
      total_input_tokens: number
      total_output_tokens: number
      total_duration_ms: number
      total_cost: number
      last_updated: string
    }>(
      `SELECT
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
      WHERE task_type = ?
      ORDER BY (CAST(successful_tasks AS REAL) / NULLIF(total_tasks, 0)) DESC`,
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

    // Count first, then delete.
    // Note: this is a non-atomic two-statement pattern. If rows matching the
    // cutoff are inserted between the COUNT and the DELETE (highly unlikely
    // during a prune operation), the returned count may be slightly lower than
    // the actual number of rows deleted. This minor inaccuracy is acceptable
    // for the reporting use-case; the data is still correctly pruned.
    const countRows = this._querySync<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM task_metrics WHERE recorded_at < ?`,
      [cutoff],
    )
    const count = countRows[0]?.cnt ?? 0

    this._mutateSync(`DELETE FROM task_metrics WHERE recorded_at < ?`, [cutoff])

    logger.info({ cutoff, deleted: count }, 'Pruned old task_metrics rows')
    return count
  }

  rebuildAggregates(): void {
    // Wrap the DELETE + re-INSERT sequence in a transaction so that concurrent
    // readers never observe performance_aggregates in a partially-empty state.
    // Without this, a crash or error mid-loop would leave the table empty.
    // (AC6 requirement; see also Dev Notes on adapter.transaction())
    const adapter = this._assertOpen()

    try {
      adapter.execSync(`BEGIN`)

      // Clear aggregates first
      this._mutateSync(`DELETE FROM performance_aggregates`)

      // Recompute from task_metrics
      // Note: GROUP BY aggregation using raw SQL. InMemoryAdapter may not
      // support complex aggregates — for production Dolt/SQLite this works fully.
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
          agent,
          task_type,
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
            r.agent,
            r.task_type,
            r.total_tasks,
            r.successful_tasks,
            r.failed_tasks,
            r.total_input_tokens,
            r.total_output_tokens,
            r.total_duration_ms,
            r.total_cost,
            r.total_retries,
            now,
          ],
        )
      }

      adapter.execSync(`COMMIT`)
      logger.info('Rebuilt performance_aggregates from task_metrics')
    } catch (err) {
      try { adapter.execSync(`ROLLBACK`) } catch { /* already rolled back or no active transaction */ }
      throw err
    }
  }

  resetAllData(): void {
    this._mutateSync(`DELETE FROM task_metrics`)
    this._mutateSync(`DELETE FROM performance_aggregates`)
    logger.info({ path: this._path }, 'Monitor data reset — all rows deleted')
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
    logger.info({ path: this._path }, 'Monitor database closed')
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
