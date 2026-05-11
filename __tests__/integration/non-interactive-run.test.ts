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

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import type { TestContext } from 'vitest'
import { execSync, spawnSync } from 'child_process'
import { existsSync, rmSync } from 'fs'
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
// Worktree cleanup (Story 75-4, AC3 + leak-finder follow-up 2026-05-11)
//
// When worktree mode is default-on (Story 75-1), a run against story key
// '0-1' creates `.substrate-worktrees/0-1` AND `substrate/story-0-1` branch
// under SUBSTRATE_ROOT (the live substrate repo, because `--project-root
// SUBSTRATE_ROOT` is passed for a real-dispatch integration check).
//
// Initial cleanup was `rmSync(.substrate-worktrees)` — removed the dir
// but didn't tell git. The gitdir record under `.git/worktrees/0-1/`
// persisted as "prunable" AND the branch persisted, accumulating across
// `npm test` runs. The leak-finder setupFile at test/leak-finder-setup.ts
// identified THIS file as the source 2026-05-11.
//
// Correct cleanup: `git worktree remove --force` for the worktree (handles
// both dir + gitdir record), then `git worktree prune` as belt-and-
// suspenders for the prunable case, then `git branch -D` for the branch.
// All wrapped in try/catch — best-effort because the test's primary
// purpose is the AC9 stdin assertion, not exercising cleanup paths.
// ---------------------------------------------------------------------------

afterEach(() => {
  const wtPath = join(SUBSTRATE_ROOT, '.substrate-worktrees', '0-1')
  try {
    execSync(`git worktree remove --force ${JSON.stringify(wtPath)}`, {
      cwd: SUBSTRATE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    })
  } catch {
    // worktree may not exist (e.g., --no-worktree path, or test failed
    // before create). Fall through to belt-and-suspenders cleanup.
  }
  try {
    execSync('git worktree prune', {
      cwd: SUBSTRATE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    })
  } catch {
    // best-effort
  }
  try {
    execSync('git branch -D substrate/story-0-1', {
      cwd: SUBSTRATE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    })
  } catch {
    // branch may not exist
  }
  // Final sweep — remove the .substrate-worktrees/ directory entirely
  // in case a stale entry from a prior failed run remains.
  rmSync(join(SUBSTRATE_ROOT, '.substrate-worktrees'), { recursive: true, force: true })
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
    // cleanEnv: see MEMORY.md "Vitest spawnSync env-inheritance bug" —
    // {...process.env} causes 30s borderline hangs from inherited vitest
    // signal handlers / module loader interactions. v0.20.73 propagated
    // cleanEnv to interactive-prompt.test.ts (70s → 4s); this test was
    // the next candidate flagged in that ship's notes (52s wall-clock).
    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      USER: process.env['USER'] ?? '',
      SHELL: process.env['SHELL'] ?? '',
    }
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
        env: cleanEnv,
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
