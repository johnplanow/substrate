/**
 * DoltStateStore — Dolt SQL backend implementing the StateStore interface.
 *
 * Uses DoltClient for SQL queries (unix socket primary, CLI fallback).
 * Each story gets its own branch for isolation; mergeStory / rollbackStory
 * manage the lifecycle of those branches.
 *
 * SQL Schema matches schema.sql (story 26-2). DoltStateStore runs
 * idempotent CREATE TABLE IF NOT EXISTS migrations so it can function
 * independently of whether `initializeDolt()` was called first.
 */
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from '../../utils/logger.js'
import type { DoltClient } from './dolt-client.js'
import type {
  StateStore,
  StoryRecord,
  StoryFilter,
  MetricRecord,
  MetricFilter,
  ContractRecord,
  StateDiff,
} from './types.js'
import type { StoryPhase } from '../implementation-orchestrator/types.js'
import { DoltQueryError } from './errors.js'

const execFile = promisify(execFileCb)
const log = createLogger('modules:state:dolt')

// ---------------------------------------------------------------------------
// Row shapes returned by SQL queries (matching schema.sql column names)
// ---------------------------------------------------------------------------

interface StoryRow {
  story_key: string
  phase: string
  review_cycles: number
  last_verdict: string | null
  error: string | null
  started_at: string | null
  completed_at: string | null
  sprint: string | null
}

interface MetricRow {
  story_key: string
  task_type: string
  model: string | null
  tokens_in: number | null
  tokens_out: number | null
  cache_read_tokens: number | null
  cost_usd: number | null
  wall_clock_ms: number | null
  review_cycles: number | null
  stall_count: number | null
  result: string | null
  recorded_at: string | null
}

interface ContractRow {
  story_key: string
  contract_name: string
  direction: string
  schema_path: string
  transport: string | null
}

interface DiffRow {
  table_name: string
  pk: string
  diff_type: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

// ---------------------------------------------------------------------------
// DoltStateStoreOptions
// ---------------------------------------------------------------------------

export interface DoltStateStoreOptions {
  repoPath: string
  client: DoltClient
}

// ---------------------------------------------------------------------------
// DoltStateStore
// ---------------------------------------------------------------------------

/**
 * Dolt-backed implementation of the StateStore interface.
 *
 * Constructor accepts a deps object for DI: `{ repoPath, client }`.
 * Call `initialize()` before any CRUD operations.
 */
export class DoltStateStore implements StateStore {
  private readonly _repoPath: string
  private readonly _client: DoltClient

  constructor(options: DoltStateStoreOptions) {
    this._repoPath = options.repoPath
    this._client = options.client
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await this._client.connect()
    await this._runMigrations()
    log.debug('DoltStateStore initialized at %s', this._repoPath)
  }

  async close(): Promise<void> {
    await this._client.close()
  }

  // ---------------------------------------------------------------------------
  // Schema migrations — idempotent, columns aligned with schema.sql (26-2)
  // ---------------------------------------------------------------------------

  private async _runMigrations(): Promise<void> {
    const ddl = [
      // stories: adds review_cycles, last_verdict, error, started_at on top of
      // the base schema.sql so the StateStore fields are fully supported.
      `CREATE TABLE IF NOT EXISTS stories (
        story_key     VARCHAR(100) NOT NULL,
        phase         VARCHAR(30)  NOT NULL DEFAULT 'PENDING',
        review_cycles INT          NOT NULL DEFAULT 0,
        last_verdict  VARCHAR(64)  NULL,
        error         TEXT         NULL,
        started_at    VARCHAR(64)  NULL,
        completed_at  VARCHAR(64)  NULL,
        sprint        VARCHAR(50)  NULL,
        PRIMARY KEY (story_key)
      )`,
      // metrics: composite PK matches schema.sql; nullable columns for partial records.
      `CREATE TABLE IF NOT EXISTS metrics (
        id              BIGINT       NOT NULL AUTO_INCREMENT,
        story_key       VARCHAR(100) NOT NULL,
        task_type       VARCHAR(100) NOT NULL,
        model           VARCHAR(100) NULL,
        tokens_in       BIGINT       NULL,
        tokens_out      BIGINT       NULL,
        cache_read_tokens BIGINT     NULL,
        cost_usd        DOUBLE       NULL,
        wall_clock_ms   BIGINT       NULL,
        review_cycles   INT          NULL,
        stall_count     INT          NULL,
        result          VARCHAR(30)  NULL,
        recorded_at     VARCHAR(64)  NULL,
        PRIMARY KEY (id)
      )`,
      // contracts: contract_name, schema_path, transport — direction is PK component.
      `CREATE TABLE IF NOT EXISTS contracts (
        story_key     VARCHAR(100) NOT NULL,
        contract_name VARCHAR(200) NOT NULL,
        direction     VARCHAR(20)  NOT NULL,
        schema_path   VARCHAR(500) NULL,
        transport     VARCHAR(200) NULL,
        PRIMARY KEY (story_key, contract_name, direction)
      )`,
    ]

    for (const sql of ddl) {
      await this._client.query(sql)
    }
    log.debug('Schema migrations applied')
  }

  // ---------------------------------------------------------------------------
  // Explicit commit (flush)
  // ---------------------------------------------------------------------------

  /**
   * Commit pending Dolt changes on the current branch.
   * Callers can invoke this after a batch of writes for explicit durability.
   */
  async flush(message = 'substrate: auto-commit'): Promise<void> {
    try {
      await execFile('dolt', ['add', '.'], { cwd: this._repoPath })
      await execFile('dolt', ['commit', '--allow-empty', '-m', message], { cwd: this._repoPath })
      log.debug('Dolt flush committed: %s', message)
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      log.warn({ detail }, 'Dolt flush failed (non-fatal)')
    }
  }

  // ---------------------------------------------------------------------------
  // Story state
  // ---------------------------------------------------------------------------

  async getStoryState(storyKey: string): Promise<StoryRecord | undefined> {
    const rows = await this._client.query<StoryRow>(
      'SELECT * FROM stories WHERE story_key = ?',
      [storyKey],
    )
    if (rows.length === 0) return undefined
    return this._rowToStory(rows[0])
  }

  async setStoryState(storyKey: string, state: StoryRecord): Promise<void> {
    // REPLACE INTO handles both insert and update atomically.
    const sql = `REPLACE INTO stories
      (story_key, phase, review_cycles, last_verdict, error, started_at, completed_at, sprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    await this._client.query(sql, [
      storyKey,
      state.phase,
      state.reviewCycles,
      state.lastVerdict ?? null,
      state.error ?? null,
      state.startedAt ?? null,
      state.completedAt ?? null,
      state.sprint ?? null,
    ])
  }

  async queryStories<T extends StoryFilter>(filter: T): Promise<StoryRecord[]> {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.phase !== undefined) {
      const phases = Array.isArray(filter.phase) ? filter.phase : [filter.phase]
      const placeholders = phases.map(() => '?').join(', ')
      conditions.push(`phase IN (${placeholders})`)
      params.push(...phases)
    }

    if (filter.sprint !== undefined) {
      conditions.push('sprint = ?')
      params.push(filter.sprint)
    }

    if (filter.storyKey !== undefined) {
      conditions.push('story_key = ?')
      params.push(filter.storyKey)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `SELECT * FROM stories ${where} ORDER BY story_key`
    const rows = await this._client.query<StoryRow>(sql, params)
    return rows.map((r) => this._rowToStory(r))
  }

  private _rowToStory(row: StoryRow): StoryRecord {
    return {
      storyKey: row.story_key,
      phase: row.phase as StoryPhase,
      reviewCycles: Number(row.review_cycles),
      lastVerdict: row.last_verdict ?? undefined,
      error: row.error ?? undefined,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      sprint: row.sprint ?? undefined,
    }
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  async recordMetric(metric: MetricRecord): Promise<void> {
    const recordedAt = metric.recordedAt ?? new Date().toISOString()
    const sql = `INSERT INTO metrics
      (story_key, task_type, model, tokens_in, tokens_out, cache_read_tokens,
       cost_usd, wall_clock_ms, review_cycles, stall_count, result, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    await this._client.query(sql, [
      metric.storyKey,
      metric.taskType,
      metric.model ?? null,
      metric.tokensIn ?? null,
      metric.tokensOut ?? null,
      metric.cacheReadTokens ?? null,
      metric.costUsd ?? null,
      metric.wallClockMs ?? null,
      metric.reviewCycles ?? null,
      metric.stallCount ?? null,
      metric.result ?? null,
      recordedAt,
    ])
  }

  async queryMetrics(filter: MetricFilter): Promise<MetricRecord[]> {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.storyKey !== undefined) {
      conditions.push('story_key = ?')
      params.push(filter.storyKey)
    }
    if (filter.taskType !== undefined) {
      conditions.push('task_type = ?')
      params.push(filter.taskType)
    }
    if (filter.dateFrom !== undefined) {
      conditions.push('recorded_at >= ?')
      params.push(filter.dateFrom)
    }
    if (filter.dateTo !== undefined) {
      conditions.push('recorded_at <= ?')
      params.push(filter.dateTo)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `SELECT * FROM metrics ${where} ORDER BY id`
    const rows = await this._client.query<MetricRow>(sql, params)
    return rows.map((r) => this._rowToMetric(r))
  }

  private _rowToMetric(row: MetricRow): MetricRecord {
    return {
      storyKey: row.story_key,
      taskType: row.task_type,
      model: row.model ?? undefined,
      tokensIn: row.tokens_in ?? undefined,
      tokensOut: row.tokens_out ?? undefined,
      cacheReadTokens: row.cache_read_tokens ?? undefined,
      costUsd: row.cost_usd ?? undefined,
      wallClockMs: row.wall_clock_ms ?? undefined,
      reviewCycles: row.review_cycles ?? undefined,
      stallCount: row.stall_count ?? undefined,
      result: row.result ?? undefined,
      recordedAt: row.recorded_at ?? undefined,
    }
  }

  // ---------------------------------------------------------------------------
  // Contracts
  // ---------------------------------------------------------------------------

  async getContracts(storyKey: string): Promise<ContractRecord[]> {
    const rows = await this._client.query<ContractRow>(
      'SELECT * FROM contracts WHERE story_key = ? ORDER BY contract_name',
      [storyKey],
    )
    return rows.map((r) => this._rowToContract(r))
  }

  async setContracts(storyKey: string, contracts: ContractRecord[]): Promise<void> {
    // Delete existing contracts for the story, then insert the new set.
    await this._client.query('DELETE FROM contracts WHERE story_key = ?', [storyKey])
    for (const c of contracts) {
      await this._client.query(
        `INSERT INTO contracts (story_key, contract_name, direction, schema_path, transport)
         VALUES (?, ?, ?, ?, ?)`,
        [c.storyKey, c.contractName, c.direction, c.schemaPath, c.transport ?? null],
      )
    }
  }

  private _rowToContract(row: ContractRow): ContractRecord {
    return {
      storyKey: row.story_key,
      contractName: row.contract_name,
      direction: row.direction as 'export' | 'import',
      schemaPath: row.schema_path,
      transport: row.transport ?? undefined,
    }
  }

  // ---------------------------------------------------------------------------
  // Branching
  // ---------------------------------------------------------------------------

  private _branchName(storyKey: string): string {
    return `story-${storyKey}`
  }

  async branchForStory(storyKey: string): Promise<void> {
    const branch = this._branchName(storyKey)
    try {
      await execFile('dolt', ['checkout', '-b', branch], { cwd: this._repoPath })
      log.debug('Created branch %s', branch)
    } catch {
      // If branch already exists, checkout without -b
      try {
        await execFile('dolt', ['checkout', branch], { cwd: this._repoPath })
        log.debug('Checked out existing branch %s', branch)
      } catch (err2: unknown) {
        const detail = err2 instanceof Error ? err2.message : String(err2)
        throw new DoltQueryError(`dolt checkout -b ${branch}`, detail)
      }
    }
  }

  async mergeStory(storyKey: string): Promise<void> {
    const branch = this._branchName(storyKey)
    try {
      await execFile('dolt', ['checkout', 'main'], { cwd: this._repoPath })
      await execFile('dolt', ['merge', branch, '--no-ff', '-m', `Merge ${branch}`], { cwd: this._repoPath })
      log.debug('Merged branch %s into main', branch)
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new DoltQueryError(`dolt merge ${branch}`, detail)
    }
  }

  async rollbackStory(storyKey: string): Promise<void> {
    const branch = this._branchName(storyKey)
    try {
      await execFile('dolt', ['checkout', 'main'], { cwd: this._repoPath })
      await execFile('dolt', ['branch', '-D', branch], { cwd: this._repoPath })
      log.debug('Rolled back (deleted) branch %s', branch)
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      log.warn({ detail }, 'rollbackStory failed for %s (non-fatal)', branch)
    }
  }

  async diffStory(storyKey: string): Promise<StateDiff> {
    const branch = this._branchName(storyKey)
    const tables = ['stories', 'metrics', 'contracts']
    const changes: StateDiff['changes'] = []

    for (const table of tables) {
      try {
        const rows = await this._client.query<DiffRow>(
          `SELECT * FROM dolt_diff_${table} WHERE from_commit = 'main' AND to_commit = ?`,
          [branch],
        )
        for (const row of rows) {
          changes.push({
            table,
            rowKey: String(row.to_story_key ?? row.from_story_key ?? row.to_id ?? row.from_id ?? ''),
            before: row.diff_type === 'added' ? undefined : row,
            after: row.diff_type === 'removed' ? undefined : row,
          })
        }
      } catch {
        // diffStory is best-effort; log and continue
        log.debug('diffStory: could not diff table %s for branch %s', table, branch)
      }
    }

    return { storyKey, changes }
  }
}
