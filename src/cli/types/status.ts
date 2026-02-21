/**
 * Types for the `substrate status` command.
 */

// ---------------------------------------------------------------------------
// SessionStatus
// ---------------------------------------------------------------------------

export type SessionStatus = 'active' | 'paused' | 'cancelled' | 'complete'

// ---------------------------------------------------------------------------
// StatusSnapshot
// ---------------------------------------------------------------------------

/**
 * Complete status snapshot for a session — returned by fetchStatusSnapshot()
 * and serialised in NDJSON output.
 */
export interface StatusSnapshot {
  sessionId: string
  status: SessionStatus
  startedAt: string
  elapsedMs: number
  taskCounts: {
    total: number
    pending: number
    running: number
    completed: number
    failed: number
  }
  runningTasks: Array<{
    taskId: string
    agent: string
    startedAt: string
    elapsedMs: number
  }>
  totalCostUsd: number
}

// ---------------------------------------------------------------------------
// TaskNode (for --show-graph)
// ---------------------------------------------------------------------------

/**
 * Minimal task node for graph rendering.
 */
export interface TaskNode {
  id: string
  name: string
  status: string
  dependencies: string[]
}
