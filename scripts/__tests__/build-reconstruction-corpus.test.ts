/**
 * Unit tests for scripts/build-reconstruction-corpus.mjs (Story 77-6).
 *
 * Exercises the pure census helpers with in-memory fixtures — no git, no FS,
 * no Dolt. The load-bearing assertion is that correlation reads the REAL manifest
 * shape `per_story_state[key].commit_sha` (F-commitsha), not the `stories[key]`
 * shape the first 77-6 dispatch wrongly assumed (which produced 0 pairs).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// @ts-expect-error — importing JS module from TS test (vitest handles the cross-load)
import {
  isAutoCommitSubject,
  extractStoryKey,
  findCorrelatingManifest,
  determinePhase,
  parseGitLog,
  censusRepo,
  resolvePhaseInput,
  EXCLUDED_STATUS,
} from '../build-reconstruction-corpus.mjs'

describe('isAutoCommitSubject / extractStoryKey', () => {
  it('matches a substrate dev-story auto-commit subject', () => {
    expect(isAutoCommitSubject('feat(story-10-2): implement the thing')).toBe(true)
    expect(extractStoryKey('feat(story-10-2): implement the thing')).toBe('10-2')
  })

  it('matches a story key with a letter suffix', () => {
    expect(isAutoCommitSubject('feat(story-41-6b): extraction phase 2')).toBe(true)
    expect(extractStoryKey('feat(story-41-6b): extraction phase 2')).toBe('41-6b')
  })

  it('does not match non-auto-commit subjects', () => {
    expect(isAutoCommitSubject('fix(work-graph): something')).toBe(false)
    expect(isAutoCommitSubject('feat(report): low-output flag')).toBe(false)
    expect(extractStoryKey('chore: bump version')).toBeNull()
  })
})

describe('findCorrelatingManifest — reads per_story_state[key].commit_sha (F-commitsha)', () => {
  const manifests = [
    {
      runId: 'run-A',
      raw: {
        per_story_state: {
          '10-2': { status: 'complete', phase: 'COMPLETE', commit_sha: 'abc123' },
        },
      },
    },
  ]

  it('correlates when per_story_state[key].commit_sha matches the commit SHA', () => {
    const r = findCorrelatingManifest(manifests, '10-2', 'abc123')
    expect(r).not.toBeNull()
    expect(r.runId).toBe('run-A')
    expect(r.storyEntry.commit_sha).toBe('abc123')
  })

  it('does NOT correlate on a SHA mismatch', () => {
    expect(findCorrelatingManifest(manifests, '10-2', 'wrong-sha')).toBeNull()
  })

  it('regression (run1 bug): does NOT read the non-existent stories[key].commit_sha shape', () => {
    // The first 77-6 dispatch read raw.stories[key].commit_sha — a shape that never
    // exists in real manifests. A manifest carrying ONLY that shape must NOT correlate.
    const wrongShape = [
      { runId: 'run-B', raw: { stories: { '10-2': { status: 'complete', commit_sha: 'abc123' } } } },
    ]
    expect(findCorrelatingManifest(wrongShape, '10-2', 'abc123')).toBeNull()
  })

  it('excludes still-running/dispatched manifests', () => {
    for (const status of EXCLUDED_STATUS) {
      const inflight = [
        { runId: 'run-C', raw: { per_story_state: { '10-2': { status, commit_sha: 'abc123' } } } },
      ]
      expect(findCorrelatingManifest(inflight, '10-2', 'abc123')).toBeNull()
    }
  })

  it('returns null when the story key is absent from per_story_state', () => {
    expect(findCorrelatingManifest(manifests, '99-9', 'abc123')).toBeNull()
  })
})

describe('determinePhase', () => {
  it('returns dev-story (substrate auto-commits dev-story output)', () => {
    expect(determinePhase({ phase: 'COMPLETE' })).toBe('dev-story')
    expect(determinePhase({})).toBe('dev-story')
  })
})

describe('parseGitLog', () => {
  it('parses commit records separated by the sentinel', () => {
    const stdout = [
      'sha1 feat(story-1-1): alpha',
      'body line',
      '---END-COMMIT-77-6---',
      'sha2 chore: bump',
      '---END-COMMIT-77-6---',
    ].join('\n')
    const records = parseGitLog(stdout)
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual({ sha: 'sha1', subject: 'feat(story-1-1): alpha' })
    expect(records[1]).toEqual({ sha: 'sha2', subject: 'chore: bump' })
  })

  it('returns [] for empty output', () => {
    expect(parseGitLog('')).toEqual([])
  })
})

describe('censusRepo (fully injected I/O — no real git/FS)', () => {
  const gitLogStdout = [
    'shaAuto feat(story-5-1): real auto-commit',
    '---END-COMMIT-77-6---',
    'shaHand feat(story-5-2): hand-built, no manifest record',
    '---END-COMMIT-77-6---',
    'shaChore chore: bump version',
    '---END-COMMIT-77-6---',
  ].join('\n')
  const manifests = [
    { runId: 'run-X', raw: { per_story_state: { '5-1': { status: 'complete', commit_sha: 'shaAuto' } } } },
    // 5-2 has NO manifest recording shaHand → excluded as hand-built.
  ]
  const resolveParentFn = (_repo: string, sha: string) => `${sha}-parent`
  const findStoryFileFn = (_repo: string, _parent: string, key: string) =>
    `_bmad-output/implementation-artifacts/${key}-x.md`

  it('emits exactly one clean triple — the correlated auto-commit (excludes hand-built + chore)', () => {
    const { triples, cleanCount } = censusRepo('/fake/repo', {
      gitLogStdout,
      manifests,
      resolveParentFn,
      findStoryFileFn,
    })
    expect(cleanCount).toBe(1)
    expect(triples[0]).toMatchObject({
      repo: '/fake/repo',
      story_key: '5-1',
      phase: 'dev-story',
      commit_sha: 'shaAuto',
      parent_sha: 'shaAuto-parent',
      run_id: 'run-X',
      story_file: '_bmad-output/implementation-artifacts/5-1-x.md',
    })
  })

  it('drops a correlated commit whose parent cannot be resolved', () => {
    const { cleanCount } = censusRepo('/fake/repo', {
      gitLogStdout,
      manifests,
      resolveParentFn: () => null,
      findStoryFileFn,
    })
    expect(cleanCount).toBe(0)
  })

  it('omits story_file when none is found at the parent', () => {
    const { triples } = censusRepo('/fake/repo', {
      gitLogStdout,
      manifests,
      resolveParentFn,
      findStoryFileFn: () => null,
    })
    expect(triples[0].story_file).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolvePhaseInput (obs_2026-05-26_027) — manifest sidecar preferred over git
// ---------------------------------------------------------------------------

describe('resolvePhaseInput — prefers manifest sidecar over git recovery', () => {
  let runsDir: string

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'recon-census-'))
  })
  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true })
  })

  const gitFinder = (_repo: string, _parent: string, key: string) =>
    `_bmad-output/implementation-artifacts/${key}-x.md`

  it('uses the manifest sidecar (input_path + sha256) when the captured file exists', () => {
    // Materialize the sidecar the orchestrator would have written.
    const rel = join('inputs', 'run-X', '5-1.md')
    const abs = join(runsDir, rel)
    mkdirSync(join(runsDir, 'inputs', 'run-X'), { recursive: true })
    writeFileSync(abs, '# Story 5-1 input')

    const storyEntry = {
      story_file: '_bmad-output/implementation-artifacts/5-1-feature.md',
      story_file_input_path: rel,
      story_file_sha256: 'deadbeef',
    }
    const out = resolvePhaseInput(storyEntry, runsDir, '/repo', 'parentsha', '5-1', gitFinder)

    expect(out.story_file_source).toBe('manifest')
    expect(out.input_path).toBe(abs)
    expect(out.story_file).toBe('_bmad-output/implementation-artifacts/5-1-feature.md')
    expect(out.story_file_sha256).toBe('deadbeef')
  })

  it('falls back to git recovery when the manifest records a path but the sidecar is missing', () => {
    const storyEntry = { story_file_input_path: join('inputs', 'run-X', 'gone.md') } // file not created
    const out = resolvePhaseInput(storyEntry, runsDir, '/repo', 'parentsha', '5-1', gitFinder)

    expect(out.story_file_source).toBe('git')
    expect(out.input_path).toBeUndefined()
    expect(out.story_file).toBe('_bmad-output/implementation-artifacts/5-1-x.md')
  })

  it('uses git recovery when the manifest has no captured input (pre-fix run)', () => {
    const out = resolvePhaseInput({ status: 'complete', commit_sha: 'abc' }, runsDir, '/repo', 'parentsha', '5-1', gitFinder)
    expect(out.story_file_source).toBe('git')
    expect(out.story_file).toBe('_bmad-output/implementation-artifacts/5-1-x.md')
  })

  it('returns no input fields when neither manifest nor git can supply one', () => {
    const out = resolvePhaseInput({}, runsDir, '/repo', 'parentsha', '5-1', () => null)
    expect(out).toEqual({})
  })
})
