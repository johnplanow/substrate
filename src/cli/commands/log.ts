/**
 * `substrate log` command
 *
 * Queries the execution log for a session, optionally filtered by task ID or event type.
 *
 * Usage:
 *   substrate log                          Default: last 50 entries from latest session (newest first)
 *   substrate log --task <id>             Filter by task ID (chronological order)
 *   substrate log --event <type>          Filter by event type (chronological order)
 *   substrate log --session <id>          Query a specific session instead of the latest
 *   substrate log --limit <n>             Limit number of returned entries (default: 50)
 *   substrate log --output-format json    JSON output
 *   substrate log --json                  JSON shorthand
 *
 * Exit codes:
 *   0 - Success (including empty result)
 *   1 - Error (database not found, query error, invalid option)
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync } from 'fs'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import {
  getSessionLog,
  getTaskLog,
  getLogByEvent,
  queryLogFiltered,
} from '../../persistence/queries/log.js'
import type { LogEntry } from '../../persistence/queries/log.js'
import { getLatestSessionId } from '../../persistence/queries/sessions.js'
import { formatTable, buildJsonOutput } from '../utils/formatting.js'
import type { CLIJsonOutput } from '../utils/formatting.js'

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const LOG_EXIT_SUCCESS = 0
export const LOG_EXIT_ERROR = 1

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { LogEntry }

export type LogJsonData = LogEntry[]

/**
 * Options for the log action.
 */
export interface LogActionOptions {
  sessionId?: string
  taskId?: string
  event?: string
  limit: number
  outputFormat: 'table' | 'json'
  projectRoot: string
  version?: string
}

// ---------------------------------------------------------------------------
// Table formatter
// ---------------------------------------------------------------------------

/**
 * Format execution log entries as a human-readable table.
 *
 * Columns: Timestamp, Event, Task ID, Old Status, New Status, Agent, Cost ($)
 * Null/undefined fields are displayed as '-'.
 * cost_usd is formatted as '0.0000' when present.
 */
export function formatLogTable(entries: LogEntry[]): string {
  const headers = ['Timestamp', 'Event', 'Task ID', 'Old Status', 'New Status', 'Agent', 'Cost ($)']
  const keys = ['timestamp', 'event', 'task_id', 'old_status', 'new_status', 'agent', 'cost_usd']

  const rows: Record<string, string>[] = entries.map((entry) => ({
    timestamp: entry.timestamp ?? '-',
    event: entry.event,
    task_id: entry.task_id ?? '-',
    old_status: entry.old_status ?? '-',
    new_status: entry.new_status ?? '-',
    agent: entry.agent ?? '-',
    cost_usd:
      entry.cost_usd !== null && entry.cost_usd !== undefined
        ? entry.cost_usd.toFixed(4)
        : '-',
  }))

  return formatTable(headers, rows, keys)
}

// ---------------------------------------------------------------------------
// runLogAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the log command.
 *
 * Returns exit code. Separated from Commander integration for testability.
 */
export async function runLogAction(options: LogActionOptions): Promise<number> {
  const {
    sessionId: explicitSessionId,
    taskId,
    event,
    limit,
    outputFormat,
    projectRoot,
    version = '0.0.0',
  } = options

  const dbPath = join(projectRoot, '.substrate', 'state.db')

  // Check if database exists
  if (!existsSync(dbPath)) {
    process.stderr.write(
      `Error: No Substrate database found at ${dbPath}. Run 'substrate init' first.\n`,
    )
    return LOG_EXIT_ERROR
  }

  // Validate output format
  const validFormats = ['table', 'json']
  if (!validFormats.includes(outputFormat)) {
    process.stderr.write(
      `Error: Invalid output format '${outputFormat}'. Valid formats: ${validFormats.join(', ')}\n`,
    )
    return LOG_EXIT_ERROR
  }

  let wrapper: DatabaseWrapper | null = null

  try {
    // Open database
    wrapper = new DatabaseWrapper(dbPath)
    wrapper.open()
    const db = wrapper.db

    if (!db) {
      process.stderr.write('Database connection failed\n')
      return LOG_EXIT_ERROR
    }

    // Run migrations to ensure schema is up-to-date
    runMigrations(db)

    // Resolve session ID
    let sessionId: string | null = explicitSessionId ?? null
    if (!sessionId) {
      sessionId = getLatestSessionId(db)
    }

    // Determine entries based on filter combination
    let entries: LogEntry[]

    if (!sessionId) {
      // No session exists — empty state
      entries = []
    } else if (taskId && event) {
      // Combined filter: use queryLogFiltered
      entries = queryLogFiltered(db, { sessionId, taskId, event, limit, order: 'asc' })
    } else if (taskId) {
      // Task filter: getTaskLog (ASC), then apply limit
      entries = getTaskLog(db, taskId).slice(0, limit)
    } else if (event) {
      // Event filter: getLogByEvent with limit
      entries = getLogByEvent(db, sessionId, event, limit)
    } else {
      // Default: getSessionLog (ASC), reverse for DESC, apply limit
      entries = getSessionLog(db, sessionId).reverse().slice(0, limit)
    }

    // Handle empty result
    if (entries.length === 0) {
      if (outputFormat === 'json') {
        const output: CLIJsonOutput<LogJsonData> = buildJsonOutput('substrate log', [], version)
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
      } else {
        process.stdout.write('No log entries found\n')
      }
      return LOG_EXIT_SUCCESS
    }

    // Output
    if (outputFormat === 'json') {
      const output: CLIJsonOutput<LogJsonData> = buildJsonOutput('substrate log', entries, version)
      process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    } else {
      process.stdout.write(formatLogTable(entries) + '\n')
    }

    return LOG_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    return LOG_EXIT_ERROR
  } finally {
    if (wrapper !== null) {
      try {
        wrapper.close()
      } catch {
        // Ignore close errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// registerLogCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate log` command with the CLI program.
 *
 * @param program     - Commander program instance
 * @param version     - Current Substrate package version (for JSON output)
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerLogCommand(
  program: Command,
  version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('log')
    .description('Query the execution log for a session')
    .option('--session <id>', 'Session ID to query (defaults to latest)')
    .option('--task <id>', 'Filter by task ID')
    .option('--event <type>', 'Filter by event type (e.g., task:status_change, orchestrator:state_change)')
    .option('--limit <n>', 'Maximum number of entries to return', '50')
    .option(
      '--output-format <format>',
      'Output format: table (default) or json',
      'table',
    )
    .option('--json', 'Output JSON (shorthand for --output-format json)', false)
    .action(async (opts: {
      session?: string
      task?: string
      event?: string
      limit: string
      outputFormat: string
      json: boolean
    }) => {
      // Resolve output format: --json flag overrides --output-format
      const outputFormat = opts.json
        ? 'json'
        : (opts.outputFormat as 'table' | 'json')

      const exitCode = await runLogAction({
        ...(opts.session !== undefined && { sessionId: opts.session }),
        ...(opts.task !== undefined && { taskId: opts.task }),
        ...(opts.event !== undefined && { event: opts.event }),
        limit: parseInt(opts.limit, 10),
        outputFormat,
        projectRoot,
        version,
      })

      process.exitCode = exitCode
    })
}
