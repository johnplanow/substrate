/**
 * Dolt SQL Server lifecycle management for pipeline runs.
 *
 * Starts a `dolt sql-server` as a background child process before the pipeline
 * begins, and kills it on cleanup. This eliminates CLI-mode concurrent write
 * failures ("cannot update manifest: database is read only") that occur when
 * multiple dolt sql -q processes contend on the noms manifest lock.
 *
 * The server listens on a unix socket only (no TCP) and is transparent to
 * DoltClient — when the socket exists, DoltClient uses pool mode automatically.
 */

import { spawn, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('dolt-server')

export interface DoltServerHandle {
  /** PID of the dolt sql-server process. */
  pid: number
  /** Path to the unix socket the server is listening on. */
  socketPath: string
  /** Stop the server. Safe to call multiple times. */
  stop: () => void
}

/**
 * Start a dolt sql-server for the given project, if Dolt is available and no
 * server is already running (socket already exists).
 *
 * Returns a handle to stop the server, or null if:
 * - Dolt is not on PATH
 * - The .substrate/state directory doesn't contain a Dolt repo
 * - A socket already exists (external server already running)
 * - The server failed to start within the timeout
 */
export async function startDoltServer(projectRoot: string): Promise<DoltServerHandle | null> {
  const stateDir = join(projectRoot, '.substrate', 'state')
  const socketPath = join(stateDir, '.dolt', 'dolt.sock')

  // Skip if no Dolt repo exists
  if (!existsSync(join(stateDir, '.dolt'))) {
    return null
  }

  // Skip if socket already exists (external server is running)
  try {
    await access(socketPath)
    logger.debug('Dolt socket already exists at %s — using existing server', socketPath)
    return null
  } catch {
    // Socket doesn't exist — proceed with auto-start
  }

  // Verify dolt is on PATH
  try {
    execFileSync('dolt', ['version'], { cwd: stateDir, stdio: 'pipe' })
  } catch {
    logger.debug('dolt binary not on PATH — cannot start server')
    return null
  }

  // Start the server
  logger.debug('Starting dolt sql-server at %s', socketPath)
  let proc: ChildProcess
  try {
    proc = spawn(
      'dolt',
      [
        'sql-server',
        '--socket',
        socketPath,
        '--port',
        '0', // disable TCP — unix socket only
        '--max-connections',
        '10',
      ],
      {
        cwd: stateDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      }
    )
  } catch (err) {
    logger.debug(
      'Failed to spawn dolt sql-server: %s',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }

  // Handle spawn errors
  let failed = false
  proc.on('error', (err) => {
    logger.debug('dolt sql-server error: %s', err.message)
    failed = true
  })
  proc.on('exit', (code) => {
    if (code !== null && code !== 0) {
      logger.debug('dolt sql-server exited with code %d', code)
    }
  })

  // Capture stderr for debug logging
  proc.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim()
    if (line) logger.debug('dolt-server: %s', line)
  })

  // Wait for the socket to appear (poll every 100ms, up to 5s)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && !failed) {
    try {
      await access(socketPath)
      const pid = proc.pid ?? 0
      logger.info('Auto-started dolt sql-server (pid=%d, socket=%s)', pid, socketPath)

      let stopped = false
      return {
        pid,
        socketPath,
        stop: () => {
          if (stopped) return
          stopped = true
          logger.debug('Stopping dolt sql-server (pid=%d)', pid)
          proc.kill('SIGTERM')
        },
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  // Timeout or error — kill and return null
  logger.debug('dolt sql-server did not start within 5s — killing')
  proc.kill('SIGTERM')
  return null
}

/**
 * Register cleanup handlers to stop the Dolt server on process exit/signals.
 */
export function registerServerCleanup(handle: DoltServerHandle): void {
  const cleanup = () => handle.stop()
  process.on('exit', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
}
