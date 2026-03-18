/**
 * Contract test suite for DatabaseAdapter implementations.
 *
 * All adapters (Dolt-mocked, InMemory) are tested against the
 * same interface expectations: basic query, parameterised query, exec DDL,
 * transaction commit, transaction rollback, and close.
 *
 * DoltDatabaseAdapter:   tested with a mocked DoltClient (verifies delegation).
 * InMemoryDatabaseAdapter: tested directly (verifies behaviour).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import type { DatabaseAdapter } from '../adapter.js'
import { isSyncAdapter } from '../adapter.js'
import { DoltDatabaseAdapter } from '../dolt-adapter.js'
import { InMemoryDatabaseAdapter } from '../memory-adapter.js'
import { initSchema } from '../schema.js'
import type { DoltClient } from '../../modules/state/dolt-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mocked DoltClient object suitable for DoltDatabaseAdapter tests. */
function makeMockedDoltClient() {
  return {
    query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>(),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// CREATE TABLE DDL used by DoltDatabaseAdapter and InMemoryDatabaseAdapter
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS contract_items (id INTEGER, name TEXT, score REAL)'

// ---------------------------------------------------------------------------
// DoltDatabaseAdapter contract tests (mocked DoltClient)
// ---------------------------------------------------------------------------

describe('DoltDatabaseAdapter contract (mocked DoltClient)', () => {
  let mockClient: ReturnType<typeof makeMockedDoltClient>
  let adapter: DoltDatabaseAdapter

  beforeEach(() => {
    mockClient = makeMockedDoltClient()
    adapter = new DoltDatabaseAdapter(mockClient as unknown as DoltClient)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('query — delegates to DoltClient.query() and returns rows', async () => {
    const mockRows = [{ id: 1, name: 'Alice', score: 9.5 }]
    mockClient.query.mockResolvedValue(mockRows)

    const rows = await adapter.query<{ id: number; name: string; score: number }>(
      'SELECT * FROM contract_items',
    )
    expect(mockClient.query).toHaveBeenCalledWith('SELECT * FROM contract_items', undefined)
    expect(rows).toEqual(mockRows)
  })

  it('query — passes parameter array to DoltClient.query()', async () => {
    const mockRows = [{ id: 2, name: 'Bob' }]
    mockClient.query.mockResolvedValue(mockRows)

    await adapter.query('SELECT * FROM contract_items WHERE id = ?', [2])
    expect(mockClient.query).toHaveBeenCalledWith('SELECT * FROM contract_items WHERE id = ?', [2])
  })

  it('query — returns empty array when DoltClient returns no rows', async () => {
    mockClient.query.mockResolvedValue([])
    const rows = await adapter.query('SELECT * FROM contract_items WHERE id = ?', [999])
    expect(rows).toEqual([])
  })

  it('exec — delegates DDL to DoltClient.query() with no params', async () => {
    mockClient.query.mockResolvedValue([])
    await adapter.exec(CREATE_TABLE_SQL)
    expect(mockClient.query).toHaveBeenCalledWith(CREATE_TABLE_SQL, undefined)
  })

  it('transaction — issues BEGIN then COMMIT on success', async () => {
    mockClient.query.mockResolvedValue([])

    const result = await adapter.transaction(async (a) => {
      await a.exec("INSERT INTO contract_items VALUES (1, 'Alice', 9.5)")
      return 'done'
    })

    expect(result).toBe('done')
    const calls = mockClient.query.mock.calls.map((c) => c[0])
    expect(calls[0]).toBe('BEGIN')
    expect(calls[calls.length - 1]).toBe('COMMIT')
  })

  it('transaction — issues BEGIN then ROLLBACK on error', async () => {
    mockClient.query.mockResolvedValue([])

    await expect(
      adapter.transaction(async () => {
        throw new Error('forced failure')
      }),
    ).rejects.toThrow('forced failure')

    const calls = mockClient.query.mock.calls.map((c) => c[0])
    expect(calls[0]).toBe('BEGIN')
    expect(calls[calls.length - 1]).toBe('ROLLBACK')
  })

  it('close — delegates to DoltClient.close()', async () => {
    await adapter.close()
    expect(mockClient.close).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// InMemoryDatabaseAdapter contract tests
// ---------------------------------------------------------------------------

describe('InMemoryDatabaseAdapter contract', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter()
    await adapter.exec(CREATE_TABLE_SQL)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('query — returns rows inserted via exec', async () => {
    await adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (1, 'Alice', 9.5)")
    const rows = await adapter.query<{ id: number; name: string; score: number }>(
      'SELECT * FROM contract_items',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 1, name: 'Alice', score: 9.5 })
  })

  it('query — accepts parameterised queries and filters rows', async () => {
    await adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (2, 'Bob', 7.0)")
    await adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (3, 'Carol', 8.0)")

    const rows = await adapter.query<{ id: number; name: string }>(
      'SELECT * FROM contract_items WHERE id = ?',
      [2],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Bob')
  })

  it('query — evaluates literal SELECT without FROM', async () => {
    const rows = await adapter.query<{ one: number; greeting: string }>(
      "SELECT 1 AS one, 'hello' AS greeting",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.one).toBe(1)
    expect(rows[0]!.greeting).toBe('hello')
  })

  it('query — returns empty array when no rows match', async () => {
    const rows = await adapter.query('SELECT * FROM contract_items WHERE id = ?', [999])
    expect(rows).toEqual([])
  })

  it('exec — creates a table (DDL)', async () => {
    await expect(adapter.exec('CREATE TABLE IF NOT EXISTS tmp (x INTEGER)')).resolves.toBeUndefined()
    // Insert into the newly created table to confirm it exists
    await expect(adapter.exec('INSERT INTO tmp (x) VALUES (42)')).resolves.toBeUndefined()
    const rows = await adapter.query<{ x: number }>('SELECT * FROM tmp')
    expect(rows[0]!.x).toBe(42)
  })

  it('exec — inserts rows without error', async () => {
    await expect(
      adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (10, 'Dan', 6.0)"),
    ).resolves.toBeUndefined()
    const rows = await adapter.query('SELECT * FROM contract_items')
    expect(rows).toHaveLength(1)
  })

  it('transaction — commits changes on success', async () => {
    const result = await adapter.transaction(async (a) => {
      await a.exec("INSERT INTO contract_items (id, name, score) VALUES (20, 'Eve', 5.0)")
      const rows = await a.query<{ id: number }>('SELECT * FROM contract_items WHERE id = ?', [20])
      return rows[0]!.id
    })

    expect(result).toBe(20)
    const rows = await adapter.query('SELECT * FROM contract_items WHERE id = ?', [20])
    expect(rows).toHaveLength(1)
  })

  it('transaction — rolls back all changes on error', async () => {
    await expect(
      adapter.transaction(async (a) => {
        await a.exec("INSERT INTO contract_items (id, name, score) VALUES (30, 'Frank', 4.0)")
        throw new Error('intentional rollback')
      }),
    ).rejects.toThrow('intentional rollback')

    const rows = await adapter.query('SELECT * FROM contract_items WHERE id = ?', [30])
    expect(rows).toHaveLength(0)
  })

  it('transaction — nested INSERT in transaction is visible inside fn', async () => {
    await adapter.transaction(async (a) => {
      await a.exec("INSERT INTO contract_items (id, name, score) VALUES (40, 'Grace', 3.0)")
      const inner = await a.query<{ id: number }>('SELECT * FROM contract_items WHERE id = ?', [40])
      expect(inner).toHaveLength(1)
    })
  })

  it('close — clears all tables without error', async () => {
    await adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (50, 'Henry', 2.0)")
    await expect(adapter.close()).resolves.toBeUndefined()
    // After close, tables are cleared; a new exec on closed adapter should not throw
    // (tables are reset, not "locked")
  })
})

// ---------------------------------------------------------------------------
// InMemoryDatabaseAdapter SyncAdapter contract tests
// ---------------------------------------------------------------------------

describe('InMemoryDatabaseAdapter SyncAdapter contract', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter()
    await adapter.exec(CREATE_TABLE_SQL)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('isSyncAdapter — returns true for InMemoryDatabaseAdapter', () => {
    expect(isSyncAdapter(adapter)).toBe(true)
  })

  it('querySync — returns same results as async query for SELECT', async () => {
    await adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (1, 'Alice', 9.5)")
    await adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (2, 'Bob', 7.0)")

    const asyncRows = await adapter.query<{ id: number; name: string; score: number }>(
      'SELECT * FROM contract_items WHERE id = ?', [1],
    )
    const syncRows = adapter.querySync<{ id: number; name: string; score: number }>(
      'SELECT * FROM contract_items WHERE id = ?', [1],
    )

    expect(syncRows).toHaveLength(1)
    expect(syncRows[0]).toMatchObject({ id: 1, name: 'Alice', score: 9.5 })
    expect(syncRows).toEqual(asyncRows)
  })

  it('execSync — creates a table via DDL', () => {
    adapter.execSync('CREATE TABLE IF NOT EXISTS sync_tmp (x INTEGER)')
    adapter.execSync('INSERT INTO sync_tmp (x) VALUES (99)')
    const rows = adapter.querySync<{ x: number }>('SELECT * FROM sync_tmp')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.x).toBe(99)
  })

  it('execSync — inserts and queries data consistently with async path', async () => {
    adapter.execSync("INSERT INTO contract_items (id, name, score) VALUES (10, 'Dan', 6.0)")
    const rows = await adapter.query<{ id: number }>('SELECT * FROM contract_items WHERE id = ?', [10])
    expect(rows).toHaveLength(1)
  })

  it('initSchema — completes without error on a fresh InMemoryDatabaseAdapter', async () => {
    const freshAdapter = new InMemoryDatabaseAdapter()
    await expect(initSchema(freshAdapter)).resolves.toBeUndefined()
    await freshAdapter.close()
  })

  it('GROUP BY — COUNT(*) returns correct per-group row counts', async () => {
    await adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (1, 'Alice', 9.5)")
    await adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (2, 'Alice', 8.0)")
    await adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (3, 'Bob', 7.0)")

    const rows = adapter.querySync<{ name: string; cnt: number }>(
      'SELECT name, COUNT(*) AS cnt FROM contract_items GROUP BY name',
    )

    expect(rows).toHaveLength(2)
    const alice = rows.find((r) => r.name === 'Alice')!
    const bob = rows.find((r) => r.name === 'Bob')!
    expect(alice.cnt).toBe(2)
    expect(bob.cnt).toBe(1)
  })

  it('GROUP BY — SUM aggregation returns correct grouped totals', async () => {
    await adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (1, 'Alice', 9.5)")
    await adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (2, 'Alice', 0.5)")
    await adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (3, 'Bob', 7.0)")

    const rows = adapter.querySync<{ name: string; total: number }>(
      'SELECT name, SUM(score) AS total FROM contract_items GROUP BY name',
    )

    expect(rows).toHaveLength(2)
    const alice = rows.find((r) => r.name === 'Alice')!
    const bob = rows.find((r) => r.name === 'Bob')!
    expect(alice.total).toBe(10)
    expect(bob.total).toBe(7)
  })

  it('GROUP BY — SUM(CASE WHEN ...) computes conditional sums per group', async () => {
    // Simulate the rebuildAggregates pattern
    adapter.execSync(`
      CREATE TABLE IF NOT EXISTS task_events (
        agent TEXT NOT NULL,
        task_type TEXT NOT NULL,
        outcome TEXT NOT NULL
      )
    `)
    adapter.execSync("INSERT INTO task_events (agent, task_type, outcome) VALUES ('devAgent', 'dev-story', 'success')")
    adapter.execSync("INSERT INTO task_events (agent, task_type, outcome) VALUES ('devAgent', 'dev-story', 'success')")
    adapter.execSync("INSERT INTO task_events (agent, task_type, outcome) VALUES ('devAgent', 'dev-story', 'failure')")
    adapter.execSync("INSERT INTO task_events (agent, task_type, outcome) VALUES ('qaAgent', 'qa-story', 'success')")

    const rows = adapter.querySync<{
      agent: string
      task_type: string
      total: number
      successes: number
      failures: number
    }>(
      `SELECT
         agent,
         task_type,
         COUNT(*) AS total,
         SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes,
         SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failures
       FROM task_events
       GROUP BY agent, task_type`,
    )

    expect(rows).toHaveLength(2)
    const dev = rows.find((r) => r.agent === 'devAgent')!
    const qa = rows.find((r) => r.agent === 'qaAgent')!
    expect(dev.total).toBe(3)
    expect(dev.successes).toBe(2)
    expect(dev.failures).toBe(1)
    expect(qa.total).toBe(1)
    expect(qa.successes).toBe(1)
    expect(qa.failures).toBe(0)
  })

  it('GROUP BY — COALESCE(SUM(col), 0) returns 0 for null sums', async () => {
    adapter.execSync(`
      CREATE TABLE IF NOT EXISTS null_test (
        grp TEXT NOT NULL,
        val INTEGER
      )
    `)
    adapter.execSync("INSERT INTO null_test (grp, val) VALUES ('a', NULL)")
    adapter.execSync("INSERT INTO null_test (grp, val) VALUES ('b', 5)")

    const rows = adapter.querySync<{ grp: string; total: number }>(
      'SELECT grp, COALESCE(SUM(val), 0) AS total FROM null_test GROUP BY grp',
    )

    expect(rows).toHaveLength(2)
    const a = rows.find((r) => r.grp === 'a')!
    const b = rows.find((r) => r.grp === 'b')!
    expect(a.total).toBe(0)
    expect(b.total).toBe(5)
  })
})
