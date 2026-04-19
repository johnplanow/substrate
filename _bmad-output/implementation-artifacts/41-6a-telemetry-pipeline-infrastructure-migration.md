# Story 41.6a: Core Telemetry Migration — Pipeline Infrastructure, Cost, and Utility Modules

## Story

As a substrate-core package consumer,
I want `TelemetryPipeline`, `BatchBuffer`, `IngestionServer`, `TelemetryNormalizer`, and all telemetry utility modules (`cost-table`, `timestamp-normalizer`, `source-detector`, `token-extractor`) available from `@substrate-ai/core`,
so that downstream packages can ingest, normalize, and pipeline OTLP telemetry data without importing from the monolith's `src/modules/telemetry/`.

## Acceptance Criteria

### AC1: Pure utility modules migrated to packages/core/src/telemetry/
**Given** `packages/core/src/telemetry/` currently contains only `types.ts` and `index.ts` (from story 40-7)
**When** story 41-6a is complete
**Then** the following new files exist in `packages/core/src/telemetry/` with zero imports from `src/`: `cost-table.ts`, `timestamp-normalizer.ts`, `source-detector.ts`, and `token-extractor.ts`; all imports use `.js` extensions; all exported functions and constants match the originals identically

### AC2: TelemetryNormalizer migrated to packages/core/src/telemetry/
**Given** `TelemetryNormalizer` currently lives in `src/modules/telemetry/normalizer.ts` and imports from `cost-table.ts`, `timestamp-normalizer.ts`, and `token-extractor.ts`
**When** story 41-6a is complete
**Then** `packages/core/src/telemetry/normalizer.ts` contains `TelemetryNormalizer`; it imports only from local core-package paths (e.g., `./cost-table.js`, `./timestamp-normalizer.js`, `./token-extractor.js`, `./types.js`); no imports from `src/`

### AC3: BatchBuffer migrated to packages/core/src/telemetry/ with zero external monolith deps
**Given** `BatchBuffer<T>` uses only `node:events` EventEmitter and has no monolith imports
**When** `packages/core/src/telemetry/batch-buffer.ts` is created
**Then** `BatchBuffer<T>` and `BatchBufferOptions` are fully exported from core; the class extends `EventEmitter` from `node:events`; no logger injection is needed (no logging in BatchBuffer); the file has zero imports from `src/`

### AC4: TelemetryPipeline migrated with duck-typed scoring interfaces and ILogger injection
**Given** `TelemetryPipeline` currently depends on scoring modules (`EfficiencyScorer`, `TurnAnalyzer`, `LogTurnAnalyzer`, `Categorizer`, `ConsumerAnalyzer`, `Recommender`) and persistence (`ITelemetryPersistence`), which are either still in the monolith or migrated in later stories
**When** `packages/core/src/telemetry/telemetry-pipeline.ts` is created
**Then** `TelemetryPipelineDeps` declares duck-typed interfaces (`ITurnAnalyzer`, `ILogTurnAnalyzer`, `ICategorizer`, `IConsumerAnalyzer`, `IEfficiencyScorer`, `IRecommender`, `ITelemetryPersistence`) using types already in `./types.js`; `TelemetryPipeline` accepts `logger?: ILogger` from `../dispatch/types.js` defaulting to `console`; zero imports from `src/`

### AC5: IngestionServer migrated to packages/core/src/telemetry/ with ILogger injection
**Given** `IngestionServer` currently imports `createLogger` from the monolith and depends on `BatchBuffer`, `TelemetryPipeline`, and `detectSource`
**When** `packages/core/src/telemetry/ingestion-server.ts` is created
**Then** `IngestionServer`, `IngestionServerOptions`, `DispatchContext`, and `TelemetryError` are exported from core; constructor accepts `logger?: ILogger` defaulting to `console`; all imports resolve to local core-package paths using `.js` extensions; `TelemetryError` extends a local `CoreError` base class or plain `Error` (not `AppError` from the monolith)

### AC6: packages/core barrel exports all new telemetry symbols and builds without TypeScript errors
**Given** new implementations are added to `packages/core/src/telemetry/`
**When** `packages/core/src/telemetry/index.ts` and `packages/core/src/index.ts` are updated
**Then** all new symbols (`TelemetryPipeline`, `TelemetryPipelineDeps`, `BatchBuffer`, `BatchBufferOptions`, `IngestionServer`, `IngestionServerOptions`, `DispatchContext`, `TelemetryError`, `TelemetryNormalizer`, `COST_TABLE`, `estimateCost`, `resolveModel`, `normalizeTimestamp`, `detectSource`, `OtlpSource`, `extractTokensFromAttributes`, `extractTokensFromBody`, `mergeTokenCounts`) are importable from `@substrate-ai/core`; `tsc -b` in `packages/core/` exits with code 0

### AC7: Re-export shims at all original src/modules/telemetry/ paths and all existing tests pass
**Given** the 8 migrated files in `src/modules/telemetry/` are replaced with re-export shims pointing to `@substrate-ai/core`
**When** `npm run test:fast` is executed
**Then** all tests in `src/modules/telemetry/__tests__/` pass without any test file modifications; no implementation code remains in `src/modules/telemetry/` for the 8 migrated files; `index.ts` shim re-exports all symbols visible to monolith callers

## Tasks / Subtasks

- [ ] Task 1: Migrate pure utility modules to `packages/core/src/telemetry/` (AC: #1)
  - [ ] Copy `src/modules/telemetry/cost-table.ts` to `packages/core/src/telemetry/cost-table.ts`; update all imports to `.js` extensions; verify only `TokenCounts` and `ModelPricing` types from `./types.js` are imported (no monolith deps); export `COST_TABLE`, `estimateCost()`, `resolveModel()` unchanged
  - [ ] Copy `src/modules/telemetry/timestamp-normalizer.ts` to `packages/core/src/telemetry/timestamp-normalizer.ts`; the file should have zero imports (pure function); export `normalizeTimestamp()` unchanged
  - [ ] Copy `src/modules/telemetry/source-detector.ts` to `packages/core/src/telemetry/source-detector.ts`; verify only local types are needed; export `OtlpSource` type and `detectSource()` unchanged
  - [ ] Copy `src/modules/telemetry/token-extractor.ts` to `packages/core/src/telemetry/token-extractor.ts`; import `TokenCounts` from `./types.js`; export `extractTokensFromAttributes()`, `extractTokensFromBody()`, `mergeTokenCounts()` unchanged
  - [ ] Run `tsc -b` in `packages/core/` and fix any type errors in these 4 files before proceeding

- [ ] Task 2: Migrate TelemetryNormalizer to core (AC: #2)
  - [ ] Copy `src/modules/telemetry/normalizer.ts` to `packages/core/src/telemetry/normalizer.ts`
  - [ ] Replace all imports with local core-package paths: `./cost-table.js`, `./timestamp-normalizer.js`, `./token-extractor.js`, `./types.js`; use `.js` extensions throughout
  - [ ] Remove any `createLogger` / `pino` imports; TelemetryNormalizer should either accept `logger?: ILogger` (import from `../dispatch/types.js`) or have no logger dependency — inspect the actual implementation to determine which is needed
  - [ ] Run `tsc -b` in `packages/core/` and confirm this file compiles cleanly

- [ ] Task 3: Migrate BatchBuffer to core (AC: #3)
  - [ ] Copy `src/modules/telemetry/batch-buffer.ts` to `packages/core/src/telemetry/batch-buffer.ts`
  - [ ] Verify imports: only `node:events` is needed; export `BatchBuffer<T>` class and `BatchBufferOptions` interface; no logger injection should be needed
  - [ ] Run `tsc -b` in `packages/core/` and confirm this file compiles cleanly

- [ ] Task 4: Define duck-typed scoring interfaces and migrate TelemetryPipeline to core (AC: #4)
  - [ ] In `packages/core/src/telemetry/telemetry-pipeline.ts`, define minimal duck-typed interfaces for scoring dependencies using types from `./types.js`: `ITurnAnalyzer { analyze(spans: NormalizedSpan[]): TurnAnalysis[] }`, `ILogTurnAnalyzer { analyze(logs: NormalizedLog[]): TurnAnalysis[] }`, `ICategorizer { categorize(spans: NormalizedSpan[], turns: TurnAnalysis[]): CategoryStats[] }`, `IConsumerAnalyzer { analyze(spans: NormalizedSpan[]): ConsumerStats[] }`, `IEfficiencyScorer { score(turns: TurnAnalysis[], ...): EfficiencyScore }`, `IRecommender { recommend(ctx: RecommenderContext): Recommendation[] }`; also define `ITelemetryPersistence` duck-typed interface with the minimal methods called by TelemetryPipeline
  - [ ] Copy the `TelemetryPipeline` class body from `src/modules/telemetry/telemetry-pipeline.ts`; replace concrete scoring class imports with the duck-typed interfaces; update constructor to accept `TelemetryPipelineDeps` (containing the scoring interface instances) plus `logger?: ILogger` from `../dispatch/types.js`
  - [ ] Replace `OtlpSource` import and `DispatchContext` import with references to local files (`./source-detector.js`, `./ingestion-server.js` — forward reference okay since ingestion-server will import pipeline); import `NormalizedSpan`, `NormalizedLog`, `TurnAnalysis`, `EfficiencyScore`, `Recommendation`, `RecommenderContext`, `CategoryStats`, `ConsumerStats` from `./types.js`
  - [ ] Export `TelemetryPipeline`, `RawOtlpPayload`, `TelemetryPipelineDeps` from the file; run `tsc -b` in `packages/core/` and fix type errors

- [ ] Task 5: Migrate IngestionServer to core (AC: #5)
  - [ ] Copy `src/modules/telemetry/ingestion-server.ts` to `packages/core/src/telemetry/ingestion-server.ts`
  - [ ] Replace `import { createLogger }` and `AppError` with: `import type { ILogger } from '../dispatch/types.js'`; define `TelemetryError extends Error` locally (or `class TelemetryError extends Error { constructor(message: string, public readonly cause?: unknown) { super(message) } }`) — do NOT import `AppError` from the monolith
  - [ ] Update all intra-file imports: `./batch-buffer.js`, `./telemetry-pipeline.js`, `./source-detector.js`; add `logger?: ILogger` to `IngestionServerOptions`; default to `console` in the constructor
  - [ ] Export `IngestionServer`, `IngestionServerOptions`, `DispatchContext`, `TelemetryError`; run `tsc -b` in `packages/core/` and fix any remaining errors

- [ ] Task 6: Update barrel exports in packages/core (AC: #6)
  - [ ] Rewrite `packages/core/src/telemetry/index.ts` to export all implementation symbols from the 8 new files, plus the existing type exports from `./types.js`; include all duck-typed scoring interfaces (`ITurnAnalyzer`, `ILogTurnAnalyzer`, `ICategorizer`, `IConsumerAnalyzer`, `IEfficiencyScorer`, `IRecommender`, `ITelemetryPersistence`) so 41-6b implementations can import and satisfy them
  - [ ] Update `packages/core/src/index.ts` to ensure the telemetry namespace is fully re-exported (verify all 20+ new symbols are reachable from `@substrate-ai/core`)
  - [ ] Run `tsc -b` in `packages/core/` and confirm zero type errors; check for any name collisions with other namespaces (e.g., `ITelemetryPersistence` from persistence vs telemetry — resolve by qualifying the telemetry-package export name if needed)

- [ ] Task 7: Create re-export shims and verify all tests pass (AC: #7)
  - [ ] Replace each of the 8 migrated files in `src/modules/telemetry/` with a thin re-export shim pointing to `@substrate-ai/core`: `batch-buffer.ts`, `ingestion-server.ts`, `normalizer.ts`, `telemetry-pipeline.ts`, `cost-table.ts`, `timestamp-normalizer.ts`, `source-detector.ts`, `token-extractor.ts`
  - [ ] Update `src/modules/telemetry/index.ts` to pass through all symbols; ensure every name the existing monolith callers use is still exported from the shim barrel (inspect callers in `src/` via `grep` if needed)
  - [ ] Verify `src/modules/telemetry/persistence.ts` (not yet migrated) still imports correctly; the shims must not break the persistence module's intra-directory imports
  - [ ] Run `npm run test:fast`; confirm all tests in `src/modules/telemetry/__tests__/` pass without modification; confirm exit code matches "Test Files" summary

## Dev Notes

### Architecture Constraints
- **ESM `.js` imports**: All intra-package imports in `packages/core/src/` must use `.js` extensions (e.g., `import { normalizeTimestamp } from './timestamp-normalizer.js'`)
- **No imports from `src/` in `packages/core/`**: The core package must be fully self-contained; any import from `../../` or `../../../` pointing into `src/` is forbidden
- **ILogger**: Already exported from `@substrate-ai/core` via `packages/core/src/dispatch/types.ts` (story 41-2); import within core via `import type { ILogger } from '../dispatch/types.js'`; do NOT redefine or re-import `pino`
- **Scoring module decoupling**: `TelemetryPipeline` currently depends on concrete scoring classes (`EfficiencyScorer`, `TurnAnalyzer`, etc.) that migrate in story 41-6b. In this story, replace all concrete scoring imports with duck-typed interfaces defined locally in `telemetry-pipeline.ts`. The monolith's shim for `telemetry-pipeline.ts` must inject the concrete scoring classes into the core constructor to preserve behavior.
- **TelemetryError base class**: The monolith's `TelemetryError` may extend `AppError` from `src/errors/app-error.ts`. In core, extend plain `Error` instead. The monolith shim can optionally re-define or extend `TelemetryError` from `AppError` if callers depend on that hierarchy — inspect callers before deciding.
- **ITelemetryPersistence duck-typing**: Define a minimal `ITelemetryPersistence` interface in `telemetry-pipeline.ts` containing only the methods TelemetryPipeline actually calls. This prevents needing to import from the persistence module. The concrete `TelemetryPersistence` from the monolith will satisfy it structurally.
- **Depends on 40-7 (Telemetry types)**, **41-2 (ILogger source)**, and **41-3 (persistence patterns)**: all must be complete before starting this story

### Duck-Typed Scoring Interface Pattern
```typescript
// packages/core/src/telemetry/telemetry-pipeline.ts
import type { ILogger } from '../dispatch/types.js'
import type {
  NormalizedSpan, NormalizedLog, TurnAnalysis, EfficiencyScore,
  Recommendation, RecommenderContext, CategoryStats, ConsumerStats
} from './types.js'

// Duck-typed interfaces for scoring deps (implementations migrate in 41-6b)
export interface ITurnAnalyzer {
  analyze(spans: NormalizedSpan[]): TurnAnalysis[]
}
export interface ILogTurnAnalyzer {
  analyze(logs: NormalizedLog[]): TurnAnalysis[]
}
export interface ICategorizer {
  categorize(spans: NormalizedSpan[], turns: TurnAnalysis[]): CategoryStats[]
}
export interface IConsumerAnalyzer {
  analyze(spans: NormalizedSpan[]): ConsumerStats[]
}
export interface IEfficiencyScorer {
  score(turns: TurnAnalysis[], taskType?: string): EfficiencyScore
}
export interface IRecommender {
  recommend(ctx: RecommenderContext): Recommendation[]
}
export interface ITelemetryPersistence {
  saveNormalizedSpans(spans: NormalizedSpan[]): Promise<void>
  saveTurnAnalysis(analysis: TurnAnalysis[]): Promise<void>
  saveEfficiencyScore(score: EfficiencyScore): Promise<void>
  // add any other methods actually called in TelemetryPipeline
}

export interface TelemetryPipelineDeps {
  turnAnalyzer: ITurnAnalyzer
  logTurnAnalyzer: ILogTurnAnalyzer
  categorizer: ICategorizer
  consumerAnalyzer: IConsumerAnalyzer
  efficiencyScorer: IEfficiencyScorer
  recommender: IRecommender
  persistence: ITelemetryPersistence
  logger?: ILogger
}

export class TelemetryPipeline {
  private logger: ILogger
  constructor(private deps: TelemetryPipelineDeps) {
    this.logger = deps.logger ?? console
  }
  // ... implementation unchanged
}
```

### Re-Export Shim Pattern for Migrated Files
```typescript
// src/modules/telemetry/batch-buffer.ts (shim)
export { BatchBuffer } from '@substrate-ai/core'
export type { BatchBufferOptions } from '@substrate-ai/core'

// src/modules/telemetry/telemetry-pipeline.ts (shim — injects concrete scoring classes)
import { TelemetryPipeline as CorePipeline } from '@substrate-ai/core'
export type { RawOtlpPayload, TelemetryPipelineDeps } from '@substrate-ai/core'
// If callers construct TelemetryPipeline directly with concrete classes, this shim
// may need to re-export a wrapped factory that pre-injects the concrete scorers:
export { CorePipeline as TelemetryPipeline }

// src/modules/telemetry/cost-table.ts (shim)
export { COST_TABLE, estimateCost, resolveModel } from '@substrate-ai/core'
```

### TelemetryError Migration
```typescript
// packages/core/src/telemetry/ingestion-server.ts
export class TelemetryError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'TelemetryError'
  }
}
```

If the monolith's callers depend on `TelemetryError instanceof AppError`, the shim can subclass:
```typescript
// src/modules/telemetry/ingestion-server.ts (shim override — only if needed)
import { AppError } from '../../errors/app-error.js'
export class TelemetryError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
  }
}
// Re-export everything else from core
export { IngestionServer, IngestionServerOptions, DispatchContext } from '@substrate-ai/core'
```

### Testing Requirements
- Run `tsc -b` in `packages/core/` after each Task (1–6) to catch type errors early, before creating shims
- Run `npm run test:fast` after Task 7 (shims in place) to confirm zero regressions
- The `__tests__/` directory in `src/modules/telemetry/` must NOT be modified — tests run against the shims transparently
- Watch for tests that directly import scoring classes (`EfficiencyScorer`, `TurnAnalyzer`, etc.) from `telemetry-pipeline.ts` — those classes are NOT migrated in this story; if the shim for `telemetry-pipeline.ts` only re-exports `TelemetryPipeline` but not the scoring classes, those tests will still import from the original (non-shim) scoring files in `src/modules/telemetry/`, which is fine
- **CRITICAL**: Never run tests concurrently — verify `pgrep -f vitest` returns nothing before running; use `timeout: 300000` in Bash tool

## Interface Contracts

- **Export**: `TelemetryPipeline`, `TelemetryPipelineDeps`, `RawOtlpPayload` @ `packages/core/src/telemetry/telemetry-pipeline.ts` (consumed by story 41-6b and monolith shim)
- **Export**: `ITurnAnalyzer`, `ILogTurnAnalyzer`, `ICategorizer`, `IConsumerAnalyzer`, `IEfficiencyScorer`, `IRecommender` @ `packages/core/src/telemetry/telemetry-pipeline.ts` (duck-typed interfaces implemented by story 41-6b scoring classes)
- **Export**: `ITelemetryPersistence` @ `packages/core/src/telemetry/telemetry-pipeline.ts` (implemented by monolith's `TelemetryPersistence` structurally)
- **Export**: `BatchBuffer`, `BatchBufferOptions` @ `packages/core/src/telemetry/batch-buffer.ts` (consumed by IngestionServer in this story and by story 41-7)
- **Export**: `IngestionServer`, `IngestionServerOptions`, `DispatchContext`, `TelemetryError` @ `packages/core/src/telemetry/ingestion-server.ts` (consumed by CLI and substrate run command)
- **Export**: `TelemetryNormalizer` @ `packages/core/src/telemetry/normalizer.ts` (consumed by TelemetryPipeline in this story and by story 41-6b)
- **Export**: `COST_TABLE`, `estimateCost`, `resolveModel` @ `packages/core/src/telemetry/cost-table.ts` (consumed by TelemetryNormalizer; also consumed by story 41-6b's EfficiencyScorer if it uses cost data)
- **Export**: `OtlpSource`, `detectSource` @ `packages/core/src/telemetry/source-detector.ts` (consumed by IngestionServer and TelemetryPipeline in this story)
- **Import**: `ILogger` @ `packages/core/src/dispatch/types.ts` (from story 41-2)
- **Import**: `NormalizedSpan`, `NormalizedLog`, `TurnAnalysis`, `EfficiencyScore`, `Recommendation`, `RecommenderContext`, `CategoryStats`, `ConsumerStats`, `TokenCounts`, `ModelPricing` @ `packages/core/src/telemetry/types.ts` (from story 40-7)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
