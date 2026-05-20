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

const { mockLogInfo } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: mockLogInfo,
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
    it('calls client.connect() and runs migrations', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.initialize()
      expect(client.connect).toHaveBeenCalledOnce()
      // Post-Ship-1: _runMigrations issues only the repo_map_symbols SHOW COLUMNS
      // probe (and ALTER if missing). No CREATE TABLE DDL anymore — those were
      // excised because the 4 affected tables (stories, metrics, contracts,
      // review_verdicts) are never written-to in production.
      const calls = vi.mocked(client.query).mock.calls
      const showColumnsCall = calls.find(([sql]) => String(sql).includes('SHOW COLUMNS FROM repo_map_symbols'))
      expect(showColumnsCall).toBeDefined()
    })

    it('calls client.close()', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.close()
      expect(client.close).toHaveBeenCalledOnce()
    })
  })

  // -- schema migration: dependencies column ---------------------------------

  describe('schema migration — dependencies column', () => {
    it('runs ALTER TABLE when dependencies column is missing (SHOW COLUMNS returns empty)', async () => {
      const client = makeClient(
        new Map([['SHOW COLUMNS FROM repo_map_symbols', []]]),
      )
      const store = makeStore(client)
      await store.initialize()

      const calls = vi.mocked(client.query).mock.calls
      const alterCall = calls.find(([sql]) => String(sql).includes('ALTER TABLE repo_map_symbols'))
      expect(alterCall).toBeDefined()
      expect(String(alterCall![0])).toContain('ADD COLUMN dependencies JSON')
    })

    it('skips ALTER TABLE when dependencies column already exists (SHOW COLUMNS returns 1 row)', async () => {
      const client = makeClient(
        new Map([
          ['SHOW COLUMNS FROM repo_map_symbols', [{ Field: 'dependencies', Type: 'json', Null: 'YES', Key: '', Default: null, Extra: '' }]],
        ]),
      )
      const store = makeStore(client)
      await store.initialize()

      const calls = vi.mocked(client.query).mock.calls
      const alterCall = calls.find(([sql]) => String(sql).includes('ALTER TABLE repo_map_symbols'))
      expect(alterCall).toBeUndefined()
    })

    it('emits info-level log with migration metadata when ALTER TABLE runs', async () => {
      mockLogInfo.mockClear()
      const client = makeClient(
        new Map([['SHOW COLUMNS FROM repo_map_symbols', []]]),
      )
      const store = makeStore(client)
      await store.initialize()

      expect(mockLogInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          component: 'dolt-state',
          migration: 'v5-to-v6',
          column: 'dependencies',
          table: 'repo_map_symbols',
        }),
        expect.any(String),
      )
    })

    it('skips migration silently when repo_map_symbols table does not exist (query throws)', async () => {
      const client = makeClient()
      let showColumnsCalled = false
      vi.mocked(client.query).mockImplementation(async (sql: string) => {
        if (String(sql).includes('SHOW COLUMNS FROM repo_map_symbols')) {
          showColumnsCalled = true
          throw new Error("Table 'substrate.repo_map_symbols' doesn't exist")
        }
        return []
      })
      const store = makeStore(client)
      await expect(store.initialize()).resolves.toBeUndefined()
      expect(showColumnsCalled).toBe(true)
      const calls = vi.mocked(client.query).mock.calls
      const alterCall = calls.find(([sql]) => String(sql).includes('ALTER TABLE repo_map_symbols'))
      expect(alterCall).toBeUndefined()
    })
  })

  // -- Branch operations -----------------------------------------------------

  describe('branchForStory', () => {
    it('calls DOLT_BRANCH SQL and registers the branch', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.branchForStory('26-7')
      const calls = vi.mocked(client.query).mock.calls
      const branchCall = calls.find(([sql]) => String(sql).includes('DOLT_BRANCH'))
      expect(branchCall).toBeDefined()
      expect(String(branchCall![0])).toContain('story/26-7')
    })

    it('throws DoltQueryError when DOLT_BRANCH fails', async () => {
      const client = makeClient()
      vi.mocked(client.query).mockRejectedValueOnce(new Error('branch error'))
      const store = makeStore(client)
      await expect(store.branchForStory('26-7')).rejects.toThrow()
    })
  })

  describe('mergeStory', () => {
    it('is a no-op when no branch is registered', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await expect(store.mergeStory('26-7')).resolves.toBeUndefined()
      const calls = vi.mocked(client.query).mock.calls
      const mergeCall = calls.find(([sql]) => String(sql).includes('DOLT_MERGE'))
      expect(mergeCall).toBeUndefined()
    })

    it('calls DOLT_MERGE and DOLT_COMMIT after branchForStory', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.branchForStory('26-7')
      vi.mocked(client.query).mockClear()
      vi.mocked(client.query).mockResolvedValue([{ hash: 'abc123', fast_forward: 1, conflicts: 0, message: '' }])
      await store.mergeStory('26-7')
      const calls = vi.mocked(client.query).mock.calls
      const mergeCall = calls.find(([sql]) => String(sql).includes('DOLT_MERGE'))
      expect(mergeCall).toBeDefined()
      const commitCall = calls.find(([sql]) => String(sql).includes('DOLT_COMMIT'))
      expect(commitCall).toBeDefined()
      expect(String(commitCall![0])).toContain('26-7')
    })
  })

  describe('rollbackStory', () => {
    it('is a no-op when no branch is registered', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await expect(store.rollbackStory('26-7')).resolves.toBeUndefined()
      const calls = vi.mocked(client.query).mock.calls
      const dropCall = calls.find(([sql]) => String(sql).includes('DOLT_BRANCH') && String(sql).includes('-D'))
      expect(dropCall).toBeUndefined()
    })

    it('calls DOLT_BRANCH -D after branchForStory', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.branchForStory('26-7')
      vi.mocked(client.query).mockClear()
      vi.mocked(client.query).mockResolvedValue([])
      await store.rollbackStory('26-7')
      const calls = vi.mocked(client.query).mock.calls
      const dropCall = calls.find(([sql]) => String(sql).includes('DOLT_BRANCH') && String(sql).includes('-D'))
      expect(dropCall).toBeDefined()
    })

    it('does not throw when DOLT_BRANCH -D fails', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.branchForStory('26-7')
      vi.mocked(client.query).mockClear()
      vi.mocked(client.query).mockRejectedValue(new Error('branch not found'))
      await expect(store.rollbackStory('26-7')).resolves.toBeUndefined()
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

  // -- flush -----------------------------------------------------------------

  describe('flush', () => {
    it('calls dolt add and dolt commit via client.execArgs', async () => {
      const execArgsCalls: string[][] = []
      const client = makeClient()
      vi.mocked(client.execArgs).mockImplementation(async (args: string[]) => {
        execArgsCalls.push(args)
        return ''
      })
      const store = makeStore(client)
      await store.flush('my commit')
      expect(execArgsCalls.length).toBeGreaterThanOrEqual(2)
      expect(execArgsCalls[0]).toContain('add')
      expect(execArgsCalls[1]).toContain('commit')
      expect(execArgsCalls[1]).toContain('my commit')
    })

    it('does not throw when dolt commit fails', async () => {
      const client = makeClient()
      vi.mocked(client.execArgs).mockRejectedValue(new Error('nothing to commit'))
      const store = makeStore(client)
      await expect(store.flush()).resolves.toBeUndefined()
    })
  })
})
