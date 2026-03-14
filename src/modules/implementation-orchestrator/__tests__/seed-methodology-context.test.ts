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
import { createWasmSqliteAdapter, WasmSqliteDatabaseAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
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

import { seedMethodologyContext } from '../seed-methodology-context.js'
import { getDecisionsByPhase } from '../../../persistence/queries/decisions.js'

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
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )
`

async function createTestDb(): Promise<WasmSqliteDatabaseAdapter> {
  const adapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
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
  let adapter: WasmSqliteDatabaseAdapter

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
  let adapter: WasmSqliteDatabaseAdapter

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
// AC1 + AC2 + AC6: Content-hash comparison logic
// ---------------------------------------------------------------------------

describe('AC1/AC2/AC6: Content-hash comparison in seedEpicShards()', () => {
  let adapter: WasmSqliteDatabaseAdapter

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
  let adapter: WasmSqliteDatabaseAdapter

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

  it('returns correct per-story section for a known story key (AC3 integration)', async () => {
    // The per-story extraction is tested directly in create-story tests,
    // but verify that the shard content seeded contains story sections
    setupEpicsFile(EPICS_WITH_STORY_SECTIONS)
    await seedMethodologyContext(adapter, MOCK_PROJECT_ROOT)

    const decisions = await getDecisionsByPhase(adapter, 'implementation')
    const shard23 = decisions.find((d) => d.category === 'epic-shard' && d.key === '23')
    expect(shard23?.value).toContain('Story 23-1')
    expect(shard23?.value).toContain('Story 23-2')
  })
})
