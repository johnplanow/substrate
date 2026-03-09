/**
 * Dolt initialization logic for the Substrate state layer.
 *
 * Provides `initializeDolt()` which creates and seeds a Dolt repository
 * at `.substrate/state/` using only the Dolt CLI — no mysql2 dependency
 * is required at this stage (that is added in story 26-3).
 */

import { spawn } from 'node:child_process'
import { mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Configuration interface
// ---------------------------------------------------------------------------

/**
 * Configuration for `initializeDolt()`.
 */
export interface DoltInitConfig {
  /** Absolute path to the project root. */
  projectRoot: string
  /**
   * Path where the Dolt repository will be created.
   * Defaults to `<projectRoot>/.substrate/state/`.
   */
  statePath?: string
  /**
   * Path to the `schema.sql` DDL file.
   * Defaults to the `schema.sql` bundled alongside this module.
   */
  schemaPath?: string
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when the `dolt` binary cannot be found in PATH.
 */
export class DoltNotInstalled extends Error {
  constructor() {
    super(
      'Dolt CLI not found in PATH. Install Dolt from https://docs.dolthub.com/introduction/installation',
    )
    this.name = 'DoltNotInstalled'
  }
}

/**
 * Thrown when a Dolt CLI command exits with a non-zero status code.
 */
export class DoltInitError extends Error {
  constructor(args: string[], exitCode: number, stderr: string) {
    super(
      `Dolt command "dolt ${args.join(' ')}" failed with exit code ${exitCode}${stderr ? `: ${stderr}` : ''}`,
    )
    this.name = 'DoltInitError'
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Verify that the `dolt` binary is installed and accessible.
 *
 * @throws {DoltNotInstalled} If the binary is not found in PATH.
 */
export async function checkDoltInstalled(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('dolt', ['version'], { stdio: 'ignore' })
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException
      if (nodeErr.code === 'ENOENT') {
        reject(new DoltNotInstalled())
      } else {
        reject(err)
      }
      return
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new DoltNotInstalled())
      } else {
        reject(err)
      }
    })

    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve()
      } else {
        // dolt exited non-zero but was found — treat as installed but broken
        resolve()
      }
    })
  })
}

/**
 * Run a Dolt CLI command in the given working directory.
 *
 * @param args - Arguments to pass to `dolt` (e.g. `['init']`).
 * @param cwd  - Working directory for the command.
 * @throws {DoltInitError} If the command exits with a non-zero code.
 */
export async function runDoltCommand(args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stderrChunks: Buffer[] = []
    const child = spawn('dolt', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })

    child.on('error', (err: Error) => {
      reject(err)
    })

    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve()
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
        reject(new DoltInitError(args, code ?? -1, stderr))
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize a Dolt repository for Substrate state storage.
 *
 * This function is idempotent: running it a second time on an already-
 * initialized repository is safe — `dolt init` is skipped, existing tables
 * are not re-created (IF NOT EXISTS guards), and the schema version row is
 * not duplicated (INSERT IGNORE).
 *
 * @param config - Initialization configuration.
 * @throws {DoltNotInstalled} If the `dolt` binary is not in PATH.
 * @throws {DoltInitError} If any Dolt CLI command fails.
 */
export async function initializeDolt(config: DoltInitConfig): Promise<void> {
  // Resolve paths
  const statePath =
    config.statePath ?? join(config.projectRoot, '.substrate', 'state')
  const schemaPath =
    config.schemaPath ??
    fileURLToPath(new URL('./schema.sql', import.meta.url))

  // 1. Verify Dolt is installed
  await checkDoltInstalled()

  // 2. Create the state directory (recursive — idempotent)
  await mkdir(statePath, { recursive: true })

  // 3. Initialize Dolt repo only if .dolt/ does not already exist
  const doltDir = join(statePath, '.dolt')
  let doltDirExists = false
  try {
    await access(doltDir)
    doltDirExists = true
  } catch {
    doltDirExists = false
  }

  if (!doltDirExists) {
    await runDoltCommand(['init'], statePath)
  }

  // 4. Apply the DDL (idempotent via IF NOT EXISTS / INSERT IGNORE)
  await runDoltCommand(['sql', '-f', schemaPath], statePath)

  // 5. Create the initial commit only if no commits exist yet
  let hasCommits = false
  try {
    await runDoltCommand(['log', '--oneline'], statePath)
    // If this succeeds, check whether there is any output.
    // We use a separate helper that captures stdout to detect empty log.
    hasCommits = await doltLogHasCommits(statePath)
  } catch {
    hasCommits = false
  }

  if (!hasCommits) {
    await runDoltCommand(['add', '-A'], statePath)
    await runDoltCommand(
      ['commit', '-m', 'Initialize substrate state schema v1'],
      statePath,
    )
  }
}

/**
 * Returns `true` if there is at least one commit in the Dolt repo.
 */
async function doltLogHasCommits(cwd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const stdoutChunks: Buffer[] = []
    const child = spawn('dolt', ['log', '--oneline'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })

    child.on('error', () => resolve(false))
    child.on('close', (code: number | null) => {
      if (code !== 0) {
        resolve(false)
        return
      }
      const output = Buffer.concat(stdoutChunks).toString('utf8').trim()
      resolve(output.length > 0)
    })
  })
}
