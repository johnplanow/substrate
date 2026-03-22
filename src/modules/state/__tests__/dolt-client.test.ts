// @vitest-environment node
/**
 * Unit tests for DoltClient.
 *
 * The mysql2 pool and node:fs/promises are mocked so no real Dolt server is needed.
 * dolt-client.ts uses `promisify(execFileCb)`, so we mock the raw execFileCb
 * and let promisify wrap it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DoltClient, createDoltClient } from '../dolt-client.js'
import { DoltQueryError } from '../errors.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
}))

// Mock the raw (callback-style) execFile.
// dolt-client.ts uses runExecFile() which internally calls execFileCb(cmd, args, opts, callback),
// so the mock must invoke the callback when called.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: vi.fn(),
  }
})

vi.mock('mysql2/promise', () => ({
  createPool: vi.fn(),
}))

// Suppress logger output in tests
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeCliClient(repoPath = '/tmp/testrepo'): Promise<DoltClient> {
  const { access } = await import('node:fs/promises')
  vi.mocked(access).mockRejectedValue(new Error('ENOENT'))
  const client = new DoltClient({ repoPath })
  await client.connect()
  return client
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DoltClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('uses default socket path when not provided', () => {
      const client = new DoltClient({ repoPath: '/tmp/repo' })
      expect(client.socketPath).toBe('/tmp/repo/.dolt/dolt.sock')
    })

    it('uses custom socket path when provided', () => {
      const client = new DoltClient({ repoPath: '/tmp/repo', socketPath: '/custom.sock' })
      expect(client.socketPath).toBe('/custom.sock')
    })

    it('stores repoPath', () => {
      const client = new DoltClient({ repoPath: '/my/repo' })
      expect(client.repoPath).toBe('/my/repo')
    })
  })

  describe('createDoltClient factory', () => {
    it('returns a DoltClient instance', () => {
      const client = createDoltClient({ repoPath: '/tmp/repo' })
      expect(client).toBeInstanceOf(DoltClient)
    })
  })

  describe('connect() — CLI fallback path', () => {
    it('falls back to CLI mode when socket is inaccessible', async () => {
      const { access } = await import('node:fs/promises')
      vi.mocked(access).mockRejectedValue(new Error('ENOENT'))

      const client = new DoltClient({ repoPath: '/tmp/repo' })
      await client.connect()

      expect(access).toHaveBeenCalledWith('/tmp/repo/.dolt/dolt.sock')
    })

    it('does not throw on second connect() call', async () => {
      const { access } = await import('node:fs/promises')
      vi.mocked(access).mockRejectedValue(new Error('ENOENT'))

      const client = new DoltClient({ repoPath: '/tmp/repo' })
      await client.connect()
      await expect(client.connect()).resolves.toBeUndefined()
    })
  })

  describe('connect() — pool path', () => {
    it('creates a pool when socket is accessible', async () => {
      const { access } = await import('node:fs/promises')
      vi.mocked(access).mockResolvedValue(undefined)

      const mysql = await import('mysql2/promise')
      const fakePool = {
        execute: vi.fn().mockResolvedValue([[], []]),
        end: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(mysql.createPool).mockReturnValue(fakePool as unknown as ReturnType<typeof mysql.createPool>)

      const client = new DoltClient({ repoPath: '/tmp/repo' })
      await client.connect()

      expect(mysql.createPool).toHaveBeenCalledWith(
        expect.objectContaining({ socketPath: '/tmp/repo/.dolt/dolt.sock' }),
      )
    })
  })

  describe('query() — CLI mode', () => {
    it('calls dolt sql with correct args and parses JSON rows', async () => {
      const mod = await import('node:child_process')
      vi.mocked(mod.execFile).mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
          if (typeof callback === 'function') {
            callback(null, JSON.stringify({ rows: [{ story_key: '26-1' }] }), '')
          }
        },
      )

      const client = await makeCliClient()
      const rows = await client.query<{ story_key: string }>('SELECT * FROM stories WHERE story_key = ?', ['26-1'])
      expect(rows).toEqual([{ story_key: '26-1' }])
    })

    it('handles empty stdout gracefully', async () => {
      const mod = await import('node:child_process')
      vi.mocked(mod.execFile).mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
          if (typeof callback === 'function') callback(null, '', '')
        },
      )

      const client = await makeCliClient()
      const rows = await client.query('SELECT 1')
      expect(rows).toEqual([])
    })

    it('throws DoltQueryError when dolt CLI returns an error', async () => {
      const mod = await import('node:child_process')
      vi.mocked(mod.execFile).mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
          if (typeof callback === 'function') {
            callback(new Error('command not found'), '', 'command not found')
          }
        },
      )

      const client = await makeCliClient()
      await expect(client.query('SELECT 1')).rejects.toBeInstanceOf(DoltQueryError)
    })

    it('substitutes null params as NULL in CLI queries', async () => {
      const mod = await import('node:child_process')
      let capturedArgs: string[] = []
      vi.mocked(mod.execFile).mockImplementation(
        (_cmd: unknown, args: unknown, _opts: unknown, callback: unknown) => {
          capturedArgs = [...(args as string[])]
          if (typeof callback === 'function') callback(null, '{"rows":[]}', '')
        },
      )

      const client = await makeCliClient()
      await client.query('INSERT INTO t VALUES (?)', [null])
      const sqlIndex = capturedArgs.indexOf('-q')
      const sqlArg = capturedArgs[sqlIndex + 1]
      expect(sqlArg).toContain('NULL')
    })

    it('substitutes string params with escaped quotes', async () => {
      const mod = await import('node:child_process')
      let capturedArgs: string[] = []
      vi.mocked(mod.execFile).mockImplementation(
        (_cmd: unknown, args: unknown, _opts: unknown, callback: unknown) => {
          capturedArgs = [...(args as string[])]
          if (typeof callback === 'function') callback(null, '{"rows":[]}', '')
        },
      )

      const client = await makeCliClient()
      await client.query('SELECT * FROM t WHERE k = ?', ["it's"])
      const sqlIndex = capturedArgs.indexOf('-q')
      const sqlArg = capturedArgs[sqlIndex + 1]
      // Single quotes should be escaped as ''
      expect(sqlArg).toContain("it''s")
    })

    it('substitutes number params without quotes', async () => {
      const mod = await import('node:child_process')
      let capturedArgs: string[] = []
      vi.mocked(mod.execFile).mockImplementation(
        (_cmd: unknown, args: unknown, _opts: unknown, callback: unknown) => {
          capturedArgs = [...(args as string[])]
          if (typeof callback === 'function') callback(null, '{"rows":[]}', '')
        },
      )

      const client = await makeCliClient()
      await client.query('SELECT * FROM t WHERE id = ?', [42])
      const sqlIndex = capturedArgs.indexOf('-q')
      const sqlArg = capturedArgs[sqlIndex + 1]
      expect(sqlArg).toContain('42')
      expect(sqlArg).not.toContain("'42'")
    })
  })

  describe('query() — pool mode', () => {
    it('delegates to pool.execute and returns rows', async () => {
      const { access } = await import('node:fs/promises')
      vi.mocked(access).mockResolvedValue(undefined)

      const mysql = await import('mysql2/promise')
      const fakePool = {
        execute: vi.fn().mockResolvedValue([[{ id: 1 }], []]),
        end: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(mysql.createPool).mockReturnValue(fakePool as unknown as ReturnType<typeof mysql.createPool>)

      const client = new DoltClient({ repoPath: '/tmp/repo' })
      await client.connect()
      const rows = await client.query<{ id: number }>('SELECT id FROM t')
      expect(rows).toEqual([{ id: 1 }])
    })

    it('throws DoltQueryError when pool.execute throws', async () => {
      const { access } = await import('node:fs/promises')
      vi.mocked(access).mockResolvedValue(undefined)

      const mysql = await import('mysql2/promise')
      const fakePool = {
        execute: vi.fn().mockRejectedValue(new Error('ER_BAD_FIELD_ERROR')),
        end: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(mysql.createPool).mockReturnValue(fakePool as unknown as ReturnType<typeof mysql.createPool>)

      const client = new DoltClient({ repoPath: '/tmp/repo' })
      await client.connect()
      await expect(client.query('BAD SQL')).rejects.toBeInstanceOf(DoltQueryError)
    })
  })

  describe('concurrent CLI serialization', () => {
    it('serializes concurrent CLI queries so they do not overlap', async () => {
      const mod = await import('node:child_process')
      let activeCount = 0
      let maxConcurrent = 0

      vi.mocked(mod.execFile).mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
          activeCount++
          if (activeCount > maxConcurrent) maxConcurrent = activeCount
          // Simulate async delay
          setTimeout(() => {
            activeCount--
            if (typeof callback === 'function') {
              callback(null, '{"rows":[]}', '')
            }
          }, 10)
        },
      )

      const client = await makeCliClient()
      // Fire 3 concurrent queries
      await Promise.all([
        client.query('SELECT 1'),
        client.query('SELECT 2'),
        client.query('SELECT 3'),
      ])

      // Mutex should ensure no overlapping execFile calls
      expect(maxConcurrent).toBe(1)
    })

    it('serializes concurrent execArgs calls', async () => {
      const mod = await import('node:child_process')
      let activeCount = 0
      let maxConcurrent = 0

      vi.mocked(mod.execFile).mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
          activeCount++
          if (activeCount > maxConcurrent) maxConcurrent = activeCount
          setTimeout(() => {
            activeCount--
            if (typeof callback === 'function') {
              callback(null, 'ok\n', '')
            }
          }, 10)
        },
      )

      const client = await makeCliClient()
      await Promise.all([
        client.execArgs(['log', '--oneline']),
        client.execArgs(['status']),
        client.execArgs(['branch']),
      ])

      expect(maxConcurrent).toBe(1)
    })

    it('releases lock even when a query fails', async () => {
      const mod = await import('node:child_process')
      let callCount = 0

      vi.mocked(mod.execFile).mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
          callCount++
          if (callCount === 1) {
            // First call fails
            if (typeof callback === 'function') {
              callback(new Error('manifest locked'), '', 'manifest locked')
            }
          } else {
            // Subsequent calls succeed
            if (typeof callback === 'function') {
              callback(null, '{"rows":[{"id":1}]}', '')
            }
          }
        },
      )

      const client = await makeCliClient()
      // First query fails, second should still proceed (lock released)
      await expect(client.query('INSERT INTO t VALUES (1)')).rejects.toThrow()
      const rows = await client.query<{ id: number }>('SELECT 1')
      expect(rows).toEqual([{ id: 1 }])
    })
  })

  describe('close()', () => {
    it('closes the pool when connected via socket', async () => {
      const { access } = await import('node:fs/promises')
      vi.mocked(access).mockResolvedValue(undefined)

      const mysql = await import('mysql2/promise')
      const fakePool = {
        execute: vi.fn().mockResolvedValue([[], []]),
        end: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(mysql.createPool).mockReturnValue(fakePool as unknown as ReturnType<typeof mysql.createPool>)

      const client = new DoltClient({ repoPath: '/tmp/repo' })
      await client.connect()
      await client.close()
      expect(fakePool.end).toHaveBeenCalledOnce()
    })

    it('resolves without error when in CLI mode (no pool)', async () => {
      const client = await makeCliClient()
      await expect(client.close()).resolves.toBeUndefined()
    })
  })
})
