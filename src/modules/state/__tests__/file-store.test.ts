// @vitest-environment node
/**
 * Unit tests for FileStateStore.
 *
 * All tests use the in-memory (no-DB) path so no SQLite mocking is needed.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { FileStateStore } from '../file-store.js'
import type { StoryRecord, ContractRecord } from '../types.js'

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

  describe('getStoryState / setStoryState', () => {
    it('returns undefined for an unknown story key', async () => {
      const result = await store.getStoryState('does-not-exist')
      expect(result).toBeUndefined()
    })

    it('round-trips a story record preserving all fields', async () => {
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
      const retrieved = await store.getStoryState('26-1')

      expect(retrieved).toEqual(record)
    })

    it('overwrites an existing record when called again', async () => {
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
  })

  // -- recordMetric / queryMetrics -------------------------------------------

  describe('recordMetric / queryMetrics', () => {
    it('stores a metric and retrieves it', async () => {
      await store.recordMetric({
        storyKey: '26-1',
        taskType: 'dev-story',
        tokensIn: 1000,
        tokensOut: 500,
        result: 'success',
      })

      const results = await store.queryMetrics({ storyKey: '26-1' })
      expect(results).toHaveLength(1)
      expect(results[0].storyKey).toBe('26-1')
      expect(results[0].tokensIn).toBe(1000)
      expect(results[0].result).toBe('success')
    })

    it('auto-sets recordedAt when not provided', async () => {
      await store.recordMetric({ storyKey: '26-1', taskType: 'code-review' })
      const results = await store.queryMetrics({})
      expect(results[0].recordedAt).toBeDefined()
    })

    it('returns empty array when no metrics match the filter', async () => {
      await store.recordMetric({ storyKey: '26-1', taskType: 'dev-story' })
      const results = await store.queryMetrics({ storyKey: 'no-match' })
      expect(results).toHaveLength(0)
    })

    it('filters by taskType', async () => {
      await store.recordMetric({ storyKey: '26-1', taskType: 'dev-story' })
      await store.recordMetric({ storyKey: '26-1', taskType: 'code-review' })

      const results = await store.queryMetrics({ taskType: 'dev-story' })
      expect(results).toHaveLength(1)
      expect(results[0].taskType).toBe('dev-story')
    })
  })

  // -- getContracts / setContracts -------------------------------------------

  describe('getContracts / setContracts', () => {
    it('returns empty array for an unknown story key', async () => {
      const result = await store.getContracts('unknown')
      expect(result).toEqual([])
    })

    it('round-trips a contract list preserving all fields', async () => {
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
      const retrieved = await store.getContracts('26-1')

      expect(retrieved).toEqual(contracts)
    })

    it('replaces the previous contract list on subsequent calls', async () => {
      await store.setContracts('26-1', [
        { storyKey: '26-1', contractName: 'OldContract', direction: 'export', schemaPath: 'old.ts' },
      ])
      await store.setContracts('26-1', [
        { storyKey: '26-1', contractName: 'NewContract', direction: 'import', schemaPath: 'new.ts' },
      ])

      const result = await store.getContracts('26-1')
      expect(result).toHaveLength(1)
      expect(result[0].contractName).toBe('NewContract')
    })
  })

  // -- Branch operations (no-ops) --------------------------------------------

  describe('branch operations', () => {
    it('branchForStory resolves without error', async () => {
      await expect(store.branchForStory('26-1')).resolves.toBeUndefined()
    })

    it('mergeStory resolves without error', async () => {
      await expect(store.mergeStory('26-1')).resolves.toBeUndefined()
    })

    it('rollbackStory resolves without error', async () => {
      await expect(store.rollbackStory('26-1')).resolves.toBeUndefined()
    })

    it('diffStory returns a StateDiff with empty changes array', async () => {
      const diff = await store.diffStory('26-1')
      expect(diff).toEqual({ storyKey: '26-1', changes: [] })
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
