/**
 * BatchBuffer — generic buffering utility with size-triggered and timer-triggered flush.
 *
 * Emits a 'flush' event with the accumulated items whenever either:
 *   - The buffer reaches `batchSize` items, or
 *   - The `flushIntervalMs` timer fires
 *
 * Callers subscribe to the 'flush' event via `.on('flush', handler)`.
 * Call `start()` to begin the interval timer and `stop()` to drain and clean up.
 * Call `flush()` to force-flush immediately without stopping the interval timer.
 *
 * Design invariants:
 *   - Never throws; errors from flush handlers are the caller's responsibility
 *   - Items pushed after stop() are still emitted in the final drain flush
 *   - EventEmitter pattern — no internal queue management beyond the items array
 */

import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// BatchBufferOptions
// ---------------------------------------------------------------------------

export interface BatchBufferOptions {
  /** Number of items that trigger a size-based flush. Default: 100. */
  batchSize?: number
  /** Interval in milliseconds between time-based flushes. Default: 5000. */
  flushIntervalMs?: number
}

// ---------------------------------------------------------------------------
// BatchBuffer
// ---------------------------------------------------------------------------

export class BatchBuffer<T> extends EventEmitter {
  private _items: T[] = []
  private _timer: ReturnType<typeof setInterval> | null = null
  private readonly _batchSize: number
  private readonly _flushIntervalMs: number

  constructor(options: BatchBufferOptions = {}) {
    super()
    this._batchSize = options.batchSize ?? 100
    this._flushIntervalMs = options.flushIntervalMs ?? 5000
  }

  /**
   * Add an item to the buffer.
   * Triggers a flush immediately when the buffer reaches `batchSize`.
   */
  push(item: T): void {
    this._items.push(item)
    if (this._items.length >= this._batchSize) {
      this._flush()
    }
  }

  /**
   * Start the interval timer that flushes items on a schedule.
   * Safe to call multiple times — subsequent calls are ignored.
   */
  start(): void {
    if (this._timer !== null) return
    this._timer = setInterval(() => this._flush(), this._flushIntervalMs)
    // Allow the Node.js event loop to exit even if this timer is active.
    if (typeof this._timer.unref === 'function') {
      this._timer.unref()
    }
  }

  /**
   * Trigger an immediate flush of buffered items without stopping the interval timer.
   * Use this to force-flush between pipeline phases while keeping the timer active.
   * No-op when the buffer is empty.
   */
  flush(): void {
    this._flush()
  }

  /**
   * Stop the interval timer and flush any remaining items.
   * Safe to call multiple times — subsequent calls are ignored.
   */
  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer)
      this._timer = null
    }
    this._flush()
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _flush(): void {
    if (this._items.length === 0) return
    const items = this._items.splice(0)
    this.emit('flush', items)
  }
}
