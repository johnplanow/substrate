/**
 * Integration tests for CrashRecoveryManager
 *
 * Uses a real temp SQLite database to validate the full recovery flow.
 *
 * Tests:
 *  - AC1: Retryable task reset to pending with retry_count incremented
 *  - AC1: Over-limit task set to failed
 *  - AC2: Completed task remains completed
 *  - RecoveryResult counters are correct
 *  - findInterruptedSession returns an interrupted session
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { CrashRecoveryManager } from '../../recovery/crash-recovery.js'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertSession(db: BetterSqlite3Database, id: string, status = 'active'): void {
  db.prepare(`
    INSERT INTO sessions (id, graph_file, status)
    VALUES (?, 'test.yaml', ?)
  `).run(id, status)
}

function insertTask(
  db: BetterSqlite3Database,
  id: string,
  sessionId: string,
  status: string,
  retryCount = 0,
  maxRetries = 2,
): void {
  db.prepare(`
    INSERT INTO tasks (id, session_id, name, prompt, status, retry_count, max_retries)
    VALUES (?, ?, ?, 'test prompt', ?, ?, ?)
  `).run(id, sessionId, `Task ${id}`, status, retryCount, maxRetries)
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('CrashRecoveryManager — integration', () => {
  let tmpDir: string
  let db: BetterSqlite3Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'substrate-test-'))
    const dbPath = join(tmpDir, 'state.db')
    const wrapper = new DatabaseWrapper(dbPath)
    wrapper.open()
    runMigrations(wrapper.db)
    db = wrapper.db
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // Already closed
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  it('AC1: retryable running task reset to pending with retry_count incremented', () => {
    insertSession(db, 'int-sess-1')
    insertTask(db, 'task-retryable', 'int-sess-1', 'running', 0, 2)

    const manager = new CrashRecoveryManager({ db })
    const result = manager.recover('int-sess-1')

    expect(result.recovered).toBe(1)
    expect(result.failed).toBe(0)

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-retryable') as {
      status: string
      retry_count: number
      worker_id: string | null
    }
    expect(task.status).toBe('pending')
    expect(task.retry_count).toBe(1)
    expect(task.worker_id).toBeNull()
  })

  it('AC1: over-limit running task set to failed with error message', () => {
    insertSession(db, 'int-sess-2')
    insertTask(db, 'task-exhausted', 'int-sess-2', 'running', 2, 2)

    const manager = new CrashRecoveryManager({ db })
    const result = manager.recover('int-sess-2')

    expect(result.recovered).toBe(0)
    expect(result.failed).toBe(1)

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-exhausted') as {
      status: string
      error: string | null
      worker_id: string | null
    }
    expect(task.status).toBe('failed')
    expect(task.error).toBe('Process crashed and max retries exceeded')
    expect(task.worker_id).toBeNull()
  })

  it('AC2: completed task remains completed after recovery', () => {
    insertSession(db, 'int-sess-3')
    insertTask(db, 'task-done', 'int-sess-3', 'completed', 0, 2)

    const manager = new CrashRecoveryManager({ db })
    const result = manager.recover('int-sess-3')

    expect(result.recovered).toBe(0)
    expect(result.failed).toBe(0)

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-done') as {
      status: string
    }
    expect(task.status).toBe('completed')
  })

  it('full scenario: 3 tasks - 1 retryable, 1 exhausted, 1 completed', () => {
    insertSession(db, 'int-sess-4')
    insertTask(db, 'task-retry', 'int-sess-4', 'running', 1, 2)   // retryable
    insertTask(db, 'task-fail', 'int-sess-4', 'running', 2, 2)    // exhausted
    insertTask(db, 'task-comp', 'int-sess-4', 'completed', 0, 2)  // completed

    const manager = new CrashRecoveryManager({ db })
    const result = manager.recover('int-sess-4')

    expect(result.recovered).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.actions).toHaveLength(2)

    const retryTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-retry') as { status: string; retry_count: number }
    expect(retryTask.status).toBe('pending')
    expect(retryTask.retry_count).toBe(2)

    const failTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-fail') as { status: string }
    expect(failTask.status).toBe('failed')

    const compTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-comp') as { status: string }
    expect(compTask.status).toBe('completed')
  })

  it('findInterruptedSession returns an interrupted session', () => {
    insertSession(db, 'int-sess-interrupted', 'interrupted')

    const session = CrashRecoveryManager.findInterruptedSession(db)

    expect(session).toBeDefined()
    expect(session!.id).toBe('int-sess-interrupted')
    expect(session!.status).toBe('interrupted')
  })

  it('findInterruptedSession returns undefined when no interrupted sessions', () => {
    insertSession(db, 'int-sess-active', 'active')

    const session = CrashRecoveryManager.findInterruptedSession(db)
    expect(session).toBeUndefined()
  })

  it('archiveSession sets status to abandoned', () => {
    insertSession(db, 'int-sess-to-archive', 'interrupted')

    CrashRecoveryManager.archiveSession(db, 'int-sess-to-archive')

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('int-sess-to-archive') as {
      status: string
    }
    expect(session.status).toBe('abandoned')
  })

  it('recovery works with retry_count=1, max_retries=2 (still retryable)', () => {
    insertSession(db, 'int-sess-5')
    insertTask(db, 'task-mid', 'int-sess-5', 'running', 1, 2)

    const manager = new CrashRecoveryManager({ db })
    const result = manager.recover('int-sess-5')

    expect(result.recovered).toBe(1)
    expect(result.failed).toBe(0)

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-mid') as {
      retry_count: number
    }
    expect(task.retry_count).toBe(2)
  })

  it('newlyReady count matches tasks with all dependencies completed', () => {
    insertSession(db, 'int-sess-6')
    // dep-task completed, so main-task (pending) should become ready
    insertTask(db, 'dep-task', 'int-sess-6', 'completed', 0, 2)
    insertTask(db, 'main-task', 'int-sess-6', 'pending', 0, 2)
    db.prepare('INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)').run('main-task', 'dep-task')
    // also add a running task that will be reset to pending
    insertTask(db, 'crash-task', 'int-sess-6', 'running', 0, 2)

    const manager = new CrashRecoveryManager({ db })
    const result = manager.recover('int-sess-6')

    // crash-task -> pending (no deps -> ready), main-task already pending (dep completed -> ready)
    expect(result.recovered).toBe(1)
    expect(result.newlyReady).toBeGreaterThanOrEqual(1)
  })
})
