/**
 * H4.4: worktree-path conformance — no NEW direct-fs worktree access.
 *
 * All worktree path construction must flow through
 * `GitWorktreeManager.getWorktreePath()` / `resolveWorktreeBaseDirectory()`,
 * so a future container backend can bind-mount ONE enumerable surface
 * (see docs/2026-07-06-container-execution-seam.md). This suite pins the
 * files that may mention the legacy `.substrate-worktrees` literal; a new
 * hardcode anywhere else fails here with instructions.
 *
 * If your change legitimately belongs on the allow-list (docs text, the
 * resolver itself, a deny-list entry), add the file below WITH a comment
 * saying why. If you're constructing a worktree path — don't: use the
 * manager.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Files allowed to contain the `.substrate-worktrees` literal, with cause. */
const ALLOWED = new Set([
  // The resolver + manager: the canonical construction sites.
  'packages/core/src/git/git-utils.ts',
  'packages/core/src/git/git-worktree-manager-impl.ts',
  // Interface/JSDoc + config schema docs: text, not path construction.
  'packages/core/src/git/git-worktree-manager.ts',
  'packages/core/src/config/types.ts',
  'src/modules/config/config-schema.ts',
  'src/cli/commands/help-agent.ts',
  'src/cli/commands/run.ts',
  // Commit denylist: excludes worktree droppings from commits (a deny rule,
  // not a path construction).
  'src/modules/compiled-workflows/git-helpers.ts',
])

describe('H4.4: worktree path conformance', () => {
  it('no .substrate-worktrees literal outside the enumerated allow-list', () => {
    let out = ''
    try {
      out = execFileSync(
        'git',
        ['grep', '-l', '.substrate-worktrees', '--', 'src/**/*.ts', 'packages/*/src/**/*.ts'],
        { cwd: REPO, encoding: 'utf-8' },
      )
    } catch (err) {
      // git grep exits 1 when nothing matches — that's a pass.
      const e = err as { status?: number; stdout?: string }
      if (e.status === 1) return
      throw err
    }
    const offenders = out
      .split('\n')
      .filter((f) => f.trim().length > 0)
      .filter((f) => !f.includes('__tests__') && !f.endsWith('.test.ts'))
      .filter((f) => !ALLOWED.has(f))
    expect(
      offenders,
      `new direct .substrate-worktrees reference(s) — use GitWorktreeManager.getWorktreePath()/resolveWorktreeBaseDirectory() instead, or add to the allow-list with a cause: ${offenders.join(', ')}`,
    ).toEqual([])
  })
})
