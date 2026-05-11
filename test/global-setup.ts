/**
 * Vitest globalSetup — runs once before all tests, returns a teardown
 * function that runs once after the entire suite (across all forks).
 *
 * Purpose: defensive cleanup of `.substrate-worktrees/*` entries created
 * during the test run. Some tests exercise code paths that bypass the
 * `gitUtils` mock and call real `git worktree add` against the project
 * root, leaving stale worktrees + branches behind. Manual cleanup after
 * every `npm test` was friction the operator absorbed for weeks.
 *
 * Strategy:
 *   1. Snapshot the `.substrate-worktrees/` entries that exist BEFORE
 *      tests run. These are operator-created worktrees and MUST be
 *      preserved.
 *   2. After tests complete, list `.substrate-worktrees/` again and
 *      identify entries NOT in the snapshot. These are test-created
 *      leaks.
 *   3. Remove each leaked worktree via `git worktree remove --force`,
 *      then `git branch -D substrate/story-<entry>`. Best-effort:
 *      failures log warn but don't break the suite.
 *   4. If any leaks were found, emit a warning naming them — helps
 *      identify which test is leaking so we can add proper `afterAll`
 *      cleanup at the source.
 *
 * This is intentionally a SAFETY NET, not the primary fix. Tests that
 * create worktrees SHOULD clean up in their own `afterAll`. This file
 * exists so a missed cleanup doesn't leave the repo dirty.
 *
 * Authored 2026-05-11 per BMAD party-mode review of the recurring
 * `.substrate-worktrees/0-1` pollution observed throughout the v0.20.86–
 * v0.20.88 ship arc.
 */

import { execSync } from 'node:child_process'
import { join } from 'node:path'

const WORKTREES_DIR = '.substrate-worktrees'
const BRANCH_PREFIX = 'substrate/story-'

interface WorktreeSnapshot {
  /** Set of taskIds (extracted from `.substrate-worktrees/<taskId>` paths) */
  readonly taskIds: ReadonlySet<string>
  readonly tookSnapshot: boolean
}

/**
 * Snapshot the current set of worktree taskIds from `git worktree list
 * --porcelain`. This sees BOTH:
 *   - real directories under `.substrate-worktrees/<taskId>/`
 *   - prunable entries (git metadata for a worktree whose dir was
 *     already removed but `git worktree prune` was never run)
 *
 * Using `readdirSync(.substrate-worktrees)` would miss the prunable
 * case — which is exactly the leak class we keep seeing: a test deletes
 * the worktree dir directly but doesn't tell git, so the gitdir record
 * persists. Empirically verified 2026-05-11: `npm test` produces a
 * prunable `0-1` entry with NO directory under `.substrate-worktrees/`,
 * so a readdir-based snapshot reports no leaks while `git worktree
 * list` still shows the stale entry.
 */
function snapshot(projectRoot: string): WorktreeSnapshot {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    })
    const taskIds = new Set<string>()
    // Each worktree entry starts with `worktree <path>` followed by
    // optional metadata lines and a blank line separator.
    for (const line of output.split('\n')) {
      if (!line.startsWith('worktree ')) continue
      const path = line.slice('worktree '.length)
      // Match `.../.substrate-worktrees/<taskId>` (with platform-tolerant
      // separator). Reject paths NOT under .substrate-worktrees/ — those
      // are the operator's main worktree or unrelated worktrees.
      const marker = `${WORKTREES_DIR}/`
      const idx = path.lastIndexOf(marker)
      if (idx === -1) continue
      const taskId = path.slice(idx + marker.length)
      if (taskId.length > 0 && !taskId.includes('/')) {
        taskIds.add(taskId)
      }
    }
    return { taskIds, tookSnapshot: true }
  } catch {
    // Not in a git repo, git unavailable, or other unexpected failure.
    return { taskIds: new Set(), tookSnapshot: false }
  }
}

function postTestLeaks(projectRoot: string, preSnapshot: WorktreeSnapshot): string[] {
  const after = snapshot(projectRoot)
  if (!after.tookSnapshot) return []
  return [...after.taskIds].filter((id) => !preSnapshot.taskIds.has(id))
}

function removeLeakedWorktree(taskId: string, projectRoot: string): void {
  const wtPath = join(projectRoot, WORKTREES_DIR, taskId)
  // `git worktree remove --force` cleans up directory + gitdir record
  // for worktrees that still have a directory. For prunable entries
  // (directory already deleted but gitdir record stale), remove errors
  // — the unconditional `prune` below handles that case.
  try {
    execSync(`git worktree remove --force ${JSON.stringify(wtPath)}`, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    })
  } catch {
    // Fall through — prune below catches prunable entries.
  }
  // Always prune. Cheap (no-op when nothing to prune), and the only way
  // to clean up stale gitdir metadata when the directory was deleted
  // directly without going through `git worktree remove`.
  try {
    execSync('git worktree prune', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    })
  } catch {
    // Best-effort.
  }
  // Delete the associated branch (best-effort — may not exist)
  try {
    execSync(`git branch -D ${JSON.stringify(BRANCH_PREFIX + taskId)}`, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    })
  } catch {
    // Branch doesn't exist — already cleaned up or never created
  }
}

export default function setup(): () => Promise<void> {
  const projectRoot = process.cwd()

  // Sweep any pre-existing prunable worktree entries BEFORE snapshotting.
  // Prunable entries are stale-by-definition (gitdir record persists for
  // a worktree whose directory was already deleted); cleaning them is
  // always safe. Without this sweep, leaks accumulated from PRIOR test
  // runs would be baked into the snapshot and survive every subsequent
  // run — exactly what was observed empirically (the `0-1` pollution
  // recurred across many sessions despite repeated manual cleanup).
  try {
    execSync('git worktree prune', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    })
  } catch {
    // Best-effort. If prune fails, the snapshot may include stale
    // entries — the diff still catches NEW leaks, just not pre-existing.
  }

  const pre = snapshot(projectRoot)

  if (!pre.tookSnapshot) {
    // eslint-disable-next-line no-console
    console.warn(
      '[test:global-setup] Could not snapshot `git worktree list` output — post-test cleanup will be skipped.',
    )
  }

  return async () => {
    if (!pre.tookSnapshot) return

    const leaks = postTestLeaks(projectRoot, pre)
    if (leaks.length === 0) return

    // eslint-disable-next-line no-console
    console.warn(
      `[test:global-setup] Detected ${leaks.length} leaked worktree(s) — cleaning up. Suspects: ${leaks.join(', ')}. ` +
      'If the same leak recurs, add an explicit afterAll cleanup in the offending test file.',
    )

    for (const leak of leaks) {
      removeLeakedWorktree(leak, projectRoot)
    }
  }
}
