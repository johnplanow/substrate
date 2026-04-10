// @vitest-environment node
/**
 * Unit tests for the `substrate migrate` command.
 *
 * Story 26-13: SQLite → Dolt Migration Command
 *
 * NOTE (Epic 29): better-sqlite3 has been removed. readSqliteSnapshot()
 * now always returns an empty snapshot. The "successful migration" path
 * (which previously read rows from SQLite) no longer has data to migrate.
 * Tests below reflect this new behavior.
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
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    stderrSpy.mockRestore()
    process.exitCode = 0
  })

  // -------------------------------------------------------------------------
  // AC4: No SQLite data (Epic 29: always the case now)
  // -------------------------------------------------------------------------

  describe('no SQLite data', () => {
    it('exits 0 and prints "no data" message when there is no SQLite data', async () => {
      process.exitCode = 0
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate'])

      expect(process.exitCode).not.toBe(1)
      expect(process.exitCode).not.toBe(2)
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('No SQLite data found — nothing to migrate')
    })

    it('prints JSON no-data response with reason "no-sqlite-data" when --output-format json', async () => {
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
  // AC1 / AC2 / AC3 / AC6: No data to migrate (Epic 29: SQLite removed)
  // -------------------------------------------------------------------------

  describe('no data to migrate (Epic 29: SQLite removed)', () => {
    it('does NOT call client.query since there are no rows to migrate', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate'])

      expect(mockClientQuery).not.toHaveBeenCalled()
    })

    it('does NOT call client.execArgs since there are no rows to migrate', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate'])

      expect(mockClientExecArgs).not.toHaveBeenCalled()
    })

    it('prints "No SQLite data found — nothing to migrate" to stdout', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('No SQLite data found — nothing to migrate')
    })

    it('exits 0 with no data', async () => {
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
    it('does NOT call client.query when --dry-run is set (no data)', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate', '--dry-run'])

      expect(mockClientQuery).not.toHaveBeenCalled()
    })

    it('does NOT call client.execArgs when --dry-run is set (no data)', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate', '--dry-run'])

      expect(mockClientExecArgs).not.toHaveBeenCalled()
    })

    it('prints "No SQLite data found" message for --dry-run with no data', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate', '--dry-run'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('No SQLite data found — nothing to migrate')
    })
  })

  // -------------------------------------------------------------------------
  // JSON output mode
  // -------------------------------------------------------------------------

  describe('JSON output mode', () => {
    it('prints valid JSON with migrated=false and reason="no-sqlite-data" since there is no data', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'migrate', '--output-format', 'json'])

      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.migrated).toBe(false)
      expect(parsed.reason).toBe('no-sqlite-data')
    })

    it('prints valid JSON with migrated=false for --dry-run --output-format json with no data', async () => {
      const program = createProgram()
      await program.parseAsync([
        'node',
        'substrate',
        'migrate',
        '--dry-run',
        '--output-format',
        'json',
      ])

      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      // With no data, the early-exit path is taken regardless of --dry-run
      expect(parsed.migrated).toBe(false)
    })
  })
})
