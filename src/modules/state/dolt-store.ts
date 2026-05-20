/**
 * DoltStateStore — Dolt SQL backend implementing the `DoltOperatorReader`
 * interface for CLI operator commands.
 *
 * Provides:
 *  - Dolt commit-log reads (`getHistory` via `dolt_log` system table)
 *  - In-memory key-value metrics (`setMetric`/`getMetric`) scoped by runId
 *
 * Ship 1 (v0.20.92) excised the conflicted-shape DDL + CRUD for `stories`,
 * `contracts`, `metrics`, `review_verdicts`. Ship 8 (v0.20.99) dropped those
 * six legacy tables outright (per the empirical-emptiness audit) and removed
 * the residual v5→v6 `repo_map_symbols.dependencies` ALTER from initialize().
 * Ship 9 (v0.20.100) decommissioned the branch-lifecycle helpers
 * (`branchForStory`/`mergeStory`/`rollbackStory`/`flush`) — they were
 * unreachable from production because the orchestrator wires FileStateStore
 * (no-op stubs), not DoltStateStore.
 *
 * The `DoltOperatorReader` interface (a subset of the pre-Ship-1 `StateStore`)
 * is what DoltStateStore supports today: history reads + per-run KV metrics.
 */
import { createLogger } from '../../utils/logger.js'
import type { DoltClient } from './dolt-client.js'
import type { DoltOperatorReader, HistoryEntry } from './types.js'
import { DoltQueryError } from './errors.js'
const log = createLogger('modules:state:dolt')

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
