/**
 * Tests for task query functions.
 *
 * Uses an in-memory SQLite database with migrations applied.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../src/persistence/migrations/index.js'
import {
  createTask,
  getTask,
  getTasksByStatus,
  getReadyTasks,
  updateTaskStatus,
  type CreateTaskInput,
} from '../../../src/persistence/queries/tasks.js'
import { createSession } from '../../../src/persistence/queries/sessions.js'

function openMemoryDb(): BetterSqlite3Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

function makeSession(id: string) {
  return { id, graph_file: 'test.yaml', status: 'active' }
}

function makeTask(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    id: `task-${Math.random().toString(36).slice(2)}`,
    session_id: 'sess-1',
    name: 'Test task',
    prompt: 'Do something',
    status: 'pending',
    ...overrides,
  }
}

describe('tasks queries', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMemoryDb()
    createSession(db, makeSession('sess-1'))
  })

  afterEach(() => {
    db.close()
  })

  describe('createTask', () => {
    it('inserts a task and can be retrieved', () => {
      const task = makeTask({ id: 'task-001' })
      createTask(db, task)
      const found = getTask(db, 'task-001')
      expect(found).toBeDefined()
      expect(found?.id).toBe('task-001')
      expect(found?.name).toBe('Test task')
      expect(found?.status).toBe('pending')
    })

    it('applies default values for optional fields', () => {
      const task = makeTask({ id: 'task-defaults' })
      createTask(db, task)
      const found = getTask(db, 'task-defaults')!
      expect(found.cost_usd).toBe(0.0)
      expect(found.input_tokens).toBe(0)
      expect(found.output_tokens).toBe(0)
      expect(found.retry_count).toBe(0)
      expect(found.max_retries).toBe(2)
    })
  })

  describe('getTask', () => {
    it('returns undefined for a missing task id', () => {
      const result = getTask(db, 'nonexistent')
      expect(result).toBeUndefined()
    })
  })

  describe('getTasksByStatus', () => {
    it('returns tasks matching the given status', () => {
      createTask(db, makeTask({ id: 'task-p1', status: 'pending' }))
      createTask(db, makeTask({ id: 'task-p2', status: 'pending' }))
      createTask(db, makeTask({ id: 'task-r1', status: 'running' }))

      const pending = getTasksByStatus(db, 'sess-1', 'pending')
      expect(pending.length).toBe(2)
      expect(pending.every((t) => t.status === 'pending')).toBe(true)

      const running = getTasksByStatus(db, 'sess-1', 'running')
      expect(running.length).toBe(1)
    })

    it('returns empty array when no tasks match', () => {
      const result = getTasksByStatus(db, 'sess-1', 'completed')
      expect(result).toEqual([])
    })
  })

  describe('getReadyTasks', () => {
    it('returns pending tasks with no unmet dependencies', () => {
      createTask(db, makeTask({ id: 'ready-task', status: 'pending' }))
      const ready = getReadyTasks(db, 'sess-1')
      expect(ready.length).toBe(1)
      expect(ready[0].id).toBe('ready-task')
    })

    it('excludes tasks with incomplete dependencies', () => {
      createTask(db, makeTask({ id: 'parent-task', status: 'pending' }))
      createTask(db, makeTask({ id: 'child-task', status: 'pending' }))

      // child-task depends on parent-task (which is not 'completed')
      db.prepare(
        'INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)',
      ).run('child-task', 'parent-task')

      const ready = getReadyTasks(db, 'sess-1')
      // Only parent-task should be ready; child-task has a pending dependency
      const readyIds = ready.map((t) => t.id)
      expect(readyIds).toContain('parent-task')
      expect(readyIds).not.toContain('child-task')
    })

    it('includes tasks after their dependency is completed', () => {
      createTask(db, makeTask({ id: 'dep-parent', status: 'completed' }))
      createTask(db, makeTask({ id: 'dep-child', status: 'pending' }))

      db.prepare(
        'INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)',
      ).run('dep-child', 'dep-parent')

      const ready = getReadyTasks(db, 'sess-1')
      const readyIds = ready.map((t) => t.id)
      expect(readyIds).toContain('dep-child')
    })

    it('includes tasks whose only dependency is cancelled', () => {
      createTask(db, makeTask({ id: 'cancelled-parent', status: 'cancelled' }))
      createTask(db, makeTask({ id: 'cancelled-child', status: 'pending' }))

      db.prepare(
        'INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)',
      ).run('cancelled-child', 'cancelled-parent')

      const ready = getReadyTasks(db, 'sess-1')
      const readyIds = ready.map((t) => t.id)
      expect(readyIds).toContain('cancelled-child')
    })
  })

  describe('updateTaskStatus', () => {
    it('updates task status', () => {
      createTask(db, makeTask({ id: 'upd-task', status: 'pending' }))
      updateTaskStatus(db, 'upd-task', 'running')
      const task = getTask(db, 'upd-task')!
      expect(task.status).toBe('running')
    })

    it('updates optional extra fields', () => {
      createTask(db, makeTask({ id: 'extra-task', status: 'running' }))
      updateTaskStatus(db, 'extra-task', 'completed', {
        result: '{"success":true}',
        cost_usd: 0.05,
        input_tokens: 1000,
        output_tokens: 500,
        completed_at: '2026-01-01T00:00:00',
      })
      const task = getTask(db, 'extra-task')!
      expect(task.status).toBe('completed')
      expect(task.result).toBe('{"success":true}')
      expect(task.cost_usd).toBe(0.05)
      expect(task.input_tokens).toBe(1000)
      expect(task.output_tokens).toBe(500)
      expect(task.completed_at).toBe('2026-01-01T00:00:00')
    })
  })
})
