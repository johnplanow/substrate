/**
 * Contract test suite for DatabaseAdapter implementations.
 *
 * All three adapters (Sqlite, Dolt-mocked, InMemory) are tested against the
 * same interface expectations: basic query, parameterised query, exec DDL,
 * transaction commit, transaction rollback, and close.
 *
 * SqliteDatabaseAdapter: tested against a real better-sqlite3 in-memory DB.
 * DoltDatabaseAdapter:   tested with a mocked DoltClient (verifies delegation).
 * InMemoryDatabaseAdapter: tested directly (verifies behaviour).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

import type { DatabaseAdapter } from '../adapter.js'
import { SyncDatabaseAdapter } from '../wasm-sqlite-adapter.js'
import { DoltDatabaseAdapter } from '../dolt-adapter.js'
import { InMemoryDatabaseAdapter } from '../memory-adapter.js'
import type { DoltClient } from '../../modules/state/dolt-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open an in-memory SQLite database ready for testing. */
function openSqliteDb() {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

/** Build a mocked DoltClient object suitable for DoltDatabaseAdapter tests. */
function makeMockedDoltClient() {
  return {
    query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>(),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// CREATE TABLE DDL used by SqliteDatabaseAdapter and InMemoryDatabaseAdapter
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS contract_items (id INTEGER, name TEXT, score REAL)'

// ---------------------------------------------------------------------------
// SqliteDatabaseAdapter contract tests
// ---------------------------------------------------------------------------

describe('SyncDatabaseAdapter contract', () => {
  let rawDb: ReturnType<typeof openSqliteDb>
  let adapter: DatabaseAdapter

  beforeEach(() => {
    rawDb = openSqliteDb()
    adapter = new SyncDatabaseAdapter(rawDb)
    rawDb.exec(CREATE_TABLE_SQL)
  })

  afterEach(async () => {
    try {
      rawDb.close()
    } catch {
      // Already closed
    }
  })

  it('query — returns rows from a SELECT', async () => {
    rawDb.exec("INSERT INTO contract_items (id, name, score) VALUES (1, 'Alice', 9.5)")
    const rows = await adapter.query<{ id: number; name: string; score: number }>(
      'SELECT * FROM contract_items',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 1, name: 'Alice', score: 9.5 })
  })

  it('query — accepts parameterised queries', async () => {
    rawDb.exec("INSERT INTO contract_items (id, name, score) VALUES (2, 'Bob', 7.0)")
    rawDb.exec("INSERT INTO contract_items (id, name, score) VALUES (3, 'Carol', 8.0)")

    const rows = await adapter.query<{ id: number; name: string }>(
      'SELECT id, name FROM contract_items WHERE id = ?',
      [2],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Bob')
  })

  it('query — returns empty array when no rows match', async () => {
    const rows = await adapter.query('SELECT * FROM contract_items WHERE id = ?', [999])
    expect(rows).toEqual([])
  })

  it('exec — executes DDL without error', async () => {
    await expect(adapter.exec('CREATE TABLE IF NOT EXISTS tmp_test (x INTEGER)')).resolves.toBeUndefined()
    // Verify table exists
    const rows = rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tmp_test'")
      .all()
    expect(rows).toHaveLength(1)
  })

  it('exec — executes DML without returning rows', async () => {
    await expect(
      adapter.exec("INSERT INTO contract_items (id, name, score) VALUES (10, 'Dan', 6.0)"),
    ).resolves.toBeUndefined()
    const count = (rawDb.prepare('SELECT COUNT(*) AS n FROM contract_items').get() as { n: number }).n
    expect(count).toBe(1)
  })

  it('transaction — commits changes on success', async () => {
    const result = await adapter.transaction(async (a) => {
      await a.exec("INSERT INTO contract_items (id, name, score) VALUES (20, 'Eve', 5.0)")
      const rows = await a.query<{ id: number }>('SELECT id FROM contract_items WHERE id = 20')
      return rows[0]!.id
    })

    expect(result).toBe(20)
    const count = (rawDb.prepare('SELECT COUNT(*) AS n FROM contract_items WHERE id = 20').get() as { n: number }).n
    expect(count).toBe(1)
  })

  it('transaction — rolls back changes on error', async () => {
    await expect(
      adapter.transaction(async (a) => {
        await a.exec("INSERT INTO contract_items (id, name, score) VALUES (30, 'Frank', 4.0)")
        throw new Error('intentional rollback')
      }),
    ).rejects.toThrow('intentional rollback')

    const count = (rawDb.prepare('SELECT COUNT(*) AS n FROM contract_items WHERE id = 30').get() as { n: number }).n
    expect(count).toBe(0)
  })

  it('close — closes the database without error', async () => {
    await expect(adapter.close()).resolves.toBeUndefined()
  })
})

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
