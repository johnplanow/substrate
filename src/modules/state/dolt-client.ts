/**
 * DoltClient — low-level SQL client for Dolt repositories.
 * Connects via mysql2 unix socket (primary) or falls back to dolt CLI.
 */
import { execFile as execFileCb } from 'node:child_process'
import { access } from 'node:fs/promises'
import type { Pool } from 'mysql2/promise'
import { createLogger } from '../../utils/logger.js'
import { DoltQueryError } from './errors.js'

/**
 * Promise-wrapper around execFile that always resolves to { stdout, stderr }.
 * Using an explicit wrapper rather than promisify() avoids the util.promisify.custom
 * symbol complexity when mocking in tests.
 */
function runExecFile(cmd: string, args: string[], opts: { cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        reject(err)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

const log = createLogger('modules:state:dolt')

export interface DoltClientOptions {
  repoPath: string
  socketPath?: string
}

export class DoltClient {
  readonly repoPath: string
  readonly socketPath: string
  private _pool: Pool | null = null
  private _useCliMode = false
  private _connected = false

  constructor(options: DoltClientOptions) {
    this.repoPath = options.repoPath
    this.socketPath = options.socketPath ?? `${options.repoPath}/.dolt/dolt.sock`
  }

  async connect(): Promise<void> {
    // Probe unix socket
    try {
      await access(this.socketPath)
      // Socket exists — try mysql2
      const mysql = await import('mysql2/promise')
      this._pool = mysql.createPool({
        socketPath: this.socketPath,
        user: 'root',
        database: 'doltdb',
        waitForConnections: true,
        connectionLimit: 5,
      })
      this._useCliMode = false
      log.debug('Connected via unix socket: %s', this.socketPath)
    } catch {
      // Socket absent or inaccessible — use CLI fallback
      this._useCliMode = true
      log.debug('Unix socket not available, using CLI fallback for %s', this.repoPath)
    }
    this._connected = true
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    if (!this._connected) {
      await this.connect()
    }
    if (this._useCliMode) {
      return this._queryCli<T>(sql, params)
    }
    return this._queryPool<T>(sql, params)
  }

  private async _queryPool<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const [rows] = await this._pool!.execute(sql, params)
      return rows as T[]
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new DoltQueryError(sql, detail)
    }
  }

  private async _queryCli<T>(sql: string, params?: unknown[]): Promise<T[]> {
    // Substitute params with escaped literals
    let resolvedSql = sql
    if (params && params.length > 0) {
      let i = 0
      resolvedSql = sql.replace(/\?/g, () => {
        const val = params[i++]
        if (val === null || val === undefined) return 'NULL'
        if (typeof val === 'number') return String(val)
        return `'${String(val).replace(/'/g, "''")}'`
      })
    }

    try {
      const { stdout } = await runExecFile(
        'dolt',
        ['sql', '-q', resolvedSql, '--result-format', 'json'],
        { cwd: this.repoPath },
      )
      const parsed = JSON.parse(stdout || '{"rows":[]}')
      return (parsed.rows ?? []) as T[]
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new DoltQueryError(resolvedSql, detail)
    }
  }

  async close(): Promise<void> {
    if (this._pool) {
      await this._pool.end()
      this._pool = null
    }
    this._connected = false
  }
}

export function createDoltClient(options: DoltClientOptions): DoltClient {
  return new DoltClient(options)
}
