// @vitest-environment node
/**
 * Unit tests for DoltStateStore (post-Ship-1 surface: DoltOperatorReader).
 *
 * DoltClient is fully mocked. No real Dolt server required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DoltStateStore } from '../dolt-store.js'
import type { DoltClient } from '../dolt-client.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: vi.fn(),
  }
})

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

function makeClient(queryResults: Map<string, unknown[]> = new Map(), execResults: Map<string, string> = new Map()): DoltClient {
  return {
    repoPath: '/tmp/testrepo',
    socketPath: '/tmp/testrepo/.dolt/dolt.sock',
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation(async (sql: string) => {
      for (const [key, value] of queryResults) {
        if (sql.includes(key)) return value
      }
      return []
    }),
    exec: vi.fn().mockImplementation(async (command: string) => {
      for (const [key, value] of execResults) {
        if (command.includes(key)) return value
      }
      return ''
    }),
    execArgs: vi.fn().mockResolvedValue(''),
  } as unknown as DoltClient
}

function makeStore(client?: DoltClient): DoltStateStore {
  return new DoltStateStore({
    repoPath: '/tmp/testrepo',
    client: client ?? makeClient(),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DoltStateStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -- initialize / close ----------------------------------------------------

  describe('initialize / close', () => {
    it('calls client.connect() on initialize', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.initialize()
      expect(client.connect).toHaveBeenCalledOnce()
    })

    it('issues no schema queries on initialize (Ship 8: residual v5→v6 ALTER removed)', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.initialize()
      // Post-Ship-8: no SHOW COLUMNS / ALTER. The `repo_map_symbols.dependencies`
      // column is now defined directly in initRepoMapSchema's CREATE TABLE.
      const calls = vi.mocked(client.query).mock.calls
      expect(calls.find(([sql]) => String(sql).includes('SHOW COLUMNS'))).toBeUndefined()
      expect(calls.find(([sql]) => String(sql).includes('ALTER TABLE'))).toBeUndefined()
    })

    it('calls client.close()', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.close()
      expect(client.close).toHaveBeenCalledOnce()
    })
  })

  // -- KV metrics ------------------------------------------------------------

  describe('setMetric / getMetric', () => {
    it('stores and retrieves a value scoped by runId', async () => {
      const store = makeStore()
      await store.setMetric('run-1', 'tokens', 1234)
      const result = await store.getMetric('run-1', 'tokens')
      expect(result).toBe(1234)
    })

    it('returns undefined for unknown runId', async () => {
      const store = makeStore()
      const result = await store.getMetric('no-such-run', 'any-key')
      expect(result).toBeUndefined()
    })

    it('isolates metrics by runId', async () => {
      const store = makeStore()
      await store.setMetric('run-A', 'key', 'valueA')
      await store.setMetric('run-B', 'key', 'valueB')
      expect(await store.getMetric('run-A', 'key')).toBe('valueA')
      expect(await store.getMetric('run-B', 'key')).toBe('valueB')
    })
  })

  // -- getHistory ------------------------------------------------------------

  describe('getHistory', () => {
    it('returns parsed HistoryEntry array from dolt_log query', async () => {
      const queryResults = new Map([
        ['dolt_log', [
          { commit_hash: 'a1b2c3d', date: '2026-03-08T14:23:01+00:00', message: 'Merge story/26-7: branch-per-story complete', committer: 'substrate' },
          { commit_hash: 'b2c3d4e', date: '2026-03-07T10:00:00+00:00', message: 'substrate: auto-commit', committer: 'substrate' },
          { commit_hash: 'c3d4e5f', date: '2026-03-06T09:00:00+00:00', message: 'Merge story/26-1: done', committer: 'substrate' },
        ]],
      ])
      const client = makeClient(queryResults)
      const store = makeStore(client)
      const entries = await store.getHistory(10)
      expect(entries).toHaveLength(3)
      expect(entries[0].hash).toBe('a1b2c3d')
      expect(entries[0].storyKey).toBe('26-7')
      expect(entries[1].storyKey).toBeNull()
      expect(entries[2].storyKey).toBe('26-1')
    })

    it('uses default limit of 20 when no options provided', async () => {
      const queryResults = new Map([['dolt_log', []]])
      const client = makeClient(queryResults)
      const store = makeStore(client)
      await store.getHistory()
      const calls = vi.mocked(client.query).mock.calls
      const logCall = calls.find(c => String(c[0]).includes('dolt_log'))
      expect(logCall).toBeDefined()
      expect(logCall![1]).toEqual([20])
    })

    it('throws DoltQueryError when query fails', async () => {
      const client = {
        ...makeClient(),
        query: vi.fn().mockRejectedValue(new Error('dolt not found')),
      } as unknown as DoltClient
      const store = makeStore(client)
      await expect(store.getHistory()).rejects.toThrow()
    })
  })

})
