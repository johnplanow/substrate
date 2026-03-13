/**
 * DoltDatabaseAdapter — wraps DoltClient and exposes it through the
 * unified async DatabaseAdapter interface.
 *
 * All SQL operations are delegated to the existing DoltClient, which
 * connects via mysql2 unix socket (primary) or dolt CLI (fallback).
 * Transactions use explicit BEGIN / COMMIT / ROLLBACK statements.
 */

import type { DatabaseAdapter } from './adapter.js'
import type { DoltClient } from '../modules/state/dolt-client.js'

export class DoltDatabaseAdapter implements DatabaseAdapter {
  private readonly _client: DoltClient

  /**
   * Create a DoltDatabaseAdapter wrapping the supplied DoltClient.
   * The caller should construct the client with the correct `repoPath`
   * before passing it here; `connect()` is called lazily by DoltClient.
   */
  constructor(client: DoltClient) {
    this._client = client
  }

  /**
   * Execute a SQL query and return all result rows as typed objects.
   *
   * Delegates to `DoltClient.query<T>()` which supports both mysql2
   * pool mode and CLI fallback.
   */
  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    return this._client.query<T>(sql, params)
  }

  /**
   * Execute a SQL statement with no return value (DDL or DML).
   *
   * Delegates to `DoltClient.query()` and discards the result rows.
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
}
