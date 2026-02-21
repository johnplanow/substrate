/**
 * Integration tests for pause / resume / cancel commands
 *
 * Uses a real in-memory SQLite database to test the full pipeline:
 *   - Pause→Resume cycle: session status transitions correctly in DB
 *   - Tasks remain 'pending' after pause (not cancelled)
 *   - Tasks are correctly marked 'cancelled' after cancel
 *   - Signal table is written with correct signal value
 *   - Session-not-found error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { randomUUID } from 'crypto'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { createSession } from '../../../persistence/queries/sessions.js'
import { createTask } from '../../../persistence/queries/tasks.js'
import { runPauseAction } from '../../commands/pause.js'
import { runResumeAction } from '../../commands/resume.js'
import { runCancelAction } from '../../commands/cancel.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _tmpDir: string

/**
 * Create a temporary directory with a real SQLite database and apply migrations.
 */
function createTempDb(): { dbPath: string; db: BetterSqlite3Database; projectRoot: string } {
  _tmpDir = join(tmpdir(), `substrate-test-${randomUUID()}`)
  const substrateDir = join(_tmpDir, '.substrate')
  mkdirSync(substrateDir, { recursive: true })
  const dbPath = join(substrateDir, 'state.db')

  const db = new BetterSqlite3(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)

  return { dbPath, db, projectRoot: _tmpDir }
}

function cleanupTempDb(): void {
  if (_tmpDir) {
    try {
      rmSync(_tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}

function seedSession(
  db: BetterSqlite3Database,
  sessionId: string,
  status: string = 'active',
): void {
  createSession(db, {
    id: sessionId,
    graph_file: 'test.yaml',
    status,
    base_branch: 'main',
    total_cost_usd: 0,
    planning_cost_usd: 0,
  })
}

function seedTask(
  db: BetterSqlite3Database,
  taskId: string,
  sessionId: string,
  status: string,
): void {
  createTask(db, {
    id: taskId,
    session_id: sessionId,
    name: `Task ${taskId}`,
    prompt: 'do something',
    status,
    agent: 'claude',
    started_at: status === 'running' ? new Date(Date.now() - 3000).toISOString() : null,
    completed_at: status === 'completed' ? new Date().toISOString() : null,
  })
}

function getSessionStatus(db: BetterSqlite3Database, sessionId: string): string | undefined {
  const row = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as
    | { status: string }
    | undefined
  return row?.status
}

function getTaskStatus(db: BetterSqlite3Database, taskId: string): string | undefined {
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as
    | { status: string }
    | undefined
  return row?.status
}

function getSignals(
  db: BetterSqlite3Database,
  sessionId: string,
): Array<{ signal: string; processed_at: string | null }> {
  return db
    .prepare('SELECT signal, processed_at FROM session_signals WHERE session_id = ? ORDER BY id')
    .all(sessionId) as Array<{ signal: string; processed_at: string | null }>
}

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

let _stdoutOutput = ''
let _stderrOutput = ''

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

function getStdout(): string {
  return _stdoutOutput
}
function getStderr(): string {
  return _stderrOutput
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  captureOutput()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  cleanupTempDb()
})

// ---------------------------------------------------------------------------
// Integration: Pause → Resume cycle
// ---------------------------------------------------------------------------

describe('pause → resume cycle', () => {
  it('updates session status from active to paused in DB', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-pause-resume-1'
    seedSession(db, sessionId, 'active')
    seedTask(db, 'task-1', sessionId, 'pending')

    const exitCode = await runPauseAction({ sessionId, outputFormat: 'human', projectRoot })
    expect(exitCode).toBe(0)
    expect(getSessionStatus(db, sessionId)).toBe('paused')
  })

  it('writes a pause signal to session_signals table', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-pause-resume-2'
    seedSession(db, sessionId, 'active')

    await runPauseAction({ sessionId, outputFormat: 'human', projectRoot })

    const signals = getSignals(db, sessionId)
    expect(signals).toHaveLength(1)
    expect(signals[0].signal).toBe('pause')
  })

  it('updates session status from paused to active on resume', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-pause-resume-3'
    seedSession(db, sessionId, 'active')
    seedTask(db, 'task-2', sessionId, 'pending')

    await runPauseAction({ sessionId, outputFormat: 'human', projectRoot })
    expect(getSessionStatus(db, sessionId)).toBe('paused')

    const exitCode = await runResumeAction({ sessionId, outputFormat: 'human', projectRoot })
    expect(exitCode).toBe(0)
    expect(getSessionStatus(db, sessionId)).toBe('active')
  })

  it('writes a resume signal to session_signals table after pause', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-pause-resume-4'
    seedSession(db, sessionId, 'active')

    await runPauseAction({ sessionId, outputFormat: 'human', projectRoot })
    await runResumeAction({ sessionId, outputFormat: 'human', projectRoot })

    const signals = getSignals(db, sessionId)
    expect(signals).toHaveLength(2)
    expect(signals[0].signal).toBe('pause')
    expect(signals[1].signal).toBe('resume')
  })

  it('tasks remain pending after pause (not cancelled)', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-pause-resume-5'
    seedSession(db, sessionId, 'active')
    seedTask(db, 'task-a', sessionId, 'pending')
    seedTask(db, 'task-b', sessionId, 'pending')

    await runPauseAction({ sessionId, outputFormat: 'human', projectRoot })

    expect(getTaskStatus(db, 'task-a')).toBe('pending')
    expect(getTaskStatus(db, 'task-b')).toBe('pending')
  })

  it('prints correct pending task count on resume', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-pause-resume-6'
    seedSession(db, sessionId, 'active')
    seedTask(db, 'task-p1', sessionId, 'pending')
    seedTask(db, 'task-p2', sessionId, 'pending')
    seedTask(db, 'task-done', sessionId, 'completed')

    await runPauseAction({ sessionId, outputFormat: 'human', projectRoot })
    _stdoutOutput = '' // reset after pause
    await runResumeAction({ sessionId, outputFormat: 'human', projectRoot })

    expect(getStdout()).toContain('2 tasks pending')
  })
})

// ---------------------------------------------------------------------------
// Integration: Cancel
// ---------------------------------------------------------------------------

describe('cancel command', () => {
  it('updates session status to cancelled in DB', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-cancel-1'
    seedSession(db, sessionId, 'active')

    const exitCode = await runCancelAction({
      sessionId,
      outputFormat: 'human',
      yes: true,
      projectRoot,
    })
    expect(exitCode).toBe(0)
    expect(getSessionStatus(db, sessionId)).toBe('cancelled')
  })

  it('marks pending tasks as cancelled', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-cancel-2'
    seedSession(db, sessionId, 'active')
    seedTask(db, 'task-p1', sessionId, 'pending')
    seedTask(db, 'task-p2', sessionId, 'pending')

    await runCancelAction({ sessionId, outputFormat: 'human', yes: true, projectRoot })

    expect(getTaskStatus(db, 'task-p1')).toBe('cancelled')
    expect(getTaskStatus(db, 'task-p2')).toBe('cancelled')
  })

  it('marks running tasks as cancelled', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-cancel-3'
    seedSession(db, sessionId, 'active')
    seedTask(db, 'task-r1', sessionId, 'running')

    await runCancelAction({ sessionId, outputFormat: 'human', yes: true, projectRoot })

    expect(getTaskStatus(db, 'task-r1')).toBe('cancelled')
  })

  it('does not cancel already-completed tasks', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-cancel-4'
    seedSession(db, sessionId, 'active')
    seedTask(db, 'task-done', sessionId, 'completed')
    seedTask(db, 'task-pend', sessionId, 'pending')

    await runCancelAction({ sessionId, outputFormat: 'human', yes: true, projectRoot })

    expect(getTaskStatus(db, 'task-done')).toBe('completed')
    expect(getTaskStatus(db, 'task-pend')).toBe('cancelled')
  })

  it('writes a cancel signal to session_signals table', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-cancel-5'
    seedSession(db, sessionId, 'active')

    await runCancelAction({ sessionId, outputFormat: 'human', yes: true, projectRoot })

    const signals = getSignals(db, sessionId)
    expect(signals).toHaveLength(1)
    expect(signals[0].signal).toBe('cancel')
  })

  it('can cancel a paused session', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-cancel-6'
    seedSession(db, sessionId, 'active')

    await runPauseAction({ sessionId, outputFormat: 'human', projectRoot })
    expect(getSessionStatus(db, sessionId)).toBe('paused')

    const exitCode = await runCancelAction({
      sessionId,
      outputFormat: 'human',
      yes: true,
      projectRoot,
    })
    expect(exitCode).toBe(0)
    expect(getSessionStatus(db, sessionId)).toBe('cancelled')
  })

  it('returns exit code 2 for already-cancelled session', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-cancel-7'
    seedSession(db, sessionId, 'cancelled')

    const exitCode = await runCancelAction({
      sessionId,
      outputFormat: 'human',
      yes: true,
      projectRoot,
    })
    expect(exitCode).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Integration: Session not found
// ---------------------------------------------------------------------------

describe('session not found', () => {
  it('pause returns exit 2 and writes to stderr for missing session', async () => {
    const { projectRoot } = createTempDb()

    const exitCode = await runPauseAction({
      sessionId: 'nonexistent',
      outputFormat: 'human',
      projectRoot,
    })
    expect(exitCode).toBe(2)
    expect(getStderr()).toContain('Session not found: nonexistent')
  })

  it('resume returns exit 2 and writes to stderr for missing session', async () => {
    const { projectRoot } = createTempDb()

    const exitCode = await runResumeAction({
      sessionId: 'nonexistent',
      outputFormat: 'human',
      projectRoot,
    })
    expect(exitCode).toBe(2)
    expect(getStderr()).toContain('Session not found: nonexistent')
  })

  it('cancel returns exit 2 and writes to stderr for missing session', async () => {
    const { projectRoot } = createTempDb()

    const exitCode = await runCancelAction({
      sessionId: 'nonexistent',
      outputFormat: 'human',
      yes: true,
      projectRoot,
    })
    expect(exitCode).toBe(2)
    expect(getStderr()).toContain('Session not found: nonexistent')
  })
})

// ---------------------------------------------------------------------------
// Integration: JSON output format
// ---------------------------------------------------------------------------

describe('JSON output format', () => {
  it('pause emits valid NDJSON line', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-json-pause'
    seedSession(db, sessionId, 'active')

    await runPauseAction({ sessionId, outputFormat: 'json', projectRoot })

    const lines = getStdout().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]) as {
      event: string
      data: { sessionId: string; newStatus: string }
    }
    expect(parsed.event).toBe('session:pause')
    expect(parsed.data.sessionId).toBe(sessionId)
    expect(parsed.data.newStatus).toBe('paused')
  })

  it('resume emits valid NDJSON line', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-json-resume'
    seedSession(db, sessionId, 'paused')

    await runResumeAction({ sessionId, outputFormat: 'json', projectRoot })

    const lines = getStdout().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]) as {
      event: string
      data: { sessionId: string; newStatus: string }
    }
    expect(parsed.event).toBe('session:resume')
    expect(parsed.data.newStatus).toBe('active')
  })

  it('cancel emits valid NDJSON line', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-json-cancel'
    seedSession(db, sessionId, 'active')

    await runCancelAction({ sessionId, outputFormat: 'json', yes: true, projectRoot })

    const lines = getStdout().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]) as {
      event: string
      data: { sessionId: string; newStatus: string }
    }
    expect(parsed.event).toBe('session:cancel')
    expect(parsed.data.newStatus).toBe('cancelled')
  })
})
