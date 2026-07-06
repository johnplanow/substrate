/**
 * H4.2 (AC2): resolveWorktreeBaseDirectory — worktree base selection.
 *
 * 'external' (default): ~/.substrate/worktrees/<projectname>-<hash8>/ —
 * outside the parent tree, so an agent inside its worktree has no repo above
 * it to leak into. 'in-repo': the pre-H4.2 <projectRoot>/.substrate-worktrees/.
 * The resolver reads `worktree.base` from .substrate/config.yaml directly so
 * EVERY manager construction site resolves identically without threading.
 *
 * Uses real tmp directories — no mocks — because the config-read fallback
 * chain is exactly what needs proving.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import * as path from 'node:path'
import { resolveWorktreeBaseDirectory } from '../git-worktree-manager-impl.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'h42-resolver-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveWorktreeBaseDirectory (H4.2 AC2)', () => {
  it('defaults to an external base under ~/.substrate/worktrees/<name>-<hash8>', () => {
    const base = resolveWorktreeBaseDirectory(root)

    expect(path.isAbsolute(base)).toBe(true)
    expect(base.startsWith(path.join(homedir(), '.substrate', 'worktrees'))).toBe(true)
    expect(path.basename(base)).toMatch(new RegExp(`^${path.basename(root)}-[0-9a-f]{8}$`))
    // The external base must NOT live inside the project tree.
    expect(base.startsWith(root + path.sep)).toBe(false)
  })

  it('is deterministic per project and distinct across projects', () => {
    const other = mkdtempSync(path.join(tmpdir(), 'h42-resolver-other-'))
    try {
      expect(resolveWorktreeBaseDirectory(root)).toBe(resolveWorktreeBaseDirectory(root))
      expect(resolveWorktreeBaseDirectory(root)).not.toBe(resolveWorktreeBaseDirectory(other))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('explicit in-repo override returns the legacy relative base', () => {
    expect(resolveWorktreeBaseDirectory(root, 'in-repo')).toBe('.substrate-worktrees')
  })

  it('honors worktree.base: in-repo from .substrate/config.yaml', () => {
    mkdirSync(path.join(root, '.substrate'), { recursive: true })
    writeFileSync(path.join(root, '.substrate', 'config.yaml'), 'worktree:\n  base: in-repo\n')

    expect(resolveWorktreeBaseDirectory(root)).toBe('.substrate-worktrees')
  })

  it('honors worktree.base: external from .substrate/config.yaml', () => {
    mkdirSync(path.join(root, '.substrate'), { recursive: true })
    writeFileSync(path.join(root, '.substrate', 'config.yaml'), 'worktree:\n  base: external\n')

    expect(path.isAbsolute(resolveWorktreeBaseDirectory(root))).toBe(true)
  })

  it('explicit override beats the config file', () => {
    mkdirSync(path.join(root, '.substrate'), { recursive: true })
    writeFileSync(path.join(root, '.substrate', 'config.yaml'), 'worktree:\n  base: external\n')

    expect(resolveWorktreeBaseDirectory(root, 'in-repo')).toBe('.substrate-worktrees')
  })

  it('ignores an unreadable or invalid config (falls back to external)', () => {
    mkdirSync(path.join(root, '.substrate'), { recursive: true })
    writeFileSync(path.join(root, '.substrate', 'config.yaml'), '{invalid yaml:::')

    expect(path.isAbsolute(resolveWorktreeBaseDirectory(root))).toBe(true)
  })
})
