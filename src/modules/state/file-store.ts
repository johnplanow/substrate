/**
 * FileStateStore — file/in-memory backend for the StateStore interface.
 *
 * Story state is kept in an in-memory Map (mirroring the _stories Map in
 * orchestrator-impl.ts). Metrics are stored entirely in-memory.
 * Contracts are stored in-memory. Branch operations are no-ops.
 */

import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  StateStore,
  StoryRecord,
  StoryFilter,
  MetricRecord,
  MetricFilter,
  ContractRecord,
  ContractFilter,
  ContractVerificationRecord,
  StoryDiff,
  HistoryEntry,
} from './types.js'

// ---------------------------------------------------------------------------
// FileStateStoreOptions
// ---------------------------------------------------------------------------

export interface FileStateStoreOptions {
  /** Optional base path (reserved for future file-system persistence). */
  basePath?: string
}

// ---------------------------------------------------------------------------
// FileStateStore
// ---------------------------------------------------------------------------

/**
 * In-memory / file-backed StateStore implementation.
 *
 * Suitable for CI environments and testing where orchestrator state is
 * ephemeral. Use DoltStateStore for branch-per-story isolation and versioned
 * history in production.
 */
export class FileStateStore implements StateStore {
  private readonly _basePath: string | undefined
  private readonly _stories: Map<string, StoryRecord> = new Map()
  private readonly _metrics: MetricRecord[] = []
  private readonly _contracts: Map<string, ContractRecord[]> = new Map()
  private readonly _contractVerifications: Map<string, ContractVerificationRecord[]> = new Map()
  /** Key-value metrics store: outer key = runId, inner key = metric key */
  private readonly _kvMetrics: Map<string, Map<string, unknown>> = new Map()

  constructor(options: FileStateStoreOptions = {}) {
    this._basePath = options.basePath
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
    const record: MetricRecord = {
      ...metric,
      recordedAt: metric.recordedAt ?? new Date().toISOString(),
    }
    this._metrics.push(record)
  }

  async queryMetrics(filter: MetricFilter): Promise<MetricRecord[]> {
    // Support both camelCase and snake_case field aliases
    const storyKey = filter.storyKey ?? filter.story_key
    const taskType = filter.taskType ?? filter.task_type

    return this._metrics.filter((m) => {
      if (storyKey !== undefined && m.storyKey !== storyKey) return false
      if (taskType !== undefined && m.taskType !== taskType) return false
      if (filter.sprint !== undefined && m.sprint !== filter.sprint) return false
      if (filter.dateFrom !== undefined && m.recordedAt !== undefined && m.recordedAt < filter.dateFrom) return false
      if (filter.dateTo !== undefined && m.recordedAt !== undefined && m.recordedAt > filter.dateTo) return false
      if (filter.since !== undefined && m.recordedAt !== undefined && m.recordedAt < filter.since) return false
      return true
    })
  }

  // -- Key-value metrics (story 28-6) ----------------------------------------

  /**
   * Persist an arbitrary key-value metric for a run.
   * Stored in memory AND written to `{basePath}/kv-metrics.json` when basePath is set.
   */
  async setMetric(runId: string, key: string, value: unknown): Promise<void> {
    // Update in-memory store
    let runMap = this._kvMetrics.get(runId)
    if (runMap === undefined) {
      runMap = new Map()
      this._kvMetrics.set(runId, runMap)
    }
    runMap.set(key, value)

    // Persist to file when basePath is configured
    if (this._basePath !== undefined) {
      await this._flushKvMetrics()
    }
  }

  /**
   * Retrieve a previously stored key-value metric for a run.
   * Reads from in-memory cache, falling back to the JSON file when basePath is set.
   */
  async getMetric(runId: string, key: string): Promise<unknown> {
    // Check in-memory first
    const inMemory = this._kvMetrics.get(runId)?.get(key)
    if (inMemory !== undefined) return inMemory

    // Attempt file-based read when basePath is configured
    if (this._basePath !== undefined) {
      try {
        const filePath = join(this._basePath, 'kv-metrics.json')
        const content = await readFile(filePath, 'utf-8')
        const parsed = JSON.parse(content) as Record<string, Record<string, unknown>>
        return parsed[runId]?.[key] ?? undefined
      } catch {
        // ignore read errors (file not found, parse error, etc.) — return undefined
      }
    }
    return undefined
  }

  /** Serialize the in-memory kv metrics map to JSON on disk. */
  private async _flushKvMetrics(): Promise<void> {
    if (this._basePath === undefined) return
    const serialized: Record<string, Record<string, unknown>> = {}
    for (const [runId, runMap] of this._kvMetrics) {
      serialized[runId] = {}
      for (const [key, value] of runMap) {
        serialized[runId][key] = value
      }
    }
    const filePath = join(this._basePath, 'kv-metrics.json')
    await writeFile(filePath, JSON.stringify(serialized, null, 2), 'utf-8')
  }

  // -- Contracts -------------------------------------------------------------

  async getContracts(storyKey: string): Promise<ContractRecord[]> {
    return this._contracts.get(storyKey) ?? []
  }

  async setContracts(storyKey: string, contracts: ContractRecord[]): Promise<void> {
    this._contracts.set(storyKey, contracts.map((c) => ({ ...c })))
  }

  async queryContracts(filter?: ContractFilter): Promise<ContractRecord[]> {
    const all: ContractRecord[] = []
    for (const records of this._contracts.values()) {
      for (const r of records) {
        all.push(r)
      }
    }

    return all.filter((r) => {
      if (filter?.storyKey !== undefined && r.storyKey !== filter.storyKey) return false
      if (filter?.direction !== undefined && r.direction !== filter.direction) return false
      return true
    })
  }

  async setContractVerification(storyKey: string, results: ContractVerificationRecord[]): Promise<void> {
    this._contractVerifications.set(storyKey, results.map((r) => ({ ...r })))

    if (this._basePath !== undefined) {
      // Serialize the full map as a flat JSON object: { storyKey: records[] }
      const serialized: Record<string, ContractVerificationRecord[]> = {}
      for (const [key, records] of this._contractVerifications) {
        serialized[key] = records
      }
      const filePath = join(this._basePath, 'contract-verifications.json')
      await writeFile(filePath, JSON.stringify(serialized, null, 2), 'utf-8')
    }
  }

  async getContractVerification(storyKey: string): Promise<ContractVerificationRecord[]> {
    return this._contractVerifications.get(storyKey) ?? []
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

  async diffStory(storyKey: string): Promise<StoryDiff> {
    // No diff available in the file backend.
    return { storyKey, tables: [] }
  }

  async getHistory(_limit?: number): Promise<HistoryEntry[]> {
    // No commit history in the file backend.
    return []
  }
}
