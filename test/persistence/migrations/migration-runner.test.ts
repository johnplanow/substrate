/**
 * Tests for the migration runner.
 *
 * Validates:
 *  - schema_migrations table is created on first run
 *  - All expected tables, indexes, and views are created
 *  - Running migrations twice is idempotent (no errors)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../src/persistence/migrations/index.js'

function openMemoryDb(): BetterSqlite3Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

describe('runMigrations', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('creates the schema_migrations table', () => {
    runMigrations(db)
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('schema_migrations')
  })

  it('records migration version 1 after first run', () => {
    runMigrations(db)
    const row = db
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 1')
      .get() as { version: number; name: string } | undefined
    expect(row?.version).toBe(1)
    expect(row?.name).toBe('001-initial-schema')
  })

  it('creates all required tables', () => {
    runMigrations(db)
    const tables = ['sessions', 'tasks', 'task_dependencies', 'execution_log', 'cost_entries']
    for (const table of tables) {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`)
        .get() as { name: string } | undefined
      expect(row?.name, `Expected table "${table}" to exist`).toBe(table)
    }
  })

  it('creates all required indexes', () => {
    runMigrations(db)
    const indexes = [
      'idx_tasks_session',
      'idx_tasks_status',
      'idx_tasks_agent',
      'idx_deps_depends_on',
      'idx_log_session',
      'idx_log_task',
      'idx_log_event',
      'idx_log_timestamp',
      'idx_cost_session',
      'idx_cost_task',
      'idx_cost_category',
      'idx_tasks_session_status',
    ]
    for (const idx of indexes) {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='${idx}'`)
        .get() as { name: string } | undefined
      expect(row?.name, `Expected index "${idx}" to exist`).toBe(idx)
    }
  })

  it('creates the ready_tasks view', () => {
    runMigrations(db)
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='ready_tasks'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('ready_tasks')
  })

  it('creates the session_cost_summary view', () => {
    runMigrations(db)
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='session_cost_summary'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('session_cost_summary')
  })

  it('is idempotent — re-running does not throw', () => {
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
  })

  it('does not re-apply already-applied migrations', () => {
    runMigrations(db)
    runMigrations(db)

    const rows = db
      .prepare('SELECT version FROM schema_migrations WHERE version = 1')
      .all() as { version: number }[]
    // Should only have one record for version 1
    expect(rows.length).toBe(1)
  })
})
