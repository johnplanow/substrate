/**
 * Tests for execution log query functions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../src/persistence/migrations/index.js'
import {
  appendLog,
  getSessionLog,
  getTaskLog,
} from '../../../src/persistence/queries/log.js'
import { createSession } from '../../../src/persistence/queries/sessions.js'
import { createTask } from '../../../src/persistence/queries/tasks.js'

function openMemoryDb(): BetterSqlite3Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

describe('log queries', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMemoryDb()
    createSession(db, { id: 'sess-log', graph_file: 'test.yaml', status: 'active' })
    createTask(db, {
      id: 'task-log-1',
      session_id: 'sess-log',
      name: 'Log task 1',
      prompt: 'p',
      status: 'running',
    })
    createTask(db, {
      id: 'task-log-2',
      session_id: 'sess-log',
      name: 'Log task 2',
      prompt: 'p',
      status: 'pending',
    })
  })

  afterEach(() => {
    db.close()
  })

  describe('appendLog', () => {
    it('inserts a log entry without error', () => {
      expect(() => {
        appendLog(db, {
          session_id: 'sess-log',
          event: 'session:started',
        })
      }).not.toThrow()
    })

    it('accepts optional task_id and status transition fields', () => {
      expect(() => {
        appendLog(db, {
          session_id: 'sess-log',
          task_id: 'task-log-1',
          event: 'task:status_change',
          old_status: 'pending',
          new_status: 'running',
          agent: 'claude-code',
        })
      }).not.toThrow()
    })
  })

  describe('getSessionLog', () => {
    it('returns empty array when no log entries exist', () => {
      expect(getSessionLog(db, 'sess-log')).toEqual([])
    })

    it('returns all entries for a session ordered by timestamp', () => {
      appendLog(db, { session_id: 'sess-log', event: 'session:started' })
      appendLog(db, { session_id: 'sess-log', event: 'task:created', task_id: 'task-log-1' })
      appendLog(db, { session_id: 'sess-log', event: 'task:running', task_id: 'task-log-1' })

      const entries = getSessionLog(db, 'sess-log')
      expect(entries.length).toBe(3)
      expect(entries[0].event).toBe('session:started')
    })

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        appendLog(db, { session_id: 'sess-log', event: `event-${i}` })
      }
      const limited = getSessionLog(db, 'sess-log', 3)
      expect(limited.length).toBe(3)
    })
  })

  describe('getTaskLog', () => {
    it('returns empty array for a task with no log entries', () => {
      expect(getTaskLog(db, 'task-log-1')).toEqual([])
    })

    it('returns only entries for the specified task', () => {
      appendLog(db, { session_id: 'sess-log', event: 'session:started' })
      appendLog(db, {
        session_id: 'sess-log',
        task_id: 'task-log-1',
        event: 'task:running',
      })
      appendLog(db, {
        session_id: 'sess-log',
        task_id: 'task-log-2',
        event: 'task:pending',
      })

      const task1Entries = getTaskLog(db, 'task-log-1')
      expect(task1Entries.length).toBe(1)
      expect(task1Entries[0].event).toBe('task:running')

      const task2Entries = getTaskLog(db, 'task-log-2')
      expect(task2Entries.length).toBe(1)
      expect(task2Entries[0].event).toBe('task:pending')
    })
  })
})
