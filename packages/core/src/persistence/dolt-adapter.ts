/**
 * DoltDatabaseAdapter — wraps a DoltClientLike and exposes it through the
 * unified async DatabaseAdapter interface.
 *
 * Uses a duck-typed DoltClientLike interface to avoid cross-package imports.
 * All SQL operations are delegated to the client, which connects via mysql2
 * unix socket (primary) or dolt CLI (fallback).
 * Transactions delegate atomicity enforcement to DoltClientLike.transact().
 */

import type { DatabaseAdapter } from './types.js'

/**
 * Duck-typed interface for the DoltClient dependency.
 * Allows packages/core to use DoltDatabaseAdapter without importing DoltClient directly.
 *
 * `transact<T>()` enforces atomicity in both pool mode and CLI mode:
 * - Pool mode: acquires a dedicated connection and issues BEGIN/COMMIT on it.
 * - CLI mode: collects all statements and executes them as a single batch invocation.
 */
export interface DoltClientLike {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  transact<T>(
    fn: (query: <R>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>
  ): Promise<T>
  close(): Promise<void>
}

export class DoltDatabaseAdapter implements DatabaseAdapter {
  readonly backendType = 'dolt' as const
  private readonly _client: DoltClientLike

  /**
   * Create a DoltDatabaseAdapter wrapping the supplied DoltClientLike.
   * The caller should construct the client with the correct `repoPath`
   * before passing it here; `connect()` is called lazily by DoltClient.
   */
  constructor(client: DoltClientLike) {
    this._client = client
  }

  /**
   * Execute a SQL query and return all result rows as typed objects.
   *
   * Delegates to `DoltClientLike.query<T>()` which supports both mysql2
   * pool mode and CLI fallback.
   */
  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    return this._client.query<T>(sql, params)
  }

  /**
   * Execute a SQL statement with no return value (DDL or DML).
   *
   * Delegates to `DoltClientLike.query()` and discards the result rows.
   */
  async exec(sql: string): Promise<void> {
    await this._client.query(sql, undefined)
  }

  /**
   * Execute a function within an explicit SQL transaction.
   *
   * Delegates atomicity enforcement to `DoltClientLike.transact()`:
   * - Pool mode: acquires a dedicated connection, issues BEGIN/COMMIT on that
   *   connection, preventing query scatter across the pool.
   * - CLI mode: collects all SQL statements and executes them as a single
   *   `dolt sql -q "BEGIN; ...; COMMIT"` invocation.
   *
   * The `fn` callback receives a transaction-scoped `DatabaseAdapter` whose
   * `query()` and `exec()` are bound to the connection-bound query lambda.
   * Nested `transaction()` calls on the scoped adapter are pass-through
   * (no nested BEGIN).
   */
  async transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this._client.transact(async (txQuery) => {
      // Build a transaction-scoped adapter that routes queries through the
      // connection-bound txQuery lambda provided by transact().
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this
      const txAdapter: DatabaseAdapter = {
        backendType: this.backendType,
        query: txQuery,
        exec: async (sql: string): Promise<void> => {
          await txQuery(sql, undefined)
        },
        // Nested transaction() calls are pass-through — no nested BEGIN.
        transaction: async <U>(innerFn: (adapter: DatabaseAdapter) => Promise<U>): Promise<U> =>
          innerFn(txAdapter),
        close: async (): Promise<void> => {},
        queryReadyStories: (): Promise<string[]> => self.queryReadyStories(),
      }
      return fn(txAdapter)
    })
  }

  /**
   * Close the underlying DoltClient connection pool.
   */
  async close(): Promise<void> {
    await this._client.close()
  }

  /**
   * Query story keys from the `ready_stories` SQL view.
   *
   * Returns story keys whose status is `planned` or `ready` and whose
   * hard dependencies are all `complete` in the work graph.
   *
   * On any SQL error (e.g., view not yet created by story 31-1 schema,
   * or empty stories table), returns `[]` so the caller falls through to
   * the legacy discovery chain.
   */
  async queryReadyStories(): Promise<string[]> {
    try {
      const rows = await this._client.query<{ key: string }>(
        'SELECT `key` FROM ready_stories ORDER BY `key` ASC',
        undefined
      )
      return rows.map((r) => r.key)
    } catch {
      return []
    }
  }
}
