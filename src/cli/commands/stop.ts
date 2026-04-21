/**
 * `substrate stop` command — Story 58-7, AC3
 *
 * Sends SIGTERM to the running orchestrator process and waits for the
 * graceful shutdown handler (installed by Story 58-7) to complete.
 *
 * Unlike `substrate cancel`, this command does NOT kill child processes,
 * does NOT force SIGKILL, and does NOT update Dolt itself — it relies on
 * the orchestrator's graceful shutdown handler to flush state cleanly.
 *
 * Usage:
 *   substrate stop                   Stop the currently running pipeline
 *   substrate stop --run-id <id>     (reserved — run-id not yet wired to PID; uses PID file)
 *   substrate stop --output-format json
 *
 * Exit codes:
 *   0 - Orchestrator exited cleanly within the timeout
 *   1 - Error (not found, permission denied, etc.)
 *   2 - Timeout: orchestrator did not exit within 30s
 */

import type { Command } from 'commander'
import { join } from 'path'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createLogger } from '../../utils/logger.js'
import { inspectProcessTree } from './health.js'
import type { OutputFormat } from './pipeline-shared.js'
import { formatOutput } from './pipeline-shared.js'

const logger = createLogger('stop-cmd')

/** How often (ms) to poll whether the orchestrator is still alive. */
const POLL_INTERVAL_MS = 500

/** Total time (ms) to wait for the orchestrator to exit before giving up. */
const STOP_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// isPidAlive — probe whether a PID is still running
// ---------------------------------------------------------------------------

/**
 * Returns true if `pid` is a live process, false if it no longer exists.
 * Uses `process.kill(pid, 0)` — no signal is sent; ESRCH means gone.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false  // No such process
    // EPERM means process exists but we lack permission to signal it
    if (code === 'EPERM') return true
    return false
  }
}

// ---------------------------------------------------------------------------
// runStopAction
// ---------------------------------------------------------------------------

export async function runStopAction(options: {
  outputFormat: OutputFormat
  projectRoot: string
  runId?: string
}): Promise<number> {
  const { outputFormat, projectRoot } = options

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const substrateDirPath = join(dbRoot, '.substrate')

  // Locate the orchestrator PID via PID file / process tree inspection
  const processInfo = inspectProcessTree({ projectRoot, substrateDirPath })
  const pid = processInfo.orchestrator_pid

  if (pid === null) {
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput({ stopped: false, reason: 'no_running_pipeline' }, 'json', true) + '\n')
    } else {
      process.stdout.write('No running pipeline found.\n')
    }
    return 0
  }

  if (outputFormat === 'human') {
    process.stdout.write(`Sending SIGTERM to orchestrator (PID ${pid})...\n`)
  }

  // Send SIGTERM — the Story 58-7 handler will flush state and exit with code 143
  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn({ pid, err: msg }, 'Failed to send SIGTERM to orchestrator')
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput({ stopped: false, reason: 'kill_failed', error: msg }, 'json', true) + '\n')
    } else {
      process.stdout.write(`Error: could not signal PID ${pid}: ${msg}\n`)
    }
    return 1
  }

  // Poll until the process exits or the timeout expires
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    if (!isPidAlive(pid)) {
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput({ stopped: true, pid }, 'json', true) + '\n')
      } else {
        process.stdout.write(`Orchestrator (PID ${pid}) stopped.\n`)
      }
      return 0
    }
  }

  // Timeout
  if (outputFormat === 'json') {
    process.stdout.write(
      formatOutput({ stopped: false, reason: 'timeout', pid, timeout_ms: STOP_TIMEOUT_MS }, 'json', true) + '\n',
    )
  } else {
    process.stdout.write(
      `Timeout: orchestrator (PID ${pid}) did not exit within ${STOP_TIMEOUT_MS / 1000}s.\n` +
        `Run \`substrate cancel --force\` to force-kill it.\n`,
    )
  }
  return 2
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerStopCommand(program: Command, projectRoot = process.cwd()): void {
  program
    .command('stop')
    .description(
      'Send SIGTERM to the running pipeline and wait for graceful shutdown (Story 58-7)',
    )
    .option('--run-id <id>', 'Pipeline run ID (reserved for future use; currently uses PID file)')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .action(
      async (opts: {
        runId?: string
        projectRoot: string
        outputFormat: string
      }) => {
        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
        const exitCode = await runStopAction({
          outputFormat,
          projectRoot: opts.projectRoot,
          runId: opts.runId,
        })
        process.exitCode = exitCode
      },
    )
}
