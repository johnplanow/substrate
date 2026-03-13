/**
 * DatabaseAdapter — unified async interface for all persistence backends.
 *
 * Implementations:
 *  - LegacySqliteAdapter (inline): wraps better-sqlite3 (synchronous ops wrapped in promises)
 *  - DoltDatabaseAdapter: delegates to DoltClient (async mysql2 or CLI)
 *  - InMemoryDatabaseAdapter: in-memory Maps (for CI / unit tests)
 *
 * Use `createDatabaseAdapter()` to obtain the appropriate implementation
 * via auto-detection.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { createLogger } from '../utils/logger.js'
import { DoltDatabaseAdapter } from './dolt-adapter.js'
import { InMemoryDatabaseAdapter } from './memory-adapter.js'
import { DoltClient } from '../modules/state/dolt-client.js'

const logger = createLogger('persistence:adapter')

// ---------------------------------------------------------------------------
// DatabaseAdapter interface
// ---------------------------------------------------------------------------

/**
 * Unified async database adapter interface.
 * All persistence backends implement this interface.
 */
export interface DatabaseAdapter {
  /**
   * Execute a SQL query and return typed rows.
   * @param sql - SQL query string (use ? for parameter placeholders)
   * @param params - Optional array of parameter values
   */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>

  /**
   * Execute a SQL statement with no return value.
   * Suitable for DDL statements (CREATE TABLE, DROP TABLE) and DML without results.
   * @param sql - SQL statement string
   */
  exec(sql: string): Promise<void>

  /**
   * Execute a function within a database transaction.
   * Commits on successful return, rolls back on thrown error.
   * @param fn - Async function that receives the adapter and performs operations
   */
  transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>

  /**
   * Close the database connection and release all resources.
   */
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// DatabaseAdapterConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for the `createDatabaseAdapter` factory.
 */
export interface DatabaseAdapterConfig {
  /**
   * Which backend to use.
   * - 'sqlite': wrap an existing better-sqlite3 database file
   * - 'dolt': connect via DoltClient (mysql2 socket or CLI fallback)
   * - 'memory': in-memory Maps, no persistence (ideal for CI / unit tests)
   * - 'auto': detect Dolt availability; fall back to 'memory' if not available
   */
  backend: 'sqlite' | 'dolt' | 'memory' | 'auto'

  /** Project root used for Dolt auto-detection and as the Dolt repo path. */
  basePath?: string

  /** For 'sqlite' backend: path to the SQLite database file (default ':memory:'). */
  databasePath?: string
}

// ---------------------------------------------------------------------------
// Auto-detection helper (mirrors logic in src/modules/state/index.ts)
// ---------------------------------------------------------------------------

/**
 * Synchronously check whether Dolt is installed on PATH and a Dolt repo
 * exists at the canonical state path under `basePath`.
 */
function isDoltAvailable(basePath: string): boolean {
  const result = spawnSync('dolt', ['version'], { stdio: 'ignore' })
  if (result.error != null || result.status !== 0) {
    return false
  }
  const stateDoltDir = join(basePath, '.substrate', 'state', '.dolt')
  return existsSync(stateDoltDir)
}

// ---------------------------------------------------------------------------
// LegacySqliteAdapter — inline adapter for the 'sqlite' backend path.
// Replaces the deleted SqliteDatabaseAdapter import.
// ---------------------------------------------------------------------------

/** Inline legacy adapter for the sqlite backend path. */
class LegacySqliteAdapter implements DatabaseAdapter {
  private readonly _db: any
  constructor(db: any) { this._db = db }
  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    const stmt = this._db.prepare(sql)
    if (stmt.reader) {
      return (params && params.length > 0 ? stmt.all(...params) : stmt.all()) as T[]
    }
    if (params && params.length > 0) { stmt.run(...params) } else { stmt.run() }
    return []
  }
  async exec(sql: string): Promise<void> { this._db.exec(sql) }
  async transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    this._db.exec('BEGIN')
    try {
      const result = await fn(this)
      this._db.exec('COMMIT')
      return result
    } catch (err) {
      try { this._db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw err
    }
  }
  async close(): Promise<void> { this._db.close() }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `DatabaseAdapter` for the specified (or auto-detected) backend.
 *
 * @param config - Optional configuration. Defaults to `{ backend: 'auto' }`.
 * @returns A `DatabaseAdapter` instance ready for use.
 */
export function createDatabaseAdapter(config: DatabaseAdapterConfig = { backend: 'auto' }): DatabaseAdapter {
  const backend = config.backend ?? 'auto'
  const basePath = config.basePath ?? process.cwd()

  if (backend === 'sqlite') {
    // Dynamically require better-sqlite3 to avoid import-time side effects
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3')
    const db = new BetterSqlite3(config.databasePath ?? ':memory:')
    return new LegacySqliteAdapter(db)
  }

  if (backend === 'dolt') {
    logger.debug('Using DoltDatabaseAdapter (explicit config)')
    const client = new DoltClient({ repoPath: basePath })
    return new DoltDatabaseAdapter(client)
  }

  if (backend === 'memory') {
    logger.debug('Using InMemoryDatabaseAdapter (explicit config)')
    return new InMemoryDatabaseAdapter()
  }

  // 'auto': probe for Dolt, fall back to in-memory
  if (isDoltAvailable(basePath)) {
    logger.debug('Dolt detected, using DoltDatabaseAdapter')
    const client = new DoltClient({ repoPath: basePath })
    return new DoltDatabaseAdapter(client)
  }

  logger.debug('Dolt not available, using InMemoryDatabaseAdapter')
  return new InMemoryDatabaseAdapter()
}
