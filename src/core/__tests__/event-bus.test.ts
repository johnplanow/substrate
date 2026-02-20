/**
 * Unit tests for TypedEventBus and OrchestratorEvents type safety.
 *
 * Covers:
 *  - Emit/subscribe with correct payload type
 *  - Unsubscribe removes handler
 *  - Multiple handlers for same event all invoked
 *  - Type safety: correct payload types enforced at compile time
 *  - Event dispatch is synchronous
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TypedEventBusImpl, createEventBus } from '../event-bus.js'
import type { TypedEventBus } from '../event-bus.js'
import type { OrchestratorEvents } from '../event-bus.types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandler<K extends keyof OrchestratorEvents>(
  _event: K
): (payload: OrchestratorEvents[K]) => void {
  return vi.fn()
}

// ---------------------------------------------------------------------------
// TypedEventBusImpl unit tests
// ---------------------------------------------------------------------------

describe('TypedEventBusImpl', () => {
  let bus: TypedEventBus

  beforeEach(() => {
    bus = new TypedEventBusImpl()
  })

  // -------------------------------------------------------------------------
  // Basic emit / subscribe
  // -------------------------------------------------------------------------

  it('invokes handler when matching event is emitted', () => {
    const handler = makeHandler('task:complete')
    bus.on('task:complete', handler)

    const payload: OrchestratorEvents['task:complete'] = {
      taskId: 'task-1',
      result: { exitCode: 0 },
    }
    bus.emit('task:complete', payload)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(payload)
  })

  it('does NOT invoke handler for a different event', () => {
    const handler = makeHandler('task:complete')
    bus.on('task:complete', handler)

    const payload: OrchestratorEvents['task:ready'] = { taskId: 'task-1' }
    bus.emit('task:ready', payload)

    expect(handler).not.toHaveBeenCalled()
  })

  it('invokes handler with the exact payload emitted', () => {
    const handler = makeHandler('task:started')
    bus.on('task:started', handler)

    const payload: OrchestratorEvents['task:started'] = {
      taskId: 'task-abc',
      workerId: 'worker-1',
      agent: 'claude',
    }
    bus.emit('task:started', payload)

    expect(handler).toHaveBeenCalledWith(payload)
  })

  // -------------------------------------------------------------------------
  // Unsubscribe
  // -------------------------------------------------------------------------

  it('unsubscribe with off() removes the handler', () => {
    const handler = makeHandler('task:ready')
    bus.on('task:ready', handler)

    bus.off('task:ready', handler)
    bus.emit('task:ready', { taskId: 'task-1' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('off() is a no-op when handler was not registered', () => {
    const handler = makeHandler('task:ready')
    // Should not throw
    expect(() => bus.off('task:ready', handler)).not.toThrow()
  })

  it('off() only removes the specific handler, not others', () => {
    const handlerA = makeHandler('task:ready')
    const handlerB = makeHandler('task:ready')

    bus.on('task:ready', handlerA)
    bus.on('task:ready', handlerB)

    bus.off('task:ready', handlerA)
    bus.emit('task:ready', { taskId: 'task-1' })

    expect(handlerA).not.toHaveBeenCalled()
    expect(handlerB).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // Multiple handlers
  // -------------------------------------------------------------------------

  it('invokes all registered handlers for the same event', () => {
    const handlerA = makeHandler('task:failed')
    const handlerB = makeHandler('task:failed')
    const handlerC = makeHandler('task:failed')

    bus.on('task:failed', handlerA)
    bus.on('task:failed', handlerB)
    bus.on('task:failed', handlerC)

    const payload: OrchestratorEvents['task:failed'] = {
      taskId: 'task-fail',
      error: { message: 'something went wrong' },
    }
    bus.emit('task:failed', payload)

    expect(handlerA).toHaveBeenCalledOnce()
    expect(handlerB).toHaveBeenCalledOnce()
    expect(handlerC).toHaveBeenCalledOnce()
  })

  it('invokes handlers in registration order', () => {
    const order: number[] = []
    bus.on('task:ready', () => order.push(1))
    bus.on('task:ready', () => order.push(2))
    bus.on('task:ready', () => order.push(3))

    bus.emit('task:ready', { taskId: 'task-1' })

    expect(order).toEqual([1, 2, 3])
  })

  // -------------------------------------------------------------------------
  // Synchronous dispatch
  // -------------------------------------------------------------------------

  it('dispatches events synchronously — handler runs before emit() returns', () => {
    let handlerCalled = false
    bus.on('orchestrator:ready', () => {
      handlerCalled = true
    })

    bus.emit('orchestrator:ready', {})
    // If dispatch were async, this would be false at this point
    expect(handlerCalled).toBe(true)
  })

  it('emit() can be called with no handlers registered — no error', () => {
    expect(() =>
      bus.emit('graph:complete', {
        totalTasks: 1,
        completedTasks: 1,
        failedTasks: 0,
        totalCostUsd: 0,
      })
    ).not.toThrow()
  })

  // -------------------------------------------------------------------------
  // Various event types
  // -------------------------------------------------------------------------

  it('handles budget:warning payload correctly', () => {
    const handler = makeHandler('budget:warning')
    bus.on('budget:warning', handler)

    const payload: OrchestratorEvents['budget:warning'] = {
      taskId: 'task-1',
      currentSpend: 8.0,
      limit: 10.0,
    }
    bus.emit('budget:warning', payload)

    expect(handler).toHaveBeenCalledWith(payload)
  })

  it('handles worktree:conflict payload correctly', () => {
    const handler = makeHandler('worktree:conflict')
    bus.on('worktree:conflict', handler)

    const payload: OrchestratorEvents['worktree:conflict'] = {
      taskId: 'task-1',
      conflictingFiles: ['src/index.ts', 'package.json'],
    }
    bus.emit('worktree:conflict', payload)

    expect(handler).toHaveBeenCalledWith(payload)
  })

  it('handles graph:paused payload (empty record) correctly', () => {
    const handler = makeHandler('graph:paused')
    bus.on('graph:paused', handler)

    bus.emit('graph:paused', {})

    expect(handler).toHaveBeenCalledWith({})
  })

  it('can subscribe/unsubscribe/re-subscribe the same handler', () => {
    const handler = makeHandler('task:ready')

    bus.on('task:ready', handler)
    bus.emit('task:ready', { taskId: 'task-1' })

    bus.off('task:ready', handler)
    bus.emit('task:ready', { taskId: 'task-2' })

    bus.on('task:ready', handler)
    bus.emit('task:ready', { taskId: 'task-3' })

    // Called for task-1 and task-3, not task-2
    expect(handler).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// createEventBus factory
// ---------------------------------------------------------------------------

describe('createEventBus', () => {
  it('returns a TypedEventBus instance', () => {
    const bus = createEventBus()
    expect(bus).toBeDefined()
    expect(typeof bus.emit).toBe('function')
    expect(typeof bus.on).toBe('function')
    expect(typeof bus.off).toBe('function')
  })

  it('created bus dispatches events correctly', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    bus.on('task:ready', handler)
    bus.emit('task:ready', { taskId: 'task-x' })
    expect(handler).toHaveBeenCalledWith({ taskId: 'task-x' })
  })
})
