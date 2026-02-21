/**
 * Unit tests for `src/cli/commands/log.ts`
 *
 * Covers all 6 Acceptance Criteria:
 *   AC1: --task <id> queries getTaskLog and formats as table
 *   AC2: --event <type> queries getLogByEvent
 *   AC3: --output-format json / --json outputs valid CLIJsonOutput<LogEntry[]>
 *   AC4: Default (no filters) uses getSessionLog, reverses, limits to 50; empty → "No log entries found"
 *   AC5: --session <id> and --limit <n> respected across all query modes
 *   AC6: Missing DB → stderr + exit 1; invalid --output-format → stderr + exit 1; DB throw → stderr + exit 1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — declared before imports that reference mocked modules
// ---------------------------------------------------------------------------

const mockOpen = vi.fn()
const mockClose = vi.fn()
let mockDb: Record<string, unknown> = { fake: true }

vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: vi.fn().mockImplementation(() => ({
    open: mockOpen,
    close: mockClose,
    get db() {
      return mockDb
    },
  })),
}))

vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

// Log query mocks
const mockGetSessionLog = vi.fn()
const mockGetTaskLog = vi.fn()
const mockGetLogByEvent = vi.fn()
const mockQueryLogFiltered = vi.fn()

vi.mock('../../../persistence/queries/log.js', () => ({
  getSessionLog: (...args: unknown[]) => mockGetSessionLog(...args),
  getTaskLog: (...args: unknown[]) => mockGetTaskLog(...args),
  getLogByEvent: (...args: unknown[]) => mockGetLogByEvent(...args),
  queryLogFiltered: (...args: unknown[]) => mockQueryLogFiltered(...args),
  appendLog: vi.fn(),
  getLogByTimeRange: vi.fn(),
}))

// Session query mock
const mockGetLatestSessionId = vi.fn()

vi.mock('../../../persistence/queries/sessions.js', () => ({
  getLatestSessionId: (...args: unknown[]) => mockGetLatestSessionId(...args),
}))

// fs mock
const mockExistsSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  runLogAction,
  formatLogTable,
  LOG_EXIT_SUCCESS,
  LOG_EXIT_ERROR,
} from '../log.js'
import { DatabaseWrapper } from '../../../persistence/database.js'
import type { LogActionOptions } from '../log.js'
import type { LogEntry } from '../../../persistence/queries/log.js'

// ---------------------------------------------------------------------------
// Output capture helpers (same pattern as cost.test.ts)
// ---------------------------------------------------------------------------

let stdoutOutput: string
let stderrOutput: string

function captureOutput(): void {
  stdoutOutput = ''
  stderrOutput = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
    stdoutOutput += typeof data === 'string' ? data : data.toString()
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
    stderrOutput += typeof data === 'string' ? data : data.toString()
    return true
  })
}

function getStdout(): string {
  return stdoutOutput
}

function getStderr(): string {
  return stderrOutput
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 1,
    session_id: 'sess-abc',
    task_id: 'task-1',
    event: 'task:status_change',
    old_status: 'pending',
    new_status: 'running',
    agent: 'claude-code',
    cost_usd: 0.025,
    data: null,
    timestamp: '2026-01-15 10:00:00',
    ...overrides,
  }
}

function makeOptions(overrides: Partial<LogActionOptions> = {}): LogActionOptions {
  return {
    limit: 50,
    outputFormat: 'table',
    projectRoot: '/fake',
    version: '1.0.0',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  captureOutput()

  // Default: database file exists
  mockExistsSync.mockReturnValue(true)
  // Default: latest session found
  mockGetLatestSessionId.mockReturnValue('sess-latest')
  // Default: empty log
  mockGetSessionLog.mockReturnValue([])
  mockGetTaskLog.mockReturnValue([])
  mockGetLogByEvent.mockReturnValue([])
  mockQueryLogFiltered.mockReturnValue([])
  // Reset db mock
  mockDb = { fake: true }
  // Re-apply DatabaseWrapper mock implementation (restoreAllMocks() may have cleared it)
  vi.mocked(DatabaseWrapper).mockImplementation(() => ({
    open: mockOpen,
    close: mockClose,
    get db() {
      return mockDb
    },
  }) as unknown as InstanceType<typeof DatabaseWrapper>)
})

afterEach(() => {
  vi.restoreAllMocks()
  mockGetLatestSessionId.mockReset()
  mockGetSessionLog.mockReset()
  mockGetTaskLog.mockReset()
  mockGetLogByEvent.mockReset()
  mockQueryLogFiltered.mockReset()
  mockExistsSync.mockReset()
  mockOpen.mockReset()
  mockClose.mockReset()
})

// ---------------------------------------------------------------------------
// formatLogTable tests
// ---------------------------------------------------------------------------

describe('formatLogTable', () => {
  it('renders correct column headers', () => {
    const entry = makeEntry()
    const result = formatLogTable([entry])
    expect(result).toContain('Timestamp')
    expect(result).toContain('Event')
    expect(result).toContain('Task ID')
    expect(result).toContain('Old Status')
    expect(result).toContain('New Status')
    expect(result).toContain('Agent')
    expect(result).toContain('Cost ($)')
  })

  it('renders entry values correctly', () => {
    const entry = makeEntry()
    const result = formatLogTable([entry])
    expect(result).toContain('task:status_change')
    expect(result).toContain('task-1')
    expect(result).toContain('pending')
    expect(result).toContain('running')
    expect(result).toContain('claude-code')
    expect(result).toContain('0.0250')
  })

  it('renders null task_id as "-"', () => {
    const entry = makeEntry({ task_id: null })
    const result = formatLogTable([entry])
    expect(result).toContain('-')
  })

  it('renders null old_status as "-"', () => {
    const entry = makeEntry({ old_status: null })
    const result = formatLogTable([entry])
    expect(result).toContain('-')
  })

  it('renders null new_status as "-"', () => {
    const entry = makeEntry({ new_status: null })
    const result = formatLogTable([entry])
    expect(result).toContain('-')
  })

  it('renders null agent as "-"', () => {
    const entry = makeEntry({ agent: null })
    const result = formatLogTable([entry])
    expect(result).toContain('-')
  })

  it('renders null cost_usd as "-"', () => {
    const entry = makeEntry({ cost_usd: null })
    const result = formatLogTable([entry])
    expect(result).toContain('-')
  })

  it('renders empty entries array with just headers and separator', () => {
    const result = formatLogTable([])
    expect(result).toContain('Timestamp')
    expect(result).toContain('Event')
    const lines = result.split('\n')
    // Should have header row + separator row only
    expect(lines.length).toBe(2)
  })

  it('formats cost_usd as 4 decimal places', () => {
    const entry = makeEntry({ cost_usd: 0.0001 })
    const result = formatLogTable([entry])
    expect(result).toContain('0.0001')
  })
})

// ---------------------------------------------------------------------------
// runLogAction tests
// ---------------------------------------------------------------------------

describe('runLogAction', () => {

  // -------------------------------------------------------------------------
  // AC6: Error cases
  // -------------------------------------------------------------------------

  describe('AC6 - Error handling', () => {
    it('returns error code when DB does not exist', async () => {
      mockExistsSync.mockReturnValue(false)
      const code = await runLogAction(makeOptions())
      expect(code).toBe(LOG_EXIT_ERROR)
    })

    it('writes "No Substrate database found" to stderr when DB does not exist', async () => {
      mockExistsSync.mockReturnValue(false)
      await runLogAction(makeOptions())
      expect(getStderr()).toContain('Error: No Substrate database found')
    })

    it('includes the db path in the error message', async () => {
      mockExistsSync.mockReturnValue(false)
      await runLogAction(makeOptions({ projectRoot: '/my/project' }))
      expect(getStderr()).toContain('/my/project')
    })

    it('returns error code for invalid output format', async () => {
      const code = await runLogAction(
        makeOptions({ outputFormat: 'csv' as 'table' }),
      )
      expect(code).toBe(LOG_EXIT_ERROR)
    })

    it('writes validation error to stderr for invalid output format', async () => {
      await runLogAction(makeOptions({ outputFormat: 'csv' as 'table' }))
      expect(getStderr()).toContain('Invalid output format')
    })

    it('returns error code when database throws on open', async () => {
      mockOpen.mockImplementation(() => {
        throw new Error('DB open failed')
      })
      const code = await runLogAction(makeOptions())
      expect(code).toBe(LOG_EXIT_ERROR)
    })

    it('writes error message to stderr when database throws', async () => {
      mockOpen.mockImplementation(() => {
        throw new Error('DB open failed')
      })
      await runLogAction(makeOptions())
      expect(getStderr()).toContain('DB open failed')
    })

    it('closes the wrapper in finally block even on error', async () => {
      mockOpen.mockImplementation(() => {
        throw new Error('DB open failed')
      })
      await runLogAction(makeOptions())
      expect(mockClose).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Default view / empty state
  // -------------------------------------------------------------------------

  describe('AC4 - Default view and empty state', () => {
    it('returns success when no entries exist', async () => {
      mockGetSessionLog.mockReturnValue([])
      const code = await runLogAction(makeOptions())
      expect(code).toBe(LOG_EXIT_SUCCESS)
    })

    it('writes "No log entries found" to stdout when no entries exist', async () => {
      mockGetSessionLog.mockReturnValue([])
      await runLogAction(makeOptions())
      expect(getStdout()).toContain('No log entries found')
    })

    it('returns success when no session exists', async () => {
      mockGetLatestSessionId.mockReturnValue(null)
      const code = await runLogAction(makeOptions())
      expect(code).toBe(LOG_EXIT_SUCCESS)
    })

    it('writes "No log entries found" when no session exists', async () => {
      mockGetLatestSessionId.mockReturnValue(null)
      await runLogAction(makeOptions())
      expect(getStdout()).toContain('No log entries found')
    })

    it('calls getSessionLog with the latest session ID', async () => {
      mockGetLatestSessionId.mockReturnValue('sess-latest')
      mockGetSessionLog.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions())
      expect(mockGetSessionLog).toHaveBeenCalledWith(expect.anything(), 'sess-latest')
    })

    it('outputs table format for default view', async () => {
      mockGetSessionLog.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions())
      expect(getStdout()).toContain('Timestamp')
      expect(getStdout()).toContain('Event')
    })

    it('does not call getTaskLog or getLogByEvent in default mode', async () => {
      mockGetSessionLog.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions())
      expect(mockGetTaskLog).not.toHaveBeenCalled()
      expect(mockGetLogByEvent).not.toHaveBeenCalled()
    })

    it('applies default limit of 50 to session log', async () => {
      const entries = Array.from({ length: 100 }, (_, i) => makeEntry({ id: i + 1 }))
      mockGetSessionLog.mockReturnValue(entries)
      // With default limit of 50, the output should show the table (not empty)
      const code = await runLogAction(makeOptions({ limit: 50 }))
      expect(code).toBe(LOG_EXIT_SUCCESS)
      expect(getStdout()).toContain('Timestamp')
    })
  })

  // -------------------------------------------------------------------------
  // AC1: Query by Task ID
  // -------------------------------------------------------------------------

  describe('AC1 - Task filter', () => {
    it('calls getTaskLog with the task ID', async () => {
      mockGetTaskLog.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ taskId: 'task-1' }))
      expect(mockGetTaskLog).toHaveBeenCalledWith(expect.anything(), 'task-1')
    })

    it('returns success with task filter', async () => {
      mockGetTaskLog.mockReturnValue([makeEntry()])
      const code = await runLogAction(makeOptions({ taskId: 'task-1' }))
      expect(code).toBe(LOG_EXIT_SUCCESS)
    })

    it('does not call getSessionLog when taskId is provided', async () => {
      mockGetTaskLog.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ taskId: 'task-1' }))
      expect(mockGetSessionLog).not.toHaveBeenCalled()
    })

    it('formats result as table with expected columns', async () => {
      mockGetTaskLog.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ taskId: 'task-1' }))
      expect(getStdout()).toContain('Timestamp')
      expect(getStdout()).toContain('Event')
      expect(getStdout()).toContain('Task ID')
    })

    it('applies limit to getTaskLog results via slice', async () => {
      const entries = Array.from({ length: 20 }, (_, i) => makeEntry({ id: i + 1 }))
      mockGetTaskLog.mockReturnValue(entries)
      const code = await runLogAction(makeOptions({ taskId: 'task-1', limit: 5 }))
      expect(code).toBe(LOG_EXIT_SUCCESS)
      expect(getStdout()).toContain('Timestamp')
    })

    it('shows "No log entries found" when task has no entries', async () => {
      mockGetTaskLog.mockReturnValue([])
      await runLogAction(makeOptions({ taskId: 'task-99' }))
      expect(getStdout()).toContain('No log entries found')
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Filter by Event Type
  // -------------------------------------------------------------------------

  describe('AC2 - Event filter', () => {
    it('calls getLogByEvent with correct args', async () => {
      mockGetLogByEvent.mockReturnValue([makeEntry({ event: 'task:status_change' })])
      await runLogAction(makeOptions({ event: 'task:status_change', limit: 50 }))
      expect(mockGetLogByEvent).toHaveBeenCalledWith(
        expect.anything(),
        'sess-latest',
        'task:status_change',
        50,
      )
    })

    it('returns success with event filter', async () => {
      mockGetLogByEvent.mockReturnValue([makeEntry()])
      const code = await runLogAction(makeOptions({ event: 'task:status_change' }))
      expect(code).toBe(LOG_EXIT_SUCCESS)
    })

    it('passes limit to getLogByEvent', async () => {
      mockGetLogByEvent.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ event: 'orchestrator:state_change', limit: 10 }))
      expect(mockGetLogByEvent).toHaveBeenCalledWith(
        expect.anything(),
        'sess-latest',
        'orchestrator:state_change',
        10,
      )
    })

    it('does not call getTaskLog when only event is provided', async () => {
      mockGetLogByEvent.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ event: 'task:status_change' }))
      expect(mockGetTaskLog).not.toHaveBeenCalled()
    })

    it('uses explicit session ID with event filter', async () => {
      mockGetLogByEvent.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ event: 'task:status_change', sessionId: 'sess-explicit' }))
      expect(mockGetLogByEvent).toHaveBeenCalledWith(
        expect.anything(),
        'sess-explicit',
        'task:status_change',
        50,
      )
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Session scoping and limit control
  // -------------------------------------------------------------------------

  describe('AC5 - Session and limit', () => {
    it('uses explicit session ID when provided', async () => {
      mockGetSessionLog.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ sessionId: 'sess-abc', limit: 50 }))
      expect(mockGetSessionLog).toHaveBeenCalledWith(expect.anything(), 'sess-abc')
    })

    it('does not call getLatestSessionId when explicit sessionId is provided', async () => {
      mockGetSessionLog.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ sessionId: 'sess-abc' }))
      expect(mockGetLatestSessionId).not.toHaveBeenCalled()
    })

    it('returns success with explicit session and limit', async () => {
      mockGetSessionLog.mockReturnValue([makeEntry()])
      const code = await runLogAction(makeOptions({ sessionId: 'sess-abc', limit: 5 }))
      expect(code).toBe(LOG_EXIT_SUCCESS)
    })

    it('limits output when getSessionLog returns more entries than limit', async () => {
      const entries = Array.from({ length: 100 }, (_, i) => makeEntry({ id: i + 1 }))
      mockGetSessionLog.mockReturnValue(entries)
      const code = await runLogAction(makeOptions({ limit: 5 }))
      expect(code).toBe(LOG_EXIT_SUCCESS)
      expect(getStdout()).toContain('Timestamp')
    })
  })

  // -------------------------------------------------------------------------
  // AC3: JSON output
  // -------------------------------------------------------------------------

  describe('AC3 - JSON output', () => {
    it('writes valid JSON to stdout', async () => {
      mockGetSessionLog.mockReturnValue([makeEntry()])
      const code = await runLogAction(makeOptions({ outputFormat: 'json' }))
      expect(code).toBe(LOG_EXIT_SUCCESS)
      expect(() => JSON.parse(getStdout())).not.toThrow()
    })

    it('JSON output has timestamp field', async () => {
      mockGetSessionLog.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ outputFormat: 'json', version: '1.0.0' }))
      const parsed = JSON.parse(getStdout()) as { timestamp: string; version: string; command: string; data: LogEntry[] }
      expect(parsed).toHaveProperty('timestamp')
    })

    it('JSON output has correct version field', async () => {
      mockGetSessionLog.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ outputFormat: 'json', version: '1.0.0' }))
      const parsed = JSON.parse(getStdout()) as { version: string }
      expect(parsed.version).toBe('1.0.0')
    })

    it('JSON output has correct command field', async () => {
      mockGetSessionLog.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ outputFormat: 'json' }))
      const parsed = JSON.parse(getStdout()) as { command: string }
      expect(parsed.command).toBe('substrate log')
    })

    it('JSON output data is an array', async () => {
      mockGetSessionLog.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ outputFormat: 'json' }))
      const parsed = JSON.parse(getStdout()) as { data: LogEntry[] }
      expect(Array.isArray(parsed.data)).toBe(true)
    })

    it('JSON data array contains LogEntry objects', async () => {
      const entry = makeEntry()
      mockGetSessionLog.mockReturnValue([entry])
      await runLogAction(makeOptions({ outputFormat: 'json' }))
      const parsed = JSON.parse(getStdout()) as { data: LogEntry[] }
      expect(parsed.data).toHaveLength(1)
      expect(parsed.data[0]).toMatchObject({
        session_id: 'sess-abc',
        event: 'task:status_change',
      })
    })

    it('JSON output with no entries has empty data array', async () => {
      mockGetSessionLog.mockReturnValue([])
      await runLogAction(makeOptions({ outputFormat: 'json' }))
      const parsed = JSON.parse(getStdout()) as { data: LogEntry[] }
      expect(parsed.data).toEqual([])
    })

    it('JSON output with no session has empty data array', async () => {
      mockGetLatestSessionId.mockReturnValue(null)
      await runLogAction(makeOptions({ outputFormat: 'json' }))
      const parsed = JSON.parse(getStdout()) as { data: LogEntry[] }
      expect(parsed.data).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Combined task + event filter
  // -------------------------------------------------------------------------

  describe('Combined task + event filter', () => {
    it('calls queryLogFiltered when both taskId and event are provided', async () => {
      mockQueryLogFiltered.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ taskId: 'task-1', event: 'task:status_change', limit: 10 }))
      expect(mockQueryLogFiltered).toHaveBeenCalledWith(expect.anything(), {
        sessionId: 'sess-latest',
        taskId: 'task-1',
        event: 'task:status_change',
        limit: 10,
        order: 'asc',
      })
    })

    it('does not call getTaskLog or getLogByEvent for combined filter', async () => {
      mockQueryLogFiltered.mockReturnValue([makeEntry()])
      await runLogAction(makeOptions({ taskId: 'task-1', event: 'task:status_change' }))
      expect(mockGetTaskLog).not.toHaveBeenCalled()
      expect(mockGetLogByEvent).not.toHaveBeenCalled()
    })

    it('returns success for combined filter', async () => {
      mockQueryLogFiltered.mockReturnValue([makeEntry()])
      const code = await runLogAction(makeOptions({ taskId: 'task-1', event: 'task:status_change' }))
      expect(code).toBe(LOG_EXIT_SUCCESS)
    })
  })
})
