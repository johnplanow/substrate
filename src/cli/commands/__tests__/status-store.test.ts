// @vitest-environment node
/**
 * Integration tests for `substrate status --history`.
 *
 * Post-Ship-1: status.ts takes a DoltOperatorReader (not StateStore) for the
 * --history subcommand. The story-state read path that previously called
 * `stateStore.queryStories({})` was removed — the modern source-of-truth is
 * the run manifest + initSchema-managed tables (pipeline_runs, story_metrics).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runStatusAction } from '../status.js'
import type { DoltOperatorReader, HistoryEntry } from '../../../modules/state/index.js'

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

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
  }
})

function makeHistoryReader(entries: HistoryEntry[]): DoltOperatorReader {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    setMetric: vi.fn().mockResolvedValue(undefined),
    getMetric: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue(entries),
  }
}

describe('runStatusAction — --history flag', () => {
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

  it('prints message when history=true and no historyReader provided', async () => {
    const exitCode = await runStatusAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test',
      history: true,
    })
    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    expect(output).toContain('History not available with file backend')
  })

  it('returns JSON array of history entries when history=true with historyReader (json format)', async () => {
    const entries: HistoryEntry[] = [
      { hash: 'abc1234', timestamp: '2026-03-08T10:00:00Z', storyKey: '26-1', message: 'feat: story 26-1' },
      { hash: 'def5678', timestamp: '2026-03-08T09:00:00Z', storyKey: null, message: 'init repo' },
    ]
    const historyReader = makeHistoryReader(entries)

    const exitCode = await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test',
      historyReader,
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
      { hash: 'abc1234', timestamp: '2026-03-08T10:00:00Z', storyKey: '26-1', message: 'feat: implement story 26-1' },
    ]
    const historyReader = makeHistoryReader(entries)

    const exitCode = await runStatusAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test',
      historyReader,
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
    const historyReader = makeHistoryReader([])
    const exitCode = await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test',
      historyReader,
      history: true,
    })
    expect(exitCode).toBe(0)
    expect(historyReader.getHistory).toHaveBeenCalledWith(20)
  })
})

describe('runStatusAction — early return when no DB', () => {
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

  it('returns exit code 1 when DB does not exist', async () => {
    const exitCode = await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test',
    })
    expect(exitCode).toBe(1)
  })
})
