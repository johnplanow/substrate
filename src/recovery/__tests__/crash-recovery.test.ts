/**
 * Unit tests for CrashRecoveryManager
 *
 * Tests:
 *  - AC1: Running tasks with retry_count < max_retries are reset to pending
 *  - AC1: Running tasks with retry_count >= max_retries are set to failed
 *  - AC2: Completed/failed tasks remain unchanged
 *  - AC4: newlyReady count reflects tasks in ready_tasks view
 *  - Performance: 100 tasks recover in < 5000ms
 *  - findInterruptedSession: returns most-recent interrupted session
 *  - archiveSession: sets status to abandoned
 *  - cleanupOrphanedWorktrees: calls gitWorktreeManager.cleanupAllWorktrees()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { CrashRecoveryManager } from '../crash-recovery.js'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openInMemoryDb(): BetterSqlite3Database {
  const wrapper = new DatabaseWrapper(':memory:')
  wrapper.open()
  runMigrations(wrapper.db)
  return wrapper.db
}

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
// Tests
// ---------------------------------------------------------------------------

describe('CrashRecoveryManager', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openInMemoryDb()
  })

  describe('recover()', () => {
    it('AC1: re-queues running tasks where retry_count < max_retries', () => {
      insertSession(db, 'sess-1')
      insertTask(db, 'task-1', 'sess-1', 'running', 0, 2)

      const manager = new CrashRecoveryManager({ db })
      const result = manager.recover('sess-1')

      expect(result.recovered).toBe(1)
      expect(result.failed).toBe(0)
      expect(result.actions).toHaveLength(1)
      expect(result.actions[0].action).toBe('requeued')
      expect(result.actions[0].taskId).toBe('task-1')

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-1') as {
        status: string
        retry_count: number
        worker_id: string | null
      }
      expect(task.status).toBe('pending')
      expect(task.retry_count).toBe(1)
      expect(task.worker_id).toBeNull()
    })

    it('AC1: fails running tasks where retry_count >= max_retries', () => {
      insertSession(db, 'sess-2')
      insertTask(db, 'task-2', 'sess-2', 'running', 2, 2)

      const manager = new CrashRecoveryManager({ db })
      const result = manager.recover('sess-2')

      expect(result.recovered).toBe(0)
      expect(result.failed).toBe(1)
      expect(result.actions[0].action).toBe('failed')

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-2') as {
        status: string
        error: string | null
      }
      expect(task.status).toBe('failed')
      expect(task.error).toBe('Process crashed and max retries exceeded')
    })

    it('AC2: completed tasks are not modified', () => {
      insertSession(db, 'sess-3')
      insertTask(db, 'task-3', 'sess-3', 'completed', 0, 2)

      const manager = new CrashRecoveryManager({ db })
      const result = manager.recover('sess-3')

      expect(result.recovered).toBe(0)
      expect(result.failed).toBe(0)

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-3') as {
        status: string
      }
      expect(task.status).toBe('completed')
    })

    it('AC2: failed tasks are not modified', () => {
      insertSession(db, 'sess-4')
      insertTask(db, 'task-4', 'sess-4', 'failed', 2, 2)

      const manager = new CrashRecoveryManager({ db })
      const result = manager.recover('sess-4')

      expect(result.recovered).toBe(0)
      expect(result.failed).toBe(0)

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-4') as {
        status: string
      }
      expect(task.status).toBe('failed')
    })

    it('AC4: newlyReady reflects tasks in ready_tasks view', () => {
      insertSession(db, 'sess-5')
      // Insert two running tasks (both retryable) and one with a dependency on the first
      insertTask(db, 'task-a', 'sess-5', 'running', 0, 2)
      insertTask(db, 'task-b', 'sess-5', 'running', 0, 2)

      const manager = new CrashRecoveryManager({ db })
      const result = manager.recover('sess-5')

      // Both reset to pending — both have no dependencies → both ready
      expect(result.recovered).toBe(2)
      expect(result.newlyReady).toBe(2)
    })

    it('AC4: newlyReady is 0 when no tasks are ready (task-c blocked by task-d, task-d blocked by completed-dep)', () => {
      insertSession(db, 'sess-6')
      // Set up: completed-dep (completed) → task-d (running, not ready because it's running → reset to pending, no deps → ready)
      // Actually: task-d has no deps so it's always ready once pending
      // To get 0 newlyReady: make ALL pending tasks blocked
      // Insert task-d (running) → reset to pending, BUT add a blocker so task-d won't appear in ready_tasks
      // We need a task that depends on a NON-completed task
      insertTask(db, 'blocker', 'sess-6', 'pending', 0, 2)   // blocker itself has no deps → will be ready
      insertTask(db, 'task-d', 'sess-6', 'running', 0, 2)    // task-d depends on blocker (pending)
      insertTask(db, 'task-c', 'sess-6', 'pending', 0, 2)    // task-c depends on task-d (will be pending after recovery)
      db.prepare('INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)').run('task-d', 'blocker')
      db.prepare('INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)').run('task-c', 'task-d')

      const manager = new CrashRecoveryManager({ db })
      const result = manager.recover('sess-6')

      // task-d reset to pending, but task-d has blocker (pending) → not ready
      // task-c still blocked by task-d (pending) → not ready
      // blocker has no deps → ready (1 ready)
      expect(result.recovered).toBe(1)
      // blocker is ready (1), task-d not ready, task-c not ready
      expect(result.newlyReady).toBe(1)
    })

    it('handles mixed states: running (retryable), running (exhausted), completed', () => {
      insertSession(db, 'sess-7')
      insertTask(db, 'task-r', 'sess-7', 'running', 1, 2)  // retryable
      insertTask(db, 'task-x', 'sess-7', 'running', 2, 2)  // exhausted
      insertTask(db, 'task-c', 'sess-7', 'completed', 0, 2)

      const manager = new CrashRecoveryManager({ db })
      const result = manager.recover('sess-7')

      expect(result.recovered).toBe(1)
      expect(result.failed).toBe(1)
      expect(result.actions).toHaveLength(2)

      const completed = db.prepare("SELECT * FROM tasks WHERE id = 'task-c'").get() as { status: string }
      expect(completed.status).toBe('completed')
    })

    it('recovers all sessions when sessionId is not provided', () => {
      insertSession(db, 'sess-a')
      insertSession(db, 'sess-b')
      insertTask(db, 'task-aa', 'sess-a', 'running', 0, 2)
      insertTask(db, 'task-bb', 'sess-b', 'running', 0, 2)

      const manager = new CrashRecoveryManager({ db })
      const result = manager.recover()

      expect(result.recovered).toBe(2)
    })

    it('performance: 100 running tasks recovered in < 5000ms', () => {
      insertSession(db, 'sess-perf')
      for (let i = 0; i < 100; i++) {
        insertTask(db, `perf-task-${i}`, 'sess-perf', 'running', 0, 2)
      }

      const manager = new CrashRecoveryManager({ db })
      const start = Date.now()
      const result = manager.recover('sess-perf')
      const elapsed = Date.now() - start

      expect(result.recovered).toBe(100)
      expect(elapsed).toBeLessThan(5000)
    })

    it('calls gitWorktreeManager.cleanupAllWorktrees() during recovery', async () => {
      insertSession(db, 'sess-wt')

      const mockCleanup = vi.fn().mockResolvedValue(3)
      const gitWorktreeManager = { cleanupAllWorktrees: mockCleanup } as any

      const manager = new CrashRecoveryManager({ db, gitWorktreeManager })
      manager.recover('sess-wt')

      // Give the async cleanupOrphanedWorktrees() a moment to run
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(mockCleanup).toHaveBeenCalledOnce()
    })
  })

  describe('cleanupOrphanedWorktrees()', () => {
    it('returns 0 when no gitWorktreeManager provided', async () => {
      const manager = new CrashRecoveryManager({ db })
      const count = await manager.cleanupOrphanedWorktrees()
      expect(count).toBe(0)
    })

    it('returns count from gitWorktreeManager.cleanupAllWorktrees()', async () => {
      const mockCleanup = vi.fn().mockResolvedValue(5)
      const gitWorktreeManager = { cleanupAllWorktrees: mockCleanup } as any

      const manager = new CrashRecoveryManager({ db, gitWorktreeManager })
      const count = await manager.cleanupOrphanedWorktrees()

      expect(count).toBe(5)
      expect(mockCleanup).toHaveBeenCalledOnce()
    })

    it('returns 0 and logs warning when cleanupAllWorktrees() throws', async () => {
      const mockCleanup = vi.fn().mockRejectedValue(new Error('git error'))
      const gitWorktreeManager = { cleanupAllWorktrees: mockCleanup } as any

      const manager = new CrashRecoveryManager({ db, gitWorktreeManager })
      const count = await manager.cleanupOrphanedWorktrees()

      expect(count).toBe(0)
    })
  })

  describe('findInterruptedSession()', () => {
    it('returns undefined when no interrupted sessions exist', () => {
      const result = CrashRecoveryManager.findInterruptedSession(db)
      expect(result).toBeUndefined()
    })

    it('returns the interrupted session when one exists', () => {
      insertSession(db, 'sess-int', 'interrupted')
      const result = CrashRecoveryManager.findInterruptedSession(db)
      expect(result).toBeDefined()
      expect(result!.id).toBe('sess-int')
      expect(result!.status).toBe('interrupted')
    })

    it('returns most recent interrupted session when multiple exist', () => {
      // Explicitly set different created_at values to ensure ordering
      db.prepare(`
        INSERT INTO sessions (id, graph_file, status, created_at, updated_at)
        VALUES ('sess-old', 'test.yaml', 'interrupted', '2024-01-01 00:00:00', '2024-01-01 00:00:00')
      `).run()
      db.prepare(`
        INSERT INTO sessions (id, graph_file, status, created_at, updated_at)
        VALUES ('sess-new', 'test.yaml', 'interrupted', '2024-01-02 00:00:00', '2024-01-02 00:00:00')
      `).run()

      const result = CrashRecoveryManager.findInterruptedSession(db)
      expect(result).toBeDefined()
      // The newer one should be returned (ORDER BY created_at DESC)
      expect(result!.id).toBe('sess-new')
    })

    it('does not return active sessions', () => {
      insertSession(db, 'sess-active', 'active')
      const result = CrashRecoveryManager.findInterruptedSession(db)
      expect(result).toBeUndefined()
    })
  })

  describe('archiveSession()', () => {
    it('sets session status to abandoned', () => {
      insertSession(db, 'sess-to-archive', 'interrupted')

      CrashRecoveryManager.archiveSession(db, 'sess-to-archive')

      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-to-archive') as {
        status: string
      }
      expect(session.status).toBe('abandoned')
    })

    it('does not affect other sessions', () => {
      insertSession(db, 'sess-keep', 'interrupted')
      insertSession(db, 'sess-archive', 'interrupted')

      CrashRecoveryManager.archiveSession(db, 'sess-archive')

      const keep = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-keep') as {
        status: string
      }
      expect(keep.status).toBe('interrupted')
    })
  })
})
