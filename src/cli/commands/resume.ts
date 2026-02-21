/**
 * `substrate resume` command
 *
 * Handles two resume modes:
 *
 * 1. Crash-recovery mode (AC7 — no sessionId provided):
 *    Auto-detects the most-recent session with status = 'interrupted' via
 *    CrashRecoveryManager.findInterruptedSession(), re-queues stuck tasks via
 *    CrashRecoveryManager.recover(), and starts execution via
 *    taskGraphEngine.startExecution().
 *
 *    Usage:
 *      substrate resume                             Auto-detect and resume interrupted session
 *      substrate resume --max-concurrency 2         Override concurrency
 *      substrate resume --output-format json        JSON (NDJSON) output
 *
 * 2. Paused-session mode (legacy — sessionId provided programmatically):
 *    Resumes a paused orchestration session by writing a 'resume' signal to
 *    the session_signals table so the running orchestrator process will
 *    re-enable task dispatching.
 *
 * Exit codes:
 *   0   - Success
 *   1   - System error (unexpected exception)
 *   2   - Usage error (session not found, invalid state transition)
 *   3   - Budget exceeded (crash-recovery mode only)
 *   4   - All tasks failed (crash-recovery mode only)
 *   130 - User interrupted (crash-recovery mode only)
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync } from 'fs'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { createLogger } from '../../utils/logger.js'
import { runStartAction } from './start.js'
import type { StartActionOptions } from './start.js'

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
  /**
   * Session ID to resume (paused-session mode).
   * When omitted, crash-recovery mode is used (auto-detect interrupted session).
   */
  sessionId?: string
  outputFormat: 'human' | 'json'
  projectRoot: string
  version?: string
  /** Max concurrency override (crash-recovery mode only) */
  maxConcurrency?: number
  /** When true, config hot-reload watcher is disabled (crash-recovery mode only) */
  noWatchConfig?: boolean
}

// ---------------------------------------------------------------------------
// runResumeAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the resume command.
 *
 * When sessionId is provided: resumes a paused session (writes a 'resume' signal).
 * When sessionId is omitted: delegates to runStartAction with resumeMode=true,
 *   which auto-detects the most-recent interrupted (crash-recovered) session.
 *
 * Returns the exit code.
 */
export async function runResumeAction(options: ResumeActionOptions): Promise<number> {
  const {
    sessionId,
    outputFormat,
    projectRoot,
    version = '0.0.0',
    maxConcurrency,
    noWatchConfig = false,
  } = options

  // ---------------------------------------------------------------------------
  // Crash-recovery mode: no sessionId provided — delegate to runStartAction
  // ---------------------------------------------------------------------------

  if (sessionId === undefined) {
    const startOptions: StartActionOptions = {
      graphFile: undefined,
      dryRun: false,
      maxConcurrency,
      outputFormat,
      projectRoot,
      version,
      noWatchConfig,
      resumeMode: true,
    }
    return runStartAction(startOptions)
  }

  // ---------------------------------------------------------------------------
  // Paused-session mode: sessionId provided — resume a paused session
  // ---------------------------------------------------------------------------

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
 * The CLI command operates in crash-recovery mode (no sessionId argument).
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
    .command('resume')
    .description('Resume the most-recent interrupted (crash-recovered) orchestration session')
    .option('--max-concurrency <n>', 'Maximum number of concurrent tasks', parseInt)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json (NDJSON streaming)',
      'human',
    )
    .option('--no-watch-config', 'Disable config file watching during orchestration')
    .action(async (opts: { maxConcurrency?: number; outputFormat: string; watchConfig: boolean }) => {
      const outputFormat: 'human' | 'json' = opts.outputFormat === 'json' ? 'json' : 'human'

      // CLI always uses crash-recovery mode (no sessionId)
      const exitCode = await runResumeAction({
        outputFormat,
        projectRoot,
        maxConcurrency: opts.maxConcurrency,
        version,
        noWatchConfig: !opts.watchConfig,
      })

      process.exitCode = exitCode
    })
}
