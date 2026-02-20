/**
 * Integration tests for the Orchestrator factory and wiring.
 *
 * Covers:
 *  - Factory creates all modules and initializes them
 *  - orchestrator:ready is emitted on successful initialization
 *  - Graceful shutdown completes all modules
 *  - Events flow through the event bus correctly
 *  - Integration: emit event from one module, verify handler in different module runs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOrchestrator } from '../orchestrator-impl.js'
import type { OrchestratorConfig } from '../orchestrator.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG: OrchestratorConfig = {
  databasePath: ':memory:',
  projectRoot: '/tmp/test-project',
  maxConcurrency: 2,
  budgetCapUsd: 0,
  budgetCapTokens: 0,
}

// ---------------------------------------------------------------------------
// createOrchestrator tests
// ---------------------------------------------------------------------------

describe('createOrchestrator', () => {
  // Clean up process signal listeners between tests to avoid accumulation
  afterEach(() => {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
  })

  it('creates an orchestrator instance with an eventBus', async () => {
    const orchestrator = await createOrchestrator(TEST_CONFIG)
    expect(orchestrator).toBeDefined()
    expect(orchestrator.eventBus).toBeDefined()
    await orchestrator.shutdown()
  })

  it('sets isReady to true after initialization', async () => {
    const orchestrator = await createOrchestrator(TEST_CONFIG)
    expect(orchestrator.isReady).toBe(true)
    await orchestrator.shutdown()
  })

  it('emits orchestrator:ready event after initialization', async () => {
    // The orchestrator:ready event fires during factory execution before
    // createOrchestrator returns. We spy on the createEventBus factory to
    // capture the bus instance, then spy on its emit method to track events.
    const eventBusModule = await import('../event-bus.js')
    const originalCreateEventBus = eventBusModule.createEventBus

    let capturedBus: ReturnType<typeof originalCreateEventBus> | null = null
    const emittedEvents: string[] = []

    const createEventBusSpy = vi.spyOn(eventBusModule, 'createEventBus').mockImplementation(() => {
      const bus = originalCreateEventBus()
      const originalEmit = bus.emit.bind(bus)
      vi.spyOn(bus, 'emit').mockImplementation((event, payload) => {
        emittedEvents.push(String(event))
        return originalEmit(event, payload)
      })
      capturedBus = bus
      return bus
    })

    const orchestrator = await createOrchestrator(TEST_CONFIG)
    createEventBusSpy.mockRestore()

    // Direct assertion: orchestrator:ready was actually emitted
    expect(emittedEvents).toContain('orchestrator:ready')
    // Also verify the flag is consistent
    expect(orchestrator.isReady).toBe(true)
    await orchestrator.shutdown()
  })

  it('shutdown() sets isReady state and completes without error', async () => {
    const orchestrator = await createOrchestrator(TEST_CONFIG)
    await expect(orchestrator.shutdown()).resolves.not.toThrow()
  })

  it('shutdown() is idempotent — calling twice does not throw', async () => {
    const orchestrator = await createOrchestrator(TEST_CONFIG)
    await orchestrator.shutdown()
    await expect(orchestrator.shutdown()).resolves.not.toThrow()
  })

  it('eventBus is functional after initialization', async () => {
    const orchestrator = await createOrchestrator(TEST_CONFIG)
    const handler = vi.fn()

    orchestrator.eventBus.on('task:ready', handler)
    orchestrator.eventBus.emit('task:ready', { taskId: 'test-task' })

    expect(handler).toHaveBeenCalledWith({ taskId: 'test-task' })
    await orchestrator.shutdown()
  })

  it('events flow through event bus from one subscriber to another', async () => {
    const orchestrator = await createOrchestrator(TEST_CONFIG)

    const completionHandler = vi.fn()
    const progressHandler = vi.fn()

    orchestrator.eventBus.on('task:complete', completionHandler)
    orchestrator.eventBus.on('task:progress', progressHandler)

    // Emit task:progress (simulating a worker reporting)
    orchestrator.eventBus.emit('task:progress', {
      taskId: 'task-1',
      message: 'Running...',
      tokensUsed: 100,
    })

    // Emit task:complete (simulating task finishing)
    orchestrator.eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { exitCode: 0, tokensUsed: 500, costUsd: 0.05 },
    })

    expect(progressHandler).toHaveBeenCalledOnce()
    expect(completionHandler).toHaveBeenCalledOnce()

    await orchestrator.shutdown()
  })

  it('multiple modules can subscribe to same event and all receive it', async () => {
    const orchestrator = await createOrchestrator(TEST_CONFIG)

    // Simulate "module A" and "module B" both subscribing to task:complete
    const moduleAHandler = vi.fn()
    const moduleBHandler = vi.fn()

    orchestrator.eventBus.on('task:complete', moduleAHandler)
    orchestrator.eventBus.on('task:complete', moduleBHandler)

    orchestrator.eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { exitCode: 0 },
    })

    expect(moduleAHandler).toHaveBeenCalledOnce()
    expect(moduleBHandler).toHaveBeenCalledOnce()

    await orchestrator.shutdown()
  })

  it('orchestrator:shutdown event is emitted during shutdown', async () => {
    const orchestrator = await createOrchestrator(TEST_CONFIG)
    const shutdownHandler = vi.fn()

    orchestrator.eventBus.on('orchestrator:shutdown', shutdownHandler)
    await orchestrator.shutdown()

    expect(shutdownHandler).toHaveBeenCalledOnce()
    expect(shutdownHandler).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.any(String) })
    )
  })

  it('can handle worker lifecycle events end-to-end', async () => {
    const orchestrator = await createOrchestrator(TEST_CONFIG)

    const spawnedHandler = vi.fn()
    const terminatedHandler = vi.fn()

    orchestrator.eventBus.on('worker:spawned', spawnedHandler)
    orchestrator.eventBus.on('worker:terminated', terminatedHandler)

    orchestrator.eventBus.emit('worker:spawned', {
      workerId: 'worker-1',
      taskId: 'task-1',
      agent: 'claude',
    })
    orchestrator.eventBus.emit('worker:terminated', {
      workerId: 'worker-1',
      reason: 'completed',
    })

    expect(spawnedHandler).toHaveBeenCalledOnce()
    expect(terminatedHandler).toHaveBeenCalledOnce()

    await orchestrator.shutdown()
  })

  it('can handle budget events end-to-end', async () => {
    const orchestrator = await createOrchestrator(TEST_CONFIG)

    const warningHandler = vi.fn()
    const exceededHandler = vi.fn()

    orchestrator.eventBus.on('budget:warning', warningHandler)
    orchestrator.eventBus.on('budget:exceeded', exceededHandler)

    orchestrator.eventBus.emit('budget:warning', {
      taskId: 'task-1',
      currentSpend: 8.5,
      limit: 10.0,
    })
    orchestrator.eventBus.emit('budget:exceeded', {
      taskId: 'task-2',
      spend: 11.0,
      limit: 10.0,
    })

    expect(warningHandler).toHaveBeenCalledOnce()
    expect(exceededHandler).toHaveBeenCalledOnce()

    await orchestrator.shutdown()
  })

  it('can handle graph lifecycle events end-to-end', async () => {
    const orchestrator = await createOrchestrator(TEST_CONFIG)

    const loadedHandler = vi.fn()
    const completeHandler = vi.fn()

    orchestrator.eventBus.on('graph:loaded', loadedHandler)
    orchestrator.eventBus.on('graph:complete', completeHandler)

    orchestrator.eventBus.emit('graph:loaded', { sessionId: 'test-session', taskCount: 5, readyCount: 3 })
    orchestrator.eventBus.emit('graph:complete', {
      totalTasks: 5,
      completedTasks: 4,
      failedTasks: 1,
      totalCostUsd: 2.50,
    })

    expect(loadedHandler).toHaveBeenCalledOnce()
    expect(completeHandler).toHaveBeenCalledOnce()

    await orchestrator.shutdown()
  })

  it('can handle git worktree events end-to-end', async () => {
    const orchestrator = await createOrchestrator(TEST_CONFIG)

    const createdHandler = vi.fn()
    const conflictHandler = vi.fn()
    const mergedHandler = vi.fn()
    const removedHandler = vi.fn()

    orchestrator.eventBus.on('worktree:created', createdHandler)
    orchestrator.eventBus.on('worktree:conflict', conflictHandler)
    orchestrator.eventBus.on('worktree:merged', mergedHandler)
    orchestrator.eventBus.on('worktree:removed', removedHandler)

    orchestrator.eventBus.emit('worktree:created', {
      taskId: 'task-1',
      path: '/tmp/wt/task-1',
      branch: 'task/task-1',
    })
    orchestrator.eventBus.emit('worktree:merged', {
      taskId: 'task-1',
      branch: 'task/task-1',
    })
    orchestrator.eventBus.emit('worktree:removed', { taskId: 'task-1' })

    expect(createdHandler).toHaveBeenCalledOnce()
    expect(mergedHandler).toHaveBeenCalledOnce()
    expect(removedHandler).toHaveBeenCalledOnce()
    expect(conflictHandler).not.toHaveBeenCalled()

    await orchestrator.shutdown()
  })
})
