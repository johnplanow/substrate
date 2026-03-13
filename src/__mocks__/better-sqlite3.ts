/**
 * Mock for better-sqlite3 backed by sql.js (WASM SQLite).
 *
 * Provides the same synchronous API surface used by test files:
 *   - new Database(':memory:')
 *   - db.exec(sql)
 *   - db.prepare(sql) → { all(), run(), get(), bind(), reader, free() }
 *   - db.pragma(str) → result
 *   - db.transaction(fn) → wrapped fn
 *   - db.close()
 *   - db.open (boolean property)
 *
 * Handles both positional and named parameters:
 *   - Positional: stmt.run(1, 'foo') or stmt.run([1, 'foo'])
 *   - Named: stmt.run({ taskId: 'x', agent: 'y' }) with @taskId/@agent in SQL
 *
 * Uses top-level await to ensure sql.js WASM is fully initialized
 * before any test code can construct a Database instance.
 */

import initSqlJs from 'sql.js'

// Top-level await ensures WASM is loaded before module exports resolve.
// Vitest supports this in ESM mode.
const SQL = await initSqlJs()

interface SqlJsDatabase {
  run(sql: string, params?: unknown[] | Record<string, unknown>): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  prepare(sql: string): SqlJsStatement
  close(): void
}

interface SqlJsStatement {
  bind(params?: unknown[] | Record<string, unknown>): boolean
  step(): boolean
  getAsObject(): Record<string, unknown>
  get(): unknown[]
  getColumnNames(): string[]
  free(): void
}

/**
 * Convert better-sqlite3 named params (@name) to sql.js format ($name)
 * and transform the param object keys to match.
 */
function convertNamedParams(
  sql: string,
  params: Record<string, unknown>,
): { sql: string; params: Record<string, unknown> } {
  // Replace @paramName with $paramName in SQL
  const convertedSql = sql.replace(/@(\w+)/g, (_match, name) => `$${name}`)
  // sql.js expects keys prefixed with $ in the object
  const convertedParams: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    convertedParams[`$${key}`] = value
  }
  return { sql: convertedSql, params: convertedParams }
}

/**
 * Determine if a single argument is a named parameter object (not an array).
 */
function isNamedParams(params: unknown[]): params is [Record<string, unknown>] {
  return (
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === 'object' &&
    !Array.isArray(params[0])
  )
}

/**
 * Normalize parameters into a flat array for positional binding.
 */
function flattenPositional(params: unknown[]): unknown[] {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0]
  }
  return params
}

/**
 * Statement wrapper that mimics better-sqlite3's Statement API.
 */
class StatementWrapper {
  private _db: SqlJsDatabase
  private _sql: string
  reader: boolean

  constructor(db: SqlJsDatabase, sql: string) {
    this._db = db
    this._sql = sql
    // Detect if this is a SELECT/PRAGMA/RETURNING statement
    const trimmed = sql.trim().toUpperCase()
    this.reader = trimmed.startsWith('SELECT') ||
      trimmed.startsWith('PRAGMA') ||
      trimmed.startsWith('WITH') ||
      trimmed.includes('RETURNING')
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    if (isNamedParams(params)) {
      const { sql, params: namedParams } = convertNamedParams(this._sql, params[0])
      const stmt = this._db.prepare(sql)
      try {
        stmt.bind(namedParams)
        const rows: Record<string, unknown>[] = []
        while (stmt.step()) {
          rows.push(stmt.getAsObject())
        }
        return rows
      } finally {
        stmt.free()
      }
    }

    const flatParams = flattenPositional(params)
    const stmt = this._db.prepare(this._sql)
    try {
      if (flatParams.length > 0) {
        stmt.bind(flatParams as unknown[])
      }
      const rows: Record<string, unknown>[] = []
      while (stmt.step()) {
        rows.push(stmt.getAsObject())
      }
      return rows
    } finally {
      stmt.free()
    }
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    if (isNamedParams(params)) {
      const { sql, params: namedParams } = convertNamedParams(this._sql, params[0])
      const stmt = this._db.prepare(sql)
      try {
        stmt.bind(namedParams)
        if (stmt.step()) {
          return stmt.getAsObject()
        }
        return undefined
      } finally {
        stmt.free()
      }
    }

    const flatParams = flattenPositional(params)
    const stmt = this._db.prepare(this._sql)
    try {
      if (flatParams.length > 0) {
        stmt.bind(flatParams as unknown[])
      }
      if (stmt.step()) {
        return stmt.getAsObject()
      }
      return undefined
    } finally {
      stmt.free()
    }
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    if (isNamedParams(params)) {
      const { sql, params: namedParams } = convertNamedParams(this._sql, params[0])
      this._db.run(sql, namedParams as unknown as unknown[])
    } else {
      const flatParams = flattenPositional(params)
      if (flatParams.length > 0) {
        this._db.run(this._sql, flatParams as unknown[])
      } else {
        this._db.run(this._sql)
      }
    }
    // sql.js doesn't easily expose changes/lastInsertRowid from run()
    // Retrieve them via separate queries
    let changes = 0
    let lastInsertRowid = 0
    try {
      const changesStmt = this._db.prepare('SELECT changes() as c')
      if (changesStmt.step()) {
        changes = (changesStmt.getAsObject() as { c: number }).c
      }
      changesStmt.free()
      const rowidStmt = this._db.prepare('SELECT last_insert_rowid() as r')
      if (rowidStmt.step()) {
        lastInsertRowid = (rowidStmt.getAsObject() as { r: number }).r
      }
      rowidStmt.free()
    } catch {
      // ignore
    }
    return { changes, lastInsertRowid }
  }

  bind(..._params: unknown[]): this {
    return this
  }

  free(): void {
    // no-op — statement is freed after each call in this mock
  }
}

/**
 * Cache of sql.js databases by path, so opening the same file path
 * multiple times returns the same in-memory database (mimicking
 * better-sqlite3's file-backed persistence within a test).
 * ':memory:' and empty paths always create fresh databases.
 */
const dbCache = new Map<string, SqlJsDatabase>()

/**
 * Database class that mimics better-sqlite3's Database API using sql.js.
 */
class Database {
  private _db: SqlJsDatabase | null
  private _isOpen: boolean
  private _path: string

  constructor(path?: string) {
    this._path = path ?? ':memory:'

    // For named paths (not :memory:), reuse the same sql.js database
    // so that multiple opens of the same path share state within a test.
    if (this._path !== ':memory:' && this._path !== '' && dbCache.has(this._path)) {
      this._db = dbCache.get(this._path)!
    } else {
      this._db = new SQL.Database()
      if (this._path !== ':memory:' && this._path !== '') {
        dbCache.set(this._path, this._db)
      }
    }

    this._isOpen = true
    // Apply default PRAGMAs (silently — WAL is not meaningful in-memory)
    try {
      this._db.run('PRAGMA journal_mode = WAL')
      this._db.run('PRAGMA foreign_keys = ON')
    } catch {
      // PRAGMAs may fail in WASM SQLite — that's fine
    }
  }

  get open(): boolean {
    return this._isOpen
  }

  private _assertOpen(): SqlJsDatabase {
    if (!this._isOpen || this._db === null) {
      throw new TypeError('The database connection is not open')
    }
    return this._db
  }

  exec(sql: string): void {
    const db = this._assertOpen()
    db.exec(sql)
  }

  prepare(sql: string): StatementWrapper {
    this._assertOpen()
    return new StatementWrapper(this._db!, sql)
  }

  pragma(str: string): unknown {
    const db = this._assertOpen()
    // PRAGMA can be "key = value" or just "key"
    const stmt = db.prepare(`PRAGMA ${str}`)
    try {
      if (stmt.step()) {
        return [stmt.getAsObject()]
      }
      return []
    } finally {
      stmt.free()
    }
  }

  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const self = this
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const db = self._assertOpen()
      db.run('BEGIN')
      try {
        const result = fn.apply(this, args)
        if (self._isOpen) db.run('COMMIT')
        return result
      } catch (err) {
        try {
          if (self._isOpen) db.run('ROLLBACK')
        } catch {
          // already rolled back
        }
        throw err
      }
    } as unknown as T
    return wrapped
  }

  close(): void {
    if (this._db !== null) {
      if (this._path === ':memory:' || this._path === '') {
        // For in-memory databases, actually close them
        this._db.close()
        this._db = null
      }
      // For file-path databases, keep the sql.js database alive in
      // the cache so a subsequent open of the same path returns the
      // same data (mimicking file-based persistence). The reference
      // is kept, but marked as closed.
    }
    this._isOpen = false
  }
}

export default Database
export { Database }
export type { Database as BetterSqlite3Database }
