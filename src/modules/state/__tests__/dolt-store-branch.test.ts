// @vitest-environment node
/**
 * Unit tests for DoltStateStore branch operations + merge conflict detection.
 *
 * Post-Ship-1: DoltStateStore implements `DoltOperatorReader` (not the full
 * StateStore interface). The pre-Ship-1 write-routing tests (which mixed
 * setStoryState/recordMetric/setContracts with branchForStory) are no longer
 * relevant — those write methods were excised. This file now covers:
 *  - AC1: branchForStory creates a branch and registers it
 *  - AC3: mergeStory after branchForStory issues DOLT_MERGE + DOLT_COMMIT
 *  - AC4: rollbackStory issues DOLT_BRANCH -D
 *  - AC5: merge-conflict detection throws DoltMergeConflictError
 *
 * DoltClient is fully mocked. No real Dolt server required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DoltStateStore } from '../dolt-store.js'
import { DoltMergeConflictError } from '../errors.js'
import { FileStateStore } from '../file-store.js'
import type { DoltClient } from '../dolt-client.js'

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

function makeMockClient(queryImpl?: (sql: string) => unknown[] | Promise<unknown[]>): DoltClient {
  return {
    repoPath: '/tmp/testrepo',
    socketPath: '/tmp/testrepo/.dolt/dolt.sock',
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation(queryImpl ?? (async () => [])),
    exec: vi.fn().mockResolvedValue(''),
    execArgs: vi.fn().mockResolvedValue(''),
  } as unknown as DoltClient
}

function makeStore(client: DoltClient): DoltStateStore {
  return new DoltStateStore({ repoPath: '/tmp/testrepo', client })
}

describe('AC1: branchForStory', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls CALL DOLT_BRANCH with story/storyKey on main branch', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    const calls = vi.mocked(client.query).mock.calls
    const branchCall = calls.find(([sql]) => String(sql).includes('DOLT_BRANCH'))
    expect(branchCall).toBeDefined()
    expect(String(branchCall![0])).toContain('story/26-7')
    // Third arg is the branch target ('main')
    expect(branchCall![2]).toBe('main')
  })

  it('throws DoltQueryError when branch creation fails', async () => {
    const client = makeMockClient()
    vi.mocked(client.query).mockRejectedValueOnce(new Error('branch creation failed'))
    const store = makeStore(client)
    await expect(store.branchForStory('26-7')).rejects.toThrow()
  })

  it('FileStateStore branchForStory is a no-op', async () => {
    const store = new FileStateStore()
    await expect(store.branchForStory('26-7')).resolves.toBeUndefined()
  })
})

describe('AC3: mergeStory', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is a no-op when no branch is registered', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await expect(store.mergeStory('26-7')).resolves.toBeUndefined()
    const calls = vi.mocked(client.query).mock.calls
    const mergeCall = calls.find(([sql]) => String(sql).includes('DOLT_MERGE'))
    expect(mergeCall).toBeUndefined()
  })

  it('calls DOLT_MERGE targeting main after branchForStory', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    vi.mocked(client.query).mockClear()
    vi.mocked(client.query).mockResolvedValue([{ hash: 'abc123', fast_forward: 1, conflicts: 0, message: '' }])
    await store.mergeStory('26-7')
    const calls = vi.mocked(client.query).mock.calls
    const mergeCall = calls.find(([sql]) => String(sql).includes('DOLT_MERGE'))
    expect(mergeCall).toBeDefined()
    expect(mergeCall![2]).toBe('main')
  })

  it('calls DOLT_COMMIT with correct message after merge', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    vi.mocked(client.query).mockClear()
    vi.mocked(client.query).mockResolvedValue([{ hash: 'abc123', fast_forward: 1, conflicts: 0, message: '' }])
    await store.mergeStory('26-7')
    const calls = vi.mocked(client.query).mock.calls
    // Find the post-merge commit that references the story key
    const commitCall = calls.find(([sql]) => String(sql).includes('DOLT_COMMIT') && String(sql).includes('Merge story 26-7'))
    expect(commitCall).toBeDefined()
  })
})

describe('AC4: rollbackStory', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is a no-op when no branch is registered', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await expect(store.rollbackStory('26-7')).resolves.toBeUndefined()
    const calls = vi.mocked(client.query).mock.calls
    const dropCall = calls.find(([sql]) => String(sql).includes('DOLT_BRANCH') && String(sql).includes('-D'))
    expect(dropCall).toBeUndefined()
  })

  it('calls DOLT_BRANCH -D on main after branchForStory', async () => {
    const client = makeMockClient()
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
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    vi.mocked(client.query).mockClear()
    vi.mocked(client.query).mockRejectedValue(new Error('branch not found'))
    await expect(store.rollbackStory('26-7')).resolves.toBeUndefined()
  })

  it('FileStateStore rollbackStory is a no-op', async () => {
    const store = new FileStateStore()
    await expect(store.rollbackStory('26-7')).resolves.toBeUndefined()
  })
})

describe('AC5: Merge conflict detection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('throws DoltMergeConflictError when DOLT_MERGE returns conflicts > 0', async () => {
    // The store needs DOLT_MERGE to return a row with conflicts > 0; other
    // queries (DOLT_ADD, DOLT_COMMIT pre-merge, dolt_conflicts lookup) return [].
    const client = makeMockClient(async (sql: string) => {
      if (sql.includes('DOLT_MERGE')) {
        return [{ hash: 'abc123', fast_forward: 0, conflicts: 1, message: '' }]
      }
      return []
    })
    const store = makeStore(client)
    await store.branchForStory('26-7')
    await expect(store.mergeStory('26-7')).rejects.toBeInstanceOf(DoltMergeConflictError)
  })

  it('DoltMergeConflictError has table field', async () => {
    const client = makeMockClient(async (sql: string) => {
      if (sql.includes('DOLT_MERGE')) {
        return [{ hash: 'abc123', fast_forward: 0, conflicts: 1, message: '' }]
      }
      if (sql.includes('dolt_conflicts')) {
        return [{ table_name: 'wg_stories' }]
      }
      return []
    })
    const store = makeStore(client)
    await store.branchForStory('26-7')
    try {
      await store.mergeStory('26-7')
      expect.fail('expected DoltMergeConflictError')
    } catch (err) {
      expect(err).toBeInstanceOf(DoltMergeConflictError)
      expect((err as DoltMergeConflictError).table).toBe('wg_stories')
    }
  })
})

describe('Story key validation', () => {
  it('rejects story key with special characters', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await expect(store.branchForStory('bad;DROP TABLE')).rejects.toThrow(/Invalid story key/)
  })

  it('accepts alphanumeric story keys like abc-def, 1-1a, NEW-26, E6', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await expect(store.branchForStory('1-1a')).resolves.toBeUndefined()
    await expect(store.branchForStory('NEW-26')).resolves.toBeUndefined()
    await expect(store.branchForStory('E6')).resolves.toBeUndefined()
  })
})
