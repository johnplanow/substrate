/**
 * StreamingFormatter — NDJSON event emitter for the `substrate start` and
 * `substrate status` commands.
 *
 * Writes newline-delimited JSON events to stdout as orchestration progresses (FR37).
 * Each event follows: {"event":"<name>","timestamp":"<ISO8601>","data":{...}}
 */

import type { StatusSnapshot } from '../types/status.js'

// ---------------------------------------------------------------------------
// emitEvent
// ---------------------------------------------------------------------------

/**
 * Write a single NDJSON event to stdout.
 *
 * @param event - Event name (e.g. "graph:loaded", "task:started")
 * @param data  - Event payload data
 */
export function emitEvent(event: string, data: Record<string, unknown>): void {
  const line = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    data,
  })
  process.stdout.write(line + '\n')
}

// ---------------------------------------------------------------------------
// emitStatusSnapshot
// ---------------------------------------------------------------------------

/**
 * Write a single NDJSON `status:snapshot` event to stdout.
 *
 * Event format:
 *   {"event":"status:snapshot","timestamp":"<ISO8601>","data":{<StatusSnapshot>}}
 *
 * @param snapshot - The current session status snapshot
 */
export function emitStatusSnapshot(snapshot: StatusSnapshot): void {
  emitEvent('status:snapshot', snapshot as unknown as Record<string, unknown>)
}
