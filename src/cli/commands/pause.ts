/**
 * `substrate pause` command
 *
 * Pauses an active orchestration session. Writes a `pause` signal to the
 * session_signals table so the running orchestrator process will gracefully
 * stop dispatching new tasks.
 *
 * Usage:
 *   substrate pause <sessionId>                       Pause an active session
 *   substrate pause <sessionId> --output-format json  JSON (NDJSON) output
 *
 * Exit codes:
 *   0 - Success (session paused)
 *   1 - System error (unexpected exception)
 *   2 - Usage error (session not found, invalid state transition)
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync } from 'fs'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('pause-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const PAUSE_EXIT_SUCCESS = 0
export const PAUSE_EXIT_ERROR = 1
export const PAUSE_EXIT_USAGE_ERROR = 2

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PauseActionOptions {
  sessionId: string
  outputFormat: 'human' | 'json'
  projectRoot: string
  version?: string
}

// ---------------------------------------------------------------------------
// runPauseAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the pause command.
 *
 * Returns the exit code. Separated from Commander integration for testability.
 */
export async function runPauseAction(options: PauseActionOptions): Promise<number> {
  const { sessionId, outputFormat, projectRoot, version = '0.0.0' } = options

  const dbPath = join(projectRoot, '.substrate', 'state.db')

  if (!existsSync(dbPath)) {
    process.stderr.write(`Error: No Substrate database found at ${dbPath}. Run 'substrate init' first.\n`)
    return PAUSE_EXIT_ERROR
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
      return PAUSE_EXIT_USAGE_ERROR
    }

    // AC2: already paused or terminal state
    if (session.status !== 'active') {
      const msg = `Session ${sessionId} is already ${session.status} — cannot pause.`
      if (outputFormat === 'json') {
        const line = JSON.stringify({
          event: 'session:pause',
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
      return PAUSE_EXIT_USAGE_ERROR
    }

    // Atomically update session status and insert signal
    const previousStatus = session.status
    db.transaction(() => {
      db.prepare(`UPDATE sessions SET status = 'paused', updated_at = datetime('now') WHERE id = ?`).run(sessionId)
      db.prepare(
        `INSERT INTO session_signals (session_id, signal) VALUES (?, 'pause')`,
      ).run(sessionId)
    })()

    // Count completed and pending tasks
    const completedCount = (db
      .prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE session_id = ? AND status = 'completed'`)
      .get(sessionId) as { cnt: number }).cnt
    const pendingCount = (db
      .prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE session_id = ? AND status IN ('pending', 'ready')`)
      .get(sessionId) as { cnt: number }).cnt

    const humanMsg = `Session ${sessionId} paused. ${completedCount} tasks completed, ${pendingCount} tasks still pending.`

    if (outputFormat === 'json') {
      const line = JSON.stringify({
        event: 'session:pause',
        timestamp: new Date().toISOString(),
        data: {
          sessionId,
          previousStatus,
          newStatus: 'paused',
          message: humanMsg,
        },
      })
      process.stdout.write(line + '\n')
    } else {
      process.stdout.write(humanMsg + '\n')
    }

    return PAUSE_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runPauseAction failed')
    return PAUSE_EXIT_ERROR
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
// registerPauseCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate pause` command with the CLI program.
 *
 * @param program     - Commander program instance
 * @param version     - Current Substrate package version (for JSON output)
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerPauseCommand(
  program: Command,
  version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('pause <sessionId>')
    .description('Pause an active orchestration session')
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(async (sessionId: string, opts: { outputFormat: string }) => {
      const outputFormat: 'human' | 'json' = opts.outputFormat === 'json' ? 'json' : 'human'

      const exitCode = await runPauseAction({
        sessionId,
        outputFormat,
        projectRoot,
        version,
      })

      process.exitCode = exitCode
    })
}
