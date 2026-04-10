/**
 * Unit tests for DoltDatabaseAdapter.queryReadyStories()
 *
 * Covers story 31-3 acceptance criteria:
 *   AC5: queryReadyStories() returns string[] from ready_stories view on success
 *   AC5: on SQL error (e.g., view missing), returns [] without throwing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DoltDatabaseAdapter } from './dolt-adapter.js'
import type { DoltClient } from '../modules/state/dolt-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal DoltClient mock.
 */
function makeMockClient(overrides: Partial<DoltClient> = {}): DoltClient {
  return {
    query: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as DoltClient
}

// ---------------------------------------------------------------------------
// AC5: happy path — returns story keys from ready_stories view
// ---------------------------------------------------------------------------

describe('DoltDatabaseAdapter.queryReadyStories() — happy path (AC5)', () => {
  it('returns string[] of keys from the ready_stories view', async () => {
    const client = makeMockClient({
      query: vi.fn().mockResolvedValue([{ key: '31-1' }, { key: '31-2' }, { key: '31-3' }]),
    })
    const adapter = new DoltDatabaseAdapter(client)

    const result = await adapter.queryReadyStories()

    expect(result).toEqual(['31-1', '31-2', '31-3'])
  })

  it('calls the correct SQL query on the DoltClient', async () => {
    const mockQuery = vi.fn().mockResolvedValue([])
    const client = makeMockClient({ query: mockQuery })
    const adapter = new DoltDatabaseAdapter(client)

    await adapter.queryReadyStories()

    expect(mockQuery).toHaveBeenCalledOnce()
    const [sql] = mockQuery.mock.calls[0] as [string, unknown]
    expect(sql).toContain('ready_stories')
    expect(sql).toMatch(/SELECT\s+`key`\s+FROM\s+ready_stories/i)
  })

  it('returns an empty array when the view returns no rows', async () => {
    const client = makeMockClient({
      query: vi.fn().mockResolvedValue([]),
    })
    const adapter = new DoltDatabaseAdapter(client)

    const result = await adapter.queryReadyStories()

    expect(result).toEqual([])
  })

  it('correctly maps the key column from each row', async () => {
    const client = makeMockClient({
      query: vi.fn().mockResolvedValue([
        { key: '10-1', status: 'planned', title: 'Some Story' },
        { key: '10-2', status: 'ready', title: 'Another Story' },
      ]),
    })
    const adapter = new DoltDatabaseAdapter(client)

    const result = await adapter.queryReadyStories()

    expect(result).toEqual(['10-1', '10-2'])
  })
})

// ---------------------------------------------------------------------------
// AC5: error path — returns [] without throwing
// ---------------------------------------------------------------------------

describe('DoltDatabaseAdapter.queryReadyStories() — error path (AC5)', () => {
  it('returns [] when the query throws (e.g., view does not exist)', async () => {
    const client = makeMockClient({
      query: vi.fn().mockRejectedValue(new Error("Table 'ready_stories' doesn't exist")),
    })
    const adapter = new DoltDatabaseAdapter(client)

    const result = await adapter.queryReadyStories()

    expect(result).toEqual([])
  })

  it('does not re-throw on SQL errors', async () => {
    const client = makeMockClient({
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    })
    const adapter = new DoltDatabaseAdapter(client)

    await expect(adapter.queryReadyStories()).resolves.toEqual([])
  })

  it('returns [] when the stories table is empty (view returns no rows)', async () => {
    // Empty result (not an error) — stories table populated but all rows blocked
    const client = makeMockClient({
      query: vi.fn().mockResolvedValue([]),
    })
    const adapter = new DoltDatabaseAdapter(client)

    const result = await adapter.queryReadyStories()

    expect(result).toEqual([])
  })
})
