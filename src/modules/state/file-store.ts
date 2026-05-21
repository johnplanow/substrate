/**
 * FileKvStore — narrow per-project KV persistence layer.
 *
 * Production callers:
 *  - `RoutingTokenAccumulator.flush()` writes `phase_token_breakdown` per run
 *  - `RoutingTuner._loadRecentBreakdowns()` reads them for auto-tune decisions
 *  - `RoutingTuner._appendTuneLog()` writes `routing_tune_log` entries
 *  - `substrate metrics --output-format json` reads `phase_token_breakdown`
 *    for operator visibility (cross-process, same project root)
 *
 * Persists to `{basePath}/kv-metrics.json` when `basePath` is provided.
 * Without a basePath, the store is purely in-memory (used by unit tests).
 *
 * Satisfies the narrow `IStateStore` contract from
 * `@substrate-ai/core/routing/types` structurally — only `setMetric` and
 * `getMetric` are required at the contract level.
 *
 * History (v0.20.107 / Ship 2 of Item 7 arc): renamed from `FileStateStore`.
 * The pre-Ship-2 class also carried story/metric/contract Maps that no
 * production caller ever touched (the orchestrator's `stateStore?` prop was
 * undefined in 100% of production paths). Those Maps + the `StateStore`
 * interface they implemented were excised. This class is now what its name
 * always implied.
 */

import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileKvStoreOptions } from './types.js'

// ---------------------------------------------------------------------------
// FileKvStore
// ---------------------------------------------------------------------------

export class FileKvStore {
  private readonly _basePath: string | undefined
  /** Key-value store: outer key = runId (or '__global__'), inner key = metric key. */
  private readonly _kvMetrics: Map<string, Map<string, unknown>> = new Map()

  constructor(options: FileKvStoreOptions = {}) {
    this._basePath = options.basePath
  }

  async initialize(): Promise<void> {
    // No-op for file backend.
  }

  async close(): Promise<void> {
    // No-op for file backend.
  }

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
}
