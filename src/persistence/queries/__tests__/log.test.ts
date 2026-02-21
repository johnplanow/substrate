/**
 * Unit tests for execution log query functions.
 * AC: #1, #5
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseWrapper } from '../../database.js'
import { runMigrations } from '../../migrations/index.js'
import {
  appendLog,
  getSessionLog,
  getTaskLog,
  getLogByEvent,
  getLogByTimeRange,
} from '../log.js'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertSession(db: BetterSqlite3Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions (id, graph_file, status) VALUES (?, 'test.yaml', 'active')`,
  ).run(id)
}

function insertTask(db: BetterSqlite3Database, id: string, sessionId: string): void {
  db.prepare(
    `INSERT INTO tasks (id, session_id, name, prompt, status) VALUES (?, ?, ?, 'test prompt', 'pending')`,
  ).run(id, sessionId, `Task ${id}`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('log query functions', () => {
  let wrapper: DatabaseWrapper
  let db: BetterSqlite3Database

  beforeEach(() => {
    wrapper = new DatabaseWrapper(':memory:')
    wrapper.open()
    runMigrations(wrapper.db)
    db = wrapper.db
  })

  afterEach(() => {
    wrapper.close()
  })

  // -------------------------------------------------------------------------
  // appendLog
  // -------------------------------------------------------------------------

  describe('appendLog', () => {
    it('inserts an entry with all fields set', () => {
      insertSession(db, 'session-1')
      insertTask(db, 'task-1', 'session-1')

      appendLog(db, {
        session_id: 'session-1',
        task_id: 'task-1',
        event: 'task:status_change',
        old_status: 'pending',
        new_status: 'running',
        agent: 'claude-code',
        cost_usd: 0.05,
        data: JSON.stringify({ result: 'done' }),
      })

      const entries = getSessionLog(db, 'session-1')
      expect(entries).toHaveLength(1)
      const e = entries[0]
      expect(e.session_id).toBe('session-1')
      expect(e.task_id).toBe('task-1')
      expect(e.event).toBe('task:status_change')
      expect(e.old_status).toBe('pending')
      expect(e.new_status).toBe('running')
      expect(e.agent).toBe('claude-code')
      expect(e.cost_usd).toBe(0.05)
      expect(e.data).toBe(JSON.stringify({ result: 'done' }))
    })

    it('inserts an entry with optional fields null, and they round-trip correctly', () => {
      insertSession(db, 'session-2')

      appendLog(db, {
        session_id: 'session-2',
        task_id: null,
        event: 'orchestrator:state_change',
        old_status: null,
        new_status: null,
        agent: null,
        cost_usd: null,
        data: null,
      })

      const entries = getSessionLog(db, 'session-2')
      expect(entries).toHaveLength(1)
      const e = entries[0]
      expect(e.task_id).toBeNull()
      expect(e.old_status).toBeNull()
      expect(e.new_status).toBeNull()
      expect(e.agent).toBeNull()
      expect(e.cost_usd).toBeNull()
      expect(e.data).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // getSessionLog
  // -------------------------------------------------------------------------

  describe('getSessionLog', () => {
    it('returns all entries for a session ordered by timestamp ASC, id ASC', () => {
      insertSession(db, 'session-3')
      appendLog(db, { session_id: 'session-3', event: 'orchestrator:state_change', old_status: 'Idle', new_status: 'Loading' })
      appendLog(db, { session_id: 'session-3', event: 'orchestrator:state_change', old_status: 'Loading', new_status: 'Executing' })

      const entries = getSessionLog(db, 'session-3')
      expect(entries).toHaveLength(2)
      expect(entries[0].old_status).toBe('Idle')
      expect(entries[1].old_status).toBe('Loading')
    })

    it('returns at most limit entries when limit is provided', () => {
      insertSession(db, 'session-4')
      for (let i = 0; i < 5; i++) {
        appendLog(db, { session_id: 'session-4', event: 'orchestrator:state_change', old_status: `S${i}`, new_status: `S${i + 1}` })
      }

      const entries = getSessionLog(db, 'session-4', 3)
      expect(entries).toHaveLength(3)
    })

    it('returns empty array for unknown session', () => {
      const entries = getSessionLog(db, 'nonexistent-session')
      expect(entries).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // getTaskLog
  // -------------------------------------------------------------------------

  describe('getTaskLog', () => {
    it('returns only entries for the specified task', () => {
      insertSession(db, 'session-5')
      insertTask(db, 'task-a', 'session-5')
      insertTask(db, 'task-b', 'session-5')

      appendLog(db, { session_id: 'session-5', task_id: 'task-a', event: 'task:status_change', old_status: 'pending', new_status: 'running' })
      appendLog(db, { session_id: 'session-5', task_id: 'task-b', event: 'task:status_change', old_status: 'pending', new_status: 'running' })

      const entries = getTaskLog(db, 'task-a')
      expect(entries).toHaveLength(1)
      expect(entries[0].task_id).toBe('task-a')
    })

    it('returns empty array for unknown task', () => {
      const entries = getTaskLog(db, 'nonexistent-task')
      expect(entries).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // getLogByEvent
  // -------------------------------------------------------------------------

  describe('getLogByEvent', () => {
    it('returns only entries with matching event = task:status_change', () => {
      insertSession(db, 'session-6')
      insertTask(db, 'task-c', 'session-6')

      appendLog(db, { session_id: 'session-6', task_id: 'task-c', event: 'task:status_change', old_status: 'pending', new_status: 'running' })
      appendLog(db, { session_id: 'session-6', event: 'orchestrator:state_change', old_status: 'Idle', new_status: 'Loading' })

      const entries = getLogByEvent(db, 'session-6', 'task:status_change')
      expect(entries).toHaveLength(1)
      expect(entries[0].event).toBe('task:status_change')
    })

    it('returns only entries with matching event = orchestrator:state_change', () => {
      insertSession(db, 'session-7')
      insertTask(db, 'task-d', 'session-7')

      appendLog(db, { session_id: 'session-7', task_id: 'task-d', event: 'task:status_change', old_status: 'pending', new_status: 'running' })
      appendLog(db, { session_id: 'session-7', event: 'orchestrator:state_change', old_status: 'Idle', new_status: 'Loading' })

      const entries = getLogByEvent(db, 'session-7', 'orchestrator:state_change')
      expect(entries).toHaveLength(1)
      expect(entries[0].event).toBe('orchestrator:state_change')
    })

    it('returns empty array for nonexistent event', () => {
      insertSession(db, 'session-8')
      appendLog(db, { session_id: 'session-8', event: 'task:status_change', old_status: 'pending', new_status: 'running' })

      const entries = getLogByEvent(db, 'session-8', 'nonexistent:event')
      expect(entries).toHaveLength(0)
    })

    it('respects limit parameter', () => {
      insertSession(db, 'session-9')
      for (let i = 0; i < 5; i++) {
        appendLog(db, { session_id: 'session-9', event: 'task:status_change', old_status: 'pending', new_status: 'running' })
      }

      const entries = getLogByEvent(db, 'session-9', 'task:status_change', 2)
      expect(entries).toHaveLength(2)
    })
  })

  // -------------------------------------------------------------------------
  // getLogByTimeRange
  // -------------------------------------------------------------------------

  describe('getLogByTimeRange', () => {
    /**
     * SQLite datetime('now') stores timestamps as 'YYYY-MM-DD HH:MM:SS' (UTC, space separator).
     * We need to use the same format for range queries to make string comparisons work correctly.
     */
    function sqliteNow(offsetMs = 0): string {
      const d = new Date(Date.now() + offsetMs)
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
        `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    }

    it('returns entries within the time window', () => {
      insertSession(db, 'session-10')

      const before = sqliteNow(-2000)
      appendLog(db, { session_id: 'session-10', event: 'task:status_change', old_status: 'pending', new_status: 'running' })
      const after = sqliteNow(2000)

      const entries = getLogByTimeRange(db, 'session-10', before, after)
      expect(entries.length).toBeGreaterThanOrEqual(1)
    })

    it('returns empty array when no entries fall in future range', () => {
      insertSession(db, 'session-11')
      appendLog(db, { session_id: 'session-11', event: 'task:status_change', old_status: 'pending', new_status: 'running' })

      const futureFrom = sqliteNow(100000)
      const futureTo = sqliteNow(200000)

      const entries = getLogByTimeRange(db, 'session-11', futureFrom, futureTo)
      expect(entries).toHaveLength(0)
    })

    it('respects limit parameter', () => {
      insertSession(db, 'session-12')
      const from = sqliteNow(-5000)
      for (let i = 0; i < 5; i++) {
        appendLog(db, { session_id: 'session-12', event: 'task:status_change', old_status: 'pending', new_status: 'running' })
      }
      const to = sqliteNow(5000)

      const entries = getLogByTimeRange(db, 'session-12', from, to, 3)
      expect(entries).toHaveLength(3)
    })
  })
})
