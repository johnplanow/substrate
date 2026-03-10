/**
 * Unit tests for BatchBuffer (Story 27-12, Task 6).
 *
 * Verifies size-triggered and timer-triggered flush behavior, start/stop
 * lifecycle, and EventEmitter usage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BatchBuffer } from '../batch-buffer.js'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BatchBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -- constructor defaults --

  it('has default batchSize of 100', () => {
    const buffer = new BatchBuffer<number>()
    const flushed: number[][] = []
    buffer.on('flush', (items: number[]) => flushed.push(items))

    // Push 99 items — should not flush
    for (let i = 0; i < 99; i++) buffer.push(i)
    expect(flushed).toHaveLength(0)

    // Push 1 more — should flush
    buffer.push(99)
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toHaveLength(100)
  })

  // -- size-triggered flush --

  it('flushes immediately when batchSize is reached', () => {
    const buffer = new BatchBuffer<string>({ batchSize: 3 })
    const flushed: string[][] = []
    buffer.on('flush', (items: string[]) => flushed.push(items))

    buffer.push('a')
    buffer.push('b')
    expect(flushed).toHaveLength(0)
    buffer.push('c')
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toEqual(['a', 'b', 'c'])
  })

  it('clears the internal buffer after a size-triggered flush', () => {
    const buffer = new BatchBuffer<number>({ batchSize: 2 })
    const flushed: number[][] = []
    buffer.on('flush', (items: number[]) => flushed.push(items))

    buffer.push(1)
    buffer.push(2) // triggers flush
    buffer.push(3) // starts new batch
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toEqual([1, 2])

    buffer.push(4) // triggers second flush
    expect(flushed).toHaveLength(2)
    expect(flushed[1]).toEqual([3, 4])
  })

  // -- timer-triggered flush --

  it('flushes on timer when flushIntervalMs elapses', () => {
    const buffer = new BatchBuffer<number>({ batchSize: 100, flushIntervalMs: 1000 })
    const flushed: number[][] = []
    buffer.on('flush', (items: number[]) => flushed.push(items))
    buffer.start()

    buffer.push(1)
    buffer.push(2)
    expect(flushed).toHaveLength(0)

    vi.advanceTimersByTime(1000)
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toEqual([1, 2])

    buffer.stop()
  })

  it('does not flush on timer when buffer is empty', () => {
    const buffer = new BatchBuffer<number>({ batchSize: 100, flushIntervalMs: 1000 })
    const flushed: number[][] = []
    buffer.on('flush', (items: number[]) => flushed.push(items))
    buffer.start()

    vi.advanceTimersByTime(5000)
    expect(flushed).toHaveLength(0)

    buffer.stop()
  })

  // -- stop() drains remaining items --

  it('drains remaining items on stop()', () => {
    const buffer = new BatchBuffer<string>({ batchSize: 100, flushIntervalMs: 5000 })
    const flushed: string[][] = []
    buffer.on('flush', (items: string[]) => flushed.push(items))
    buffer.start()

    buffer.push('x')
    buffer.push('y')
    expect(flushed).toHaveLength(0)

    buffer.stop()
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toEqual(['x', 'y'])
  })

  it('stop() is idempotent', () => {
    const buffer = new BatchBuffer<number>({ batchSize: 10, flushIntervalMs: 1000 })
    buffer.start()
    buffer.stop()
    expect(() => buffer.stop()).not.toThrow()
  })

  // -- start() idempotency --

  it('start() is idempotent — calling twice does not double-register the timer', () => {
    const buffer = new BatchBuffer<number>({ batchSize: 100, flushIntervalMs: 1000 })
    const flushed: number[][] = []
    buffer.on('flush', (items: number[]) => flushed.push(items))
    buffer.start()
    buffer.start() // second call should be a no-op

    buffer.push(1)
    vi.advanceTimersByTime(1000)
    // Should flush exactly once, not twice
    expect(flushed).toHaveLength(1)

    buffer.stop()
  })

  // -- flush event delivers correct items --

  it('emits flush with the exact items pushed', () => {
    const buffer = new BatchBuffer<{ id: number }>({ batchSize: 2 })
    const received: Array<{ id: number }[]> = []
    buffer.on('flush', (items) => received.push(items as { id: number }[]))

    buffer.push({ id: 1 })
    buffer.push({ id: 2 })

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual([{ id: 1 }, { id: 2 }])
  })

  // -- no flush when nothing pushed --

  it('stop() without any pushes does not emit flush', () => {
    const buffer = new BatchBuffer<number>()
    let flushed = false
    buffer.on('flush', () => { flushed = true })
    buffer.start()
    buffer.stop()
    expect(flushed).toBe(false)
  })

  // -- timer fires multiple times --

  it('flushes on each timer interval', () => {
    const buffer = new BatchBuffer<number>({ batchSize: 100, flushIntervalMs: 500 })
    const flushed: number[][] = []
    buffer.on('flush', (items: number[]) => flushed.push(items))
    buffer.start()

    buffer.push(1)
    vi.advanceTimersByTime(500)
    expect(flushed).toHaveLength(1)

    buffer.push(2)
    vi.advanceTimersByTime(500)
    expect(flushed).toHaveLength(2)

    buffer.stop()
  })
})
