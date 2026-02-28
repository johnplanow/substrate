/**
 * NDJSON pipeline event emitter.
 *
 * Provides a fire-and-forget emitter that serializes `PipelineEvent` values
 * to NDJSON (one JSON object per line) and writes them to a given `Writable`
 * stream (typically `process.stdout`).
 *
 * Design constraints (from AC1, Dev Notes: Backpressure):
 *   - Write errors are swallowed — never crash the pipeline for a broken pipe
 *   - The pipeline does NOT await drain events (fire-and-forget)
 *   - Timestamps are generated at emit time (not from upstream data)
 */

import type { Writable } from 'node:stream'
import type { PipelineEvent } from './event-types.js'

// ---------------------------------------------------------------------------
// PipelineEventEmitter
// ---------------------------------------------------------------------------

/**
 * Thin emitter interface returned by `createEventEmitter`.
 */
export interface PipelineEventEmitter {
  /**
   * Emit a `PipelineEvent` to the bound output stream.
   *
   * The `ts` field on the event object is overwritten with the current
   * ISO-8601 timestamp at call time, regardless of any value set by the caller.
   *
   * Fire-and-forget: write errors are swallowed.
   */
  emit(event: PipelineEvent): void
}

// ---------------------------------------------------------------------------
// createEventEmitter
// ---------------------------------------------------------------------------

/**
 * Factory that creates a `PipelineEventEmitter` bound to the given stream.
 *
 * @param stream - A writable stream to which NDJSON events will be written
 *                 (e.g., `process.stdout`).
 * @returns A `PipelineEventEmitter` instance
 */
export function createEventEmitter(stream: Writable): PipelineEventEmitter {
  function emit(event: PipelineEvent): void {
    // Overwrite ts at emit time (AC7)
    const stamped = { ...event, ts: new Date().toISOString() }
    const line = JSON.stringify(stamped) + '\n'
    try {
      // Fire-and-forget: ignore backpressure signal (stream.write returns false
      // when buffer is full, but we don't block the pipeline)
      stream.write(line)
    } catch {
      // Swallow write errors — never crash the pipeline for a broken pipe
    }
  }

  return { emit }
}
