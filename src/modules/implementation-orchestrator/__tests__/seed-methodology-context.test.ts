/**
 * Unit tests for seed-methodology-context.ts — Story 23-1: Epic Shard Overhaul
 *
 * Covers:
 * - AC1/AC6: Content-hash re-seed on changed or missing hash
 * - AC2: Unchanged file skips re-seed
 * - AC4: Relaxed heading regex (h2/h3/h4) in parseEpicShards()
 * - AC7: MAX_EPIC_SHARD_CHARS raised to 12,000
 * - Integration: seed → verify → modify file → re-seed → verify updated content
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Mock node:fs — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  }
})

import { existsSync, readFileSync } from 'node:fs'
const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)

// Mock logger to suppress output during tests
vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

import { seedMethodologyContext, parseStorySubsections, detectTestPatterns } from '../seed-methodology-context.js'
import { getDecisionsByPhase } from '../../../persistence/queries/decisions.js'
import { createLogger } from '../../../utils/logger.js'

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

const CREATE_DECISIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS decisions (
    id              TEXT PRIMARY KEY,
    pipeline_run_id TEXT,
    phase           TEXT NOT NULL,
    category        TEXT NOT NULL,
    key             TEXT NOT NULL,
    value           TEXT NOT NULL,
    rationale       TEXT,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`

async function createTestDb(): Promise<InMemoryDatabaseAdapter> {
  const adapter = new InMemoryDatabaseAdapter()
  adapter.execSync(CREATE_DECISIONS_TABLE)
  return adapter
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EPICS_H2 = `# Epics

## Epic 1: Foundation
Story 1-1: Setup
Story 1-2: Config

## Epic 2: Core Features
Story 2-1: API
Story 2-2: UI
`

const EPICS_H3 = `# Epics

### Epic 1: Foundation
Story 1-1: Setup
Story 1-2: Config

### Epic 2: Core Features
Story 2-1: API
Story 2-2: UI
`

const EPICS_H4 = `# Epics

#### Epic 1: Foundation
Story 1-1: Setup

#### Epic 2: Core Features
Story 2-1: API
`

const EPICS_MIXED_DEPTH = `# Epics

## Epic 1: Foundation
Story 1-1: Setup

### Epic 2: Core Features
Story 2-1: API

#### Epic 3: Advanced
Story 3-1: Search
`

const EPICS_WITH_STORY_SECTIONS = `# Epics

## Epic 23: Cross-Project Pipeline Correctness

### Story 23-1: Epic Shard Overhaul
This story handles the epic shard logic.
AC1: Content-Hash Re-Seed
AC2: Unchanged File Skips Re-Seed

### Story 23-2: Dispatch Error Separation
This story handles dispatch error separation.
AC1: Dispatch failures use dispatch_failed
`

// Path to the (mocked) epics file
const MOCK_EPICS_PATH = '/project/_bmad-output/planning-artifacts/epics.md'
const MOCK_PROJECT_ROOT = '/project'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function setupEpicsFile(content: string): void {
  mockExistsSync.mockImplementation((p: unknown) => {
    const path = String(p)
    return path === MOCK_EPICS_PATH || path.endsWith('planning-artifacts/epics.md')
  })
  mockReadFileSync.mockImplementation((p: unknown) => {
    const path = String(p)
    if (path.endsWith('epics.md')) return content
    if (path.endsWith('package.json')) return JSON.stringify({ devDependencies: {} })
    return ''
  })
}

// ---------------------------------------------------------------------------
// AC4: Relaxed heading regex (h2/h3/h4) in parseEpicShards()
// ---------------------------------------------------------------------------

describe('AC4: Relaxed Heading Regex — parseEpicShards()', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
  })
  afterEach(async () => {
    await adapter.close()
  })

  it('parses ## (h2) epic headings and produces correct shard count', async () => {
    setupEpicsFile(EPICS_H2)
    const result = await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)
    // Should seed 2 epic shards (Epic 1 and Epic 2)
    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    const shards = decisions.filter((d) => d.category === 'epic-shard')
    expect(shards).toHaveLength(2)
    expect(shards.map((s) => s.key)).toContain('1')
    expect(shards.map((s) => s.key)).toContain('2')
    expect(result.decisionsCreated).toBeGreaterThanOrEqual(2)
  })

  it('parses ### (h3) epic headings and produces correct shard count', async () => {
    setupEpicsFile(EPICS_H3)
    const result = await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)
    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    const shards = decisions.filter((d) => d.category === 'epic-shard')
    expect(shards).toHaveLength(2)
    expect(shards.map((s) => s.key)).toContain('1')
    expect(shards.map((s) => s.key)).toContain('2')
    expect(result.decisionsCreated).toBeGreaterThanOrEqual(2)
  })

  it('parses #### (h4) epic headings and produces correct shard count', async () => {
    setupEpicsFile(EPICS_H4)
    const result = await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)
    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    const shards = decisions.filter((d) => d.category === 'epic-shard')
    expect(shards).toHaveLength(2)
    expect(shards.map((s) => s.key)).toContain('1')
    expect(shards.map((s) => s.key)).toContain('2')
    expect(result.decisionsCreated).toBeGreaterThanOrEqual(2)
  })

  it('parses mixed heading depths (h2/h3/h4) correctly', async () => {
    setupEpicsFile(EPICS_MIXED_DEPTH)
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)
    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    const shards = decisions.filter((d) => d.category === 'epic-shard')
    expect(shards).toHaveLength(3)
    expect(shards.map((s) => s.key)).toContain('1')
    expect(shards.map((s) => s.key)).toContain('2')
    expect(shards.map((s) => s.key)).toContain('3')
  })

  it('shard content contains the section text', async () => {
    setupEpicsFile(EPICS_H3)
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)
    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    const shard1 = decisions.find((d) => d.category === 'epic-shard' && d.key === '1')
    expect(shard1?.value).toContain('Foundation')
    expect(shard1?.value).toContain('Story 1-1')
  })
})

// ---------------------------------------------------------------------------
// AC7: MAX_EPIC_SHARD_CHARS raised to 12,000
// ---------------------------------------------------------------------------

describe('AC7: MAX_EPIC_SHARD_CHARS = 12,000', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
  })
  afterEach(async () => {
    await adapter.close()
  })

  it('does not truncate content shorter than 12,000 chars', async () => {
    const longContent = '## Epic 1: Long Epic\n' + 'x'.repeat(11_000) + '\n\n## Epic 2: Short\nContent\n'
    setupEpicsFile(longContent)
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)
    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    const shard1 = decisions.find((d) => d.category === 'epic-shard' && d.key === '1')
    // The shard should contain the full 11,000 char content (not truncated at 4,000)
    expect(shard1?.value.length).toBeGreaterThan(4_000)
    expect(shard1?.value.length).toBeGreaterThan(11_000)
  })
})

// ---------------------------------------------------------------------------
// Story 58-19: Shard truncation log-warn visibility
//
// When a subsection's content exceeds MAX_EPIC_SHARD_CHARS, the value is
// silently truncated at write time. Strata obs_2026-04-20_001's per-epic
// fallback path (pre-58-17) made this catastrophic — Stories 1.6, 1.8, 1.9+
// disappeared into the dropped tail. After 58-17 each subsection is per-story
// and usually fits, but a pathological single story can still exceed the cap.
// 58-19 surfaces truncation events as warn-level log lines with diagnostic
// metadata so an operator notices and can decide to split or raise the cap.
// ---------------------------------------------------------------------------

describe('Story 58-19: shard truncation log-warn visibility', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
    // Reset all warn-mock call histories on the shared createLogger instances
    // before each test. The module-level logger is constructed at import and
    // shared across tests in this file; without a reset, a prior test's
    // truncation warn would leak into the "no truncation" assertion below.
    vi.mocked(createLogger).mock.results.forEach((r) => {
      const inst = r.value as { warn: ReturnType<typeof vi.fn> } | undefined
      if (inst?.warn !== undefined) inst.warn.mockClear()
    })
  })
  afterEach(async () => {
    await adapter.close()
  })

  function getTruncationWarns(): unknown[][] {
    return vi.mocked(createLogger).mock.results
      .flatMap((r) => (r.value as { warn: ReturnType<typeof vi.fn> }).warn.mock.calls)
      .filter((call) => {
        const arg = call[0] as Record<string, unknown> | undefined
        return arg !== undefined
          && typeof arg === 'object'
          && 'storyKey' in arg
          && 'originalLength' in arg
          && 'truncatedLength' in arg
      })
  }

  it('emits a warn log when a per-story shard exceeds MAX_EPIC_SHARD_CHARS', async () => {
    // Construct a single-story epic where the story's content alone exceeds 12K.
    const longBody = 'x'.repeat(13_000)
    const epicContent = `## Epic 8

### Story 8-1: A long story
${longBody}
`
    setupEpicsFile(epicContent)

    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    const truncationWarns = getTruncationWarns()
    expect(truncationWarns.length).toBeGreaterThanOrEqual(1)

    const warnPayload = truncationWarns[0]?.[0] as Record<string, unknown>
    expect(warnPayload.storyKey).toBe('8-1')
    expect(warnPayload.originalLength).toBeGreaterThan(12_000)
    expect(warnPayload.truncatedLength).toBe(12_000)
    expect(warnPayload.droppedChars).toBeGreaterThan(0)

    // Warn presence does NOT block the write — decision still persisted at
    // ~MAX_EPIC_SHARD_CHARS (truncation applied, original 13K dropped to ~12K).
    // The exact value can vary by ±a few chars (~2) depending on parser/storage
    // edge handling; the test asserts truncation happened, not exact byte count.
    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    const shard = decisions.find((d) => d.category === 'epic-shard' && d.key === '8-1')
    expect(shard).toBeDefined()
    // Significantly smaller than the 13K source — proves truncation
    expect(shard!.value.length).toBeLessThan(12_100)
    // But still close to the cap — proves we didn't drop too much
    expect(shard!.value.length).toBeGreaterThan(11_900)
  })

  it('does NOT emit a truncation warn when content fits within the cap', async () => {
    const epicContent = `## Epic 9

### Story 9-1: A short story
Just a few lines of content. Far under the 12K cap.
`
    setupEpicsFile(epicContent)

    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    const truncationWarns = getTruncationWarns()
    expect(truncationWarns).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC1 + AC2 + AC6: Content-hash comparison logic
// ---------------------------------------------------------------------------

describe('AC1/AC2/AC6: Content-hash comparison in seedEpicShards()', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
  })
  afterEach(async () => {
    await adapter.close()
  })

  it('AC6: seeds shards and stores hash when no epic-shard-hash exists (first run)', async () => {
    setupEpicsFile(EPICS_H2)
    const result = await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    // Should have created epic-shard decisions
    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    const shards = decisions.filter((d) => d.category === 'epic-shard')
    expect(shards.length).toBeGreaterThan(0)

    // Should have stored the hash
    const hashDecision = decisions.find(
      (d) => d.category === 'epic-shard-hash' && d.key === 'epics-file',
    )
    expect(hashDecision).toBeDefined()
    expect(hashDecision?.value).toBe(sha256(EPICS_H2))

    // decisionsCreated should include shards + hash
    expect(result.decisionsCreated).toBeGreaterThan(0)
    expect(result.skippedCategories).not.toContain('epic-shard')
  })

  it('AC2: skips re-seeding when hash matches (file unchanged)', async () => {
    setupEpicsFile(EPICS_H2)
    // First run — seeds everything
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    const decisionsAfterFirst = await getDecisionsByPhase(adapter, 'implementation')
    const shardCountAfterFirst = decisionsAfterFirst.filter((d) => d.category === 'epic-shard').length

    // Second run — same file content
    const result2 = await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    // Should be skipped (returns -1 internally → skippedCategories includes 'epic-shard')
    expect(result2.skippedCategories).toContain('epic-shard')

    // No new shards should have been added
    const decisionsAfterSecond = await getDecisionsByPhase(adapter, 'implementation')
    const shardCountAfterSecond = decisionsAfterSecond.filter((d) => d.category === 'epic-shard').length
    expect(shardCountAfterSecond).toBe(shardCountAfterFirst)
  })

  it('AC1: deletes stale shards and re-seeds when hash differs (file changed)', async () => {
    setupEpicsFile(EPICS_H2)
    // First run — seeds EPICS_H2 (2 epics)
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    const THREE_EPIC_CONTENT = `
## Epic 1: Foundation
Story 1-1: Setup

## Epic 2: Core Features
Story 2-1: API

## Epic 3: New Epic
Story 3-1: New
`
    // Change file content
    setupEpicsFile(THREE_EPIC_CONTENT)

    // Second run — different file content
    const result2 = await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)
    expect(result2.skippedCategories).not.toContain('epic-shard')

    // Should now have 3 shards (stale 2 were deleted and 3 new were seeded)
    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    const shards = decisions.filter((d) => d.category === 'epic-shard')
    expect(shards).toHaveLength(3)

    // Hash should be updated
    const hashDecision = decisions.find(
      (d) => d.category === 'epic-shard-hash' && d.key === 'epics-file',
    )
    expect(hashDecision?.value).toBe(sha256(THREE_EPIC_CONTENT))
  })

  it('AC1: stores updated hash after re-seeding', async () => {
    // First: seed with original content
    setupEpicsFile(EPICS_H2)
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    const MODIFIED_CONTENT = EPICS_H2 + '\n## Epic 3: Extra\nStory 3-1: Extra\n'
    setupEpicsFile(MODIFIED_CONTENT)

    // Second: re-seed with modified content
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    const hashDecision = decisions.find(
      (d) => d.category === 'epic-shard-hash' && d.key === 'epics-file',
    )
    expect(hashDecision?.value).toBe(sha256(MODIFIED_CONTENT))
  })
})

// ---------------------------------------------------------------------------
// Integration test: full seed → modify → re-seed flow with h3 headings
// ---------------------------------------------------------------------------

describe('Integration: h3 headings, full seed-modify-re-seed flow', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
  })
  afterEach(async () => {
    await adapter.close()
  })

  it('seeds with h3 headings, verifies count, modifies, re-seeds and verifies updated content', async () => {
    // Step 1: seed with h3 headings (2 epics)
    setupEpicsFile(EPICS_H3)
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    let decisions = await getDecisionsByPhase(adapter, 'implementation')
    let shards = decisions.filter((d) => d.category === 'epic-shard')
    expect(shards).toHaveLength(2)
    const shard1 = shards.find((s) => s.key === '1')
    expect(shard1?.value).toContain('Foundation')

    // Step 2: modify file (add Epic 3 with h3)
    const MODIFIED_H3 = EPICS_H3 + '\n### Epic 3: New Epic\nStory 3-1: New\n'
    setupEpicsFile(MODIFIED_H3)

    // Step 3: re-seed
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    // Step 4: verify updated content
    decisions = await getDecisionsByPhase(adapter, 'implementation')
    shards = decisions.filter((d) => d.category === 'epic-shard')
    expect(shards).toHaveLength(3)
    const shard3 = shards.find((s) => s.key === '3')
    expect(shard3?.value).toContain('New Epic')

    // Hash should match updated content
    const hashDecision = decisions.find(
      (d) => d.category === 'epic-shard-hash' && d.key === 'epics-file',
    )
    expect(hashDecision?.value).toBe(sha256(MODIFIED_H3))
  })

  it('seeds per-story shards when epic has markdown story headings (AC1 integration)', async () => {
    // Post-37-0: epics with ### Story N-N headings produce one shard per story
    setupEpicsFile(EPICS_WITH_STORY_SECTIONS)
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    const epicShards = decisions.filter((d) => d.category === 'epic-shard')

    // Should have produced per-story shards (key='23-1' and key='23-2')
    // rather than a single per-epic shard (key='23')
    const shard23_1 = epicShards.find((d) => d.key === '23-1')
    const shard23_2 = epicShards.find((d) => d.key === '23-2')
    expect(shard23_1).toBeDefined()
    expect(shard23_2).toBeDefined()
    expect(shard23_1?.value).toContain('Epic Shard Overhaul')
    expect(shard23_2?.value).toContain('Dispatch Error Separation')
    // No per-epic fallback key should exist (stories were found)
    const shard23 = epicShards.find((d) => d.key === '23')
    expect(shard23).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Task 5: Unit tests for parseStorySubsections() — AC1, AC2, AC3, AC7
// ---------------------------------------------------------------------------

describe('parseStorySubsections()', () => {
  // AC1 + AC2: h3 story headings → per-story shards with correct keys and boundaries
  it('returns per-story shards from h3 story headings (AC1, AC2)', () => {
    const epicContent = `## Epic 37: Polyglot Project Support

### Story 37-1: Project Profile
Content for 37-1.
- Task A
- Task B

### Story 37-2: Build Gate
Content for 37-2.
- Task C
`
    const result = parseStorySubsections('37', epicContent)
    expect(result).toHaveLength(2)
    expect(result[0]?.key).toBe('37-1')
    expect(result[1]?.key).toBe('37-2')
    // AC2: boundary — 37-1 section must NOT include 37-2 content
    expect(result[0]?.content).toContain('Content for 37-1')
    expect(result[0]?.content).not.toContain('Content for 37-2')
    expect(result[1]?.content).toContain('Content for 37-2')
    expect(result[1]?.content).not.toContain('Content for 37-1')
  })

  // AC2: h4 story headings → same boundary assertion
  it('returns per-story shards from h4 story headings (AC2)', () => {
    const epicContent = `## Epic 10: Workflows

#### Story 10-1: First Story
First story content.

#### Story 10-2: Second Story
Second story content.
`
    const result = parseStorySubsections('10', epicContent)
    expect(result).toHaveLength(2)
    expect(result[0]?.key).toBe('10-1')
    expect(result[1]?.key).toBe('10-2')
    expect(result[0]?.content).toContain('First story content')
    expect(result[0]?.content).not.toContain('Second story content')
  })

  // AC3: no story headings → single per-epic fallback entry keyed by epicId
  it('returns single per-epic fallback when no story headings found (AC3)', () => {
    const epicContent = `## Epic 5: Simple Epic
Some high-level description.
No story subsections here.
`
    const result = parseStorySubsections('5', epicContent)
    expect(result).toHaveLength(1)
    expect(result[0]?.key).toBe('5') // keyed by epicId
    expect(result[0]?.content).toContain('Simple Epic')
    expect(result[0]?.content).toContain('No story subsections here')
  })

  // AC7: large epic content split into per-story shards, each well under 12K
  it('each per-story shard is well under 12K chars for large epics (AC7)', () => {
    // Build an epic whose total content exceeds 12K characters
    const storyCount = 5
    let epicContent = '## Epic 99: Large Epic\n\n'
    for (let i = 1; i <= storyCount; i++) {
      epicContent += `### Story 99-${i}: Story Title ${i}\n`
      epicContent += 'x'.repeat(3_000) + '\n\n' // 3K per story, 15K total > 12K limit
    }

    const result = parseStorySubsections('99', epicContent)
    expect(result).toHaveLength(storyCount)

    // AC7: each shard must be complete and under 12K chars
    for (const shard of result) {
      expect(shard.content.length).toBeLessThan(12_000)
      expect(shard.content.length).toBeGreaterThan(0)
    }
  })

  // Bold **Story N-N** pattern
  it('parses bold **Story N-N** story headings', () => {
    const epicContent = `## Epic 3

**Story 3-1** First bold story
Some content.

**Story 3-2** Second bold story
More content.
`
    const result = parseStorySubsections('3', epicContent)
    expect(result).toHaveLength(2)
    expect(result[0]?.key).toBe('3-1')
    expect(result[1]?.key).toBe('3-2')
  })

  // Bare key pattern  e.g. "37-1: Title"
  it('parses bare key N-N: story headings at line start', () => {
    const epicContent = `## Epic 4

37-1: Project Profile
Bare key content.

37-2: Build Gate
Other content.
`
    const result = parseStorySubsections('4', epicContent)
    expect(result).toHaveLength(2)
    expect(result[0]?.key).toBe('37-1')
    expect(result[1]?.key).toBe('37-2')
  })

  // Last section extends to EOF (no next heading)
  it('last story section extends to end of content', () => {
    const epicContent = `## Epic 6

### Story 6-1: Only Story
This is the only story and goes to end.
Line 2.
Line 3.
`
    const result = parseStorySubsections('6', epicContent)
    expect(result).toHaveLength(1)
    expect(result[0]?.key).toBe('6-1')
    expect(result[0]?.content).toContain('Line 3')
  })
})

// ---------------------------------------------------------------------------
// Story 58-17: parseStorySubsections separator normalization
//
// Strata obs_2026-04-20_001 root cause: parseStorySubsections's regex required
// `\d+-\d+` (dash-separated), but strata's epics.md uses `### Story 1.1`
// (dot-separated, BMAD-template convention). Without separator-agnostic
// parsing, every Story 1.X heading was invisible to the parser, the
// matches.length === 0 fallback fired, the entire epic was stored as ONE
// per-epic decision (key=epicId) truncated at 12K. Stories past the 12K mark
// (1.6, 1.8, 1.9+) were never present in the decisions store at all.
//
// Fix: regex accepts \d+[-._ ]\d+; captured key normalized to canonical
// dash-form so `--stories 1-9` finds shards stored from `### Story 1.9`.
// ---------------------------------------------------------------------------

describe('Story 58-17: parseStorySubsections separator normalization', () => {
  it('detects dot-separated story headings (### Story 1.1) and normalizes keys to dash-form', () => {
    const epicContent = `## Epic 1: Fleet Foundation

### Story 1.1: Monorepo scaffolding
Content for 1.1.

### Story 1.2: Secrets bootstrap
Content for 1.2.

### Story 1.9: Wikilink JSON adjacency builder
Content for 1.9 — uses plain JSON file, NOT LanceDB.
`
    const result = parseStorySubsections('1', epicContent)
    expect(result).toHaveLength(3)
    expect(result.map(s => s.key)).toEqual(['1-1', '1-2', '1-9'])
    // Each subsection contains its own content
    expect(result[0]?.content).toContain('Content for 1.1')
    expect(result[2]?.content).toContain('uses plain JSON file, NOT LanceDB')
  })

  it('detects underscore-separated headings (### Story 1_1) and normalizes', () => {
    const epicContent = `### Story 2_1: First
First story.

### Story 2_2: Second
Second story.
`
    const result = parseStorySubsections('2', epicContent)
    expect(result).toHaveLength(2)
    expect(result.map(s => s.key)).toEqual(['2-1', '2-2'])
  })

  it('detects space-separated headings (### Story 3 1) and normalizes', () => {
    const epicContent = `### Story 3 1: First
First story.

### Story 3 2: Second
Second story.
`
    const result = parseStorySubsections('3', epicContent)
    expect(result).toHaveLength(2)
    expect(result.map(s => s.key)).toEqual(['3-1', '3-2'])
  })

  it('mixed-convention epic (some dash, some dot) produces N per-story decisions, all canonical', () => {
    const epicContent = `## Epic 4

### Story 4-1: Dash style
Dash content.

### Story 4.2: Dot style
Dot content.

### Story 4_3: Underscore style
Underscore content.
`
    const result = parseStorySubsections('4', epicContent)
    expect(result).toHaveLength(3)
    expect(result.map(s => s.key)).toEqual(['4-1', '4-2', '4-3'])
  })

  it('canonical dash-form is preserved when input already uses dashes (regression)', () => {
    const epicContent = `### Story 37-1: Direct
Content.

### Story 37-2: Direct
More content.
`
    const result = parseStorySubsections('37', epicContent)
    expect(result).toHaveLength(2)
    expect(result.map(s => s.key)).toEqual(['37-1', '37-2'])
  })

  it('regression: full strata-style epic with 4+ dot-separated stories does NOT fall through to per-epic fallback', () => {
    // The pre-58-17 bug: zero matches → matches.length === 0 → return single
    // per-epic entry with key=epicId. This test ensures we get N per-story
    // entries, NOT a single key='1' entry containing the entire epic.
    const epicContent = `## Epic 1: Fleet Foundation

### Story 1.1: A
A.

### Story 1.2: B
B.

### Story 1.6: C
C.

### Story 1.8: D
D.

### Story 1.9: E
E.
`
    const result = parseStorySubsections('1', epicContent)
    // 5 per-story decisions, NOT 1 per-epic decision
    expect(result).toHaveLength(5)
    expect(result.map(s => s.key)).toEqual(['1-1', '1-2', '1-6', '1-8', '1-9'])
    // None of them should be keyed by the bare epicId '1'
    expect(result.every(s => s.key !== '1')).toBe(true)
  })

  it('bold-style headings (**Story 1.5**) accept all separators with normalization', () => {
    const epicContent = `**Story 5.1**
Content for 5.1.

**Story 5_2**
Content for 5.2.
`
    const result = parseStorySubsections('5', epicContent)
    expect(result).toHaveLength(2)
    expect(result.map(s => s.key)).toEqual(['5-1', '5-2'])
  })

  it('bare-key headings (1.7:) accept all separators with normalization', () => {
    const epicContent = `7.1: First
Content for 7.1.

7.2: Second
Content for 7.2.
`
    const result = parseStorySubsections('7', epicContent)
    expect(result).toHaveLength(2)
    expect(result.map(s => s.key)).toEqual(['7-1', '7-2'])
  })
})

// ---------------------------------------------------------------------------
// Task 6: Integration tests for seed-and-retrieve round trip — AC4, AC5, AC6
// ---------------------------------------------------------------------------

describe('Integration: seed-and-retrieve round trip (Story 37-0)', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
  })
  afterEach(async () => {
    await adapter.close()
  })

  it('AC4: seeding epic with story subsections stores per-storyKey decisions', async () => {
    setupEpicsFile(EPICS_WITH_STORY_SECTIONS)
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    // Direct per-story lookup should succeed
    const shard23_1 = decisions.find((d) => d.category === 'epic-shard' && d.key === '23-1')
    const shard23_2 = decisions.find((d) => d.category === 'epic-shard' && d.key === '23-2')
    expect(shard23_1).toBeDefined()
    expect(shard23_2).toBeDefined()
    expect(shard23_1?.value).toContain('Epic Shard Overhaul')
    expect(shard23_2?.value).toContain('Dispatch Error Separation')
  })

  it('AC5: re-seed deletes all prior epic-shard rows (both per-story and per-epic)', async () => {
    // First seed: EPICS_WITH_STORY_SECTIONS (produces per-story shards 23-1, 23-2)
    setupEpicsFile(EPICS_WITH_STORY_SECTIONS)
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    // Verify initial state
    let decisions = await getDecisionsByPhase(adapter, 'implementation')
    let shards = decisions.filter((d) => d.category === 'epic-shard')
    const initialKeys = shards.map((s) => s.key)
    expect(initialKeys).toContain('23-1')
    expect(initialKeys).toContain('23-2')

    // Modify file to change content → triggers re-seed
    const MODIFIED_CONTENT = EPICS_WITH_STORY_SECTIONS + '\n## Epic 99: New Epic\nStory 99-1: Added\n'
    setupEpicsFile(MODIFIED_CONTENT)
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    // All prior per-story shards deleted; new ones plus epic 99 should be present
    decisions = await getDecisionsByPhase(adapter, 'implementation')
    shards = decisions.filter((d) => d.category === 'epic-shard')
    const newKeys = shards.map((s) => s.key)
    // 23-1 and 23-2 should still exist (re-seeded from same sections)
    expect(newKeys).toContain('23-1')
    expect(newKeys).toContain('23-2')
    // Epic 99 has no story headings → per-epic fallback
    expect(newKeys).toContain('99')
  })

  it('AC6: backward compat — old per-epic shard (key=epicId) still queryable', async () => {
    // Simulate pre-37-0 state: seed a per-epic shard (key=epicId, not storyKey)
    setupEpicsFile(EPICS_H2) // EPICS_H2 has no story heading patterns → per-epic fallback
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    // Should have per-epic shards (backward compat)
    const shard1 = decisions.find((d) => d.category === 'epic-shard' && d.key === '1')
    const shard2 = decisions.find((d) => d.category === 'epic-shard' && d.key === '2')
    expect(shard1).toBeDefined()
    expect(shard2).toBeDefined()
    expect(shard1?.value).toContain('Foundation')
    expect(shard2?.value).toContain('Core Features')
  })
})

// ---------------------------------------------------------------------------
// Story 37-5: Polyglot test pattern detection
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/project'
const PROFILE_PATH = `${PROJECT_ROOT}/.substrate/project-profile.yaml`

/**
 * Helper: set up mocks for a project with only the given files present.
 * `files` is a map from file path to content (string). All other paths → false.
 */
function setupPolyglotMocks(files: Record<string, string>): void {
  mockExistsSync.mockImplementation((p: unknown) => {
    const path = String(p)
    return Object.prototype.hasOwnProperty.call(files, path)
  })
  mockReadFileSync.mockImplementation((p: unknown) => {
    const path = String(p)
    if (Object.prototype.hasOwnProperty.call(files, path)) return files[path]
    throw new Error(`ENOENT: no such file: ${path}`)
  })
}

describe('detectTestPatterns: Story 37-5 polyglot detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // AC1: Profile with go testCommand → Go patterns
  it('AC1: profile testCommand go test → seeds Go patterns via seedMethodologyContext()', async () => {
    const adapter = await createTestDb()
    try {
      const profileYaml = `project:\n  type: single\n  language: go\n  testCommand: "go test ./..."\n  packages: []\n`
      setupPolyglotMocks({
        [PROFILE_PATH]: profileYaml,
        // no package.json, no go.mod — profile takes precedence
      })

      await seedMethodologyContext(adapter, PROJECT_ROOT)

      const decisions = await getDecisionsByPhase(adapter, 'solutioning')
      const testPatterns = decisions.find((d) => d.category === 'test-patterns')
      expect(testPatterns).toBeDefined()
      expect(testPatterns?.value).toContain('go test')
    } finally {
      await adapter.close()
    }
  })

  // AC2: go.mod filesystem probe → Go patterns
  it('AC2: go.mod present → returns Go test patterns', () => {
    setupPolyglotMocks({
      [`${PROJECT_ROOT}/go.mod`]: `module example.com/app\ngo 1.22\n`,
    })

    const result = detectTestPatterns(PROJECT_ROOT)
    expect(result).toBeDefined()
    expect(result).toContain('go test ./...')
  })

  // AC2b: go.mod with testify → mentions testify
  it('AC2b: go.mod with testify → result mentions testify', () => {
    setupPolyglotMocks({
      [`${PROJECT_ROOT}/go.mod`]: `module example.com/app\ngo 1.22\n\nrequire github.com/stretchr/testify v1.8.4\n`,
    })

    const result = detectTestPatterns(PROJECT_ROOT)
    expect(result).toBeDefined()
    expect(result).toContain('testify')
  })

  // AC3: build.gradle.kts with junit-jupiter → Gradle JUnit 5 patterns
  it('AC3: build.gradle.kts with junit-jupiter → Gradle patterns', () => {
    setupPolyglotMocks({
      [`${PROJECT_ROOT}/build.gradle.kts`]: `plugins { id("org.springframework.boot") }\ndependencies { testImplementation("org.junit.jupiter:junit-jupiter") }\n`,
    })

    const result = detectTestPatterns(PROJECT_ROOT)
    expect(result).toBeDefined()
    expect(result).toContain('./gradlew test')
    expect(result).toContain('@Test')
  })

  // AC4: pyproject.toml with [tool.pytest] → pytest patterns
  it('AC4: pyproject.toml with [tool.pytest] → pytest patterns', () => {
    setupPolyglotMocks({
      [`${PROJECT_ROOT}/pyproject.toml`]: `[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`,
    })

    const result = detectTestPatterns(PROJECT_ROOT)
    expect(result).toBeDefined()
    expect(result).toContain('pytest')
    expect(result).toContain('fixture')
  })

  // AC4-negative: pyproject.toml WITHOUT [tool.pytest] → no pytest patterns
  it('AC4-negative: pyproject.toml without [tool.pytest] → returns undefined', () => {
    setupPolyglotMocks({
      [`${PROJECT_ROOT}/pyproject.toml`]: `[tool.poetry]\nname = "my-lib"\nversion = "0.1.0"\n`,
    })

    const result = detectTestPatterns(PROJECT_ROOT)
    expect(result).toBeUndefined()
  })

  // AC4b: conftest.py only → pytest patterns
  it('AC4b: conftest.py only → pytest patterns', () => {
    setupPolyglotMocks({
      [`${PROJECT_ROOT}/conftest.py`]: `import pytest\n`,
    })

    const result = detectTestPatterns(PROJECT_ROOT)
    expect(result).toBeDefined()
    expect(result).toContain('pytest')
  })

  // AC5: Cargo.toml → Rust patterns
  it('AC5: Cargo.toml present → Rust test patterns', () => {
    setupPolyglotMocks({
      [`${PROJECT_ROOT}/Cargo.toml`]: `[package]\nname = "my-app"\nversion = "0.1.0"\n`,
    })

    const result = detectTestPatterns(PROJECT_ROOT)
    expect(result).toBeDefined()
    expect(result).toContain('cargo test')
    expect(result).toContain('#[test]')
  })

  // AC6: monorepo profile with Go + TypeScript packages → combined patterns
  it('AC6: monorepo profile with Go + TypeScript → combined patterns seeded', async () => {
    const adapter = await createTestDb()
    try {
      const profileYaml = [
        'project:',
        '  type: monorepo',
        '  tool: turborepo',
        '  buildCommand: "turbo build"',
        '  testCommand: "turbo test"',
        '  packages:',
        '    - path: apps/lock-service',
        '      language: go',
        '    - path: apps/web',
        '      language: typescript',
        '      framework: nextjs',
      ].join('\n')

      setupPolyglotMocks({
        [PROFILE_PATH]: profileYaml,
      })

      await seedMethodologyContext(adapter, PROJECT_ROOT)

      const decisions = await getDecisionsByPhase(adapter, 'solutioning')
      const testPatterns = decisions.find((d) => d.category === 'test-patterns')
      expect(testPatterns).toBeDefined()
      expect(testPatterns?.value).toContain('go test')
      expect(testPatterns?.value).toMatch(/vitest|npm/)
    } finally {
      await adapter.close()
    }
  })

  // AC7: no regression — vitest detection unchanged when only package.json is present
  it('AC7: package.json with vitest → Vitest patterns, no Go', () => {
    setupPolyglotMocks({
      [`${PROJECT_ROOT}/package.json`]: JSON.stringify({
        devDependencies: { vitest: '^1.0.0' },
        scripts: {},
      }),
    })

    const result = detectTestPatterns(PROJECT_ROOT)
    expect(result).toBeDefined()
    expect(result).toContain('vitest')
    expect(result).not.toContain('go test')
  })
})
