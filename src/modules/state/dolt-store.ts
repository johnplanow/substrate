/**
 * DoltStateStore — Dolt SQL backend implementing the `DoltOperatorReader`
 * interface for CLI operator commands.
 *
 * Provides:
 *  - Dolt commit-log reads (`getHistory` via `dolt_log` system table)
 *  - In-memory key-value metrics (`setMetric`/`getMetric`) scoped by runId
 *
 * History — the schema-unification arc + Item 7 arc together excised every
 * pre-2026 write path on this class:
 *  - Ship 1 of schema-arc (v0.20.92): conflicted-shape CRUD for `stories`,
 *    `contracts`, `metrics`, `review_verdicts` excised after empirical audit
 *    found those tables empty in every production project
 *  - Ship 8 (v0.20.99): the six legacy tables dropped outright + v5→v6
 *    `repo_map_symbols.dependencies` ALTER removed from initialize()
 *  - Ship 9 (v0.20.100): branch-lifecycle helpers decommissioned —
 *    `branchForStory`/`mergeStory`/`rollbackStory`/`flush` had no production
 *    caller path (orchestrator's `stateStore?` was undefined)
 *  - Item 7 arc Ships 1-2 (v0.20.106/v0.20.107): orchestrator-side
 *    `StateStore` interface deleted entirely; the per-run KV needs of
 *    routing-tuner moved to the narrow `FileKvStore` class
 *
 * The `DoltOperatorReader` interface is what DoltStateStore supports today:
 * Dolt commit-log reads + per-run KV metrics (the latter is in-memory,
 * scoped by runId, used by CLI operator commands during a single invocation).
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
