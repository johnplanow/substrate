/**
 * DatabaseWrapper — thin wrapper around better-sqlite3.
 *
 * Responsibilities:
 *  - Open a SQLite database with the required PRAGMAs (WAL mode, etc.)
 *  - Expose the raw BetterSqlite3.Database instance for use by query modules
 *  - Implement the DatabaseService lifecycle interface (initialize / shutdown)
 */

import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { BaseService } from '../core/di.js'
import { runMigrations } from './migrations/index.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('persistence:database')

// ---------------------------------------------------------------------------
// DatabaseWrapper
// ---------------------------------------------------------------------------

/**
 * Thin wrapper that opens a SQLite database, applies required PRAGMAs,
 * and exposes the raw BetterSqlite3 instance.
 */
export class DatabaseWrapper {
  private _db: BetterSqlite3Database | null = null
  private readonly _path: string

  constructor(databasePath: string) {
    this._path = databasePath
  }

  /**
   * Open the database at the configured path and apply all required PRAGMAs.
   * Idempotent — calling open() when already open is a no-op.
   */
  open(): void {
    if (this._db !== null) {
      return
    }

    logger.info({ path: this._path }, 'Opening SQLite database')
    this._db = new BetterSqlite3(this._path)

    // Required PRAGMAs per Architecture Section 5 / AC1
    const walResult = this._db.pragma('journal_mode = WAL') as { journal_mode: string }[]
    if (walResult?.[0]?.journal_mode !== 'wal') {
      logger.warn(
        { result: walResult?.[0]?.journal_mode },
        'WAL pragma did not return expected "wal" — journal_mode may be "memory" or unsupported',
      )
    }
    this._db.pragma('busy_timeout = 5000')
    this._db.pragma('synchronous = NORMAL')
    this._db.pragma('foreign_keys = ON')

    logger.info({ path: this._path }, 'SQLite database opened with WAL mode')
  }

  /**
   * Close the database. Idempotent — calling close() when already closed is a no-op.
   */
  close(): void {
    if (this._db === null) {
      return
    }

    this._db.close()
    this._db = null
    logger.info({ path: this._path }, 'SQLite database closed')
  }

  /**
   * Return the raw BetterSqlite3 instance.
   * @throws {Error} if the database has not been opened yet.
   */
  get db(): BetterSqlite3Database {
    if (this._db === null) {
      throw new Error('DatabaseWrapper: database is not open. Call open() first.')
    }
    return this._db
  }

  /** Whether the database is currently open */
  get isOpen(): boolean {
    return this._db !== null
  }
}

// ---------------------------------------------------------------------------
// DatabaseService interface
// ---------------------------------------------------------------------------

/**
 * Extended DatabaseService interface that exposes the raw BetterSqlite3
 * database instance for use by query modules.
 */
export interface DatabaseService extends BaseService {
  /** Whether the database connection is open and ready */
  readonly isOpen: boolean
  /** Raw BetterSqlite3 database instance — use for prepared statements */
  readonly db: BetterSqlite3Database
}

// ---------------------------------------------------------------------------
// DatabaseServiceImpl
// ---------------------------------------------------------------------------

/**
 * Full implementation of DatabaseService backed by a real SQLite file.
 * Replaces the stub from story 2-1.
 */
export class DatabaseServiceImpl implements DatabaseService {
  private readonly _wrapper: DatabaseWrapper

  constructor(databasePath: string) {
    this._wrapper = new DatabaseWrapper(databasePath)
  }

  get isOpen(): boolean {
    return this._wrapper.isOpen
  }

  get db(): BetterSqlite3Database {
    return this._wrapper.db
  }

  async initialize(): Promise<void> {
    this._wrapper.open()
    runMigrations(this._wrapper.db)
    logger.info('DatabaseService initialized')
  }

  async shutdown(): Promise<void> {
    this._wrapper.close()
    logger.info('DatabaseService shut down')
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDatabaseService(databasePath: string): DatabaseService {
  return new DatabaseServiceImpl(databasePath)
}
