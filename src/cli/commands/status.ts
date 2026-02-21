/**
 * `substrate status` command
 *
 * Displays the real-time state of an active or recently completed orchestration session.
 *
 * Usage:
 *   substrate status                          Show most recent session (AC2)
 *   substrate status <sessionId>             Show specific session (AC1)
 *   substrate status <sessionId> --watch     Poll and stream NDJSON (AC3)
 *   substrate status <sessionId> --output-format json  Single NDJSON snapshot (AC4)
 *   substrate status <sessionId> --show-graph          ASCII dependency graph (AC8)
 *
 * Exit codes:
 *   0 - Success (snapshot displayed or watch loop completed)
 *   1 - System error (unexpected exception)
 *   2 - Usage error (session not found, invalid args)
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync } from 'fs'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { getSession, getLatestSessionId } from '../../persistence/queries/sessions.js'
import { getAllTasks } from '../../persistence/queries/tasks.js'
import { emitStatusSnapshot } from '../formatters/streaming.js'
import { renderStatusHuman, renderTaskGraph } from '../formatters/status-formatter.js'
import type { StatusSnapshot, SessionStatus, TaskNode } from '../types/status.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('status-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const STATUS_EXIT_SUCCESS = 0
export const STATUS_EXIT_ERROR = 1
export const STATUS_EXIT_NOT_FOUND = 2

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the status action.
 */
export interface StatusActionOptions {
  sessionId?: string
  watch: boolean
  outputFormat: 'human' | 'json'
  showGraph: boolean
  pollIntervalMs: number
  projectRoot: string
}

// ---------------------------------------------------------------------------
// fetchStatusSnapshot
// ---------------------------------------------------------------------------

/**
 * Query the database for a complete status snapshot of a session.
 *
 * Uses read-only prepared statements — no writes (AC7 / NFR2).
 * Returns null if the session does not exist.
 */
export function fetchStatusSnapshot(
  wrapper: DatabaseWrapper,
  sessionId: string,
): StatusSnapshot | null {
  const db = wrapper.db

  const session = getSession(db, sessionId)
  if (!session) {
    return null
  }

  const now = Date.now()
  const startedAt = session.created_at
  // SQLite datetime('now') returns UTC in "YYYY-MM-DD HH:MM:SS" format (no timezone
  // indicator). Node.js parses this as local time unless we normalise to ISO-8601 UTC.
  const normalisedStartedAt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(startedAt)
    ? startedAt.replace(' ', 'T') + 'Z'
    : startedAt
  const startMs = new Date(normalisedStartedAt).getTime()
  const elapsedMs = isNaN(startMs) ? 0 : now - startMs

  // Map session status to the union type
  const statusMap: Record<string, SessionStatus> = {
    active: 'active',
    paused: 'paused',
    cancelled: 'cancelled',
    complete: 'complete',
    completed: 'complete',
  }
  const status: SessionStatus = statusMap[session.status] ?? 'active'

  // Query all tasks for this session (read-only)
  const allTasks = getAllTasks(db, sessionId)

  const taskCounts = {
    total: allTasks.length,
    pending: allTasks.filter((t) => t.status === 'pending').length,
    running: allTasks.filter((t) => t.status === 'running').length,
    completed: allTasks.filter((t) => t.status === 'completed').length,
    failed: allTasks.filter((t) => t.status === 'failed').length,
  }

  const runningTasks = allTasks
    .filter((t) => t.status === 'running')
    .map((t) => {
      const taskStartMs = t.started_at ? new Date(t.started_at).getTime() : startMs
      const taskElapsedMs = isNaN(taskStartMs) ? 0 : now - taskStartMs
      return {
        taskId: t.id,
        agent: t.agent ?? 'unknown',
        startedAt: t.started_at ?? startedAt,
        elapsedMs: taskElapsedMs,
      }
    })

  const totalCostUsd = session.total_cost_usd ?? 0

  return {
    sessionId,
    status,
    startedAt,
    elapsedMs,
    taskCounts,
    runningTasks,
    totalCostUsd,
  }
}

// ---------------------------------------------------------------------------
// isTerminalStatus
// ---------------------------------------------------------------------------

function isTerminalStatus(status: SessionStatus): boolean {
  return status === 'complete' || status === 'cancelled'
}

// ---------------------------------------------------------------------------
// runStatusAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the status command.
 *
 * Returns exit code. Separated from Commander integration for testability.
 */
export async function runStatusAction(options: StatusActionOptions): Promise<number> {
  const {
    sessionId: explicitSessionId,
    watch,
    outputFormat,
    showGraph,
    pollIntervalMs,
    projectRoot,
  } = options

  const dbPath = join(projectRoot, '.substrate', 'state.db')

  if (!existsSync(dbPath)) {
    process.stderr.write(
      `Error: No Substrate database found at ${dbPath}. Run 'substrate init' first.\n`,
    )
    return STATUS_EXIT_ERROR
  }

  let wrapper: DatabaseWrapper | null = null

  try {
    wrapper = new DatabaseWrapper(dbPath)
    wrapper.open()
    const db = wrapper.db

    // Run migrations to ensure schema is up-to-date
    runMigrations(db)

    // Resolve session ID
    let resolvedSessionId: string | null = explicitSessionId ?? null
    if (!resolvedSessionId) {
      resolvedSessionId = getLatestSessionId(db)
      if (!resolvedSessionId) {
        process.stdout.write('No sessions found.\n')
        return STATUS_EXIT_SUCCESS
      }
    }

    // Verify session exists (AC6)
    const sessionExists = getSession(db, resolvedSessionId)
    if (!sessionExists) {
      process.stderr.write(`Error: Session not found: ${resolvedSessionId}\n`)
      return STATUS_EXIT_NOT_FOUND
    }

    // --watch mode: polling loop (AC3)
    if (watch) {
      return await new Promise<number>((resolve) => {
        // eslint-disable-next-line prefer-const
        let interval: ReturnType<typeof setInterval>

        const poll = () => {
          try {
            const snapshot = fetchStatusSnapshot(wrapper!, resolvedSessionId!)
            if (!snapshot) {
              process.stderr.write(`Error: Session not found: ${resolvedSessionId}\n`)
              clearInterval(interval)
              resolve(STATUS_EXIT_NOT_FOUND)
              return
            }

            emitStatusSnapshot(snapshot)

            if (isTerminalStatus(snapshot.status)) {
              clearInterval(interval)
              resolve(STATUS_EXIT_SUCCESS)
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            process.stderr.write(`Error: ${message}\n`)
            clearInterval(interval)
            resolve(STATUS_EXIT_ERROR)
          }
        }

        // Register SIGINT handler (AC3)
        const sigintHandler = () => {
          clearInterval(interval)
          resolve(STATUS_EXIT_SUCCESS)
        }
        process.once('SIGINT', sigintHandler)

        // Start polling loop
        poll()
        interval = setInterval(poll, pollIntervalMs)
      })
    }

    // Single snapshot
    const snapshot = fetchStatusSnapshot(wrapper, resolvedSessionId)
    if (!snapshot) {
      process.stderr.write(`Error: Session not found: ${resolvedSessionId}\n`)
      return STATUS_EXIT_NOT_FOUND
    }

    // --output-format json: emit single NDJSON line (AC4)
    if (outputFormat === 'json') {
      emitStatusSnapshot(snapshot)
      return STATUS_EXIT_SUCCESS
    }

    // Human-readable output (AC5)
    process.stdout.write(renderStatusHuman(snapshot) + '\n')

    // --show-graph: render ASCII task dependency graph (AC8)
    if (showGraph) {
      const allTasks = getAllTasks(db, resolvedSessionId)
      const taskNodes: TaskNode[] = allTasks.map((t) => {
        // Dependencies stored in task_dependencies table; we include a minimal
        // TaskNode here — full dependency resolution requires a separate query.
        return {
          id: t.id,
          name: t.name,
          status: t.status,
          dependencies: [],
        }
      })

      // Load dependency relationships
      const depsStmt = db.prepare(
        'SELECT task_id, depends_on FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE session_id = ?)',
      )
      type DepRow = { task_id: string; depends_on: string }
      const depRows = depsStmt.all(resolvedSessionId) as DepRow[]
      for (const row of depRows) {
        const node = taskNodes.find((n) => n.id === row.task_id)
        if (node) {
          node.dependencies.push(row.depends_on)
        }
      }

      process.stdout.write('\n' + renderTaskGraph(snapshot, taskNodes) + '\n')
    }

    return STATUS_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runStatusAction failed')
    return STATUS_EXIT_ERROR
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
// registerStatusCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate status` command with the CLI program.
 *
 * @param program     - Commander program instance
 * @param version     - Current Substrate package version (unused, reserved for future use)
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerStatusCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('status [sessionId]')
    .description('Show the current status of an orchestration session')
    .option('--watch', 'Poll and stream NDJSON status updates', false)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json (NDJSON)',
      'human',
    )
    .option('--show-graph', 'Display ASCII task dependency graph', false)
    .option(
      '--poll-interval <ms>',
      'Polling interval for --watch mode in milliseconds',
      '2000',
    )
    .action(async (sessionId: string | undefined, opts: {
      watch: boolean
      outputFormat: string
      showGraph: boolean
      pollInterval: string
    }) => {
      const outputFormat: 'human' | 'json' = opts.outputFormat === 'json' ? 'json' : 'human'
      const pollIntervalMs = parseInt(opts.pollInterval, 10) || 2000

      const exitCode = await runStatusAction({
        ...(sessionId !== undefined && { sessionId }),
        watch: opts.watch,
        outputFormat,
        showGraph: opts.showGraph,
        pollIntervalMs,
        projectRoot,
      })

      process.exitCode = exitCode
    })
}
