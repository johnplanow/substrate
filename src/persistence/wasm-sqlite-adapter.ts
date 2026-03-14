/**
 * WASM SQLite adapters — wraps sql.js (SQLite compiled to WASM) with
 * the DatabaseAdapter interface.
 *
 * Provides full SQLite SQL compatibility (JOINs, VIEWs, aggregates,
 * AUTOINCREMENT, etc.) without any native C++ compilation.
 *
 * Two adapters:
 *   - WasmSqliteDatabaseAdapter: wraps a raw sql.js database instance
 *   - SyncDatabaseAdapter: wraps any synchronous prepare/exec-compatible object
 */

import type { DatabaseAdapter, SyncAdapter } from './adapter.js'
export type { SyncAdapter } from './adapter.js'
export { isSyncAdapter } from './adapter.js'

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

export class WasmSqliteDatabaseAdapter implements DatabaseAdapter, SyncAdapter {
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

  // Synchronous query path (implements SyncAdapter)
  querySync<T = unknown>(sql: string, params?: unknown[]): T[] {
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

  // Synchronous exec path (implements SyncAdapter)
  execSync(sql: string): void {
    const db = this._assertOpen()
    db.exec(sql)
  }

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.querySync<T>(sql, params)
  }

  async exec(sql: string): Promise<void> {
    this.execSync(sql)
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

// ---------------------------------------------------------------------------
// SyncDatabaseAdapter — wraps any synchronous prepare/exec-compatible object
// ---------------------------------------------------------------------------

/**
 * Minimal interface matching the synchronous Database API surface
 * (prepare, exec, close).
 */
interface SyncDatabaseLike {
  prepare(sql: string): { reader: boolean; all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }
  exec(sql: string): void
}

/**
 * DatabaseAdapter that wraps any object implementing the synchronous
 * prepare/exec API. Does NOT own the database lifecycle —
 * close() is a no-op; the caller manages open/close.
 *
 * Used in test code that bridges legacy synchronous database objects.
 */
export class SyncDatabaseAdapter implements DatabaseAdapter, SyncAdapter {
  private readonly _db: SyncDatabaseLike

  constructor(db: SyncDatabaseLike) {
    this._db = db
  }

  // Synchronous query path (implements SyncAdapter)
  querySync<T = unknown>(sql: string, params?: unknown[]): T[] {
    const stmt = this._db.prepare(sql)
    if (stmt.reader) {
      return (params && params.length > 0 ? stmt.all(...params) : stmt.all()) as T[]
    }
    if (params && params.length > 0) {
      stmt.run(...params)
    } else {
      stmt.run()
    }
    return []
  }

  // Synchronous exec path (implements SyncAdapter)
  execSync(sql: string): void {
    this._db.exec(sql)
  }

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.querySync<T>(sql, params)
  }

  async exec(sql: string): Promise<void> {
    this.execSync(sql)
  }

  async transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    this._db.exec('BEGIN')
    try {
      const result = await fn(this)
      this._db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this._db.exec('ROLLBACK')
      } catch {
        // Already closed or rolled back
      }
      throw err
    }
  }

  async close(): Promise<void> {
    // No-op — caller manages database lifecycle
  }
}

/**
 * Create a DatabaseAdapter wrapping a synchronous prepare/exec-compatible database.
 *
 * The adapter delegates prepare/exec calls to the underlying database.
 * close() is a no-op — the caller remains responsible for closing the database.
 *
 * @param db - Any object with prepare() and exec() methods (e.g. WASM mock Database)
 */
export function createAdapterFromSyncDb(db: SyncDatabaseLike): DatabaseAdapter {
  return new SyncDatabaseAdapter(db)
}
