/**
 * FileStateStore — file/in-memory backend for the StateStore interface.
 *
 * Story state is kept in an in-memory Map (mirroring the _stories Map in
 * orchestrator-impl.ts). Metrics are stored in-memory when no SQLite DB is
 * provided, or delegated to writeStoryMetrics when a DB is available.
 * Contracts are stored in-memory. Branch operations are no-ops.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { writeStoryMetrics } from '../../persistence/queries/metrics.js'
import type {
  StateStore,
  StoryRecord,
  StoryFilter,
  MetricRecord,
  MetricFilter,
  ContractRecord,
  StateDiff,
} from './types.js'

// ---------------------------------------------------------------------------
// FileStateStoreOptions
// ---------------------------------------------------------------------------

export interface FileStateStoreOptions {
  /** Optional SQLite DB for metric persistence. When absent, metrics are in-memory. */
  db?: BetterSqlite3Database
  /** Optional base path (reserved for future file-system persistence). */
  basePath?: string
}

// ---------------------------------------------------------------------------
// FileStateStore
// ---------------------------------------------------------------------------

/**
 * In-memory / file-backed StateStore implementation.
 *
 * Suitable for the current pipeline where orchestrator state is ephemeral and
 * metrics can optionally be flushed to SQLite. Replace with DoltStateStore
 * (story 26-3) to gain branch-per-story isolation and versioned history.
 */
export class FileStateStore implements StateStore {
  private readonly _db: BetterSqlite3Database | undefined
  private readonly _stories: Map<string, StoryRecord> = new Map()
  private readonly _metrics: MetricRecord[] = []
  private readonly _contracts: Map<string, ContractRecord[]> = new Map()

  constructor(options: FileStateStoreOptions = {}) {
    this._db = options.db
  }

  // -- Lifecycle -------------------------------------------------------------

  async initialize(): Promise<void> {
    // No-op for file backend.
  }

  async close(): Promise<void> {
    // No-op for file backend.
  }

  // -- Story state -----------------------------------------------------------

  async getStoryState(storyKey: string): Promise<StoryRecord | undefined> {
    return this._stories.get(storyKey)
  }

  async setStoryState(storyKey: string, state: StoryRecord): Promise<void> {
    this._stories.set(storyKey, { ...state, storyKey })
  }

  async queryStories<T extends StoryFilter>(filter: T): Promise<StoryRecord[]> {
    const all = Array.from(this._stories.values())

    return all.filter((record) => {
      // Phase filter — accepts a single phase or an array of phases.
      if (filter.phase !== undefined) {
        const phases = Array.isArray(filter.phase) ? filter.phase : [filter.phase]
        if (!phases.includes(record.phase)) return false
      }

      // Sprint filter.
      if (filter.sprint !== undefined && record.sprint !== filter.sprint) {
        return false
      }

      // Story key filter.
      if (filter.storyKey !== undefined && record.storyKey !== filter.storyKey) {
        return false
      }

      return true
    })
  }

  // -- Metrics ---------------------------------------------------------------

  async recordMetric(metric: MetricRecord): Promise<void> {
    // Always store in the in-memory array so queryMetrics works without a DB.
    const record: MetricRecord = {
      ...metric,
      recordedAt: metric.recordedAt ?? new Date().toISOString(),
    }
    this._metrics.push(record)

    // Additionally persist to SQLite when a DB is available.
    if (this._db) {
      writeStoryMetrics(this._db, {
        run_id: 'default',
        story_key: metric.storyKey,
        result: metric.result ?? 'unknown',
        wall_clock_seconds: metric.wallClockMs !== undefined ? metric.wallClockMs / 1000 : undefined,
        input_tokens: metric.tokensIn,
        output_tokens: metric.tokensOut,
        cost_usd: metric.costUsd,
        review_cycles: metric.reviewCycles,
      })
    }
  }

  async queryMetrics(filter: MetricFilter): Promise<MetricRecord[]> {
    return this._metrics.filter((m) => {
      if (filter.storyKey !== undefined && m.storyKey !== filter.storyKey) return false
      if (filter.taskType !== undefined && m.taskType !== filter.taskType) return false
      if (filter.dateFrom !== undefined && m.recordedAt !== undefined && m.recordedAt < filter.dateFrom) return false
      if (filter.dateTo !== undefined && m.recordedAt !== undefined && m.recordedAt > filter.dateTo) return false
      return true
    })
  }

  // -- Contracts -------------------------------------------------------------

  async getContracts(storyKey: string): Promise<ContractRecord[]> {
    return this._contracts.get(storyKey) ?? []
  }

  async setContracts(storyKey: string, contracts: ContractRecord[]): Promise<void> {
    this._contracts.set(storyKey, contracts.map((c) => ({ ...c })))
  }

  // -- Branching (no-ops for file backend) -----------------------------------

  async branchForStory(_storyKey: string): Promise<void> {
    // No-op: file backend has no branching capability.
  }

  async mergeStory(_storyKey: string): Promise<void> {
    // No-op: file backend has no branching capability.
  }

  async rollbackStory(_storyKey: string): Promise<void> {
    // No-op: file backend has no branching capability.
  }

  async diffStory(storyKey: string): Promise<StateDiff> {
    // No diff available in the file backend.
    return { storyKey, changes: [] }
  }
}
