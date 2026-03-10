// @vitest-environment node
/**
 * Unit tests for the `substrate routing` command.
 *
 * Story 28-9: CLI Commands, Full-Stack Wiring, and Staleness Detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TuneLogEntry } from '../../../modules/routing/index.js'

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
const {
  mockInitialize,
  mockClose,
  mockGetMetric,
} = vi.hoisted(() => ({
  mockInitialize: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockGetMetric: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../../modules/state/index.js', () => ({
  createStateStore: vi.fn(() => ({
    initialize: mockInitialize,
    close: mockClose,
    getMetric: mockGetMetric,
  })),
  FileStateStore: class MockFileStateStore {},
}))

import { Command } from 'commander'
import { registerRoutingCommand } from '../routing.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTuneEntry(overrides: Partial<TuneLogEntry> = {}): TuneLogEntry {
  return {
    id: 'entry-1',
    runId: 'run-abc',
    phase: 'explore',
    oldModel: 'claude-opus-4-5',
    newModel: 'claude-haiku-4-5',
    estimatedSavingsPct: 72.5,
    appliedAt: '2026-03-09T10:00:00.000Z',
    ...overrides,
  }
}

function createProgram(): Command {
  const program = new Command()
  program.exitOverride()
  registerRoutingCommand(program)
  return program
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routing command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  describe('default (no flags)', () => {
    it('shows zero entries when tune log is empty', async () => {
      mockGetMetric.mockResolvedValue(null)

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'routing'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toMatch(/0 entr/)
    })

    it('shows entry count when tune log has entries', async () => {
      mockGetMetric.mockResolvedValue([makeTuneEntry(), makeTuneEntry({ id: 'entry-2' })])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'routing'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toMatch(/2 entr/)
    })

    it('outputs JSON with tuneLogEntries count in JSON mode', async () => {
      mockGetMetric.mockResolvedValue([makeTuneEntry()])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'routing', '--output-format', 'json'])

      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.tuneLogEntries).toBe(1)
    })
  })

  describe('--history', () => {
    it('outputs "No routing auto-tune history found" when log is empty', async () => {
      mockGetMetric.mockResolvedValue(null)

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'routing', '--history'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toMatch(/No routing auto-tune history found/)
    })

    it('prints each tune entry in text mode', async () => {
      const entry = makeTuneEntry()
      mockGetMetric.mockResolvedValue([entry])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'routing', '--history'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain(entry.phase)
      expect(output).toContain(entry.oldModel)
      expect(output).toContain(entry.newModel)
      expect(output).toContain(entry.runId)
      expect(output).toContain('72.5%')
    })

    it('outputs JSON with { entries } wrapper in JSON mode', async () => {
      const entries = [makeTuneEntry(), makeTuneEntry({ id: 'entry-2', phase: 'generate' })]
      mockGetMetric.mockResolvedValue(entries)

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'routing', '--history', '--output-format', 'json'])

      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as { entries: TuneLogEntry[] }
      expect(Array.isArray(parsed.entries)).toBe(true)
      expect(parsed.entries).toHaveLength(2)
    })

    it('outputs empty entries array when log is empty', async () => {
      mockGetMetric.mockResolvedValue([])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'routing', '--history', '--output-format', 'json'])

      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as { entries: unknown[] }
      expect(parsed.entries).toEqual([])
    })

    it('sorts entries by appliedAt descending', async () => {
      const entries = [
        makeTuneEntry({ id: 'older', appliedAt: '2026-03-08T10:00:00.000Z' }),
        makeTuneEntry({ id: 'newer', appliedAt: '2026-03-10T10:00:00.000Z' }),
      ]
      mockGetMetric.mockResolvedValue(entries)

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'routing', '--history', '--output-format', 'json'])

      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as { entries: TuneLogEntry[] }
      expect(parsed.entries[0].id).toBe('newer')
      expect(parsed.entries[1].id).toBe('older')
    })

    it('handles non-array raw value gracefully (defaults to [])', async () => {
      mockGetMetric.mockResolvedValue('unexpected-string-value')

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'routing', '--history'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toMatch(/No routing auto-tune history found/)
    })
  })

  describe('getMetric call', () => {
    it('calls getMetric with global runId and routing_tune_log key', async () => {
      mockGetMetric.mockResolvedValue(null)

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'routing', '--history'])

      expect(mockGetMetric).toHaveBeenCalledWith('global', 'routing_tune_log')
    })
  })

  describe('lifecycle', () => {
    it('calls initialize() and close()', async () => {
      mockGetMetric.mockResolvedValue(null)

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'routing'])

      expect(mockInitialize).toHaveBeenCalledOnce()
      expect(mockClose).toHaveBeenCalledOnce()
    })
  })
})
