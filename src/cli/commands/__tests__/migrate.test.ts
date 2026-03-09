// @vitest-environment node
/**
 * Unit tests for the `substrate migrate` command.
 *
 * Story 26-13: SQLite → Dolt Migration Command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks (must be declared before imports of the module under test)
// ---------------------------------------------------------------------------

vi.mock('../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/test-project'),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}))

// Mock better-sqlite3
const { mockSqliteConstructor, mockPrepare, mockAll, mockClose: mockDbClose } = vi.hoisted(() => {
  const mockAll = vi.fn()
  const mockPrepare = vi.fn(() => ({ all: mockAll }))
  const mockDbClose = vi.fn()
  const mockSqliteConstructor = vi.fn(() => ({
    prepare: mockPrepare,
    close: mockDbClose,
  }))
  return { mockSqliteConstructor, mockPrepare, mockAll, mockClose: mockDbClose }
})

vi.mock('better-sqlite3', () => ({
  default: mockSqliteConstructor,
}))

// Mock state module: checkDoltInstalled, createDoltClient, DoltNotInstalled
const {
  mockCheckDoltInstalled,
  mockClientConnect,
  mockClientQuery,
  mockClientExec,
  mockClientExecArgs,
  mockClientClose,
  MockDoltNotInstalled,
} = vi.hoisted(() => {
  class MockDoltNotInstalled extends Error {
    constructor() {
      super('Dolt CLI not found in PATH.')
      this.name = 'DoltNotInstalled'
    }
  }
  const mockClientConnect = vi.fn().mockResolvedValue(undefined)
  const mockClientQuery = vi.fn().mockResolvedValue([])
  const mockClientExec = vi.fn().mockResolvedValue('')
  const mockClientExecArgs = vi.fn().mockResolvedValue('')
  const mockClientClose = vi.fn().mockResolvedValue(undefined)
  const mockCheckDoltInstalled = vi.fn().mockResolvedValue(undefined)
  return {
    mockCheckDoltInstalled,
    mockClientConnect,
    mockClientQuery,
    mockClientExec,
    mockClientExecArgs,
    mockClientClose,
    MockDoltNotInstalled,
  }
})

vi.mock('../../../modules/state/index.js', () => ({
  checkDoltInstalled: mockCheckDoltInstalled,
  createDoltClient: vi.fn(() => ({
    connect: mockClientConnect,
    query: mockClientQuery,
    exec: mockClientExec,
    execArgs: mockClientExecArgs,
    close: mockClientClose,
  })),
  DoltNotInstalled: MockDoltNotInstalled,
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { Command } from 'commander'
import { registerMigrateCommand } from '../migrate.js'
import { existsSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createProgram(): Command {
  const program = new Command()
  program.exitOverride()
  registerMigrateCommand(program)
  return program
}

const SAMPLE_ROWS = [
  {
    story_key: '26-1',
    result: 'success',
    completed_at: '2026-03-01T10:00:00Z',
    created_at: '2026-03-01T09:00:00Z',
    wall_clock_seconds: 120,
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: 0.01,
    review_cycles: 1,
  },
  {
    story_key: '26-2',
    result: 'success',
    completed_at: '2026-03-02T10:00:00Z',
    created_at: '2026-03-02T09:00:00Z',
    wall_clock_seconds: 200,
    input_tokens: 2000,
    output_tokens: 800,
    cost_usd: 0.02,
    review_cycles: 0,
  },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrate command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    // Default: dolt .dolt dir exists
    vi.mocked(existsSync).mockReturnValue(true)

    // Default: SQLite returns sample rows
    mockAll.mockReturnValue(SAMPLE_ROWS)
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    stderrSpy.mockRestore()
    process.exitCode = 0
  })

  // -------------------------------------------------------------------------
  // AC4: No SQLite data
  // -------------------------------------------------------------------------

  describe('no SQLite data', () => {
    it('exits 0 and prints "no data" message when SQLite file is missing', async () => {
      // Simulate Database constructor throwing (file not found)
      mockSqliteConstructor.mockImplementationOnce(() => {
        throw new Error('ENOENT: no such file or directory')
      })

      process.exitCode = 0
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate'])

      expect(process.exitCode).not.toBe(1)
      expect(process.exitCode).not.toBe(2)
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('No SQLite data found — nothing to migrate')
    })

    it('prints JSON no-data response with reason "no-sqlite-data" when --output-format json and no SQLite', async () => {
      mockSqliteConstructor.mockImplementationOnce(() => {
        throw new Error('ENOENT')
      })

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate', '--output-format', 'json'])

      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.migrated).toBe(false)
      expect(parsed.reason).toBe('no-sqlite-data')
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Dolt not installed
  // -------------------------------------------------------------------------

  describe('Dolt not installed', () => {
    it('exits 1 and prints actionable message to stderr when Dolt binary missing', async () => {
      mockCheckDoltInstalled.mockRejectedValueOnce(new MockDoltNotInstalled())

      process.exitCode = 0
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate'])

      expect(process.exitCode).toBe(1)
      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(stderrOutput).toContain("Run 'substrate init --dolt' first")
    })

    it('emits JSON error object to stdout when Dolt binary missing and --output-format json', async () => {
      mockCheckDoltInstalled.mockRejectedValueOnce(new MockDoltNotInstalled())

      process.exitCode = 0
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate', '--output-format', 'json'])

      expect(process.exitCode).toBe(1)
      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.error).toBe('ERR_DOLT_NOT_INITIALIZED')
      expect(typeof parsed.message).toBe('string')
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Dolt .dolt dir absent
  // -------------------------------------------------------------------------

  describe('Dolt not initialized', () => {
    it('exits 1 and prints actionable message when .dolt directory absent', async () => {
      vi.mocked(existsSync).mockReturnValue(false)

      process.exitCode = 0
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate'])

      expect(process.exitCode).toBe(1)
      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(stderrOutput).toContain("Run 'substrate init --dolt' first")
    })

    it('emits JSON error object to stdout when .dolt directory absent and --output-format json', async () => {
      vi.mocked(existsSync).mockReturnValue(false)

      process.exitCode = 0
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate', '--output-format', 'json'])

      expect(process.exitCode).toBe(1)
      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.error).toBe('ERR_DOLT_NOT_INITIALIZED')
      expect(typeof parsed.message).toBe('string')
    })
  })

  // -------------------------------------------------------------------------
  // AC1 / AC2 / AC3 / AC6: Successful migration
  // -------------------------------------------------------------------------

  describe('successful migration', () => {
    it('calls client.query with INSERT SQL containing ON DUPLICATE KEY UPDATE', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate'])

      expect(mockClientQuery).toHaveBeenCalled()
      const sql = String(mockClientQuery.mock.calls[0][0])
      expect(sql).toContain('INSERT INTO metrics')
      expect(sql).toContain('ON DUPLICATE KEY UPDATE')
    })

    it('calls client.execArgs with add and commit after writing', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate'])

      const execArgsCalls = mockClientExecArgs.mock.calls.map((c) => c[0] as string[])
      expect(execArgsCalls).toContainEqual(['add', '.'])
      expect(execArgsCalls.some((args) => args.includes('commit') && args.includes('Migrate historical data from SQLite'))).toBe(true)
    })

    it('prints "Migrated N story metrics." to stdout', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain(`Migrated ${SAMPLE_ROWS.length} story metrics.`)
    })

    it('exits 0 on success', async () => {
      process.exitCode = 0
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate'])

      expect(process.exitCode).not.toBe(1)
      expect(process.exitCode).not.toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  // AC7: dry-run
  // -------------------------------------------------------------------------

  describe('--dry-run flag', () => {
    it('does NOT call client.query when --dry-run is set', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate', '--dry-run'])

      expect(mockClientQuery).not.toHaveBeenCalled()
    })

    it('does NOT call client.execArgs when --dry-run is set', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate', '--dry-run'])

      expect(mockClientExecArgs).not.toHaveBeenCalled()
    })

    it('prints "Would migrate N story metrics (dry run — no changes written)"', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate', '--dry-run'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain(`Would migrate ${SAMPLE_ROWS.length} story metrics (dry run — no changes written)`)
    })
  })

  // -------------------------------------------------------------------------
  // JSON output mode
  // -------------------------------------------------------------------------

  describe('JSON output mode', () => {
    it('prints valid JSON with migrated=true and counts.metrics on success', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate', '--output-format', 'json'])

      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.migrated).toBe(true)
      expect(typeof (parsed.counts as Record<string, number>).metrics).toBe('number')
    })

    it('prints valid JSON with dryRun=true and counts.metrics when --dry-run --output-format json', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate', '--dry-run', '--output-format', 'json'])

      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.migrated).toBe(false)
      expect(parsed.dryRun).toBe(true)
      expect(typeof (parsed.counts as Record<string, number>).metrics).toBe('number')
    })
  })

  // -------------------------------------------------------------------------
  // Skipping invalid rows
  // -------------------------------------------------------------------------

  describe('row filtering', () => {
    it('skips rows with NULL story_key and does not include them in migrated count', async () => {
      const rowsWithNull = [
        ...SAMPLE_ROWS,
        {
          story_key: null,
          result: 'success',
          completed_at: '2026-03-03T10:00:00Z',
          created_at: '2026-03-03T09:00:00Z',
          wall_clock_seconds: 50,
          input_tokens: 100,
          output_tokens: 50,
          cost_usd: 0.001,
          review_cycles: 0,
        },
      ]
      mockAll.mockReturnValueOnce(rowsWithNull)

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      // Only the valid rows (SAMPLE_ROWS.length = 2) should be migrated
      expect(output).toContain(`Migrated ${SAMPLE_ROWS.length} story metrics.`)

      // AC1: skipped rows must produce a user-visible warning on stderr
      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(stderrOutput).toContain('Skipped')
      expect(stderrOutput).toContain('1') // 1 row was skipped
    })
  })
})
