# Story 49-6: Summary Quality Metrics

## Story

As a factory pipeline operator,
I want quality metrics for produced summaries measuring compression ratio, key-fact retention, and round-trip preservation,
so that I can monitor summarization fidelity, detect regressions, and tune summarization parameters for reliable context management in long-running pipelines.

## Acceptance Criteria

### AC1: Compression Ratio Computation
**Given** a `Summary` object with `originalTokenCount` and `summaryTokenCount` fields populated
**When** `computeCompressionRatio(summary: Summary): number` is called
**Then** `summaryTokenCount / originalTokenCount` is returned as a float in `[0, 1]`; when either field is absent (undefined) or `originalTokenCount` is zero, `-1` is returned as a sentinel value indicating the metric is unavailable

### AC2: Key-Fact Extraction
**Given** a string of content that may contain fenced code blocks (triple-backtick), file-path tokens matching `/[\w./]+(\.ts|\.js|\.json|\.md|\.go|\.py|\.yaml|\.yml)\b/g`, and error-type names matching `/\b(Error|Exception|ENOENT|ETIMEDOUT|TypeError|SyntaxError)\b/g`
**When** `extractKeyFacts(content: string): Set<string>` is called
**Then** the returned `Set<string>` contains one entry per matched fenced code block (entire block as a trimmed string), one entry per distinct file-path token, and one entry per distinct error-type name; content with none of these markers returns an empty set

### AC3: Key-Fact Retention Rate
**Given** original content and the summarized content string
**When** `computeKeyFactRetentionRate(original: string, summarized: string): number` is called
**Then** `extractKeyFacts(original)` and `extractKeyFacts(summarized)` are computed, and `retentionRate = preservedFacts / totalFacts` where `preservedFacts` is the count of original facts that also appear in the summarized set; when `totalFacts === 0`, `1.0` is returned (no key facts to lose)

### AC4: Round-Trip Preservation Score
**Given** the original content string and the result of `expand(summarize(content))` (the `expanded` string)
**When** `computeRoundTripScore(original: string, expanded: string): number` is called
**Then** a Jaccard word-set overlap score is returned: each string is tokenized into a lowercase word set by splitting on `/\W+/` and filtering empty tokens, intersection-over-union is computed, the result is in `[0, 1]`; when both word sets are empty the score is `1.0`; when exactly one set is non-empty the score is `0.0`

### AC5: Full Quality Report via SummaryQualityAnalyzer
**Given** a `SummaryQualityAnalyzer` instance, original content, a `Summary` object, and an optional `expanded` string
**When** `analyze(original: string, summary: Summary, expanded?: string): QualityReport` is called
**Then** the returned `QualityReport` contains: `summaryHash` (from `summary.originalHash`), `level` (from `summary.level`), `compressionRatio` (computed per AC1), `keyFactRetentionRate` (comparing `original` against `summary.content` per AC3), `roundTripScore` (computed per AC4 when `expanded` is provided, `null` otherwise), `overallScore` (`= keyFactRetentionRate * 0.6 + roundTripScore * 0.4` when `roundTripScore !== null`, else `keyFactRetentionRate`), and `computedAt` as an ISO-8601 timestamp

### AC6: Quality Metrics Persistence
**Given** a `QualityMetricsPersistence` instance configured with `runId: string` and `storageDir: string`
**When** `record(report: QualityReport): Promise<void>` is called
**Then** the report is appended as a `PersistedQualityEntry` (the report fields plus `recordedAt: string` ISO-8601) serialized as a single JSON line to `{storageDir}/runs/{runId}/quality-metrics.jsonl`, creating the parent directory if absent; when `readAll(): Promise<PersistedQualityEntry[]>` is called, all previously recorded entries are returned in insertion order; when the file does not yet exist, `readAll()` returns `[]` without throwing

### AC7: Unit Tests — All Quality Metric Behaviors Covered
**Given** `packages/factory/src/context/__tests__/summary-metrics.test.ts`
**When** run via `npm run test:fast`
**Then** at least 16 `it(...)` cases pass covering: `computeCompressionRatio` with valid token counts; `computeCompressionRatio` with missing token counts returns `-1`; `extractKeyFacts` detects fenced code blocks; `extractKeyFacts` detects file-path tokens; `extractKeyFacts` detects error-type names; `extractKeyFacts` returns empty set for plain text; `computeKeyFactRetentionRate` all facts retained returns `1.0`; `computeKeyFactRetentionRate` no key facts in original returns `1.0`; `computeKeyFactRetentionRate` partial retention; `computeRoundTripScore` identical strings return `1.0`; `computeRoundTripScore` disjoint word sets return `0.0`; `computeRoundTripScore` partial overlap returns value in `(0, 1)`; `analyze` without `expanded` — `roundTripScore` is `null` and `overallScore === keyFactRetentionRate`; `analyze` with `expanded` — `roundTripScore` is non-null and `overallScore === keyFactRetentionRate * 0.6 + roundTripScore * 0.4`; `QualityMetricsPersistence.record()` then `readAll()` returns entry; `QualityMetricsPersistence.readAll()` returns `[]` when file absent

## Tasks / Subtasks

- [ ] Task 1: Define quality metric types and error class in `packages/factory/src/context/summary-metrics.ts` (AC: #1, #5, #6)
  - [ ] Import: `import type { Summary, SummaryLevel } from './summary-types.js'`
  - [ ] Import Node built-ins: `import { appendFile, mkdir, readFile } from 'node:fs/promises'` and `import { join } from 'node:path'`
  - [ ] Export `QualityReport` interface: `summaryHash: string`, `level: SummaryLevel`, `compressionRatio: number` (−1 when unavailable), `keyFactRetentionRate: number`, `roundTripScore: number | null`, `overallScore: number`, `computedAt: string`
  - [ ] Export `PersistedQualityEntry` interface extending `QualityReport` with `recordedAt: string` (ISO-8601)
  - [ ] Export `QualityThresholds` interface: `minKeyFactRetentionRate?: number`, `minRoundTripScore?: number`, `minOverallScore?: number`
  - [ ] Export `QualityBelowThresholdError extends Error` with `readonly report: QualityReport` and `readonly failures: string[]` constructor parameters; constructor body: `super(\`Summary quality below threshold: \${failures.join(', ')}\`)` and `this.name = 'QualityBelowThresholdError'`
  - [ ] Export `QualityMetricsPersistenceConfig` interface: `runId: string`, `storageDir: string`

- [ ] Task 2: Implement pure metric computation functions (AC: #1, #2, #3, #4)
  - [ ] Export `computeCompressionRatio(summary: Summary): number`:
    - If `summary.originalTokenCount === undefined || summary.originalTokenCount === 0 || summary.summaryTokenCount === undefined` return `-1`
    - Return `summary.summaryTokenCount / summary.originalTokenCount`
  - [ ] Export `extractKeyFacts(content: string): Set<string>`:
    - Extract fenced code blocks via `/```[\s\S]*?```/g` — for each match call `.trim()` and add to set
    - Extract file-path tokens via `/[\w./]+(\.ts|\.js|\.json|\.md|\.go|\.py|\.yaml|\.yml)\b/g` — add each match to set
    - Extract error-type names via `/\b(Error|Exception|ENOENT|ETIMEDOUT|TypeError|SyntaxError)\b/g` — add each match to set
    - Return the combined `Set<string>`
  - [ ] Export `computeKeyFactRetentionRate(original: string, summarized: string): number`:
    - Compute `originalFacts = extractKeyFacts(original)` and `summarizedFacts = extractKeyFacts(summarized)`
    - If `originalFacts.size === 0` return `1.0`
    - Count `preserved = [...originalFacts].filter(f => summarizedFacts.has(f)).length`
    - Return `preserved / originalFacts.size`
  - [ ] Export `computeRoundTripScore(original: string, expanded: string): number`:
    - Tokenize each string: `const words = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 0))`
    - Compute `wordsA = words(original)` and `wordsB = words(expanded)`
    - If `wordsA.size === 0 && wordsB.size === 0` return `1.0`
    - Count `intersection = [...wordsA].filter(w => wordsB.has(w)).length`
    - Compute `union = new Set([...wordsA, ...wordsB]).size`
    - Return `intersection / union`

- [ ] Task 3: Implement `SummaryQualityAnalyzer` class (AC: #5)
  - [ ] Export `SummaryQualityAnalyzer` class (stateless — no constructor parameters needed)
  - [ ] Implement `analyze(original: string, summary: Summary, expanded?: string): QualityReport`:
    - Compute `compressionRatio = computeCompressionRatio(summary)`
    - Compute `keyFactRetentionRate = computeKeyFactRetentionRate(original, summary.content)`
    - Compute `roundTripScore = expanded !== undefined ? computeRoundTripScore(original, expanded) : null`
    - Compute `overallScore = roundTripScore !== null ? keyFactRetentionRate * 0.6 + roundTripScore * 0.4 : keyFactRetentionRate`
    - Return `QualityReport`: `{ summaryHash: summary.originalHash, level: summary.level, compressionRatio, keyFactRetentionRate, roundTripScore, overallScore, computedAt: new Date().toISOString() }`
  - [ ] Implement `assertQuality(report: QualityReport, thresholds: QualityThresholds): void`:
    - Build `failures: string[]`
    - If `thresholds.minKeyFactRetentionRate !== undefined && report.keyFactRetentionRate < thresholds.minKeyFactRetentionRate` push `` `keyFactRetentionRate ${report.keyFactRetentionRate.toFixed(3)} < ${thresholds.minKeyFactRetentionRate}` ``
    - If `thresholds.minRoundTripScore !== undefined && report.roundTripScore !== null && report.roundTripScore < thresholds.minRoundTripScore` push `` `roundTripScore ${report.roundTripScore.toFixed(3)} < ${thresholds.minRoundTripScore}` ``
    - If `thresholds.minOverallScore !== undefined && report.overallScore < thresholds.minOverallScore` push `` `overallScore ${report.overallScore.toFixed(3)} < ${thresholds.minOverallScore}` ``
    - If `failures.length > 0` throw `new QualityBelowThresholdError(report, failures)`

- [ ] Task 4: Implement `QualityMetricsPersistence` class (AC: #6)
  - [ ] Export `QualityMetricsPersistence` class with constructor `(private readonly config: QualityMetricsPersistenceConfig)`
  - [ ] Implement `private metricsPath(): string` — returns `join(this.config.storageDir, 'runs', this.config.runId, 'quality-metrics.jsonl')`
  - [ ] Implement `async record(report: QualityReport): Promise<void>`:
    - Compute `dir = join(this.config.storageDir, 'runs', this.config.runId)`
    - Call `await mkdir(dir, { recursive: true })`
    - Build `entry: PersistedQualityEntry = { ...report, recordedAt: new Date().toISOString() }`
    - Append `JSON.stringify(entry) + '\n'` to `this.metricsPath()` via `appendFile(this.metricsPath(), JSON.stringify(entry) + '\n', 'utf-8')`
  - [ ] Implement `async readAll(): Promise<PersistedQualityEntry[]>`:
    - `try { const raw = await readFile(this.metricsPath(), 'utf-8') }` — on `ENOENT` return `[]`; propagate all other errors
    - Split `raw` by `'\n'`, filter out empty strings, map each line to `JSON.parse(line) as PersistedQualityEntry`
    - Return the resulting array

- [ ] Task 5: Update barrel export `packages/factory/src/context/index.ts` (AC: #5, #6)
  - [ ] **Read the entire existing `index.ts` first** to see what is already exported
  - [ ] Add `export * from './summary-metrics.js'` after the existing exports
  - [ ] Confirm no circular dependency: `summary-metrics.ts` imports only `summary-types.ts` and Node built-ins — never imports from `summarizer.ts`, `auto-summarizer.ts`, or `summary-cache.ts`

- [ ] Task 6: Write unit tests in `packages/factory/src/context/__tests__/summary-metrics.test.ts` (AC: #7)
  - [ ] Import `mkdtemp`, `rm` from `'node:fs/promises'` and `tmpdir` from `'node:os'`; create a fresh isolated temp dir in `beforeEach`; clean up in `afterEach` via `rm(tmpDir, { recursive: true, force: true })`
  - [ ] Define a `makeSummary(overrides?: Partial<Summary>): Summary` helper that returns a minimal valid `Summary` with `level: 'medium'`, `content: 'summary content'`, `originalHash: 'abc123'`, `createdAt: new Date().toISOString()`, and spreads any provided overrides
  - [ ] **`computeCompressionRatio` tests (2 cases):** `makeSummary({ originalTokenCount: 100, summaryTokenCount: 50 })` returns `0.5`; `makeSummary({ originalTokenCount: undefined })` returns `-1`
  - [ ] **`extractKeyFacts` tests (4 cases):** content with a fenced code block — the block appears in the returned set; content containing `packages/factory/src/context/summary-types.ts` — that path appears in the set; content containing the word `ENOENT` — it appears in the set; plain prose `'hello world no facts here'` — set is empty
  - [ ] **`computeKeyFactRetentionRate` tests (3 cases):** original and summarized both contain the same file path — returns `1.0`; original has no key facts — returns `1.0`; original has two file paths and summarized retains only one — returns approximately `0.5`
  - [ ] **`computeRoundTripScore` tests (3 cases):** identical strings return `1.0`; `original = 'alpha beta'` and `expanded = 'gamma delta'` return `0.0`; `original = 'alpha beta gamma'` and `expanded = 'alpha beta delta'` return a value strictly between `0` and `1`
  - [ ] **`SummaryQualityAnalyzer.analyze` tests (2 cases):** call without `expanded` — `report.roundTripScore` is `null` and `report.overallScore === report.keyFactRetentionRate`; call with `expanded` equal to `original` — `report.roundTripScore === 1.0` and `report.overallScore === report.keyFactRetentionRate * 0.6 + 1.0 * 0.4`
  - [ ] **`QualityMetricsPersistence` tests (2 cases):** `record(report)` then `readAll()` returns array of length 1 with `entry.summaryHash === report.summaryHash` and `entry.recordedAt` defined; `readAll()` returns `[]` when no file exists at the metrics path
  - [ ] Ensure at least 16 `it(...)` cases total

- [ ] Task 7: Build and test verification (AC: all)
  - [ ] Run `npm run build` and confirm zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` and confirm "Test Files" summary line with zero failures
  - [ ] Verify no test output is piped through `grep`, `head`, `tail`, or any filter

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import type { Summary } from './summary-types.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- `summary-metrics.ts` MUST import ONLY from `summary-types.ts` and Node built-ins — never from `summarizer.ts`, `summary-engine.ts`, `auto-summarizer.ts`, or `summary-cache.ts`
- No external libraries for text similarity — implement Jaccard overlap using built-in JavaScript `Set` operations only
- Use `node:fs/promises` and `node:path` — Node built-ins only; no third-party I/O libraries

### New File Paths
```
packages/factory/src/context/summary-metrics.ts                        — QualityReport, QualityThresholds, QualityBelowThresholdError, SummaryQualityAnalyzer, QualityMetricsPersistence
packages/factory/src/context/__tests__/summary-metrics.test.ts         — unit tests (≥16 test cases)
```

### Modified File Paths
```
packages/factory/src/context/index.ts                                  — add: export * from './summary-metrics.js'
```

### Quality Metrics JSONL Storage Path
```
{storageDir}/runs/{runId}/quality-metrics.jsonl   ← one PersistedQualityEntry JSON object per line
```
The path mirrors the `runs/` convention used elsewhere in the factory package for per-run state. Each line is a self-contained JSON object terminated by `\n`; the file can be read line-by-line or in full.

### Key Type Definitions Sketch

```typescript
// packages/factory/src/context/summary-metrics.ts

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Summary, SummaryLevel } from './summary-types.js'

export interface QualityReport {
  summaryHash: string
  level: SummaryLevel
  compressionRatio: number      // [0,1] when available; -1 sentinel when token counts absent
  keyFactRetentionRate: number  // [0, 1]
  roundTripScore: number | null // null when expanded not provided
  overallScore: number          // [0, 1] weighted quality score
  computedAt: string            // ISO-8601
}

export interface PersistedQualityEntry extends QualityReport {
  recordedAt: string // ISO-8601 — time written to disk
}

export interface QualityThresholds {
  minKeyFactRetentionRate?: number
  minRoundTripScore?: number
  minOverallScore?: number
}

export class QualityBelowThresholdError extends Error {
  constructor(
    public readonly report: QualityReport,
    public readonly failures: string[],
  ) {
    super(`Summary quality below threshold: ${failures.join(', ')}`)
    this.name = 'QualityBelowThresholdError'
  }
}

export interface QualityMetricsPersistenceConfig {
  runId: string
  storageDir: string
}
```

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect` — no Jest globals
- Use `mkdtemp(join(tmpdir(), 'summary-metrics-test-'))` in `beforeEach` for isolated temp directory; clean up in `afterEach` with `rm(tmpDir, { recursive: true, force: true })`
- All pure metric functions (`computeCompressionRatio`, `extractKeyFacts`, etc.) need no mocking or I/O — test directly with string inputs
- Only `QualityMetricsPersistence` requires a temp directory; create one only in that `describe` block
- Run: `npm run build` first to catch TypeScript errors; then `npm run test:fast` with `timeout: 300000`; NEVER pipe output
- Confirm results by checking for the "Test Files" summary line in raw output
- Minimum 16 `it(...)` cases required

## Interface Contracts

- **Import**: `Summary`, `SummaryLevel` @ `packages/factory/src/context/summary-types.ts` (from story 49-1)
- **Export**: `QualityReport`, `PersistedQualityEntry`, `QualityThresholds`, `QualityBelowThresholdError` @ `packages/factory/src/context/summary-metrics.ts` (consumed by stories 49-7, 49-8)
- **Export**: `SummaryQualityAnalyzer`, `computeCompressionRatio`, `extractKeyFacts`, `computeKeyFactRetentionRate`, `computeRoundTripScore` @ `packages/factory/src/context/summary-metrics.ts` (consumed by stories 49-7, 49-8)
- **Export**: `QualityMetricsPersistence`, `QualityMetricsPersistenceConfig` @ `packages/factory/src/context/summary-metrics.ts` (consumed by story 49-7)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
