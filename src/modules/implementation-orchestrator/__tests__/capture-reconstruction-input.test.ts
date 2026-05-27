/**
 * Unit tests for captureReconstructionInput (obs_2026-05-26_027).
 *
 * The orchestrator captures the reconstruction phase-input (the story file the
 * producing phase consumed) at auto-commit time — the last point before the
 * per-story worktree is torn down. It copies the file to a durable sidecar
 * under the run manifest's directory and records its path + SHA-256 so the
 * Story 77-8 harness can recover the input even when the consumer repo does
 * not git-track story artifacts (the strata-5-2 gap). The orchestrator call
 * site is deep in the worktree/merge path, so the logic is extracted here and
 * tested directly against real temp files (no mocks — the actual fs write path
 * is exercised).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { captureReconstructionInput } from '../orchestrator-impl.js'

describe('captureReconstructionInput', () => {
  let root: string
  let projectRoot: string
  let runsDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'capture-input-'))
    projectRoot = join(root, 'project')
    runsDir = join(projectRoot, '.substrate', 'runs')
    mkdirSync(join(projectRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true })
    mkdirSync(runsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeStory(content: string): string {
    const p = join(projectRoot, '_bmad-output', 'implementation-artifacts', '5-2-briefing.md')
    writeFileSync(p, content)
    return p
  }

  it('copies the story file to a sidecar and returns path + relative location + sha256', () => {
    const content = '# Story 5-2\n\n## Acceptance Criteria\nAC1: brief the manager.\n'
    const storyFilePath = writeStory(content)

    const out = captureReconstructionInput(storyFilePath, '5-2', runsDir, 'run-abc', projectRoot)

    // Returned fields.
    expect(out.story_file_input_path).toBe(join('inputs', 'run-abc', '5-2.md'))
    expect(out.story_file).toBe('_bmad-output/implementation-artifacts/5-2-briefing.md')
    expect(out.story_file_sha256).toBe(createHash('sha256').update(content).digest('hex'))

    // Sidecar actually written under the runs dir, with identical content.
    const sidecar = join(runsDir, out.story_file_input_path)
    expect(existsSync(sidecar)).toBe(true)
    expect(readFileSync(sidecar, 'utf-8')).toBe(content)
  })

  it('records story_file relative to effectiveProjectRoot (worktree-relative path)', () => {
    // Simulate a worktree checkout: effectiveProjectRoot is the worktree, the
    // story file lives under it. The recorded path must be repo-relative.
    const worktree = join(root, 'wt')
    mkdirSync(join(worktree, '_bmad-output', 'implementation-artifacts'), { recursive: true })
    const wtStory = join(worktree, '_bmad-output', 'implementation-artifacts', '5-2-briefing.md')
    writeFileSync(wtStory, 'wt content')

    const out = captureReconstructionInput(wtStory, '5-2', runsDir, 'run-abc', worktree)
    expect(out.story_file).toBe('_bmad-output/implementation-artifacts/5-2-briefing.md')
  })

  it('falls back to basename when the story file is outside effectiveProjectRoot', () => {
    const storyFilePath = writeStory('x')
    const out = captureReconstructionInput(storyFilePath, '5-2', runsDir, 'run-abc', '/some/unrelated/root')
    expect(out.story_file).toBe('5-2-briefing.md')
  })

  it('creates the sidecar directory tree if it does not exist yet', () => {
    const storyFilePath = writeStory('content')
    // runsDir exists but inputs/<run> does not.
    expect(existsSync(join(runsDir, 'inputs'))).toBe(false)
    captureReconstructionInput(storyFilePath, '5-2', runsDir, 'fresh-run', projectRoot)
    expect(existsSync(join(runsDir, 'inputs', 'fresh-run', '5-2.md'))).toBe(true)
  })

  it('throws when the story file cannot be read (caller treats capture as best-effort)', () => {
    expect(() =>
      captureReconstructionInput(join(projectRoot, 'does-not-exist.md'), '5-2', runsDir, 'run-abc', projectRoot),
    ).toThrow()
  })
})
