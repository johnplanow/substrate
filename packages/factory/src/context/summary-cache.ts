/**
 * SummaryCache — file-backed storage for summaries with a caching layer
 * that prevents redundant LLM calls during long-running convergence sessions.
 *
 * Storage layout:
 *   {storageDir}/{runId}/summaries/{hash}-{level}.json   ← CachedSummaryRecord
 *   {storageDir}/{runId}/summaries/{hash}.orig            ← raw original content
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Summary, SummaryLevel, SummarizeOptions, ExpandOptions } from './summary-types.js'
import type { SummaryEngine } from './summary-engine.js'

export interface SummaryCacheConfig {
  /** Unique identifier for the current pipeline run. */
  runId: string
  /** Absolute path to the storage root that contains run directories (e.g. `.substrate/runs/`). */
  storageDir: string
  /** Whether to persist original content alongside summaries for lossless expansion. Default: true. */
  storeOriginals?: boolean
}

/** Envelope type persisted to disk — wraps Summary with cache metadata. */
export interface CachedSummaryRecord {
  summary: Summary
  cachedAt: string // ISO-8601
}

export class SummaryCache {
  private readonly config: SummaryCacheConfig

  constructor(config: SummaryCacheConfig) {
    this.config = config
  }

  private summaryPath(hash: string, level: SummaryLevel): string {
    return join(this.config.storageDir, this.config.runId, 'summaries', `${hash}-${level}.json`)
  }

  private originalPath(hash: string): string {
    return join(this.config.storageDir, this.config.runId, 'summaries', `${hash}.orig`)
  }

  async put(summary: Summary, originalContent?: string): Promise<void> {
    const dir = join(this.config.storageDir, this.config.runId, 'summaries')
    await mkdir(dir, { recursive: true })
    const record: CachedSummaryRecord = { summary, cachedAt: new Date().toISOString() }
    await writeFile(this.summaryPath(summary.originalHash, summary.level), JSON.stringify(record, null, 2))
    if (originalContent !== undefined && this.config.storeOriginals !== false) {
      await writeFile(this.originalPath(summary.originalHash), originalContent)
    }
  }

  async get(originalHash: string, level: SummaryLevel): Promise<Summary | null> {
    try {
      const raw = await readFile(this.summaryPath(originalHash, level), 'utf-8')
      const record: CachedSummaryRecord = JSON.parse(raw) as CachedSummaryRecord
      return record.summary
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async getOriginal(originalHash: string): Promise<string | null> {
    try {
      return await readFile(this.originalPath(originalHash), 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }
}

export class CachingSummaryEngine implements SummaryEngine {
  readonly name: string

  constructor(
    private readonly inner: SummaryEngine,
    private readonly cache: SummaryCache,
  ) {
    this.name = `caching(${inner.name})`
  }

  async summarize(content: string, targetLevel: SummaryLevel, opts?: SummarizeOptions): Promise<Summary> {
    const originalHash = createHash('sha256').update(content).digest('hex')
    const cached = await this.cache.get(originalHash, targetLevel)
    if (cached !== null) return cached
    const summary = await this.inner.summarize(content, targetLevel, opts)
    await this.cache.put(summary, content)
    return summary
  }

  async expand(summary: Summary, targetLevel: SummaryLevel, opts?: ExpandOptions): Promise<string> {
    const original = await this.cache.getOriginal(summary.originalHash)
    if (original !== null) return original
    return this.inner.expand(summary, targetLevel, opts)
  }
}
