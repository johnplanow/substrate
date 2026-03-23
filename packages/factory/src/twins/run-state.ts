/**
 * Run state management for digital twin sessions.
 *
 * Persists the compose directory path and started twin names to
 * `.substrate/twins/.run-state.json` so that `twins stop` and `twins status`
 * can locate the active session without Docker inspection.
 *
 * Story 47-5.
 */

import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import path from 'node:path'

// ---------------------------------------------------------------------------
// TwinRunState interface
// ---------------------------------------------------------------------------

/**
 * Serialized state written by `twins start` and read by `twins stop`/`twins status`.
 */
export interface TwinRunState {
  /** Absolute path to the temp directory containing the active docker-compose.yml */
  composeDir: string
  /** Names of all twins included in this run */
  twinNames: string[]
  /** ISO 8601 timestamp of when the twins were started */
  startedAt: string
}

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the run-state JSON file for the given project.
 *
 * @param projectDir - Absolute path to the project root (usually `process.cwd()`)
 */
export function runStatePath(projectDir: string): string {
  return path.join(projectDir, '.substrate', 'twins', '.run-state.json')
}

// ---------------------------------------------------------------------------
// Read / write / clear
// ---------------------------------------------------------------------------

/**
 * Reads and JSON-parses the run-state file.
 *
 * @returns The parsed `TwinRunState`, or `null` if the file does not exist.
 * @throws If any I/O error other than ENOENT occurs, or if the JSON is invalid.
 */
export async function readRunState(projectDir: string): Promise<TwinRunState | null> {
  const filePath = runStatePath(projectDir)
  try {
    const content = await readFile(filePath, 'utf-8')
    return JSON.parse(content) as TwinRunState
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Writes the given run state to disk, creating parent directories as needed.
 *
 * @param projectDir - Absolute path to the project root
 * @param state - The `TwinRunState` to persist
 */
export async function writeRunState(projectDir: string, state: TwinRunState): Promise<void> {
  const filePath = runStatePath(projectDir)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * Deletes the run-state file. No-op if the file does not exist.
 *
 * @param projectDir - Absolute path to the project root
 */
export async function clearRunState(projectDir: string): Promise<void> {
  const filePath = runStatePath(projectDir)
  try {
    await unlink(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
