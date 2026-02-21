/**
 * `substrate resume` command
 *
 * Resumes a paused orchestration session. Writes a `resume` signal to the
 * session_signals table so the running orchestrator process will re-enable
 * task dispatching.
 *
 * Usage:
 *   substrate resume <sessionId>                       Resume a paused session
 *   substrate resume <sessionId> --output-format json  JSON (NDJSON) output
 *
 * Exit codes:
 *   0 - Success (session resumed)
 *   1 - System error (unexpected exception)
 *   2 - Usage error (session not found, invalid state transition)
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync } from 'fs'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('resume-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const RESUME_EXIT_SUCCESS = 0
export const RESUME_EXIT_ERROR = 1
export const RESUME_EXIT_USAGE_ERROR = 2

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResumeActionOptions {
  sessionId: string
  outputFormat: 'human' | 'json'
  projectRoot: string
  version?: string
}

// ---------------------------------------------------------------------------
// runResumeAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the resume command.
 *
 * Returns the exit code. Separated from Commander integration for testability.
 */
export async function runResumeAction(options: ResumeActionOptions): Promise<number> {
  const { sessionId, outputFormat, projectRoot, version = '0.0.0' } = options

  const dbPath = join(projectRoot, '.substrate', 'state.db')

  if (!existsSync(dbPath)) {
    process.stderr.write(`Error: No Substrate database found at ${dbPath}. Run 'substrate init' first.\n`)
    return RESUME_EXIT_ERROR
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
      return RESUME_EXIT_USAGE_ERROR
    }

    // AC4: invalid state transition
    if (session.status !== 'paused') {
      const msg = `Session ${sessionId} is ${session.status} — can only resume a paused session.`
      if (outputFormat === 'json') {
        const line = JSON.stringify({
          event: 'session:resume',
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
      return RESUME_EXIT_USAGE_ERROR
    }

    const previousStatus = session.status

    // Atomically update session status and insert signal
    db.transaction(() => {
      db.prepare(`UPDATE sessions SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(sessionId)
      db.prepare(
        `INSERT INTO session_signals (session_id, signal) VALUES (?, 'resume')`,
      ).run(sessionId)
    })()

    // Count pending tasks
    const pendingCount = (db
      .prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE session_id = ? AND status IN ('pending', 'ready')`)
      .get(sessionId) as { cnt: number }).cnt

    const humanMsg = `Session ${sessionId} resumed. ${pendingCount} tasks pending.`

    if (outputFormat === 'json') {
      const line = JSON.stringify({
        event: 'session:resume',
        timestamp: new Date().toISOString(),
        data: {
          sessionId,
          previousStatus,
          newStatus: 'active',
          message: humanMsg,
        },
      })
      process.stdout.write(line + '\n')
    } else {
      process.stdout.write(humanMsg + '\n')
    }

    return RESUME_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runResumeAction failed')
    return RESUME_EXIT_ERROR
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
// registerResumeCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate resume` command with the CLI program.
 *
 * @param program     - Commander program instance
 * @param version     - Current Substrate package version (for JSON output)
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerResumeCommand(
  program: Command,
  version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('resume <sessionId>')
    .description('Resume a paused orchestration session')
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(async (sessionId: string, opts: { outputFormat: string }) => {
      const outputFormat: 'human' | 'json' = opts.outputFormat === 'json' ? 'json' : 'human'

      const exitCode = await runResumeAction({
        sessionId,
        outputFormat,
        projectRoot,
        version,
      })

      process.exitCode = exitCode
    })
}
