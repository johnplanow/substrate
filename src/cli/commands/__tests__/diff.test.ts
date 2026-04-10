// @vitest-environment node
/**
 * Unit tests for the `substrate diff` command.
 *
 * Story 26-9: Dolt Diff + History Commands
 * Story 26-12: CLI Degraded-Mode Hints (updated for stderr-based hints)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StoryDiff, StoryRecord } from '../../../modules/state/types.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/test-project'),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}))

// Use vi.hoisted so these are available before vi.mock factories run
const { mockInitialize, mockClose, mockDiffStory, mockQueryStories, MockFileStateStore } =
  vi.hoisted(() => {
    class MockFileStateStore {}
    return {
      mockInitialize: vi.fn().mockResolvedValue(undefined),
      mockClose: vi.fn().mockResolvedValue(undefined),
      mockDiffStory: vi.fn(),
      mockQueryStories: vi.fn(),
      MockFileStateStore,
    }
  })

vi.mock('../../../modules/state/index.js', () => ({
  createStateStore: vi.fn(() => ({
    initialize: mockInitialize,
    close: mockClose,
    diffStory: mockDiffStory,
    queryStories: mockQueryStories,
  })),
  FileStateStore: MockFileStateStore,
}))

// Mock the degraded-mode-hint utility so we can assert its usage without
// triggering real Dolt detection in unit tests.
const { mockEmitDegradedModeHint } = vi.hoisted(() => ({
  mockEmitDegradedModeHint:
    vi.fn<(opts: unknown) => Promise<{ hint: string; doltInstalled: boolean }>>(),
}))

vi.mock('../../../utils/degraded-mode-hint.js', () => ({
  emitDegradedModeHint: mockEmitDegradedModeHint,
}))

import { Command } from 'commander'
import { registerDiffCommand } from '../diff.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStoryDiff(storyKey: string, tables: StoryDiff['tables'] = []): StoryDiff {
  return { storyKey, tables }
}

/**
 * Build a TableDiff with DiffRow arrays of the specified lengths.
 * Provides a concise way to express numeric counts in tests.
 */
function makeTableDiff(
  table: string,
  addedCount: number,
  deletedCount: number,
  modifiedCount: number
): StoryDiff['tables'][number] {
  return {
    table,
    added: Array.from({ length: addedCount }, (_, i) => ({ rowKey: `added-${i}` })),
    deleted: Array.from({ length: deletedCount }, (_, i) => ({ rowKey: `deleted-${i}` })),
    modified: Array.from({ length: modifiedCount }, (_, i) => ({ rowKey: `modified-${i}` })),
  }
}

function makeStory(overrides: Partial<StoryRecord> = {}): StoryRecord {
  return {
    storyKey: '26-1',
    phase: 'COMPLETE',
    reviewCycles: 0,
    sprint: 'sprint-3',
    ...overrides,
  }
}

function createProgram(): Command {
  const program = new Command()
  program.exitOverride()
  registerDiffCommand(program)
  return program
}

// Default hint returned by the mock in file-backend tests
const MOCK_HINT =
  'Note: Dolt is not installed. Install it from https://docs.dolthub.com/introduction/installation, then run `substrate init --dolt` to enable diff and history features.'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('diff command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    // Default: emitDegradedModeHint resolves with mock hint
    mockEmitDegradedModeHint.mockResolvedValue({ hint: MOCK_HINT, doltInstalled: false })
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  describe('argument validation', () => {
    it('prints error and sets exitCode=1 when neither storyKey nor --sprint provided', async () => {
      const program = createProgram()
      // Reset exitCode
      process.exitCode = 0
      await program.parseAsync(['node', 'substrate', 'diff'])
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('story key'))
      expect(process.exitCode).toBe(1)
      process.exitCode = 0
    })
  })

  describe('single story diff', () => {
    it('prints text output with table stats', async () => {
      mockDiffStory.mockResolvedValue(
        makeStoryDiff('26-7', [
          makeTableDiff('stories', 4, 2, 2),
          makeTableDiff('metrics', 1, 0, 0),
        ])
      )

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'diff', '26-7'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('Diff for story 26-7')
      expect(output).toContain('stories: +4 -2 ~2')
      expect(output).toContain('metrics: +1 -0 ~0')
    })

    it('prints JSON when --output-format json is specified', async () => {
      const diff = makeStoryDiff('26-7', [makeTableDiff('stories', 2, 1, 1)])
      mockDiffStory.mockResolvedValue(diff)

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'diff', '26-7', '--output-format', 'json'])

      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as unknown
      expect(parsed).toMatchObject({ storyKey: '26-7', tables: expect.any(Array) })
    })

    it('prints (no changes) when tables array is empty but not file backend', async () => {
      mockDiffStory.mockResolvedValue(makeStoryDiff('26-7', []))

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'diff', '26-7'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('(no changes)')
    })

    it('calls initialize() and close()', async () => {
      mockDiffStory.mockResolvedValue(makeStoryDiff('26-7', []))

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'diff', '26-7'])

      expect(mockInitialize).toHaveBeenCalledOnce()
      expect(mockClose).toHaveBeenCalledOnce()
    })
  })

  describe('file backend degraded mode', () => {
    async function makeFileStoreInstance() {
      const { createStateStore, FileStateStore: MockFS } =
        await import('../../../modules/state/index.js')
      const fileStoreInstance = Object.create(
        (MockFS as unknown as { prototype: object }).prototype
      ) as object
      Object.assign(fileStoreInstance, {
        initialize: mockInitialize,
        close: mockClose,
        diffStory: vi.fn().mockResolvedValue(makeStoryDiff('26-7', [])),
        queryStories: mockQueryStories,
      })
      vi.mocked(createStateStore).mockReturnValueOnce(
        fileStoreInstance as ReturnType<typeof createStateStore>
      )
    }

    it('calls emitDegradedModeHint when file backend is active (text mode)', async () => {
      await makeFileStoreInstance()

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'diff', '26-7'])

      expect(mockEmitDegradedModeHint).toHaveBeenCalledOnce()
      expect(mockEmitDegradedModeHint).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'diff', outputFormat: 'text' })
      )
    })

    it('does not call console.log with hint text in text mode (hint goes to stderr via utility)', async () => {
      await makeFileStoreInstance()

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'diff', '26-7'])

      // console.log must not be called at all (no hint text, no data output)
      expect(consoleSpy).not.toHaveBeenCalled()
    })

    it('exit code remains 0 in degraded mode', async () => {
      await makeFileStoreInstance()
      process.exitCode = 0

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'diff', '26-7'])

      expect(process.exitCode).not.toBe(1)
      process.exitCode = 0
    })

    it('emits JSON envelope with backend=file and hint field in JSON mode', async () => {
      await makeFileStoreInstance()

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'diff', '26-7', '--output-format', 'json'])

      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.backend).toBe('file')
      expect(typeof parsed.hint).toBe('string')
      expect(parsed.diff).toBeNull()
    })

    it('does not call emitDegradedModeHint for Dolt backend', async () => {
      // Default mock returns a non-FileStateStore instance (plain object without FileStateStore prototype)
      mockDiffStory.mockResolvedValue(makeStoryDiff('26-7', []))

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'diff', '26-7'])

      expect(mockEmitDegradedModeHint).not.toHaveBeenCalled()
    })
  })

  describe('sprint diff', () => {
    it('aggregates table stats across all stories in the sprint', async () => {
      mockQueryStories.mockResolvedValue([
        makeStory({ storyKey: '26-7', sprint: 'sprint-3' }),
        makeStory({ storyKey: '26-8', sprint: 'sprint-3' }),
      ])
      mockDiffStory
        .mockResolvedValueOnce(makeStoryDiff('26-7', [makeTableDiff('stories', 2, 1, 1)]))
        .mockResolvedValueOnce(
          makeStoryDiff('26-8', [
            makeTableDiff('stories', 3, 0, 0),
            makeTableDiff('metrics', 1, 0, 0),
          ])
        )

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'diff', '--sprint', 'sprint-3'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('Diff for sprint sprint-3')
      expect(output).toContain('stories: +5 -1 ~1')
      expect(output).toContain('metrics: +1 -0 ~0')
    })

    it('outputs JSON for sprint diff', async () => {
      mockQueryStories.mockResolvedValue([makeStory({ storyKey: '26-7' })])
      mockDiffStory.mockResolvedValue(makeStoryDiff('26-7', [makeTableDiff('contracts', 1, 0, 0)]))

      const program = createProgram()
      await program.parseAsync([
        'node',
        'substrate',
        'diff',
        '--sprint',
        'sprint-3',
        '--output-format',
        'json',
      ])

      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.sprint).toBe('sprint-3')
      expect(Array.isArray(parsed.tables)).toBe(true)
    })

    it('calls emitDegradedModeHint for sprint diff on file backend', async () => {
      const { createStateStore, FileStateStore: MockFS } =
        await import('../../../modules/state/index.js')
      const fileStoreInstance = Object.create(
        (MockFS as unknown as { prototype: object }).prototype
      ) as object
      Object.assign(fileStoreInstance, {
        initialize: mockInitialize,
        close: mockClose,
        diffStory: vi.fn().mockResolvedValue(makeStoryDiff('26-7', [])),
        queryStories: vi.fn().mockResolvedValue([]),
      })
      vi.mocked(createStateStore).mockReturnValueOnce(
        fileStoreInstance as ReturnType<typeof createStateStore>
      )

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'diff', '--sprint', 'sprint-3'])

      expect(mockEmitDegradedModeHint).toHaveBeenCalledOnce()
      expect(mockEmitDegradedModeHint).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'diff', outputFormat: 'text' })
      )
    })
  })
})
