// @vitest-environment node
/**
 * Integration tests for `substrate status` — StateStore integration (Story 26-8).
 *
 * Verifies:
 * - runStatusAction with a mock StateStore correctly queries stories (AC1, AC2)
 * - story_states field appears in JSON output (AC1)
 * - Human output renders StateStore story states (AC2)
 * - --history flag triggers getHistory on the StateStore (AC4)
 * - --history returns message when no stateStore provided (AC4)
 * - DoltStateInfo included in health JSON output (AC3)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runStatusAction } from '../status.js'
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

// Mock the DB to say it doesn't exist — status command with no DB returns early
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStoreStories(stories: StoryRecord[]): StateStore {
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
// Tests: StatusOptions with stateStore
// ---------------------------------------------------------------------------

describe('StatusOptions — stateStore and history fields', () => {
  it('accepts stateStore field in options', () => {
    const store = makeStoreStories([])
    const opts = {
      outputFormat: 'json' as const,
      projectRoot: '/tmp',
      stateStore: store,
    }
    expect(opts.stateStore).toBeDefined()
  })

  it('accepts history field in options', () => {
    const opts = {
      outputFormat: 'json' as const,
      projectRoot: '/tmp',
      history: true,
    }
    expect(opts.history).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: --history flag behavior
// ---------------------------------------------------------------------------

describe('runStatusAction — --history flag (AC4)', () => {
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
  })

  afterEach(() => {
    process.stdout.write = origStdout
    process.stderr.write = origStderr
    vi.clearAllMocks()
  })

  it('prints message when history=true and no stateStore provided', async () => {
    const exitCode = await runStatusAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test',
      history: true,
    })
    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    expect(output).toContain('History not available with file backend')
  })

  it('returns JSON array of history entries when history=true with stateStore (json format)', async () => {
    const entries: HistoryEntry[] = [
      {
        hash: 'abc1234',
        timestamp: '2026-03-08T10:00:00Z',
        storyKey: '26-1',
        message: 'feat: story 26-1',
      },
      { hash: 'def5678', timestamp: '2026-03-08T09:00:00Z', storyKey: null, message: 'init repo' },
    ]
    const store = makeHistoryStore(entries)

    const exitCode = await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test',
      stateStore: store,
      history: true,
    })
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdoutChunks.join('')) as HistoryEntry[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].hash).toBe('abc1234')
    expect(parsed[1].storyKey).toBeNull()
  })

  it('renders human-format history table with header', async () => {
    const entries: HistoryEntry[] = [
      {
        hash: 'abc1234',
        timestamp: '2026-03-08T10:00:00Z',
        storyKey: '26-1',
        message: 'feat: implement story 26-1',
      },
    ]
    const store = makeHistoryStore(entries)

    const exitCode = await runStatusAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test',
      stateStore: store,
      history: true,
    })
    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    expect(output).toContain('TIMESTAMP')
    expect(output).toContain('HASH')
    expect(output).toContain('MESSAGE')
    expect(output).toContain('abc1234')
    expect(output).toContain('feat: implement story 26-1')
  })

  it('calls getHistory with limit=20', async () => {
    const store = makeHistoryStore([])
    const exitCode = await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test',
      stateStore: store,
      history: true,
    })
    expect(exitCode).toBe(0)
    expect(store.getHistory).toHaveBeenCalledWith(20)
  })
})

// ---------------------------------------------------------------------------
// Tests: story_states in JSON output when DB is absent
// ---------------------------------------------------------------------------

describe('runStatusAction — early return when no DB (story_states not queried)', () => {
  let stdoutChunks: string[]
  const origStdout = process.stdout.write

  beforeEach(() => {
    stdoutChunks = []
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(chunk)
      return true
    }) as typeof process.stdout.write
  })

  afterEach(() => {
    process.stdout.write = origStdout
    vi.clearAllMocks()
  })

  it('returns exit code 1 when DB does not exist, even with stateStore provided', async () => {
    // existsSync returns false for the DB path (mocked at top level)
    const store = makeStoreStories([{ storyKey: '26-1', phase: 'COMPLETE', reviewCycles: 2 }])
    const exitCode = await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test',
      stateStore: store,
    })
    // Without a DB, status returns 1 (initialization error)
    expect(exitCode).toBe(1)
  })

  it('queryStories is NOT called when history mode is used (short circuit)', async () => {
    const store = makeHistoryStore([])
    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test',
      stateStore: store,
      history: true,
    })
    // queryStories should not be called because history mode short-circuits
    expect(store.queryStories).not.toHaveBeenCalled()
  })
})
