/**
 * DoltStateStore — Dolt SQL backend implementing the `DoltOperatorReader`
 * interface for CLI operator commands.
 *
 * Provides:
 *  - Dolt commit-log reads (`getHistory` via `dolt_log` system table)
 *  - In-memory key-value metrics (`setMetric`/`getMetric`) scoped by runId
 *  - Branch lifecycle helpers (`branchForStory`/`mergeStory`/`rollbackStory`)
 *    used by orchestrator-side branching code paths
 *
 * Ship 1 (v0.20.92) excised the conflicted-shape DDL + CRUD for `stories`,
 * `contracts`, `metrics`, `review_verdicts`. Ship 8 (v0.20.99) dropped those
 * six legacy tables outright (per the empirical-emptiness audit) and removed
 * the residual v5→v6 `repo_map_symbols.dependencies` ALTER from initialize()
 * — the CREATE TABLE in `repo-map-schema.ts:initRepoMapSchema` defines the
 * column directly. The `DoltOperatorReader` interface (a subset of the
 * pre-Ship-1 `StateStore`) reflects what DoltStateStore can support today.
 */
import { createLogger } from '../../utils/logger.js'
import type { DoltClient } from './dolt-client.js'
import type { DoltOperatorReader, HistoryEntry } from './types.js'
import { DoltQueryError, DoltMergeConflictError } from './errors.js'
const log = createLogger('modules:state:dolt')

/**
 * Validate that a story key matches the expected pattern (e.g. "26-7", "1-1a", "NEW-26", "E6").
 * Prevents SQL injection via string-interpolated identifiers.
 */
const STORY_KEY_PATTERN = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)?$/
function assertValidStoryKey(storyKey: string): void {
  if (!STORY_KEY_PATTERN.test(storyKey)) {
    throw new DoltQueryError('assertValidStoryKey', `Invalid story key: '${storyKey}'. Must match pattern <key> or <epic>-<story> (e.g. "E6", "10-1", "1-1a", "NEW-26").`)
  }
}

interface MergeResultRow {
  hash: string
  fast_forward: number
  conflicts: number
  message: string
}

type ConflictRow = Record<string, unknown>

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

export class DoltStateStore implements DoltOperatorReader {
  private readonly _repoPath: string
  private readonly _client: DoltClient
  private readonly _storyBranches: Map<string, string> = new Map()
  /** In-memory KV store for per-run arbitrary metrics. Not persisted to Dolt. */
  private readonly _kvMetrics: Map<string, Map<string, unknown>> = new Map()

  constructor(options: DoltStateStoreOptions) {
    this._repoPath = options.repoPath
    this._client = options.client
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await this._client.connect()
    log.debug('DoltStateStore initialized at %s', this._repoPath)
  }

  async close(): Promise<void> {
    await this._client.close()
  }

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
  // Branching
  // ---------------------------------------------------------------------------

  async branchForStory(storyKey: string): Promise<void> {
    assertValidStoryKey(storyKey)
    const branchName = `story/${storyKey}`
    try {
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
      try {
        await this._client.query(`CALL DOLT_ADD('-A')`, [], branchName)
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
      const mergeResult = mergeRows[0]
      if (mergeResult && (mergeResult.conflicts ?? 0) > 0) {
        // Conflict-detail lookup is best-effort; the legacy `stories` conflict
        // table no longer exists post-Ship-1, so we report the conflict with
        // unknown row context rather than failing the merge silently.
        let table = 'unknown'
        let rowKey = 'unknown'
        let ourValue: string | undefined
        let theirValue: string | undefined
        try {
          const conflictRows = await this._client.query<ConflictRow>(
            `SELECT table_name FROM dolt_conflicts LIMIT 1`,
            [],
            'main',
          )
          if (conflictRows.length > 0) {
            table = String(conflictRows[0]['table_name'] ?? 'unknown')
          }
        } catch {
          // best-effort
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
  // Key-value metrics (in-memory; not persisted to Dolt)
  // ---------------------------------------------------------------------------

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
