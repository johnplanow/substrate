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

/**
 * Retrieve log entries for a session filtered by event type.
 * Uses the idx_log_event index for efficient lookup.
 */
export function getLogByEvent(
  db: BetterSqlite3Database,
  sessionId: string,
  event: string,
  limit?: number,
): LogEntry[] {
  if (limit !== undefined) {
    const stmt = db.prepare(
      'SELECT * FROM execution_log WHERE session_id = ? AND event = ? ORDER BY timestamp ASC, id ASC LIMIT ?',
    )
    return stmt.all(sessionId, event, limit) as LogEntry[]
  }
  const stmt = db.prepare(
    'SELECT * FROM execution_log WHERE session_id = ? AND event = ? ORDER BY timestamp ASC, id ASC',
  )
  return stmt.all(sessionId, event) as LogEntry[]
}

/**
 * Retrieve log entries for a session within a time range.
 * Uses the idx_log_timestamp index for efficient lookup.
 * @param from - ISO 8601 timestamp string (inclusive lower bound)
 * @param to   - ISO 8601 timestamp string (inclusive upper bound)
 */
// ---------------------------------------------------------------------------
// Combined filter query
// ---------------------------------------------------------------------------

/**
 * Options for the combined log filter query.
 */
export interface LogQueryOptions {
  sessionId: string
  taskId?: string
  event?: string
  limit?: number
  order?: 'asc' | 'desc'
}

/**
 * Query execution_log with a combination of filters.
 *
 * Builds SQL dynamically based on the provided options.
 * Supports filtering by taskId and/or event type within a session.
 *
 * @param db      - SQLite database connection
 * @param options - Filter options
 */
export function queryLogFiltered(
  db: BetterSqlite3Database,
  options: LogQueryOptions,
): LogEntry[] {
  const { sessionId, taskId, event, limit, order = 'asc' } = options

  const conditions: string[] = ['session_id = ?']
  const params: unknown[] = [sessionId]

  if (taskId !== undefined) {
    conditions.push('task_id = ?')
    params.push(taskId)
  }

  if (event !== undefined) {
    conditions.push('event = ?')
    params.push(event)
  }

  const orderClause =
    order === 'desc'
      ? 'ORDER BY timestamp DESC, id DESC'
      : 'ORDER BY timestamp ASC, id ASC'

  let sql = `SELECT * FROM execution_log WHERE ${conditions.join(' AND ')} ${orderClause}`

  if (limit !== undefined) {
    sql += ' LIMIT ?'
    params.push(limit)
  }

  const stmt = db.prepare(sql)
  return stmt.all(...params) as LogEntry[]
}

export function getLogByTimeRange(
  db: BetterSqlite3Database,
  sessionId: string,
  from: string,
  to: string,
  limit?: number,
): LogEntry[] {
  if (limit !== undefined) {
    const stmt = db.prepare(
      'SELECT * FROM execution_log WHERE session_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC, id ASC LIMIT ?',
    )
    return stmt.all(sessionId, from, to, limit) as LogEntry[]
  }
  const stmt = db.prepare(
    'SELECT * FROM execution_log WHERE session_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC, id ASC',
  )
  return stmt.all(sessionId, from, to) as LogEntry[]
}
