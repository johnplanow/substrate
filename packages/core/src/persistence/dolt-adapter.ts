/**
 * DoltDatabaseAdapter — wraps a DoltClientLike and exposes it through the
 * unified async DatabaseAdapter interface.
 *
 * Uses a duck-typed DoltClientLike interface to avoid cross-package imports.
 * All SQL operations are delegated to the client, which connects via mysql2
 * unix socket (primary) or dolt CLI (fallback).
 * Transactions use explicit BEGIN / COMMIT / ROLLBACK statements.
 */

import type { DatabaseAdapter } from './types.js'

/**
 * Duck-typed interface for the DoltClient dependency.
 * Allows packages/core to use DoltDatabaseAdapter without importing DoltClient directly.
 */
export interface DoltClientLike {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
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
   * Issues `BEGIN` before the function and `COMMIT` on success or
   * `ROLLBACK` on error.  Works in both mysql2 pool mode (where
   * transactions are natively supported) and CLI mode (where Dolt
   * supports multi-statement sessions via CALL DOLT_CHECKOUT).
   */
  async transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    await this._client.query('BEGIN', undefined)
    try {
      const result = await fn(this)
      await this._client.query('COMMIT', undefined)
      return result
    } catch (err) {
      await this._client.query('ROLLBACK', undefined)
      throw err
    }
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
        undefined,
      )
      return rows.map((r) => r.key)
    } catch {
      return []
    }
  }
}
