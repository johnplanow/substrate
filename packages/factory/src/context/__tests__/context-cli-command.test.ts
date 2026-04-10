/**
 * Unit tests for `factory context` CLI commands.
 *
 * Story 49-7 AC7: minimum 12 test cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be created before any imports
// ---------------------------------------------------------------------------

const { mockStat, mockReaddir, mockReadFile } = vi.hoisted(() => ({
  mockStat: vi.fn(),
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  stat: mockStat,
  readdir: mockReaddir,
  readFile: mockReadFile,
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}))

const { mockGetOriginal, mockPut, mockGet, mockEngineSummarize, mockEngineExpand } = vi.hoisted(
  () => ({
    mockGetOriginal: vi.fn(),
    mockPut: vi.fn(),
    mockGet: vi.fn(),
    mockEngineSummarize: vi.fn(),
    mockEngineExpand: vi.fn(),
  })
)

vi.mock('../summary-cache.js', () => ({
  SummaryCache: vi.fn().mockImplementation(() => ({
    getOriginal: mockGetOriginal,
    put: mockPut,
    get: mockGet,
  })),
  CachingSummaryEngine: vi.fn().mockImplementation(() => ({
    summarize: mockEngineSummarize,
    expand: mockEngineExpand,
    name: 'caching(mock)',
  })),
}))

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import {
  summarizeAction,
  expandAction,
  statsAction,
  type CLIJsonOutput,
  type StatsRow,
} from '../cli-command.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_HASH = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1'
const TEST_HASH_2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function makeSummaryRecord(
  iterationIndex: number,
  level = 'medium',
  hash = TEST_HASH,
  cachedAt = '2025-01-01T00:00:00.000Z'
): string {
  return JSON.stringify({
    summary: {
      level,
      content: 'summarized content',
      originalHash: hash,
      createdAt: '2025-01-01T00:00:00.000Z',
      iterationIndex,
    },
    cachedAt,
  })
}

interface TestOutput {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  getStdout(): string
  getStderr(): string
}

function makeOutput(): TestOutput {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  return {
    stdout: {
      write: (s: string) => {
        stdoutChunks.push(s)
        return true
      },
    } as NodeJS.WritableStream,
    stderr: {
      write: (s: string) => {
        stderrChunks.push(s)
        return true
      },
    } as NodeJS.WritableStream,
    getStdout: () => stdoutChunks.join(''),
    getStderr: () => stderrChunks.join(''),
  }
}

const TEST_DEPS = { storageDir: '/test/.substrate', version: '1.0.0' }
const TEST_RUN = 'run-abc123'

// ---------------------------------------------------------------------------
// summarizeAction tests
// ---------------------------------------------------------------------------

describe('summarizeAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls SummaryCache.getOriginal() and CachingSummaryEngine.summarize() on success', async () => {
    mockStat.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue(['file-medium.json'])
    mockReadFile.mockResolvedValue(makeSummaryRecord(1, 'medium', TEST_HASH))
    mockGetOriginal.mockResolvedValue('original content')
    mockEngineSummarize.mockResolvedValue({
      level: 'medium',
      content: 'summarized',
      originalHash: TEST_HASH,
      createdAt: '2025-01-01T00:00:00.000Z',
    })
    mockPut.mockResolvedValue(undefined)

    const out = makeOutput()
    const code = await summarizeAction(
      { run: TEST_RUN, iteration: '1', level: 'medium', outputFormat: 'text' },
      TEST_DEPS,
      out
    )

    expect(code).toBe(0)
    expect(mockGetOriginal).toHaveBeenCalledWith(TEST_HASH)
    expect(mockEngineSummarize).toHaveBeenCalledWith('original content', 'medium')
    expect(out.getStdout()).toContain('Summarized iteration 1')
  })

  it('writes result via cache.put() with summary and original content', async () => {
    mockStat.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue(['file-medium.json'])
    mockReadFile.mockResolvedValue(makeSummaryRecord(1, 'medium', TEST_HASH))
    mockGetOriginal.mockResolvedValue('original content')
    const mockSummary = {
      level: 'medium' as const,
      content: 'summarized',
      originalHash: TEST_HASH,
      createdAt: '2025-01-01T00:00:00.000Z',
    }
    mockEngineSummarize.mockResolvedValue(mockSummary)
    mockPut.mockResolvedValue(undefined)

    const out = makeOutput()
    await summarizeAction(
      { run: TEST_RUN, iteration: '1', level: 'medium', outputFormat: 'text' },
      TEST_DEPS,
      out
    )

    expect(mockPut).toHaveBeenCalledWith(mockSummary, 'original content')
  })

  it('exits 1 on invalid level value', async () => {
    const out = makeOutput()
    const code = await summarizeAction(
      { run: TEST_RUN, iteration: '1', level: 'invalid', outputFormat: 'text' },
      TEST_DEPS,
      out
    )

    expect(code).toBe(1)
    expect(out.getStderr()).toContain('--level must be one of: full, high, medium, low')
    expect(mockStat).not.toHaveBeenCalled()
  })

  it('exits 1 when getOriginal returns null (original not found)', async () => {
    mockStat.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue(['file-medium.json'])
    mockReadFile.mockResolvedValue(makeSummaryRecord(1, 'medium', TEST_HASH))
    mockGetOriginal.mockResolvedValue(null)

    const out = makeOutput()
    const code = await summarizeAction(
      { run: TEST_RUN, iteration: '1', level: 'medium', outputFormat: 'text' },
      TEST_DEPS,
      out
    )

    expect(code).toBe(1)
    expect(out.getStderr()).toContain('Original content (.orig) not found')
  })

  it('exits 1 when run directory does not exist', async () => {
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const out = makeOutput()
    const code = await summarizeAction(
      { run: TEST_RUN, iteration: '1', level: 'medium', outputFormat: 'text' },
      TEST_DEPS,
      out
    )

    expect(code).toBe(1)
    expect(out.getStderr()).toContain('Run directory not found')
  })

  it('emits valid CLIJsonOutput when --output-format json', async () => {
    mockStat.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue(['file-medium.json'])
    mockReadFile.mockResolvedValue(makeSummaryRecord(1, 'medium', TEST_HASH))
    mockGetOriginal.mockResolvedValue('original content')
    mockEngineSummarize.mockResolvedValue({
      level: 'medium',
      content: 'summarized',
      originalHash: TEST_HASH,
      createdAt: '2025-01-01T00:00:00.000Z',
    })
    mockPut.mockResolvedValue(undefined)

    const out = makeOutput()
    const code = await summarizeAction(
      { run: TEST_RUN, iteration: '1', level: 'medium', outputFormat: 'json' },
      TEST_DEPS,
      out
    )

    expect(code).toBe(0)
    const parsed = JSON.parse(out.getStdout()) as CLIJsonOutput<unknown>
    expect(parsed).toHaveProperty('timestamp')
    expect(parsed).toHaveProperty('version', '1.0.0')
    expect(parsed).toHaveProperty('command', 'factory context summarize')
    expect(parsed).toHaveProperty('data')
    expect(parsed.data).toHaveProperty('hash', TEST_HASH)
    expect(parsed.data).toHaveProperty('level', 'medium')
  })

  it('exits 1 for non-integer --iteration value', async () => {
    const out = makeOutput()
    const code = await summarizeAction(
      { run: TEST_RUN, iteration: 'abc', level: 'medium', outputFormat: 'text' },
      TEST_DEPS,
      out
    )

    expect(code).toBe(1)
    expect(out.getStderr()).toContain('--iteration must be a non-negative integer')
  })
})

// ---------------------------------------------------------------------------
// expandAction tests
// ---------------------------------------------------------------------------

describe('expandAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls SummaryCache (via find) then CachingSummaryEngine.expand() on success', async () => {
    mockStat.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue(['file-medium.json'])
    mockReadFile.mockResolvedValue(makeSummaryRecord(2, 'medium', TEST_HASH))
    mockEngineExpand.mockResolvedValue('expanded content')

    const out = makeOutput()
    const code = await expandAction(
      { run: TEST_RUN, iteration: '2', outputFormat: 'text' },
      TEST_DEPS,
      out
    )

    expect(code).toBe(0)
    expect(mockEngineExpand).toHaveBeenCalledWith(
      expect.objectContaining({ originalHash: TEST_HASH }),
      'full'
    )
    expect(out.getStdout()).toContain('expanded content')
  })

  it('exits 1 when no summary found for requested iteration', async () => {
    mockStat.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue(['file-medium.json'])
    // File has iterationIndex 99, not the requested iteration 2
    mockReadFile.mockResolvedValue(makeSummaryRecord(99, 'medium', TEST_HASH))

    const out = makeOutput()
    const code = await expandAction(
      { run: TEST_RUN, iteration: '2', outputFormat: 'text' },
      TEST_DEPS,
      out
    )

    expect(code).toBe(1)
    expect(out.getStderr()).toContain('No summary found for iteration 2')
  })

  it('emits valid CLIJsonOutput when --output-format json', async () => {
    mockStat.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue(['file-medium.json'])
    mockReadFile.mockResolvedValue(makeSummaryRecord(3, 'medium', TEST_HASH))
    mockEngineExpand.mockResolvedValue('expanded full content')

    const out = makeOutput()
    const code = await expandAction(
      { run: TEST_RUN, iteration: '3', outputFormat: 'json' },
      TEST_DEPS,
      out
    )

    expect(code).toBe(0)
    const parsed = JSON.parse(out.getStdout()) as CLIJsonOutput<{
      hash: string
      level: string
      expandedLength: number
      content: string
    }>
    expect(parsed).toHaveProperty('timestamp')
    expect(parsed).toHaveProperty('version', '1.0.0')
    expect(parsed).toHaveProperty('command', 'factory context expand')
    expect(parsed.data).toHaveProperty('content', 'expanded full content')
    expect(parsed.data).toHaveProperty('hash', TEST_HASH)
  })

  it('exits 1 for non-integer --iteration value', async () => {
    const out = makeOutput()
    const code = await expandAction(
      { run: TEST_RUN, iteration: '1.5', outputFormat: 'text' },
      TEST_DEPS,
      out
    )

    expect(code).toBe(1)
    expect(out.getStderr()).toContain('--iteration must be a non-negative integer')
    expect(mockStat).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// statsAction tests
// ---------------------------------------------------------------------------

describe('statsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads all .json files and formats a table with compression stats', async () => {
    mockStat.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue(['file1-medium.json', 'file2-low.json', 'somehash.orig'])
    mockReadFile.mockImplementation((filePath: string) => {
      if ((filePath as string).endsWith('.json')) {
        if ((filePath as string).includes('file1')) {
          return Promise.resolve(
            makeSummaryRecord(1, 'medium', TEST_HASH, '2025-01-01T00:00:00.000Z')
          )
        }
        return Promise.resolve(makeSummaryRecord(2, 'low', TEST_HASH_2, '2025-01-02T00:00:00.000Z'))
      }
      // .orig file — throw ENOENT
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    })

    const out = makeOutput()
    const code = await statsAction({ run: TEST_RUN, outputFormat: 'text' }, TEST_DEPS, out)

    expect(code).toBe(0)
    const outputText = out.getStdout()
    expect(outputText).toContain('Hash')
    expect(outputText).toContain('Level')
    expect(outputText).toContain('CompRatio')
    expect(outputText).toContain('CachedAt')
    // Should have 2 data rows (file1 and file2)
    expect(outputText).toContain('medium')
    expect(outputText).toContain('low')
  })

  it('exits 1 when run directory does not exist', async () => {
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const out = makeOutput()
    const code = await statsAction({ run: TEST_RUN, outputFormat: 'text' }, TEST_DEPS, out)

    expect(code).toBe(1)
    expect(out.getStderr()).toContain('Run directory not found')
  })

  it('emits valid CLIJsonOutput with data array when --output-format json', async () => {
    mockStat.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue(['file-medium.json'])
    mockReadFile.mockImplementation((filePath: string) => {
      if ((filePath as string).endsWith('.json')) {
        return Promise.resolve(makeSummaryRecord(1, 'medium', TEST_HASH))
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    })

    const out = makeOutput()
    const code = await statsAction({ run: TEST_RUN, outputFormat: 'json' }, TEST_DEPS, out)

    expect(code).toBe(0)
    const parsed = JSON.parse(out.getStdout()) as CLIJsonOutput<StatsRow[]>
    expect(parsed).toHaveProperty('timestamp')
    expect(parsed).toHaveProperty('version', '1.0.0')
    expect(parsed).toHaveProperty('command', 'factory context stats')
    expect(Array.isArray(parsed.data)).toBe(true)
    expect(parsed.data).toHaveLength(1)
    expect(parsed.data[0]).toHaveProperty('hash', TEST_HASH)
    expect(parsed.data[0]).toHaveProperty('level', 'medium')
    expect(parsed.data[0]).toHaveProperty('cachedAt')
  })

  it('outputs empty message when no summary files exist', async () => {
    mockStat.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue([])

    const out = makeOutput()
    const code = await statsAction({ run: TEST_RUN, outputFormat: 'text' }, TEST_DEPS, out)

    expect(code).toBe(0)
    expect(out.getStdout()).toContain('No summaries found')
  })

  it('skips malformed JSON files without failing', async () => {
    mockStat.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue(['bad.json', 'good-medium.json'])
    mockReadFile.mockImplementation((filePath: string) => {
      if ((filePath as string).includes('bad')) {
        return Promise.resolve('not valid json {{{')
      }
      if ((filePath as string).endsWith('.json')) {
        return Promise.resolve(makeSummaryRecord(1, 'medium', TEST_HASH))
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    })

    const out = makeOutput()
    const code = await statsAction({ run: TEST_RUN, outputFormat: 'json' }, TEST_DEPS, out)

    expect(code).toBe(0)
    const parsed = JSON.parse(out.getStdout()) as CLIJsonOutput<StatsRow[]>
    // Only the good file is in the result
    expect(parsed.data).toHaveLength(1)
  })

  it('sorts rows by cachedAt ascending', async () => {
    mockStat.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue(['later-medium.json', 'earlier-medium.json'])
    mockReadFile.mockImplementation((filePath: string) => {
      if ((filePath as string).endsWith('.json')) {
        if ((filePath as string).includes('later')) {
          return Promise.resolve(
            makeSummaryRecord(2, 'medium', TEST_HASH_2, '2025-02-01T00:00:00.000Z')
          )
        }
        return Promise.resolve(
          makeSummaryRecord(1, 'medium', TEST_HASH, '2025-01-01T00:00:00.000Z')
        )
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    })

    const out = makeOutput()
    const code = await statsAction({ run: TEST_RUN, outputFormat: 'json' }, TEST_DEPS, out)

    expect(code).toBe(0)
    const parsed = JSON.parse(out.getStdout()) as CLIJsonOutput<StatsRow[]>
    expect(parsed.data).toHaveLength(2)
    expect(parsed.data[0]!.cachedAt).toBe('2025-01-01T00:00:00.000Z')
    expect(parsed.data[1]!.cachedAt).toBe('2025-02-01T00:00:00.000Z')
  })
})
