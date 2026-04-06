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

import type { VerificationCheck, VerificationContext, VerificationResult } from '../types.js'
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
      return {
        status: 'warn',
        details: `build-skip: no build command detected for project at ${context.workingDir}`,
        duration_ms: Date.now() - start,
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

      let output = ''

      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })

      // Hard timeout: kill the process group and return fail
      const timeoutHandle = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          // Process already exited between timeout fire and kill call
        }
        resolve({
          status: 'fail',
          details: `build-timeout: command exceeded ${BUILD_CHECK_TIMEOUT_MS}ms`,
          duration_ms: Date.now() - start,
        })
      }, BUILD_CHECK_TIMEOUT_MS)

      child.on('close', (code) => {
        clearTimeout(timeoutHandle)

        if (code === 0) {
          resolve({
            status: 'pass',
            details: 'build passed',
            duration_ms: Date.now() - start,
          })
        } else {
          const truncated =
            output.length > MAX_OUTPUT_CHARS
              ? output.slice(0, MAX_OUTPUT_CHARS) + '... (truncated)'
              : output
          resolve({
            status: 'fail',
            details: `build failed (exit ${code}): ${truncated}`,
            duration_ms: Date.now() - start,
          })
        }
      })
    })
  }
}
