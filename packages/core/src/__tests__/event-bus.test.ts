/**
 * Unit tests for packages/core/src/events/event-bus.ts
 *
 * Tests the TypedEventBusImpl class and createEventBus factory:
 * - Basic emit/on/off lifecycle
 * - Typed event emission with correct payload delivery
 * - Multiple handlers for same event
 * - Handler removal (off)
 * - Synchronous dispatch guarantee
 * - Multiple event types coexisting
 * - createEventBus factory returns working instance
 */

import { describe, it, expect, vi } from 'vitest'
import { TypedEventBusImpl, createEventBus } from '../events/event-bus.js'
import type { TypedEventBus } from '../events/event-bus.js'

// ---------------------------------------------------------------------------
// Test event map types
// ---------------------------------------------------------------------------

interface TestEvents {
  'test:simple': { message: string }
  'test:numeric': { value: number }
  'test:complex': { items: string[]; count: number; nested: { ok: boolean } }
  'test:empty': Record<string, never>
}

// ---------------------------------------------------------------------------
// TypedEventBusImpl
// ---------------------------------------------------------------------------

describe('TypedEventBusImpl', () => {
  // -----------------------------------------------------------------------
  // emit / on basics
  // -----------------------------------------------------------------------

  describe('emit and on', () => {
    it('delivers a payload to a registered handler', () => {
      const bus = new TypedEventBusImpl<TestEvents>()
      const handler = vi.fn()

      bus.on('test:simple', handler)
      bus.emit('test:simple', { message: 'hello' })

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ message: 'hello' })
    })

    it('delivers correct payload for numeric events', () => {
      const bus = new TypedEventBusImpl<TestEvents>()
      const handler = vi.fn()

      bus.on('test:numeric', handler)
      bus.emit('test:numeric', { value: 42 })

      expect(handler).toHaveBeenCalledWith({ value: 42 })
    })

    it('delivers complex nested payloads', () => {
      const bus = new TypedEventBusImpl<TestEvents>()
      const handler = vi.fn()

      const payload = {
        items: ['a', 'b', 'c'],
        count: 3,
        nested: { ok: true },
      }

      bus.on('test:complex', handler)
      bus.emit('test:complex', payload)

      expect(handler).toHaveBeenCalledWith(payload)
    })

    it('does not deliver to handlers of different events', () => {
      const bus = new TypedEventBusImpl<TestEvents>()
      const simpleHandler = vi.fn()
      const numericHandler = vi.fn()

      bus.on('test:simple', simpleHandler)
      bus.on('test:numeric', numericHandler)

      bus.emit('test:simple', { message: 'only simple' })

      expect(simpleHandler).toHaveBeenCalledOnce()
      expect(numericHandler).not.toHaveBeenCalled()
    })

    it('emitting with no registered handlers does not throw', () => {
      const bus = new TypedEventBusImpl<TestEvents>()

      expect(() => {
        bus.emit('test:simple', { message: 'nobody listening' })
      }).not.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // Multiple handlers
  // -----------------------------------------------------------------------

  describe('multiple handlers', () => {
    it('delivers to all registered handlers for the same event', () => {
      const bus = new TypedEventBusImpl<TestEvents>()
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      const handler3 = vi.fn()

      bus.on('test:simple', handler1)
      bus.on('test:simple', handler2)
      bus.on('test:simple', handler3)

      bus.emit('test:simple', { message: 'broadcast' })

      expect(handler1).toHaveBeenCalledOnce()
      expect(handler2).toHaveBeenCalledOnce()
      expect(handler3).toHaveBeenCalledOnce()
      // All received the same payload
      for (const h of [handler1, handler2, handler3]) {
        expect(h).toHaveBeenCalledWith({ message: 'broadcast' })
      }
    })

    it('delivers multiple emissions to the same handler', () => {
      const bus = new TypedEventBusImpl<TestEvents>()
      const handler = vi.fn()

      bus.on('test:numeric', handler)
      bus.emit('test:numeric', { value: 1 })
      bus.emit('test:numeric', { value: 2 })
      bus.emit('test:numeric', { value: 3 })

      expect(handler).toHaveBeenCalledTimes(3)
      expect(handler).toHaveBeenNthCalledWith(1, { value: 1 })
      expect(handler).toHaveBeenNthCalledWith(2, { value: 2 })
      expect(handler).toHaveBeenNthCalledWith(3, { value: 3 })
    })
  })

  // -----------------------------------------------------------------------
  // off (handler removal)
  // -----------------------------------------------------------------------

  describe('off', () => {
    it('stops delivering to a removed handler', () => {
      const bus = new TypedEventBusImpl<TestEvents>()
      const handler = vi.fn()

      bus.on('test:simple', handler)
      bus.emit('test:simple', { message: 'before off' })
      expect(handler).toHaveBeenCalledOnce()

      bus.off('test:simple', handler)
      bus.emit('test:simple', { message: 'after off' })
      expect(handler).toHaveBeenCalledOnce() // still 1, not 2
    })

    it('only removes the specific handler, not others', () => {
      const bus = new TypedEventBusImpl<TestEvents>()
      const handlerA = vi.fn()
      const handlerB = vi.fn()

      bus.on('test:simple', handlerA)
      bus.on('test:simple', handlerB)

      bus.off('test:simple', handlerA)
      bus.emit('test:simple', { message: 'after removing A' })

      expect(handlerA).not.toHaveBeenCalled()
      expect(handlerB).toHaveBeenCalledOnce()
    })

    it('removing a handler that was never registered does not throw', () => {
      const bus = new TypedEventBusImpl<TestEvents>()
      const handler = vi.fn()

      expect(() => {
        bus.off('test:simple', handler)
      }).not.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // Synchronous dispatch
  // -----------------------------------------------------------------------

  describe('synchronous dispatch', () => {
    it('all handlers complete before emit returns', () => {
      const bus = new TypedEventBusImpl<TestEvents>()
      const order: number[] = []

      bus.on('test:simple', () => order.push(1))
      bus.on('test:simple', () => order.push(2))

      bus.emit('test:simple', { message: 'sync test' })
      order.push(3) // This runs after emit returns

      // If dispatch were async, order might be [3, 1, 2]
      expect(order).toEqual([1, 2, 3])
    })
  })

  // -----------------------------------------------------------------------
  // Multiple event types
  // -----------------------------------------------------------------------

  describe('event type isolation', () => {
    it('maintains separate handler lists per event type', () => {
      const bus = new TypedEventBusImpl<TestEvents>()
      const simpleHandler = vi.fn()
      const numericHandler = vi.fn()

      bus.on('test:simple', simpleHandler)
      bus.on('test:numeric', numericHandler)

      bus.emit('test:simple', { message: 'hello' })
      bus.emit('test:numeric', { value: 99 })

      expect(simpleHandler).toHaveBeenCalledOnce()
      expect(simpleHandler).toHaveBeenCalledWith({ message: 'hello' })
      expect(numericHandler).toHaveBeenCalledOnce()
      expect(numericHandler).toHaveBeenCalledWith({ value: 99 })
    })

    it('removing handler for one event does not affect others', () => {
      const bus = new TypedEventBusImpl<TestEvents>()
      const simpleHandler = vi.fn()
      const numericHandler = vi.fn()

      bus.on('test:simple', simpleHandler)
      bus.on('test:numeric', numericHandler)

      bus.off('test:simple', simpleHandler)

      bus.emit('test:simple', { message: 'removed' })
      bus.emit('test:numeric', { value: 1 })

      expect(simpleHandler).not.toHaveBeenCalled()
      expect(numericHandler).toHaveBeenCalledOnce()
    })
  })
})

// ---------------------------------------------------------------------------
// createEventBus factory
// ---------------------------------------------------------------------------

describe('createEventBus', () => {
  it('returns a TypedEventBusImpl instance', () => {
    const bus = createEventBus<TestEvents>()

    expect(bus).toBeInstanceOf(TypedEventBusImpl)
  })

  it('returned bus supports full emit/on/off lifecycle', () => {
    const bus: TypedEventBus<TestEvents> = createEventBus<TestEvents>()
    const handler = vi.fn()

    bus.on('test:simple', handler)
    bus.emit('test:simple', { message: 'factory test' })

    expect(handler).toHaveBeenCalledWith({ message: 'factory test' })

    bus.off('test:simple', handler)
    bus.emit('test:simple', { message: 'after off' })

    expect(handler).toHaveBeenCalledOnce()
  })
})
