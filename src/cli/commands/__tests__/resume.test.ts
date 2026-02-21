/**
 * Unit tests for `src/cli/commands/resume.ts`
 *
 * Covers Acceptance Criteria:
 *   AC3: Paused session → status updated to active, pending task count printed, exit 0
 *   AC4: Active/cancelled/complete session → warning, exit 2
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
let _fakePendingCount = 5
let _sessionUpdates: Array<{ id: string; status: string }> = []
let _signalsInserted: Array<{ sessionId: string; signal: string }> = []
let _existsResult = true

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
        return {
          prepare: (sql: string) => ({
            get: (_id: string) => {
              if (sql.includes('SELECT id, status FROM sessions')) {
                return _fakeSession ?? undefined
              }
              if (sql.includes("status IN ('pending', 'ready')")) {
                return { cnt: _fakePendingCount }
              }
              return undefined
            },
            run: (id: string) => {
              if (sql.includes("SET status = 'active'")) {
                _sessionUpdates.push({ id, status: 'active' })
              }
              if (sql.includes("INSERT INTO session_signals") && sql.includes("'resume'")) {
                _signalsInserted.push({ sessionId: id, signal: 'resume' })
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
  runResumeAction,
  RESUME_EXIT_SUCCESS,
  RESUME_EXIT_ERROR,
  RESUME_EXIT_USAGE_ERROR,
} from '../resume.js'
import type { ResumeActionOptions } from '../resume.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/fake/project'

function defaultOptions(overrides: Partial<ResumeActionOptions> = {}): ResumeActionOptions {
  return {
    sessionId: 'sess-paused-456',
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
  _fakeSession = { id: 'sess-paused-456', status: 'paused' }
  _fakePendingCount = 5
  _sessionUpdates = []
  _signalsInserted = []
  _existsResult = true
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Exit code constants
// ---------------------------------------------------------------------------

describe('exit code constants', () => {
  it('RESUME_EXIT_SUCCESS is 0', () => { expect(RESUME_EXIT_SUCCESS).toBe(0) })
  it('RESUME_EXIT_ERROR is 1', () => { expect(RESUME_EXIT_ERROR).toBe(1) })
  it('RESUME_EXIT_USAGE_ERROR is 2', () => { expect(RESUME_EXIT_USAGE_ERROR).toBe(2) })
})

// ---------------------------------------------------------------------------
// AC3: Paused session → resume succeeds
// ---------------------------------------------------------------------------

describe('AC3: paused session → status updated to active, pending count printed, exit 0', () => {
  it('returns exit code 0 when session is paused', async () => {
    const exitCode = await runResumeAction(defaultOptions())
    expect(exitCode).toBe(RESUME_EXIT_SUCCESS)
  })

  it('prints success message to stdout', async () => {
    await runResumeAction(defaultOptions())
    expect(getStdout()).toContain('resumed')
    expect(getStdout()).toContain('sess-paused-456')
  })

  it('includes pending task count in output', async () => {
    _fakePendingCount = 8
    await runResumeAction(defaultOptions())
    expect(getStdout()).toContain('8 tasks pending')
  })

  it('writes nothing to stderr on success', async () => {
    await runResumeAction(defaultOptions())
    expect(getStderr()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// AC4: Invalid state transition
// ---------------------------------------------------------------------------

describe('AC4: active/cancelled/complete session → warning, exit 2', () => {
  it('returns exit code 2 when session is active', async () => {
    _fakeSession = { id: 'sess-paused-456', status: 'active' }
    const exitCode = await runResumeAction(defaultOptions())
    expect(exitCode).toBe(RESUME_EXIT_USAGE_ERROR)
  })

  it('prints warning for active session', async () => {
    _fakeSession = { id: 'sess-paused-456', status: 'active' }
    await runResumeAction(defaultOptions())
    expect(getStdout()).toContain('can only resume a paused session')
  })

  it('returns exit code 2 when session is cancelled', async () => {
    _fakeSession = { id: 'sess-paused-456', status: 'cancelled' }
    const exitCode = await runResumeAction(defaultOptions())
    expect(exitCode).toBe(RESUME_EXIT_USAGE_ERROR)
  })

  it('returns exit code 2 when session is complete', async () => {
    _fakeSession = { id: 'sess-paused-456', status: 'complete' }
    const exitCode = await runResumeAction(defaultOptions())
    expect(exitCode).toBe(RESUME_EXIT_USAGE_ERROR)
  })

  it('includes current status in warning message', async () => {
    _fakeSession = { id: 'sess-paused-456', status: 'active' }
    await runResumeAction(defaultOptions())
    expect(getStdout()).toContain('active')
  })
})

// ---------------------------------------------------------------------------
// AC7: Session not found
// ---------------------------------------------------------------------------

describe('AC7: session not found → stderr error, exit 2', () => {
  it('returns exit code 2 when session not found', async () => {
    _fakeSession = null
    const exitCode = await runResumeAction(defaultOptions())
    expect(exitCode).toBe(RESUME_EXIT_USAGE_ERROR)
  })

  it('writes error to stderr when session not found', async () => {
    _fakeSession = null
    await runResumeAction(defaultOptions({ sessionId: 'ghost-session' }))
    expect(getStderr()).toContain('Error: Session not found: ghost-session')
  })

  it('writes nothing to stdout when session not found', async () => {
    _fakeSession = null
    await runResumeAction(defaultOptions())
    expect(getStdout()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// AC8: --output-format json → NDJSON output
// ---------------------------------------------------------------------------

describe('AC8: --output-format json → NDJSON output', () => {
  it('emits a single NDJSON line to stdout on success', async () => {
    const exitCode = await runResumeAction(defaultOptions({ outputFormat: 'json' }))
    expect(exitCode).toBe(RESUME_EXIT_SUCCESS)

    const lines = getStdout().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.event).toBe('session:resume')
    expect(parsed.timestamp).toBeDefined()
    expect(parsed.data.sessionId).toBe('sess-paused-456')
    expect(parsed.data.newStatus).toBe('active')
    expect(parsed.data.previousStatus).toBe('paused')
  })

  it('includes human-readable message in JSON data', async () => {
    await runResumeAction(defaultOptions({ outputFormat: 'json' }))
    const lines = getStdout().split('\n').filter(Boolean)
    const parsed = JSON.parse(lines[0])
    expect(parsed.data.message).toContain('resumed')
  })

  it('returns exit code 2 and emits JSON for invalid state', async () => {
    _fakeSession = { id: 'sess-paused-456', status: 'active' }
    const exitCode = await runResumeAction(defaultOptions({ outputFormat: 'json' }))
    expect(exitCode).toBe(RESUME_EXIT_USAGE_ERROR)
    const lines = getStdout().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.data.previousStatus).toBe('active')
  })

  it('ISO 8601 timestamp is present in JSON output', async () => {
    await runResumeAction(defaultOptions({ outputFormat: 'json' }))
    const lines = getStdout().split('\n').filter(Boolean)
    const parsed = JSON.parse(lines[0])
    expect(() => new Date(parsed.timestamp).toISOString()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Database not found
// ---------------------------------------------------------------------------

describe('database not found', () => {
  it('returns exit code 1 when DB does not exist', async () => {
    _existsResult = false
    const exitCode = await runResumeAction(defaultOptions())
    expect(exitCode).toBe(RESUME_EXIT_ERROR)
  })

  it('writes error to stderr when DB does not exist', async () => {
    _existsResult = false
    await runResumeAction(defaultOptions())
    expect(getStderr()).toContain('Error: No Substrate database found')
  })
})
