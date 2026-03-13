/**
 * SqliteDatabaseAdapter — wraps a better-sqlite3 Database instance and
 * exposes it through the unified async DatabaseAdapter interface.
 *
 * All better-sqlite3 operations are synchronous; this adapter wraps each
 * call in `Promise.resolve()` so callers can use the async interface
 * uniformly alongside the Dolt and in-memory adapters.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { DatabaseAdapter } from './adapter.js'

export class SqliteDatabaseAdapter implements DatabaseAdapter {
  private readonly _db: BetterSqlite3Database

  /**
   * Create a SqliteDatabaseAdapter wrapping the supplied better-sqlite3
   * Database instance.  The caller is responsible for opening the database
   * and running any required migrations before passing it here.
   */
  constructor(db: BetterSqlite3Database) {
    this._db = db
  }

  private get _isOpen(): boolean {
    return this._db.open
  }

  /**
   * Execute a SQL query and return all result rows as typed objects.
   *
   * For SELECT statements, uses `stmt.all()` to return rows.
   * For DML/DDL statements (INSERT, UPDATE, DELETE, CREATE, etc.),
   * uses `stmt.run()` which returns a RunResult instead of rows,
   * and we return an empty array.
   *
   * Wraps everything in a resolved promise so callers can await uniformly.
   */
  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    if (!this._isOpen) return []
    const stmt = this._db.prepare(sql)
    // Use stmt.reader to detect whether this statement returns rows.
    // better-sqlite3 exposes this as a boolean property.
    if (stmt.reader) {
      const rows = params && params.length > 0 ? stmt.all(...params) : stmt.all()
      return Promise.resolve(rows as T[])
    } else {
      if (params && params.length > 0) {
        stmt.run(...params)
      } else {
        stmt.run()
      }
      return Promise.resolve([])
    }
  }

  /**
   * Execute a SQL statement with no return value (DDL or DML).
   *
   * Uses `db.exec()` for statements that produce no rows.
   */
  async exec(sql: string): Promise<void> {
    if (!this._isOpen) return
    this._db.exec(sql)
    return Promise.resolve()
  }

  /**
   * Execute a function within an explicit SQL transaction.
   *
   * Because the provided `fn` is async, better-sqlite3's native synchronous
   * `transaction()` helper cannot be used directly.  Instead, this method
   * issues explicit `BEGIN`, `COMMIT`, and `ROLLBACK` statements around the
   * async function body.
   */
  async transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    if (!this._isOpen) throw new Error('Database connection is closed')
    this._db.exec('BEGIN')
    try {
      const result = await fn(this)
      if (this._isOpen) this._db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        if (this._isOpen) this._db.exec('ROLLBACK')
      } catch {
        // DB may already be closed during test teardown
      }
      throw err
    }
  }

  /**
   * Close the underlying better-sqlite3 database connection.
   */
  async close(): Promise<void> {
    this._db.close()
    return Promise.resolve()
  }
}
