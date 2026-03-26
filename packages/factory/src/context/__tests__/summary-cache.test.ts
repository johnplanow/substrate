import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { SummaryCache, CachingSummaryEngine } from '../summary-cache.js'
import type { SummaryCacheConfig } from '../summary-cache.js'
import type { Summary, SummaryLevel, SummarizeOptions, ExpandOptions } from '../summary-types.js'
import type { SummaryEngine } from '../summary-engine.js'

// ---------------------------------------------------------------------------
// Mock engine
// ---------------------------------------------------------------------------

class MockSummaryEngine implements SummaryEngine {
  readonly name: string = 'mock'
  invokeCount = 0
  expandCount = 0

  async summarize(content: string, targetLevel: SummaryLevel, _opts?: SummarizeOptions): Promise<Summary> {
    this.invokeCount++
    const originalHash = createHash('sha256').update(content).digest('hex')
    return {
      level: targetLevel,
      content: `summarized(${content.slice(0, 20)})`,
      originalHash,
      createdAt: new Date().toISOString(),
    }
  }

  async expand(summary: Summary, _targetLevel: SummaryLevel, opts?: ExpandOptions): Promise<string> {
    this.expandCount++
    return opts?.originalContent ?? summary.content
  }
}

function makeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

// ---------------------------------------------------------------------------
// SummaryCache tests
// ---------------------------------------------------------------------------

describe('SummaryCache', () => {
  let tmpDir: string
  let cache: SummaryCache

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'summary-cache-test-'))
    cache = new SummaryCache({ runId: 'run-001', storageDir: tmpDir })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('put then get with same hash+level returns stored Summary object', async () => {
    const summary: Summary = {
      level: 'medium',
      content: 'summarized text',
      originalHash: makeHash('original text'),
      createdAt: new Date().toISOString(),
    }
    await cache.put(summary)
    const result = await cache.get(summary.originalHash, 'medium')
    expect(result).toEqual(summary)
  })

  it('get with unknown hash returns null', async () => {
    const result = await cache.get('deadbeef'.repeat(8), 'medium')
    expect(result).toBeNull()
  })

  it('get with known hash but different level returns null', async () => {
    const summary: Summary = {
      level: 'medium',
      content: 'summarized text',
      originalHash: makeHash('original text'),
      createdAt: new Date().toISOString(),
    }
    await cache.put(summary)
    // stored at 'medium', querying 'low' should miss
    const result = await cache.get(summary.originalHash, 'low')
    expect(result).toBeNull()
  })

  it('put succeeds when summaries directory does not yet exist', async () => {
    // Use a sub-directory that has never been created
    const nestedDir = join(tmpDir, 'deep', 'nested')
    const freshCache = new SummaryCache({ runId: 'run-999', storageDir: nestedDir })
    const summary: Summary = {
      level: 'high',
      content: 'hello',
      originalHash: makeHash('hello-source'),
      createdAt: new Date().toISOString(),
    }
    await expect(freshCache.put(summary)).resolves.toBeUndefined()
    const result = await freshCache.get(summary.originalHash, 'high')
    expect(result).toEqual(summary)
  })

  it('getOriginal returns exact text when put with originalContent', async () => {
    const originalText = 'This is the original content — preserve it exactly.'
    const summary: Summary = {
      level: 'low',
      content: 'compressed',
      originalHash: makeHash(originalText),
      createdAt: new Date().toISOString(),
    }
    await cache.put(summary, originalText)
    const result = await cache.getOriginal(summary.originalHash)
    expect(result).toBe(originalText)
  })

  it('getOriginal returns null when no original was stored', async () => {
    const summary: Summary = {
      level: 'low',
      content: 'compressed',
      originalHash: makeHash('some content'),
      createdAt: new Date().toISOString(),
    }
    await cache.put(summary) // no originalContent argument
    const result = await cache.getOriginal(summary.originalHash)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SummaryCache — storeOriginals: false
// ---------------------------------------------------------------------------

describe('SummaryCache storeOriginals: false', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'summary-cache-no-orig-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('does NOT write .orig file when storeOriginals is false', async () => {
    const config: SummaryCacheConfig = { runId: 'run-002', storageDir: tmpDir, storeOriginals: false }
    const cache = new SummaryCache(config)
    const originalText = 'original content that should not be persisted'
    const summary: Summary = {
      level: 'medium',
      content: 'compressed',
      originalHash: makeHash(originalText),
      createdAt: new Date().toISOString(),
    }
    await cache.put(summary, originalText)
    const orig = await cache.getOriginal(summary.originalHash)
    expect(orig).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// CachingSummaryEngine tests
// ---------------------------------------------------------------------------

describe('CachingSummaryEngine', () => {
  let tmpDir: string
  let inner: MockSummaryEngine
  let cache: SummaryCache
  let engine: CachingSummaryEngine

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'caching-engine-test-'))
    inner = new MockSummaryEngine()
    cache = new SummaryCache({ runId: 'run-caching', storageDir: tmpDir })
    engine = new CachingSummaryEngine(inner, cache)
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('first call (cache miss) delegates to inner engine exactly once', async () => {
    const content = 'Hello world content for summarization'
    const summary = await engine.summarize(content, 'medium')
    expect(inner.invokeCount).toBe(1)
    expect(summary.level).toBe('medium')
    expect(summary.originalHash).toBe(makeHash(content))
  })

  it('second call with same content+level (cache hit) returns cached without calling inner', async () => {
    const content = 'Same content for cache hit test'
    const first = await engine.summarize(content, 'medium')
    const second = await engine.summarize(content, 'medium')
    expect(inner.invokeCount).toBe(1)
    expect(second).toEqual(first)
  })

  it('different levels for same content are stored independently', async () => {
    const content = 'Content to summarize at multiple levels'
    const medSummary = await engine.summarize(content, 'medium')
    const lowSummary = await engine.summarize(content, 'low')
    expect(inner.invokeCount).toBe(2)
    expect(medSummary.level).toBe('medium')
    expect(lowSummary.level).toBe('low')
    // Both should be retrievable from cache
    const cachedMed = await cache.get(makeHash(content), 'medium')
    const cachedLow = await cache.get(makeHash(content), 'low')
    expect(cachedMed).toEqual(medSummary)
    expect(cachedLow).toEqual(lowSummary)
  })

  it('expand returns original from cache without calling inner expand', async () => {
    const content = 'Original content for lossless expansion test'
    const summary = await engine.summarize(content, 'low')
    // original was stored during summarize
    const expanded = await engine.expand(summary, 'full')
    expect(inner.expandCount).toBe(0)
    expect(expanded).toBe(content)
  })

  it('expand calls inner when original not cached (manually constructed summary)', async () => {
    // Build a summary whose hash is not in the cache
    const fakeSummary: Summary = {
      level: 'medium',
      content: 'some compressed text',
      originalHash: makeHash('content that was never summarized via engine'),
      createdAt: new Date().toISOString(),
    }
    const expanded = await engine.expand(fakeSummary, 'full')
    expect(inner.expandCount).toBe(1)
    // MockSummaryEngine.expand returns summary.content when no opts.originalContent
    expect(expanded).toBe(fakeSummary.content)
  })

  it('engine.name equals "caching(mock)" given inner engine with name "mock"', () => {
    expect(engine.name).toBe('caching(mock)')
  })

  it('CachingSummaryEngine instance is accepted as SummaryEngine', async () => {
    // Verify by calling both methods through a typed SummaryEngine variable
    const typed: SummaryEngine = engine
    const content = 'Interface compliance check'
    const summary = await typed.summarize(content, 'high')
    expect(summary).toBeDefined()
    const expanded = await typed.expand(summary, 'full')
    expect(expanded).toBeDefined()
  })
})
