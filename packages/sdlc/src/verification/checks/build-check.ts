/**
 * BuildCheck — Story 51-4.
 *
 * Tier A verification check that runs the project's build command after each
 * story dispatch to catch compile-time regressions immediately.
 *
 * Architecture constraints (DC-6, FR-V9, FR-V11):
 * - No LLM calls — pure shell invocation.
 * - Hard 60-second timeout. On timeout the entire process group is killed.
 * - Runs in Tier A, third in canonical order: after PhantomReviewCheck and
 *   TrivialOutputCheck.
 *
 * Build command detection priority (mirrors dispatcher-impl.ts logic without
 * importing from the monolith to avoid circular dependencies):
 *   1. turbo.json        → 'turbo build'
 *   2. pnpm-lock.yaml    → 'pnpm run build'
 *   3. yarn.lock         → 'yarn build'
 *   4. bun.lockb         → 'bun run build'
 *   5. package.json      → 'npm run build'
 *   6. Non-Node markers  → '' (skip)
 *   7. Nothing found     → '' (skip)
 */

import type {
  VerificationCheck,
  VerificationContext,
  VerificationFinding,
  VerificationResult,
} from '../types.js'
import { renderFindings } from '../findings.js'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard timeout for the build command in milliseconds (FR-V11). */
export const BUILD_CHECK_TIMEOUT_MS = 60_000

/** Maximum characters to include in details string from build output. */
const MAX_OUTPUT_CHARS = 2000

/** Per-stream tail size cap for structured findings (story 55-1 convention). */
const TAIL_BYTES = 4 * 1024

/** Return the last N bytes of a UTF-8 string, sliced by string length for simplicity. */
function tail(text: string, bytes = TAIL_BYTES): string {
  return text.length <= bytes ? text : text.slice(text.length - bytes)
}

// ---------------------------------------------------------------------------
// Build command detection
// ---------------------------------------------------------------------------

/**
 * Detect the build command for a project based on files present in `workingDir`.
 *
 * Returns an empty string when no recognized build system is found, which
 * causes BuildCheck to return a 'warn' result without blocking the pipeline.
 *
 * NOTE: Do NOT import from src/modules/agent-dispatch/dispatcher-impl.ts —
 * that would create a circular dependency from packages/sdlc/ → monolith src/.
 * This function inlines the detection logic independently.
 */
export function detectBuildCommand(workingDir: string): string {
  // Priority 1: turbo.json
  if (existsSync(join(workingDir, 'turbo.json'))) {
    return 'turbo build'
  }
  // Priority 2: pnpm-lock.yaml
  if (existsSync(join(workingDir, 'pnpm-lock.yaml'))) {
    return 'pnpm run build'
  }
  // Priority 3: yarn.lock
  if (existsSync(join(workingDir, 'yarn.lock'))) {
    return 'yarn build'
  }
  // Priority 4: bun.lockb
  if (existsSync(join(workingDir, 'bun.lockb'))) {
    return 'bun run build'
  }
  // Priority 5: package.json (no turbo/lockfile match above)
  if (existsSync(join(workingDir, 'package.json'))) {
    return 'npm run build'
  }
  // Non-Node build markers: no universal build step, skip
  const nonNodeMarkers = ['pyproject.toml', 'poetry.lock', 'setup.py', 'Cargo.toml', 'go.mod']
  for (const marker of nonNodeMarkers) {
    if (existsSync(join(workingDir, marker))) {
      return ''
    }
  }
  // Nothing found
  return ''
}

// ---------------------------------------------------------------------------
// BuildCheck
// ---------------------------------------------------------------------------

/**
 * Runs the project's build command and returns pass/warn/fail based on exit code.
 *
 * AC1: exit code 0 → pass
 * AC2: non-zero exit code → fail with truncated output in details
 * AC3: timeout → kill process group, return fail with timeout message
 * AC4: no recognized build system → warn without blocking
 * AC5: explicit buildCommand override respected; empty string → warn (skip)
 * AC6: name === 'build', tier === 'A'
 */
export class BuildCheck implements VerificationCheck {
  readonly name = 'build'
  readonly tier = 'A' as const

  async run(context: VerificationContext): Promise<VerificationResult> {
    const start = Date.now()

    // Resolve the command to run
    const cmd =
      context.buildCommand !== undefined
        ? context.buildCommand
        : detectBuildCommand(context.workingDir)

    // Empty command → skip (warn)
    if (cmd === '') {
      const findings: VerificationFinding[] = [
        {
          category: 'build-skip',
          severity: 'warn',
          message: `no build command detected for project at ${context.workingDir}`,
        },
      ]
      return {
        status: 'warn',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    // Spawn the build process as a detached process group so we can kill the
    // entire group on timeout (FR-V11).
    return new Promise<VerificationResult>((resolve) => {
      const child = spawn(cmd, [], {
        cwd: context.workingDir,
        detached: true,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      // Stream-separated capture so the structured finding can carry each stream
      // independently. `output` is kept as the combined stream for backward-compat
      // details rendering in the legacy format.
      let stdout = ''
      let stderr = ''
      let output = ''

      child.stdout?.on('data', (chunk: Buffer) => {
        const s = chunk.toString()
        stdout += s
        output += s
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        const s = chunk.toString()
        stderr += s
        output += s
      })

      // Hard timeout: kill the process group and return fail
      const timeoutHandle = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          // Process already exited between timeout fire and kill call
        }
        const duration = Date.now() - start
        const findings: VerificationFinding[] = [
          {
            category: 'build-timeout',
            severity: 'error',
            message: `command exceeded ${BUILD_CHECK_TIMEOUT_MS}ms`,
            command: cmd,
            // exitCode omitted — process was killed before reporting one
            stdoutTail: tail(stdout),
            stderrTail: tail(stderr),
            durationMs: duration,
          },
        ]
        resolve({
          status: 'fail',
          details: renderFindings(findings),
          duration_ms: duration,
          findings,
        })
      }, BUILD_CHECK_TIMEOUT_MS)

      child.on('close', (code) => {
        clearTimeout(timeoutHandle)

        const duration = Date.now() - start
        if (code === 0) {
          resolve({
            status: 'pass',
            details: 'build passed',
            duration_ms: duration,
            findings: [],
          })
        } else {
          const truncated =
            output.length > MAX_OUTPUT_CHARS
              ? output.slice(0, MAX_OUTPUT_CHARS) + '... (truncated)'
              : output
          const findings: VerificationFinding[] = [
            {
              category: 'build-error',
              severity: 'error',
              // Message carries the same human-readable summary the legacy
              // details string used to emit, so renderFindings(findings) ==
              // the old details verbatim (minus the leading category prefix).
              message: `build failed (exit ${code}): ${truncated}`,
              command: cmd,
              ...(code !== null ? { exitCode: code } : {}),
              stdoutTail: tail(stdout),
              stderrTail: tail(stderr),
              durationMs: duration,
            },
          ]
          resolve({
            status: 'fail',
            details: renderFindings(findings),
            duration_ms: duration,
            findings,
          })
        }
      })
    })
  }
}
