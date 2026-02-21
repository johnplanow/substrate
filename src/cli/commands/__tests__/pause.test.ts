/**
 * Unit tests for `src/cli/commands/pause.ts`
 *
 * Covers Acceptance Criteria:
 *   AC1: Active session → status updated to paused, exit 0
 *   AC2: Already paused/cancelled/complete session → warning, exit 2
 *   AC7: Session not found → stderr error, exit 2
 *   AC8: --output-format json → NDJSON output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Fake DB rows
// ---------------------------------------------------------------------------

interface FakeSession {
  id: string
  status: string
}

let _fakeSession: FakeSession | null = null
let _fakeCompletedCount = 2
let _fakePendingCount = 3
let _sessionUpdates: Array<{ id: string; status: string }> = []
let _signalsInserted: Array<{ sessionId: string; signal: string }> = []
let _dbPath = ''
let _existsResult = true

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('fs', () => ({
  existsSync: (p: string) => {
    _dbPath = p
    return _existsResult
  },
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// We mock DatabaseWrapper to avoid real SQLite I/O
vi.mock('../../../persistence/database.js', () => {
  return {
    DatabaseWrapper: class MockDatabaseWrapper {
      open() { /* no-op */ }
      close() { /* no-op */ }
      get db() {
        return {
          prepare: (sql: string) => ({
            get: (id: string) => {
              if (sql.includes('SELECT id, status FROM sessions')) {
                return _fakeSession ?? undefined
              }
              if (sql.includes("status = 'completed'")) {
                return { cnt: _fakeCompletedCount }
              }
              if (sql.includes("status IN ('pending', 'ready')")) {
                return { cnt: _fakePendingCount }
              }
              return undefined
            },
            run: (id: string) => {
              if (sql.includes("SET status = 'paused'")) {
                _sessionUpdates.push({ id, status: 'paused' })
              }
              if (sql.includes("INSERT INTO session_signals") && sql.includes("'pause'")) {
                _signalsInserted.push({ sessionId: id, signal: 'pause' })
              }
            },
          }),
          transaction: (fn: () => void) => () => {
            fn()
          },
        }
      }
    },
  }
})

vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports — after all vi.mock() declarations
// ---------------------------------------------------------------------------

import {
  runPauseAction,
  PAUSE_EXIT_SUCCESS,
  PAUSE_EXIT_ERROR,
  PAUSE_EXIT_USAGE_ERROR,
} from '../pause.js'
import type { PauseActionOptions } from '../pause.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/fake/project'

function defaultOptions(overrides: Partial<PauseActionOptions> = {}): PauseActionOptions {
  return {
    sessionId: 'sess-abc-123',
    outputFormat: 'human',
    projectRoot: PROJECT_ROOT,
    version: '1.0.0',
    ...overrides,
  }
}

let _stdoutOutput: string
let _stderrOutput: string

function captureOutput(): void {
  _stdoutOutput = ''
  _stderrOutput = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
    _stdoutOutput += typeof data === 'string' ? data : data.toString()
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
    _stderrOutput += typeof data === 'string' ? data : data.toString()
    return true
  })
}

function getStdout(): string { return _stdoutOutput }
function getStderr(): string { return _stderrOutput }

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  captureOutput()
  _fakeSession = { id: 'sess-abc-123', status: 'active' }
  _fakeCompletedCount = 2
  _fakePendingCount = 3
  _sessionUpdates = []
  _signalsInserted = []
  _existsResult = true
  _dbPath = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Exit code constants
// ---------------------------------------------------------------------------

describe('exit code constants', () => {
  it('PAUSE_EXIT_SUCCESS is 0', () => { expect(PAUSE_EXIT_SUCCESS).toBe(0) })
  it('PAUSE_EXIT_ERROR is 1', () => { expect(PAUSE_EXIT_ERROR).toBe(1) })
  it('PAUSE_EXIT_USAGE_ERROR is 2', () => { expect(PAUSE_EXIT_USAGE_ERROR).toBe(2) })
})

// ---------------------------------------------------------------------------
// AC1: Active session → pause succeeds
// ---------------------------------------------------------------------------

describe('AC1: active session → status updated to paused, exit 0', () => {
  it('returns exit code 0 when session is active', async () => {
    const exitCode = await runPauseAction(defaultOptions())
    expect(exitCode).toBe(PAUSE_EXIT_SUCCESS)
  })

  it('prints success message to stdout', async () => {
    await runPauseAction(defaultOptions())
    expect(getStdout()).toContain('paused')
    expect(getStdout()).toContain('sess-abc-123')
  })

  it('includes completed task count in output', async () => {
    _fakeCompletedCount = 5
    await runPauseAction(defaultOptions())
    expect(getStdout()).toContain('5 tasks completed')
  })

  it('includes pending task count in output', async () => {
    _fakePendingCount = 7
    await runPauseAction(defaultOptions())
    expect(getStdout()).toContain('7 tasks still pending')
  })

  it('writes nothing to stderr on success', async () => {
    await runPauseAction(defaultOptions())
    expect(getStderr()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// AC2: Already paused or terminal state
// ---------------------------------------------------------------------------

describe('AC2: already paused/cancelled/complete → warning, exit 2', () => {
  it('returns exit code 2 when session is already paused', async () => {
    _fakeSession = { id: 'sess-abc-123', status: 'paused' }
    const exitCode = await runPauseAction(defaultOptions())
    expect(exitCode).toBe(PAUSE_EXIT_USAGE_ERROR)
  })

  it('prints warning message for already-paused session', async () => {
    _fakeSession = { id: 'sess-abc-123', status: 'paused' }
    await runPauseAction(defaultOptions())
    expect(getStdout()).toContain('already paused')
  })

  it('returns exit code 2 when session is cancelled', async () => {
    _fakeSession = { id: 'sess-abc-123', status: 'cancelled' }
    const exitCode = await runPauseAction(defaultOptions())
    expect(exitCode).toBe(PAUSE_EXIT_USAGE_ERROR)
  })

  it('returns exit code 2 when session is complete', async () => {
    _fakeSession = { id: 'sess-abc-123', status: 'complete' }
    const exitCode = await runPauseAction(defaultOptions())
    expect(exitCode).toBe(PAUSE_EXIT_USAGE_ERROR)
  })

  it('includes the current status in the warning message', async () => {
    _fakeSession = { id: 'sess-abc-123', status: 'cancelled' }
    await runPauseAction(defaultOptions())
    expect(getStdout()).toContain('cancelled')
  })

  it('includes "cannot pause" in the warning message', async () => {
    _fakeSession = { id: 'sess-abc-123', status: 'paused' }
    await runPauseAction(defaultOptions())
    expect(getStdout()).toContain('cannot pause')
  })
})

// ---------------------------------------------------------------------------
// AC7: Session not found
// ---------------------------------------------------------------------------

describe('AC7: session not found → stderr error, exit 2', () => {
  it('returns exit code 2 when session not found', async () => {
    _fakeSession = null
    const exitCode = await runPauseAction(defaultOptions())
    expect(exitCode).toBe(PAUSE_EXIT_USAGE_ERROR)
  })

  it('writes error to stderr when session not found', async () => {
    _fakeSession = null
    await runPauseAction(defaultOptions({ sessionId: 'missing-sess' }))
    expect(getStderr()).toContain('Error: Session not found: missing-sess')
  })

  it('writes nothing to stdout when session not found', async () => {
    _fakeSession = null
    await runPauseAction(defaultOptions())
    expect(getStdout()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// AC8: --output-format json → NDJSON output
// ---------------------------------------------------------------------------

describe('AC8: --output-format json → NDJSON output', () => {
  it('emits a single NDJSON line to stdout on success', async () => {
    const exitCode = await runPauseAction(defaultOptions({ outputFormat: 'json' }))
    expect(exitCode).toBe(PAUSE_EXIT_SUCCESS)

    const lines = getStdout().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.event).toBe('session:pause')
    expect(parsed.timestamp).toBeDefined()
    expect(parsed.data.sessionId).toBe('sess-abc-123')
    expect(parsed.data.newStatus).toBe('paused')
    expect(parsed.data.previousStatus).toBe('active')
  })

  it('includes human-readable message in JSON data', async () => {
    await runPauseAction(defaultOptions({ outputFormat: 'json' }))
    const lines = getStdout().split('\n').filter(Boolean)
    const parsed = JSON.parse(lines[0])
    expect(parsed.data.message).toContain('paused')
  })

  it('returns exit code 2 and emits JSON for already-paused session', async () => {
    _fakeSession = { id: 'sess-abc-123', status: 'paused' }
    const exitCode = await runPauseAction(defaultOptions({ outputFormat: 'json' }))
    expect(exitCode).toBe(PAUSE_EXIT_USAGE_ERROR)
    const lines = getStdout().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.data.newStatus).toBe('paused')
  })

  it('ISO 8601 timestamp is present in JSON output', async () => {
    await runPauseAction(defaultOptions({ outputFormat: 'json' }))
    const lines = getStdout().split('\n').filter(Boolean)
    const parsed = JSON.parse(lines[0])
    expect(() => new Date(parsed.timestamp).toISOString()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// DB not found
// ---------------------------------------------------------------------------

describe('database not found', () => {
  it('returns exit code 1 when DB does not exist', async () => {
    _existsResult = false
    const exitCode = await runPauseAction(defaultOptions())
    expect(exitCode).toBe(PAUSE_EXIT_ERROR)
  })

  it('writes error to stderr when DB does not exist', async () => {
    _existsResult = false
    await runPauseAction(defaultOptions())
    expect(getStderr()).toContain('Error: No Substrate database found')
  })
})
