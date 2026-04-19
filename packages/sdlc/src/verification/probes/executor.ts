/**
 * Host-sandbox probe executor — Epic 55 / Phase 2.
 *
 * Runs one runtime probe directly on the operator machine via a detached
 * shell process, with stream-separated capture and a hard timeout that
 * terminates the entire process group. Same safety posture as BuildCheck —
 * specifically the detached-process-group + SIGKILL-on-timeout pattern —
 * so probe execution cannot orphan long-running descendants.
 *
 * Twin-sandbox execution is **deferred to Phase 3** (Digital Twin
 * integration). RuntimeProbeCheck handles the `sandbox: twin` case itself
 * without routing through this module.
 */

import { spawn } from 'node:child_process'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  PROBE_TAIL_BYTES,
  type ProbeResult,
  type RuntimeProbe,
} from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the last N bytes of a UTF-8 string (sliced by length for simplicity). */
function tail(text: string, bytes = PROBE_TAIL_BYTES): string {
  return text.length <= bytes ? text : text.slice(text.length - bytes)
}

// ---------------------------------------------------------------------------
// executeProbeOnHost — public entry point
// ---------------------------------------------------------------------------

/** Options for host execution. Injected primarily to make tests deterministic. */
export interface HostExecuteOptions {
  /** Working directory for the spawned shell. Defaults to process.cwd(). */
  cwd?: string
  /** Environment override. Defaults to the parent process's env. */
  env?: NodeJS.ProcessEnv
}

/**
 * Execute one probe on the host and return a structured ProbeResult.
 *
 * Behavior notes:
 *   - The shell used is `/bin/sh -c '<probe.command>'` inside a detached
 *     process group (so the entire tree is killed on timeout).
 *   - stdout and stderr are captured independently; each is returned
 *     tailed to PROBE_TAIL_BYTES (≤ 4 KiB) so published tarballs of the
 *     run manifest stay small.
 *   - Timeout defaults to `probe.timeout_ms ?? DEFAULT_PROBE_TIMEOUT_MS`
 *     (60 s). When the timeout fires, the process group is SIGKILL'd and
 *     the returned result has `outcome: 'timeout'`, `exitCode` undefined.
 *   - Never throws. Spawn errors (e.g. exec format error) are returned as
 *     `outcome: 'fail'` with exitCode -1 and the error message captured on
 *     stderrTail, so the caller can emit a deterministic finding.
 */
export function executeProbeOnHost(
  probe: RuntimeProbe,
  options: HostExecuteOptions = {},
): Promise<ProbeResult> {
  const timeoutMs = probe.timeout_ms ?? DEFAULT_PROBE_TIMEOUT_MS
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const start = Date.now()

  return new Promise<ProbeResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const child = spawn(probe.command, [], {
      cwd,
      env,
      detached: true,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const finalize = (result: ProbeResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    child.on('error', (err) => {
      // spawn error (ENOENT, EACCES, EMFILE, etc.) — never reach 'close'.
      finalize({
        outcome: 'fail',
        command: probe.command,
        exitCode: -1,
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr + (stderr.length > 0 && !stderr.endsWith('\n') ? '\n' : '') + `spawn error: ${err.message}\n`),
        durationMs: Date.now() - start,
      })
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const timeoutHandle = setTimeout(() => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL')
        }
      } catch {
        // Process already exited between timeout fire and kill call.
      }
      finalize({
        outcome: 'timeout',
        command: probe.command,
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr),
        durationMs: Date.now() - start,
      })
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timeoutHandle)
      const duration = Date.now() - start
      finalize({
        outcome: code === 0 ? 'pass' : 'fail',
        command: probe.command,
        ...(code !== null ? { exitCode: code } : {}),
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr),
        durationMs: duration,
      })
    })
  })
}
