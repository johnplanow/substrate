/**
 * Persistence interface definitions for @substrate-ai/core.
 *
 * This module contains interface definitions only — no implementations.
 * Implementations live in the monolith `src/persistence/` and will be
 * migrated to `packages/core/` in Epic 41.
 *
 * Exports:
 *  - DatabaseAdapter: unified async interface for all persistence backends
 *  - SyncAdapter: optional synchronous extension for in-memory backends
 *  - DatabaseAdapterConfig: configuration for the createDatabaseAdapter factory
 *  - isSyncAdapter: type guard for capability detection
 *  - InitSchemaFn: function type alias for the initSchema contract
 */

// ---------------------------------------------------------------------------
// DatabaseAdapter interface
// ---------------------------------------------------------------------------

/**
 * Optional synchronous query extension for adapters backed by synchronous engines
 * (e.g., InMemoryDatabaseAdapter). Consumers that require a synchronous
 * interface (like MonitorDatabaseImpl) use this to avoid async cascades.
 */
export interface SyncAdapter {
  /** Execute a SQL query synchronously and return typed rows. */
  querySync<T = unknown>(sql: string, params?: unknown[]): T[]
  /** Execute a SQL statement synchronously (DDL/DML). */
  execSync(sql: string): void
}

/**
 * Unified async database adapter interface.
 * All persistence backends implement this interface.
 */
export interface DatabaseAdapter {
  /**
   * The persistence backend powering this adapter.
   * - 'dolt': backed by a Dolt SQL database (persists to disk)
   * - 'memory': backed by in-memory Maps (no persistence, lost on process exit)
   */
  readonly backendType: 'dolt' | 'memory'

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
   *   - The adapter does not support the work graph (InMemory)
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
// Type guard
// ---------------------------------------------------------------------------

/** Type guard: check if a DatabaseAdapter also implements SyncAdapter. */
export function isSyncAdapter(adapter: DatabaseAdapter): adapter is DatabaseAdapter & SyncAdapter {
  return typeof (adapter as DatabaseAdapter & SyncAdapter).querySync === 'function'
}

// ---------------------------------------------------------------------------
// InitSchemaFn type alias
// ---------------------------------------------------------------------------

/**
 * Function type alias describing the `initSchema` contract.
 * Implementations accept a DatabaseAdapter and initialize all persistence
 * tables. Must be idempotent — safe to call multiple times.
 */
export type InitSchemaFn = (adapter: DatabaseAdapter) => Promise<void>
