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
import type { TwinHealthMonitor } from '../twins/health-monitor.js'

// ---------------------------------------------------------------------------
// TwinCoordinator interface
// ---------------------------------------------------------------------------

/**
 * Coordinates the lifecycle of digital twins required for scenario execution.
 * Concrete implementations live in the twins module (story 47-2) and are
 * injected via `ScenarioRunnerOptions.twinCoordinator`.
 */
export interface TwinCoordinator {
  /**
   * Start the named digital twins.
   * Resolves with a map of environment variable key-value pairs to inject
   * into scenario subprocesses (e.g. `{ STRIPE_URL: 'http://localhost:4242' }`).
   */
  startTwins(names: string[]): Promise<Record<string, string>>

  /**
   * Stop all running twins. Must be idempotent — safe to call multiple times.
   */
  stopTwins(): Promise<void>
}

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface ScenarioRunnerOptions {
  /**
   * Maximum time to allow per scenario in milliseconds.
   * Not yet enforced — reserved for future implementation.
   */
  _timeoutMs?: number

  /**
   * Optional coordinator for managing digital twin lifecycles.
   * When provided along with a manifest that has a non-empty `twins` field,
   * the runner will start twins before scenario execution and stop them after
   * (even if scenarios fail), injecting the returned env vars into subprocesses.
   */
  twinCoordinator?: TwinCoordinator

  /**
   * Optional health monitor for digital twins. When provided, the runner checks
   * the health status of all monitored twins before executing any scenarios.
   * If any twin is 'unhealthy', execution aborts with a failure result (story 47-6).
   */
  twinHealthMonitor?: TwinHealthMonitor
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
 *
 * @param entry       - Scenario entry with name and path.
 * @param projectRoot - Working directory for scenario execution.
 * @param env         - Optional extra environment variables to inject into the subprocess.
 *                      When provided, merged on top of `process.env`.
 */
function runScenario(
  entry: { name: string; path: string },
  projectRoot: string,
  env?: Record<string, string>
): Promise<ScenarioResult> {
  return new Promise((resolve) => {
    const startTime = Date.now()
    const command = getExecutionCommand(entry.path)
    const spawnEnv = env != null ? { ...process.env, ...env } : undefined
    const child = spawn(command, [], { cwd: projectRoot, shell: true, env: spawnEnv })

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

/**
 * Build a ScenarioRunResult where every scenario is marked as failed due to
 * a twin startup error. No scripts were executed.
 */
function buildStartupFailureResult(
  scenarioEntries: ScenarioManifest['scenarios'],
  err: Error
): ScenarioRunResult {
  const scenarios: ScenarioResult[] = scenarioEntries.map((entry) => ({
    name: entry.name,
    status: 'fail',
    exitCode: -1,
    stdout: '',
    stderr: err.message,
    durationMs: 0,
  }))
  return {
    scenarios,
    summary: {
      total: scenarios.length,
      passed: 0,
      failed: scenarios.length,
    },
    durationMs: 0,
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a ScenarioRunner that executes all scenarios in a manifest.
 *
 * @param options - Optional configuration including twin coordinator and timeout.
 */
export function createScenarioRunner(options?: ScenarioRunnerOptions): ScenarioRunner {
  return {
    async run(manifest: ScenarioManifest, projectRoot: string): Promise<ScenarioRunResult> {
      const startTime = Date.now()
      const { twinCoordinator } = options ?? {}
      const requiresTwins = (manifest.twins?.length ?? 0) > 0 && twinCoordinator != null

      if (!requiresTwins) {
        // Check health gate — abort if any monitored twin is unhealthy (story 47-6)
        if (options?.twinHealthMonitor) {
          const healthStatus = options.twinHealthMonitor.getStatus()
          const unhealthyNames = Object.entries(healthStatus)
            .filter(([, s]) => s === 'unhealthy')
            .map(([name]) => name)
          if (unhealthyNames.length > 0) {
            const msg = unhealthyNames.map((n) => `Twin '${n}' is unhealthy`).join('; ')
            return buildStartupFailureResult(manifest.scenarios, new Error(msg))
          }
        }

        // Existing code path — unchanged
        const scenarios = await Promise.all(
          manifest.scenarios.map((entry) => runScenario(entry, projectRoot))
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
      }

      // Twin-aware code path
      let twinEnv: Record<string, string>
      try {
        twinEnv = await twinCoordinator!.startTwins(manifest.twins!)
      } catch (err) {
        // Startup failed — map all scenarios to failure; do NOT call stopTwins
        return buildStartupFailureResult(manifest.scenarios, err as Error)
      }

      // Check health gate after twin startup — abort if any monitored twin is unhealthy (story 47-6)
      if (options?.twinHealthMonitor) {
        const healthStatus = options.twinHealthMonitor.getStatus()
        const unhealthyNames = Object.entries(healthStatus)
          .filter(([, s]) => s === 'unhealthy')
          .map(([name]) => name)
        if (unhealthyNames.length > 0) {
          const msg = unhealthyNames.map((n) => `Twin '${n}' is unhealthy`).join('; ')
          try {
            await twinCoordinator!.stopTwins()
          } catch {
            // best-effort cleanup
          }
          return buildStartupFailureResult(manifest.scenarios, new Error(msg))
        }
      }

      try {
        const scenarios = await Promise.all(
          manifest.scenarios.map((entry) => runScenario(entry, projectRoot, twinEnv))
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
      } finally {
        await twinCoordinator!.stopTwins()
      }
    },
  }
}
