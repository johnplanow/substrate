# Story 49-4: Summary Storage and Expansion Cache

## Story

As a factory pipeline operator,
I want summaries persisted to file-backed run state with a cache layer that prevents redundant LLM calls,
so that long-running convergence sessions can resume without re-summarizing identical content, reducing token costs and latency.

## Acceptance Criteria

### AC1: SummaryCache — File-Backed Storage
**Given** a `SummaryCache` instance configured with a `runId` and `storageDir`
**When** `put(summary: Summary, originalContent?: string): Promise<void>` is called
**Then** the summary is written as a `CachedSummaryRecord` JSON file to `{storageDir}/{runId}/summaries/{hash}-{level}.json`, the directory is created if absent, and when `originalContent` is provided the original text is written to `{storageDir}/{runId}/summaries/{hash}.orig`

### AC2: SummaryCache — Get by Hash and Level
**Given** a summary previously stored via `put()`
**When** `get(originalHash: string, level: SummaryLevel): Promise<Summary | null>` is called with matching hash and level
**Then** the stored `Summary` object is returned; when called with a hash or level for which no entry exists, `null` is returned without throwing

### AC3: SummaryCache — Original Content Retrieval
**Given** a summary stored via `put(summary, originalContent)` where `originalContent` is provided
**When** `getOriginal(originalHash: string): Promise<string | null>` is called
**Then** the original text is returned exactly as stored; when no original was stored for the given hash, `null` is returned without throwing

### AC4: CachingSummaryEngine — Cache-First Summarization
**Given** a `CachingSummaryEngine` wrapping an inner `SummaryEngine` with a `SummaryCache`
**When** `summarize(content: string, targetLevel: SummaryLevel): Promise<Summary>` is called
**Then** on a cache miss the inner engine is called exactly once, the result is stored via `cache.put()` with the original content, and the summary is returned; on a subsequent call with identical `content` and `level` the cached result is returned without calling the inner engine again

### AC5: CachingSummaryEngine — Lossless Expansion from Cache
**Given** a `CachingSummaryEngine` where original content was stored during `summarize()`
**When** `expand(summary: Summary, targetLevel: SummaryLevel): Promise<string>` is called
**Then** if the original is available via `cache.getOriginal(summary.originalHash)` it is returned directly without calling the inner engine; if no original is cached, the inner engine's `expand()` is called as the LLM fallback

### AC6: CachingSummaryEngine Implements SummaryEngine Interface
**Given** `packages/factory/src/context/summary-cache.ts`
**When** imported by another TypeScript module
**Then** `CachingSummaryEngine` satisfies the `SummaryEngine` interface with `readonly name: string`, `summarize()`, and `expand()` methods; `name` follows the pattern `caching({innerName})`; and TypeScript accepts it wherever `SummaryEngine` is expected without type assertions

### AC7: Unit Tests — All Cache Behaviors Covered
**Given** `packages/factory/src/context/__tests__/summary-cache.test.ts`
**When** run via `npm run test:fast`
**Then** at least 14 `it(...)` cases pass covering: `put()` writes files to the correct paths, `get()` returns stored summary on hit, `get()` returns `null` on miss, `get()` returns `null` when level mismatches, `getOriginal()` returns stored text, `getOriginal()` returns `null` when not stored, `put()` succeeds when directory does not yet exist, `CachingSummaryEngine.summarize()` delegates on miss and caches, `CachingSummaryEngine.summarize()` returns cache hit without calling inner, multiple levels for same hash stored independently, `CachingSummaryEngine.expand()` returns original from cache without calling inner, `CachingSummaryEngine.expand()` calls inner when original not cached, `CachingSummaryEngine.name` contains `'caching('`, and the instance is accepted as `SummaryEngine` type

## Tasks / Subtasks

- [ ] Task 1: Define types and `SummaryCacheConfig` in `packages/factory/src/context/summary-cache.ts` (AC: #1, #6)
  - [ ] Export `SummaryCacheConfig` interface with `runId: string`, `storageDir: string` (absolute path to storage root, e.g. the `.substrate` parent directory), and optional `storeOriginals?: boolean` (default `true`)
  - [ ] Export `CachedSummaryRecord` interface with `summary: Summary` and `cachedAt: string` (ISO-8601); this is the envelope type persisted to disk — the outer wrapper is not surfaced to consumers
  - [ ] Import types using `.js` extensions: `import type { Summary, SummaryLevel, SummarizeOptions, ExpandOptions } from './summary-types.js'` and `import type { SummaryEngine } from './summary-engine.js'`
  - [ ] Import Node built-ins: `import { createHash } from 'node:crypto'` and `import { mkdir, readFile, writeFile } from 'node:fs/promises'` and `import { join } from 'node:path'`

- [ ] Task 2: Implement `SummaryCache` class with file I/O (AC: #1, #2, #3)
  - [ ] Implement `private summaryPath(hash: string, level: SummaryLevel): string` — returns `join(storageDir, runId, 'summaries', \`${hash}-${level}.json\`)`
  - [ ] Implement `private originalPath(hash: string): string` — returns `join(storageDir, runId, 'summaries', \`${hash}.orig\`)`
  - [ ] Implement `async put(summary: Summary, originalContent?: string): Promise<void>`:
    - Create directory with `mkdir(dir, { recursive: true })` before writing
    - Write `JSON.stringify({ summary, cachedAt: new Date().toISOString() }, null, 2)` to `summaryPath(summary.originalHash, summary.level)`
    - If `originalContent !== undefined` AND `config.storeOriginals !== false`, write `originalContent` to `originalPath(summary.originalHash)`
  - [ ] Implement `async get(originalHash: string, level: SummaryLevel): Promise<Summary | null>`:
    - Read and `JSON.parse` the file at `summaryPath(originalHash, level)`
    - Return `record.summary` on success; return `null` on `ENOENT`; propagate all other errors
  - [ ] Implement `async getOriginal(originalHash: string): Promise<string | null>`:
    - Read file at `originalPath(originalHash)` as `'utf-8'`
    - Return content on success; return `null` on `ENOENT`; propagate all other errors

- [ ] Task 3: Implement `CachingSummaryEngine` class (AC: #4, #5, #6)
  - [ ] Export `CachingSummaryEngine` class with constructor `(inner: SummaryEngine, cache: SummaryCache)`
  - [ ] Set `readonly name = \`caching(${inner.name})\`` for observability and log traceability
  - [ ] Implement `async summarize(content: string, targetLevel: SummaryLevel, opts?: SummarizeOptions): Promise<Summary>`:
    - Compute `originalHash = createHash('sha256').update(content).digest('hex')`
    - Check cache: `const cached = await this.cache.get(originalHash, targetLevel)`; if `cached !== null`, return `cached`
    - Delegate: `const summary = await this.inner.summarize(content, targetLevel, opts)`
    - Store with original: `await this.cache.put(summary, content)` — always stores original content to enable lossless expansion
    - Return `summary`
  - [ ] Implement `async expand(summary: Summary, targetLevel: SummaryLevel, opts?: ExpandOptions): Promise<string>`:
    - Check for cached original: `const original = await this.cache.getOriginal(summary.originalHash)`
    - If `original !== null`, return `original` directly (lossless expansion path — no LLM call)
    - Otherwise: `return this.inner.expand(summary, targetLevel, opts)` (LLM fallback path)

- [ ] Task 4: Update barrel export `packages/factory/src/context/index.ts` (AC: #6)
  - [ ] **Read the entire existing `index.ts` first** to see what is already exported
  - [ ] Add `export * from './summary-cache.js'` after the existing exports
  - [ ] Confirm no circular dependency: `summary-cache.ts` imports only from `summary-types.ts` and `summary-engine.ts` (both defined in 49-1), never from `auto-summarizer.ts` or `summarizer.ts`

- [ ] Task 5: Write unit tests in `packages/factory/src/context/__tests__/summary-cache.test.ts` (AC: #7)
  - [ ] Import `mkdtemp`, `rm` from `'node:fs/promises'` and `tmpdir` from `'node:os'` for isolated temp directories; create fresh temp dir per `describe` block in `beforeEach`; clean up in `afterEach` via `rm(tmpDir, { recursive: true })`
  - [ ] Define a local `MockSummaryEngine` class implementing `SummaryEngine` with an `invokeCount` counter for `summarize` and an `expandCount` counter for `expand`; `summarize` returns a deterministic `Summary` with `originalHash` computed from input; `expand` returns `opts?.originalContent ?? summary.content`
  - [ ] **`SummaryCache.put()` / `get()` tests (4 cases):** put then get with same hash+level returns stored Summary object; get with unknown hash returns null; get with known hash but different level returns null; put succeeds when summaries directory does not yet exist
  - [ ] **`SummaryCache.getOriginal()` tests (2 cases):** put with originalContent then getOriginal returns exact text; put without originalContent then getOriginal returns null
  - [ ] **`CachingSummaryEngine.summarize()` tests (3 cases):** first call (cache miss) calls inner once and stores result; second call with same content+level (cache hit) returns cached without calling inner (`invokeCount` stays at 1); different levels for same content stored independently (both retrievable)
  - [ ] **`CachingSummaryEngine.expand()` tests (2 cases):** when original cached (after summarize call), expand returns original without calling inner expand; when original not in cache (manually constructed summary), expand calls inner expand
  - [ ] **Interface and naming tests (2 cases):** `CachingSummaryEngine` instance is accepted as `SummaryEngine` (verify by calling both methods through typed variable); `engine.name` equals `'caching(mock)'` given inner engine with `name = 'mock'`
  - [ ] **storeOriginals: false test (1 case):** when `SummaryCacheConfig.storeOriginals` is `false`, `put()` with originalContent does NOT write a `.orig` file (getOriginal returns null)
  - [ ] Ensure at least 14 `it(...)` cases total

- [ ] Task 6: Build and test verification (AC: all)
  - [ ] Run `npm run build` and confirm zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` and confirm "Test Files" summary line with zero failures
  - [ ] Verify no test output is piped through `grep`, `head`, `tail`, or any filter

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import type { Summary } from './summary-types.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- `CachingSummaryEngine` depends on the `SummaryEngine` **interface** from story 49-1 — NOT on `LLMSummaryEngine` (the concrete implementation from 49-2). Inversion of control: `SummaryCache` and `CachingSummaryEngine` have no knowledge of which engine is underneath.
- Use `node:crypto`, `node:fs/promises`, `node:path` — Node built-ins only; no external I/O libraries
- `AutoSummarizer` (from 49-3) is NOT imported by this story — the cache is a separate concern from the compression-trigger logic

### Storage Path Convention
```
{storageDir}/{runId}/summaries/{hash}-{level}.json   ← CachedSummaryRecord (summary envelope)
{storageDir}/{runId}/summaries/{hash}.orig            ← raw original content (utf-8 text)
```
The `hash` is the full 64-character SHA-256 hex string from `summary.originalHash`. File names are deterministic and collision-free for any content+level combination.

### New File Paths
```
packages/factory/src/context/summary-cache.ts                        — SummaryCacheConfig, CachedSummaryRecord, SummaryCache, CachingSummaryEngine
packages/factory/src/context/__tests__/summary-cache.test.ts         — unit tests (≥14 test cases)
```

### Modified File Paths
```
packages/factory/src/context/index.ts                                — add: export * from './summary-cache.js'
```

### Key Type Definitions

```typescript
// packages/factory/src/context/summary-cache.ts

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Summary, SummaryLevel, SummarizeOptions, ExpandOptions } from './summary-types.js'
import type { SummaryEngine } from './summary-engine.js'

export interface SummaryCacheConfig {
  /** Unique identifier for the current pipeline run. */
  runId: string
  /** Absolute path to the storage root (e.g. the directory containing `.substrate/`). */
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
```

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect` — no Jest globals
- Use `mkdtemp(join(tmpdir(), 'summary-cache-test-'))` in `beforeEach` for a fresh isolated temp directory; clean up in `afterEach` with `rm(tmpDir, { recursive: true, force: true })`
- Define a local `MockSummaryEngine` with call counters to verify cache hit/miss behavior — do NOT use `vi.mock()`
- The `MockSummaryEngine.summarize()` must compute the same `originalHash` that `CachingSummaryEngine` computes (`sha256(content)`), so tests can build matching `Summary` objects for expand tests
- Run: `npm run build` first to catch TypeScript errors; then `npm run test:fast` with `timeout: 300000`; NEVER pipe output
- Confirm results by checking for the "Test Files" summary line in raw output
- Minimum 14 `it(...)` cases required

## Interface Contracts

- **Import**: `Summary`, `SummaryLevel`, `SummarizeOptions`, `ExpandOptions` @ `packages/factory/src/context/summary-types.ts` (from story 49-1)
- **Import**: `SummaryEngine` @ `packages/factory/src/context/summary-engine.ts` (from story 49-1)
- **Export**: `SummaryCache` @ `packages/factory/src/context/summary-cache.ts` (consumed by stories 49-5, 49-7, 49-8)
- **Export**: `SummaryCacheConfig`, `CachedSummaryRecord` @ `packages/factory/src/context/summary-cache.ts` (consumed by stories 49-5, 49-7, 49-8)
- **Export**: `CachingSummaryEngine` @ `packages/factory/src/context/summary-cache.ts` (consumed by stories 49-5, 49-7, 49-8)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
