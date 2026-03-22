// @vitest-environment node
/**
 * Shared StateStore contract tests.
 *
 * These tests verify that any StateStore implementation honours the full
 * interface contract. Currently exercised against FileStateStore (always) and
 * DoltStateStore in CLI-mock mode (always, via mocked DoltClient).
 *
 * Real Dolt integration tests (requiring a `dolt` binary) are skipped unless
 * the DOLT_INTEGRATION_TEST environment variable is set to '1'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StateStore, StoryRecord, ContractRecord, MetricRecord } from '../types.js'
import { FileStateStore } from '../file-store.js'
import { DoltStateStore } from '../dolt-store.js'
import type { DoltClient } from '../dolt-client.js'

// ---------------------------------------------------------------------------
// Mock logger (suppress output in tests)
// ---------------------------------------------------------------------------

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: vi.fn(),
  }
})

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(overrides: Partial<StoryRecord> = {}): StoryRecord {
  return {
    storyKey: '26-1',
    phase: 'PENDING',
    reviewCycles: 0,
    ...overrides,
  }
}

function makeContract(overrides: Partial<ContractRecord> = {}): ContractRecord {
  return {
    storyKey: '26-1',
    contractName: 'StateStore',
    direction: 'export',
    schemaPath: 'src/modules/state/types.ts',
    ...overrides,
  }
}

function makeMetric(overrides: Partial<MetricRecord> = {}): MetricRecord {
  return {
    storyKey: '26-1',
    taskType: 'dev-story',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// In-memory DoltClient mock for contract tests
// ---------------------------------------------------------------------------

/**
 * Creates a mock DoltClient that stores data in memory for contract tests.
 * This allows us to test DoltStateStore contract compliance without a real DB.
 */
function makeInMemoryDoltClient(): DoltClient {
  // Simple in-memory state mirroring what a real Dolt DB would hold
  const tables: Record<string, Record<string, unknown>[]> = {
    stories: [],
    metrics: [],
    contracts: [],
  }
  let metricId = 1

  const client: DoltClient = {
    repoPath: '/tmp/contract-test',
    socketPath: '/tmp/contract-test/.dolt/dolt.sock',
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
      const s = String(sql).trim()

      // CREATE TABLE — no-op
      if (/^CREATE TABLE/i.test(s)) return []

      // REPLACE INTO stories
      if (/^REPLACE INTO stories/i.test(s)) {
        const [story_key, phase, review_cycles, last_verdict, error, started_at, completed_at, sprint] = params
        tables.stories = tables.stories.filter((r) => r.story_key !== story_key)
        tables.stories.push({ story_key, phase, review_cycles, last_verdict, error, started_at, completed_at, sprint })
        return []
      }

      // SELECT * FROM stories WHERE story_key = ?
      if (/SELECT \* FROM stories WHERE story_key = \?/i.test(s)) {
        return tables.stories.filter((r) => r.story_key === params[0])
      }

      // SELECT * FROM stories (with possible WHERE)
      if (/SELECT \* FROM stories/i.test(s)) {
        let rows = [...tables.stories]
        // phase IN (...)
        const phaseMatch = s.match(/phase IN \(([^)]+)\)/)
        if (phaseMatch) {
          const phaseCount = (phaseMatch[1].match(/\?/g) || []).length
          const phases = params.slice(0, phaseCount) as string[]
          let idx = 0
          if (/sprint = \?/i.test(s)) idx = phaseCount
          if (/story_key = \?/i.test(s)) idx = phaseCount
          rows = rows.filter((r) => phases.includes(r.phase as string))
          if (/sprint = \?/i.test(s)) rows = rows.filter((r) => r.sprint === params[idx])
          if (/story_key = \?/i.test(s)) rows = rows.filter((r) => r.story_key === params[idx])
        } else if (/sprint = \?/i.test(s)) {
          const sprintIdx = params.indexOf(params.find((_p, i) => {
            const before = s.split('?').slice(0, i + 1).join('?')
            return /sprint = \?/i.test(before)
          }))
          rows = rows.filter((r) => r.sprint === params[Math.max(0, sprintIdx)])
        } else if (/story_key = \?/i.test(s)) {
          rows = rows.filter((r) => r.story_key === params[0])
        }
        return rows
      }

      // INSERT INTO metrics
      if (/^INSERT INTO metrics/i.test(s)) {
        const [story_key, task_type, model, tokens_in, tokens_out, cache_read_tokens, cost_usd, wall_clock_ms, review_cycles, stall_count, result, recorded_at] = params
        tables.metrics.push({ id: metricId++, story_key, task_type, model, tokens_in, tokens_out, cache_read_tokens, cost_usd, wall_clock_ms, review_cycles, stall_count, result, recorded_at })
        return []
      }

      // SELECT * FROM metrics
      if (/SELECT \* FROM metrics/i.test(s)) {
        let rows = [...tables.metrics]
        if (/story_key = \?/i.test(s)) rows = rows.filter((r) => r.story_key === params[0])
        if (/task_type = \?/i.test(s)) {
          const idx = params.findIndex((_p, i) => {
            const before = s.split('?').slice(0, i + 1).join('?')
            return /task_type = \?/i.test(before) && !/story_key = \?/i.test(before.replace(/.*task_type/, ''))
          })
          // Simple: filter by taskType if present in params
          const taskTypeParam = params.find((p) => typeof p === 'string' && p !== params[0])
          if (taskTypeParam) rows = rows.filter((r) => r.task_type === taskTypeParam)
          void idx
        }
        return rows
      }

      // DELETE FROM contracts WHERE story_key = ?
      if (/^DELETE FROM contracts/i.test(s)) {
        tables.contracts = tables.contracts.filter((r) => r.story_key !== params[0])
        return []
      }

      // INSERT INTO contracts
      if (/^INSERT INTO contracts/i.test(s)) {
        const [story_key, contract_name, direction, schema_path, transport] = params
        tables.contracts.push({ story_key, contract_name, direction, schema_path, transport })
        return []
      }

      // SELECT * FROM contracts WHERE story_key = ?
      if (/SELECT \* FROM contracts WHERE story_key = \?/i.test(s)) {
        return tables.contracts.filter((r) => r.story_key === params[0])
      }

      // Dolt diff tables (best-effort)
      if (/dolt_diff/i.test(s)) return []

      return []
    }),
    exec: vi.fn().mockResolvedValue(''),
  } as unknown as DoltClient

  return client
}

// ---------------------------------------------------------------------------
// Contract test suite (shared)
// ---------------------------------------------------------------------------

function runContractTests(label: string, createStore: () => StateStore): void {
  describe(`${label} — StateStore contract`, () => {
    let store: StateStore

    beforeEach(async () => {
      vi.clearAllMocks()
      store = createStore()
      await store.initialize()
    })

    afterEach(async () => {
      await store.close()
    })

    // -- Story state -----------------------------------------------------------

    describe('getStoryState / setStoryState', () => {
      it('returns undefined for an unknown story key', async () => {
        const result = await store.getStoryState('does-not-exist')
        expect(result).toBeUndefined()
      })

      it('round-trips a minimal StoryRecord', async () => {
        const record = makeStory({ phase: 'IN_DEV', reviewCycles: 0 })
        await store.setStoryState('26-1', record)
        const retrieved = await store.getStoryState('26-1')
        expect(retrieved?.storyKey).toBe('26-1')
        expect(retrieved?.phase).toBe('IN_DEV')
        expect(retrieved?.reviewCycles).toBe(0)
      })

      it('round-trips a full StoryRecord preserving all optional fields', async () => {
        const record: StoryRecord = {
          storyKey: '26-1',
          phase: 'COMPLETE',
          reviewCycles: 3,
          lastVerdict: 'LGTM',
          error: undefined,
          startedAt: '2026-03-08T10:00:00.000Z',
          completedAt: '2026-03-08T11:00:00.000Z',
          sprint: 'sprint-1',
        }
        await store.setStoryState('26-1', record)
        const retrieved = await store.getStoryState('26-1')
        expect(retrieved?.phase).toBe('COMPLETE')
        expect(retrieved?.reviewCycles).toBe(3)
        expect(retrieved?.lastVerdict).toBe('LGTM')
        expect(retrieved?.startedAt).toBe('2026-03-08T10:00:00.000Z')
        expect(retrieved?.sprint).toBe('sprint-1')
      })

      it('overwrites an existing record', async () => {
        await store.setStoryState('26-1', makeStory({ phase: 'PENDING' }))
        await store.setStoryState('26-1', makeStory({ phase: 'COMPLETE' }))
        const result = await store.getStoryState('26-1')
        expect(result?.phase).toBe('COMPLETE')
      })
    })

    // -- queryStories ----------------------------------------------------------

    describe('queryStories', () => {
      beforeEach(async () => {
        await store.setStoryState('26-1', makeStory({ storyKey: '26-1', phase: 'COMPLETE', sprint: 'sprint-1' }))
        await store.setStoryState('26-2', makeStory({ storyKey: '26-2', phase: 'ESCALATED', sprint: 'sprint-1' }))
        await store.setStoryState('26-3', makeStory({ storyKey: '26-3', phase: 'IN_DEV', sprint: 'sprint-2' }))
      })

      it('returns all stories for empty filter', async () => {
        const results = await store.queryStories({})
        expect(results.length).toBeGreaterThanOrEqual(3)
      })

      it('filters by single phase', async () => {
        const results = await store.queryStories({ phase: 'COMPLETE' })
        expect(results.some((r) => r.storyKey === '26-1')).toBe(true)
        expect(results.every((r) => r.phase === 'COMPLETE')).toBe(true)
      })

      it('filters by sprint', async () => {
        const results = await store.queryStories({ sprint: 'sprint-2' })
        expect(results.some((r) => r.storyKey === '26-3')).toBe(true)
        expect(results.every((r) => r.sprint === 'sprint-2')).toBe(true)
      })

      it('filters by storyKey', async () => {
        const results = await store.queryStories({ storyKey: '26-2' })
        expect(results).toHaveLength(1)
        expect(results[0].phase).toBe('ESCALATED')
      })
    })

    // -- recordMetric / queryMetrics -------------------------------------------

    describe('recordMetric / queryMetrics', () => {
      it('stores and retrieves a metric', async () => {
        await store.recordMetric(makeMetric({ tokensIn: 1000, result: 'success' }))
        const results = await store.queryMetrics({ storyKey: '26-1' })
        expect(results.length).toBeGreaterThanOrEqual(1)
        expect(results[0].storyKey).toBe('26-1')
      })

      it('auto-sets recordedAt', async () => {
        await store.recordMetric(makeMetric())
        const results = await store.queryMetrics({})
        expect(results.length).toBeGreaterThanOrEqual(1)
        expect(results[0].recordedAt).toBeDefined()
      })
    })

    // -- getContracts / setContracts -------------------------------------------

    describe('getContracts / setContracts', () => {
      it('returns empty array for unknown story', async () => {
        const result = await store.getContracts('unknown-99')
        expect(result).toEqual([])
      })

      it('round-trips a list of contracts', async () => {
        const contracts: ContractRecord[] = [
          makeContract({ contractName: 'StateStore', direction: 'export' }),
          makeContract({ contractName: 'createStateStore', direction: 'export', schemaPath: 'index.ts' }),
        ]
        await store.setContracts('26-1', contracts)
        const retrieved = await store.getContracts('26-1')
        expect(retrieved).toHaveLength(2)
        expect(retrieved.map((c) => c.contractName).sort()).toEqual(['StateStore', 'createStateStore'])
      })

      it('replaces contracts on subsequent call', async () => {
        await store.setContracts('26-1', [makeContract({ contractName: 'OldContract' })])
        await store.setContracts('26-1', [makeContract({ contractName: 'NewContract' })])
        const result = await store.getContracts('26-1')
        expect(result).toHaveLength(1)
        expect(result[0].contractName).toBe('NewContract')
      })
    })

    // -- Branch operations -----------------------------------------------------

    describe('branch operations', () => {
      it('branchForStory resolves without throwing', async () => {
        // Mock execFile for branch operations
        const { execFile } = await import('node:child_process')
        vi.mocked(execFile).mockImplementation(
          (_cmd: string, _args: readonly string[], _opts: unknown, callback?: unknown) => {
            if (typeof callback === 'function') callback(null, '', '')
            return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>
          },
        )
        await expect(store.branchForStory('26-1')).resolves.toBeUndefined()
      })

      it('mergeStory resolves without throwing', async () => {
        const { execFile } = await import('node:child_process')
        vi.mocked(execFile).mockImplementation(
          (_cmd: string, _args: readonly string[], _opts: unknown, callback?: unknown) => {
            if (typeof callback === 'function') callback(null, '', '')
            return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>
          },
        )
        await expect(store.mergeStory('26-1')).resolves.toBeUndefined()
      })

      it('rollbackStory resolves without throwing', async () => {
        const { execFile } = await import('node:child_process')
        vi.mocked(execFile).mockImplementation(
          (_cmd: string, _args: readonly string[], _opts: unknown, callback?: unknown) => {
            if (typeof callback === 'function') callback(null, '', '')
            return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>
          },
        )
        await expect(store.rollbackStory('26-1')).resolves.toBeUndefined()
      })

      it('diffStory returns a StoryDiff with storyKey and tables array', async () => {
        const diff = await store.diffStory('26-1')
        expect(diff.storyKey).toBe('26-1')
        expect(Array.isArray(diff.tables)).toBe(true)
      })
    })

    // -- getHistory ------------------------------------------------------------

    describe('getHistory', () => {
      it('returns an array', async () => {
        const history = await store.getHistory()
        expect(Array.isArray(history)).toBe(true)
      })

      it('returns an array when limit option is provided', async () => {
        const history = await store.getHistory(5)
        expect(Array.isArray(history)).toBe(true)
      })

      it('each entry has required fields when non-empty', async () => {
        const history = await store.getHistory(100)
        for (const entry of history) {
          expect(typeof entry.hash).toBe('string')
          expect(typeof entry.timestamp).toBe('string')
          expect(typeof entry.message).toBe('string')
          // storyKey is string | null
          expect(entry.storyKey === null || typeof entry.storyKey === 'string').toBe(true)
        }
      })
    })

    // -- Lifecycle -------------------------------------------------------------

    describe('lifecycle', () => {
      it('initialize resolves without error', async () => {
        const s = createStore()
        await expect(s.initialize()).resolves.toBeUndefined()
        await s.close()
      })

      it('close resolves without error', async () => {
        const s = createStore()
        await s.initialize()
        await expect(s.close()).resolves.toBeUndefined()
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Run contract tests for FileStateStore
// ---------------------------------------------------------------------------

runContractTests('FileStateStore', () => new FileStateStore())

// ---------------------------------------------------------------------------
// Run contract tests for DoltStateStore (mock client, no real Dolt)
// ---------------------------------------------------------------------------

runContractTests('DoltStateStore (mock client)', () => {
  const client = makeInMemoryDoltClient()
  return new DoltStateStore({ repoPath: '/tmp/contract-test', client })
})
