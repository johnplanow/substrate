// @vitest-environment node
/**
 * Unit tests for EpicIngester.
 *
 * Story 31-2: Epic Doc Ingestion (AC3, AC4, AC6)
 *
 * All database interactions use InMemoryDatabaseAdapter — no Dolt process required.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { EpicIngester } from '../epic-ingester.js'
import { CyclicDependencyError } from '../errors.js'
import { CREATE_STORIES_TABLE, CREATE_STORY_DEPENDENCIES_TABLE } from '../schema.js'
import type { ParsedStory, ParsedDependency } from '../epic-parser.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStory(overrides: Partial<ParsedStory> = {}): ParsedStory {
  return {
    story_key: '31-1',
    epic_num: 31,
    story_num: 1,
    title: 'Schema and Dolt init',
    priority: 'P0',
    size: 'Small',
    sprint: 1,
    ...overrides,
  }
}

function makeDep(overrides: Partial<ParsedDependency> = {}): ParsedDependency {
  return {
    story_key: '31-2',
    depends_on: '31-1',
    dependency_type: 'blocks',
    source: 'explicit',
    ...overrides,
  }
}

const STORY_31_1 = makeStory({ story_key: '31-1', story_num: 1, title: 'Schema and Dolt init' })
const STORY_31_2 = makeStory({ story_key: '31-2', story_num: 2, title: 'Epic doc ingestion', sprint: 1 })
const DEP_31_2_NEEDS_31_1 = makeDep({ story_key: '31-2', depends_on: '31-1' })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedTables(adapter: InMemoryDatabaseAdapter): Promise<void> {
  await adapter.exec(CREATE_STORIES_TABLE)
  await adapter.exec(CREATE_STORY_DEPENDENCIES_TABLE)
}

async function queryAllStories(adapter: InMemoryDatabaseAdapter): Promise<Record<string, unknown>[]> {
  return adapter.query('SELECT * FROM stories')
}

async function queryAllDeps(adapter: InMemoryDatabaseAdapter): Promise<Record<string, unknown>[]> {
  return adapter.query('SELECT * FROM story_dependencies')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EpicIngester', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter()
    await seedTables(adapter)
  })

  // -------------------------------------------------------------------------
  // AC3: Upsert stories
  // -------------------------------------------------------------------------

  describe('story upsert', () => {
    it('inserts new stories with status = "planned"', async () => {
      const ingester = new EpicIngester(adapter)
      await ingester.ingest([STORY_31_1, STORY_31_2], [])

      const rows = await queryAllStories(adapter)
      expect(rows).toHaveLength(2)

      const row1 = rows.find((r) => r['story_key'] === '31-1')
      expect(row1?.['status']).toBe('planned')

      const row2 = rows.find((r) => r['story_key'] === '31-2')
      expect(row2?.['status']).toBe('planned')
    })

    it('storiesUpserted count equals the number of newly inserted stories', async () => {
      const ingester = new EpicIngester(adapter)
      const result = await ingester.ingest([STORY_31_1, STORY_31_2], [])
      expect(result.storiesUpserted).toBe(2)
    })

    it('re-ingesting the same story with changed title updates title but preserves status', async () => {
      const ingester = new EpicIngester(adapter)

      // First ingest — creates story with status='planned'
      await ingester.ingest([STORY_31_1], [])

      // Manually update the status to simulate runtime progress
      await adapter.query(
        "UPDATE stories SET status = 'in-progress' WHERE story_key = '31-1'",
      )

      // Second ingest — same key, updated title
      const updatedStory = { ...STORY_31_1, title: 'Schema v2' }
      await ingester.ingest([updatedStory], [])

      const rows = await queryAllStories(adapter)
      expect(rows).toHaveLength(1)

      const row = rows[0]!
      expect(row['title']).toBe('Schema v2')
      expect(row['status']).toBe('in-progress')
    })

    it('re-ingesting the same story updates priority, size, and sprint', async () => {
      const ingester = new EpicIngester(adapter)
      await ingester.ingest([STORY_31_1], [])

      const updated = { ...STORY_31_1, priority: 'P1', size: 'Large', sprint: 2 }
      await ingester.ingest([updated], [])

      const rows = await queryAllStories(adapter)
      const row = rows.find((r) => r['story_key'] === '31-1')!
      expect(row['priority']).toBe('P1')
      expect(row['size']).toBe('Large')
      expect(row['sprint']).toBe(2)
    })

    it('does not count re-ingested (existing) stories in storiesUpserted', async () => {
      const ingester = new EpicIngester(adapter)
      await ingester.ingest([STORY_31_1], [])

      const result = await ingester.ingest([STORY_31_1], [])
      // Second time: story already exists, no new insertion
      expect(result.storiesUpserted).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Dependency sync
  // -------------------------------------------------------------------------

  describe('dependency sync', () => {
    it('inserts fresh dependencies after stories are ingested', async () => {
      const ingester = new EpicIngester(adapter)
      await ingester.ingest([STORY_31_1, STORY_31_2], [DEP_31_2_NEEDS_31_1])

      const deps = await queryAllDeps(adapter)
      expect(deps).toHaveLength(1)
      expect(deps[0]).toMatchObject({
        story_key: '31-2',
        depends_on: '31-1',
        dependency_type: 'blocks',
        source: 'explicit',
      })
    })

    it('dependenciesReplaced equals the number of dependencies in the current batch', async () => {
      const dep2 = makeDep({ story_key: '31-3', depends_on: '31-2' })
      const ingester = new EpicIngester(adapter)
      const result = await ingester.ingest([STORY_31_1, STORY_31_2], [DEP_31_2_NEEDS_31_1, dep2])
      expect(result.dependenciesReplaced).toBe(2)
    })

    it('running ingest twice with different deps leaves only the second batch', async () => {
      const ingester = new EpicIngester(adapter)

      const dep1 = makeDep({ story_key: '31-2', depends_on: '31-1' })
      const dep2 = makeDep({ story_key: '31-3', depends_on: '31-2' })

      const story3 = makeStory({ story_key: '31-3', story_num: 3 })

      // First ingest: dep1
      await ingester.ingest([STORY_31_1, STORY_31_2], [dep1])

      // Second ingest: dep2 (dep1 is removed)
      await ingester.ingest([STORY_31_1, STORY_31_2, story3], [dep2])

      const deps = await queryAllDeps(adapter)
      expect(deps).toHaveLength(1)
      const row = deps[0]!
      expect(row['story_key']).toBe('31-3')
      expect(row['depends_on']).toBe('31-2')
    })

    it('ingesting with empty dependencies clears all existing explicit deps', async () => {
      const ingester = new EpicIngester(adapter)
      await ingester.ingest([STORY_31_1, STORY_31_2], [DEP_31_2_NEEDS_31_1])

      // Re-ingest with no deps
      await ingester.ingest([STORY_31_1, STORY_31_2], [])

      const deps = await queryAllDeps(adapter)
      expect(deps).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Idempotency
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('identical ingest twice produces the same row counts with no duplicates', async () => {
      const ingester = new EpicIngester(adapter)

      await ingester.ingest([STORY_31_1, STORY_31_2], [DEP_31_2_NEEDS_31_1])
      await ingester.ingest([STORY_31_1, STORY_31_2], [DEP_31_2_NEEDS_31_1])

      const stories = await queryAllStories(adapter)
      const deps = await queryAllDeps(adapter)

      expect(stories).toHaveLength(2)
      expect(deps).toHaveLength(1)
    })

    it('identical ingest twice preserves story status values', async () => {
      const ingester = new EpicIngester(adapter)
      await ingester.ingest([STORY_31_1], [])

      await adapter.query("UPDATE stories SET status = 'done' WHERE story_key = '31-1'")

      await ingester.ingest([STORY_31_1], [])

      const rows = await queryAllStories(adapter)
      expect(rows[0]?.['status']).toBe('done')
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Cycle detection
  // -------------------------------------------------------------------------

  describe('cycle detection', () => {
    it('throws CyclicDependencyError when dependencies contain a cycle', async () => {
      const ingester = new EpicIngester(adapter)
      const cyclicDeps: ParsedDependency[] = [
        { story_key: '31-A', depends_on: '31-B', dependency_type: 'blocks', source: 'explicit' },
        { story_key: '31-B', depends_on: '31-A', dependency_type: 'blocks', source: 'explicit' },
      ]
      await expect(ingester.ingest([STORY_31_1], cyclicDeps)).rejects.toThrow(CyclicDependencyError)
    })

    it('CyclicDependencyError message contains "Cyclic dependency detected"', async () => {
      const ingester = new EpicIngester(adapter)
      const cyclicDeps: ParsedDependency[] = [
        { story_key: '31-A', depends_on: '31-B', dependency_type: 'blocks', source: 'explicit' },
        { story_key: '31-B', depends_on: '31-A', dependency_type: 'blocks', source: 'explicit' },
      ]
      await expect(ingester.ingest([STORY_31_1], cyclicDeps)).rejects.toThrow(
        'Cyclic dependency detected',
      )
    })

    it('no DB rows are written when a cyclic dep set is passed (AC6)', async () => {
      const txSpy = vi.spyOn(adapter, 'transaction')
      const ingester = new EpicIngester(adapter)
      const cyclicDeps: ParsedDependency[] = [
        { story_key: '31-A', depends_on: '31-B', dependency_type: 'blocks', source: 'explicit' },
        { story_key: '31-B', depends_on: '31-A', dependency_type: 'blocks', source: 'explicit' },
      ]

      await expect(ingester.ingest([STORY_31_1], cyclicDeps)).rejects.toThrow(CyclicDependencyError)

      // transaction() must never have been called
      expect(txSpy).not.toHaveBeenCalled()

      // DB must be empty
      const storiesRows = await queryAllStories(adapter)
      const depsRows = await queryAllDeps(adapter)
      expect(storiesRows).toHaveLength(0)
      expect(depsRows).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Transaction wrapping
  // -------------------------------------------------------------------------

  describe('transaction', () => {
    it('wraps both inserts in a single adapter.transaction() call', async () => {
      const txSpy = vi.spyOn(adapter, 'transaction')

      const ingester = new EpicIngester(adapter)
      await ingester.ingest([STORY_31_1], [DEP_31_2_NEEDS_31_1])

      expect(txSpy).toHaveBeenCalledOnce()
    })

    it('rolls back on error — no partial data is committed', async () => {
      // Create an adapter that throws on the second query inside the transaction
      let queryCount = 0
      const faultyAdapter = new InMemoryDatabaseAdapter()
      await faultyAdapter.exec(CREATE_STORIES_TABLE)
      await faultyAdapter.exec(CREATE_STORY_DEPENDENCIES_TABLE)

      const origQuery = faultyAdapter.query.bind(faultyAdapter)
      vi.spyOn(faultyAdapter, 'query').mockImplementation(async (sql, params) => {
        queryCount++
        // Fail on the 2nd query (the dep INSERT)
        if (queryCount === 2) throw new Error('Simulated DB failure')
        return origQuery(sql, params)
      })

      const ingester = new EpicIngester(faultyAdapter)
      await expect(ingester.ingest([STORY_31_1], [DEP_31_2_NEEDS_31_1])).rejects.toThrow(
        'Simulated DB failure',
      )

      // The adapter's transaction() should have rolled back — stories table is empty
      const realAdapter = new InMemoryDatabaseAdapter()
      await realAdapter.exec(CREATE_STORIES_TABLE)
      // No rows were committed
      const rows = await faultyAdapter.query('SELECT * FROM stories')
      expect(rows).toHaveLength(0)
    })
  })
})
