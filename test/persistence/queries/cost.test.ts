/**
 * Tests for cost query functions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../src/persistence/migrations/index.js'
import {
  recordCostEntry,
  getSessionCost,
  getTaskCost,
} from '../../../src/persistence/queries/cost.js'
import { createSession } from '../../../src/persistence/queries/sessions.js'
import { createTask } from '../../../src/persistence/queries/tasks.js'

function openMemoryDb(): BetterSqlite3Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

describe('cost queries', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMemoryDb()
    createSession(db, { id: 'sess-cost', graph_file: 'test.yaml', status: 'active' })
    createTask(db, {
      id: 'task-cost-1',
      session_id: 'sess-cost',
      name: 'Task 1',
      prompt: 'p',
      status: 'running',
    })
  })

  afterEach(() => {
    db.close()
  })

  describe('recordCostEntry', () => {
    it('inserts a cost entry without error', () => {
      expect(() => {
        recordCostEntry(db, {
          session_id: 'sess-cost',
          task_id: 'task-cost-1',
          agent: 'claude-code',
          billing_mode: 'api',
          estimated_cost: 0.01,
          input_tokens: 500,
          output_tokens: 200,
        })
      }).not.toThrow()
    })
  })

  describe('getSessionCost', () => {
    it('returns zero totals when no entries exist', () => {
      const result = getSessionCost(db, 'sess-cost')
      expect(result.total_cost).toBe(0)
      expect(result.total_input_tokens).toBe(0)
      expect(result.total_output_tokens).toBe(0)
      expect(result.entry_count).toBe(0)
    })

    it('aggregates costs for a session', () => {
      recordCostEntry(db, {
        session_id: 'sess-cost',
        agent: 'claude-code',
        billing_mode: 'api',
        estimated_cost: 0.10,
        input_tokens: 1000,
        output_tokens: 500,
      })
      recordCostEntry(db, {
        session_id: 'sess-cost',
        agent: 'claude-code',
        billing_mode: 'api',
        estimated_cost: 0.05,
        input_tokens: 500,
        output_tokens: 250,
      })

      const result = getSessionCost(db, 'sess-cost')
      expect(result.total_cost).toBeCloseTo(0.15, 5)
      expect(result.total_input_tokens).toBe(1500)
      expect(result.total_output_tokens).toBe(750)
      expect(result.entry_count).toBe(2)
    })

    it('prefers actual_cost over estimated_cost when set', () => {
      recordCostEntry(db, {
        session_id: 'sess-cost',
        agent: 'claude-code',
        billing_mode: 'api',
        estimated_cost: 0.10,
        actual_cost: 0.08,
        input_tokens: 100,
        output_tokens: 50,
      })

      const result = getSessionCost(db, 'sess-cost')
      expect(result.total_cost).toBeCloseTo(0.08, 5)
    })
  })

  describe('getTaskCost', () => {
    it('returns zero totals for a task with no entries', () => {
      const result = getTaskCost(db, 'task-cost-1')
      expect(result.total_cost).toBe(0)
      expect(result.entry_count).toBe(0)
    })

    it('returns cost totals for a specific task', () => {
      recordCostEntry(db, {
        session_id: 'sess-cost',
        task_id: 'task-cost-1',
        agent: 'claude-code',
        billing_mode: 'api',
        estimated_cost: 0.02,
        input_tokens: 100,
        output_tokens: 50,
      })

      const result = getTaskCost(db, 'task-cost-1')
      expect(result.total_cost).toBeCloseTo(0.02, 5)
      expect(result.entry_count).toBe(1)
    })
  })
})
