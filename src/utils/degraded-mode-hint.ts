/**
 * Shared utility for emitting degraded-mode hints when substrate CLI commands
 * (diff, history) are run against a file-only backend that does not support
 * Dolt-specific features.
 *
 * Story 26-12: CLI Degraded-Mode Hints
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { checkDoltInstalled, DoltNotInstalled } from '../modules/state/index.js'

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface DegradedModeHintOptions {
  outputFormat: string
  command: 'diff' | 'history'
  statePath: string
}

export interface DegradedModeHintResult {
  hint: string
  doltInstalled: boolean
}

// ---------------------------------------------------------------------------
// Internal hint builder
// ---------------------------------------------------------------------------

/**
 * Determine the appropriate degraded-mode hint message based on whether Dolt
 * is installed and/or initialized at the given state path.
 *
 * @param statePath - Absolute path to the substrate state directory
 *                    (e.g. `/project/.substrate/state`).
 */
export async function getDegradedModeHint(
  statePath: string
): Promise<{ hint: string; doltInstalled: boolean }> {
  try {
    await checkDoltInstalled()
    // Dolt binary found — check if repo is initialized
    if (!existsSync(join(statePath, '.dolt'))) {
      return {
        hint: 'Note: Dolt is installed but not initialized. Run `substrate init --dolt` to enable diff and history features.',
        doltInstalled: true,
      }
    }
    // Should not reach here when in file backend, but guard anyway
    return {
      hint: 'Note: Running on file backend. Diff and history require Dolt.',
      doltInstalled: true,
    }
  } catch (err) {
    if (err instanceof DoltNotInstalled) {
      return {
        hint: 'Note: Dolt is not installed. Install it from https://docs.dolthub.com/introduction/installation, then run `substrate init --dolt` to enable diff and history features.',
        doltInstalled: false,
      }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Exported emitter
// ---------------------------------------------------------------------------

/**
 * Emit a degraded-mode hint for the given command.
 *
 * - **Text mode**: writes the hint to `process.stderr` (not stdout).
 * - **JSON mode**: does NOT write to stderr; the caller is responsible for
 *   writing the returned `hint` field to stdout as part of its JSON envelope.
 *
 * @param options - Hint options including output format, command name, and
 *                  the resolved state directory path.
 * @returns The hint message and a flag indicating whether Dolt is installed.
 */
export async function emitDegradedModeHint(
  options: DegradedModeHintOptions
): Promise<DegradedModeHintResult> {
  const { hint, doltInstalled } = await getDegradedModeHint(options.statePath)

  if (options.outputFormat !== 'json') {
    // Use process.stderr.write so the output is not captured by console.error
    // spies in tests and is cleanly separated from stdout.
    process.stderr.write(`\n${hint}\n`)
  }

  return { hint, doltInstalled }
}
