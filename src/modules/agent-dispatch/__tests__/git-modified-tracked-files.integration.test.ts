/**
 * H7 (commit-blinds-tripwire, red-team): checkGitModifiedTrackedFiles against a
 * REAL git repo. The reward-hack tripwire (TestMutationCheck) consumes this
 * function's output; if it only looked at the working-tree/index delta vs HEAD,
 * an agent could `git commit` its gutted test and leave both diffs empty —
 * blinding the tripwire. The baseline param must surface committed
 * modifications of pre-existing tracked files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkGitModifiedTrackedFiles } from '../dispatcher-impl.js'

let repo: string
function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: repo, encoding: 'utf-8' })
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'h7-tripwire-'))
  git('init -q -b main')
  git('config user.email t@t && git config user.name t')
  writeFileSync(join(repo, 'test_ledger.py'), 'def test_total():\n    assert compute() == 100\n')
  git('add -A')
  git('commit -qm baseline')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('checkGitModifiedTrackedFiles baseline range (H7)', () => {
  it('surfaces a tracked-test edit that was COMMITTED (working-tree delta is empty)', () => {
    const baseline = git('rev-parse HEAD').trim()
    // Agent guts the assertion, then commits — hiding it from `git diff HEAD`.
    writeFileSync(join(repo, 'test_ledger.py'), 'def test_total():\n    assert True\n')
    git('add -A')
    git('commit -qm "impl story"')

    // Without baseline: blind (working tree is clean post-commit).
    expect(checkGitModifiedTrackedFiles(repo)).toEqual([])
    // With baseline: the committed modification is surfaced.
    expect(checkGitModifiedTrackedFiles(repo, baseline)).toContain('test_ledger.py')
  })

  it('surfaces a committed DELETION of a pre-existing tracked file', () => {
    const baseline = git('rev-parse HEAD').trim()
    git('rm -q test_ledger.py')
    git('commit -qm "removed test"')

    expect(checkGitModifiedTrackedFiles(repo, baseline)).toContain('test_ledger.py')
  })

  it('H7 review (bug_002): surfaces a committed RENAME of a tracked test out of the discovery path', () => {
    const baseline = git('rev-parse HEAD').trim()
    git('mv test_ledger.py legacy_test_ledger.py')
    git('commit -qm "rename test out of discovery"')

    // MDR filter includes renames — the moved test must be visible to the tripwire.
    const result = checkGitModifiedTrackedFiles(repo, baseline)
    expect(result.some((f) => f.includes('test_ledger.py'))).toBe(true)
  })

  it('does NOT surface a newly ADDED file as a modification', () => {
    const baseline = git('rev-parse HEAD').trim()
    writeFileSync(join(repo, 'new_impl.py'), 'x = 1\n')
    git('add -A')
    git('commit -qm "new file"')

    // --diff-filter=MD excludes additions — new files are not "modifications".
    expect(checkGitModifiedTrackedFiles(repo, baseline)).not.toContain('new_impl.py')
  })

  it('still catches uncommitted working-tree edits (no baseline needed)', () => {
    writeFileSync(join(repo, 'test_ledger.py'), 'def test_total():\n    assert False\n')
    expect(checkGitModifiedTrackedFiles(repo)).toContain('test_ledger.py')
  })
})
