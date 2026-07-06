/**
 * H5.5 (story-artifact resilience): recoverStoryFileFromBranch against a REAL
 * git repo — the live-smoke incident shape (2026-07-06): a fix-phase agent
 * deleted the committed story artifact from the working tree; the artifact
 * was safely in the H0.1 feat commit the whole time. Recovery must read it
 * from branch HEAD and restore it to the working tree.
 *
 * Real tmp repos (no mocks) — the git interaction IS the contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recoverStoryFileFromBranch } from '../git-helpers.js'

let repo: string

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: repo, encoding: 'utf-8' })
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'h55-recover-'))
  git('init -q -b main')
  git('config user.email t@t && git config user.name t')
  mkdirSync(join(repo, '_bmad-output', 'implementation-artifacts'), { recursive: true })
  writeFileSync(join(repo, '_bmad-output', 'implementation-artifacts', '1-1-story.md'), '# Story 1-1\n\nACs here\n')
  git('add -A')
  git('commit -qm "feat(story-1-1): story artifact committed"')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('recoverStoryFileFromBranch (H5.5)', () => {
  it('recovers a deleted story file from branch HEAD and restores it to the working tree', async () => {
    const rel = join('_bmad-output', 'implementation-artifacts', '1-1-story.md')
    rmSync(join(repo, rel))
    expect(existsSync(join(repo, rel))).toBe(false)

    const content = await recoverStoryFileFromBranch(rel, repo)

    expect(content).toContain('# Story 1-1')
    // Restored for downstream phases, not just returned.
    expect(existsSync(join(repo, rel))).toBe(true)
    expect(readFileSync(join(repo, rel), 'utf-8')).toContain('ACs here')
  })

  it('accepts an absolute path inside the worktree', async () => {
    const abs = join(repo, '_bmad-output', 'implementation-artifacts', '1-1-story.md')
    rmSync(abs)

    const content = await recoverStoryFileFromBranch(abs, repo)

    expect(content).toContain('# Story 1-1')
  })

  it('returns undefined when the file was never committed (gone from HEAD too)', async () => {
    const content = await recoverStoryFileFromBranch('_bmad-output/implementation-artifacts/9-9-story.md', repo)

    expect(content).toBeUndefined()
  })

  it('refuses paths outside the worktree (containment, mirrors H1.8)', async () => {
    const content = await recoverStoryFileFromBranch('/etc/passwd', repo)

    expect(content).toBeUndefined()
  })
})
