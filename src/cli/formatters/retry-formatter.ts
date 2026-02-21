/**
 * Retry formatter — structured error report rendering for `substrate retry`.
 *
 * Provides:
 *   - `fetchFailedTaskDetails` — query failed tasks from DB
 *   - `renderFailedTasksHuman` — ASCII table output (AC3)
 *   - `renderFailedTasksJson` — NDJSON per failed task (AC4)
 *   - `formatActionableError` — categorize and format error message (AC7)
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailedTaskDetail {
  taskId: string
  agent: string | null
  errorCode: number | null
  errorMessage: string | null
  failedAt: string | null
  retryCount: number
}

// ---------------------------------------------------------------------------
// fetchFailedTaskDetails
// ---------------------------------------------------------------------------

/**
 * Query all failed tasks for a session from the database.
 */
export function fetchFailedTaskDetails(
  db: BetterSqlite3Database,
  sessionId: string,
): FailedTaskDetail[] {
  const rows = db
    .prepare(
      `SELECT id, agent, exit_code, error, completed_at, retry_count
       FROM tasks
       WHERE session_id = ? AND status = 'failed'
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as Array<{
    id: string
    agent: string | null
    exit_code: number | null
    error: string | null
    completed_at: string | null
    retry_count: number
  }>

  return rows.map((row) => ({
    taskId: row.id,
    agent: row.agent,
    errorCode: row.exit_code,
    errorMessage: row.error,
    failedAt: row.completed_at,
    retryCount: row.retry_count,
  }))
}

// ---------------------------------------------------------------------------
// formatActionableError
// ---------------------------------------------------------------------------

/**
 * Categorize and format an error message into an actionable string (AC7).
 */
export function formatActionableError(detail: FailedTaskDetail): string {
  const msg = detail.errorMessage ?? ''

  // Budget-related errors
  if (msg.toLowerCase().includes('budget') || msg.toLowerCase().includes('exceeded')) {
    return `Budget exceeded: ${msg}. Increase budget cap in substrate.config.yaml.`
  }

  // Adapter unavailability errors
  if (msg.toLowerCase().includes('unavailable') || detail.errorCode === 127) {
    return `Agent ${detail.agent ?? 'unknown'} is unavailable. Run: substrate adapters --health`
  }

  // Routing failure errors
  if (msg.toLowerCase().includes('routing') || msg.toLowerCase().includes('routingdecision')) {
    return `Routing failed: ${msg}. Check routing policies in substrate.config.yaml.`
  }

  // Default: raw message + exit code
  return `Exit code ${detail.errorCode ?? 'unknown'}: ${msg || 'No error details captured'}`
}

// ---------------------------------------------------------------------------
// renderFailedTasksHuman
// ---------------------------------------------------------------------------

/**
 * Render an ASCII table of failed tasks (AC3).
 */
export function renderFailedTasksHuman(sessionId: string, tasks: FailedTaskDetail[]): string {
  if (tasks.length === 0) {
    return `No failed tasks in session ${sessionId}.`
  }

  const header = `Failed Tasks in Session ${sessionId}:`

  // Column widths
  const COL_TASK = 16
  const COL_AGENT = 12
  const COL_ERROR = 120

  const totalWidth = COL_TASK + COL_AGENT + COL_ERROR + 4 + 6 // 4 pipes + 3 inner spaces each side

  const horizontalLine = '─'.repeat(totalWidth)
  const topBorder = `┌${horizontalLine}┐`
  const midBorder = `├${horizontalLine}┤`
  const bottomBorder = `└${horizontalLine}┘`

  function padFixed(str: string, width: number): string {
    if (str.length > width) {
      return str.slice(0, width - 3) + '...'
    }
    return str.padEnd(width)
  }

  const headerRow = `│ ${padFixed('Task ID', COL_TASK)} │ ${padFixed('Agent', COL_AGENT)} │ ${padFixed('Error', COL_ERROR)} │`
  const rows = tasks.map((t) => {
    const taskId = t.taskId
    const agent = t.agent ?? '—'
    const errorMsg = formatActionableError(t)
    return `│ ${padFixed(taskId, COL_TASK)} │ ${padFixed(agent, COL_AGENT)} │ ${padFixed(errorMsg, COL_ERROR)} │`
  })

  return [header, topBorder, headerRow, midBorder, ...rows, bottomBorder].join('\n')
}

// ---------------------------------------------------------------------------
// renderFailedTasksJson
// ---------------------------------------------------------------------------

/**
 * Write NDJSON output to stdout for each failed task (AC4).
 */
export function renderFailedTasksJson(tasks: FailedTaskDetail[]): void {
  const timestamp = new Date().toISOString()
  for (const t of tasks) {
    const line = JSON.stringify({
      event: 'task:failed:detail',
      timestamp,
      data: {
        taskId: t.taskId,
        agent: t.agent,
        errorCode: t.errorCode,
        errorMessage: t.errorMessage,
        failedAt: t.failedAt,
      },
    })
    process.stdout.write(line + '\n')
  }
}
