// @vitest-environment node
/**
 * Integration tests for `substrate status` — StateStore integration (Story 26-8).
 *
 * These tests verify:
 * - AC1: runStatusAction with StateStore reads stories via queryStories({})
 * - AC2: story_states field appears in JSON output when StateStore provides stories
 * - AC4: --history flag triggers getHistory on the StateStore
 * - AC6: Backward compatibility — when no StateStore, existing DB path is used
 * - AC7: Degraded mode — config loading failure still calls runStatusAction
 *
 * Unlike status-store.test.ts, these tests mock the DB to exist so the full
 * code path (including StateStore queries) is exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StateStore, StoryRecord, HistoryEntry } from '../../../modules/state/index.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/test-project'),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}))

// Mock existsSync to return true for the DB path so we get past the early return
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
  }
})

// Mock DatabaseAdapter — replaces legacy DatabaseWrapper mock
const mockAdapterQuery = vi.fn().mockResolvedValue([])
const mockAdapterExec = vi.fn().mockResolvedValue(undefined)
const mockAdapterClose = vi.fn().mockResolvedValue(undefined)
const mockAdapterQueryReadyStories = vi.fn().mockResolvedValue([])
const mockAdapterObj = {
  query: mockAdapterQuery,
  exec: mockAdapterExec,
  transaction: vi.fn(),
  close: mockAdapterClose,
  queryReadyStories: mockAdapterQueryReadyStories,
}

vi.mock('../../../persistence/adapter.js', () => ({
  createDatabaseAdapter: vi.fn(() => mockAdapterObj),
}))

vi.mock('../../../persistence/schema.js', () => ({
  initSchema: vi.fn().mockResolvedValue(undefined),
}))

// Mock WorkGraphRepository used by status.ts
vi.mock('../../../modules/state/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../modules/state/index.js')>()
  return {
    ...actual,
    WorkGraphRepository: vi.fn(() => ({
      getReadyStories: vi.fn().mockResolvedValue([]),
      getBlockedStories: vi.fn().mockResolvedValue([]),
    })),
  }
})

// Default: getLatestRun returns a run, getTokenUsageSummary returns zeroes
vi.mock('../../../persistence/queries/decisions.js', () => ({
  getLatestRun: vi.fn().mockResolvedValue({
    id: 'test-run-123',
    status: 'completed',
    methodology: 'bmad',
    current_phase: 'implementation',
    created_at: '2026-03-08 10:00:00',
    updated_at: '2026-03-08 11:00:00',
    config_json: '{}',
    token_usage_json: null,
  }),
  // getTokenUsageSummary returns TokenUsageSummary[] — an array
  getTokenUsageSummary: vi.fn().mockResolvedValue([]),
  getPipelineRunById: vi.fn(),
}))

vi.mock('../../../persistence/queries/metrics.js', () => ({
  getStoryMetricsForRun: vi.fn().mockResolvedValue([]),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStoreWithStories(stories: StoryRecord[]): StateStore {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getStoryState: vi.fn().mockResolvedValue(undefined),
    setStoryState: vi.fn().mockResolvedValue(undefined),
    queryStories: vi.fn().mockResolvedValue(stories),
    recordMetric: vi.fn().mockResolvedValue(undefined),
    queryMetrics: vi.fn().mockResolvedValue([]),
    getContracts: vi.fn().mockResolvedValue([]),
    setContracts: vi.fn().mockResolvedValue(undefined),
    queryContracts: vi.fn().mockResolvedValue([]),
    setContractVerification: vi.fn().mockResolvedValue(undefined),
    getContractVerification: vi.fn().mockResolvedValue([]),
    branchForStory: vi.fn().mockResolvedValue(undefined),
    mergeStory: vi.fn().mockResolvedValue(undefined),
    rollbackStory: vi.fn().mockResolvedValue(undefined),
    diffStory: vi.fn().mockResolvedValue({ storyKey: '', tables: [] }),
    getHistory: vi.fn().mockResolvedValue([]),
  } as unknown as StateStore
}

function makeHistoryStore(entries: HistoryEntry[]): StateStore {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getStoryState: vi.fn().mockResolvedValue(undefined),
    setStoryState: vi.fn().mockResolvedValue(undefined),
    queryStories: vi.fn().mockResolvedValue([]),
    recordMetric: vi.fn().mockResolvedValue(undefined),
    queryMetrics: vi.fn().mockResolvedValue([]),
    getContracts: vi.fn().mockResolvedValue([]),
    setContracts: vi.fn().mockResolvedValue(undefined),
    queryContracts: vi.fn().mockResolvedValue([]),
    setContractVerification: vi.fn().mockResolvedValue(undefined),
    getContractVerification: vi.fn().mockResolvedValue([]),
    branchForStory: vi.fn().mockResolvedValue(undefined),
    mergeStory: vi.fn().mockResolvedValue(undefined),
    rollbackStory: vi.fn().mockResolvedValue(undefined),
    diffStory: vi.fn().mockResolvedValue({ storyKey: '', tables: [] }),
    getHistory: vi.fn().mockResolvedValue(entries),
  } as unknown as StateStore
}

// ---------------------------------------------------------------------------
// Capture stdout/stderr
// ---------------------------------------------------------------------------

let stdoutChunks: string[]
let stderrChunks: string[]
const origStdout = process.stdout.write
const origStderr = process.stderr.write

beforeEach(() => {
  stdoutChunks = []
  stderrChunks = []
  process.stdout.write = ((chunk: string) => {
    stdoutChunks.push(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    stderrChunks.push(chunk)
    return true
  }) as typeof process.stderr.write
  // Reset adapter query mock for each test — returns empty arrays by default
  mockAdapterQuery.mockResolvedValue([])
})

afterEach(() => {
  process.stdout.write = origStdout
  process.stderr.write = origStderr
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests: AC1/AC2 — happy path with DB existing and StateStore providing stories
// ---------------------------------------------------------------------------

describe('runStatusAction — AC1/AC2 happy path (DB exists, StateStore has stories)', () => {
  it('JSON output includes story_states array with StateStore data', async () => {
    const { runStatusAction } = await import('../status.js')
    const store = makeStoreWithStories([
      { storyKey: '26-1', phase: 'COMPLETE', reviewCycles: 2 },
      { storyKey: '26-2', phase: 'IN_DEV', reviewCycles: 1 },
    ])

    const exitCode = await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      stateStore: store,
    })

    expect(exitCode).toBe(0)
    expect(store.queryStories).toHaveBeenCalledWith({})

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { story_states: StoryRecord[] } }
    expect(parsed.success).toBe(true)
    expect(parsed.data.story_states).toBeDefined()
    expect(parsed.data.story_states).toHaveLength(2)
    expect(parsed.data.story_states[0].storyKey).toBe('26-1')
    expect(parsed.data.story_states[0].phase).toBe('COMPLETE')
    expect(parsed.data.story_states[1].storyKey).toBe('26-2')
  })

  it('JSON output includes story_states as empty array when StateStore has no stories', async () => {
    const { runStatusAction } = await import('../status.js')
    const store = makeStoreWithStories([])

    const exitCode = await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      stateStore: store,
    })

    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { story_states: StoryRecord[] } }
    expect(parsed.data.story_states).toEqual([])
  })

  it('human output includes StateStore story states section', async () => {
    const { runStatusAction } = await import('../status.js')
    const store = makeStoreWithStories([
      { storyKey: '26-1', phase: 'COMPLETE', reviewCycles: 3 },
    ])

    const exitCode = await runStatusAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      stateStore: store,
    })

    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    expect(output).toContain('StateStore Story States')
    expect(output).toContain('26-1')
    expect(output).toContain('COMPLETE')
    expect(output).toContain('3 review cycles')
  })

  it('queryStories is called and result is included even when empty', async () => {
    const { runStatusAction } = await import('../status.js')
    const store = makeStoreWithStories([])

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      stateStore: store,
    })

    expect(store.queryStories).toHaveBeenCalledWith({})
  })
})

// ---------------------------------------------------------------------------
// Tests: AC6 — backward compatibility when no StateStore
// ---------------------------------------------------------------------------

describe('runStatusAction — AC6 backward compat (no StateStore)', () => {
  it('JSON output includes story_states as empty array when no stateStore', async () => {
    const { runStatusAction } = await import('../status.js')

    const exitCode = await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
    })

    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { story_states: StoryRecord[] } }
    expect(parsed.data.story_states).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Tests: AC4 — --history with full StateStore
// ---------------------------------------------------------------------------

describe('runStatusAction — AC4 --history with StateStore', () => {
  it('renders history table with 3 entries in human format', async () => {
    const { runStatusAction } = await import('../status.js')
    const entries: HistoryEntry[] = [
      { hash: 'abc1234', timestamp: '2026-03-08T12:00:00Z', storyKey: '26-1', message: 'Merge story/26-1' },
      { hash: 'def5678', timestamp: '2026-03-08T11:00:00Z', storyKey: '26-2', message: 'Merge story/26-2' },
      { hash: 'ghi9012', timestamp: '2026-03-08T10:00:00Z', storyKey: null, message: 'initial commit' },
    ]
    const store = makeHistoryStore(entries)

    const exitCode = await runStatusAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      stateStore: store,
      history: true,
    })

    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    expect(output).toContain('TIMESTAMP')
    expect(output).toContain('HASH')
    expect(output).toContain('MESSAGE')
    expect(output).toContain('abc1234')
    expect(output).toContain('def5678')
    expect(output).toContain('ghi9012')
    expect(output).toContain('Merge story/26-1')
    expect(output).toContain('initial commit')
  })

  it('returns JSON array of HistoryEntry objects', async () => {
    const { runStatusAction } = await import('../status.js')
    const entries: HistoryEntry[] = [
      { hash: 'abc1234', timestamp: '2026-03-08T12:00:00Z', storyKey: '26-1', message: 'Merge story/26-1' },
    ]
    const store = makeHistoryStore(entries)

    const exitCode = await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      stateStore: store,
      history: true,
    })

    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as HistoryEntry[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].hash).toBe('abc1234')
    expect(parsed[0].storyKey).toBe('26-1')
  })
})

// ---------------------------------------------------------------------------
// Tests: AC7 — degraded mode when StateStore throws
// ---------------------------------------------------------------------------

describe('runStatusAction — AC7 degraded mode (StateStore query fails)', () => {
  it('continues with empty story_states when stateStore.queryStories throws', async () => {
    const { runStatusAction } = await import('../status.js')
    const store = makeStoreWithStories([])
    // Override queryStories to throw
    vi.mocked(store.queryStories).mockRejectedValue(new Error('connection refused'))

    const exitCode = await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      stateStore: store,
    })

    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { story_states: StoryRecord[] } }
    expect(parsed.success).toBe(true)
    // story_states should be empty array (fallback) since queryStories threw
    expect(parsed.data.story_states).toEqual([])
  })

  it('runStatusAction still works when stateStore is undefined (config load failure)', async () => {
    const { runStatusAction } = await import('../status.js')

    // This simulates AC7: config loading fails, stateStore is undefined
    const exitCode = await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      stateStore: undefined,
    })

    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { story_states: StoryRecord[] } }
    expect(parsed.success).toBe(true)
    expect(parsed.data.story_states).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Tests: getAutoHealthData with mock DoltStateStore (AC3)
// ---------------------------------------------------------------------------

describe('getAutoHealthData — dolt_state integration (AC3)', () => {
  it('includes dolt_state with initialized and responsive when Dolt backend configured', async () => {
    const { existsSync } = await import('fs')
    // Make .dolt path exist, .substrate/substrate.db not exist (NO_PIPELINE scenario)
    vi.mocked(existsSync).mockImplementation((p) => {
      const ps = String(p)
      if (ps.includes('.dolt')) return true
      return false
    })

    const { getAutoHealthData } = await import('../health.js')
    const store: StateStore = {
      initialize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getStoryState: vi.fn().mockResolvedValue(undefined),
      setStoryState: vi.fn().mockResolvedValue(undefined),
      queryStories: vi.fn().mockResolvedValue([]),
      recordMetric: vi.fn().mockResolvedValue(undefined),
      queryMetrics: vi.fn().mockResolvedValue([]),
      getContracts: vi.fn().mockResolvedValue([]),
      setContracts: vi.fn().mockResolvedValue(undefined),
      queryContracts: vi.fn().mockResolvedValue([]),
      setContractVerification: vi.fn().mockResolvedValue(undefined),
      getContractVerification: vi.fn().mockResolvedValue([]),
      branchForStory: vi.fn().mockResolvedValue(undefined),
      mergeStory: vi.fn().mockResolvedValue(undefined),
      rollbackStory: vi.fn().mockResolvedValue(undefined),
      diffStory: vi.fn().mockResolvedValue({ storyKey: '', tables: [] }),
      getHistory: vi.fn().mockResolvedValue([{ hash: 'abc', timestamp: '', storyKey: null, message: 'init' }]),
    } as unknown as StateStore

    const health = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      stateStore: store,
      stateStoreConfig: { backend: 'dolt', basePath: '/tmp/test-project/.substrate/state' },
    })

    expect(health.dolt_state).toBeDefined()
    expect(health.dolt_state!.initialized).toBe(true)
    expect(health.dolt_state!.responsive).toBe(true)
  })
})
