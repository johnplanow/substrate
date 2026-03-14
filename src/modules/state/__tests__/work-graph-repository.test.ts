// @vitest-environment node
/**
 * Unit tests for WorkGraphRepository.
 *
 * Uses InMemoryDatabaseAdapter as the test backend — no real database required.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { WorkGraphRepository } from '../work-graph-repository.js'
import type { BlockedStoryInfo } from '../work-graph-repository.js'
import type { WgStory, StoryDependency } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTables(db: InMemoryDatabaseAdapter): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS wg_stories (
    story_key    VARCHAR(20)   NOT NULL,
    epic         VARCHAR(20)   NOT NULL,
    title        VARCHAR(255),
    status       VARCHAR(30)   NOT NULL DEFAULT 'planned',
    spec_path    VARCHAR(500),
    created_at   DATETIME,
    updated_at   DATETIME,
    completed_at DATETIME,
    PRIMARY KEY (story_key)
  )`)
  await db.exec(`CREATE TABLE IF NOT EXISTS story_dependencies (
    story_key  VARCHAR(20)  NOT NULL,
    depends_on VARCHAR(20)  NOT NULL,
    dependency_type   VARCHAR(20)  NOT NULL,
    source     VARCHAR(20)  NOT NULL,
    created_at DATETIME,
    PRIMARY KEY (story_key, depends_on)
  )`)
}

function makeStory(overrides: Partial<WgStory> = {}): WgStory {
  return {
    story_key: '31-1',
    epic: '31',
    status: 'planned',
    ...overrides,
  }
}

function makeDep(overrides: Partial<StoryDependency> = {}): StoryDependency {
  return {
    story_key: '31-2',
    depends_on: '31-1',
    dependency_type: 'blocks',
    source: 'explicit',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// upsertStory
// ---------------------------------------------------------------------------

describe('WorkGraphRepository.upsertStory()', () => {
  let db: InMemoryDatabaseAdapter
  let repo: WorkGraphRepository

  beforeEach(async () => {
    db = new InMemoryDatabaseAdapter()
    await createTables(db)
    repo = new WorkGraphRepository(db)
  })

  it('inserts a new story', async () => {
    await repo.upsertStory(makeStory())
    const rows = await db.query<WgStory>(`SELECT * FROM wg_stories`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.story_key).toBe('31-1')
  })

  it('updates an existing story via upsert (only one row after second upsert)', async () => {
    await repo.upsertStory(makeStory({ status: 'planned' }))
    await repo.upsertStory(makeStory({ status: 'in_progress' }))

    const rows = await db.query<WgStory>(`SELECT * FROM wg_stories`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('in_progress')
  })

  it('stores optional fields correctly', async () => {
    await repo.upsertStory(
      makeStory({
        title: 'My Story',
        spec_path: '/docs/story-31-1.md',
        created_at: '2026-01-01 00:00:00',
      })
    )
    const rows = await db.query<WgStory>(`SELECT * FROM wg_stories`)
    expect(rows[0]!.title).toBe('My Story')
    expect(rows[0]!.spec_path).toBe('/docs/story-31-1.md')
  })
})

// ---------------------------------------------------------------------------
// addDependency
// ---------------------------------------------------------------------------

describe('WorkGraphRepository.addDependency()', () => {
  let db: InMemoryDatabaseAdapter
  let repo: WorkGraphRepository

  beforeEach(async () => {
    db = new InMemoryDatabaseAdapter()
    await createTables(db)
    repo = new WorkGraphRepository(db)
  })

  it('inserts a new dependency', async () => {
    await repo.addDependency(makeDep())
    const rows = await db.query<StoryDependency>(`SELECT * FROM story_dependencies`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.story_key).toBe('31-2')
    expect(rows[0]!.depends_on).toBe('31-1')
    expect(rows[0]!.dependency_type).toBe('blocks')
  })

  it('is idempotent — inserting the same dep twice yields one row', async () => {
    await repo.addDependency(makeDep())
    await repo.addDependency(makeDep())
    const rows = await db.query<StoryDependency>(`SELECT * FROM story_dependencies`)
    expect(rows).toHaveLength(1)
  })

  it('stores an informs dependency', async () => {
    await repo.addDependency(makeDep({ dependency_type: 'informs', source: 'inferred' }))
    const rows = await db.query<StoryDependency>(`SELECT * FROM story_dependencies`)
    expect(rows[0]!.dependency_type).toBe('informs')
    expect(rows[0]!.source).toBe('inferred')
  })
})

// ---------------------------------------------------------------------------
// getReadyStories
// ---------------------------------------------------------------------------

describe('WorkGraphRepository.getReadyStories()', () => {
  let db: InMemoryDatabaseAdapter
  let repo: WorkGraphRepository

  beforeEach(async () => {
    db = new InMemoryDatabaseAdapter()
    await createTables(db)
    repo = new WorkGraphRepository(db)
  })

  it('(a) returns a story with no dependencies', async () => {
    await repo.upsertStory(makeStory({ story_key: 'A', epic: '31', status: 'planned' }))
    const ready = await repo.getReadyStories()
    expect(ready.map((s) => s.story_key)).toContain('A')
  })

  it('(b) returns a story whose blocking dep has status=complete', async () => {
    await repo.upsertStory(makeStory({ story_key: 'B1', epic: '31', status: 'complete' }))
    await repo.upsertStory(makeStory({ story_key: 'B2', epic: '31', status: 'planned' }))
    await repo.addDependency({ story_key: 'B2', depends_on: 'B1', dependency_type: 'blocks', source: 'explicit' })

    const ready = await repo.getReadyStories()
    const keys = ready.map((s) => s.story_key)
    expect(keys).toContain('B2')
    expect(keys).not.toContain('B1') // B1 is 'complete', not 'planned'/'ready'
  })

  it('(c) excludes a story whose blocking dep is not complete', async () => {
    await repo.upsertStory(makeStory({ story_key: 'C1', epic: '31', status: 'in_progress' }))
    await repo.upsertStory(makeStory({ story_key: 'C2', epic: '31', status: 'planned' }))
    await repo.addDependency({ story_key: 'C2', depends_on: 'C1', dependency_type: 'blocks', source: 'explicit' })

    const ready = await repo.getReadyStories()
    expect(ready.map((s) => s.story_key)).not.toContain('C2')
  })

  it('(d) does NOT block a story with only an informs dep whose dep is not complete', async () => {
    await repo.upsertStory(makeStory({ story_key: 'D1', epic: '31', status: 'in_progress' }))
    await repo.upsertStory(makeStory({ story_key: 'D2', epic: '31', status: 'planned' }))
    await repo.addDependency({ story_key: 'D2', depends_on: 'D1', dependency_type: 'informs', source: 'inferred' })

    const ready = await repo.getReadyStories()
    expect(ready.map((s) => s.story_key)).toContain('D2')
  })

  it('returns empty list when no stories exist', async () => {
    const ready = await repo.getReadyStories()
    expect(ready).toHaveLength(0)
  })

  it('excludes stories whose status is not planned or ready', async () => {
    await repo.upsertStory(makeStory({ story_key: 'E1', epic: '31', status: 'complete' }))
    await repo.upsertStory(makeStory({ story_key: 'E2', epic: '31', status: 'escalated' }))
    await repo.upsertStory(makeStory({ story_key: 'E3', epic: '31', status: 'ready' }))

    const ready = await repo.getReadyStories()
    const keys = ready.map((s) => s.story_key)
    expect(keys).not.toContain('E1')
    expect(keys).not.toContain('E2')
    expect(keys).toContain('E3')
  })
})

// ---------------------------------------------------------------------------
// updateStoryStatus
// ---------------------------------------------------------------------------

describe('WorkGraphRepository.updateStoryStatus()', () => {
  let db: InMemoryDatabaseAdapter
  let repo: WorkGraphRepository

  beforeEach(async () => {
    db = new InMemoryDatabaseAdapter()
    await createTables(db)
    repo = new WorkGraphRepository(db)
  })

  it('is a no-op when the story key does not exist in wg_stories', async () => {
    // No story inserted — should complete without error
    await expect(repo.updateStoryStatus('99-9', 'in_progress')).resolves.toBeUndefined()
    const rows = await db.query<WgStory>(`SELECT * FROM wg_stories`)
    expect(rows).toHaveLength(0)
  })

  it('transitions an existing story to in_progress', async () => {
    const before = makeStory({ story_key: '31-4', status: 'planned', updated_at: '2026-01-01T00:00:00.000Z' })
    await repo.upsertStory(before)

    await repo.updateStoryStatus('31-4', 'in_progress')

    const rows = await db.query<WgStory>(`SELECT * FROM wg_stories`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('in_progress')
    // updated_at should be a fresh timestamp (not the original value)
    expect(rows[0]!.updated_at).not.toBe('2026-01-01T00:00:00.000Z')
    // completed_at should remain null/undefined for in_progress
    expect(rows[0]!.completed_at).toBeNull()
  })

  it('transitions an existing story to complete and sets completed_at from opts (AC6)', async () => {
    const before = makeStory({
      story_key: '31-4',
      epic: '31',
      title: 'Some title',
      spec_path: '/path/to/spec',
      status: 'in_progress',
    })
    await repo.upsertStory(before)

    await repo.updateStoryStatus('31-4', 'complete', { completedAt: '2026-03-14T10:00:00.000Z' })

    const rows = await db.query<WgStory>(`SELECT * FROM wg_stories`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('complete')
    expect(rows[0]!.completed_at).toBe('2026-03-14T10:00:00.000Z')
    // non-status fields preserved (AC6)
    expect(rows[0]!.title).toBe('Some title')
    expect(rows[0]!.spec_path).toBe('/path/to/spec')
    expect(rows[0]!.epic).toBe('31')
  })

  it('transitions an existing story to escalated and sets completed_at', async () => {
    await repo.upsertStory(makeStory({ story_key: '31-4', status: 'in_progress' }))

    await repo.updateStoryStatus('31-4', 'escalated', { completedAt: '2026-03-14T11:00:00.000Z' })

    const rows = await db.query<WgStory>(`SELECT * FROM wg_stories`)
    expect(rows[0]!.status).toBe('escalated')
    expect(rows[0]!.completed_at).toBe('2026-03-14T11:00:00.000Z')
  })

  it('uses current time for completed_at when opts.completedAt is absent', async () => {
    await repo.upsertStory(makeStory({ story_key: '31-4', status: 'in_progress' }))

    const before = Date.now()
    await repo.updateStoryStatus('31-4', 'complete')
    const after = Date.now()

    const rows = await db.query<WgStory>(`SELECT * FROM wg_stories`)
    const completedAt = rows[0]!.completed_at
    expect(completedAt).toBeTruthy()
    const ts = new Date(completedAt!).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('does not set completed_at when transitioning to in_progress', async () => {
    await repo.upsertStory(makeStory({ story_key: '31-4', status: 'planned', completed_at: undefined }))

    await repo.updateStoryStatus('31-4', 'in_progress')

    const rows = await db.query<WgStory>(`SELECT * FROM wg_stories`)
    expect(rows[0]!.completed_at).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// listStories
// ---------------------------------------------------------------------------

describe('WorkGraphRepository.listStories()', () => {
  let db: InMemoryDatabaseAdapter
  let repo: WorkGraphRepository

  beforeEach(async () => {
    db = new InMemoryDatabaseAdapter()
    await createTables(db)
    repo = new WorkGraphRepository(db)

    await repo.upsertStory(makeStory({ story_key: '31-1', epic: '31', status: 'planned' }))
    await repo.upsertStory(makeStory({ story_key: '31-2', epic: '31', status: 'in_progress' }))
    await repo.upsertStory(makeStory({ story_key: '32-1', epic: '32', status: 'planned' }))
  })

  it('returns all stories when no filter is provided', async () => {
    const stories = await repo.listStories()
    expect(stories).toHaveLength(3)
  })

  it('filters by epic', async () => {
    const stories = await repo.listStories({ epic: '31' })
    expect(stories).toHaveLength(2)
    expect(stories.every((s) => s.epic === '31')).toBe(true)
  })

  it('filters by status', async () => {
    const stories = await repo.listStories({ status: 'planned' })
    expect(stories).toHaveLength(2)
    expect(stories.every((s) => s.status === 'planned')).toBe(true)
  })

  it('filters by both epic and status', async () => {
    const stories = await repo.listStories({ epic: '31', status: 'in_progress' })
    expect(stories).toHaveLength(1)
    expect(stories[0]!.story_key).toBe('31-2')
  })
})

// ---------------------------------------------------------------------------
// addContractDependencies
// ---------------------------------------------------------------------------

describe('WorkGraphRepository.addContractDependencies()', () => {
  let db: InMemoryDatabaseAdapter
  let repo: WorkGraphRepository

  beforeEach(async () => {
    db = new InMemoryDatabaseAdapter()
    // Only story_dependencies is needed — addContractDependencies() does not
    // touch wg_stories.
    await db.exec(`CREATE TABLE IF NOT EXISTS story_dependencies (
      story_key  VARCHAR(20)  NOT NULL,
      depends_on VARCHAR(20)  NOT NULL,
      dependency_type   VARCHAR(20)  NOT NULL,
      source     VARCHAR(20)  NOT NULL,
      created_at DATETIME,
      PRIMARY KEY (story_key, depends_on)
    )`)
    repo = new WorkGraphRepository(db)
  })

  it('AC1: export→import edge persisted as blocks dep with source=contract', async () => {
    await repo.addContractDependencies([
      { from: '31-A', to: '31-B', reason: '31-A exports FooSchema, 31-B imports it' },
    ])
    const rows = await db.query<{ story_key: string; depends_on: string; dependency_type: string; source: string }>(
      'SELECT * FROM story_dependencies',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      story_key: '31-B',
      depends_on: '31-A',
      dependency_type: 'blocks',
      source: 'contract',
    })
  })

  it('AC2: dual-export edge persisted as informs dep', async () => {
    await repo.addContractDependencies([
      { from: '31-A', to: '31-B', reason: 'dual export: 31-A and 31-B both export BarSchema — serialized to prevent conflicting definitions' },
    ])
    const rows = await db.query<{ story_key: string; depends_on: string; dependency_type: string; source: string }>(
      'SELECT * FROM story_dependencies',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      story_key: '31-B',
      depends_on: '31-A',
      dependency_type: 'informs',
      source: 'contract',
    })
  })

  it('AC3: calling twice with the same edges yields exactly one row per (story_key, depends_on) pair', async () => {
    const edges = [
      { from: '31-A', to: '31-B', reason: '31-A exports FooSchema, 31-B imports it' },
    ]
    await repo.addContractDependencies(edges)
    await repo.addContractDependencies(edges)
    const rows = await db.query<{ story_key: string; depends_on: string }>(
      'SELECT * FROM story_dependencies',
    )
    expect(rows).toHaveLength(1)
  })

  it('AC4: empty edge list is a no-op — no error and no rows written', async () => {
    await expect(repo.addContractDependencies([])).resolves.toBeUndefined()
    const rows = await db.query<{ story_key: string }>('SELECT * FROM story_dependencies')
    expect(rows).toHaveLength(0)
  })

  it('persists multiple edges in a single call', async () => {
    await repo.addContractDependencies([
      { from: '31-A', to: '31-B', reason: 'export→import' },
      { from: '31-A', to: '31-C', reason: 'export→import' },
    ])
    const rows = await db.query<{ story_key: string; depends_on: string; dependency_type: string }>(
      'SELECT * FROM story_dependencies',
    )
    expect(rows).toHaveLength(2)
    const targets = rows.map((r) => r.story_key).sort()
    expect(targets).toEqual(['31-B', '31-C'])
    expect(rows.every((r) => r.dependency_type === 'blocks')).toBe(true)
  })

  it('edge with no reason defaults to blocks dependency_type', async () => {
    await repo.addContractDependencies([{ from: '31-A', to: '31-B' }])
    const rows = await db.query<{ dependency_type: string }>('SELECT dependency_type FROM story_dependencies')
    expect(rows[0]!.dependency_type).toBe('blocks')
  })
})

// ---------------------------------------------------------------------------
// detectCycles
// ---------------------------------------------------------------------------

describe('WorkGraphRepository.detectCycles()', () => {
  let db: InMemoryDatabaseAdapter
  let repo: WorkGraphRepository

  beforeEach(async () => {
    db = new InMemoryDatabaseAdapter()
    await db.exec(`CREATE TABLE IF NOT EXISTS story_dependencies (
      story_key  VARCHAR(20)  NOT NULL,
      depends_on VARCHAR(20)  NOT NULL,
      dependency_type   VARCHAR(20)  NOT NULL,
      source     VARCHAR(20)  NOT NULL,
      created_at DATETIME,
      PRIMARY KEY (story_key, depends_on)
    )`)
    repo = new WorkGraphRepository(db)
  })

  it('returns [] for an empty table', async () => {
    const result = await repo.detectCycles()
    expect(result).toEqual([])
  })

  it('returns [] for acyclic blocks deps (linear chain A→B→C)', async () => {
    await db.query(
      `INSERT INTO story_dependencies (story_key, depends_on, dependency_type, source) VALUES (?, ?, ?, ?)`,
      ['31-2', '31-1', 'blocks', 'explicit'],
    )
    await db.query(
      `INSERT INTO story_dependencies (story_key, depends_on, dependency_type, source) VALUES (?, ?, ?, ?)`,
      ['31-3', '31-2', 'blocks', 'explicit'],
    )
    const result = await repo.detectCycles()
    expect(result).toEqual([])
  })

  it('returns non-empty array for a cyclic blocks dep (2-node cycle)', async () => {
    await db.query(
      `INSERT INTO story_dependencies (story_key, depends_on, dependency_type, source) VALUES (?, ?, ?, ?)`,
      ['31-A', '31-B', 'blocks', 'explicit'],
    )
    await db.query(
      `INSERT INTO story_dependencies (story_key, depends_on, dependency_type, source) VALUES (?, ?, ?, ?)`,
      ['31-B', '31-A', 'blocks', 'explicit'],
    )
    const result = await repo.detectCycles()
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain('31-A')
    expect(result).toContain('31-B')
  })

  it('AC5: returns [] when only informs deps form a mutual cycle', async () => {
    // A informs B, B informs A — should NOT be treated as a blocking cycle
    await db.query(
      `INSERT INTO story_dependencies (story_key, depends_on, dependency_type, source) VALUES (?, ?, ?, ?)`,
      ['31-A', '31-B', 'informs', 'inferred'],
    )
    await db.query(
      `INSERT INTO story_dependencies (story_key, depends_on, dependency_type, source) VALUES (?, ?, ?, ?)`,
      ['31-B', '31-A', 'informs', 'inferred'],
    )
    const result = await repo.detectCycles()
    expect(result).toEqual([])
  })

  it('returns [] when informs deps cycle but blocks deps are acyclic', async () => {
    // Cyclic informs deps (should be ignored)
    await db.query(
      `INSERT INTO story_dependencies (story_key, depends_on, dependency_type, source) VALUES (?, ?, ?, ?)`,
      ['31-A', '31-B', 'informs', 'inferred'],
    )
    await db.query(
      `INSERT INTO story_dependencies (story_key, depends_on, dependency_type, source) VALUES (?, ?, ?, ?)`,
      ['31-B', '31-A', 'informs', 'inferred'],
    )
    // Acyclic blocks dep (should be fine)
    await db.query(
      `INSERT INTO story_dependencies (story_key, depends_on, dependency_type, source) VALUES (?, ?, ?, ?)`,
      ['31-C', '31-A', 'blocks', 'explicit'],
    )
    const result = await repo.detectCycles()
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getBlockedStories
// ---------------------------------------------------------------------------

describe('WorkGraphRepository.getBlockedStories()', () => {
  let db: InMemoryDatabaseAdapter
  let repo: WorkGraphRepository

  beforeEach(async () => {
    db = new InMemoryDatabaseAdapter()
    await createTables(db)
    repo = new WorkGraphRepository(db)
  })

  it('returns empty array when no stories exist', async () => {
    const result = await repo.getBlockedStories()
    expect(result).toEqual([])
  })

  it('returns empty array when a planned story has no dependencies', async () => {
    await repo.upsertStory(makeStory({ story_key: 'BS-1', epic: 'BS', status: 'planned' }))
    const result = await repo.getBlockedStories()
    // No deps → nothing blocked
    expect(result).toHaveLength(0)
  })

  it('returns empty array when all blocks deps for a planned story are complete', async () => {
    await repo.upsertStory(makeStory({ story_key: 'BS-1', epic: 'BS', status: 'complete' }))
    await repo.upsertStory(makeStory({ story_key: 'BS-2', epic: 'BS', status: 'planned' }))
    await repo.addDependency({ story_key: 'BS-2', depends_on: 'BS-1', dependency_type: 'blocks', source: 'explicit' })
    const result = await repo.getBlockedStories()
    expect(result).toHaveLength(0)
  })

  it('returns blocked story when it has one incomplete blocks dep', async () => {
    await repo.upsertStory(makeStory({ story_key: 'BS-1', epic: 'BS', status: 'in_progress', title: 'Prereq Story' }))
    await repo.upsertStory(makeStory({ story_key: 'BS-2', epic: 'BS', status: 'planned', title: 'Blocked Story' }))
    await repo.addDependency({ story_key: 'BS-2', depends_on: 'BS-1', dependency_type: 'blocks', source: 'explicit' })

    const result: BlockedStoryInfo[] = await repo.getBlockedStories()
    expect(result).toHaveLength(1)
    expect(result[0]!.story.story_key).toBe('BS-2')
    expect(result[0]!.blockers).toHaveLength(1)
    expect(result[0]!.blockers[0]!.key).toBe('BS-1')
    expect(result[0]!.blockers[0]!.title).toBe('Prereq Story')
    expect(result[0]!.blockers[0]!.status).toBe('in_progress')
  })

  it('includes only incomplete blockers when story has two deps — one complete, one planned', async () => {
    await repo.upsertStory(makeStory({ story_key: 'BS-1', epic: 'BS', status: 'complete', title: 'Done Dep' }))
    await repo.upsertStory(makeStory({ story_key: 'BS-2', epic: 'BS', status: 'planned', title: 'Pending Dep' }))
    await repo.upsertStory(makeStory({ story_key: 'BS-3', epic: 'BS', status: 'planned', title: 'Blocked Story' }))
    await repo.addDependency({ story_key: 'BS-3', depends_on: 'BS-1', dependency_type: 'blocks', source: 'explicit' })
    await repo.addDependency({ story_key: 'BS-3', depends_on: 'BS-2', dependency_type: 'blocks', source: 'explicit' })

    const result: BlockedStoryInfo[] = await repo.getBlockedStories()
    expect(result).toHaveLength(1)
    expect(result[0]!.story.story_key).toBe('BS-3')
    // Only the incomplete dep (BS-2) should appear
    expect(result[0]!.blockers).toHaveLength(1)
    expect(result[0]!.blockers[0]!.key).toBe('BS-2')
  })

  it('excludes in_progress and complete stories from candidates', async () => {
    await repo.upsertStory(makeStory({ story_key: 'BS-1', epic: 'BS', status: 'planned' }))
    await repo.upsertStory(makeStory({ story_key: 'BS-2', epic: 'BS', status: 'in_progress' }))
    await repo.upsertStory(makeStory({ story_key: 'BS-3', epic: 'BS', status: 'complete' }))
    // BS-2 and BS-3 depend on BS-1 (not complete) but are not candidates
    await repo.addDependency({ story_key: 'BS-2', depends_on: 'BS-1', dependency_type: 'blocks', source: 'explicit' })
    await repo.addDependency({ story_key: 'BS-3', depends_on: 'BS-1', dependency_type: 'blocks', source: 'explicit' })

    const result: BlockedStoryInfo[] = await repo.getBlockedStories()
    // Only planned/ready stories are candidates — none here qualify (BS-1 has no incomplete blocking deps)
    expect(result).toHaveLength(0)
  })

  it('informs deps do not cause a story to appear as blocked', async () => {
    await repo.upsertStory(makeStory({ story_key: 'BS-1', epic: 'BS', status: 'planned' }))
    await repo.upsertStory(makeStory({ story_key: 'BS-2', epic: 'BS', status: 'planned' }))
    // informs dep only — should NOT block
    await repo.addDependency({ story_key: 'BS-2', depends_on: 'BS-1', dependency_type: 'informs', source: 'inferred' })

    const result: BlockedStoryInfo[] = await repo.getBlockedStories()
    expect(result).toHaveLength(0)
  })
})
