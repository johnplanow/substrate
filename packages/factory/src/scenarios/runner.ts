/**
 * ScenarioRunner — executes scenario files and returns aggregated results.
 *
 * Supports scenario files matching scenario-*.{sh,py,js,ts} by dispatching
 * to the appropriate interpreter based on file extension.
 *
 * Story 44-2 / Story 44-5.
 */

import { spawn } from 'child_process'
import { extname } from 'path'
import type { ScenarioManifest } from './types.js'
import type { ScenarioResult, ScenarioRunResult } from '../events.js'

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface ScenarioRunnerOptions {
  /**
   * Maximum time to allow per scenario in milliseconds.
   * Not yet enforced — reserved for future implementation.
   */
  _timeoutMs?: number
}

// ---------------------------------------------------------------------------
// ScenarioRunner interface
// ---------------------------------------------------------------------------

export interface ScenarioRunner {
  /**
   * Execute all scenarios in the manifest and return aggregated results.
   *
   * @param manifest   - The scenario manifest from ScenarioStore.discover().
   * @param projectRoot - Working directory for scenario execution.
   */
  run(manifest: ScenarioManifest, projectRoot: string): Promise<ScenarioRunResult>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the shell command string to execute a scenario file.
 * Dispatches by file extension so each interpreter is called correctly.
 */
function getExecutionCommand(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case '.sh':
      return `sh "${filePath}"`
    case '.py':
      return `python3 "${filePath}"`
    case '.js':
      return `node "${filePath}"`
    case '.ts':
      return `npx tsx "${filePath}"`
    default:
      return `"${filePath}"`
  }
}

/**
 * Run a single scenario file and return its result.
 */
function runScenario(
  entry: { name: string; path: string },
  projectRoot: string,
): Promise<ScenarioResult> {
  return new Promise((resolve) => {
    const startTime = Date.now()
    const command = getExecutionCommand(entry.path)
    const child = spawn(command, [], { cwd: projectRoot, shell: true })

    let stdoutBuf = ''
    let stderrBuf = ''

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutBuf += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrBuf += chunk.toString()
    })

    child.on('error', (err: Error) => {
      const durationMs = Date.now() - startTime
      resolve({
        name: entry.name,
        status: 'fail',
        exitCode: -1,
        stdout: stdoutBuf.trim(),
        stderr: err.message,
        durationMs,
      })
    })

    child.on('close', (code: number | null) => {
      const durationMs = Date.now() - startTime
      const exitCode = code ?? -1
      const status: 'pass' | 'fail' = exitCode === 0 ? 'pass' : 'fail'

      // Attempt to parse stdout as JSON; attach as parsedOutput if successful
      const trimmedStdout = stdoutBuf.trim()
      let parsedOutput: unknown
      if (trimmedStdout) {
        try {
          parsedOutput = JSON.parse(trimmedStdout)
        } catch {
          // Not JSON — leave parsedOutput undefined
        }
      }

      const result: ScenarioResult = {
        name: entry.name,
        status,
        exitCode,
        stdout: trimmedStdout,
        stderr: stderrBuf.trim(),
        durationMs,
      }

      if (parsedOutput !== undefined) {
        result.parsedOutput = parsedOutput
      }

      resolve(result)
    })
  })
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a ScenarioRunner that executes all scenarios in a manifest.
 *
 * @param _options - Optional configuration (currently reserved for future use).
 */
export function createScenarioRunner(_options?: ScenarioRunnerOptions): ScenarioRunner {
  return {
    async run(manifest: ScenarioManifest, projectRoot: string): Promise<ScenarioRunResult> {
      const startTime = Date.now()

      const scenarios = await Promise.all(
        manifest.scenarios.map((entry) => runScenario(entry, projectRoot)),
      )

      const passed = scenarios.filter((s) => s.status === 'pass').length
      const failed = scenarios.filter((s) => s.status === 'fail').length

      return {
        scenarios,
        summary: {
          total: scenarios.length,
          passed,
          failed,
        },
        durationMs: Date.now() - startTime,
      }
    },
  }
}
