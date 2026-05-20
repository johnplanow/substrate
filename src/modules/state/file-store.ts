/**
 * FileStateStore — in-memory backend for the StateStore interface.
 *
 * Story state, structured metrics, and contracts are kept in in-memory Maps
 * (mirroring the `_stories` Map in orchestrator-impl.ts). The data is
 * ephemeral — discarded at process end. Canonical persistent state lives in
 * the run manifest + initSchema-managed tables (pipeline_runs, story_metrics).
 *
 * The two persistence-bearing methods are `setMetric`/`getMetric` (key-value
 * scratch), which optionally write to `{basePath}/kv-metrics.json`, and
 * `setContractVerification`, which optionally writes `{basePath}/contract-verifications.json`.
 *
 * Branch operations are no-ops (the file backend has no branching concept).
 */

import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  StateStore,
  StoryRecord,
  StoryFilter,
  MetricRecord,
  ContractRecord,
  ContractFilter,
  ContractVerificationRecord,
  HistoryEntry,
} from './types.js'

// ---------------------------------------------------------------------------
// FileStateStoreOptions
// ---------------------------------------------------------------------------

export interface FileStateStoreOptions {
  /** Optional base path for kv-metrics + contract-verifications JSON files. */
  basePath?: string
}

// ---------------------------------------------------------------------------
// FileStateStore
// ---------------------------------------------------------------------------

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

  async setStoryState(storyKey: string, state: StoryRecord): Promise<void> {
    this._stories.set(storyKey, { ...state, storyKey })
  }

  async queryStories(filter: StoryFilter): Promise<StoryRecord[]> {
    const all = Array.from(this._stories.values())

    return all.filter((record) => {
      if (filter.phase !== undefined) {
        const phases = Array.isArray(filter.phase) ? filter.phase : [filter.phase]
        if (!phases.includes(record.phase)) return false
      }
      if (filter.sprint !== undefined && record.sprint !== filter.sprint) return false
      if (filter.storyKey !== undefined && record.storyKey !== filter.storyKey) return false
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

  // -- Key-value metrics (story 28-6) ----------------------------------------

  async setMetric(runId: string, key: string, value: unknown): Promise<void> {
    let runMap = this._kvMetrics.get(runId)
    if (runMap === undefined) {
      runMap = new Map()
      this._kvMetrics.set(runId, runMap)
    }
    runMap.set(key, value)

    if (this._basePath !== undefined) {
      await this._flushKvMetrics()
    }
  }

  async getMetric(runId: string, key: string): Promise<unknown> {
    const inMemory = this._kvMetrics.get(runId)?.get(key)
    if (inMemory !== undefined) return inMemory

    if (this._basePath !== undefined) {
      try {
        const filePath = join(this._basePath, 'kv-metrics.json')
        const content = await readFile(filePath, 'utf-8')
        const parsed = JSON.parse(content) as Record<string, Record<string, unknown>>
        return parsed[runId]?.[key] ?? undefined
      } catch {
        // ignore read errors — return undefined
      }
    }
    return undefined
  }

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
      const serialized: Record<string, ContractVerificationRecord[]> = {}
      for (const [key, records] of this._contractVerifications) {
        serialized[key] = records
      }
      const filePath = join(this._basePath, 'contract-verifications.json')
      await writeFile(filePath, JSON.stringify(serialized, null, 2), 'utf-8')
    }
  }

  async getHistory(_limit?: number): Promise<HistoryEntry[]> {
    // No commit history in the file backend.
    return []
  }
}
