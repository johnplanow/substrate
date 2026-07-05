/**
 * v0.20.109: Unit tests for `copyFilesToWorktree` + the richer
 * "already registered" error format. These exercise real filesystem I/O
 * (via tmpdir) — no git subprocess involvement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { copyFilesToWorktree, decideWorktreeReclaim, decideWorktreeRemoval } from '../git-utils.js'

describe('decideWorktreeReclaim', () => {
  it('is safe to reclaim a clean worktree with no commits beyond base', () => {
    // The common case: a failed create-story (e.g. Codex write-block) left an
    // empty, clean worktree — re-running should reclaim it, not hard-error.
    expect(decideWorktreeReclaim(false, 0, 'main')).toEqual({ safe: true })
  })

  it('refuses to reclaim when there are uncommitted changes (data-loss safety)', () => {
    const d = decideWorktreeReclaim(true, 0, 'main')
    expect(d.safe).toBe(false)
    expect(d.reason).toMatch(/uncommitted changes/i)
  })

  it('refuses to reclaim when the branch has commits beyond base', () => {
    const d = decideWorktreeReclaim(false, 2, 'main')
    expect(d.safe).toBe(false)
    expect(d.reason).toContain('2 commit(s) beyond main')
  })

  it('refuses to reclaim when the ahead-count could not be determined', () => {
    const d = decideWorktreeReclaim(false, -1, 'main')
    expect(d.safe).toBe(false)
    expect(d.reason).toMatch(/could not be verified/i)
  })

  it('uncommitted changes take precedence over commit count in the reason', () => {
    const d = decideWorktreeReclaim(true, 5, 'develop')
    expect(d.safe).toBe(false)
    expect(d.reason).toMatch(/uncommitted changes/i)
  })
})

describe('decideWorktreeRemoval (H0.3 — dirty-guard on cleanup)', () => {
  it('safe when clean and branch fully merged', () => {
    expect(decideWorktreeRemoval(false, [], 0, 'substrate/story-1-1')).toEqual({ safe: true, reasons: [] })
  })

  it('unsafe with uncommitted changes — names the files that would be destroyed', () => {
    const d = decideWorktreeRemoval(true, ['src/a.py', 'tests/test_a.py'], 0, 'substrate/story-4-3')
    expect(d.safe).toBe(false)
    expect(d.reasons[0]).toContain('2 uncommitted change(s)')
    expect(d.reasons[0]).toContain('src/a.py')
  })

  it('caps the uncommitted-file preview at 10 and counts the rest', () => {
    const files = Array.from({ length: 14 }, (_, i) => `f${String(i)}.py`)
    const d = decideWorktreeRemoval(true, files, 0, 'substrate/story-4-3')
    expect(d.reasons[0]).toContain('(+4 more)')
  })

  it('unsafe when the branch carries unmerged commits (wip checkpoints live here)', () => {
    const d = decideWorktreeRemoval(false, [], 2, 'substrate/story-5-1')
    expect(d.safe).toBe(false)
    expect(d.reasons[0]).toContain('2 commit(s) not reachable')
    expect(d.reasons[0]).toContain('substrate/story-5-1')
  })

  it('unsafe when branch state is unverifiable (negative count)', () => {
    const d = decideWorktreeRemoval(false, [], -1, 'substrate/story-9-9')
    expect(d.safe).toBe(false)
    expect(d.reasons[0]).toContain('could not be verified')
  })

  it('compounds reasons when both dirty AND unmerged', () => {
    const d = decideWorktreeRemoval(true, ['x.py'], 3, 'substrate/story-2-2')
    expect(d.safe).toBe(false)
    expect(d.reasons).toHaveLength(2)
  })
})

describe('copyFilesToWorktree (v0.20.109 Finding #3)', () => {
  let sourceRoot: string
  let worktreeRoot: string

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), 'substrate-copy-src-'))
    worktreeRoot = await mkdtemp(path.join(tmpdir(), 'substrate-copy-wt-'))
  })

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(worktreeRoot, { recursive: true, force: true })
  })

  it('copies a single .env file from source root to worktree', async () => {
    await writeFile(path.join(sourceRoot, '.env'), 'YNAB_PAT=secret\n')

    await copyFilesToWorktree(sourceRoot, worktreeRoot, ['.env'])

    const copied = await readFile(path.join(worktreeRoot, '.env'), 'utf-8')
    expect(copied).toBe('YNAB_PAT=secret\n')
  })

  it('copies multiple files when configured', async () => {
    await writeFile(path.join(sourceRoot, '.env'), 'A=1\n')
    await writeFile(path.join(sourceRoot, '.env.local'), 'B=2\n')

    await copyFilesToWorktree(sourceRoot, worktreeRoot, ['.env', '.env.local'])

    expect(await readFile(path.join(worktreeRoot, '.env'), 'utf-8')).toBe('A=1\n')
    expect(await readFile(path.join(worktreeRoot, '.env.local'), 'utf-8')).toBe('B=2\n')
  })

  it('skips missing source files silently (permissive default is safe)', async () => {
    await writeFile(path.join(sourceRoot, '.env'), 'present\n')
    // .env.local intentionally absent

    await expect(
      copyFilesToWorktree(sourceRoot, worktreeRoot, ['.env', '.env.local']),
    ).resolves.toBeUndefined()

    expect(await readFile(path.join(worktreeRoot, '.env'), 'utf-8')).toBe('present\n')
    await expect(access(path.join(worktreeRoot, '.env.local'))).rejects.toThrow()
  })

  it('no-op when files array is empty (default behavior)', async () => {
    await writeFile(path.join(sourceRoot, '.env'), 'should-not-copy\n')

    await copyFilesToWorktree(sourceRoot, worktreeRoot, [])

    await expect(access(path.join(worktreeRoot, '.env'))).rejects.toThrow()
  })

  it('creates parent directories for nested paths', async () => {
    await mkdir(path.join(sourceRoot, 'config'), { recursive: true })
    await writeFile(path.join(sourceRoot, 'config/.env'), 'nested\n')

    await copyFilesToWorktree(sourceRoot, worktreeRoot, ['config/.env'])

    expect(await readFile(path.join(worktreeRoot, 'config/.env'), 'utf-8')).toBe('nested\n')
  })

  it('rejects absolute paths to prevent host-file smuggling', async () => {
    // Even if a misconfigured config has `/etc/passwd`, this should be a no-op.
    await copyFilesToWorktree(sourceRoot, worktreeRoot, ['/etc/hostname'])

    // Nothing should land at the worktree's matching path
    await expect(access(path.join(worktreeRoot, 'etc/hostname'))).rejects.toThrow()
    await expect(access(path.join(worktreeRoot, '/etc/hostname'))).rejects.toThrow()
  })

  it('rejects parent-directory traversal', async () => {
    // Write a file outside sourceRoot that a copy_files: ['../escaped.txt']
    // misconfiguration could try to target. The contract is: the function
    // must not write anywhere under worktreeRoot derived from a `..` path.
    const outsidePath = path.join(sourceRoot, '..', `escaped-${Date.now()}.txt`)
    await writeFile(outsidePath, 'should-not-leak\n').catch(() => {/* ignore */})

    const outsideName = path.basename(outsidePath)
    await copyFilesToWorktree(sourceRoot, worktreeRoot, [`../${outsideName}`])

    // The file MUST NOT have been copied to worktreeRoot under any name
    await expect(access(path.join(worktreeRoot, outsideName))).rejects.toThrow()
    // And the function must have returned without throwing (silently skipped)

    // Cleanup
    await rm(outsidePath, { force: true }).catch(() => {/* ignore */})
  })
})
