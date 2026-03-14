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
  /** Promise-chain mutex that serializes all CLI operations to prevent concurrent noms manifest access */
  private _cliMutex: Promise<void> = Promise.resolve()

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

  async query<T>(sql: string, params?: unknown[], branch?: string): Promise<T[]> {
    if (!this._connected) {
      await this.connect()
    }
    if (this._useCliMode) {
      return this._queryCli<T>(sql, params, branch)
    }
    return this._queryPool<T>(sql, params, branch)
  }

  private async _queryPool<T>(sql: string, params?: unknown[], branch?: string): Promise<T[]> {
    try {
      if (branch !== undefined && branch !== 'main') {
        // For branch-targeting, acquire a dedicated connection and switch the database context.
        // Dolt server mode supports `database/branch` as a database selector via USE statement.
        const conn = await this._pool!.getConnection()
        try {
          await conn.execute(`USE \`substrate/${branch}\``)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const [rows] = await conn.execute(sql, params as any)
          return rows as T[]
        } finally {
          conn.release()
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [rows] = await this._pool!.execute(sql, params as any)
      return rows as T[]
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new DoltQueryError(sql, detail)
    }
  }

  /**
   * Acquire an exclusive CLI lock. Dolt CLI takes an exclusive lock on the noms
   * manifest, so concurrent `dolt sql -q` / `dolt <subcommand>` processes
   * produce "cannot update manifest: database is read only" errors.
   * Serialize all CLI operations through a single promise chain.
   */
  private _withCliLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._cliMutex
    let release!: () => void
    this._cliMutex = new Promise<void>((resolve) => { release = resolve })
    return prev.then(fn).finally(() => release())
  }

  private async _queryCli<T>(sql: string, params?: unknown[], branch?: string): Promise<T[]> {
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

    const finalSql = resolvedSql
    return this._withCliLock(async () => {
      try {
        // Dolt CLI has no branch flag for `dolt sql`. Prepend DOLT_CHECKOUT
        // to switch branches when needed. Multi-statement output produces one
        // JSON object per line — parse the last line for the actual result.
        const branchPrefix = branch
          ? `CALL DOLT_CHECKOUT('${branch.replace(/'/g, "''")}'); `
          : ''
        const args = ['sql', '-q', branchPrefix + finalSql, '--result-format', 'json']
        const { stdout } = await runExecFile('dolt', args, { cwd: this.repoPath })
        // When branch prefix is used, stdout has multiple JSON lines; take the last one
        const lines = (stdout || '').trim().split('\n').filter(Boolean)
        const lastLine = lines.length > 0 ? lines[lines.length - 1]! : '{"rows":[]}'
        const parsed = JSON.parse(lastLine)
        return (parsed.rows ?? []) as T[]
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new DoltQueryError(finalSql, detail)
      }
    })
  }

  /**
   * Execute a raw Dolt CLI command (e.g. `dolt diff main...story/26-1 --stat`)
   * and return the stdout as a string.
   *
   * This is distinct from `query()` which runs SQL. Use `exec()` for Dolt
   * sub-commands like `diff`, `log`, `branch`, etc.
   */
  async exec(command: string): Promise<string> {
    const parts = command.trim().split(/\s+/)
    // If the command starts with 'dolt', strip it; otherwise pass all parts as args
    const cmdArgs = parts[0] === 'dolt' ? parts.slice(1) : parts
    return this.execArgs(cmdArgs)
  }

  /**
   * Execute a Dolt CLI command with pre-split arguments.
   *
   * Use this instead of `exec()` when arguments contain spaces (e.g. commit
   * messages) to avoid whitespace-splitting issues.
   */
  async execArgs(args: string[]): Promise<string> {
    return this._withCliLock(async () => {
      try {
        const { stdout } = await runExecFile('dolt', args, { cwd: this.repoPath })
        return stdout
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new DoltQueryError(args.join(' '), detail)
      }
    })
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
