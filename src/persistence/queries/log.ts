/**
 * Execution log query functions for the SQLite persistence layer.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Log types
// ---------------------------------------------------------------------------

export interface LogEntry {
  id?: number
  session_id: string
  task_id?: string | null
  event: string
  old_status?: string | null
  new_status?: string | null
  agent?: string | null
  cost_usd?: number | null
  data?: string | null
  timestamp?: string
}

export type CreateLogEntryInput = Omit<LogEntry, 'id' | 'timestamp'>

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Append an entry to the execution log.
 */
export function appendLog(db: BetterSqlite3Database, entry: CreateLogEntryInput): void {
  const stmt = db.prepare(`
    INSERT INTO execution_log (
      session_id, task_id, event, old_status, new_status, agent, cost_usd, data
    ) VALUES (
      @session_id, @task_id, @event, @old_status, @new_status, @agent, @cost_usd, @data
    )
  `)

  stmt.run({
    task_id: null,
    old_status: null,
    new_status: null,
    agent: null,
    cost_usd: null,
    data: null,
    ...entry,
  })
}

/**
 * Retrieve log entries for a session, optionally limited in count.
 * Results are ordered by timestamp ascending (oldest first).
 */
export function getSessionLog(
  db: BetterSqlite3Database,
  sessionId: string,
  limit?: number,
): LogEntry[] {
  if (limit !== undefined) {
    const stmt = db.prepare(
      'SELECT * FROM execution_log WHERE session_id = ? ORDER BY timestamp ASC, id ASC LIMIT ?',
    )
    return stmt.all(sessionId, limit) as LogEntry[]
  }

  const stmt = db.prepare(
    'SELECT * FROM execution_log WHERE session_id = ? ORDER BY timestamp ASC, id ASC',
  )
  return stmt.all(sessionId) as LogEntry[]
}

/**
 * Retrieve log entries for a specific task, ordered by timestamp ascending.
 */
export function getTaskLog(db: BetterSqlite3Database, taskId: string): LogEntry[] {
  const stmt = db.prepare(
    'SELECT * FROM execution_log WHERE task_id = ? ORDER BY timestamp ASC, id ASC',
  )
  return stmt.all(taskId) as LogEntry[]
}
