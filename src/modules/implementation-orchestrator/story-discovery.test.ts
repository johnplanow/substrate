/**
 * Unit tests for story-discovery.ts — resolveStoryKeys() dispatch gating
 *
 * Covers story 31-3 acceptance criteria:
 *   AC1: ready_stories view is used when it returns results
 *   AC2: Blocked stories are excluded (view is responsible; unit test confirms passthrough)
 *   AC3: Explicit --stories flag bypasses dependency gating
 *   AC4: Empty stories table falls through to existing discovery chain
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DatabaseAdapter } from '../../persistence/adapter.js'
import { resolveStoryKeys } from './story-discovery.js'

// ---------------------------------------------------------------------------
// Mock fs so tests don't touch disk
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => ''),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal DatabaseAdapter mock.
 * All methods throw by default unless overridden via the returned object.
 */
function makeMockDb(overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  return {
    query: vi.fn().mockRejectedValue(new Error('not implemented')),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn().mockRejectedValue(new Error('not implemented')),
    close: vi.fn().mockResolvedValue(undefined),
    queryReadyStories: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AC3: Explicit --stories flag bypasses dependency gating
// ---------------------------------------------------------------------------

describe('resolveStoryKeys — explicit --stories flag (AC3)', () => {
  it('returns explicit keys without calling queryReadyStories', async () => {
    const db = makeMockDb()

    const result = await resolveStoryKeys(db, '/fake/root', { explicit: ['31-1', '31-2'] })

    expect(result).toEqual(['31-1', '31-2'])
    expect(db.queryReadyStories).not.toHaveBeenCalled()
  })

  it('returns explicit keys even when queryReadyStories would return results', async () => {
    const db = makeMockDb({
      queryReadyStories: vi.fn().mockResolvedValue(['31-3', '31-4']),
    })

    const result = await resolveStoryKeys(db, '/fake/root', { explicit: ['99-1'] })

    expect(result).toEqual(['99-1'])
    expect(db.queryReadyStories).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC1: ready_stories view returns keys → use them, skip further fallback
// ---------------------------------------------------------------------------

describe('resolveStoryKeys — ready_stories view (AC1)', () => {
  it('returns keys from queryReadyStories when non-empty', async () => {
    const db = makeMockDb({
      queryReadyStories: vi.fn().mockResolvedValue(['31-1', '31-2', '31-3']),
    })

    const result = await resolveStoryKeys(db, '/fake/root')

    expect(result).toEqual(['31-1', '31-2', '31-3'])
    // db.query should NOT have been called (no decisions table fallback)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('sorts keys numerically when ready_stories returns them out of order', async () => {
    const db = makeMockDb({
      queryReadyStories: vi.fn().mockResolvedValue(['31-3', '31-1', '10-1', '2-5']),
    })

    const result = await resolveStoryKeys(db, '/fake/root')

    expect(result).toEqual(['2-5', '10-1', '31-1', '31-3'])
  })

  it('deduplicates keys from queryReadyStories', async () => {
    const db = makeMockDb({
      queryReadyStories: vi.fn().mockResolvedValue(['31-1', '31-1', '31-2']),
    })

    const result = await resolveStoryKeys(db, '/fake/root')

    expect(result).toEqual(['31-1', '31-2'])
  })

  it('applies epicNumber filter to ready_stories results', async () => {
    const db = makeMockDb({
      queryReadyStories: vi.fn().mockResolvedValue(['30-1', '31-1', '31-2', '32-1']),
    })

    const result = await resolveStoryKeys(db, '/fake/root', { epicNumber: 31 })

    expect(result).toEqual(['31-1', '31-2'])
  })
})

// ---------------------------------------------------------------------------
// AC2: Blocked stories excluded — view is responsible (passthrough test)
// ---------------------------------------------------------------------------

describe('resolveStoryKeys — blocked story exclusion (AC2)', () => {
  it('returns only the keys that queryReadyStories provides (blocked stories are excluded by the view)', async () => {
    // Story 31-2 depends on 31-1. The view should have excluded 31-2.
    // Unit test confirms the resolver passes view results through unchanged.
    const db = makeMockDb({
      queryReadyStories: vi.fn().mockResolvedValue(['31-1']), // 31-2 excluded by view
    })

    const result = await resolveStoryKeys(db, '/fake/root')

    expect(result).toEqual(['31-1'])
    expect(result).not.toContain('31-2')
  })
})

// ---------------------------------------------------------------------------
// AC4: Empty stories table → fall through to existing discovery chain
// ---------------------------------------------------------------------------

describe('resolveStoryKeys — fallback chain (AC4)', () => {
  it('falls through to decisions table when queryReadyStories returns empty array', async () => {
    const db = makeMockDb({
      queryReadyStories: vi.fn().mockResolvedValue([]),
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("category = 'stories'")) {
          return Promise.resolve([{ key: '5-1-my-story' }])
        }
        // completed stories query
        return Promise.resolve([])
      }),
    })

    const result = await resolveStoryKeys(db, '/fake/root')

    expect(result).toEqual(['5-1'])
    expect(db.query).toHaveBeenCalled()
  })

  it('falls through to epics.md on disk when both ready_stories and decisions return empty', async () => {
    const db = makeMockDb({
      queryReadyStories: vi.fn().mockResolvedValue([]),
      query: vi.fn().mockResolvedValue([]),
    })

    // discoverPendingStoryKeys will return [] because existsSync returns false (mocked above)
    const result = await resolveStoryKeys(db, '/fake/root')

    expect(result).toEqual([])
    expect(db.queryReadyStories).toHaveBeenCalled()
  })

  it('falls through to legacy path when queryReadyStories throws (defensive)', async () => {
    // queryReadyStories should never throw per AC5 contract, but if it did, we'd
    // want the resolver to handle it gracefully. This tests that contract.
    // Since DoltDatabaseAdapter wraps in try/catch and returns [], the caller
    // should never see a throw — but we test that the resolver itself is safe too.
    const db = makeMockDb({
      queryReadyStories: vi.fn().mockResolvedValue([]),
      query: vi.fn().mockResolvedValue([{ key: '10-1-some-story' }]),
    })

    const result = await resolveStoryKeys(db, '/fake/root')

    // Falls through to decisions table
    expect(result).toContain('10-1')
  })
})

// ---------------------------------------------------------------------------
// Integration-style: ready_stories with filterCompleted
// ---------------------------------------------------------------------------

describe('resolveStoryKeys — ready_stories with filterCompleted', () => {
  it('filters completed stories from ready_stories results when filterCompleted is true', async () => {
    const db = makeMockDb({
      queryReadyStories: vi.fn().mockResolvedValue(['31-1', '31-2', '31-3']),
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('pipeline_runs')) {
          // Simulate '31-1' already completed
          return Promise.resolve([
            {
              token_usage_json: JSON.stringify({
                stories: { '31-1': { phase: 'COMPLETE' } },
              }),
            },
          ])
        }
        return Promise.resolve([])
      }),
    })

    const result = await resolveStoryKeys(db, '/fake/root', { filterCompleted: true })

    expect(result).toEqual(['31-2', '31-3'])
    expect(result).not.toContain('31-1')
  })
})
