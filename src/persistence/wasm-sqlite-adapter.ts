/**
 * WasmSqliteDatabaseAdapter — wraps sql.js (SQLite compiled to WASM) with
 * the DatabaseAdapter interface.
 *
 * Used exclusively in tests as a drop-in replacement for the removed
 * better-sqlite3-backed SqliteDatabaseAdapter. Provides full SQLite SQL
 * compatibility (JOINs, VIEWs, aggregates, AUTOINCREMENT, etc.) without
 * any native C++ compilation.
 *
 * Production code uses DoltDatabaseAdapter or InMemoryDatabaseAdapter.
 */

import type { DatabaseAdapter } from './adapter.js'

// sql.js types (dynamic import — no compile-time dependency)
interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  prepare(sql: string): SqlJsStatement
  close(): void
}

interface SqlJsStatement {
  bind(params?: unknown[]): boolean
  step(): boolean
  getAsObject(): Record<string, unknown>
  free(): void
}

// ---------------------------------------------------------------------------
// WasmSqliteDatabaseAdapter
// ---------------------------------------------------------------------------

export class WasmSqliteDatabaseAdapter implements DatabaseAdapter {
  private _db: SqlJsDatabase | null

  constructor(db: SqlJsDatabase) {
    this._db = db
  }

  private _assertOpen(): SqlJsDatabase {
    if (this._db === null) {
      throw new Error('WasmSqliteDatabaseAdapter: database is closed')
    }
    return this._db
  }

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    const db = this._assertOpen()
    const stmt = db.prepare(sql)
    try {
      if (params && params.length > 0) {
        stmt.bind(params)
      }
      const rows: T[] = []
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T)
      }
      return rows
    } finally {
      stmt.free()
    }
  }

  async exec(sql: string): Promise<void> {
    const db = this._assertOpen()
    db.exec(sql)
  }

  async transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    const db = this._assertOpen()
    db.run('BEGIN')
    try {
      const result = await fn(this)
      if (this._db !== null) db.run('COMMIT')
      return result
    } catch (err) {
      try {
        if (this._db !== null) db.run('ROLLBACK')
      } catch {
        // Already closed or rolled back
      }
      throw err
    }
  }

  async close(): Promise<void> {
    if (this._db === null) return
    this._db.close()
    this._db = null
  }
}

// ---------------------------------------------------------------------------
// Factory for tests
// ---------------------------------------------------------------------------

/**
 * Create a DatabaseAdapter backed by sql.js (WASM SQLite).
 * Returns a fresh in-memory database with foreign keys enabled.
 *
 * Requires `sql.js` as a devDependency.
 */
export async function createWasmSqliteAdapter(): Promise<DatabaseAdapter> {
  // Dynamic import so sql.js is only loaded in test environments
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  return new WasmSqliteDatabaseAdapter(db)
}
