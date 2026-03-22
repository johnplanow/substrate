// @vitest-environment node
/**
 * Unit tests for DoltStateStore branch-per-story operations (Story 26-7).
 *
 * Covers AC1 (branchForStory), AC2 (write routing), AC3 (mergeStory),
 * AC4 (rollbackStory), AC5 (merge conflicts), AC6 (diffStory row-level).
 *
 * DoltClient is fully mocked. No real Dolt server required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DoltStateStore } from '../dolt-store.js'
import { DoltMergeConflictError } from '../errors.js'
import type { DoltClient } from '../dolt-client.js'
import type { StoryRecord, MetricRecord, ContractRecord } from '../types.js'

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

function makeMockClient(): DoltClient {
  return {
    repoPath: '/tmp/testrepo',
    socketPath: '/tmp/testrepo/.dolt/dolt.sock',
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(''),
  } as unknown as DoltClient
}

function makeStore(client: DoltClient): DoltStateStore {
  return new DoltStateStore({ repoPath: '/tmp/testrepo', client })
}

function makeStory(overrides: Partial<StoryRecord> = {}): StoryRecord {
  return { storyKey: '26-7', phase: 'PENDING', reviewCycles: 0, ...overrides }
}

// ---------------------------------------------------------------------------
// AC1: branchForStory creates branch and sets _storyBranches
// ---------------------------------------------------------------------------

describe('AC1: branchForStory', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls CALL DOLT_BRANCH with story/storyKey on main branch', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    const calls = vi.mocked(client.query).mock.calls
    const branchCall = calls.find(([sql]) => String(sql).includes('DOLT_BRANCH'))
    expect(branchCall).toBeDefined()
    expect(String(branchCall![0])).toContain("story/26-7")
    // Should target 'main' branch (3rd arg)
    expect(branchCall![2]).toBe('main')
  })

  it('registers the branch in the internal map (affects subsequent writes)', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    vi.mocked(client.query).mockClear()

    // Now setStoryState should target story/26-7
    await store.setStoryState('26-7', makeStory({ phase: 'IN_DEV' }))
    const calls = vi.mocked(client.query).mock.calls
    const replaceCall = calls.find(([sql]) => String(sql).includes('REPLACE INTO'))
    expect(replaceCall).toBeDefined()
    // Branch arg should be 'story/26-7'
    expect(replaceCall![2]).toBe('story/26-7')
  })

  it('throws DoltQueryError when branch creation fails', async () => {
    const client = makeMockClient()
    vi.mocked(client.query).mockRejectedValueOnce(new Error('branch exists'))
    const store = makeStore(client)
    await expect(store.branchForStory('26-7')).rejects.toThrow()
  })

  it('FileStateStore branchForStory is a no-op', async () => {
    const { FileStateStore } = await import('../file-store.js')
    const store = new FileStateStore()
    await expect(store.branchForStory('26-7')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC2: Write routing — writes target story branch after branchForStory
// ---------------------------------------------------------------------------

describe('AC2: Write routing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('setStoryState targets main when no branch registered', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.setStoryState('26-7', makeStory())
    const calls = vi.mocked(client.query).mock.calls
    const replaceCall = calls.find(([sql]) => String(sql).includes('REPLACE INTO'))
    expect(replaceCall).toBeDefined()
    // No branch or 'main' branch
    expect(replaceCall![2] ?? 'main').toBe('main')
  })

  it('setStoryState targets story/26-7 after branchForStory', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    vi.mocked(client.query).mockClear()
    vi.mocked(client.query).mockResolvedValue([])
    await store.setStoryState('26-7', makeStory({ phase: 'IN_DEV' }))
    const calls = vi.mocked(client.query).mock.calls
    const replaceCall = calls.find(([sql]) => String(sql).includes('REPLACE INTO'))
    expect(replaceCall![2]).toBe('story/26-7')
  })

  it('different stories target different branches independently', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    await store.branchForStory('26-8')
    vi.mocked(client.query).mockClear()
    vi.mocked(client.query).mockResolvedValue([])

    await store.setStoryState('26-7', makeStory({ storyKey: '26-7' }))
    await store.setStoryState('26-8', makeStory({ storyKey: '26-8' }))

    const calls = vi.mocked(client.query).mock.calls
    const story7Calls = calls.filter(([sql, , branch]) => String(sql).includes('REPLACE INTO') && branch === 'story/26-7')
    const story8Calls = calls.filter(([sql, , branch]) => String(sql).includes('REPLACE INTO') && branch === 'story/26-8')
    expect(story7Calls).toHaveLength(1)
    expect(story8Calls).toHaveLength(1)
  })

  it('recordMetric routes to story branch', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    vi.mocked(client.query).mockClear()
    vi.mocked(client.query).mockResolvedValue([])
    const metric: MetricRecord = { storyKey: '26-7', taskType: 'dev-story', wallClockMs: 1000 }
    await store.recordMetric(metric)
    const calls = vi.mocked(client.query).mock.calls
    const insertCall = calls.find(([sql]) => String(sql).includes('INSERT INTO metrics'))
    expect(insertCall).toBeDefined()
    expect(insertCall![2]).toBe('story/26-7')
  })

  it('setContracts routes to story branch', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    vi.mocked(client.query).mockClear()
    vi.mocked(client.query).mockResolvedValue([])
    const contracts: ContractRecord[] = [
      { storyKey: '26-7', contractName: 'Foo', direction: 'export', schemaPath: 'foo.ts' },
    ]
    await store.setContracts('26-7', contracts)
    const calls = vi.mocked(client.query).mock.calls
    const deleteCall = calls.find(([sql]) => String(sql).includes('DELETE FROM contracts'))
    expect(deleteCall![2]).toBe('story/26-7')
  })
})

// ---------------------------------------------------------------------------
// AC3: mergeStory merges into main and removes branch mapping
// ---------------------------------------------------------------------------

describe('AC3: mergeStory', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is a no-op and logs warning when no branch registered', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await expect(store.mergeStory('26-7')).resolves.toBeUndefined()
    const calls = vi.mocked(client.query).mock.calls
    expect(calls.find(([sql]) => String(sql).includes('DOLT_MERGE'))).toBeUndefined()
  })

  it('calls DOLT_MERGE targeting main after branchForStory', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    vi.mocked(client.query).mockClear()
    // Return no conflicts
    vi.mocked(client.query).mockResolvedValue([{ hash: 'abc', fast_forward: 1, conflicts: 0, message: '' }])
    await store.mergeStory('26-7')
    const calls = vi.mocked(client.query).mock.calls
    const mergeCall = calls.find(([sql]) => String(sql).includes('DOLT_MERGE'))
    expect(mergeCall).toBeDefined()
    expect(String(mergeCall![0])).toContain('story/26-7')
    expect(mergeCall![2]).toBe('main')
  })

  it('calls DOLT_COMMIT with correct message after merge', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    vi.mocked(client.query).mockClear()
    vi.mocked(client.query).mockResolvedValue([{ hash: 'abc', fast_forward: 1, conflicts: 0, message: '' }])
    await store.mergeStory('26-7')
    const calls = vi.mocked(client.query).mock.calls
    // Find the post-merge DOLT_COMMIT (contains "Merge story"), not the pre-merge ones
    const commitCall = calls.find(([sql]) => String(sql).includes('Merge story'))
    expect(commitCall).toBeDefined()
    expect(String(commitCall![0])).toContain('Merge story 26-7: COMPLETE')
  })

  it('removes the branch mapping from _storyBranches after merge', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    vi.mocked(client.query).mockClear()
    vi.mocked(client.query).mockResolvedValue([{ hash: 'abc', fast_forward: 1, conflicts: 0, message: '' }])
    await store.mergeStory('26-7')
    // After merge, subsequent writes should target 'main' again
    vi.mocked(client.query).mockClear()
    vi.mocked(client.query).mockResolvedValue([])
    await store.setStoryState('26-7', makeStory())
    const calls = vi.mocked(client.query).mock.calls
    const replaceCall = calls.find(([sql]) => String(sql).includes('REPLACE INTO'))
    expect(replaceCall![2] ?? 'main').toBe('main')
  })
})

// ---------------------------------------------------------------------------
// AC4: rollbackStory drops the branch
// ---------------------------------------------------------------------------

describe('AC4: rollbackStory', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is a no-op when no branch is registered', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await expect(store.rollbackStory('26-7')).resolves.toBeUndefined()
    const calls = vi.mocked(client.query).mock.calls
    expect(calls.find(([sql]) => String(sql).includes('DOLT_BRANCH') && String(sql).includes('-D'))).toBeUndefined()
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
    expect(String(dropCall![0])).toContain('story/26-7')
    expect(dropCall![2]).toBe('main')
  })

  it('removes branch mapping from _storyBranches', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    vi.mocked(client.query).mockClear()
    vi.mocked(client.query).mockResolvedValue([])
    await store.rollbackStory('26-7')
    // After rollback, subsequent writes should target 'main'
    vi.mocked(client.query).mockClear()
    vi.mocked(client.query).mockResolvedValue([])
    await store.setStoryState('26-7', makeStory())
    const calls = vi.mocked(client.query).mock.calls
    const replaceCall = calls.find(([sql]) => String(sql).includes('REPLACE INTO'))
    expect(replaceCall![2] ?? 'main').toBe('main')
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
    const { FileStateStore } = await import('../file-store.js')
    const store = new FileStateStore()
    await expect(store.rollbackStory('26-7')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC5: mergeStory throws DoltMergeConflictError when conflicts detected
// ---------------------------------------------------------------------------

describe('AC5: Merge conflict detection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('throws DoltMergeConflictError when DOLT_MERGE returns conflicts > 0', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    vi.mocked(client.query).mockClear()
    // Pre-merge commits (4 calls: DOLT_ADD + DOLT_COMMIT on story branch, DOLT_ADD + DOLT_COMMIT on main)
    vi.mocked(client.query).mockResolvedValueOnce([]) // DOLT_ADD on story branch
    vi.mocked(client.query).mockResolvedValueOnce([]) // DOLT_COMMIT on story branch
    vi.mocked(client.query).mockResolvedValueOnce([]) // DOLT_ADD on main
    vi.mocked(client.query).mockResolvedValueOnce([]) // DOLT_COMMIT on main
    // DOLT_MERGE returns conflicts=1
    vi.mocked(client.query).mockResolvedValueOnce([{ hash: null, fast_forward: 0, conflicts: 1, message: 'conflicts' }])
    // dolt_conflicts_stories returns conflict detail
    vi.mocked(client.query).mockResolvedValueOnce([{
      base_story_key: '26-7',
      our_status: 'COMPLETE',
      their_status: 'ESCALATED',
    }])
    await expect(store.mergeStory('26-7')).rejects.toBeInstanceOf(DoltMergeConflictError)
  })

  it('DoltMergeConflictError has table field', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    vi.mocked(client.query).mockClear()
    // Pre-merge commits (4 calls)
    vi.mocked(client.query).mockResolvedValueOnce([]) // DOLT_ADD on story branch
    vi.mocked(client.query).mockResolvedValueOnce([]) // DOLT_COMMIT on story branch
    vi.mocked(client.query).mockResolvedValueOnce([]) // DOLT_ADD on main
    vi.mocked(client.query).mockResolvedValueOnce([]) // DOLT_COMMIT on main
    vi.mocked(client.query).mockResolvedValueOnce([{ conflicts: 1, hash: null, fast_forward: 0, message: '' }])
    vi.mocked(client.query).mockResolvedValueOnce([{ base_story_key: '26-7', our_status: 'A', their_status: 'B' }])
    try {
      await store.mergeStory('26-7')
      expect.fail('Should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DoltMergeConflictError)
      expect((err as DoltMergeConflictError).table).toBe('stories')
    }
  })
})

// ---------------------------------------------------------------------------
// AC6: diffStory returns row-level diff via DOLT_DIFF SQL (Story 26-7)
// ---------------------------------------------------------------------------

describe('AC6: diffStory row-level diff', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns empty tables when no branchForStory has been called', async () => {
    // _storyBranches has no entry → falls back to merged-story lookup via dolt_log,
    // which returns empty → result is empty tables
    const client = makeMockClient()
    const store = makeStore(client)
    const diff = await store.diffStory('26-7')
    expect(diff).toEqual({ storyKey: '26-7', tables: [] })
    // dolt_log query is issued for the merged-story fallback
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('dolt_log'),
      expect.arrayContaining(['%26-7%']),
    )
  })

  it('returns row-level DiffRow arrays via DOLT_DIFF SQL when branch is registered', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    // Set up query mock: DOLT_BRANCH returns [], DOLT_DIFF returns rows for specific tables
    vi.mocked(client.query).mockImplementation(async (sql: string) => {
      if (sql.includes('DOLT_BRANCH')) return []
      if (sql.includes("DOLT_DIFF") && sql.includes("'stories'")) {
        return [
          { diff_type: 'added', after_story_key: '26-7', after_phase: 'COMPLETE', before_story_key: null },
          { diff_type: 'modified', after_story_key: '26-7', after_phase: 'IN_REVIEW', before_story_key: '26-7', before_phase: 'IN_DEV' },
        ]
      }
      if (sql.includes("DOLT_DIFF") && sql.includes("'contracts'")) {
        return [
          { diff_type: 'removed', before_story_key: '26-7', before_contract_name: 'old-contract', after_story_key: null },
        ]
      }
      return []
    })
    await store.branchForStory('26-7')
    const diff = await store.diffStory('26-7')
    expect(diff.storyKey).toBe('26-7')
    const storiesTable = diff.tables.find((t) => t.table === 'stories')
    expect(storiesTable).toBeDefined()
    expect(storiesTable!.added).toHaveLength(1)
    expect(storiesTable!.added[0]!.rowKey).toBe('26-7')
    expect(storiesTable!.modified).toHaveLength(1)
    expect(storiesTable!.deleted).toHaveLength(0)
    const contractsTable = diff.tables.find((t) => t.table === 'contracts')
    expect(contractsTable).toBeDefined()
    expect(contractsTable!.deleted).toHaveLength(1)
    expect(contractsTable!.added).toHaveLength(0)
    expect(contractsTable!.modified).toHaveLength(0)
  })

  it('returns empty tables after rollbackStory removes the branch registration', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    await store.branchForStory('26-7')
    await store.rollbackStory('26-7')
    // _storyBranches entry deleted by rollback → diffStory returns empty
    const diff = await store.diffStory('26-7')
    expect(diff).toEqual({ storyKey: '26-7', tables: [] })
  })

  it('returns empty tables when all DOLT_DIFF queries return no rows', async () => {
    const client = makeMockClient()
    const store = makeStore(client)
    // query returns [] by default (including for DOLT_DIFF)
    await store.branchForStory('26-7')
    const diff = await store.diffStory('26-7')
    expect(diff.tables).toHaveLength(0)
  })

  it('FileStateStore diffStory always returns empty tables', async () => {
    const { FileStateStore } = await import('../file-store.js')
    const store = new FileStateStore()
    const diff = await store.diffStory('26-7')
    expect(diff).toEqual({ storyKey: '26-7', tables: [] })
  })
})

// ---------------------------------------------------------------------------
// Story key validation — prevents SQL injection via interpolated identifiers
// ---------------------------------------------------------------------------

describe('Story key validation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('branchForStory rejects story key with SQL injection payload', async () => {
    const store = makeStore(makeMockClient())
    await expect(store.branchForStory("'; DROP TABLE stories;--")).rejects.toThrow('Invalid story key')
  })

  it('mergeStory rejects story key with spaces', async () => {
    const store = makeStore(makeMockClient())
    await expect(store.mergeStory('26 7')).rejects.toThrow('Invalid story key')
  })

  it('rollbackStory rejects story key with slashes', async () => {
    const store = makeStore(makeMockClient())
    await expect(store.rollbackStory('26/7')).rejects.toThrow('Invalid story key')
  })

  it('diffStory rejects story key with special characters', async () => {
    const store = makeStore(makeMockClient())
    await expect(store.diffStory('bad!key')).rejects.toThrow('Invalid story key')
  })

  it('diffStory accepts alphanumeric story keys like abc-def, 1-1a, NEW-26, E6', async () => {
    const store = makeStore(makeMockClient())
    // These should not throw validation — single-segment and hyphenated keys are valid
    await expect(store.diffStory('abc-def')).resolves.toBeDefined()
    await expect(store.diffStory('1-1a')).resolves.toBeDefined()
    await expect(store.diffStory('NEW-26')).resolves.toBeDefined()
    await expect(store.diffStory('E6')).resolves.toBeDefined()
  })

  it('accepts valid story keys like 26-7, 1-1, 100-999', async () => {
    const store = makeStore(makeMockClient())
    // These should not throw (they may hit mock client but won't fail validation)
    await expect(store.branchForStory('26-7')).resolves.toBeUndefined()
    await expect(store.branchForStory('1-1')).resolves.toBeUndefined()
    await expect(store.branchForStory('100-999')).resolves.toBeUndefined()
  })
})
