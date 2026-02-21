/**
 * Unit tests for `src/cli/commands/cancel.ts`
 *
 * Covers Acceptance Criteria:
 *   AC5: Active session → all pending/running tasks cancelled, exit 0
 *   AC6: Already cancelled/complete → warning, exit 2
 *   AC7: Session not found → stderr error, exit 2
 *   AC8: --output-format json → NDJSON output
 *   AC9: Interactive TTY, no --yes → prompt shown; 'n' → aborts with exit 0
 *   AC9: --yes → prompt skipped, proceeds directly
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
let _fakeCancelledTaskCount = 4
let _sessionUpdates: Array<{ id: string; status: string }> = []
let _signalsInserted: Array<{ sessionId: string; signal: string }> = []
let _existsResult = true

// ---------------------------------------------------------------------------
// Readline mock (for AC9 confirmation prompt)
// ---------------------------------------------------------------------------

let _promptAnswer = 'n'

vi.mock('readline', () => ({
  createInterface: () => ({
    question: (_msg: string, callback: (answer: string) => void) => {
      callback(_promptAnswer)
    },
    close: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('fs', () => ({
  existsSync: () => _existsResult,
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../../../persistence/database.js', () => {
  return {
    DatabaseWrapper: class MockDatabaseWrapper {
      open() { /* no-op */ }
      close() { /* no-op */ }
      get db() {
        const fakeDb = {
          prepare: (sql: string) => ({
            get: (_id: string) => {
              if (sql.includes('SELECT id, status FROM sessions')) {
                return _fakeSession ?? undefined
              }
              if (sql.includes('COUNT(*)')) {
                return { cnt: _fakeCancelledTaskCount }
              }
              return undefined
            },
            run: (id: string) => {
              if (sql.includes("SET status = 'cancelled'") && sql.includes('sessions')) {
                _sessionUpdates.push({ id, status: 'cancelled' })
              }
              if (sql.includes("INSERT INTO session_signals") && sql.includes("'cancel'")) {
                _signalsInserted.push({ sessionId: id, signal: 'cancel' })
              }
            },
          }),
          transaction: (fn: () => unknown) => () => {
            return fn()
          },
        }
        return fakeDb
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
  runCancelAction,
  CANCEL_EXIT_SUCCESS,
  CANCEL_EXIT_ERROR,
  CANCEL_EXIT_USAGE_ERROR,
} from '../cancel.js'
import type { CancelActionOptions } from '../cancel.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/fake/project'

function defaultOptions(overrides: Partial<CancelActionOptions> = {}): CancelActionOptions {
  return {
    sessionId: 'sess-active-789',
    outputFormat: 'human',
    yes: true, // skip prompt by default in tests
    projectRoot: PROJECT_ROOT,
    version: '1.0.0',
    isTTY: false, // non-interactive by default
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
  _fakeSession = { id: 'sess-active-789', status: 'active' }
  _fakeCancelledTaskCount = 4
  _sessionUpdates = []
  _signalsInserted = []
  _existsResult = true
  _promptAnswer = 'n'
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Exit code constants
// ---------------------------------------------------------------------------

describe('exit code constants', () => {
  it('CANCEL_EXIT_SUCCESS is 0', () => { expect(CANCEL_EXIT_SUCCESS).toBe(0) })
  it('CANCEL_EXIT_ERROR is 1', () => { expect(CANCEL_EXIT_ERROR).toBe(1) })
  it('CANCEL_EXIT_USAGE_ERROR is 2', () => { expect(CANCEL_EXIT_USAGE_ERROR).toBe(2) })
})

// ---------------------------------------------------------------------------
// AC5: Active session → cancel succeeds
// ---------------------------------------------------------------------------

describe('AC5: active session → all pending/running tasks cancelled, exit 0', () => {
  it('returns exit code 0 when session is active', async () => {
    const exitCode = await runCancelAction(defaultOptions())
    expect(exitCode).toBe(CANCEL_EXIT_SUCCESS)
  })

  it('prints success message to stdout', async () => {
    await runCancelAction(defaultOptions())
    expect(getStdout()).toContain('cancelled')
    expect(getStdout()).toContain('sess-active-789')
  })

  it('writes nothing to stderr on success', async () => {
    await runCancelAction(defaultOptions())
    expect(getStderr()).toBe('')
  })

  it('also cancels a paused session', async () => {
    _fakeSession = { id: 'sess-active-789', status: 'paused' }
    const exitCode = await runCancelAction(defaultOptions())
    expect(exitCode).toBe(CANCEL_EXIT_SUCCESS)
  })
})

// ---------------------------------------------------------------------------
// AC6: Already cancelled or complete
// ---------------------------------------------------------------------------

describe('AC6: already cancelled/complete → warning, exit 2', () => {
  it('returns exit code 2 when session is already cancelled', async () => {
    _fakeSession = { id: 'sess-active-789', status: 'cancelled' }
    const exitCode = await runCancelAction(defaultOptions())
    expect(exitCode).toBe(CANCEL_EXIT_USAGE_ERROR)
  })

  it('prints warning for already-cancelled session', async () => {
    _fakeSession = { id: 'sess-active-789', status: 'cancelled' }
    await runCancelAction(defaultOptions())
    expect(getStdout()).toContain('already cancelled')
    expect(getStdout()).toContain('cannot cancel')
  })

  it('returns exit code 2 when session is complete', async () => {
    _fakeSession = { id: 'sess-active-789', status: 'complete' }
    const exitCode = await runCancelAction(defaultOptions())
    expect(exitCode).toBe(CANCEL_EXIT_USAGE_ERROR)
  })

  it('includes the current status in the warning', async () => {
    _fakeSession = { id: 'sess-active-789', status: 'complete' }
    await runCancelAction(defaultOptions())
    expect(getStdout()).toContain('complete')
  })
})

// ---------------------------------------------------------------------------
// AC7: Session not found
// ---------------------------------------------------------------------------

describe('AC7: session not found → stderr error, exit 2', () => {
  it('returns exit code 2 when session not found', async () => {
    _fakeSession = null
    const exitCode = await runCancelAction(defaultOptions())
    expect(exitCode).toBe(CANCEL_EXIT_USAGE_ERROR)
  })

  it('writes error to stderr when session not found', async () => {
    _fakeSession = null
    await runCancelAction(defaultOptions({ sessionId: 'no-such-sess' }))
    expect(getStderr()).toContain('Error: Session not found: no-such-sess')
  })

  it('writes nothing to stdout when session not found', async () => {
    _fakeSession = null
    await runCancelAction(defaultOptions())
    expect(getStdout()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// AC8: --output-format json → NDJSON output
// ---------------------------------------------------------------------------

describe('AC8: --output-format json → NDJSON output', () => {
  it('emits a single NDJSON line to stdout on success', async () => {
    const exitCode = await runCancelAction(defaultOptions({ outputFormat: 'json' }))
    expect(exitCode).toBe(CANCEL_EXIT_SUCCESS)

    const lines = getStdout().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.event).toBe('session:cancel')
    expect(parsed.timestamp).toBeDefined()
    expect(parsed.data.sessionId).toBe('sess-active-789')
    expect(parsed.data.newStatus).toBe('cancelled')
    expect(parsed.data.previousStatus).toBe('active')
  })

  it('includes human-readable message in JSON data', async () => {
    await runCancelAction(defaultOptions({ outputFormat: 'json' }))
    const lines = getStdout().split('\n').filter(Boolean)
    const parsed = JSON.parse(lines[0])
    expect(parsed.data.message).toContain('cancelled')
  })

  it('returns exit code 2 and emits JSON for already-cancelled session', async () => {
    _fakeSession = { id: 'sess-active-789', status: 'cancelled' }
    const exitCode = await runCancelAction(defaultOptions({ outputFormat: 'json' }))
    expect(exitCode).toBe(CANCEL_EXIT_USAGE_ERROR)
    const lines = getStdout().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.data.previousStatus).toBe('cancelled')
  })

  it('ISO 8601 timestamp is present in JSON output', async () => {
    await runCancelAction(defaultOptions({ outputFormat: 'json' }))
    const lines = getStdout().split('\n').filter(Boolean)
    const parsed = JSON.parse(lines[0])
    expect(() => new Date(parsed.timestamp).toISOString()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC9: Interactive TTY confirmation prompt
// ---------------------------------------------------------------------------

describe('AC9: interactive TTY, no --yes → prompt shown', () => {
  it('aborts with exit code 0 when user types n', async () => {
    _promptAnswer = 'n'
    const exitCode = await runCancelAction(defaultOptions({ yes: false, isTTY: true }))
    expect(exitCode).toBe(CANCEL_EXIT_SUCCESS)
    expect(getStdout()).toContain('Cancelled by user.')
  })

  it('aborts with exit code 0 when user types anything other than y/yes', async () => {
    _promptAnswer = 'no'
    const exitCode = await runCancelAction(defaultOptions({ yes: false, isTTY: true }))
    expect(exitCode).toBe(CANCEL_EXIT_SUCCESS)
  })

  it('proceeds when user types y', async () => {
    _promptAnswer = 'y'
    const exitCode = await runCancelAction(defaultOptions({ yes: false, isTTY: true }))
    expect(exitCode).toBe(CANCEL_EXIT_SUCCESS)
    expect(getStdout()).toContain('cancelled')
    expect(getStdout()).not.toContain('Cancelled by user.')
  })

  it('proceeds when user types yes', async () => {
    _promptAnswer = 'yes'
    const exitCode = await runCancelAction(defaultOptions({ yes: false, isTTY: true }))
    expect(exitCode).toBe(CANCEL_EXIT_SUCCESS)
    expect(getStdout()).toContain('cancelled')
  })
})

describe('AC9: --yes → prompt skipped', () => {
  it('skips prompt when --yes is passed', async () => {
    _promptAnswer = 'n' // if prompt were shown, it would abort
    const exitCode = await runCancelAction(defaultOptions({ yes: true, isTTY: true }))
    expect(exitCode).toBe(CANCEL_EXIT_SUCCESS)
    expect(getStdout()).not.toContain('Cancelled by user.')
    expect(getStdout()).toContain('cancelled')
  })

  it('skips prompt in non-interactive mode even without --yes', async () => {
    _promptAnswer = 'n'
    const exitCode = await runCancelAction(defaultOptions({ yes: false, isTTY: false }))
    expect(exitCode).toBe(CANCEL_EXIT_SUCCESS)
  })
})

// ---------------------------------------------------------------------------
// Database not found
// ---------------------------------------------------------------------------

describe('database not found', () => {
  it('returns exit code 1 when DB does not exist', async () => {
    _existsResult = false
    const exitCode = await runCancelAction(defaultOptions())
    expect(exitCode).toBe(CANCEL_EXIT_ERROR)
  })

  it('writes error to stderr when DB does not exist', async () => {
    _existsResult = false
    await runCancelAction(defaultOptions())
    expect(getStderr()).toContain('Error: No Substrate database found')
  })
})
