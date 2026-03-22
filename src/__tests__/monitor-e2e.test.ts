/**
 * End-to-end integration tests for the Monitor Agent.
 *
 * These tests use the actual MonitorDatabaseImpl and MonitorAgentImpl
 * connected via a real TypedEventBus to validate the complete flow:
 *  - Task:complete triggers metrics collection
 *  - Task:failed is recorded with failure reason
 *  - Retention pruning removes old records
 *  - Monitor database is independent from main database
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MonitorAgentImpl } from '../modules/monitor/monitor-agent-impl.js'
import { MonitorDatabaseImpl } from '../persistence/monitor-database.js'
import { InMemoryDatabaseAdapter } from '../persistence/memory-adapter.js'
import type { SyncAdapter } from '../persistence/adapter.js'
import { createEventBus } from '../core/event-bus.js'
import type { TypedEventBus } from '../core/event-bus.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestSetup(): Promise<{
  eventBus: TypedEventBus
  monitorDb: MonitorDatabaseImpl
  agent: MonitorAgentImpl
}> {
  const eventBus = createEventBus()
  const adapter = new InMemoryDatabaseAdapter()
  const monitorDb = new MonitorDatabaseImpl(adapter)
  const agent = new MonitorAgentImpl(eventBus, monitorDb, { retentionDays: 90 })
  return { eventBus, monitorDb, agent }
}

function getRowCount(db: MonitorDatabaseImpl, table: string): number {
  const syncAdapter = (db as unknown as { _syncAdapter: SyncAdapter | null })._syncAdapter
  if (!syncAdapter) throw new Error('No sync adapter available')
  const rows = syncAdapter.querySync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table}`)
  return rows[0]?.cnt ?? 0
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('Monitor Agent E2E Integration', () => {
  let setup: Awaited<ReturnType<typeof createTestSetup>>

  beforeEach(async () => {
    setup = await createTestSetup()
    await setup.agent.initialize()
  })

  afterEach(async () => {
    await setup.agent.shutdown()
  })

  // -------------------------------------------------------------------------
  // AC1: Automatic metrics collection on task completion
  // -------------------------------------------------------------------------

  it('task:complete event triggers monitor metrics collection', () => {
    const { eventBus, monitorDb } = setup

    eventBus.emit('task:complete', {
      taskId: 'task-e2e-1',
      result: {
        exitCode: 0,
        tokensUsed: 500,
        costUsd: 0.05,
      },
    })

    // Metrics should be persisted synchronously
    const count = getRowCount(monitorDb, 'task_metrics')
    expect(count).toBe(1)

    // Check the specific record
    const syncAdapter = (monitorDb as unknown as { _syncAdapter: SyncAdapter | null })._syncAdapter
    if (!syncAdapter) throw new Error('No sync adapter available')
    const [row] = syncAdapter.querySync<{ task_id: string; outcome: string; input_tokens: number }>(
      'SELECT * FROM task_metrics WHERE task_id = ?',
      ['task-e2e-1'],
    )
    expect(row).toBeDefined()
    expect(row!.task_id).toBe('task-e2e-1')
    expect(row!.outcome).toBe('success')
  })

  it('task:failed event is recorded with failure reason', () => {
    const { eventBus, monitorDb } = setup

    eventBus.emit('task:failed', {
      taskId: 'task-e2e-fail',
      error: {
        message: 'Process exited with non-zero code',
        code: 'ENONZERO',
      },
    })

    const syncAdapter = (monitorDb as unknown as { _syncAdapter: SyncAdapter | null })._syncAdapter
    if (!syncAdapter) throw new Error('No sync adapter available')
    const [row] = syncAdapter.querySync<{ task_id: string; outcome: string; failure_reason: string }>(
      'SELECT * FROM task_metrics WHERE task_id = ?',
      ['task-e2e-fail'],
    )
    expect(row).toBeDefined()
    expect(row!.task_id).toBe('task-e2e-fail')
    expect(row!.outcome).toBe('failure')
    expect(row!.failure_reason).toBe('Process exited with non-zero code')
  })

  it('both task:complete and task:failed events create separate records', () => {
    const { eventBus, monitorDb } = setup

    eventBus.emit('task:complete', {
      taskId: 'task-success',
      result: { exitCode: 0 },
    })
    eventBus.emit('task:failed', {
      taskId: 'task-failure',
      error: { message: 'Error occurred' },
    })

    const count = getRowCount(monitorDb, 'task_metrics')
    expect(count).toBe(2)
  })

  it('multiple completions build up performance_aggregates', () => {
    const { eventBus, monitorDb } = setup

    for (let i = 0; i < 5; i++) {
      eventBus.emit('task:complete', {
        taskId: `task-${i}`,
        result: { exitCode: 0, tokensUsed: 100, costUsd: 0.01 },
      })
    }

    const aggregates = monitorDb.getAggregates()
    expect(aggregates.length).toBeGreaterThan(0)
    const aggregate = aggregates[0]!
    expect(aggregate.totalTasks).toBe(5)
    expect(aggregate.successfulTasks).toBe(5)
    expect(aggregate.failedTasks).toBe(0)
  })

  // -------------------------------------------------------------------------
  // AC3: Zero LLM calls
  // -------------------------------------------------------------------------

  it('metrics collection is synchronous (no Promise returned)', () => {
    const { eventBus, monitorDb } = setup

    // Spy on insertTaskMetrics to verify it's called synchronously
    const insertSpy = vi.spyOn(monitorDb, 'insertTaskMetrics')

    eventBus.emit('task:complete', {
      taskId: 'task-sync',
      result: { exitCode: 0 },
    })

    // If synchronous, the spy should have been called by now
    expect(insertSpy).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // AC4: Data retention
  // -------------------------------------------------------------------------

  it('pruneOldData removes records older than retention window', () => {
    const { monitorDb } = setup

    // Manually insert old record directly to db
    const syncAdapter = (monitorDb as unknown as { _syncAdapter: SyncAdapter | null })._syncAdapter
    if (!syncAdapter) throw new Error('No sync adapter available')
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()

    syncAdapter.querySync(`
      INSERT INTO task_metrics (task_id, agent, task_type, outcome, input_tokens, output_tokens,
        duration_ms, cost, estimated_cost, billing_mode, recorded_at)
      VALUES ('old-task', 'claude', 'coding', 'success', 100, 200, 500, 0.05, 0.04, 'api', ?)
    `, [oldDate])

    const deleted = monitorDb.pruneOldData(90)
    expect(deleted).toBe(1)

    const count = getRowCount(monitorDb, 'task_metrics')
    expect(count).toBe(0)
  })

  // -------------------------------------------------------------------------
  // AC2: Monitor database is independent from main database
  // -------------------------------------------------------------------------

  it('monitor database uses its own separate in-memory connection', () => {
    const { monitorDb } = setup

    // Verify monitor DB has its own tables (not the main DB tables)
    const syncAdapter = (monitorDb as unknown as { _syncAdapter: SyncAdapter | null })._syncAdapter
    if (!syncAdapter) throw new Error('No sync adapter available')
    const tables = syncAdapter.querySync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    const tableNames = tables.map((t) => t.name)

    // Monitor-specific tables exist
    expect(tableNames).toContain('task_metrics')
    expect(tableNames).toContain('performance_aggregates')
    expect(tableNames).toContain('routing_recommendations')

    // Main DB tables should NOT exist in monitor DB
    expect(tableNames).not.toContain('sessions')
    expect(tableNames).not.toContain('tasks')
    expect(tableNames).not.toContain('task_dependencies')
  })

  // -------------------------------------------------------------------------
  // monitor:metrics_recorded event emitted
  // -------------------------------------------------------------------------

  it('emits monitor:metrics_recorded event on successful collection', () => {
    const { eventBus } = setup
    const monitorHandler = vi.fn()
    eventBus.on('monitor:metrics_recorded', monitorHandler)

    eventBus.emit('task:complete', {
      taskId: 'task-event-check',
      result: { exitCode: 0 },
    })

    expect(monitorHandler).toHaveBeenCalledOnce()
    expect(monitorHandler).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-event-check' })
    )
  })

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  it('after shutdown, task:complete events no longer trigger recording', async () => {
    const { eventBus, monitorDb, agent } = setup

    await agent.shutdown()

    const insertSpy = vi.spyOn(monitorDb, 'insertTaskMetrics')

    eventBus.emit('task:complete', {
      taskId: 'task-after-shutdown',
      result: { exitCode: 0 },
    })

    expect(insertSpy).not.toHaveBeenCalled()
  })
})
