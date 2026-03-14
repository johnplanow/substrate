// @vitest-environment node
/**
 * Unit tests for WorkGraphRepository.
 *
 * Uses InMemoryDatabaseAdapter as the test backend — no real database required.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { WorkGraphRepository } from '../work-graph-repository.js'
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
    dep_type   VARCHAR(20)  NOT NULL,
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
    dep_type: 'blocks',
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
    expect(rows[0]!.dep_type).toBe('blocks')
  })

  it('is idempotent — inserting the same dep twice yields one row', async () => {
    await repo.addDependency(makeDep())
    await repo.addDependency(makeDep())
    const rows = await db.query<StoryDependency>(`SELECT * FROM story_dependencies`)
    expect(rows).toHaveLength(1)
  })

  it('stores an informs dependency', async () => {
    await repo.addDependency(makeDep({ dep_type: 'informs', source: 'inferred' }))
    const rows = await db.query<StoryDependency>(`SELECT * FROM story_dependencies`)
    expect(rows[0]!.dep_type).toBe('informs')
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
    await repo.addDependency({ story_key: 'B2', depends_on: 'B1', dep_type: 'blocks', source: 'explicit' })

    const ready = await repo.getReadyStories()
    const keys = ready.map((s) => s.story_key)
    expect(keys).toContain('B2')
    expect(keys).not.toContain('B1') // B1 is 'complete', not 'planned'/'ready'
  })

  it('(c) excludes a story whose blocking dep is not complete', async () => {
    await repo.upsertStory(makeStory({ story_key: 'C1', epic: '31', status: 'in_progress' }))
    await repo.upsertStory(makeStory({ story_key: 'C2', epic: '31', status: 'planned' }))
    await repo.addDependency({ story_key: 'C2', depends_on: 'C1', dep_type: 'blocks', source: 'explicit' })

    const ready = await repo.getReadyStories()
    expect(ready.map((s) => s.story_key)).not.toContain('C2')
  })

  it('(d) does NOT block a story with only an informs dep whose dep is not complete', async () => {
    await repo.upsertStory(makeStory({ story_key: 'D1', epic: '31', status: 'in_progress' }))
    await repo.upsertStory(makeStory({ story_key: 'D2', epic: '31', status: 'planned' }))
    await repo.addDependency({ story_key: 'D2', depends_on: 'D1', dep_type: 'informs', source: 'inferred' })

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
