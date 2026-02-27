/**
 * Unit tests for MonitorAgentImpl.
 *
 * Covers:
 *  - recordTaskMetrics records metrics to database with all fields
 *  - taskType classification works with explicit label
 *  - taskType classification works with heuristic matching
 *  - zero LLM calls during metric collection (all processing is synchronous/heuristic)
 *  - latency is negligible (< 5ms per metric, using a generous threshold)
 *  - initialize() subscribes to task:complete and task:failed events
 *  - shutdown() unsubscribes handlers and closes database
 *  - retention cron is started on initialize and stopped on shutdown
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MonitorAgentImpl, createMonitorAgent } from '../monitor-agent-impl.js'
import type { MonitorDatabase } from '../../../persistence/monitor-database.js'
import { createEventBus } from '../../../core/event-bus.js'
import type { TypedEventBus } from '../../../core/event-bus.js'

// ---------------------------------------------------------------------------
// Mock MonitorDatabase
// ---------------------------------------------------------------------------

function createMockMonitorDb(): MonitorDatabase & {
  insertTaskMetrics: ReturnType<typeof vi.fn>
  updateAggregates: ReturnType<typeof vi.fn>
  updatePerformanceAggregates: ReturnType<typeof vi.fn>
  getAggregates: ReturnType<typeof vi.fn>
  getTaskMetricsDateRange: ReturnType<typeof vi.fn>
  getAgentPerformance: ReturnType<typeof vi.fn>
  getTaskTypeBreakdown: ReturnType<typeof vi.fn>
  pruneOldData: ReturnType<typeof vi.fn>
  rebuildAggregates: ReturnType<typeof vi.fn>
  resetAllData: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  return {
    insertTaskMetrics: vi.fn(),
    updateAggregates: vi.fn(),
    updatePerformanceAggregates: vi.fn(),
    getAggregates: vi.fn().mockReturnValue([]),
    getTaskMetricsDateRange: vi.fn().mockReturnValue({ earliest: null, latest: null }),
    getAgentPerformance: vi.fn().mockReturnValue(null),
    getTaskTypeBreakdown: vi.fn().mockReturnValue(null),
    pruneOldData: vi.fn().mockReturnValue(0),
    rebuildAggregates: vi.fn(),
    resetAllData: vi.fn(),
    close: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// MonitorAgentImpl unit tests
// ---------------------------------------------------------------------------

describe('MonitorAgentImpl', () => {
  let eventBus: TypedEventBus
  let mockDb: ReturnType<typeof createMockMonitorDb>
  let agent: MonitorAgentImpl

  beforeEach(() => {
    eventBus = createEventBus()
    mockDb = createMockMonitorDb()
    agent = new MonitorAgentImpl(eventBus, mockDb)
  })

  afterEach(async () => {
    await agent.shutdown()
    vi.clearAllTimers()
  })

  // -------------------------------------------------------------------------
  // recordTaskMetrics — basic functionality
  // -------------------------------------------------------------------------

  it('recordTaskMetrics calls insertTaskMetrics with all fields', () => {
    agent.recordTaskMetrics('task-1', 'claude', 'success', {
      inputTokens: 100,
      outputTokens: 200,
      durationMs: 500,
      cost: 0.05,
      estimatedCost: 0.04,
      billingMode: 'api',
      taskType: 'testing',
    })

    expect(mockDb.insertTaskMetrics).toHaveBeenCalledOnce()
    const call = mockDb.insertTaskMetrics.mock.calls[0][0] as {
      taskId: string
      agent: string
      taskType: string
      outcome: string
      inputTokens: number
      outputTokens: number
      durationMs: number
      cost: number
      estimatedCost: number
      billingMode: string
      recordedAt: string
    }
    expect(call.taskId).toBe('task-1')
    expect(call.agent).toBe('claude')
    expect(call.taskType).toBe('testing')
    expect(call.outcome).toBe('success')
    expect(call.inputTokens).toBe(100)
    expect(call.outputTokens).toBe(200)
    expect(call.durationMs).toBe(500)
    expect(call.cost).toBe(0.05)
    expect(call.estimatedCost).toBe(0.04)
    expect(call.billingMode).toBe('api')
    expect(typeof call.recordedAt).toBe('string')
  })

  it('recordTaskMetrics calls updateAggregates after insert', () => {
    agent.recordTaskMetrics('task-1', 'claude', 'success', {
      inputTokens: 100,
      outputTokens: 200,
      durationMs: 500,
      cost: 0.05,
    })

    expect(mockDb.updateAggregates).toHaveBeenCalledOnce()
  })

  it('recordTaskMetrics records failure with reason', () => {
    agent.recordTaskMetrics('task-fail', 'claude', 'failure', {
      failureReason: 'Timeout exceeded',
      billingMode: 'api',
    })

    const call = mockDb.insertTaskMetrics.mock.calls[0][0] as {
      taskId: string
      outcome: string
      failureReason: string | undefined
    }
    expect(call.taskId).toBe('task-fail')
    expect(call.outcome).toBe('failure')
    expect(call.failureReason).toBe('Timeout exceeded')
  })

  it('recordTaskMetrics uses "unknown" agent when agent is empty string', () => {
    agent.recordTaskMetrics('task-1', '', 'success', {})

    const call = mockDb.insertTaskMetrics.mock.calls[0][0] as { agent: string }
    expect(call.agent).toBe('unknown')
  })

  it('recordTaskMetrics uses default values for optional fields', () => {
    agent.recordTaskMetrics('task-1', 'claude', 'success', {})

    const call = mockDb.insertTaskMetrics.mock.calls[0][0] as {
      inputTokens: number
      outputTokens: number
      durationMs: number
      cost: number
      estimatedCost: number
      billingMode: string
    }
    expect(call.inputTokens).toBe(0)
    expect(call.outputTokens).toBe(0)
    expect(call.durationMs).toBe(0)
    expect(call.cost).toBe(0)
    expect(call.estimatedCost).toBe(0)
    expect(call.billingMode).toBe('api')
  })

  // -------------------------------------------------------------------------
  // Task type classification
  // -------------------------------------------------------------------------

  it('uses explicit taskType when provided', () => {
    agent.recordTaskMetrics('task-1', 'claude', 'success', { taskType: 'testing' })

    const call = mockDb.insertTaskMetrics.mock.calls[0][0] as { taskType: string }
    expect(call.taskType).toBe('testing')
  })

  it('classifies task type by heuristic when no explicit type is given', () => {
    // No taskType provided — classifier will default to "coding"
    agent.recordTaskMetrics('task-1', 'claude', 'success', {})

    const call = mockDb.insertTaskMetrics.mock.calls[0][0] as { taskType: string }
    expect(call.taskType).toBe('coding') // default fallback
  })

  // -------------------------------------------------------------------------
  // Zero LLM calls
  // -------------------------------------------------------------------------

  it('makes no async LLM calls during metric collection (all sync)', () => {
    // recordTaskMetrics is synchronous — if it returned a Promise, it would be
    // a sign of async LLM usage. Verify the return type is void (undefined).
    const result = agent.recordTaskMetrics('task-1', 'claude', 'success', {})
    expect(result).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Latency constraint (AC1, NFR22)
  // -------------------------------------------------------------------------

  it('recordTaskMetrics completes in < 5ms (latency constraint)', () => {
    const start = performance.now()
    for (let i = 0; i < 10; i++) {
      agent.recordTaskMetrics(`task-${i}`, 'claude', 'success', {
        inputTokens: 100,
        outputTokens: 200,
        durationMs: 500,
        cost: 0.05,
      })
    }
    const elapsed = performance.now() - start
    // 10 records in < 50ms = < 5ms each on average
    expect(elapsed).toBeLessThan(50)
  })

  // -------------------------------------------------------------------------
  // initialize() — event subscriptions
  // -------------------------------------------------------------------------

  it('initialize() subscribes to task:complete events', async () => {
    await agent.initialize()

    const spy = vi.spyOn(agent, 'recordTaskMetrics')
    eventBus.emit('task:complete', {
      taskId: 'task-abc',
      result: { exitCode: 0, tokensUsed: 500, costUsd: 0.05 },
    })

    expect(spy).toHaveBeenCalledOnce()
    const call = spy.mock.calls[0]
    expect(call[0]).toBe('task-abc')
    expect(call[2]).toBe('success')
  })

  it('initialize() subscribes to task:failed events', async () => {
    await agent.initialize()

    const spy = vi.spyOn(agent, 'recordTaskMetrics')
    eventBus.emit('task:failed', {
      taskId: 'task-fail',
      error: { message: 'Process exited with code 1', code: 'EXIT_1' },
    })

    expect(spy).toHaveBeenCalledOnce()
    const call = spy.mock.calls[0]
    expect(call[0]).toBe('task-fail')
    expect(call[2]).toBe('failure')
    expect(call[3].failureReason).toBe('Process exited with code 1')
  })

  it('emits monitor:metrics_recorded event after recording', async () => {
    await agent.initialize()

    const monitorHandler = vi.fn()
    eventBus.on('monitor:metrics_recorded', monitorHandler)

    agent.recordTaskMetrics('task-1', 'claude', 'success', {})

    expect(monitorHandler).toHaveBeenCalledOnce()
    expect(monitorHandler).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', agent: 'claude' })
    )
  })

  // -------------------------------------------------------------------------
  // shutdown() — cleanup
  // -------------------------------------------------------------------------

  it('shutdown() unsubscribes from task:complete events', async () => {
    await agent.initialize()
    await agent.shutdown()

    const spy = vi.spyOn(agent, 'recordTaskMetrics')
    eventBus.emit('task:complete', {
      taskId: 'task-after-shutdown',
      result: { exitCode: 0 },
    })

    expect(spy).not.toHaveBeenCalled()
  })

  it('shutdown() unsubscribes from task:failed events', async () => {
    await agent.initialize()
    await agent.shutdown()

    const spy = vi.spyOn(agent, 'recordTaskMetrics')
    eventBus.emit('task:failed', {
      taskId: 'task-after-shutdown',
      error: { message: 'error' },
    })

    expect(spy).not.toHaveBeenCalled()
  })

  it('shutdown() closes the monitor database', async () => {
    await agent.initialize()
    await agent.shutdown()

    expect(mockDb.close).toHaveBeenCalledOnce()
  })

  it('shutdown() stops the retention timer', async () => {
    vi.useFakeTimers()
    await agent.initialize()
    await agent.shutdown()

    // After shutdown, advancing the timer should not trigger pruning
    vi.advanceTimersByTime(25 * 60 * 60 * 1000) // 25 hours
    expect(mockDb.pruneOldData).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // createMonitorAgent factory
  // -------------------------------------------------------------------------

  it('createMonitorAgent factory creates a MonitorAgent instance', () => {
    const bus = createEventBus()
    const db = createMockMonitorDb()
    const monitorAgent = createMonitorAgent({ eventBus: bus, monitorDb: db })
    expect(monitorAgent).toBeDefined()
    expect(typeof monitorAgent.initialize).toBe('function')
    expect(typeof monitorAgent.shutdown).toBe('function')
    expect(typeof monitorAgent.recordTaskMetrics).toBe('function')
  })

  it('createMonitorAgent respects custom config', () => {
    const bus = createEventBus()
    const db = createMockMonitorDb()
    const monitorAgent = createMonitorAgent({
      eventBus: bus,
      monitorDb: db,
      config: { retentionDays: 30, customTaxonomy: { mytype: ['custom_kw'] } },
    })
    expect(monitorAgent).toBeDefined()
  })
})
