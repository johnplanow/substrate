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
import { createLogger } from '../../utils/logger.js'
import type { DoltClient } from './dolt-client.js'
import type {
  StateStore,
  StoryRecord,
  StoryFilter,
  MetricRecord,
  MetricFilter,
  AggregateMetricResult,
  ContractRecord,
  ContractFilter,
  ContractVerificationRecord,
  StoryDiff,
  TableDiff,
  DiffRow,
  HistoryEntry,
} from './types.js'
import type { StoryPhase } from '../implementation-orchestrator/types.js'
import { DoltQueryError, DoltMergeConflictError } from './errors.js'
const log = createLogger('modules:state:dolt')

/**
 * Validate that a story key matches the expected pattern (e.g. "26-7").
 * Prevents SQL injection via string-interpolated identifiers.
 */
const STORY_KEY_PATTERN = /^[0-9]+-[0-9]+$/
function assertValidStoryKey(storyKey: string): void {
  if (!STORY_KEY_PATTERN.test(storyKey)) {
    throw new DoltQueryError('assertValidStoryKey', `Invalid story key: '${storyKey}'. Must match pattern <number>-<number>.`)
  }
}

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
  sprint: string | null
  timestamp: string | null
}

interface AggregateMetricRow {
  task_type: string
  avg_cost_usd: number | null
  sum_tokens_in: number | null
  sum_tokens_out: number | null
  count: number
}

interface ContractRow {
  story_key: string
  contract_name: string
  direction: string
  schema_path: string
  transport: string | null
}

interface ReviewVerdictRow {
  story_key: string
  task_type: string
  verdict: string
  issues_count: number | null
  notes: string | null
  timestamp: string | null
}

interface MergeResultRow {
  hash: string
  fast_forward: number
  conflicts: number
  message: string
}

interface ConflictRow {
  [key: string]: unknown
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
  private readonly _storyBranches: Map<string, string> = new Map()

  constructor(options: DoltStateStoreOptions) {
    this._repoPath = options.repoPath
    this._client = options.client
  }

  /**
   * Return the branch name for a story if one has been created via branchForStory(),
   * or undefined to use the default (main) branch.
   */
  private _branchFor(storyKey: string): string | undefined {
    return this._storyBranches.get(storyKey)
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await this._client.connect()
    await this._runMigrations()
    // Commit schema changes so branches created via branchForStory()
    // fork from a commit that includes the tables.
    await this.flush('substrate: schema migrations')
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
        sprint          VARCHAR(50)  NULL,
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
      // review_verdicts: stores contract verification results and other post-review verdicts.
      `CREATE TABLE IF NOT EXISTS review_verdicts (
        id            BIGINT       NOT NULL AUTO_INCREMENT,
        story_key     VARCHAR(100) NOT NULL,
        task_type     VARCHAR(100) NOT NULL,
        verdict       VARCHAR(64)  NOT NULL,
        issues_count  INT          NULL,
        notes         TEXT         NULL,
        timestamp     VARCHAR(64)  NULL,
        PRIMARY KEY (id)
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
      await this._client.execArgs(['add', '.'])
      await this._client.execArgs(['commit', '--allow-empty', '-m', message])
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
    const branch = this._branchFor(storyKey)
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
    ], branch)
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
    const branch = this._branchFor(metric.storyKey)
    const recordedAt = metric.recordedAt ?? metric.timestamp ?? new Date().toISOString()
    const sql = `INSERT INTO metrics
      (story_key, task_type, model, tokens_in, tokens_out, cache_read_tokens,
       cost_usd, wall_clock_ms, review_cycles, stall_count, result, recorded_at, sprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      metric.sprint ?? null,
    ], branch)
  }

  async queryMetrics(filter: MetricFilter): Promise<MetricRecord[]> {
    const conditions: string[] = []
    const params: unknown[] = []

    // Support both camelCase and snake_case field aliases
    const storyKey = filter.storyKey ?? filter.story_key
    const taskType = filter.taskType ?? filter.task_type

    if (storyKey !== undefined) {
      conditions.push('story_key = ?')
      params.push(storyKey)
    }
    if (taskType !== undefined) {
      conditions.push('task_type = ?')
      params.push(taskType)
    }
    if (filter.sprint !== undefined) {
      conditions.push('sprint = ?')
      params.push(filter.sprint)
    }
    if (filter.dateFrom !== undefined) {
      conditions.push('recorded_at >= ?')
      params.push(filter.dateFrom)
    }
    if (filter.dateTo !== undefined) {
      conditions.push('recorded_at <= ?')
      params.push(filter.dateTo)
    }
    if (filter.since !== undefined) {
      conditions.push('recorded_at >= ?')
      params.push(filter.since)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    if (filter.aggregate) {
      const sql = `SELECT task_type,
        AVG(cost_usd) AS avg_cost_usd,
        SUM(tokens_in) AS sum_tokens_in,
        SUM(tokens_out) AS sum_tokens_out,
        COUNT(*) AS count
        FROM metrics ${where} GROUP BY task_type ORDER BY task_type`
      const aggRows = await this._client.query<AggregateMetricRow>(sql, params)
      return aggRows.map((r) => this._aggregateRowToMetric(r))
    }

    const sql = `SELECT * FROM metrics ${where} ORDER BY id`
    const rows = await this._client.query<MetricRow>(sql, params)
    return rows.map((r) => this._rowToMetric(r))
  }

  private _aggregateRowToMetric(row: AggregateMetricRow): MetricRecord {
    return {
      storyKey: '',
      taskType: row.task_type,
      costUsd: row.avg_cost_usd ?? undefined,
      tokensIn: row.sum_tokens_in ?? undefined,
      tokensOut: row.sum_tokens_out ?? undefined,
      count: row.count,
      result: 'aggregate',
    }
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
      sprint: row.sprint ?? undefined,
      timestamp: row.timestamp ?? row.recorded_at ?? undefined,
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
    const branch = this._branchFor(storyKey)
    await this._client.query('DELETE FROM contracts WHERE story_key = ?', [storyKey], branch)
    for (const c of contracts) {
      await this._client.query(
        `INSERT INTO contracts (story_key, contract_name, direction, schema_path, transport)
         VALUES (?, ?, ?, ?, ?)`,
        [c.storyKey, c.contractName, c.direction, c.schemaPath, c.transport ?? null],
        branch,
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

  async queryContracts(filter?: ContractFilter): Promise<ContractRecord[]> {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter?.storyKey !== undefined) {
      conditions.push('story_key = ?')
      params.push(filter.storyKey)
    }
    if (filter?.direction !== undefined) {
      conditions.push('direction = ?')
      params.push(filter.direction)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `SELECT * FROM contracts ${where} ORDER BY story_key, contract_name`
    const rows = await this._client.query<ContractRow>(sql, params)
    return rows.map((r) => this._rowToContract(r))
  }

  async setContractVerification(storyKey: string, results: ContractVerificationRecord[]): Promise<void> {
    const branch = this._branchFor(storyKey)
    await this._client.query(
      `DELETE FROM review_verdicts WHERE story_key = ? AND task_type = 'contract-verification'`,
      [storyKey],
      branch,
    )

    const failCount = results.filter((r) => r.verdict === 'fail').length

    for (const r of results) {
      await this._client.query(
        `INSERT INTO review_verdicts (story_key, task_type, verdict, issues_count, notes, timestamp)
         VALUES (?, 'contract-verification', ?, ?, ?, ?)`,
        [
          storyKey,
          r.verdict,
          failCount,
          JSON.stringify({ contractName: r.contractName, mismatchDescription: r.mismatchDescription }),
          r.verifiedAt,
        ],
        branch,
      )
    }

    // Note: Dolt commit on merge via mergeStory() — no explicit flush needed for branch-isolated writes
  }

  async getContractVerification(storyKey: string): Promise<ContractVerificationRecord[]> {
    const rows = await this._client.query<ReviewVerdictRow>(
      `SELECT * FROM review_verdicts WHERE story_key = ? AND task_type = 'contract-verification' ORDER BY timestamp DESC`,
      [storyKey],
    )

    return rows.map((row) => {
      let contractName = ''
      let mismatchDescription: string | undefined

      if (row.notes !== null) {
        try {
          const parsed = JSON.parse(row.notes) as Record<string, unknown>
          if (typeof parsed.contractName === 'string') contractName = parsed.contractName
          if (typeof parsed.mismatchDescription === 'string') mismatchDescription = parsed.mismatchDescription
        } catch {
          // Ignore malformed notes
        }
      }

      return {
        storyKey: row.story_key,
        contractName,
        verdict: row.verdict as 'pass' | 'fail',
        ...(mismatchDescription !== undefined ? { mismatchDescription } : {}),
        verifiedAt: row.timestamp ?? new Date().toISOString(),
      } satisfies ContractVerificationRecord
    })
  }

  // ---------------------------------------------------------------------------
  // Branching
  // ---------------------------------------------------------------------------

  async branchForStory(storyKey: string): Promise<void> {
    assertValidStoryKey(storyKey)
    const branchName = `story/${storyKey}`
    try {
      // Execute CALL DOLT_BRANCH on main to create the branch
      await this._client.query(`CALL DOLT_BRANCH('${branchName}')`, [], 'main')
      this._storyBranches.set(storyKey, branchName)
      log.debug('Created Dolt branch %s for story %s', branchName, storyKey)
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new DoltQueryError(`CALL DOLT_BRANCH('${branchName}')`, detail)
    }
  }

  async mergeStory(storyKey: string): Promise<void> {
    assertValidStoryKey(storyKey)
    const branchName = this._storyBranches.get(storyKey)
    if (branchName === undefined) {
      log.warn({ storyKey }, 'mergeStory called but no branch registered — no-op')
      return
    }
    try {
      // Commit any pending writes on the story branch before merging.
      // Without this, writes remain in the working set and DOLT_MERGE
      // only sees the committed state.
      try {
        await this._client.query(
          `CALL DOLT_ADD('-A')`,
          [],
          branchName,
        )
        await this._client.query(
          `CALL DOLT_COMMIT('-m', 'Story ${storyKey}: pre-merge commit', '--allow-empty')`,
          [],
          branchName,
        )
      } catch {
        // Best-effort — branch may already be clean
      }

      // Commit any pending changes on main so DOLT_MERGE doesn't refuse
      // with "local changes would be stomped by merge".
      try {
        await this._client.query(`CALL DOLT_ADD('-A')`, [], 'main')
        await this._client.query(
          `CALL DOLT_COMMIT('-m', 'substrate: pre-merge auto-commit', '--allow-empty')`,
          [],
          'main',
        )
      } catch {
        // Best-effort — main may already be clean
      }

      // Merge the story branch into main
      const mergeRows = await this._client.query<MergeResultRow>(
        `CALL DOLT_MERGE('${branchName}')`,
        [],
        'main',
      )
      // Check for conflicts
      const mergeResult = mergeRows[0]
      if (mergeResult && (mergeResult.conflicts ?? 0) > 0) {
        // Query conflict details from the stories conflict table (best-effort)
        let table = 'stories'
        let rowKey = 'unknown'
        let ourValue: string | undefined
        let theirValue: string | undefined
        try {
          const conflictRows = await this._client.query<ConflictRow>(
            `SELECT * FROM dolt_conflicts_stories LIMIT 1`,
            [],
            'main',
          )
          if (conflictRows.length > 0) {
            const row = conflictRows[0]
            rowKey = String(row['base_story_key'] ?? row['our_story_key'] ?? 'unknown')
            ourValue = JSON.stringify(row['our_status'] ?? row)
            theirValue = JSON.stringify(row['their_status'] ?? row)
          }
        } catch {
          // best-effort — ignore errors querying conflict table
        }
        this._storyBranches.delete(storyKey)
        throw new DoltMergeConflictError(table, [rowKey], { rowKey, ourValue, theirValue })
      }
      // Commit the merge on main. Dolt may auto-commit fast-forward merges,
      // so "nothing to commit" is expected and safe to ignore.
      try {
        await this._client.query(
          `CALL DOLT_COMMIT('-m', 'Merge story ${storyKey}: COMPLETE')`,
          [],
          'main',
        )
      } catch (commitErr: unknown) {
        const msg = commitErr instanceof Error ? commitErr.message : String(commitErr)
        if (!msg.includes('nothing to commit')) throw commitErr
      }
      this._storyBranches.delete(storyKey)
      log.debug('Merged branch %s into main for story %s', branchName, storyKey)
    } catch (err: unknown) {
      if (err instanceof DoltMergeConflictError) throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new DoltQueryError(`CALL DOLT_MERGE('${branchName}')`, detail)
    }
  }

  async rollbackStory(storyKey: string): Promise<void> {
    assertValidStoryKey(storyKey)
    const branchName = this._storyBranches.get(storyKey)
    if (branchName === undefined) {
      log.warn({ storyKey }, 'rollbackStory called but no branch registered — no-op')
      return
    }
    try {
      await this._client.query(`CALL DOLT_BRANCH('-D', '${branchName}')`, [], 'main')
      this._storyBranches.delete(storyKey)
      log.debug('Rolled back (deleted) branch %s for story %s', branchName, storyKey)
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      log.warn({ detail, storyKey, branchName }, 'rollbackStory failed (non-fatal)')
      this._storyBranches.delete(storyKey)
    }
  }

  // ---------------------------------------------------------------------------
  // Diff (row-level via DOLT_DIFF SQL, Story 26-7)
  // ---------------------------------------------------------------------------

  /**
   * Tables queried by diffStory(). Each table is checked for row-level changes
   * via SELECT * FROM DOLT_DIFF('main', branchName, tableName).
   */
  private static readonly DIFF_TABLES = [
    'stories',
    'contracts',
    'metrics',
    'dispatch_log',
    'build_results',
    'review_verdicts',
  ] as const

  async diffStory(storyKey: string): Promise<StoryDiff> {
    assertValidStoryKey(storyKey)
    const branchName = this._storyBranches.get(storyKey)

    // If no in-memory branch, try to find the merge commit for an already-merged story
    if (branchName === undefined) {
      return this._diffMergedStory(storyKey)
    }

    // Commit pending (uncommitted) writes on the story branch so DOLT_DIFF
    // can see them — DOLT_DIFF only compares committed state.
    try {
      await this._client.query(`CALL DOLT_ADD('-A')`, [], branchName)
      await this._client.query(
        `CALL DOLT_COMMIT('-m', 'Story ${storyKey}: pre-diff snapshot', '--allow-empty')`,
        [],
        branchName,
      )
    } catch {
      // Best-effort — may fail if nothing to commit
    }

    return this._diffRange('main', branchName, storyKey)
  }

  /**
   * Diff a merged story by finding its merge commit in the Dolt log.
   * Queries the `dolt_log` system table for commits referencing the story,
   * then diffs `<hash>~1` vs `<hash>` for row-level changes.
   */
  private async _diffMergedStory(storyKey: string): Promise<StoryDiff> {
    try {
      const rows = await this._client.query<{ commit_hash: string }>(
        `SELECT commit_hash FROM dolt_log WHERE message LIKE ? LIMIT 1`,
        [`%${storyKey}%`],
      )
      if (rows.length === 0) {
        return { storyKey, tables: [] }
      }
      const hash = String(rows[0].commit_hash)
      if (!hash) {
        return { storyKey, tables: [] }
      }
      return this._diffRange(`${hash}~1`, hash, storyKey)
    } catch {
      // If log search fails (e.g. no merge commit found), return empty
      return { storyKey, tables: [] }
    }
  }

  /**
   * Compute row-level diffs between two Dolt revisions (branches or commit hashes)
   * across all tracked tables.
   */
  private async _diffRange(fromRef: string, toRef: string, storyKey: string): Promise<StoryDiff> {
    const tableDiffs: TableDiff[] = []

    for (const table of DoltStateStore.DIFF_TABLES) {
      try {
        const rows = await this._client.query<Record<string, unknown>>(
          `SELECT * FROM DOLT_DIFF('${fromRef}', '${toRef}', '${table}')`,
          [],
          'main',
        )

        if (rows.length === 0) continue

        const added: DiffRow[] = []
        const modified: DiffRow[] = []
        const deleted: DiffRow[] = []

        for (const row of rows) {
          const diffType = row['diff_type'] as string
          const rowKey = this._extractRowKey(row)
          const before = this._extractPrefixedFields(row, 'before_')
          const after = this._extractPrefixedFields(row, 'after_')
          const diffRow: DiffRow = { rowKey, ...(before !== undefined && { before }), ...(after !== undefined && { after }) }
          if (diffType === 'added') added.push(diffRow)
          else if (diffType === 'modified') modified.push(diffRow)
          else if (diffType === 'removed') deleted.push(diffRow)
        }

        if (added.length > 0 || modified.length > 0 || deleted.length > 0) {
          tableDiffs.push({ table, added, modified, deleted })
        }
      } catch {
        // Skip tables that do not exist or have no diff data
      }
    }

    return { storyKey, tables: tableDiffs }
  }

  /**
   * Extract a human-readable row key from a DOLT_DIFF result row.
   * Tries after_ fields first (for added/modified rows), then before_ fields
   * (for removed rows). Skips commit_hash pseudo-columns.
   */
  private _extractRowKey(row: Record<string, unknown>): string {
    for (const prefix of ['after_', 'before_']) {
      for (const [key, val] of Object.entries(row)) {
        if (key.startsWith(prefix) && !key.endsWith('_commit_hash') && val !== null && val !== undefined) {
          return String(val)
        }
      }
    }
    return 'unknown'
  }

  /**
   * Extract all fields with a given prefix from a DOLT_DIFF result row,
   * stripping the prefix from the key names. Returns undefined if no matching
   * fields are found.
   */
  private _extractPrefixedFields(
    row: Record<string, unknown>,
    prefix: string,
  ): Record<string, unknown> | undefined {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(row)) {
      if (key.startsWith(prefix)) {
        result[key.slice(prefix.length)] = val
      }
    }
    return Object.keys(result).length > 0 ? result : undefined
  }

  // ---------------------------------------------------------------------------
  // History (Story 26-9)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Key-value metrics (story 28-6)
  // ---------------------------------------------------------------------------

  /** In-memory KV store for per-run arbitrary metrics. Not persisted to Dolt. */
  private readonly _kvMetrics: Map<string, Map<string, unknown>> = new Map()

  async setMetric(runId: string, key: string, value: unknown): Promise<void> {
    let runMap = this._kvMetrics.get(runId)
    if (runMap === undefined) {
      runMap = new Map()
      this._kvMetrics.set(runId, runMap)
    }
    runMap.set(key, value)
  }

  async getMetric(runId: string, key: string): Promise<unknown> {
    return this._kvMetrics.get(runId)?.get(key)
  }

  // ---------------------------------------------------------------------------
  // History (Story 26-9)
  // ---------------------------------------------------------------------------

  async getHistory(limit?: number): Promise<HistoryEntry[]> {
    const effectiveLimit = limit ?? 20
    try {
      // Use dolt_log system table instead of CLI --format flag (not supported by Dolt)
      // dolt_log system table reflects the current branch; no branch parameter needed
      const rows = await this._client.query<Record<string, unknown>>(
        `SELECT commit_hash, date, message, committer FROM dolt_log LIMIT ?`,
        [effectiveLimit],
      )
      const entries: HistoryEntry[] = []
      for (const row of rows) {
        const hash = String(row.commit_hash ?? '')
        const dateVal = row.date
        const timestamp = dateVal instanceof Date
          ? dateVal.toISOString()
          : String(dateVal ?? '')
        const message = String(row.message ?? '')
        const author = row.committer ? String(row.committer) : undefined
        // Extract story key from message
        const storyKeyMatch = /story\/([0-9]+-[0-9]+)/i.exec(message)
        entries.push({
          hash,
          timestamp,
          storyKey: storyKeyMatch ? storyKeyMatch[1]! : null,
          message,
          author,
        })
      }
      return entries
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new DoltQueryError('getHistory', detail)
    }
  }
}
