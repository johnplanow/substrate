/**
 * `substrate cancel` command
 *
 * Cancels an active or paused orchestration session. Writes a `cancel` signal
 * to the session_signals table, marks all pending/running tasks as cancelled,
 * and updates the session status to `cancelled`.
 *
 * Usage:
 *   substrate cancel <sessionId>                       Cancel a session (prompts if TTY)
 *   substrate cancel <sessionId> --yes                 Skip confirmation prompt
 *   substrate cancel <sessionId> --output-format json  JSON (NDJSON) output
 *
 * Exit codes:
 *   0 - Success (session cancelled, or aborted by user)
 *   1 - System error (unexpected exception)
 *   2 - Usage error (session not found, invalid state transition)
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync } from 'fs'
import * as readline from 'readline'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('cancel-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const CANCEL_EXIT_SUCCESS = 0
export const CANCEL_EXIT_ERROR = 1
export const CANCEL_EXIT_USAGE_ERROR = 2

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CancelActionOptions {
  sessionId: string
  outputFormat: 'human' | 'json'
  yes: boolean
  projectRoot: string
  version?: string
  /** Override for testing — allows injecting a custom TTY check */
  isTTY?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Prompt the user for confirmation via readline.
 * Returns true if the user confirms (y/yes), false otherwise.
 */
async function promptConfirmation(sessionId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    rl.question(
      `Cancel session ${sessionId}? This will terminate all running workers. [y/N] `,
      (answer) => {
        rl.close()
        const normalised = answer.trim().toLowerCase()
        resolve(normalised === 'y' || normalised === 'yes')
      },
    )
  })
}

// ---------------------------------------------------------------------------
// runCancelAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the cancel command.
 *
 * Returns the exit code. Separated from Commander integration for testability.
 */
export async function runCancelAction(options: CancelActionOptions): Promise<number> {
  const { sessionId, outputFormat, yes, projectRoot, version = '0.0.0' } = options

  const dbPath = join(projectRoot, '.substrate', 'state.db')

  if (!existsSync(dbPath)) {
    process.stderr.write(`Error: No Substrate database found at ${dbPath}. Run 'substrate init' first.\n`)
    return CANCEL_EXIT_ERROR
  }

  let wrapper: DatabaseWrapper | null = null

  try {
    wrapper = new DatabaseWrapper(dbPath)
    wrapper.open()
    const db = wrapper.db

    runMigrations(db)

    // Query session by ID
    const session = db
      .prepare('SELECT id, status FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; status: string } | undefined

    if (!session) {
      process.stderr.write(`Error: Session not found: ${sessionId}\n`)
      return CANCEL_EXIT_USAGE_ERROR
    }

    // AC6: already cancelled or complete
    if (session.status === 'cancelled' || session.status === 'complete') {
      const msg = `Session ${sessionId} is already ${session.status} — cannot cancel.`
      if (outputFormat === 'json') {
        const line = JSON.stringify({
          event: 'session:cancel',
          timestamp: new Date().toISOString(),
          data: {
            sessionId,
            previousStatus: session.status,
            newStatus: session.status,
            message: msg,
          },
        })
        process.stdout.write(line + '\n')
      } else {
        process.stdout.write(msg + '\n')
      }
      return CANCEL_EXIT_USAGE_ERROR
    }

    // AC9: confirmation prompt for interactive TTY
    const isInteractive = options.isTTY !== undefined ? options.isTTY : process.stdin.isTTY === true
    if (isInteractive && !yes) {
      const confirmed = await promptConfirmation(sessionId)
      if (!confirmed) {
        process.stdout.write('Cancelled by user.\n')
        return CANCEL_EXIT_SUCCESS
      }
    }

    const previousStatus = session.status

    // Atomically update session status, cancel pending/running tasks, and insert signal
    const cancelledTasksResult = db.transaction(() => {
      // Count tasks that will be cancelled
      const countResult = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM tasks WHERE session_id = ? AND status IN ('pending', 'running', 'ready')`,
        )
        .get(sessionId) as { cnt: number }

      // Cancel pending/running tasks
      db.prepare(
        `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
         WHERE session_id = ? AND status IN ('pending', 'running', 'ready')`,
      ).run(sessionId)

      // Update session status
      db.prepare(
        `UPDATE sessions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
      ).run(sessionId)

      // Insert cancel signal so the running orchestrator sends SIGTERM to workers
      db.prepare(
        `INSERT INTO session_signals (session_id, signal) VALUES (?, 'cancel')`,
      ).run(sessionId)

      return countResult.cnt
    })()

    const cancelledCount = cancelledTasksResult as number
    const humanMsg = `Session ${sessionId} cancelled. ${cancelledCount} tasks were cancelled.`

    if (outputFormat === 'json') {
      const line = JSON.stringify({
        event: 'session:cancel',
        timestamp: new Date().toISOString(),
        data: {
          sessionId,
          previousStatus,
          newStatus: 'cancelled',
          message: humanMsg,
        },
      })
      process.stdout.write(line + '\n')
    } else {
      process.stdout.write(humanMsg + '\n')
    }

    return CANCEL_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runCancelAction failed')
    return CANCEL_EXIT_ERROR
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
// registerCancelCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate cancel` command with the CLI program.
 *
 * @param program     - Commander program instance
 * @param version     - Current Substrate package version (for JSON output)
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerCancelCommand(
  program: Command,
  version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('cancel <sessionId>')
    .description('Cancel an active or paused orchestration session')
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .option('--yes', 'Skip confirmation prompt', false)
    .action(async (sessionId: string, opts: { outputFormat: string; yes: boolean }) => {
      const outputFormat: 'human' | 'json' = opts.outputFormat === 'json' ? 'json' : 'human'

      const exitCode = await runCancelAction({
        sessionId,
        outputFormat,
        yes: opts.yes,
        projectRoot,
        version,
      })

      process.exitCode = exitCode
    })
}
