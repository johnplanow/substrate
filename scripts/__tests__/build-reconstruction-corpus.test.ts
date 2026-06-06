/**
 * Unit tests for scripts/build-reconstruction-corpus.mjs (Story 77-6 / Story 81-8).
 *
 * Exercises the pure census helpers with in-memory fixtures — no git, no FS,
 * no Dolt. The load-bearing assertion is that correlation reads the REAL manifest
 * shape `per_story_state[key].commit_sha` (F-commitsha), not the `stories[key]`
 * shape the first 77-6 dispatch wrongly assumed (which produced 0 pairs).
 *
 * Story 81-8 additions: tests for deriveSource, resolveStoryFileInputPath,
 * and the shared-schema fields (id, source, story_file_input_path, expect)
 * emitted by censusRepo.
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
  deriveSource,
  resolveStoryFileInputPath,
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
  // Inject resolveStoryFileInputPathFn so the test doesn't require a real FS at /fake/repo.
  // Story 81-8: this dep is injectable to keep the corpus-logic tests self-contained.
  const resolveStoryFileInputPathFn = (_input: object, _repo: string, key: string) =>
    ({ path: `/mocked/${key}.md`, source: 'git' })

  it('emits exactly one clean triple — the correlated auto-commit (excludes hand-built + chore)', () => {
    const { triples, cleanCount } = censusRepo('/fake/repo', {
      gitLogStdout,
      manifests,
      resolveParentFn,
      findStoryFileFn,
      resolveStoryFileInputPathFn,
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
      resolveStoryFileInputPathFn,
    })
    expect(cleanCount).toBe(0)
  })

  it('omits story_file when none is found at the parent (resolvePhaseInput returns {})', () => {
    const { triples, cleanCount } = censusRepo('/fake/repo', {
      gitLogStdout,
      manifests,
      resolveParentFn,
      findStoryFileFn: () => null,
      resolveStoryFileInputPathFn,
    })
    // Triple is still included (resolveStoryFileInputPathFn returns a path).
    expect(cleanCount).toBe(1)
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

// ---------------------------------------------------------------------------
// deriveSource (Story 81-8) — maps repo path to source label
// ---------------------------------------------------------------------------

describe('deriveSource — maps repo path to canonical source label', () => {
  it('returns substrate-self for a path ending in /substrate', () => {
    expect(deriveSource('/home/user/code/substrate')).toBe('substrate-self')
    expect(deriveSource('/tmp/substrate')).toBe('substrate-self')
  })

  it('returns the basename for non-substrate repos', () => {
    expect(deriveSource('/home/user/code/ynab')).toBe('ynab')
    expect(deriveSource('/home/user/code/strata')).toBe('strata')
    expect(deriveSource('/home/user/code/agent-mesh')).toBe('agent-mesh')
  })

  it('returns unknown for a path with no basename', () => {
    expect(deriveSource('')).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// resolveStoryFileInputPath (Story 81-8, AC5) — unified story_file_input_path
// ---------------------------------------------------------------------------

describe('resolveStoryFileInputPath — resolves absolute path for pack-upgrade + reconstruction', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'recon-sfip-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('Priority 1: returns input_path (manifest sidecar) when present', () => {
    const abs = join(tmpDir, 'inputs', 'run-X', '5-1.md')
    mkdirSync(join(tmpDir, 'inputs', 'run-X'), { recursive: true })
    writeFileSync(abs, '# story')

    const result = resolveStoryFileInputPath({ input_path: abs }, tmpDir, '5-1')
    expect(result).not.toBeNull()
    expect(result.path).toBe(abs)
    expect(result.source).toBe('manifest')
  })

  it('Priority 2: returns git-recovered file when it exists on disk', () => {
    const storyFile = '_bmad-output/implementation-artifacts/5-1-x.md'
    const abs = join(tmpDir, storyFile)
    mkdirSync(join(tmpDir, '_bmad-output', 'implementation-artifacts'), { recursive: true })
    writeFileSync(abs, '# story')

    const result = resolveStoryFileInputPath({ story_file: storyFile }, tmpDir, '5-1')
    expect(result).not.toBeNull()
    expect(result.path).toBe(abs)
    expect(result.source).toBe('git')
  })

  it('Priority 2: falls through to checkout when git-recovered file is missing', () => {
    // git-recovered file does NOT exist on disk
    const storyFile = '_bmad-output/implementation-artifacts/5-1-gone.md'
    // Create a checkout fallback
    const checkoutFile = '5-1-checkout-fallback.md'
    const dir = join(tmpDir, '_bmad-output', 'implementation-artifacts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, checkoutFile), '# story from checkout')

    const result = resolveStoryFileInputPath({ story_file: storyFile }, tmpDir, '5-1')
    expect(result).not.toBeNull()
    expect(result.path).toBe(join(dir, checkoutFile))
    expect(result.source).toBe('checkout')
  })

  it('Priority 3: returns checkout fallback when no manifest or git resolution', () => {
    // No manifest sidecar, no git-recovered file; but story file exists in current checkout
    const dir = join(tmpDir, '_bmad-output', 'implementation-artifacts')
    mkdirSync(dir, { recursive: true })
    const checkoutFile = '78-1-fix-some-bug.md'
    writeFileSync(join(dir, checkoutFile), '# story from checkout')

    const result = resolveStoryFileInputPath({}, tmpDir, '78-1')
    expect(result).not.toBeNull()
    expect(result.path).toBe(join(dir, checkoutFile))
    expect(result.source).toBe('checkout')
  })

  it('returns null when no story input can be resolved from any source', () => {
    // No manifest, no git file, no checkout file
    const result = resolveStoryFileInputPath({}, tmpDir, '99-9')
    expect(result).toBeNull()
  })

  it('Priority 1 takes precedence over all other sources', () => {
    // Both manifest sidecar and git file and checkout file exist
    const sidecarPath = join(tmpDir, 'sidecar.md')
    writeFileSync(sidecarPath, '# sidecar')
    const gitFile = '_bmad-output/implementation-artifacts/5-1-git.md'
    const dir = join(tmpDir, '_bmad-output', 'implementation-artifacts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '5-1-git.md'), '# git')
    writeFileSync(join(dir, '5-1-checkout.md'), '# checkout')

    const result = resolveStoryFileInputPath(
      { input_path: sidecarPath, story_file: gitFile },
      tmpDir,
      '5-1',
    )
    expect(result!.path).toBe(sidecarPath)
    expect(result!.source).toBe('manifest')
  })
})

// ---------------------------------------------------------------------------
// censusRepo shared schema (Story 81-8, AC2) — id, source, story_file_input_path, expect
// ---------------------------------------------------------------------------

describe('censusRepo — emits shared schema fields (Story 81-8, AC2)', () => {
  const gitLogStdout = [
    'shaAuto feat(story-5-1): real auto-commit',
    '---END-COMMIT-77-6---',
  ].join('\n')
  const manifests = [
    { runId: 'run-X', raw: { per_story_state: { '5-1': { status: 'complete', commit_sha: 'shaAuto' } } } },
  ]
  const resolveParentFn = (_repo: string, sha: string) => `${sha}-parent`

  it('includes id, source, story_file_input_path, and expect fields', () => {
    const mockPath = '/tmp/5-1-story.md'
    const resolveStoryFileInputPathFn = (_: object, _repo: string, _key: string) =>
      ({ path: mockPath, source: 'manifest' })
    const findStoryFileFn = () => null

    const { triples } = censusRepo('/home/user/code/ynab', {
      gitLogStdout,
      manifests,
      resolveParentFn,
      findStoryFileFn,
      resolveStoryFileInputPathFn,
    })
    expect(triples).toHaveLength(1)
    const t = triples[0]
    // id = <story_key>-<sha[:8]>
    expect(t.id).toBe('5-1-shaAuto'[0] === 's' ? '5-1-shaAuto'.slice(0, '5-1-shaAuto'.length) : '5-1-shaAuto')
    expect(t.id).toBe('5-1-shaAuto')
    expect(t.source).toBe('ynab') // non-substrate repo → basename
    expect(t.story_file_input_path).toBe(mockPath)
    expect(t.expect).toEqual({ result_class: 'complete' })
  })

  it('generates correct id as <story_key>-<sha[:8]>', () => {
    const sha = 'abcdef1234567890'
    const logWithSha = [`${sha} feat(story-10-2): something`, '---END-COMMIT-77-6---'].join('\n')
    const m = [
      { runId: 'run-Y', raw: { per_story_state: { '10-2': { status: 'complete', commit_sha: sha } } } },
    ]
    const resolveStoryFileInputPathFn = () => ({ path: '/tmp/x.md', source: 'checkout' })
    const { triples } = censusRepo('/fake/repo', {
      gitLogStdout: logWithSha,
      manifests: m,
      resolveParentFn: () => 'parent-sha',
      findStoryFileFn: () => null,
      resolveStoryFileInputPathFn,
    })
    expect(triples[0].id).toBe(`10-2-${sha.slice(0, 8)}`)
  })

  it('uses substrate-self source for substrate repo', () => {
    const resolveStoryFileInputPathFn = () => ({ path: '/tmp/x.md', source: 'manifest' })
    const { triples } = censusRepo('/home/user/code/substrate', {
      gitLogStdout,
      manifests,
      resolveParentFn,
      findStoryFileFn: () => null,
      resolveStoryFileInputPathFn,
    })
    expect(triples[0].source).toBe('substrate-self')
  })

  it('excludes triples with no resolvable story_file_input_path (AC5)', () => {
    // resolveStoryFileInputPathFn returns null → corpus-error, excluded
    const { triples, cleanCount, excludedCount } = censusRepo('/fake/repo', {
      gitLogStdout,
      manifests,
      resolveParentFn,
      findStoryFileFn: () => null,
      resolveStoryFileInputPathFn: () => null,
    })
    expect(cleanCount).toBe(0)
    expect(excludedCount).toBe(1)
    expect(triples).toHaveLength(0)
  })

  it('sets input_path for checkout-source triples (for reconstruction harness validateTriple)', () => {
    const checkoutPath = '/tmp/checkout/story.md'
    const resolveStoryFileInputPathFn = () => ({ path: checkoutPath, source: 'checkout' })
    const { triples } = censusRepo('/fake/repo', {
      gitLogStdout,
      manifests,
      resolveParentFn,
      findStoryFileFn: () => null,
      resolveStoryFileInputPathFn,
    })
    expect(triples[0].story_file_source).toBe('checkout')
    // input_path must be set for checkout source so reconstruction validateTriple passes
    expect(triples[0].input_path).toBe(checkoutPath)
  })
})
