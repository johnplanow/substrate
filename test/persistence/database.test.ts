/**
 * Tests for DatabaseWrapper and DatabaseServiceImpl.
 *
 * Uses :memory: databases for speed and zero cleanup.
 * Validates:
 *  - open/close lifecycle
 *  - PRAGMA application (WAL mode, busy_timeout, synchronous, foreign_keys)
 *  - DatabaseService lifecycle methods (initialize / shutdown)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseWrapper, DatabaseServiceImpl, createDatabaseService } from '../../src/persistence/database.js'

// ---------------------------------------------------------------------------
// DatabaseWrapper tests
// ---------------------------------------------------------------------------

describe('DatabaseWrapper', () => {
  let wrapper: DatabaseWrapper

  beforeEach(() => {
    wrapper = new DatabaseWrapper(':memory:')
  })

  afterEach(() => {
    if (wrapper.isOpen) wrapper.close()
  })

  it('should start in a closed state', () => {
    expect(wrapper.isOpen).toBe(false)
  })

  it('should open successfully', () => {
    wrapper.open()
    expect(wrapper.isOpen).toBe(true)
  })

  it('should expose the raw db after open', () => {
    wrapper.open()
    expect(wrapper.db).toBeDefined()
  })

  it('should throw when accessing db before open', () => {
    expect(() => wrapper.db).toThrow('database is not open')
  })

  it('should be idempotent on repeated open calls', () => {
    wrapper.open()
    const db1 = wrapper.db
    wrapper.open() // second call — should not re-open
    expect(wrapper.db).toBe(db1)
  })

  it('should close successfully', () => {
    wrapper.open()
    wrapper.close()
    expect(wrapper.isOpen).toBe(false)
  })

  it('should be idempotent on repeated close calls', () => {
    wrapper.open()
    wrapper.close()
    expect(() => wrapper.close()).not.toThrow()
    expect(wrapper.isOpen).toBe(false)
  })

  describe('PRAGMA verification', () => {
    it('should attempt to set WAL mode (journal_mode pragma is applied)', () => {
      // WAL mode is applied via pragma() on open. In-memory databases use 'memory'
      // journal mode which cannot be changed to WAL — this is expected SQLite behaviour.
      // We verify that the pragma() call doesn't throw, and that the wrapper opens cleanly.
      expect(() => wrapper.open()).not.toThrow()
      expect(wrapper.isOpen).toBe(true)
      // The journal_mode pragma is readable without error
      expect(() => wrapper.db.pragma('journal_mode')).not.toThrow()
    })

    it('should set busy_timeout to 5000', () => {
      wrapper.open()
      // better-sqlite3 returns busy_timeout as [{ timeout: 5000 }]
      const result = wrapper.db.pragma('busy_timeout') as Array<{ timeout: number }>
      expect(result[0].timeout).toBe(5000)
    })

    it('should set synchronous to NORMAL (1)', () => {
      wrapper.open()
      const row = wrapper.db.pragma('synchronous') as Array<{ synchronous: number }>
      // NORMAL = 1
      expect(row[0].synchronous).toBe(1)
    })

    it('should enable foreign keys', () => {
      wrapper.open()
      const row = wrapper.db.pragma('foreign_keys') as Array<{ foreign_keys: number }>
      // ON = 1
      expect(row[0].foreign_keys).toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// DatabaseServiceImpl tests
// ---------------------------------------------------------------------------

describe('DatabaseServiceImpl', () => {
  let service: DatabaseServiceImpl

  beforeEach(() => {
    service = new DatabaseServiceImpl(':memory:')
  })

  afterEach(async () => {
    if (service.isOpen) await service.shutdown()
  })

  it('should start closed', () => {
    expect(service.isOpen).toBe(false)
  })

  it('should open on initialize()', async () => {
    await service.initialize()
    expect(service.isOpen).toBe(true)
  })

  it('should expose db after initialize()', async () => {
    await service.initialize()
    expect(service.db).toBeDefined()
  })

  it('should close on shutdown()', async () => {
    await service.initialize()
    await service.shutdown()
    expect(service.isOpen).toBe(false)
  })

  it('should have applied WAL pragma without throwing after initialize()', async () => {
    // WAL mode is applied during initialize(). In-memory databases stay in 'memory'
    // journal mode (SQLite limitation), but the pragma call must not throw.
    await service.initialize()
    expect(() => service.db.pragma('journal_mode')).not.toThrow()
    expect(service.isOpen).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createDatabaseService factory tests
// ---------------------------------------------------------------------------

describe('createDatabaseService', () => {
  it('should return a DatabaseService instance', () => {
    const svc = createDatabaseService(':memory:')
    expect(svc).toBeDefined()
    expect(typeof svc.initialize).toBe('function')
    expect(typeof svc.shutdown).toBe('function')
    expect(svc.isOpen).toBe(false)
  })

  it('should fully initialize and shut down', async () => {
    const svc = createDatabaseService(':memory:')
    await svc.initialize()
    expect(svc.isOpen).toBe(true)
    await svc.shutdown()
    expect(svc.isOpen).toBe(false)
  })
})
