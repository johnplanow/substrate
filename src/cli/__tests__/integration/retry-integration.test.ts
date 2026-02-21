/**
 * Integration tests for the `substrate retry` command.
 *
 * Uses a real temporary SQLite database to test the full pipeline:
 *   - dry-run: error report generated, no DB changes
 *   - normal retry: failed tasks reset to pending, retry_count incremented
 *   - resume signal written to session_signals table
 *   - max-retries safety guard skips over-retried tasks
 *   - --task flag with dependency validation
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
import { runRetryAction } from '../../commands/retry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _tmpDir: string

function createTempDb(): { dbPath: string; db: BetterSqlite3Database; projectRoot: string } {
  _tmpDir = join(tmpdir(), `substrate-retry-test-${randomUUID()}`)
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
  status = 'active',
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
  opts: {
    status: string
    agent?: string
    error?: string | null
    exitCode?: number | null
    retryCount?: number
  },
): void {
  createTask(db, {
    id: taskId,
    session_id: sessionId,
    name: `Task ${taskId}`,
    prompt: 'do something',
    status: opts.status,
    agent: opts.agent ?? 'claude',
    error: opts.error ?? null,
    exit_code: opts.exitCode ?? null,
    retry_count: opts.retryCount ?? 0,
    started_at: opts.status === 'running' ? new Date(Date.now() - 3000).toISOString() : null,
    completed_at: ['completed', 'failed'].includes(opts.status) ? new Date().toISOString() : null,
  })
}

function seedDependency(
  db: BetterSqlite3Database,
  taskId: string,
  dependsOnId: string,
): void {
  db.prepare(
    'INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)',
  ).run(taskId, dependsOnId)
}

function getTaskStatus(db: BetterSqlite3Database, taskId: string): string | undefined {
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as
    | { status: string }
    | undefined
  return row?.status
}

function getTaskRetryCount(db: BetterSqlite3Database, taskId: string): number {
  const row = db.prepare('SELECT retry_count FROM tasks WHERE id = ?').get(taskId) as
    | { retry_count: number }
    | undefined
  return row?.retry_count ?? 0
}

function getTaskError(db: BetterSqlite3Database, taskId: string): string | null {
  const row = db.prepare('SELECT error FROM tasks WHERE id = ?').get(taskId) as
    | { error: string | null }
    | undefined
  return row?.error ?? null
}

function getSignals(
  db: BetterSqlite3Database,
  sessionId: string,
): Array<{ signal: string }> {
  return db
    .prepare('SELECT signal FROM session_signals WHERE session_id = ?')
    .all(sessionId) as Array<{ signal: string }>
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

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

beforeEach(() => {
  captureOutput()
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanupTempDb()
})

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('retry integration: dry-run mode', () => {
  it('generates error report without modifying task status', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-int-1'

    seedSession(db, sessionId)
    seedTask(db, 'task-a', sessionId, {
      status: 'failed',
      agent: 'claude',
      error: 'timeout exceeded',
      exitCode: 1,
    })
    seedTask(db, 'task-b', sessionId, {
      status: 'failed',
      agent: 'codex',
      error: 'Budget exceeded: task cost $0.06 exceeded limit $0.05',
    })
    seedTask(db, 'task-c', sessionId, { status: 'completed' })

    // Close the seeding connection so the command can open it
    db.close()

    const exitCode = await runRetryAction({
      sessionId,
      dryRun: true,
      follow: false,
      outputFormat: 'human',
      maxRetries: 3,
      projectRoot,
    })

    // Exit 0 for dry-run
    expect(exitCode).toBe(0)

    // Open fresh DB to verify no changes
    const verifyDb = new BetterSqlite3(join(projectRoot, '.substrate', 'state.db'))
    expect(getTaskStatus(verifyDb, 'task-a')).toBe('failed')
    expect(getTaskStatus(verifyDb, 'task-b')).toBe('failed')
    expect(getTaskStatus(verifyDb, 'task-c')).toBe('completed')
    expect(getSignals(verifyDb, sessionId)).toHaveLength(0)
    verifyDb.close()

    // Output contains report
    expect(getStdout()).toContain('Failed Tasks in Session sess-int-1')
    expect(getStdout()).toContain('task-a')
    expect(getStdout()).toContain('task-b')
  })

  it('renders NDJSON output in json dry-run mode', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-int-json'

    seedSession(db, sessionId)
    seedTask(db, 'task-x', sessionId, { status: 'failed', agent: 'claude', error: 'crash' })
    db.close()

    const exitCode = await runRetryAction({
      sessionId,
      dryRun: true,
      follow: false,
      outputFormat: 'json',
      maxRetries: 3,
      projectRoot,
    })

    expect(exitCode).toBe(0)

    const lines = getStdout().trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.event).toBe('task:failed:detail')
    expect(parsed.data.taskId).toBe('task-x')
    expect(parsed.data.agent).toBe('claude')
  })
})

describe('retry integration: normal retry (no --follow)', () => {
  it('resets failed tasks to pending and increments retry_count', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-int-2'

    seedSession(db, sessionId)
    seedTask(db, 'task-a', sessionId, {
      status: 'failed',
      error: 'timeout',
      exitCode: 1,
      retryCount: 1,
    })
    seedTask(db, 'task-b', sessionId, {
      status: 'failed',
      error: 'oom',
      retryCount: 0,
    })
    seedTask(db, 'task-c', sessionId, { status: 'completed' })
    db.close()

    const exitCode = await runRetryAction({
      sessionId,
      dryRun: false,
      follow: false,
      outputFormat: 'human',
      maxRetries: 3,
      projectRoot,
    })

    expect(exitCode).toBe(0)

    const verifyDb = new BetterSqlite3(join(projectRoot, '.substrate', 'state.db'))

    // Failed tasks reset to pending
    expect(getTaskStatus(verifyDb, 'task-a')).toBe('pending')
    expect(getTaskStatus(verifyDb, 'task-b')).toBe('pending')

    // retry_count incremented
    expect(getTaskRetryCount(verifyDb, 'task-a')).toBe(2)
    expect(getTaskRetryCount(verifyDb, 'task-b')).toBe(1)

    // error cleared
    expect(getTaskError(verifyDb, 'task-a')).toBeNull()
    expect(getTaskError(verifyDb, 'task-b')).toBeNull()

    // completed task untouched
    expect(getTaskStatus(verifyDb, 'task-c')).toBe('completed')

    verifyDb.close()
  })

  it('writes resume signal to session_signals table', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-int-signal'

    seedSession(db, sessionId)
    seedTask(db, 'task-a', sessionId, { status: 'failed' })
    db.close()

    await runRetryAction({
      sessionId,
      dryRun: false,
      follow: false,
      outputFormat: 'human',
      maxRetries: 3,
      projectRoot,
    })

    const verifyDb = new BetterSqlite3(join(projectRoot, '.substrate', 'state.db'))
    const signals = getSignals(verifyDb, sessionId)
    expect(signals).toHaveLength(1)
    expect(signals[0].signal).toBe('resume')
    verifyDb.close()
  })

  it('prints correct "Retrying N failed tasks" message', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-int-msg'

    seedSession(db, sessionId)
    seedTask(db, 'task-a', sessionId, { status: 'failed' })
    seedTask(db, 'task-b', sessionId, { status: 'failed' })
    db.close()

    await runRetryAction({
      sessionId,
      dryRun: false,
      follow: false,
      outputFormat: 'human',
      maxRetries: 3,
      projectRoot,
    })

    expect(getStdout()).toContain('Retrying 2 failed tasks in session sess-int-msg')
  })
})

describe('retry integration: max-retries guard', () => {
  it('skips tasks that have exceeded max-retries', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-int-maxretry'

    seedSession(db, sessionId)
    seedTask(db, 'task-overretried', sessionId, {
      status: 'failed',
      retryCount: 3,
    })
    seedTask(db, 'task-eligible', sessionId, {
      status: 'failed',
      retryCount: 1,
    })
    db.close()

    const exitCode = await runRetryAction({
      sessionId,
      dryRun: false,
      follow: false,
      outputFormat: 'human',
      maxRetries: 3,
      projectRoot,
    })

    expect(exitCode).toBe(0)

    const verifyDb = new BetterSqlite3(join(projectRoot, '.substrate', 'state.db'))
    expect(getTaskStatus(verifyDb, 'task-overretried')).toBe('failed')
    expect(getTaskStatus(verifyDb, 'task-eligible')).toBe('pending')
    verifyDb.close()

    expect(getStdout()).toContain('1 task(s) skipped (exceeded max-retries of 3)')
  })
})

describe('retry integration: --task flag', () => {
  it('resets only the specified task', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-int-task'

    seedSession(db, sessionId)
    seedTask(db, 'task-dep', sessionId, { status: 'completed' })
    seedTask(db, 'task-a', sessionId, { status: 'failed' })
    seedTask(db, 'task-b', sessionId, { status: 'failed' })
    seedDependency(db, 'task-a', 'task-dep')
    db.close()

    const exitCode = await runRetryAction({
      sessionId,
      taskId: 'task-a',
      dryRun: false,
      follow: false,
      outputFormat: 'human',
      maxRetries: 3,
      projectRoot,
    })

    expect(exitCode).toBe(0)

    const verifyDb = new BetterSqlite3(join(projectRoot, '.substrate', 'state.db'))
    expect(getTaskStatus(verifyDb, 'task-a')).toBe('pending')
    expect(getTaskStatus(verifyDb, 'task-b')).toBe('failed')
    verifyDb.close()
  })

  it('returns exit 2 when dependency is not completed', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-int-dep-fail'

    seedSession(db, sessionId)
    seedTask(db, 'task-dep', sessionId, { status: 'pending' })
    seedTask(db, 'task-a', sessionId, { status: 'failed' })
    seedDependency(db, 'task-a', 'task-dep')
    db.close()

    const exitCode = await runRetryAction({
      sessionId,
      taskId: 'task-a',
      dryRun: false,
      follow: false,
      outputFormat: 'human',
      maxRetries: 3,
      projectRoot,
    })

    expect(exitCode).toBe(2)
    expect(getStderr()).toContain('Cannot retry task task-a')
    expect(getStderr()).toContain('task-dep')
  })
})

describe('retry integration: session not found', () => {
  it('returns exit 2 when session does not exist', async () => {
    const { db, projectRoot } = createTempDb()
    db.close()

    const exitCode = await runRetryAction({
      sessionId: 'nonexistent-session',
      dryRun: false,
      follow: false,
      outputFormat: 'human',
      maxRetries: 3,
      projectRoot,
    })

    expect(exitCode).toBe(2)
    expect(getStderr()).toContain('Error: Session not found: nonexistent-session')
  })

  it('returns exit 0 when session has no failed tasks', async () => {
    const { db, projectRoot } = createTempDb()
    const sessionId = 'sess-int-nofail'

    seedSession(db, sessionId)
    seedTask(db, 'task-a', sessionId, { status: 'completed' })
    db.close()

    const exitCode = await runRetryAction({
      sessionId,
      dryRun: false,
      follow: false,
      outputFormat: 'human',
      maxRetries: 3,
      projectRoot,
    })

    expect(exitCode).toBe(0)
    expect(getStdout()).toContain(`No failed tasks found in session ${sessionId}`)
  })
})
