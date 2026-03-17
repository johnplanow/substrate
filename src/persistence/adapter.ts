/**
 * DatabaseAdapter — unified async interface for all persistence backends.
 *
 * Implementations:
 *  - DoltDatabaseAdapter: delegates to DoltClient (async mysql2 or CLI)
 *  - InMemoryDatabaseAdapter: in-memory Maps (for CI / unit tests)
 *
 * Use `createDatabaseAdapter()` to obtain the appropriate implementation
 * via auto-detection.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { createLogger } from '../utils/logger.js'
import { DoltDatabaseAdapter } from './dolt-adapter.js'
import { InMemoryDatabaseAdapter } from './memory-adapter.js'
import { SyncDatabaseAdapter } from './wasm-sqlite-adapter.js'
import { DoltClient } from '../modules/state/dolt-client.js'

const logger = createLogger('persistence:adapter')

// ---------------------------------------------------------------------------
// DatabaseAdapter interface
// ---------------------------------------------------------------------------

/**
 * Optional synchronous query extension for adapters backed by synchronous engines
 * (e.g., WasmSqliteDatabaseAdapter). Consumers that require a synchronous
 * interface (like MonitorDatabaseImpl) use this to avoid async cascades.
 */
export interface SyncAdapter {
  /** Execute a SQL query synchronously and return typed rows. */
  querySync<T = unknown>(sql: string, params?: unknown[]): T[]
  /** Execute a SQL statement synchronously (DDL/DML). */
  execSync(sql: string): void
}

/** Type guard: check if a DatabaseAdapter also implements SyncAdapter. */
export function isSyncAdapter(adapter: DatabaseAdapter): adapter is DatabaseAdapter & SyncAdapter {
  return typeof (adapter as DatabaseAdapter & SyncAdapter).querySync === 'function'
}

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

  /**
   * Query story keys from the `ready_stories` SQL view.
   *
   * Returns an array of story key strings (e.g. ['31-1', '31-2']) for stories
   * whose status is `planned` or `ready` and whose hard dependencies are all
   * `complete` in the work graph.
   *
   * Returns `[]` when:
   *   - The `ready_stories` view does not exist (story 31-1 schema not applied)
   *   - The `stories` table is empty (story 31-2 ingestion has not run)
   *   - The adapter does not support the work graph (InMemory, WasmSqlite)
   *
   * Callers should treat `[]` as a signal to fall through to the legacy
   * story discovery chain (decisions table → epic-shard → epics.md).
   */
  queryReadyStories(): Promise<string[]>
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
   * - 'dolt': connect via DoltClient (mysql2 socket or CLI fallback)
   * - 'memory': in-memory Maps, no persistence (ideal for CI / unit tests)
   * - 'auto': detect Dolt availability; fall back to 'memory' if not available
   */
  backend: 'dolt' | 'memory' | 'auto'

  /** Project root used for Dolt auto-detection and as the Dolt repo path. */
  basePath?: string
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

  const doltRepoPath = join(basePath, '.substrate', 'state')

  if (backend === 'dolt') {
    logger.debug('Using DoltDatabaseAdapter (explicit config)')
    const client = new DoltClient({ repoPath: doltRepoPath })
    return new DoltDatabaseAdapter(client)
  }

  if (backend === 'memory') {
    logger.debug('Using InMemoryDatabaseAdapter (explicit config)')
    return new InMemoryDatabaseAdapter()
  }

  // 'auto': probe for Dolt, then try file-backed SQLite, fall back to in-memory
  if (isDoltAvailable(basePath)) {
    logger.debug('Dolt detected, using DoltDatabaseAdapter')
    const client = new DoltClient({ repoPath: doltRepoPath })
    return new DoltDatabaseAdapter(client)
  }

  // Try file-backed SQLite via better-sqlite3 (native C++ addon).
  // better-sqlite3's Database implements prepare/exec which matches
  // the SyncDatabaseLike interface used by SyncDatabaseAdapter.
  const sqliteDbPath = join(basePath, '.substrate', 'substrate.db')
  try {
    const require = createRequire(import.meta.url)
    const BetterSqlite3 = require('better-sqlite3') as new (path: string) => {
      pragma(stmt: string): void
      prepare(sql: string): { reader: boolean; all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }
      exec(sql: string): void
      close(): void
    }
    const substrateDir = join(basePath, '.substrate')
    if (!existsSync(substrateDir)) {
      mkdirSync(substrateDir, { recursive: true })
    }
    const db = new BetterSqlite3(sqliteDbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    logger.debug({ path: sqliteDbPath }, 'Using file-backed SQLite via better-sqlite3')
    return new SyncDatabaseAdapter(db)
  } catch (err) {
    logger.debug({ err }, 'better-sqlite3 not available, using InMemoryDatabaseAdapter')
    return new InMemoryDatabaseAdapter()
  }
}
