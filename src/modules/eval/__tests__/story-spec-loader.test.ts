// src/modules/eval/__tests__/story-spec-loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import { createDecision } from '../../../persistence/queries/decisions.js'
import { STORY_METRICS } from '@substrate-ai/core'
import {
  parseStorySpec,
  aggregateStorySpecs,
  loadStorySpecsForRun,
} from '../story-spec-loader.js'

describe('parseStorySpec', () => {
  it('extracts AC headings of the form "### AC<n>: title"', () => {
    const content = `
## Story
As a developer, I want X.

## Acceptance Criteria

### AC1: vitest alias redirects better-sqlite3 imports
The alias should resolve to the wasm shim before any test runs.

### AC2: File-based integration tests adapted
Tests must continue to pass against the new backend.

### AC3: SqliteDatabaseAdapter deleted
No code should reference the deleted module.
`
    const spec = parseStorySpec(content)
    expect(spec.acceptanceCriteria).toEqual([
      'AC1: vitest alias redirects better-sqlite3 imports',
      'AC2: File-based integration tests adapted',
      'AC3: SqliteDatabaseAdapter deleted',
    ])
  })

  it('extracts files from a "## File List" section with bullet items', () => {
    const content = `
## Story
description

## File List
- src/modules/eval/story-spec-loader.ts
- src/modules/eval/__tests__/story-spec-loader.test.ts
- src/cli/commands/eval.ts

## Dev Notes
something
`
    const spec = parseStorySpec(content)
    expect(spec.files).toEqual([
      'src/modules/eval/story-spec-loader.ts',
      'src/modules/eval/__tests__/story-spec-loader.test.ts',
      'src/cli/commands/eval.ts',
    ])
  })

  it('also accepts "### File List" (heading depth 3)', () => {
    const content = `
### File List
- src/foo.ts
- src/bar.ts
`
    const spec = parseStorySpec(content)
    expect(spec.files).toEqual(['src/foo.ts', 'src/bar.ts'])
  })

  it('strips file annotations after the path (e.g. "- src/foo.ts (new)")', () => {
    const content = `
## File List
- src/foo.ts (new)
- src/bar.ts (modified)
- src/baz.ts
`
    const spec = parseStorySpec(content)
    expect(spec.files).toEqual(['src/foo.ts', 'src/bar.ts', 'src/baz.ts'])
  })

  it('returns empty arrays when neither AC nor File List is present', () => {
    const content = `
## Story
A story with no structured AC or file list section.

## Dev Notes
Just notes.
`
    const spec = parseStorySpec(content)
    expect(spec.acceptanceCriteria).toEqual([])
    expect(spec.files).toEqual([])
  })

  it('handles empty content gracefully', () => {
    const spec = parseStorySpec('')
    expect(spec.acceptanceCriteria).toEqual([])
    expect(spec.files).toEqual([])
  })

  it('does not pick up bullet items from sections that are not File List', () => {
    const content = `
## Tasks
- [ ] T1: do thing
- [ ] T2: do other thing

## Constraints
- src/foo.ts is read-only
`
    const spec = parseStorySpec(content)
    expect(spec.files).toEqual([])
  })

  it('extracts AC from section text when "### AC<n>:" headings are absent', () => {
    // Some BMAD stories use a numbered list under "## Acceptance Criteria"
    // instead of `### AC<n>:` headings.
    const content = `
## Acceptance Criteria

1. The CLI accepts a --depth flag with values standard or deep.
2. The CLI exits 0 when the eval passes.
3. The CLI exits 1 when the eval fails.

## Dev Notes
notes
`
    const spec = parseStorySpec(content)
    expect(spec.acceptanceCriteria).toEqual([
      'The CLI accepts a --depth flag with values standard or deep.',
      'The CLI exits 0 when the eval passes.',
      'The CLI exits 1 when the eval fails.',
    ])
  })
})

describe('aggregateStorySpecs', () => {
  it('unions files (deduped, order preserved by first appearance)', () => {
    const a = { files: ['src/a.ts', 'src/b.ts'], acceptanceCriteria: [] }
    const b = { files: ['src/b.ts', 'src/c.ts'], acceptanceCriteria: [] }
    const merged = aggregateStorySpecs([a, b])
    expect(merged.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })

  it('concatenates AC and prefixes each with its source story key when provided', () => {
    const merged = aggregateStorySpecs([
      {
        storyKey: '21-1',
        files: [],
        acceptanceCriteria: ['AC1: thing one', 'AC2: thing two'],
      },
      {
        storyKey: '21-2',
        files: [],
        acceptanceCriteria: ['AC1: other thing'],
      },
    ])
    expect(merged.acceptanceCriteria).toEqual([
      'Story 21-1 — AC1: thing one',
      'Story 21-1 — AC2: thing two',
      'Story 21-2 — AC1: other thing',
    ])
  })

  it('does not prefix AC when source storyKey is not provided', () => {
    const merged = aggregateStorySpecs([
      { files: [], acceptanceCriteria: ['AC1: x'] },
    ])
    expect(merged.acceptanceCriteria).toEqual(['AC1: x'])
  })

  it('returns an empty spec when given an empty list', () => {
    const merged = aggregateStorySpecs([])
    expect(merged.files).toEqual([])
    expect(merged.acceptanceCriteria).toEqual([])
  })
})

describe('loadStorySpecsForRun', () => {
  let db: InMemoryDatabaseAdapter
  let projectRoot: string

  beforeEach(async () => {
    db = new InMemoryDatabaseAdapter()
    await initSchema(db)
    projectRoot = await mkdtemp(join(tmpdir(), 'eval-story-spec-'))
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  async function seedStoryFile(storyKey: string, slug: string, content: string): Promise<void> {
    const dir = join(projectRoot, '_bmad-output', 'implementation-artifacts')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${storyKey}-${slug}.md`), content, 'utf-8')
  }

  async function seedStoryMetrics(storyKey: string, runId: string): Promise<void> {
    await createDecision(db, {
      pipeline_run_id: runId,
      phase: 'implementation',
      category: STORY_METRICS,
      key: `${storyKey}:${runId}`,
      value: JSON.stringify({ wall_clock_seconds: 1 }),
    })
  }

  it('aggregates files and AC across every story that ran in the run', async () => {
    const runId = 'run-abc'
    await seedStoryMetrics('21-1', runId)
    await seedStoryMetrics('21-2', runId)

    await seedStoryFile(
      '21-1',
      'first-story',
      `## Story\nA story\n\n## Acceptance Criteria\n\n### AC1: first criterion\n### AC2: second criterion\n\n## File List\n- src/foo.ts\n- src/bar.ts\n`,
    )
    await seedStoryFile(
      '21-2',
      'second-story',
      `## Acceptance Criteria\n\n### AC1: another criterion\n\n## File List\n- src/bar.ts\n- src/baz.ts\n`,
    )

    const spec = await loadStorySpecsForRun(db, runId, projectRoot)

    // Files are deduped (bar.ts appears in both)
    expect(spec.files).toEqual(['src/foo.ts', 'src/bar.ts', 'src/baz.ts'])
    // AC are prefixed with the source story key
    expect(spec.acceptanceCriteria).toEqual([
      'Story 21-1 — AC1: first criterion',
      'Story 21-1 — AC2: second criterion',
      'Story 21-2 — AC1: another criterion',
    ])
  })

  it('returns an empty spec when no story-metrics decisions exist for the run', async () => {
    const spec = await loadStorySpecsForRun(db, 'run-no-stories', projectRoot)
    expect(spec.files).toEqual([])
    expect(spec.acceptanceCriteria).toEqual([])
  })

  it('skips story keys whose on-disk file is missing without failing', async () => {
    const runId = 'run-missing'
    await seedStoryMetrics('99-1', runId)
    await seedStoryMetrics('99-2', runId)

    // Only 99-2 has a file on disk
    await seedStoryFile(
      '99-2',
      'present',
      `## Acceptance Criteria\n\n### AC1: only this one\n`,
    )

    const spec = await loadStorySpecsForRun(db, runId, projectRoot)
    expect(spec.acceptanceCriteria).toEqual(['Story 99-2 — AC1: only this one'])
  })

  it('returns empty when the implementation-artifacts directory does not exist', async () => {
    const runId = 'run-no-dir'
    await seedStoryMetrics('1-1', runId)
    // intentionally do not create _bmad-output/implementation-artifacts/

    const spec = await loadStorySpecsForRun(db, runId, projectRoot)
    expect(spec.files).toEqual([])
    expect(spec.acceptanceCriteria).toEqual([])
  })

  it('ignores story-metrics decisions from other runs (per-run scoping)', async () => {
    await seedStoryMetrics('30-1', 'run-A')
    await seedStoryMetrics('30-2', 'run-B')

    await seedStoryFile('30-1', 'a', `### AC1: from run A\n`)
    await seedStoryFile('30-2', 'b', `### AC1: from run B\n`)

    const specA = await loadStorySpecsForRun(db, 'run-A', projectRoot)
    expect(specA.acceptanceCriteria).toEqual(['Story 30-1 — AC1: from run A'])

    const specB = await loadStorySpecsForRun(db, 'run-B', projectRoot)
    expect(specB.acceptanceCriteria).toEqual(['Story 30-2 — AC1: from run B'])
  })
})
