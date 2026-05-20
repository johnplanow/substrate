// @vitest-environment node
/**
 * Unit tests for FileStateStore.
 *
 * All tests use the in-memory (no-DB) path so no SQLite mocking is needed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Top-level vi.mock is hoisted above imports by vitest — this ensures that
// file-store.ts receives the mocked writeFile when it is first loaded.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
  }
})

import { writeFile } from 'node:fs/promises'
import { FileStateStore } from '../file-store.js'
import type { StoryRecord, ContractRecord, ContractVerificationRecord } from '../types.js'

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileStateStore', () => {
  let store: FileStateStore

  beforeEach(() => {
    store = new FileStateStore()
  })

  // -- Story state -----------------------------------------------------------

  describe('setStoryState / queryStories', () => {
    it('round-trips a story record preserving all fields (read via queryStories)', async () => {
      const record: StoryRecord = {
        storyKey: '26-1',
        phase: 'IN_DEV',
        reviewCycles: 2,
        lastVerdict: 'LGTM',
        error: undefined,
        startedAt: '2026-03-08T10:00:00.000Z',
        completedAt: '2026-03-08T11:00:00.000Z',
        sprint: 'sprint-1',
      }

      await store.setStoryState('26-1', record)
      const retrieved = (await store.queryStories({ storyKey: '26-1' }))[0]

      expect(retrieved).toEqual(record)
    })

    it('overwrites an existing record when called again', async () => {
      await store.setStoryState('26-1', makeStory({ phase: 'PENDING' }))
      await store.setStoryState('26-1', makeStory({ phase: 'COMPLETE' }))

      const result = (await store.queryStories({ storyKey: '26-1' }))[0]
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

    it('returns only stories matching a single phase', async () => {
      const results = await store.queryStories({ phase: 'COMPLETE' })
      expect(results).toHaveLength(1)
      expect(results[0].storyKey).toBe('26-1')
    })

    it('returns stories matching an array of phases', async () => {
      const results = await store.queryStories({ phase: ['COMPLETE', 'ESCALATED'] })
      expect(results).toHaveLength(2)
      const keys = results.map((r) => r.storyKey).sort()
      expect(keys).toEqual(['26-1', '26-2'])
    })

    it('returns all stories when filter is empty', async () => {
      const results = await store.queryStories({})
      expect(results).toHaveLength(3)
    })

    it('filters by sprint', async () => {
      const results = await store.queryStories({ sprint: 'sprint-2' })
      expect(results).toHaveLength(1)
      expect(results[0].storyKey).toBe('26-3')
    })

    it('filters by storyKey', async () => {
      const results = await store.queryStories({ storyKey: '26-2' })
      expect(results).toHaveLength(1)
      expect(results[0].phase).toBe('ESCALATED')
    })

    it('returns empty array for an unknown story key', async () => {
      const results = await store.queryStories({ storyKey: 'does-not-exist' })
      expect(results).toEqual([])
    })
  })

  // -- recordMetric ----------------------------------------------------------

  describe('recordMetric', () => {
    it('stores a metric without throwing', async () => {
      await expect(store.recordMetric({
        storyKey: '26-1',
        taskType: 'dev-story',
        tokensIn: 1000,
        tokensOut: 500,
        result: 'success',
      })).resolves.toBeUndefined()
    })

    it('auto-sets recordedAt when not provided (verified via no-throw)', async () => {
      await expect(store.recordMetric({ storyKey: '26-1', taskType: 'code-review' })).resolves.toBeUndefined()
    })
  })

  // -- setMetric / getMetric -------------------------------------------------

  describe('setMetric / getMetric', () => {
    it('returns undefined for an unknown runId', async () => {
      const result = await store.getMetric('no-such-run', 'any-key')
      expect(result).toBeUndefined()
    })

    it('returns undefined for unknown key within a known runId', async () => {
      await store.setMetric('run-1', 'known-key', 42)
      const result = await store.getMetric('run-1', 'unknown-key')
      expect(result).toBeUndefined()
    })

    it('stores and retrieves a primitive value', async () => {
      await store.setMetric('run-1', 'token_count', 1234)
      const result = await store.getMetric('run-1', 'token_count')
      expect(result).toBe(1234)
    })

    it('stores and retrieves an object value', async () => {
      const value = { explore: 100, generate: 500, review: 200 }
      await store.setMetric('run-2', 'phase_breakdown', value)
      const result = await store.getMetric('run-2', 'phase_breakdown')
      expect(result).toEqual(value)
    })

    it('overwrites an existing value for the same runId/key', async () => {
      await store.setMetric('run-1', 'tokens', 100)
      await store.setMetric('run-1', 'tokens', 999)
      const result = await store.getMetric('run-1', 'tokens')
      expect(result).toBe(999)
    })

    it('isolates metrics by runId', async () => {
      await store.setMetric('run-A', 'key', 'valueA')
      await store.setMetric('run-B', 'key', 'valueB')
      expect(await store.getMetric('run-A', 'key')).toBe('valueA')
      expect(await store.getMetric('run-B', 'key')).toBe('valueB')
    })

    it('flushes kv-metrics.json to disk when basePath is set', async () => {
      const mockWriteFile = vi.mocked(writeFile)
      mockWriteFile.mockClear()

      const storeWithPath = new FileStateStore({ basePath: '/tmp/test-kv' })
      await storeWithPath.setMetric('run-1', 'phase_tokens', 100)

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('kv-metrics.json'),
        expect.any(String),
        'utf-8',
      )
    })

    it('does not call writeFile when no basePath is set', async () => {
      const mockWriteFile = vi.mocked(writeFile)
      mockWriteFile.mockClear()

      await store.setMetric('run-1', 'key', 'value')

      expect(mockWriteFile).not.toHaveBeenCalled()
    })
  })

  // -- setContracts / queryContracts -----------------------------------------

  describe('setContracts / queryContracts', () => {
    it('round-trips a contract list preserving all fields (read via queryContracts)', async () => {
      const contracts: ContractRecord[] = [
        {
          storyKey: '26-1',
          contractName: 'StateStore',
          direction: 'export',
          schemaPath: 'src/modules/state/types.ts',
          transport: 'typescript',
        },
        {
          storyKey: '26-1',
          contractName: 'createStateStore',
          direction: 'export',
          schemaPath: 'src/modules/state/index.ts',
        },
      ]

      await store.setContracts('26-1', contracts)
      const retrieved = await store.queryContracts({ storyKey: '26-1' })

      expect(retrieved).toEqual(contracts)
    })

    it('replaces the previous contract list on subsequent calls', async () => {
      await store.setContracts('26-1', [
        { storyKey: '26-1', contractName: 'OldContract', direction: 'export', schemaPath: 'old.ts' },
      ])
      await store.setContracts('26-1', [
        { storyKey: '26-1', contractName: 'NewContract', direction: 'import', schemaPath: 'new.ts' },
      ])

      const result = await store.queryContracts({ storyKey: '26-1' })
      expect(result).toHaveLength(1)
      expect(result[0].contractName).toBe('NewContract')
    })
  })

  // -- queryContracts --------------------------------------------------------

  describe('queryContracts', () => {
    beforeEach(async () => {
      await store.setContracts('26-1', [
        { storyKey: '26-1', contractName: 'StateStore', direction: 'export', schemaPath: 'src/modules/state/types.ts' },
        { storyKey: '26-1', contractName: 'DoltClient', direction: 'import', schemaPath: 'src/modules/state/dolt-client.ts' },
      ])
      await store.setContracts('26-2', [
        { storyKey: '26-2', contractName: 'MetricRecord', direction: 'export', schemaPath: 'src/modules/state/types.ts' },
      ])
    })

    it('returns all contracts when no filter provided', async () => {
      const results = await store.queryContracts()
      expect(results).toHaveLength(3)
    })

    it('returns all contracts when empty filter provided', async () => {
      const results = await store.queryContracts({})
      expect(results).toHaveLength(3)
    })

    it('filters by storyKey', async () => {
      const results = await store.queryContracts({ storyKey: '26-1' })
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.storyKey === '26-1')).toBe(true)
    })

    it('filters by direction export', async () => {
      const results = await store.queryContracts({ direction: 'export' })
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.direction === 'export')).toBe(true)
    })

    it('filters by direction import', async () => {
      const results = await store.queryContracts({ direction: 'import' })
      expect(results).toHaveLength(1)
      expect(results[0].contractName).toBe('DoltClient')
    })

    it('returns empty array when no contracts exist', async () => {
      const emptyStore = new FileStateStore()
      const results = await emptyStore.queryContracts()
      expect(results).toEqual([])
    })
  })

  // -- setContractVerification (write-only on interface) ---------------------

  describe('setContractVerification', () => {
    it('persists verification records without throwing', async () => {
      const records: ContractVerificationRecord[] = [
        {
          storyKey: '26-1',
          contractName: 'StateStore',
          verdict: 'pass',
          verifiedAt: '2026-03-08T10:00:00.000Z',
        },
      ]
      await expect(store.setContractVerification('26-1', records)).resolves.toBeUndefined()
    })

    it('writes contract-verifications.json to disk when basePath is set', async () => {
      const mockWriteFile = vi.mocked(writeFile)
      mockWriteFile.mockClear()

      const storeWithPath = new FileStateStore({ basePath: '/tmp/test-state' })
      const records: ContractVerificationRecord[] = [
        { storyKey: '26-1', contractName: 'StateStore', verdict: 'pass', verifiedAt: '2026-03-08T10:00:00.000Z' },
      ]

      await storeWithPath.setContractVerification('26-1', records)

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('contract-verifications.json'),
        expect.any(String),
        'utf-8',
      )
    })
  })

  // -- History ---------------------------------------------------------------

  describe('getHistory', () => {
    it('returns empty array', async () => {
      const history = await store.getHistory()
      expect(history).toEqual([])
    })

    it('returns empty array with limit option', async () => {
      const history = await store.getHistory(5)
      expect(history).toEqual([])
    })
  })

  // -- Lifecycle -------------------------------------------------------------

  describe('lifecycle', () => {
    it('initialize resolves without error', async () => {
      await expect(store.initialize()).resolves.toBeUndefined()
    })

    it('close resolves without error', async () => {
      await expect(store.close()).resolves.toBeUndefined()
    })
  })
})
