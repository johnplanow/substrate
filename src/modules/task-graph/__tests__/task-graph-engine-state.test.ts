/**
 * Unit tests for TaskGraphEngine — Story 2-4 ACs
 *
 * Covers:
 *  - Task state transitions (markTaskRunning, markTaskComplete, markTaskFailed, markTaskCancelled)
 *  - State machine transitions (startExecution, pause, resume, cancelAll)
 *  - Scheduling logic (concurrency enforcement, cascading, completion detection)
 *  - In-flight tracking (race condition fix)
 *  - NFR1: scheduling latency (<500ms)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseServiceImpl } from '../../../persistence/database.js'
import { createEventBus } from '../../../core/event-bus.js'
import { TaskGraphEngineImpl } from '../task-graph-engine.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import { getTask, getTasksByStatus, getReadyTasks } from '../../../persistence/queries/tasks.js'

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function createTestEngine() {
  const dbService = new DatabaseServiceImpl(':memory:')
  const eventBus = createEventBus()
  const engine = new TaskGraphEngineImpl(eventBus, dbService)
  return { dbService, eventBus, engine }
}

/**
 * Load a simple graph with independent tasks (no dependencies).
 * All tasks are immediately ready.
 */
async function loadIndependentTasks(engine: TaskGraphEngineImpl, count: number): Promise<string> {
  const tasks: Record<string, { name: string; prompt: string; type: string; depends_on: string[] }> = {}
  for (let i = 1; i <= count; i++) {
    tasks[`task-${i}`] = {
      name: `Task ${i}`,
      prompt: `Do task ${i}`,
      type: 'coding',
      depends_on: [],
    }
  }

  const content = JSON.stringify({
    version: '1',
    session: { name: 'test-independent' },
    tasks,
  })
  return engine.loadGraphFromString(content, 'json')
}

/**
 * Load a chain graph: task-1 → task-2 → task-3
 */
async function loadChainGraph(engine: TaskGraphEngineImpl): Promise<string> {
  const content = JSON.stringify({
    version: '1',
    session: { name: 'test-chain' },
    tasks: {
      'task-1': { name: 'Task 1', prompt: 'Do 1', type: 'coding', depends_on: [] },
      'task-2': { name: 'Task 2', prompt: 'Do 2', type: 'coding', depends_on: ['task-1'] },
      'task-3': { name: 'Task 3', prompt: 'Do 3', type: 'coding', depends_on: ['task-2'] },
    },
  })
  return engine.loadGraphFromString(content, 'json')
}

/**
 * Load a diamond graph: task-1 → task-2a, task-2b → task-3
 */
async function loadDiamondGraph(engine: TaskGraphEngineImpl): Promise<string> {
  const content = JSON.stringify({
    version: '1',
    session: { name: 'test-diamond' },
    tasks: {
      'task-1': { name: 'Task 1', prompt: 'Do 1', type: 'coding', depends_on: [] },
      'task-2a': { name: 'Task 2a', prompt: 'Do 2a', type: 'coding', depends_on: ['task-1'] },
      'task-2b': { name: 'Task 2b', prompt: 'Do 2b', type: 'coding', depends_on: ['task-1'] },
      'task-3': { name: 'Task 3', prompt: 'Do 3', type: 'coding', depends_on: ['task-2a', 'task-2b'] },
    },
  })
  return engine.loadGraphFromString(content, 'json')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskGraphEngine — task state transitions', () => {
  let dbService: DatabaseServiceImpl
  let engine: TaskGraphEngineImpl
  let eventBus: TypedEventBus

  beforeEach(async () => {
    const setup = createTestEngine()
    dbService = setup.dbService
    engine = setup.engine
    eventBus = setup.eventBus
    await dbService.initialize()
    await engine.initialize()
  })

  afterEach(async () => {
    await dbService.shutdown()
  })

  // -------------------------------------------------------------------------
  // markTaskRunning
  // -------------------------------------------------------------------------

  describe('markTaskRunning', () => {
    it('transitions task from pending to running', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 5)

      engine.markTaskRunning('task-1', 'worker-1')

      const task = getTask(dbService.db, 'task-1')
      expect(task?.status).toBe('running')
      expect(task?.worker_id).toBe('worker-1')
      expect(task?.started_at).toBeDefined()
    })

    it('throws for non-existent task', () => {
      expect(() => engine.markTaskRunning('nonexistent', 'worker-1')).toThrow('not found')
    })

    it('writes intent log entry before status update', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 5)

      engine.markTaskRunning('task-1', 'worker-1')

      const logs = dbService.db
        .prepare("SELECT * FROM execution_log WHERE task_id = 'task-1' AND event = 'task:status_change'")
        .all() as Array<{ old_status: string; new_status: string }>
      expect(logs.length).toBeGreaterThanOrEqual(1)
      const logEntry = logs[logs.length - 1]
      expect(logEntry.old_status).toBe('pending')
      expect(logEntry.new_status).toBe('running')
    })
  })

  // -------------------------------------------------------------------------
  // markTaskComplete
  // -------------------------------------------------------------------------

  describe('markTaskComplete', () => {
    it('transitions task from running to completed', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('task-1', 'worker-1')

      engine.markTaskComplete('task-1', 'done', 0.05)

      const task = getTask(dbService.db, 'task-1')
      expect(task?.status).toBe('completed')
      expect(task?.result).toBe('done')
      expect(task?.cost_usd).toBe(0.05)
      expect(task?.completed_at).toBeDefined()
    })

    it('throws for non-existent task', () => {
      expect(() => engine.markTaskComplete('nonexistent', 'done')).toThrow('not found')
    })

    it('cascades scheduling after completion', async () => {
      const sessionId = await loadChainGraph(engine)
      const readyEvents: string[] = []
      eventBus.on('task:ready', ({ taskId }) => {
        readyEvents.push(taskId)
      })

      engine.startExecution(sessionId, 5)
      // task-1 should have been emitted as ready
      expect(readyEvents).toContain('task-1')

      // Mark task-1 running then complete
      engine.markTaskRunning('task-1', 'worker-1')
      readyEvents.length = 0
      engine.markTaskComplete('task-1', 'done')

      // task-2 should now be ready
      expect(readyEvents).toContain('task-2')
    })

    it('writes intent log entry with cost', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('task-1', 'worker-1')

      engine.markTaskComplete('task-1', 'done', 1.23)

      const logs = dbService.db
        .prepare("SELECT * FROM execution_log WHERE task_id = 'task-1' AND new_status = 'completed'")
        .all() as Array<{ cost_usd: number | null }>
      expect(logs.length).toBeGreaterThanOrEqual(1)
      expect(logs[0].cost_usd).toBe(1.23)
    })
  })

  // -------------------------------------------------------------------------
  // markTaskFailed
  // -------------------------------------------------------------------------

  describe('markTaskFailed', () => {
    it('transitions task to failed when no retries remain', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('task-1', 'worker-1')

      // Default max_retries is 2, retry_count starts at 0
      // Exhaust retries: fail 3 times (retry_count 0→1, 1→2, then 2 >= 2 = failed)
      engine.markTaskFailed('task-1', 'error 1', 1)
      // After first fail: retry_count=1, status='pending'
      let task = getTask(dbService.db, 'task-1')
      expect(task?.status).toBe('pending')
      expect(task?.retry_count).toBe(1)

      engine.markTaskRunning('task-1', 'worker-1')
      engine.markTaskFailed('task-1', 'error 2', 1)
      // After second fail: retry_count=2, but 2 >= max_retries(2) → failed? No: 1 < 2 so retry
      // Actually: retry_count was 1, 1 < 2 → canRetry, so becomes pending with retry_count=2
      task = getTask(dbService.db, 'task-1')
      expect(task?.status).toBe('pending')
      expect(task?.retry_count).toBe(2)

      engine.markTaskRunning('task-1', 'worker-1')
      engine.markTaskFailed('task-1', 'error 3', 1)
      // Now retry_count=2, 2 >= 2 → failed
      task = getTask(dbService.db, 'task-1')
      expect(task?.status).toBe('failed')
      expect(task?.error).toBe('error 3')
    })

    it('retries task when retries remain (resets to pending)', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('task-1', 'worker-1')

      engine.markTaskFailed('task-1', 'transient error', 1)

      const task = getTask(dbService.db, 'task-1')
      expect(task?.status).toBe('pending')
      expect(task?.retry_count).toBe(1)
      expect(task?.error).toBe('transient error')
    })

    it('throws for non-existent task', () => {
      expect(() => engine.markTaskFailed('nonexistent', 'err')).toThrow('not found')
    })

    it('sets exit_code on failure', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('task-1', 'worker-1')

      engine.markTaskFailed('task-1', 'crash', 127)

      const task = getTask(dbService.db, 'task-1')
      expect(task?.exit_code).toBe(127)
    })
  })

  // -------------------------------------------------------------------------
  // markTaskCancelled
  // -------------------------------------------------------------------------

  describe('markTaskCancelled', () => {
    it('transitions task to cancelled', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 5)

      engine.markTaskCancelled('task-1')

      const task = getTask(dbService.db, 'task-1')
      expect(task?.status).toBe('cancelled')
    })

    it('throws for non-existent task', () => {
      expect(() => engine.markTaskCancelled('nonexistent')).toThrow('not found')
    })

    it('writes intent log entry', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 5)

      engine.markTaskCancelled('task-1')

      const logs = dbService.db
        .prepare("SELECT * FROM execution_log WHERE task_id = 'task-1' AND new_status = 'cancelled'")
        .all() as Array<{ old_status: string; new_status: string }>
      expect(logs.length).toBeGreaterThanOrEqual(1)
    })
  })
})

// ---------------------------------------------------------------------------
// State machine transitions
// ---------------------------------------------------------------------------

describe('TaskGraphEngine — state machine transitions', () => {
  let dbService: DatabaseServiceImpl
  let engine: TaskGraphEngineImpl
  let eventBus: TypedEventBus

  beforeEach(async () => {
    const setup = createTestEngine()
    dbService = setup.dbService
    engine = setup.engine
    eventBus = setup.eventBus
    await dbService.initialize()
    await engine.initialize()
  })

  afterEach(async () => {
    await dbService.shutdown()
  })

  describe('startExecution', () => {
    it('transitions from Idle to Executing', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      expect(engine.state).toBe('Idle')

      engine.startExecution(sessionId, 2)

      expect(engine.state).toBe('Executing')
    })

    it('throws when called while already Executing', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 2)

      expect(() => engine.startExecution(sessionId, 2)).toThrow(
        'startExecution requires Idle state',
      )
    })

    it('emits task:ready events for initial ready tasks', async () => {
      const sessionId = await loadIndependentTasks(engine, 3)
      const readyEvents: string[] = []
      eventBus.on('task:ready', ({ taskId }) => {
        readyEvents.push(taskId)
      })

      engine.startExecution(sessionId, 5)

      expect(readyEvents).toContain('task-1')
      expect(readyEvents).toContain('task-2')
      expect(readyEvents).toContain('task-3')
    })
  })

  describe('pause', () => {
    it('transitions from Executing to Paused', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 2)

      engine.pause()

      expect(engine.state).toBe('Paused')
    })

    it('emits graph:paused event', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 2)

      const pausedHandler = vi.fn()
      eventBus.on('graph:paused', pausedHandler)

      engine.pause()

      expect(pausedHandler).toHaveBeenCalledOnce()
    })

    it('throws when called from Idle state', () => {
      expect(() => engine.pause()).toThrow('Invalid state transition')
    })
  })

  describe('resume', () => {
    it('transitions from Paused to Executing', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 2)
      engine.pause()
      expect(engine.state).toBe('Paused')

      engine.resume()

      expect(engine.state).toBe('Executing')
    })

    it('emits graph:resumed event', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 2)
      engine.pause()

      const resumedHandler = vi.fn()
      eventBus.on('graph:resumed', resumedHandler)

      engine.resume()

      expect(resumedHandler).toHaveBeenCalledOnce()
    })

    it('reschedules ready tasks on resume', async () => {
      const sessionId = await loadIndependentTasks(engine, 2)
      engine.startExecution(sessionId, 5)
      engine.pause()

      const readyEvents: string[] = []
      eventBus.on('task:ready', ({ taskId }) => {
        readyEvents.push(taskId)
      })

      engine.resume()

      // Since tasks are still pending, they should be re-emitted
      expect(readyEvents.length).toBeGreaterThan(0)
    })

    it('throws when called from Idle state', () => {
      expect(() => engine.resume()).toThrow('Invalid state transition')
    })
  })

  describe('cancelAll', () => {
    it('cancels all pending and running tasks', async () => {
      const sessionId = await loadIndependentTasks(engine, 3)
      engine.startExecution(sessionId, 5)

      // Mark one as running
      engine.markTaskRunning('task-1', 'worker-1')

      engine.cancelAll()

      const cancelled = getTasksByStatus(dbService.db, sessionId, 'cancelled')
      expect(cancelled.length).toBe(3)
    })

    it('emits graph:cancelled event with count', async () => {
      const sessionId = await loadIndependentTasks(engine, 2)
      engine.startExecution(sessionId, 5)

      const cancelledHandler = vi.fn()
      eventBus.on('graph:cancelled', cancelledHandler)

      engine.cancelAll()

      expect(cancelledHandler).toHaveBeenCalledOnce()
      expect(cancelledHandler).toHaveBeenCalledWith({ cancelledTasks: 2 })
    })

    it('emits graph:cancelled before transitioning to Idle', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 5)

      let stateAtCancelEvent: string | null = null
      eventBus.on('graph:cancelled', () => {
        stateAtCancelEvent = engine.state
      })

      engine.cancelAll()

      // The event should fire while still in Cancelling state
      expect(stateAtCancelEvent).toBe('Cancelling')
      // After cancelAll returns, should be Idle
      expect(engine.state).toBe('Idle')
    })

    it('transitions through Cancelling to Idle', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 5)

      engine.cancelAll()

      expect(engine.state).toBe('Idle')
    })

    it('handles cancelAll from Paused state', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      engine.startExecution(sessionId, 5)
      engine.pause()

      engine.cancelAll()

      expect(engine.state).toBe('Idle')
    })
  })
})

// ---------------------------------------------------------------------------
// Scheduling logic
// ---------------------------------------------------------------------------

describe('TaskGraphEngine — scheduling logic', () => {
  let dbService: DatabaseServiceImpl
  let engine: TaskGraphEngineImpl
  let eventBus: TypedEventBus

  beforeEach(async () => {
    const setup = createTestEngine()
    dbService = setup.dbService
    engine = setup.engine
    eventBus = setup.eventBus
    await dbService.initialize()
    await engine.initialize()
  })

  afterEach(async () => {
    await dbService.shutdown()
  })

  // -------------------------------------------------------------------------
  // Concurrency enforcement
  // -------------------------------------------------------------------------

  describe('concurrency enforcement', () => {
    it('respects maxConcurrency limit', async () => {
      const sessionId = await loadIndependentTasks(engine, 5)
      const readyEvents: string[] = []
      eventBus.on('task:ready', ({ taskId }) => {
        readyEvents.push(taskId)
      })

      engine.startExecution(sessionId, 2)

      // Only 2 tasks should be scheduled despite 5 being ready
      expect(readyEvents.length).toBe(2)
    })

    it('schedules more tasks as running tasks complete', async () => {
      const sessionId = await loadIndependentTasks(engine, 4)
      const readyEvents: string[] = []
      eventBus.on('task:ready', ({ taskId }) => {
        readyEvents.push(taskId)
      })

      engine.startExecution(sessionId, 2)
      expect(readyEvents.length).toBe(2)

      // Mark the first two as running and complete one
      engine.markTaskRunning(readyEvents[0], 'worker-1')
      engine.markTaskRunning(readyEvents[1], 'worker-2')
      readyEvents.length = 0

      engine.markTaskComplete('task-1', 'done')

      // Now a new slot opened up, so one more task should be scheduled
      expect(readyEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('in-flight count prevents over-scheduling', async () => {
      const sessionId = await loadIndependentTasks(engine, 5)
      const readyEvents: string[] = []
      eventBus.on('task:ready', ({ taskId }) => {
        readyEvents.push(taskId)
      })

      // maxConcurrency = 2
      engine.startExecution(sessionId, 2)

      // Only 2 should be emitted (in-flight count tracks them)
      expect(readyEvents.length).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  // Cascading (dependency resolution after completion)
  // -------------------------------------------------------------------------

  describe('cascading', () => {
    it('schedules dependent tasks when dependencies complete', async () => {
      const sessionId = await loadChainGraph(engine)
      const readyEvents: string[] = []
      eventBus.on('task:ready', ({ taskId }) => {
        readyEvents.push(taskId)
      })

      engine.startExecution(sessionId, 5)
      expect(readyEvents).toEqual(['task-1'])

      engine.markTaskRunning('task-1', 'worker-1')
      readyEvents.length = 0
      engine.markTaskComplete('task-1', 'done')

      expect(readyEvents).toEqual(['task-2'])

      engine.markTaskRunning('task-2', 'worker-2')
      readyEvents.length = 0
      engine.markTaskComplete('task-2', 'done')

      expect(readyEvents).toEqual(['task-3'])
    })

    it('schedules parallel tasks in diamond graph', async () => {
      const sessionId = await loadDiamondGraph(engine)
      const readyEvents: string[] = []
      eventBus.on('task:ready', ({ taskId }) => {
        readyEvents.push(taskId)
      })

      engine.startExecution(sessionId, 5)
      expect(readyEvents).toEqual(['task-1'])

      engine.markTaskRunning('task-1', 'worker-1')
      readyEvents.length = 0
      engine.markTaskComplete('task-1', 'done')

      // Both task-2a and task-2b should be ready
      expect(readyEvents).toContain('task-2a')
      expect(readyEvents).toContain('task-2b')
    })

    it('schedules join task only when ALL dependencies are met', async () => {
      const sessionId = await loadDiamondGraph(engine)
      const readyEvents: string[] = []
      eventBus.on('task:ready', ({ taskId }) => {
        readyEvents.push(taskId)
      })

      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('task-1', 'worker-1')
      engine.markTaskComplete('task-1', 'done')

      // Complete only task-2a
      engine.markTaskRunning('task-2a', 'worker-2')
      readyEvents.length = 0
      engine.markTaskComplete('task-2a', 'done')

      // task-3 should NOT be ready yet (task-2b still pending)
      expect(readyEvents).not.toContain('task-3')

      // Complete task-2b
      engine.markTaskRunning('task-2b', 'worker-3')
      readyEvents.length = 0
      engine.markTaskComplete('task-2b', 'done')

      // NOW task-3 should be ready
      expect(readyEvents).toContain('task-3')
    })
  })

  // -------------------------------------------------------------------------
  // Completion detection
  // -------------------------------------------------------------------------

  describe('completion detection', () => {
    it('emits graph:complete when all tasks are completed', async () => {
      const sessionId = await loadIndependentTasks(engine, 2)
      const completeHandler = vi.fn()
      eventBus.on('graph:complete', completeHandler)

      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('task-1', 'worker-1')
      engine.markTaskRunning('task-2', 'worker-2')
      engine.markTaskComplete('task-1', 'done', 0.01)
      engine.markTaskComplete('task-2', 'done', 0.02)

      expect(completeHandler).toHaveBeenCalledOnce()
      expect(completeHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          totalTasks: 2,
          completedTasks: 2,
          failedTasks: 0,
        }),
      )
    })

    it('emits graph:complete with correct cost aggregation', async () => {
      const sessionId = await loadIndependentTasks(engine, 2)
      const completeHandler = vi.fn()
      eventBus.on('graph:complete', completeHandler)

      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('task-1', 'worker-1')
      engine.markTaskRunning('task-2', 'worker-2')
      engine.markTaskComplete('task-1', 'done', 1.5)
      engine.markTaskComplete('task-2', 'done', 2.5)

      expect(completeHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          totalCostUsd: 4.0,
        }),
      )
    })

    it('emits graph:complete when remaining tasks are failed', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)

      // Set max_retries to 0 so first failure is terminal
      dbService.db
        .prepare("UPDATE tasks SET max_retries = 0 WHERE id = 'task-1'")
        .run()

      const completeHandler = vi.fn()
      eventBus.on('graph:complete', completeHandler)

      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('task-1', 'worker-1')
      engine.markTaskFailed('task-1', 'error', 1)

      expect(completeHandler).toHaveBeenCalledOnce()
      expect(completeHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          totalTasks: 1,
          completedTasks: 0,
          failedTasks: 1,
        }),
      )
    })

    it('does NOT emit graph:complete while in-flight tasks exist', async () => {
      const sessionId = await loadIndependentTasks(engine, 2)
      const completeHandler = vi.fn()
      eventBus.on('graph:complete', completeHandler)

      // Start execution — 2 tasks will be emitted as task:ready (in-flight)
      engine.startExecution(sessionId, 5)

      // Without calling markTaskRunning, in-flight count should prevent completion
      expect(completeHandler).not.toHaveBeenCalled()
    })

    it('transitions to Completing then emits graph:complete', async () => {
      const sessionId = await loadIndependentTasks(engine, 1)
      let stateAtComplete: string | null = null
      eventBus.on('graph:complete', () => {
        stateAtComplete = engine.state
      })

      engine.startExecution(sessionId, 5)
      engine.markTaskRunning('task-1', 'worker-1')
      engine.markTaskComplete('task-1', 'done')

      expect(stateAtComplete).toBe('Completing')
    })
  })

  // -------------------------------------------------------------------------
  // In-flight tracking (race condition fix)
  // -------------------------------------------------------------------------

  describe('in-flight tracking', () => {
    it('tracks emitted task:ready events as in-flight', async () => {
      const sessionId = await loadIndependentTasks(engine, 3)
      let readyCount = 0
      eventBus.on('task:ready', () => {
        readyCount++
      })

      engine.startExecution(sessionId, 3)

      // All 3 should be emitted
      expect(readyCount).toBe(3)
    })

    it('markTaskRunning decrements in-flight count', async () => {
      const sessionId = await loadIndependentTasks(engine, 2)

      engine.startExecution(sessionId, 2)
      // 2 tasks emitted (in-flight = 2)

      engine.markTaskRunning('task-1', 'worker-1')
      // in-flight = 1, running = 1

      engine.markTaskRunning('task-2', 'worker-2')
      // in-flight = 0, running = 2

      engine.markTaskComplete('task-1', 'done')
      engine.markTaskComplete('task-2', 'done')

      // Graph should complete because in-flight = 0, running = 0, ready = 0
      expect(engine.state).toBe('Completing')
    })

    it('cancelAll resets in-flight count', async () => {
      const sessionId = await loadIndependentTasks(engine, 3)

      engine.startExecution(sessionId, 3)
      // 3 tasks in-flight

      engine.cancelAll()
      expect(engine.state).toBe('Idle')
      // No errors — in-flight was properly reset
    })
  })
})

// ---------------------------------------------------------------------------
// NFR1: scheduling latency
// ---------------------------------------------------------------------------

describe('TaskGraphEngine — NFR1 scheduling latency', () => {
  let dbService: DatabaseServiceImpl
  let engine: TaskGraphEngineImpl
  let eventBus: TypedEventBus

  beforeEach(async () => {
    const setup = createTestEngine()
    dbService = setup.dbService
    engine = setup.engine
    eventBus = setup.eventBus
    await dbService.initialize()
    await engine.initialize()
  })

  afterEach(async () => {
    await dbService.shutdown()
  })

  it('scheduling latency is under 500ms for 50 tasks', async () => {
    const sessionId = await loadIndependentTasks(engine, 50)
    let readyCount = 0
    eventBus.on('task:ready', () => {
      readyCount++
    })

    const start = performance.now()
    engine.startExecution(sessionId, 50)
    const elapsed = performance.now() - start

    expect(readyCount).toBe(50)
    expect(elapsed).toBeLessThan(500)
  })

  it('cascading scheduling latency is under 500ms', async () => {
    const sessionId = await loadChainGraph(engine)
    engine.startExecution(sessionId, 5)
    engine.markTaskRunning('task-1', 'worker-1')

    const start = performance.now()
    engine.markTaskComplete('task-1', 'done')
    const elapsed = performance.now() - start

    // The cascading should be near-instant
    expect(elapsed).toBeLessThan(500)
  })
})

// ---------------------------------------------------------------------------
// Query methods
// ---------------------------------------------------------------------------

describe('TaskGraphEngine — query methods', () => {
  let dbService: DatabaseServiceImpl
  let engine: TaskGraphEngineImpl
  let eventBus: TypedEventBus

  beforeEach(async () => {
    const setup = createTestEngine()
    dbService = setup.dbService
    engine = setup.engine
    eventBus = setup.eventBus
    await dbService.initialize()
    await engine.initialize()
  })

  afterEach(async () => {
    await dbService.shutdown()
  })

  it('getReadyTasks returns tasks with satisfied deps', async () => {
    const sessionId = await loadChainGraph(engine)

    const ready = engine.getReadyTasks(sessionId)
    expect(ready.length).toBe(1)
    expect(ready[0].id).toBe('task-1')
  })

  it('getTask returns a task by ID', async () => {
    await loadChainGraph(engine)

    const task = engine.getTask('task-1')
    expect(task).toBeDefined()
    expect(task?.name).toBe('Task 1')
  })

  it('getTask returns undefined for non-existent task', async () => {
    const task = engine.getTask('nonexistent')
    expect(task).toBeUndefined()
  })

  it('getAllTasks returns all tasks for a session', async () => {
    const sessionId = await loadChainGraph(engine)

    const all = engine.getAllTasks(sessionId)
    expect(all.length).toBe(3)
  })

  it('getTasksByStatus returns filtered tasks', async () => {
    const sessionId = await loadChainGraph(engine)
    engine.startExecution(sessionId, 5)
    engine.markTaskRunning('task-1', 'worker-1')

    const running = engine.getTasksByStatus(sessionId, 'running')
    expect(running.length).toBe(1)
    expect(running[0].id).toBe('task-1')

    const pending = engine.getTasksByStatus(sessionId, 'pending')
    expect(pending.length).toBe(2)
  })
})
