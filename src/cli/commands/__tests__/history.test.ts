// @vitest-environment node
/**
 * Unit tests for the `substrate history` command.
 *
 * Story 26-9: Dolt Diff + History Commands
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HistoryEntry } from '../../../modules/state/types.js'

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
const { mockInitialize, mockClose, mockGetHistory, MockFileStateStore } = vi.hoisted(() => {
  class MockFileStateStore {}
  return {
    mockInitialize: vi.fn().mockResolvedValue(undefined),
    mockClose: vi.fn().mockResolvedValue(undefined),
    mockGetHistory: vi.fn(),
    MockFileStateStore,
  }
})

vi.mock('../../../modules/state/index.js', () => ({
  createStateStore: vi.fn(() => ({
    initialize: mockInitialize,
    close: mockClose,
    getHistory: mockGetHistory,
  })),
  FileStateStore: MockFileStateStore,
}))

import { Command } from 'commander'
import { registerHistoryCommand } from '../history.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    hash: 'a1b2c3d',
    timestamp: '2026-03-08T14:23:01+00:00',
    storyKey: '26-7',
    message: 'Merge story/26-7: branch-per-story complete',
    ...overrides,
  }
}

function createProgram(): Command {
  const program = new Command()
  program.exitOverride()
  registerHistoryCommand(program)
  return program
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('history command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  describe('empty history', () => {
    it('prints graceful message for file backend with no history', async () => {
      const { createStateStore, FileStateStore: MockFS } = await import('../../../modules/state/index.js')
      const fileStoreInstance = Object.create((MockFS as unknown as { prototype: object }).prototype) as object
      Object.assign(fileStoreInstance, {
        initialize: mockInitialize,
        close: mockClose,
        getHistory: vi.fn().mockResolvedValue([]),
      })
      vi.mocked(createStateStore).mockReturnValueOnce(fileStoreInstance as ReturnType<typeof createStateStore>)

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('substrate init --dolt')
    })

    it('prints "No history available" for non-file backend with no history', async () => {
      mockGetHistory.mockResolvedValue([])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('No history available')
    })
  })

  describe('text output', () => {
    it('prints one line per entry in hash  timestamp  storyKey  message format', async () => {
      mockGetHistory.mockResolvedValue([
        makeEntry({ hash: 'a1b2c3d', timestamp: '2026-03-08T14:23:01+00:00', storyKey: '26-7', message: 'Merge story/26-7: done' }),
        makeEntry({ hash: 'b2c3d4e', timestamp: '2026-03-07T10:00:00+00:00', storyKey: null, message: 'substrate: auto-commit' }),
      ])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('a1b2c3d')
      expect(output).toContain('2026-03-08T14:23:01+00:00')
      expect(output).toContain('26-7')
      expect(output).toContain('Merge story/26-7: done')
      expect(output).toContain('b2c3d4e')
      // null storyKey should render as '-'
      expect(output).toContain('-')
      expect(output).toContain('substrate: auto-commit')
    })

    it('pads storyKey column to 8 characters', async () => {
      mockGetHistory.mockResolvedValue([
        makeEntry({ storyKey: '26-7' }),
      ])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history'])

      // storyKey '26-7' padded to 8 chars = '26-7    '
      const output = String(consoleSpy.mock.calls[0][0])
      expect(output).toContain('26-7    ')
    })
  })

  describe('JSON output', () => {
    it('outputs valid JSON array when --output-format json is specified', async () => {
      const entries: HistoryEntry[] = [
        makeEntry({ hash: 'a1b2c3d', storyKey: '26-7' }),
        makeEntry({ hash: 'b2c3d4e', storyKey: null, message: 'auto-commit' }),
      ]
      mockGetHistory.mockResolvedValue(entries)

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history', '--output-format', 'json'])

      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as unknown[]
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed).toHaveLength(2)
      const first = parsed[0] as Record<string, unknown>
      expect(first.hash).toBe('a1b2c3d')
      expect(first.storyKey).toBe('26-7')
    })
  })

  describe('--limit option', () => {
    it('passes the limit to getHistory', async () => {
      mockGetHistory.mockResolvedValue([])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history', '--limit', '5'])

      expect(mockGetHistory).toHaveBeenCalledWith(5)
    })

    it('defaults to limit=20', async () => {
      mockGetHistory.mockResolvedValue([])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history'])

      expect(mockGetHistory).toHaveBeenCalledWith(20)
    })
  })

  describe('lifecycle', () => {
    it('calls initialize() and close()', async () => {
      mockGetHistory.mockResolvedValue([])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history'])

      expect(mockInitialize).toHaveBeenCalledOnce()
      expect(mockClose).toHaveBeenCalledOnce()
    })
  })
})
