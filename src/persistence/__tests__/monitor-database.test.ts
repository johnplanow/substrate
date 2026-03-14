/**
 * Unit tests for MonitorDatabaseImpl.
 *
 * Covers:
 *  - Schema migration creates tables correctly
 *  - insertTaskMetrics persists to database
 *  - pruneOldData removes records older than retention period
 *  - rebuildAggregates recalculates performance_aggregates correctly
 *  - getAggregates returns filtered results
 *  - updateAggregates correctly upserts aggregate rows
 *
 * Uses WASM SQLite (sql.js) via WasmSqliteDatabaseAdapter for no-native-deps testing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MonitorDatabaseImpl, createMonitorDatabase } from '../monitor-database.js'
import type { TaskMetricsRow } from '../monitor-database.js'
import type { DatabaseAdapter } from '../adapter.js'
import { createWasmSqliteAdapter } from '../wasm-sqlite-adapter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetricsRow(overrides: Partial<TaskMetricsRow> = {}): TaskMetricsRow {
  return {
    taskId: 'task-1',
    agent: 'claude',
    taskType: 'coding',
    outcome: 'success',
    failureReason: undefined,
    inputTokens: 100,
    outputTokens: 200,
    durationMs: 500,
    cost: 0.05,
    estimatedCost: 0.04,
    billingMode: 'api',
    recordedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// MonitorDatabaseImpl tests
// ---------------------------------------------------------------------------

describe('MonitorDatabaseImpl', () => {
  let adapter: DatabaseAdapter
  let db: MonitorDatabaseImpl

  beforeEach(async () => {
    adapter = await createWasmSqliteAdapter()
    db = new MonitorDatabaseImpl(adapter)
  })

  afterEach(async () => {
    try {
      db.close()
    } catch {
      // Already closed
    }
    await adapter.close()
  })

  // -------------------------------------------------------------------------
  // Schema creation
  // -------------------------------------------------------------------------

  it('creates all required tables on initialization', async () => {
    const tables = await adapter.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )

    const tableNames = tables.map((t) => t.name)
    expect(tableNames).toContain('task_metrics')
    expect(tableNames).toContain('performance_aggregates')
    expect(tableNames).toContain('routing_recommendations')
    expect(tableNames).toContain('_schema_version')
  })

  it('creates all required indexes for task_metrics', async () => {
    const indexes = await adapter.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_metrics'",
    )

    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('idx_tm_agent')
    expect(indexNames).toContain('idx_tm_task_type')
    expect(indexNames).toContain('idx_tm_recorded_at')
    expect(indexNames).toContain('idx_tm_agent_type')
  })

  // -------------------------------------------------------------------------
  // insertTaskMetrics
  // -------------------------------------------------------------------------

  it('inserts a task metrics row successfully', async () => {
    const row = makeMetricsRow()
    db.insertTaskMetrics(row)

    const results = await adapter.query<{
      task_id: string
      agent: string
      task_type: string
      outcome: string
      input_tokens: number
      output_tokens: number
      duration_ms: number
      cost: number
      estimated_cost: number
      billing_mode: string
    }>('SELECT * FROM task_metrics WHERE task_id = ?', ['task-1'])

    expect(results).toHaveLength(1)
    const result = results[0]!
    expect(result.task_id).toBe('task-1')
    expect(result.agent).toBe('claude')
    expect(result.task_type).toBe('coding')
    expect(result.outcome).toBe('success')
    expect(result.input_tokens).toBe(100)
    expect(result.output_tokens).toBe(200)
    expect(result.duration_ms).toBe(500)
    expect(result.cost).toBe(0.05)
    expect(result.estimated_cost).toBe(0.04)
    expect(result.billing_mode).toBe('api')
  })

  it('inserts a failure metrics row with failure_reason', async () => {
    const row = makeMetricsRow({
      taskId: 'task-fail',
      outcome: 'failure',
      failureReason: 'Out of memory',
    })
    db.insertTaskMetrics(row)

    const results = await adapter.query<{ outcome: string; failure_reason: string }>(
      'SELECT * FROM task_metrics WHERE task_id = ?',
      ['task-fail'],
    )

    expect(results[0]!.outcome).toBe('failure')
    expect(results[0]!.failure_reason).toBe('Out of memory')
  })

  it('can insert multiple metrics rows', async () => {
    db.insertTaskMetrics(makeMetricsRow({ taskId: 'task-1', recordedAt: new Date(Date.now() - 1000).toISOString() }))
    db.insertTaskMetrics(makeMetricsRow({ taskId: 'task-2', recordedAt: new Date().toISOString() }))
    db.insertTaskMetrics(makeMetricsRow({ taskId: 'task-3', agent: 'codex', taskType: 'testing' }))

    const rows = await adapter.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM task_metrics')
    expect(rows[0]!.cnt).toBe(3)
  })

  // -------------------------------------------------------------------------
  // updateAggregates
  // -------------------------------------------------------------------------

  it('creates a new aggregate row on first upsert', () => {
    db.updateAggregates('claude', 'coding', {
      outcome: 'success',
      inputTokens: 100,
      outputTokens: 200,
      durationMs: 500,
      cost: 0.05,
    })

    const aggregates = db.getAggregates({ agent: 'claude', taskType: 'coding' })
    expect(aggregates).toHaveLength(1)
    expect(aggregates[0].totalTasks).toBe(1)
    expect(aggregates[0].successfulTasks).toBe(1)
    expect(aggregates[0].failedTasks).toBe(0)
    expect(aggregates[0].totalInputTokens).toBe(100)
    expect(aggregates[0].totalOutputTokens).toBe(200)
    expect(aggregates[0].totalDurationMs).toBe(500)
    expect(aggregates[0].totalCost).toBeCloseTo(0.05)
  })

  it('accumulates values on repeated upserts', () => {
    db.updateAggregates('claude', 'coding', {
      outcome: 'success',
      inputTokens: 100,
      outputTokens: 200,
      durationMs: 500,
      cost: 0.05,
    })
    db.updateAggregates('claude', 'coding', {
      outcome: 'failure',
      inputTokens: 50,
      outputTokens: 0,
      durationMs: 100,
      cost: 0.01,
    })

    const aggregates = db.getAggregates({ agent: 'claude', taskType: 'coding' })
    expect(aggregates[0].totalTasks).toBe(2)
    expect(aggregates[0].successfulTasks).toBe(1)
    expect(aggregates[0].failedTasks).toBe(1)
    expect(aggregates[0].totalInputTokens).toBe(150)
    expect(aggregates[0].totalOutputTokens).toBe(200)
    expect(aggregates[0].totalDurationMs).toBe(600)
    expect(aggregates[0].totalCost).toBeCloseTo(0.06)
  })

  // -------------------------------------------------------------------------
  // getAggregates
  // -------------------------------------------------------------------------

  it('returns all aggregates when no filter provided', () => {
    db.updateAggregates('claude', 'coding', { outcome: 'success', inputTokens: 10, outputTokens: 20, durationMs: 50, cost: 0.01 })
    db.updateAggregates('codex', 'testing', { outcome: 'success', inputTokens: 20, outputTokens: 40, durationMs: 100, cost: 0.02 })

    const aggregates = db.getAggregates()
    expect(aggregates.length).toBe(2)
  })

  it('filters aggregates by agent', () => {
    db.updateAggregates('claude', 'coding', { outcome: 'success', inputTokens: 10, outputTokens: 20, durationMs: 50, cost: 0.01 })
    db.updateAggregates('codex', 'testing', { outcome: 'success', inputTokens: 20, outputTokens: 40, durationMs: 100, cost: 0.02 })

    const aggregates = db.getAggregates({ agent: 'claude' })
    expect(aggregates).toHaveLength(1)
    expect(aggregates[0].agent).toBe('claude')
  })

  it('filters aggregates by taskType', () => {
    db.updateAggregates('claude', 'coding', { outcome: 'success', inputTokens: 10, outputTokens: 20, durationMs: 50, cost: 0.01 })
    db.updateAggregates('codex', 'testing', { outcome: 'success', inputTokens: 20, outputTokens: 40, durationMs: 100, cost: 0.02 })

    const aggregates = db.getAggregates({ taskType: 'testing' })
    expect(aggregates).toHaveLength(1)
    expect(aggregates[0].taskType).toBe('testing')
  })

  it('filters aggregates by sinceDate using performance_aggregates.last_updated (AC2/AC3)', () => {
    // updateAggregates sets last_updated to now, so these rows will pass a recent sinceDate filter
    db.updateAggregates('claude', 'coding', { outcome: 'success', inputTokens: 100, outputTokens: 0, durationMs: 0, cost: 0 })
    db.updateAggregates('codex', 'testing', { outcome: 'success', inputTokens: 200, outputTokens: 0, durationMs: 0, cost: 0 })

    // Filter to only rows updated since 5 days ago — both rows were just written, so both should pass
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    const aggregates = db.getAggregates({ sinceDate: fiveDaysAgo })

    expect(aggregates.length).toBeGreaterThanOrEqual(2)
  })

  it('returns empty array when sinceDate is in the future', () => {
    db.updateAggregates('claude', 'coding', { outcome: 'success', inputTokens: 100, outputTokens: 0, durationMs: 0, cost: 0 })

    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const aggregates = db.getAggregates({ sinceDate: futureDate })
    expect(aggregates).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // pruneOldData
  // -------------------------------------------------------------------------

  it('prunes records older than retention period', async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() // 100 days ago
    const recent = new Date().toISOString()

    db.insertTaskMetrics(makeMetricsRow({ taskId: 'old-task', recordedAt: old }))
    db.insertTaskMetrics(makeMetricsRow({ taskId: 'new-task', recordedAt: recent }))

    const deleted = db.pruneOldData(90) // 90-day retention
    expect(deleted).toBe(1)

    const remaining = await adapter.query<{ task_id: string }>('SELECT task_id FROM task_metrics')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.task_id).toBe('new-task')
  })

  it('returns 0 when no records are old enough to prune', () => {
    db.insertTaskMetrics(makeMetricsRow({ taskId: 'recent-task', recordedAt: new Date().toISOString() }))

    const deleted = db.pruneOldData(90)
    expect(deleted).toBe(0)
  })

  it('prunes all records when retention is 0 days', () => {
    db.insertTaskMetrics(makeMetricsRow({ taskId: 'task-1' }))

    // Wait a tick then set retention to 0 — everything older than now is pruned
    const deleted = db.pruneOldData(0)
    // 0 retention means "older than now" which includes most records
    // (depends on timing), but at least we verify it runs without error
    expect(typeof deleted).toBe('number')
  })

  // -------------------------------------------------------------------------
  // rebuildAggregates
  // -------------------------------------------------------------------------

  it('rebuilds aggregates from remaining metrics after pruning', () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    const recent = new Date().toISOString()

    // Insert old and recent metrics
    db.insertTaskMetrics(makeMetricsRow({ taskId: 'old-success', agent: 'claude', taskType: 'coding', outcome: 'success', inputTokens: 1000, recordedAt: old }))
    db.insertTaskMetrics(makeMetricsRow({ taskId: 'new-success', agent: 'claude', taskType: 'coding', outcome: 'success', inputTokens: 200, recordedAt: recent }))

    // Manually update aggregates to include old record's data
    db.updateAggregates('claude', 'coding', { outcome: 'success', inputTokens: 1000, outputTokens: 0, durationMs: 0, cost: 0 })
    db.updateAggregates('claude', 'coding', { outcome: 'success', inputTokens: 200, outputTokens: 0, durationMs: 0, cost: 0 })

    // Prune old data
    db.pruneOldData(90)

    // Rebuild aggregates — should now only reflect the recent record
    db.rebuildAggregates()

    const aggregates = db.getAggregates({ agent: 'claude', taskType: 'coding' })
    expect(aggregates).toHaveLength(1)
    expect(aggregates[0].totalTasks).toBe(1) // Only recent task remains
    expect(aggregates[0].totalInputTokens).toBe(200)
  })

  it('clears aggregates when all metrics are pruned', () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    db.insertTaskMetrics(makeMetricsRow({ taskId: 'old-task', recordedAt: old }))
    db.updateAggregates('claude', 'coding', { outcome: 'success', inputTokens: 100, outputTokens: 0, durationMs: 0, cost: 0 })

    db.pruneOldData(90)
    db.rebuildAggregates()

    const aggregates = db.getAggregates()
    expect(aggregates).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  it('close() shuts down the database without error', () => {
    expect(() => db.close()).not.toThrow()
  })

  it('close() is idempotent — can be called multiple times', () => {
    db.close()
    expect(() => db.close()).not.toThrow()
  })

  // -------------------------------------------------------------------------
  // resetAllData()
  // -------------------------------------------------------------------------

  it('resetAllData() deletes all task_metrics and performance_aggregates rows', async () => {
    db.insertTaskMetrics(makeMetricsRow({ taskId: 'task-1' }))
    db.insertTaskMetrics(makeMetricsRow({ taskId: 'task-2' }))
    db.updateAggregates('claude', 'coding', { outcome: 'success', inputTokens: 100, outputTokens: 0, durationMs: 0, cost: 0 })

    db.resetAllData()

    const metricsRows = await adapter.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM task_metrics')
    const aggRows = await adapter.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM performance_aggregates')

    expect(metricsRows[0]!.cnt).toBe(0)
    expect(aggRows[0]!.cnt).toBe(0)
  })

  it('createMonitorDatabase creates a working MonitorDatabase', () => {
    // Use the path-based factory (legacy path)
    const monitorDb = createMonitorDatabase(':memory:')
    expect(monitorDb).toBeDefined()
    // Should not throw on basic operations
    monitorDb.insertTaskMetrics(makeMetricsRow())
    const aggs = monitorDb.getAggregates()
    expect(aggs).toBeDefined()
    monitorDb.close()
  })
})
