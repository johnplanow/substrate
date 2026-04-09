/**
 * Unit tests for DoltDatabaseAdapter transaction() + DoltClient.transact()
 *
 * Story 53-14 acceptance criteria:
 *   AC1: Pool-mode transactions use a dedicated connection (no query scatter)
 *   AC2: CLI-mode transactions use a single batched dolt sql invocation
 *   AC4: Existing DoltDatabaseAdapter.transaction() call sites unchanged
 */

import { describe, it, expect, vi } from 'vitest'
import { DoltDatabaseAdapter } from './dolt-adapter.js'
import type { DoltClientLike } from './dolt-adapter.js'
import { DoltClient } from './dolt-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock DoltClientLike that includes both query() and transact(). */
function makeMockClient(overrides: Partial<DoltClientLike> = {}): DoltClientLike {
  return {
    query: vi.fn().mockResolvedValue([]),
    transact: vi.fn().mockImplementation(
      async (fn: (q: <R>(sql: string, p?: unknown[]) => Promise<R[]>) => Promise<unknown>) => {
        const txQuery = <R>(_sql: string, _params?: unknown[]): Promise<R[]> =>
          Promise.resolve([] as R[])
        return fn(txQuery)
      },
    ),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AC1: Pool-mode — dedicated connection, BEGIN + COMMIT on same conn
// ---------------------------------------------------------------------------

describe('DoltClient.transact() — pool mode (AC1)', () => {
  function makeClientWithMockPool() {
    const mockConn = {
      execute: vi.fn().mockResolvedValue([[], []]),
      release: vi.fn(),
    }
    const mockPool = {
      getConnection: vi.fn().mockResolvedValue(mockConn),
    }

    const client = new DoltClient({ repoPath: '/tmp/fake-repo' })
    // @ts-expect-error - private field injection for test
    client._pool = mockPool
    // @ts-expect-error - private field injection for test
    client._useCliMode = false
    // @ts-expect-error - private field injection for test
    client._connected = true

    return { client, mockConn, mockPool }
  }

  it('executes BEGIN, user queries, and COMMIT on the same connection', async () => {
    const { client, mockConn, mockPool } = makeClientWithMockPool()

    const executedSql: string[] = []
    mockConn.execute.mockImplementation(async (sql: string) => {
      executedSql.push(sql)
      return [[], []]
    })

    await client.transact(async (txQuery) => {
      await txQuery<{ id: number }>('INSERT INTO foo VALUES (1)')
      await txQuery<{ id: number }>('INSERT INTO foo VALUES (2)')
    })

    // All calls go through the same connection object
    expect(executedSql).toEqual([
      'BEGIN',
      'INSERT INTO foo VALUES (1)',
      'INSERT INTO foo VALUES (2)',
      'COMMIT',
    ])
    // Exactly one connection was acquired
    expect(mockPool.getConnection).toHaveBeenCalledOnce()
    // Connection is released in finally
    expect(mockConn.release).toHaveBeenCalledOnce()
  })

  it('issues ROLLBACK and releases connection when fn() throws', async () => {
    const { client, mockConn } = makeClientWithMockPool()

    const executedSql: string[] = []
    mockConn.execute.mockImplementation(async (sql: string) => {
      executedSql.push(sql)
      return [[], []]
    })

    await expect(
      client.transact(async () => {
        throw new Error('forced failure')
      }),
    ).rejects.toThrow('forced failure')

    expect(executedSql).toContain('ROLLBACK')
    expect(executedSql).not.toContain('COMMIT')
    // Connection must be released even on error
    expect(mockConn.release).toHaveBeenCalledOnce()
  })

  it('two concurrent transactions acquire separate connections (no query interleaving)', async () => {
    const connA = {
      execute: vi.fn().mockResolvedValue([[], []]),
      release: vi.fn(),
    }
    const connB = {
      execute: vi.fn().mockResolvedValue([[], []]),
      release: vi.fn(),
    }
    let acquireCount = 0
    const mockPool = {
      getConnection: vi.fn().mockImplementation(() => {
        acquireCount++
        return Promise.resolve(acquireCount === 1 ? connA : connB)
      }),
    }

    const client = new DoltClient({ repoPath: '/tmp/fake-repo' })
    // @ts-expect-error - private field injection for test
    client._pool = mockPool
    // @ts-expect-error - private field injection for test
    client._useCliMode = false
    // @ts-expect-error - private field injection for test
    client._connected = true

    // Run both transactions concurrently
    await Promise.all([
      client.transact(async (txQuery) => {
        await txQuery('INSERT INTO t1 VALUES (1)')
      }),
      client.transact(async (txQuery) => {
        await txQuery('INSERT INTO t2 VALUES (2)')
      }),
    ])

    // Two separate connections were acquired
    expect(mockPool.getConnection).toHaveBeenCalledTimes(2)

    // connA contains only t1 SQL; connB contains only t2 SQL
    const sqlA = connA.execute.mock.calls.map((c) => c[0] as string)
    const sqlB = connB.execute.mock.calls.map((c) => c[0] as string)

    expect(sqlA).toContain('INSERT INTO t1 VALUES (1)')
    expect(sqlA).not.toContain('INSERT INTO t2 VALUES (2)')
    expect(sqlB).toContain('INSERT INTO t2 VALUES (2)')
    expect(sqlB).not.toContain('INSERT INTO t1 VALUES (1)')
  })
})

// ---------------------------------------------------------------------------
// AC2: CLI mode — batch statement collection + single dolt invocation
// ---------------------------------------------------------------------------

describe('DoltClient.transact() — CLI mode (AC2)', () => {
  function makeCliClient() {
    const client = new DoltClient({ repoPath: '/tmp/dolt-repo' })
    // @ts-expect-error - private field injection for test
    client._useCliMode = true
    // @ts-expect-error - private field injection for test
    client._connected = true
    return client
  }

  it('does NOT call query() for statements within transact() — they are collected', async () => {
    const client = makeCliClient()
    const querySpy = vi.spyOn(client, 'query')

    // Stub _withCliLock to avoid actual dolt binary invocation by assigning a no-op
    const lockStub = vi.fn().mockResolvedValue(undefined)
    // @ts-expect-error - override private method for test
    client._withCliLock = lockStub

    await client.transact(async (txQuery) => {
      await txQuery('INSERT INTO foo VALUES (1)')
      await txQuery('INSERT INTO foo VALUES (2)')
    })

    // query() must NOT be called — statements are batched, not individually dispatched
    expect(querySpy).not.toHaveBeenCalled()
    // _withCliLock WAS called once (the single batch invocation)
    expect(lockStub).toHaveBeenCalledOnce()
  })

  it('assembles BEGIN/.../COMMIT batch and invokes _withCliLock exactly once', async () => {
    const client = makeCliClient()
    let capturedBatchSql: string | undefined

    // Execute the inner fn so we can inspect the batch SQL.
    // runExecFile will throw (no real dolt binary), but DoltQueryError
    // exposes the batch SQL via its .sql property — capture it and swallow
    // the error so that transact() can return normally.
    const lockStub = vi.fn().mockImplementation(async (fn: () => Promise<void>) => {
      try {
        await fn()
      } catch (err: unknown) {
        if (err instanceof Error && 'sql' in err) {
          capturedBatchSql = (err as { sql: string }).sql
        }
        // Swallow error to allow transact() to complete normally
      }
    })
    // @ts-expect-error - override private method for test
    client._withCliLock = lockStub

    await client.transact(async (txQuery) => {
      await txQuery("INSERT INTO foo (id) VALUES (1)")
      await txQuery("INSERT INTO foo (id) VALUES (2)")
    })

    // Single batch invocation regardless of statement count
    expect(lockStub).toHaveBeenCalledOnce()

    // The batch SQL must wrap all statements with BEGIN and COMMIT in order
    expect(capturedBatchSql).toBe(
      "BEGIN; INSERT INTO foo (id) VALUES (1); INSERT INTO foo (id) VALUES (2); COMMIT"
    )
  })

  it('does NOT call _withCliLock when fn() issues zero statements', async () => {
    const client = makeCliClient()

    const lockStub = vi.fn().mockResolvedValue(undefined)
    // @ts-expect-error - override private method for test
    client._withCliLock = lockStub

    const result = await client.transact(async () => {
      // No SQL statements
      return 'empty'
    })

    expect(lockStub).not.toHaveBeenCalled()
    expect(result).toBe('empty')
  })

  it('CLI-mode transact() rejects when the batch dolt invocation fails', async () => {
    const client = makeCliClient()

    // _withCliLock stub that executes the inner fn (which calls runExecFile — will fail)
    const lockStub = vi.fn().mockImplementation(async (fn: () => Promise<void>) => fn())
    // @ts-expect-error - override private method for test
    client._withCliLock = lockStub

    // Should reject (no real dolt binary available)
    await expect(
      client.transact(async (txQuery) => {
        await txQuery("INSERT INTO foo VALUES (1)")
      }),
    ).rejects.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// _resolveParams unit tests (AC2 — correct param interpolation in batch SQL)
// ---------------------------------------------------------------------------

describe('DoltClient._resolveParams() — parameter interpolation (AC2)', () => {
  function resolveParams(sql: string, params?: unknown[]): string {
    const client = new DoltClient({ repoPath: '/tmp/repo' })
    // @ts-expect-error - accessing private method for test
    return client._resolveParams(sql, params)
  }

  it('substitutes numeric params without quoting', () => {
    expect(resolveParams('SELECT * FROM t WHERE id = ?', [42])).toBe(
      'SELECT * FROM t WHERE id = 42',
    )
  })

  it('substitutes string params with single-quote escaping', () => {
    expect(resolveParams("INSERT INTO t VALUES (?)", ['hello'])).toBe(
      "INSERT INTO t VALUES ('hello')",
    )
  })

  it('escapes single quotes inside string values', () => {
    expect(resolveParams("INSERT INTO t VALUES (?)", ["it's fine"])).toBe(
      "INSERT INTO t VALUES ('it''s fine')",
    )
  })

  it('substitutes null/undefined as NULL', () => {
    expect(resolveParams("INSERT INTO t VALUES (?, ?)", [null, undefined])).toBe(
      "INSERT INTO t VALUES (NULL, NULL)",
    )
  })

  it('handles multiple params in order', () => {
    expect(resolveParams("INSERT INTO t (a, b) VALUES (?, ?)", ['hello', null])).toBe(
      "INSERT INTO t (a, b) VALUES ('hello', NULL)",
    )
  })

  it('returns SQL unchanged when no params', () => {
    expect(resolveParams('SELECT 1', undefined)).toBe('SELECT 1')
    expect(resolveParams('SELECT 1', [])).toBe('SELECT 1')
  })
})

// ---------------------------------------------------------------------------
// DoltDatabaseAdapter.transaction() — delegates to client.transact() (AC4)
// ---------------------------------------------------------------------------

describe('DoltDatabaseAdapter.transaction() — delegates to client.transact()', () => {
  it('calls client.transact() — does NOT issue BEGIN/COMMIT via query()', async () => {
    const transactMock = vi.fn().mockImplementation(
      async (fn: (q: <R>(sql: string, p?: unknown[]) => Promise<R[]>) => Promise<unknown>) => {
        const txQuery = <R>(_sql: string, _params?: unknown[]): Promise<R[]> =>
          Promise.resolve([] as R[])
        return fn(txQuery)
      },
    )
    const client = makeMockClient({ transact: transactMock })
    const adapter = new DoltDatabaseAdapter(client)

    const result = await adapter.transaction(async (tx) => {
      await tx.exec("INSERT INTO t VALUES (1)")
      return 'done'
    })

    expect(result).toBe('done')
    expect(transactMock).toHaveBeenCalledOnce()
    // Critically: BEGIN and COMMIT must NOT be issued via query()
    expect(vi.mocked(client.query)).not.toHaveBeenCalledWith('BEGIN', undefined)
    expect(vi.mocked(client.query)).not.toHaveBeenCalledWith('COMMIT', undefined)
  })

  it('txAdapter has backendType = "dolt"', async () => {
    let capturedBackendType: string | undefined
    const client = makeMockClient()
    const adapter = new DoltDatabaseAdapter(client)

    await adapter.transaction(async (tx) => {
      capturedBackendType = tx.backendType
    })

    expect(capturedBackendType).toBe('dolt')
  })

  it('nested transaction() on txAdapter is a pass-through — no second transact() call', async () => {
    let innerCallCount = 0
    const transactMock = vi.fn().mockImplementation(
      async (fn: (q: <R>(sql: string, p?: unknown[]) => Promise<R[]>) => Promise<unknown>) => {
        const txQuery = <R>(_sql: string, _params?: unknown[]): Promise<R[]> =>
          Promise.resolve([] as R[])
        return fn(txQuery)
      },
    )
    const client = makeMockClient({ transact: transactMock })
    const adapter = new DoltDatabaseAdapter(client)

    await adapter.transaction(async (outerTx) => {
      await outerTx.transaction(async (innerTx) => {
        innerCallCount++
        await innerTx.exec('INSERT INTO t VALUES (99)')
      })
    })

    // transact() was called exactly once (the outer call — nested is pass-through)
    expect(transactMock).toHaveBeenCalledOnce()
    expect(innerCallCount).toBe(1)
  })

  it('propagates rejection from fn() through transact()', async () => {
    const client = makeMockClient()
    const adapter = new DoltDatabaseAdapter(client)

    await expect(
      adapter.transaction(async () => {
        throw new Error('tx failed')
      }),
    ).rejects.toThrow('tx failed')
  })

  it('txAdapter.exec() passes SQL to txQuery with undefined params', async () => {
    let capturedSql: string | undefined
    let capturedParams: unknown[] | undefined

    const transactMock = vi.fn().mockImplementation(
      async (fn: (q: <R>(sql: string, p?: unknown[]) => Promise<R[]>) => Promise<unknown>) => {
        const txQuery = <R>(sql: string, params?: unknown[]): Promise<R[]> => {
          capturedSql = sql
          capturedParams = params
          return Promise.resolve([] as R[])
        }
        return fn(txQuery)
      },
    )
    const client = makeMockClient({ transact: transactMock })
    const adapter = new DoltDatabaseAdapter(client)

    await adapter.transaction(async (tx) => {
      await tx.exec('DELETE FROM foo WHERE id = 1')
    })

    expect(capturedSql).toBe('DELETE FROM foo WHERE id = 1')
    expect(capturedParams).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC3: Integration test — data survives process exit (gated on real Dolt repo)
// ---------------------------------------------------------------------------

/**
 * Integration test (AC3): verifies that rows committed via adapter.transaction()
 * are visible to a fresh process querying via Dolt CLI.
 *
 * SKIPPED unless DOLT_INTEGRATION_TEST=1 is set in the environment.
 * Requires: Dolt CLI on PATH + a git repo initialized with `dolt init`.
 */
describe('DoltClient.transact() — integration (AC3, skipped by default)', () => {
  const runIntegration = process.env['DOLT_INTEGRATION_TEST'] === '1'

  it.skipIf(!runIntegration)(
    'rows written in a transaction are visible to a fresh CLI process after close()',
    async () => {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const { mkdtemp, rm } = await import('node:fs/promises')
      const execFileAsync = promisify(execFile)

      // Create a temp dir and initialize a Dolt repo
      const tmpDir = await mkdtemp('/tmp/dolt-test-')
      try {
        await execFileAsync('dolt', ['init'], { cwd: tmpDir })

        // Create a test table via Dolt CLI
        await execFileAsync('dolt', ['sql', '-q', 'CREATE TABLE tx_test (id INT PRIMARY KEY, val TEXT)'], {
          cwd: tmpDir,
        })

        // Import the real DoltClient
        const { DoltClient: DoltClientReal } = await import('./dolt-client.js')
        const client = new DoltClientReal({ repoPath: tmpDir })

        // Write two rows in a single transaction
        await client.transact(async (txQuery) => {
          await txQuery("INSERT INTO tx_test (id, val) VALUES (1, 'alpha')")
          await txQuery("INSERT INTO tx_test (id, val) VALUES (2, 'beta')")
        })

        // Close the client (release resources)
        await client.close()

        // Verify via a fresh Dolt CLI invocation (new process, new session)
        const { stdout } = await execFileAsync(
          'dolt',
          ['sql', '-q', 'SELECT COUNT(*) AS cnt FROM tx_test', '--result-format', 'json'],
          { cwd: tmpDir },
        )
        const parsed = JSON.parse(stdout) as { rows: { cnt: number }[] }
        expect(parsed.rows[0]!.cnt).toBe(2)
      } finally {
        await rm(tmpDir, { recursive: true, force: true })
      }
    },
  )
})
