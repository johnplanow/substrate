/**
 * Unit tests for `test/global-setup.ts`.
 *
 * The setup module is invoked by vitest at suite-start time and again
 * at suite-end (via the returned teardown). We can't easily exercise the
 * vitest plumbing in a unit test, but we CAN drive the exported setup
 * function directly against a tmpdir snapshot to verify:
 *   - pre-existing worktree entries are preserved (operator workflow)
 *   - test-leaked entries are detected and removed
 *   - missing `.substrate-worktrees/` is handled gracefully
 *   - cleanup is best-effort (git failures don't throw)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function setupGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-global-setup-test-'))
  execSync('git init -q', { cwd: dir })
  execSync('git config user.email t@example.com', { cwd: dir })
  execSync('git config user.name test', { cwd: dir })
  // Need at least one commit so worktree add works
  writeFileSync(join(dir, 'README.md'), '# Test\n')
  execSync('git add README.md', { cwd: dir })
  execSync('git commit -q -m "initial"', { cwd: dir })
  return dir
}

function createWorktree(repoRoot: string, taskId: string): void {
  const wtPath = join(repoRoot, '.substrate-worktrees', taskId)
  mkdirSync(join(repoRoot, '.substrate-worktrees'), { recursive: true })
  execSync(
    `git worktree add ${JSON.stringify(wtPath)} -b substrate/story-${taskId}`,
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

describe('test/global-setup.ts — pollution cleanup safety net', () => {
  let repoRoot: string
  let originalCwd: string

  let originalExitCode: number | string | undefined

  beforeEach(() => {
    originalCwd = process.cwd()
    repoRoot = setupGitRepo()
    process.chdir(repoRoot)
    // Silence the warn/error emitted when leaks are detected — the test
    // verifies cleanup behavior, not log inspection.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Snapshot the original exit code so we can restore it after each
    // test (the tightened gate sets process.exitCode = 1 on leak).
    originalExitCode = process.exitCode
  })

  afterEach(() => {
    process.chdir(originalCwd)
    vi.restoreAllMocks()
    process.exitCode = originalExitCode
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('AC1: leaked worktree created during the run is removed by the teardown', async () => {
    // Import fresh to read process.cwd() at the right time
    const { default: setup } = await import('./global-setup.ts')
    const teardown = setup()

    // Simulate a test creating a leaked worktree mid-suite
    createWorktree(repoRoot, '0-1')
    // Verify it exists before teardown
    expect(
      execSync('git worktree list', { cwd: repoRoot, encoding: 'utf-8' }),
    ).toContain('.substrate-worktrees/0-1')

    await teardown()

    // Verify the leak is gone
    const after = execSync('git worktree list', { cwd: repoRoot, encoding: 'utf-8' })
    expect(after).not.toContain('.substrate-worktrees/0-1')
    // And the branch was deleted
    const branches = execSync('git branch', { cwd: repoRoot, encoding: 'utf-8' })
    expect(branches).not.toContain('substrate/story-0-1')
  })

  it('AC2: pre-existing worktree (operator-created BEFORE suite) is preserved', async () => {
    // Operator-created worktree exists before tests start
    createWorktree(repoRoot, 'operator-task-keep-me')

    const { default: setup } = await import('./global-setup.ts')
    const teardown = setup()

    // No new worktrees during "the suite"

    await teardown()

    // The pre-existing worktree must still be there
    const after = execSync('git worktree list', { cwd: repoRoot, encoding: 'utf-8' })
    expect(after).toContain('.substrate-worktrees/operator-task-keep-me')
  })

  it('AC3: pre-existing + leaked are correctly partitioned (preserve operator, remove leak)', async () => {
    createWorktree(repoRoot, 'operator-task')

    const { default: setup } = await import('./global-setup.ts')
    const teardown = setup()

    createWorktree(repoRoot, 'leaked-by-test')

    await teardown()

    const after = execSync('git worktree list', { cwd: repoRoot, encoding: 'utf-8' })
    expect(after).toContain('.substrate-worktrees/operator-task')
    expect(after).not.toContain('.substrate-worktrees/leaked-by-test')
  })

  it('AC4: no worktrees at all (only main) is handled gracefully (no crash, no warn)', async () => {
    // Only main exists. setup() snapshots empty taskId set. teardown
    // confirms still empty → no warn.
    const warnSpy = vi.mocked(console.warn)

    const { default: setup } = await import('./global-setup.ts')
    const teardown = setup()

    await expect(teardown()).resolves.toBeUndefined()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('AC4b: prunable worktree (gitdir record without directory) is detected as a leak and pruned', async () => {
    // Reproduces the empirically-observed leak class: a test creates a
    // worktree, deletes the directory via `rm -rf` without running `git
    // worktree remove`, leaving stale gitdir metadata. `readdirSync`
    // would miss this; `git worktree list --porcelain` catches it.
    //
    // Order matters: setup() snapshots BEFORE the leak, then the leak
    // happens "during the suite", then teardown() detects + cleans.
    const { default: setup } = await import('./global-setup.ts')
    const teardown = setup()

    createWorktree(repoRoot, 'simulated-rm-rf-leak')
    // Manually rm -rf the directory so git considers it prunable
    rmSync(join(repoRoot, '.substrate-worktrees', 'simulated-rm-rf-leak'), {
      recursive: true,
      force: true,
    })
    // Verify git sees the prunable entry
    expect(
      execSync('git worktree list', { cwd: repoRoot, encoding: 'utf-8' }),
    ).toMatch(/simulated-rm-rf-leak.*prunable/)

    await teardown()

    // After teardown, git worktree list should NOT include the prunable
    // entry (either pruned outright OR cleaned via worktree remove).
    const after = execSync('git worktree list', { cwd: repoRoot, encoding: 'utf-8' })
    expect(after).not.toContain('simulated-rm-rf-leak')
  })

  it('AC5: error() emitted with leak names when leaks are detected (tightened gate)', async () => {
    const errorSpy = vi.mocked(console.error)

    const { default: setup } = await import('./global-setup.ts')
    const teardown = setup()

    createWorktree(repoRoot, '7-3')
    createWorktree(repoRoot, 'noisy-leak')

    await teardown()

    expect(errorSpy).toHaveBeenCalled()
    const allCalls = errorSpy.mock.calls.flat().join(' ')
    expect(allCalls).toContain('7-3')
    expect(allCalls).toContain('noisy-leak')
    expect(allCalls).toContain('LEAK DETECTED')
  })

  it('AC5d: process.exitCode is set to 1 when leaks are detected (suite gate)', async () => {
    // Tightened-gate behavior: leak detection now fails the suite via
    // process.exitCode. Vitest globalSetup teardown can't throw to
    // affect the run outcome (timing-wise too late), but the exit code
    // propagates when Node finally exits.
    expect(process.exitCode).toBeFalsy() // baseline: no exit code set

    const { default: setup } = await import('./global-setup.ts')
    const teardown = setup()

    createWorktree(repoRoot, 'gate-test-leak')

    await teardown()

    expect(process.exitCode).toBe(1)
  })

  it('AC5e: process.exitCode is NOT set when no leaks are detected (clean run)', async () => {
    expect(process.exitCode).toBeFalsy()

    const { default: setup } = await import('./global-setup.ts')
    const teardown = setup()
    // no leaks during "the suite"
    await teardown()

    expect(process.exitCode).toBeFalsy()
  })

  it('AC5b: orphan `substrate/story-*` branch (no associated worktree) is deleted at setup-start', async () => {
    // Reproduces the failure mode observed post-3ec3225: a prior test
    // created a worktree, then `git worktree prune` cleaned the gitdir
    // record but left the `substrate/story-X` branch behind. Each
    // subsequent `npm test` run preserved the orphan branch because
    // teardown only iterates leaks detected mid-suite, not orphan state.
    // Setup-start orphan-branch cleanup catches this.
    //
    // Create an orphan: worktree + branch, then prune the worktree (not
    // via `worktree remove` — that would also delete the branch).
    createWorktree(repoRoot, 'orphan-branch-test')
    rmSync(join(repoRoot, '.substrate-worktrees', 'orphan-branch-test'), {
      recursive: true,
      force: true,
    })
    execSync('git worktree prune', { cwd: repoRoot })
    // Verify the worktree is gone but the branch persists
    const wtAfterPrune = execSync('git worktree list', { cwd: repoRoot, encoding: 'utf-8' })
    expect(wtAfterPrune).not.toContain('orphan-branch-test')
    const branchesBefore = execSync('git branch', { cwd: repoRoot, encoding: 'utf-8' })
    expect(branchesBefore).toContain('substrate/story-orphan-branch-test')

    const { default: setup } = await import('./global-setup.ts')
    setup()

    // After setup, the orphan branch should be deleted
    const branchesAfter = execSync('git branch', { cwd: repoRoot, encoding: 'utf-8' })
    expect(branchesAfter).not.toContain('substrate/story-orphan-branch-test')
  })

  it('AC5c: `substrate/story-*` branches WITH an associated worktree are preserved at setup-start', async () => {
    // The orphan-cleanup must not delete branches for live worktrees.
    // Operator-active dispatches should survive `npm test`.
    createWorktree(repoRoot, 'live-dispatch')

    const { default: setup } = await import('./global-setup.ts')
    setup()

    // The live worktree's branch must still exist
    const branches = execSync('git branch', { cwd: repoRoot, encoding: 'utf-8' })
    expect(branches).toContain('substrate/story-live-dispatch')
    const worktrees = execSync('git worktree list', { cwd: repoRoot, encoding: 'utf-8' })
    expect(worktrees).toContain('.substrate-worktrees/live-dispatch')
  })

  it('AC6: no warn emitted when no leaks are detected (clean run is silent)', async () => {
    const warnSpy = vi.mocked(console.warn)

    const { default: setup } = await import('./global-setup.ts')
    const teardown = setup()

    // No worktrees created during "the suite"

    await teardown()

    // The "Could not snapshot" warning fires only on failure; the
    // "Detected N leaked" warning fires only on leaks. Neither should
    // fire on a clean run.
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
