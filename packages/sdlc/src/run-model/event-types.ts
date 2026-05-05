/**
 * Event type definitions for dispatcher lifecycle telemetry.
 *
 * These types are the canonical shape for events emitted by the dispatcher
 * and surfaced to OTEL persistence, supervisor, and status CLI.
 *
 * Story 66-4: dispatch:spawnsync-timeout telemetry event emission.
 * obs_2026-05-04_023 fix #3.
 */

// ---------------------------------------------------------------------------
// DispatchSpawnSyncTimeoutEvent
// ---------------------------------------------------------------------------

/**
 * Emitted by the dispatcher whenever a dispatch is killed due to a timeout.
 * Fires distinctly for attempt 1 (initial) and attempt 2 (retry at 1.5× the
 * initial timeout), allowing operators to distinguish retryable timeouts from
 * terminal ones and query timeout patterns in OTEL persistence.
 *
 * Story 66-4: closes obs_2026-05-04_023 fix #3 (telemetry event making
 * timeout patterns queryable in OTEL persistence and surfaceable by the
 * supervisor and status CLI).
 *
 * Story 66-5: adds `stderrTail` and `stdoutTail` for forensic capture
 * (obs_2026-05-04_023 fix #4). Fields are optional for backward-compatibility
 * with existing callers that emit the event without tails.
 *
 * Consumed by: OTEL persistence layer, supervisor, status CLI event consumers.
 */
export interface DispatchSpawnSyncTimeoutEvent {
  type: 'dispatch:spawnsync-timeout'
  /** Story key associated with the dispatch (e.g. '10-1') */
  storyKey: string
  /** Task type (e.g. 'probe-author', 'dev-story') */
  taskType: string
  /**
   * Which attempt timed out:
   * 1 = initial attempt (default timeout)
   * 2 = retry attempt (1.5× the initial timeout)
   */
  attemptNumber: 1 | 2
  /** The configured timeout value that was exceeded (milliseconds) */
  timeoutMs: number
  /** Wall-clock time from process spawn to kill (milliseconds) */
  elapsedAtKill: number
  /** Child process PID, if available */
  pid?: number
  /** ISO 8601 timestamp at the moment the timeout was detected */
  occurredAt: string
  /**
   * Tail of subprocess stderr output captured at kill time (most recent bytes,
   * up to ~64KB). UTF-8; malformed bytes replaced with U+FFFD.
   * Story 66-5: obs_2026-05-04_023 fix #4.
   */
  stderrTail?: string
  /**
   * Tail of subprocess stdout output captured at kill time (most recent bytes,
   * up to ~64KB). UTF-8; malformed bytes replaced with U+FFFD.
   * Story 66-5: obs_2026-05-04_023 fix #4.
   */
  stdoutTail?: string
}
