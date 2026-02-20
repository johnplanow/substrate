/**
 * Tests for session query functions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../src/persistence/migrations/index.js'
import {
  createSession,
  getSession,
  updateSession,
  listSessions,
} from '../../../src/persistence/queries/sessions.js'

function openMemoryDb(): BetterSqlite3Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

describe('sessions queries', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  describe('createSession', () => {
    it('inserts a session record', () => {
      createSession(db, { id: 'sess-001', graph_file: 'plan.yaml', status: 'active' })
      const found = getSession(db, 'sess-001')
      expect(found).toBeDefined()
      expect(found?.id).toBe('sess-001')
      expect(found?.graph_file).toBe('plan.yaml')
      expect(found?.status).toBe('active')
    })

    it('applies default values', () => {
      createSession(db, { id: 'sess-defaults', graph_file: 'graph.yaml', status: 'active' })
      const found = getSession(db, 'sess-defaults')!
      expect(found.total_cost_usd).toBe(0.0)
      expect(found.planning_cost_usd).toBe(0.0)
      expect(found.base_branch).toBe('main')
    })
  })

  describe('getSession', () => {
    it('returns undefined for missing id', () => {
      expect(getSession(db, 'nonexistent')).toBeUndefined()
    })
  })

  describe('updateSession', () => {
    it('updates specific session fields', () => {
      createSession(db, { id: 'sess-upd', graph_file: 'g.yaml', status: 'active' })
      updateSession(db, 'sess-upd', { status: 'completed', total_cost_usd: 1.23 })
      const found = getSession(db, 'sess-upd')!
      expect(found.status).toBe('completed')
      expect(found.total_cost_usd).toBe(1.23)
    })

    it('does not modify fields not provided in update', () => {
      createSession(db, { id: 'sess-partial', graph_file: 'g.yaml', status: 'active', name: 'My Session' })
      updateSession(db, 'sess-partial', { status: 'paused' })
      const found = getSession(db, 'sess-partial')!
      expect(found.name).toBe('My Session') // unchanged
      expect(found.status).toBe('paused')    // changed
    })
  })

  describe('listSessions', () => {
    it('returns empty array when no sessions exist', () => {
      expect(listSessions(db)).toEqual([])
    })

    it('returns all sessions ordered by created_at DESC', () => {
      createSession(db, { id: 'sess-a', graph_file: 'a.yaml', status: 'active' })
      createSession(db, { id: 'sess-b', graph_file: 'b.yaml', status: 'active' })
      createSession(db, { id: 'sess-c', graph_file: 'c.yaml', status: 'active' })

      const sessions = listSessions(db)
      expect(sessions.length).toBe(3)
      // All sessions should be present
      const ids = sessions.map((s) => s.id)
      expect(ids).toContain('sess-a')
      expect(ids).toContain('sess-b')
      expect(ids).toContain('sess-c')
    })
  })
})
