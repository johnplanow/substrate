// @vitest-environment node
/**
 * Unit tests for FileKvStore.
 *
 * The class is a narrow KV persistence layer: setMetric / getMetric +
 * lifecycle, with optional flush to {basePath}/kv-metrics.json.
 *
 * Pre-Ship-2 history: this file used to test setStoryState / queryStories /
 * recordMetric / setContracts / setContractVerification — all on the
 * since-removed `StateStore` interface. Those tests were deleted in
 * v0.20.107 (Ship 2 of Item 7 arc) because the production orchestrator
 * never exercised any of those methods (its `stateStore?` prop was
 * undefined in 100% of production paths).
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
import { FileKvStore } from '../file-store.js'

describe('FileKvStore', () => {
  let store: FileKvStore

  beforeEach(() => {
    vi.mocked(writeFile).mockClear()
    store = new FileKvStore()
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

  // -- setMetric / getMetric (in-memory mode, no basePath) ------------------

  describe('setMetric / getMetric — in-memory mode', () => {
    it('round-trips a value within a single runId scope', async () => {
      await store.setMetric('run-1', 'phase_token_breakdown', { entries: [], baselineModel: 'x', runId: 'run-1' })
      const result = await store.getMetric('run-1', 'phase_token_breakdown')
      expect(result).toEqual({ entries: [], baselineModel: 'x', runId: 'run-1' })
    })

    it('isolates values by runId', async () => {
      await store.setMetric('run-A', 'key', 'value-A')
      await store.setMetric('run-B', 'key', 'value-B')
      expect(await store.getMetric('run-A', 'key')).toBe('value-A')
      expect(await store.getMetric('run-B', 'key')).toBe('value-B')
    })

    it('returns undefined for unknown runId', async () => {
      expect(await store.getMetric('no-such-run', 'any-key')).toBeUndefined()
    })

    it('overwrites a value when set is called twice with the same key', async () => {
      await store.setMetric('run-1', 'key', 'first')
      await store.setMetric('run-1', 'key', 'second')
      expect(await store.getMetric('run-1', 'key')).toBe('second')
    })

    it('does NOT flush to disk when basePath is undefined', async () => {
      await store.setMetric('run-1', 'key', 'value')
      expect(writeFile).not.toHaveBeenCalled()
    })
  })

  // -- setMetric / getMetric (persistent mode, with basePath) ---------------

  describe('setMetric — persistent mode (with basePath)', () => {
    it('flushes the in-memory map to {basePath}/kv-metrics.json on every set', async () => {
      const persistentStore = new FileKvStore({ basePath: '/tmp/test-substrate' })
      await persistentStore.setMetric('run-1', 'phase_token_breakdown', { entries: [], runId: 'run-1' })

      expect(writeFile).toHaveBeenCalledOnce()
      const [filePath, content] = vi.mocked(writeFile).mock.calls[0]!
      expect(String(filePath)).toBe('/tmp/test-substrate/kv-metrics.json')
      expect(JSON.parse(String(content))).toEqual({
        'run-1': {
          phase_token_breakdown: { entries: [], runId: 'run-1' },
        },
      })
    })

    it('serializes multiple runIds into a single file payload', async () => {
      const persistentStore = new FileKvStore({ basePath: '/tmp/test-substrate' })
      await persistentStore.setMetric('run-A', 'key', 'value-A')
      await persistentStore.setMetric('run-B', 'key', 'value-B')

      const lastCall = vi.mocked(writeFile).mock.calls.at(-1)!
      expect(JSON.parse(String(lastCall[1]))).toEqual({
        'run-A': { key: 'value-A' },
        'run-B': { key: 'value-B' },
      })
    })
  })
})
