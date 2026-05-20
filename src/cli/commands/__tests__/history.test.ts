// @vitest-environment node
/**
 * Unit tests for the `substrate history` command.
 *
 * Post-Ship-1: history.ts uses `createDoltOperatorReader` and degrades
 * cleanly when no `.substrate/state/.dolt/` repo exists.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HistoryEntry } from '../../../modules/state/types.js'

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/test-project'),
}))

const { mockExistsSync } = vi.hoisted(() => ({ mockExistsSync: vi.fn().mockReturnValue(false) }))

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}))

const { mockInitialize, mockClose, mockGetHistory } = vi.hoisted(() => ({
  mockInitialize: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockGetHistory: vi.fn(),
}))

vi.mock('../../../modules/state/index.js', () => ({
  createDoltOperatorReader: vi.fn(() => ({
    initialize: mockInitialize,
    close: mockClose,
    getHistory: mockGetHistory,
    setMetric: vi.fn(),
    getMetric: vi.fn(),
  })),
}))

const { mockEmitDegradedModeHint } = vi.hoisted(() => ({
  mockEmitDegradedModeHint: vi.fn<(opts: unknown) => Promise<{ hint: string; doltInstalled: boolean }>>(),
}))

vi.mock('../../../utils/degraded-mode-hint.js', () => ({
  emitDegradedModeHint: mockEmitDegradedModeHint,
}))

import { Command } from 'commander'
import { registerHistoryCommand } from '../history.js'

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

const MOCK_HINT = 'Note: Dolt is not installed. Install it from https://docs.dolthub.com/introduction/installation, then run `substrate init --dolt` to enable history.'

describe('history command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockEmitDegradedModeHint.mockResolvedValue({ hint: MOCK_HINT, doltInstalled: false })
    mockExistsSync.mockReturnValue(false)
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  describe('file backend degraded mode (no .dolt/)', () => {
    it('calls emitDegradedModeHint when no Dolt repo exists (text mode)', async () => {
      mockExistsSync.mockReturnValue(false)
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history'])
      expect(mockEmitDegradedModeHint).toHaveBeenCalledOnce()
      expect(mockEmitDegradedModeHint).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'history', outputFormat: 'text' }),
      )
    })

    it('emits JSON envelope with backend=file, hint field, and entries=[] in JSON mode', async () => {
      mockExistsSync.mockReturnValue(false)
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history', '--output-format', 'json'])
      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.backend).toBe('file')
      expect(typeof parsed.hint).toBe('string')
      expect(parsed.entries).toEqual([])
    })

    it('does not call emitDegradedModeHint when Dolt repo exists', async () => {
      mockExistsSync.mockReturnValue(true)
      mockGetHistory.mockResolvedValue([])
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history'])
      expect(mockEmitDegradedModeHint).not.toHaveBeenCalled()
    })
  })

  describe('empty history (Dolt repo present, no commits)', () => {
    it('prints "No history available" when history is empty', async () => {
      mockExistsSync.mockReturnValue(true)
      mockGetHistory.mockResolvedValue([])
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history'])
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('No history available')
    })
  })

  describe('text output', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true)
    })

    it('prints one line per entry in hash  timestamp  storyKey  message format', async () => {
      mockGetHistory.mockResolvedValue([
        makeEntry({ hash: 'a1b2c3d', timestamp: '2026-03-08T14:23:01+00:00', storyKey: '26-7', message: 'Merge story/26-7: done' }),
        makeEntry({ hash: 'b2c3d4e', timestamp: '2026-03-07T10:00:00+00:00', storyKey: null, message: 'substrate: auto-commit' }),
      ])
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history'])
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('a1b2c3d')
      expect(output).toContain('Merge story/26-7: done')
      expect(output).toContain('b2c3d4e')
      expect(output).toContain('-')
      expect(output).toContain('substrate: auto-commit')
    })

    it('pads storyKey column to 8 characters', async () => {
      mockGetHistory.mockResolvedValue([makeEntry({ storyKey: '26-7' })])
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history'])
      const output = String(consoleSpy.mock.calls[0][0])
      expect(output).toContain('26-7    ')
    })
  })

  describe('JSON output', () => {
    it('outputs valid JSON array when --output-format json is specified', async () => {
      mockExistsSync.mockReturnValue(true)
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
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true)
      mockGetHistory.mockResolvedValue([])
    })

    it('passes the limit to getHistory', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history', '--limit', '5'])
      expect(mockGetHistory).toHaveBeenCalledWith(5)
    })

    it('defaults to limit=20', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history'])
      expect(mockGetHistory).toHaveBeenCalledWith(20)
    })
  })

  describe('lifecycle', () => {
    it('calls initialize() and close() when Dolt repo exists', async () => {
      mockExistsSync.mockReturnValue(true)
      mockGetHistory.mockResolvedValue([])
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'history'])
      expect(mockInitialize).toHaveBeenCalledOnce()
      expect(mockClose).toHaveBeenCalledOnce()
    })
  })
})
