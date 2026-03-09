// @vitest-environment node
/**
 * Unit tests for DoltStateStore.
 *
 * DoltClient is fully mocked. No real Dolt server required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DoltStateStore } from '../dolt-store.js'
import type { DoltClient } from '../dolt-client.js'
import type { StoryRecord, MetricRecord, ContractRecord, ContractVerificationRecord } from '../types.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the raw callback-style execFile. Real promisify wraps it into a promise.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

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

function makeClient(queryResults: Map<string, unknown[]> = new Map()): DoltClient {
  return {
    repoPath: '/tmp/testrepo',
    socketPath: '/tmp/testrepo/.dolt/dolt.sock',
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation(async (sql: string) => {
      // Find a matching result key by checking if sql contains keywords
      for (const [key, value] of queryResults) {
        if (sql.includes(key)) return value
      }
      return []
    }),
  } as unknown as DoltClient
}

function makeStore(client?: DoltClient): DoltStateStore {
  return new DoltStateStore({
    repoPath: '/tmp/testrepo',
    client: client ?? makeClient(),
  })
}

function makeStory(overrides: Partial<StoryRecord> = {}): StoryRecord {
  return {
    storyKey: '26-1',
    phase: 'PENDING',
    reviewCycles: 0,
    ...overrides,
  }
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
      // Should have issued DDL for stories, metrics, contracts
      const calls = vi.mocked(client.query).mock.calls
      const ddlCalls = calls.filter(([sql]) => String(sql).includes('CREATE TABLE'))
      expect(ddlCalls.length).toBeGreaterThanOrEqual(3)
    })

    it('calls client.close()', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.close()
      expect(client.close).toHaveBeenCalledOnce()
    })
  })

  // -- Story state -----------------------------------------------------------

  describe('getStoryState', () => {
    it('returns undefined when no row found', async () => {
      const client = makeClient()
      const store = makeStore(client)
      const result = await store.getStoryState('26-99')
      expect(result).toBeUndefined()
    })

    it('maps row columns to StoryRecord fields', async () => {
      const client = makeClient(
        new Map([
          [
            'FROM stories',
            [
              {
                story_key: '26-1',
                phase: 'IN_DEV',
                review_cycles: 2,
                last_verdict: 'LGTM',
                error: null,
                started_at: '2026-03-08T10:00:00.000Z',
                completed_at: null,
                sprint: 'sprint-1',
              },
            ],
          ],
        ]),
      )
      const store = makeStore(client)
      const result = await store.getStoryState('26-1')
      expect(result).toEqual({
        storyKey: '26-1',
        phase: 'IN_DEV',
        reviewCycles: 2,
        lastVerdict: 'LGTM',
        error: undefined,
        startedAt: '2026-03-08T10:00:00.000Z',
        completedAt: undefined,
        sprint: 'sprint-1',
      })
    })
  })

  describe('setStoryState', () => {
    it('calls query with REPLACE INTO and correct params', async () => {
      const client = makeClient()
      const store = makeStore(client)
      const record = makeStory({ phase: 'IN_DEV', reviewCycles: 1, sprint: 'sprint-1' })
      await store.setStoryState('26-1', record)

      const calls = vi.mocked(client.query).mock.calls
      const replaceCall = calls.find(([sql]) => String(sql).includes('REPLACE INTO'))
      expect(replaceCall).toBeDefined()
      const params = replaceCall![1] as unknown[]
      expect(params[0]).toBe('26-1')
      expect(params[1]).toBe('IN_DEV')
      expect(params[2]).toBe(1)
    })

    it('maps undefined optional fields to null', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.setStoryState('26-1', makeStory())
      const calls = vi.mocked(client.query).mock.calls
      const replaceCall = calls.find(([sql]) => String(sql).includes('REPLACE INTO'))!
      const params = replaceCall[1] as unknown[]
      // lastVerdict, error, startedAt, completedAt, sprint → all null
      expect(params[3]).toBeNull()
      expect(params[4]).toBeNull()
    })
  })

  describe('queryStories', () => {
    it('builds query with no WHERE clause for empty filter', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.queryStories({})
      const calls = vi.mocked(client.query).mock.calls
      const selectCall = calls.find(([sql]) => String(sql).includes('FROM stories'))
      expect(selectCall![0]).not.toContain('WHERE')
    })

    it('builds WHERE phase IN (...) for single phase', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.queryStories({ phase: 'COMPLETE' })
      const calls = vi.mocked(client.query).mock.calls
      const selectCall = calls.find(([sql]) => String(sql).includes('FROM stories'))!
      expect(String(selectCall[0])).toContain('phase IN')
      expect(selectCall[1]).toContain('COMPLETE')
    })

    it('builds WHERE phase IN (...) for array of phases', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.queryStories({ phase: ['COMPLETE', 'ESCALATED'] })
      const calls = vi.mocked(client.query).mock.calls
      const selectCall = calls.find(([sql]) => String(sql).includes('FROM stories'))!
      const params = selectCall[1] as unknown[]
      expect(params).toContain('COMPLETE')
      expect(params).toContain('ESCALATED')
    })

    it('builds WHERE sprint = ? for sprint filter', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.queryStories({ sprint: 'sprint-2' })
      const calls = vi.mocked(client.query).mock.calls
      const selectCall = calls.find(([sql]) => String(sql).includes('FROM stories'))!
      expect(String(selectCall[0])).toContain('sprint = ?')
      expect(selectCall[1]).toContain('sprint-2')
    })

    it('builds WHERE story_key = ? for storyKey filter', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.queryStories({ storyKey: '26-2' })
      const calls = vi.mocked(client.query).mock.calls
      const selectCall = calls.find(([sql]) => String(sql).includes('FROM stories'))!
      expect(String(selectCall[0])).toContain('story_key = ?')
    })

    it('maps returned rows to StoryRecord[]', async () => {
      const client = makeClient(
        new Map([
          [
            'FROM stories',
            [
              { story_key: '26-1', phase: 'COMPLETE', review_cycles: 3, last_verdict: null, error: null, started_at: null, completed_at: null, sprint: null },
            ],
          ],
        ]),
      )
      const store = makeStore(client)
      const results = await store.queryStories({})
      expect(results).toHaveLength(1)
      expect(results[0].storyKey).toBe('26-1')
      expect(results[0].phase).toBe('COMPLETE')
    })
  })

  // -- Metrics ---------------------------------------------------------------

  describe('recordMetric', () => {
    it('calls INSERT INTO metrics with correct values', async () => {
      const client = makeClient()
      const store = makeStore(client)
      const metric: MetricRecord = {
        storyKey: '26-1',
        taskType: 'dev-story',
        model: 'claude-3-5-sonnet',
        tokensIn: 1000,
        tokensOut: 500,
        result: 'success',
      }
      await store.recordMetric(metric)

      const calls = vi.mocked(client.query).mock.calls
      const insertCall = calls.find(([sql]) => String(sql).includes('INSERT INTO metrics'))
      expect(insertCall).toBeDefined()
      const params = insertCall![1] as unknown[]
      expect(params[0]).toBe('26-1')
      expect(params[1]).toBe('dev-story')
      expect(params[2]).toBe('claude-3-5-sonnet')
    })

    it('auto-sets recordedAt when not provided', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.recordMetric({ storyKey: '26-1', taskType: 'code-review' })
      const calls = vi.mocked(client.query).mock.calls
      const insertCall = calls.find(([sql]) => String(sql).includes('INSERT INTO metrics'))!
      const params = insertCall[1] as unknown[]
      // recordedAt is at index 11 (story_key, task_type, model, tokens_in, tokens_out,
      // cache_read_tokens, cost_usd, wall_clock_ms, review_cycles, stall_count, result, recorded_at, sprint)
      const recordedAt = params[11]
      expect(typeof recordedAt).toBe('string')
      expect(String(recordedAt)).toMatch(/\d{4}-\d{2}-\d{2}/)
    })
  })

  describe('queryMetrics', () => {
    it('returns empty array when no rows match', async () => {
      const client = makeClient()
      const store = makeStore(client)
      const results = await store.queryMetrics({ storyKey: 'no-match' })
      expect(results).toEqual([])
    })

    it('builds query with storyKey filter', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.queryMetrics({ storyKey: '26-1' })
      const calls = vi.mocked(client.query).mock.calls
      const selectCall = calls.find(([sql]) => String(sql).includes('FROM metrics'))!
      expect(String(selectCall[0])).toContain('story_key = ?')
    })

    it('maps rows to MetricRecord[]', async () => {
      const client = makeClient(
        new Map([
          [
            'FROM metrics',
            [
              {
                story_key: '26-1',
                task_type: 'dev-story',
                model: null,
                tokens_in: 1000,
                tokens_out: 500,
                cache_read_tokens: null,
                cost_usd: null,
                wall_clock_ms: 30000,
                review_cycles: 1,
                stall_count: null,
                result: 'success',
                recorded_at: '2026-03-08T10:00:00.000Z',
              },
            ],
          ],
        ]),
      )
      const store = makeStore(client)
      const results = await store.queryMetrics({})
      expect(results).toHaveLength(1)
      expect(results[0].storyKey).toBe('26-1')
      expect(results[0].tokensIn).toBe(1000)
      expect(results[0].wallClockMs).toBe(30000)
    })
  })

  // -- Contracts -------------------------------------------------------------

  describe('getContracts', () => {
    it('returns empty array when no contracts found', async () => {
      const client = makeClient()
      const store = makeStore(client)
      const results = await store.getContracts('26-99')
      expect(results).toEqual([])
    })

    it('maps rows to ContractRecord[]', async () => {
      const client = makeClient(
        new Map([
          [
            'FROM contracts',
            [
              {
                story_key: '26-1',
                contract_name: 'StateStore',
                direction: 'export',
                schema_path: 'src/modules/state/types.ts',
                transport: null,
              },
            ],
          ],
        ]),
      )
      const store = makeStore(client)
      const results = await store.getContracts('26-1')
      expect(results).toHaveLength(1)
      expect(results[0].contractName).toBe('StateStore')
      expect(results[0].direction).toBe('export')
      expect(results[0].transport).toBeUndefined()
    })
  })

  describe('setContracts', () => {
    it('deletes existing contracts then inserts new ones', async () => {
      const client = makeClient()
      const store = makeStore(client)
      const contracts: ContractRecord[] = [
        { storyKey: '26-1', contractName: 'Foo', direction: 'export', schemaPath: 'foo.ts' },
        { storyKey: '26-1', contractName: 'Bar', direction: 'import', schemaPath: 'bar.ts' },
      ]
      await store.setContracts('26-1', contracts)

      const calls = vi.mocked(client.query).mock.calls
      const deleteCall = calls.find(([sql]) => String(sql).includes('DELETE FROM contracts'))
      expect(deleteCall).toBeDefined()
      expect(deleteCall![1]).toContain('26-1')

      const insertCalls = calls.filter(([sql]) => String(sql).includes('INSERT INTO contracts'))
      expect(insertCalls).toHaveLength(2)
    })

    it('handles empty contracts array (just deletes)', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.setContracts('26-1', [])
      const calls = vi.mocked(client.query).mock.calls
      const deleteCall = calls.find(([sql]) => String(sql).includes('DELETE FROM contracts'))
      expect(deleteCall).toBeDefined()
      const insertCalls = calls.filter(([sql]) => String(sql).includes('INSERT INTO contracts'))
      expect(insertCalls).toHaveLength(0)
    })
  })

  // -- Branch operations -----------------------------------------------------

  describe('branchForStory', () => {
    it('calls dolt checkout -b story-<storyKey>', async () => {
      const { execFile } = await import('node:child_process')
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: readonly string[], _opts: unknown, callback?: unknown) => {
          if (typeof callback === 'function') callback(null, '', '')
          return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>
        },
      )
      const store = makeStore()
      await store.branchForStory('26-1')
      expect(execFile).toHaveBeenCalledWith(
        'dolt',
        ['checkout', '-b', 'story-26-1'],
        expect.objectContaining({ cwd: '/tmp/testrepo' }),
        expect.any(Function),
      )
    })

    it('falls back to checkout without -b when branch exists', async () => {
      const { execFile } = await import('node:child_process')
      let callCount = 0
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, args: readonly string[], _opts: unknown, callback?: unknown) => {
          callCount++
          if (typeof callback === 'function') {
            if (callCount === 1 && args.includes('-b')) {
              // First call fails (branch exists)
              callback(new Error('branch already exists'), '', '')
            } else {
              callback(null, '', '')
            }
          }
          return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>
        },
      )
      const store = makeStore()
      await expect(store.branchForStory('26-1')).resolves.toBeUndefined()
    })
  })

  describe('mergeStory', () => {
    it('checks out main then merges the story branch', async () => {
      const { execFile } = await import('node:child_process')
      const calls: string[][] = []
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, args: readonly string[], _opts: unknown, callback?: unknown) => {
          calls.push([...args])
          if (typeof callback === 'function') callback(null, '', '')
          return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>
        },
      )
      const store = makeStore()
      await store.mergeStory('26-1')
      expect(calls[0]).toEqual(['checkout', 'main'])
      expect(calls[1]).toContain('merge')
      expect(calls[1]).toContain('story-26-1')
    })
  })

  describe('rollbackStory', () => {
    it('checks out main then deletes the story branch', async () => {
      const { execFile } = await import('node:child_process')
      const calls: string[][] = []
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, args: readonly string[], _opts: unknown, callback?: unknown) => {
          calls.push([...args])
          if (typeof callback === 'function') callback(null, '', '')
          return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>
        },
      )
      const store = makeStore()
      await store.rollbackStory('26-1')
      expect(calls[0]).toEqual(['checkout', 'main'])
      expect(calls[1]).toEqual(['branch', '-D', 'story-26-1'])
    })

    it('does not throw when dolt commands fail (non-fatal)', async () => {
      const { execFile } = await import('node:child_process')
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: readonly string[], _opts: unknown, callback?: unknown) => {
          if (typeof callback === 'function') callback(new Error('branch not found'), '', '')
          return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>
        },
      )
      const store = makeStore()
      await expect(store.rollbackStory('26-1')).resolves.toBeUndefined()
    })
  })

  describe('diffStory', () => {
    it('returns StateDiff with storyKey and changes array', async () => {
      const client = makeClient()
      const store = makeStore(client)
      const diff = await store.diffStory('26-1')
      expect(diff.storyKey).toBe('26-1')
      expect(Array.isArray(diff.changes)).toBe(true)
    })

    it('handles query errors gracefully (best-effort)', async () => {
      const client = {
        ...makeClient(),
        query: vi.fn().mockRejectedValue(new Error('table not found')),
      } as unknown as DoltClient
      const store = makeStore(client)
      const diff = await store.diffStory('26-1')
      expect(diff.storyKey).toBe('26-1')
      expect(diff.changes).toEqual([])
    })
  })

  // -- flush -----------------------------------------------------------------

  describe('flush', () => {
    it('calls dolt add and dolt commit', async () => {
      const { execFile } = await import('node:child_process')
      const calls: string[][] = []
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, args: readonly string[], _opts: unknown, callback?: unknown) => {
          calls.push([...args])
          if (typeof callback === 'function') callback(null, '', '')
          return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>
        },
      )
      const store = makeStore()
      await store.flush('my commit')
      expect(calls[0]).toEqual(['add', '.'])
      expect(calls[1]).toContain('commit')
      expect(calls[1]).toContain('my commit')
    })

    it('does not throw when dolt commit fails', async () => {
      const { execFile } = await import('node:child_process')
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: readonly string[], _opts: unknown, callback?: unknown) => {
          if (typeof callback === 'function') callback(new Error('nothing to commit'), '', '')
          return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>
        },
      )
      const store = makeStore()
      await expect(store.flush()).resolves.toBeUndefined()
    })
  })

  // -- queryContracts --------------------------------------------------------

  describe('queryContracts', () => {
    it('builds SELECT * FROM contracts with no WHERE clause when no filter', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.queryContracts()
      const calls = vi.mocked(client.query).mock.calls
      const selectCall = calls.find(([sql]) => String(sql).includes('FROM contracts') && !String(sql).includes('WHERE'))
      expect(selectCall).toBeDefined()
    })

    it('builds WHERE story_key = ? for storyKey filter', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.queryContracts({ storyKey: '26-1' })
      const calls = vi.mocked(client.query).mock.calls
      const selectCall = calls.find(([sql]) => String(sql).includes('FROM contracts'))!
      expect(String(selectCall[0])).toContain('story_key = ?')
      expect(selectCall[1]).toContain('26-1')
    })

    it('builds WHERE direction = ? for direction filter', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.queryContracts({ direction: 'export' })
      const calls = vi.mocked(client.query).mock.calls
      const selectCall = calls.find(([sql]) => String(sql).includes('FROM contracts'))!
      expect(String(selectCall[0])).toContain('direction = ?')
      expect(selectCall[1]).toContain('export')
    })

    it('maps rows to ContractRecord[]', async () => {
      const client = makeClient(
        new Map([
          [
            'FROM contracts',
            [
              {
                story_key: '26-1',
                contract_name: 'StateStore',
                direction: 'export',
                schema_path: 'src/modules/state/types.ts',
                transport: null,
              },
            ],
          ],
        ]),
      )
      const store = makeStore(client)
      const results = await store.queryContracts()
      expect(results).toHaveLength(1)
      expect(results[0].storyKey).toBe('26-1')
      expect(results[0].contractName).toBe('StateStore')
    })
  })

  // -- setContractVerification / getContractVerification ---------------------

  describe('setContractVerification', () => {
    it('deletes existing records and inserts new ones', async () => {
      const { execFile } = await import('node:child_process')
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: readonly string[], _opts: unknown, callback?: unknown) => {
          if (typeof callback === 'function') callback(null, '', '')
          return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>
        },
      )
      const client = makeClient()
      const store = makeStore(client)
      const records: ContractVerificationRecord[] = [
        { storyKey: '26-1', contractName: 'StateStore', verdict: 'pass', verifiedAt: '2026-03-08T10:00:00.000Z' },
        { storyKey: '26-1', contractName: 'DoltClient', verdict: 'fail', mismatchDescription: 'Missing close()', verifiedAt: '2026-03-08T10:00:00.000Z' },
      ]

      await store.setContractVerification('26-1', records)

      const calls = vi.mocked(client.query).mock.calls
      const deleteCall = calls.find(([sql]) => String(sql).includes('DELETE FROM review_verdicts'))
      expect(deleteCall).toBeDefined()
      expect(deleteCall![1]).toContain('26-1')

      const insertCalls = calls.filter(([sql]) => String(sql).includes('INSERT INTO review_verdicts'))
      expect(insertCalls).toHaveLength(2)
    })

    it('stores notes as JSON with contractName and mismatchDescription', async () => {
      const { execFile } = await import('node:child_process')
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: readonly string[], _opts: unknown, callback?: unknown) => {
          if (typeof callback === 'function') callback(null, '', '')
          return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>
        },
      )
      const client = makeClient()
      const store = makeStore(client)
      const records: ContractVerificationRecord[] = [
        { storyKey: '26-1', contractName: 'StateStore', verdict: 'fail', mismatchDescription: 'Type mismatch', verifiedAt: '2026-03-08T10:00:00.000Z' },
      ]

      await store.setContractVerification('26-1', records)

      const calls = vi.mocked(client.query).mock.calls
      const insertCall = calls.find(([sql]) => String(sql).includes('INSERT INTO review_verdicts'))!
      const params = insertCall[1] as unknown[]
      // notes is at index 3
      const notes = JSON.parse(params[3] as string) as { contractName: string; mismatchDescription: string }
      expect(notes.contractName).toBe('StateStore')
      expect(notes.mismatchDescription).toBe('Type mismatch')
    })
  })

  describe('getContractVerification', () => {
    it('returns empty array when no records found', async () => {
      const client = makeClient()
      const store = makeStore(client)
      const results = await store.getContractVerification('26-99')
      expect(results).toEqual([])
    })

    it('parses notes JSON to reconstruct ContractVerificationRecord', async () => {
      const client = makeClient(
        new Map([
          [
            'FROM review_verdicts',
            [
              {
                story_key: '26-1',
                task_type: 'contract-verification',
                verdict: 'pass',
                issues_count: 0,
                notes: JSON.stringify({ contractName: 'StateStore', mismatchDescription: undefined }),
                timestamp: '2026-03-08T10:00:00.000Z',
              },
            ],
          ],
        ]),
      )
      const store = makeStore(client)
      const results = await store.getContractVerification('26-1')
      expect(results).toHaveLength(1)
      expect(results[0].contractName).toBe('StateStore')
      expect(results[0].verdict).toBe('pass')
      expect(results[0].verifiedAt).toBe('2026-03-08T10:00:00.000Z')
    })

    it('queries with correct SQL including task_type filter', async () => {
      const client = makeClient()
      const store = makeStore(client)
      await store.getContractVerification('26-1')
      const calls = vi.mocked(client.query).mock.calls
      const selectCall = calls.find(([sql]) => String(sql).includes('FROM review_verdicts'))!
      expect(String(selectCall[0])).toContain("task_type = 'contract-verification'")
      expect(String(selectCall[0])).toContain('story_key = ?')
    })
  })
})
