/**
 * Integration tests for Story 72-2: --non-interactive flag.
 *
 * Spawns `substrate run --non-interactive` as a child process with stdin
 * redirected from /dev/null (closed pipe) and verifies:
 *   1. The process exits within timeout (no stdin blocking)
 *   2. Exit code is 0, 1, or 2 (machine-readable per AC3)
 *
 * Skipped when dist/cli.mjs is not present (pre-build environments).
 *
 * Phase D Story 54-6 (2026-04-05): original headless CI/CD spec.
 * Story 72-1: Decision Router providing routeDecision defaultAction authority.
 * Story 72-2: --non-interactive flag enabling CI/CD non-blocking invocations.
 * Enables strata + agent-mesh cross-project CI/CD invocation.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import type { TestContext } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SUBSTRATE_ROOT = resolve(__dirname, '../..')
const CLI_MJS = join(SUBSTRATE_ROOT, 'dist', 'cli.mjs')

// ---------------------------------------------------------------------------
// Skip when not built
// ---------------------------------------------------------------------------

let cliBuildExists = false
beforeAll(() => {
  cliBuildExists = existsSync(CLI_MJS)
})

// ---------------------------------------------------------------------------
// Integration test: non-interactive exits without blocking stdin
// ---------------------------------------------------------------------------

describe('substrate run --non-interactive', () => {
  // NOTE: AC1/AC11 (flag registration in --help) is verified by the runtime probe
  // `non-interactive-flag-registered-in-help` which runs `node dist/cli.mjs run --help`
  // in the host sandbox. This integration test focuses on the AC9 behavioral guarantee
  // (stdin suppression + machine-readable exit codes) which requires a full pipeline run.

  it('exits without reading stdin when --non-interactive is set (AC9)', (ctx: TestContext) => {
    if (!cliBuildExists) {
      // Use ctx.skip() so vitest reports this as SKIPPED rather than PASSED
      // with 0 assertions — ensures pre-build CI surfaces the missing artifact
      // rather than silently passing without executing any behavioral assertions.
      ctx.skip()
    }

    // Spawn with stdin from /dev/null (closed) — if the process tries to read
    // stdin it will get EOF immediately, not block.
    //
    // --stories 0-1: constrains the run to a single non-existent story key so
    // the orchestrator does NOT auto-discover all pending stories from the
    // project root. Without --stories, substrate auto-discovers ALL pending
    // stories and may attempt real dispatches, mutating project state and
    // leaving orphaned claude-code processes if the 30s kill fires.
    // Story key '0-1' passes format validation but will not match any real
    // story in the project — the run completes quickly with exit 1 (escalated)
    // or 2 (failed), both of which are valid machine-readable outcomes per AC3.
    const result = spawnSync(
      process.execPath,
      [
        CLI_MJS,
        'run',
        '--non-interactive',
        '--halt-on', 'none',
        '--events',
        '--stories', '0-1',
        '--project-root', SUBSTRATE_ROOT,
      ],
      {
        // 'ignore' for stdin = closed pipe (equivalent to </dev/null)
        stdio: ['ignore', 'pipe', 'pipe'],
        // 30s timeout — if the process hangs on stdin this catches it
        timeout: 30_000,
        cwd: SUBSTRATE_ROOT,
      },
    )

    // Must not timeout (signal would be set if spawnSync timed out)
    expect(result.signal).toBeNull()

    // Exit code MUST be 0, 1, or 2 (machine-readable per AC3)
    // - 0: all stories succeeded or no pending stories (clean run)
    // - 1: some stories escalated; run completed
    // - 2: run-level failure (init failed, story not found, orchestrator error)
    expect([0, 1, 2]).toContain(result.status)
  })
})
