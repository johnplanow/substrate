/**
 * v0.20.109: Unit tests for `copyFilesToWorktree` + the richer
 * "already registered" error format. These exercise real filesystem I/O
 * (via tmpdir) — no git subprocess involvement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { copyFilesToWorktree } from '../git-utils.js'

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
