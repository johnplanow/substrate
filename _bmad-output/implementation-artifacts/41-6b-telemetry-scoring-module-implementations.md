# Story 41.6b: Core Telemetry Migration — Scoring Module Implementations

## Story

As a substrate-core package consumer,
I want `TurnAnalyzer`, `LogTurnAnalyzer`, `Categorizer`, `ConsumerAnalyzer`, `EfficiencyScorer`, and `Recommender` available from `@substrate-ai/core`,
so that the telemetry scoring layer is fully decoupled from the monolith and downstream packages can compute telemetry analysis without importing from `src/modules/telemetry/`.

## Acceptance Criteria

### AC1: TurnAnalyzer and LogTurnAnalyzer migrated to packages/core/src/telemetry/
**Given** `TurnAnalyzer` and `LogTurnAnalyzer` currently live in `src/modules/telemetry/` and their method signatures match the `ITurnAnalyzer` and `ILogTurnAnalyzer` duck-typed interfaces defined in story 41-6a's `telemetry-pipeline.ts`
**When** story 41-6b is complete
**Then** `packages/core/src/telemetry/turn-analyzer.ts` and `packages/core/src/telemetry/log-turn-analyzer.ts` exist; each class structurally satisfies the corresponding interface from `./telemetry-pipeline.js`; all imports use `.js` extensions; zero imports from `src/`; `tsc -b` passes in `packages/core/`

### AC2: Categorizer and ConsumerAnalyzer migrated to packages/core/src/telemetry/
**Given** `Categorizer` and `ConsumerAnalyzer` implement `ICategorizer` and `IConsumerAnalyzer` respectively, and depend only on telemetry types already available in `./types.js`
**When** `packages/core/src/telemetry/categorizer.ts` and `packages/core/src/telemetry/consumer-analyzer.ts` are created
**Then** both classes are exported from core; each structurally satisfies the corresponding duck-typed interface; all imports use `.js` extensions and resolve within `packages/core/src/`; `tsc -b` passes in `packages/core/`

### AC3: EfficiencyScorer migrated to packages/core/src/telemetry/ with ILogger injection
**Given** `EfficiencyScorer` implements `IEfficiencyScorer`, may use cost data from `cost-table.ts` (already in core via story 41-6a), and calls `createLogger` from the monolith
**When** `packages/core/src/telemetry/efficiency-scorer.ts` is created
**Then** `EfficiencyScorer` is exported from core; `createLogger` is replaced with `logger?: ILogger` from `../dispatch/types.js` defaulting to `console`; cost-table imports use `./cost-table.js`; all imports resolve to core-package paths using `.js` extensions; `tsc -b` passes in `packages/core/`

### AC4: Recommender migrated to packages/core/src/telemetry/
**Given** `Recommender` implements `IRecommender` and depends on telemetry types already in `./types.js`
**When** `packages/core/src/telemetry/recommender.ts` is created
**Then** `Recommender` is exported from core; it structurally satisfies `IRecommender`; all imports use `.js` extensions and resolve within `packages/core/src/`; `tsc -b` passes in `packages/core/`

### AC5: packages/core barrel exports all new scoring symbols and builds without TypeScript errors
**Given** 6 new scoring module files are added to `packages/core/src/telemetry/`
**When** `packages/core/src/telemetry/index.ts` and `packages/core/src/index.ts` are updated
**Then** all 6 scoring classes (`TurnAnalyzer`, `LogTurnAnalyzer`, `Categorizer`, `ConsumerAnalyzer`, `EfficiencyScorer`, `Recommender`) are importable from `@substrate-ai/core`; `tsc -b` in `packages/core/` exits with code 0; no name collisions with existing exports from prior stories

### AC6: Re-export shims at all original src/modules/telemetry/ paths and TelemetryPipeline shim updated
**Given** the 6 migrated scoring files in `src/modules/telemetry/` are replaced with re-export shims pointing to `@substrate-ai/core`
**When** shims are in place and the `TelemetryPipeline` shim from story 41-6a is updated to inject the now-available concrete scoring classes
**Then** each shim exports all symbols that existing monolith callers use; the `TelemetryPipeline` shim injects concrete scoring instances into `TelemetryPipelineDeps` so the pipeline's behavior is identical to pre-migration; `src/modules/telemetry/index.ts` barrel still exports all scoring classes

### AC7: All existing tests pass without modification
**Given** all 6 shims and the updated `TelemetryPipeline` shim are in place
**When** `npm run test:fast` is executed
**Then** all tests in `src/modules/telemetry/__tests__/` pass without any test file modifications; no implementation code remains in `src/modules/telemetry/` for the 6 migrated files; the exit code matches the "Test Files" summary in the output

## Tasks / Subtasks

- [ ] Task 1: Locate and audit scoring module source files (AC: #1–4)
  - [ ] Run `grep -r "class TurnAnalyzer\|class LogTurnAnalyzer\|class Categorizer\|class ConsumerAnalyzer\|class EfficiencyScorer\|class Recommender" src/modules/telemetry/ --include="*.ts" -l` to confirm exact file paths for all 6 classes
  - [ ] For each file, inspect imports to identify: which types come from `./types.ts`, which come from `./cost-table.ts`, which use `createLogger`, and any cross-scoring-module dependencies (e.g., `EfficiencyScorer` importing `TurnAnalysis` output shapes); document before migrating
  - [ ] Confirm the duck-typed interface method signatures in `packages/core/src/telemetry/telemetry-pipeline.ts` match the existing class method signatures; note any discrepancies that need reconciliation

- [ ] Task 2: Migrate TurnAnalyzer and LogTurnAnalyzer to core (AC: #1)
  - [ ] Copy `TurnAnalyzer` source to `packages/core/src/telemetry/turn-analyzer.ts`; update all imports to `.js` extensions; replace `createLogger` with `logger?: ILogger` from `../dispatch/types.js` defaulting to `console`; import all telemetry types from `./types.js`; add `implements ITurnAnalyzer` from `./telemetry-pipeline.js` to catch signature mismatches at compile time
  - [ ] Copy `LogTurnAnalyzer` source to `packages/core/src/telemetry/log-turn-analyzer.ts`; apply same import updates; add `implements ILogTurnAnalyzer` from `./telemetry-pipeline.js`; add `logger?: ILogger` injection if `createLogger` is present
  - [ ] Run `tsc -b` in `packages/core/` and fix any type errors before proceeding to Task 3

- [ ] Task 3: Migrate Categorizer and ConsumerAnalyzer to core (AC: #2)
  - [ ] Copy `Categorizer` source to `packages/core/src/telemetry/categorizer.ts`; replace all monolith imports with core-package equivalents using `.js` extensions; add `implements ICategorizer` from `./telemetry-pipeline.js`; add `logger?: ILogger` injection if `createLogger` is present
  - [ ] Copy `ConsumerAnalyzer` source to `packages/core/src/telemetry/consumer-analyzer.ts`; apply same import updates; add `implements IConsumerAnalyzer` from `./telemetry-pipeline.js`
  - [ ] Run `tsc -b` in `packages/core/` and fix any type errors before proceeding to Task 4

- [ ] Task 4: Migrate EfficiencyScorer to core (AC: #3)
  - [ ] Copy `EfficiencyScorer` source to `packages/core/src/telemetry/efficiency-scorer.ts`
  - [ ] Replace `createLogger` with `logger?: ILogger` from `../dispatch/types.js` defaulting to `console`; update cost-table imports to `./cost-table.js`; update all other monolith imports to use `.js` extensions within `packages/core/src/`; add `implements IEfficiencyScorer` from `./telemetry-pipeline.js`
  - [ ] Run `tsc -b` in `packages/core/` and fix any type errors before proceeding to Task 5

- [ ] Task 5: Migrate Recommender to core (AC: #4)
  - [ ] Copy `Recommender` source to `packages/core/src/telemetry/recommender.ts`; replace all monolith imports with core-package equivalents using `.js` extensions; add `implements IRecommender` from `./telemetry-pipeline.js`; add `logger?: ILogger` injection if `createLogger` is present
  - [ ] Run `tsc -b` in `packages/core/` and fix any type errors before proceeding to Task 6

- [ ] Task 6: Update barrel exports in packages/core (AC: #5)
  - [ ] Update `packages/core/src/telemetry/index.ts` to export all 6 new scoring classes alongside the existing exports added in story 41-6a; ensure all 6 are named exports (not wildcard only, to avoid accidental shadowing)
  - [ ] Verify `packages/core/src/index.ts` exposes the scoring classes via the telemetry re-export path; check no name collisions with exports from other namespaces (dispatch, persistence, routing, config)
  - [ ] Run `tsc -b` in `packages/core/` and confirm zero type errors

- [ ] Task 7: Create re-export shims, update TelemetryPipeline shim, and verify all tests pass (AC: #6, #7)
  - [ ] Replace each of the 6 migrated scoring files in `src/modules/telemetry/` with a thin re-export shim: `export { TurnAnalyzer } from '@substrate-ai/core'` — include all named exports from each original file (run `grep "^export" <file>` before replacing to capture every export)
  - [ ] Update the `TelemetryPipeline` shim created in story 41-6a (`src/modules/telemetry/telemetry-pipeline.ts`): import the concrete scoring classes from the shims and build a `TelemetryPipelineDeps` object to inject into `CorePipeline`; export the configured pipeline so callers requiring no-argument construction continue to work
  - [ ] Verify `src/modules/telemetry/index.ts` barrel still re-exports all 6 scoring classes; update if needed so existing monolith callers compile without changes
  - [ ] Run `pgrep -f vitest` and confirm no vitest instances are running, then run `npm run test:fast`; confirm all tests in `src/modules/telemetry/__tests__/` pass without modification; confirm "Test Files" line appears in output and exit code is 0

## Dev Notes

### Architecture Constraints
- **ESM `.js` imports**: All intra-package imports in `packages/core/src/` must use `.js` extensions (e.g., `import { TurnAnalysis } from './types.js'`)
- **No imports from `src/` in `packages/core/`**: The core package must be fully self-contained; any import path containing `../../src/` or `../../../` pointing into the monolith is forbidden
- **ILogger injection**: Replace all `createLogger()` / `pino` calls with `logger?: ILogger` parameter (import from `../dispatch/types.js`); default to `console`; never redefine `ILogger`
- **Depends on story 41-6a**: All duck-typed interfaces (`ITurnAnalyzer`, `ILogTurnAnalyzer`, `ICategorizer`, `IConsumerAnalyzer`, `IEfficiencyScorer`, `IRecommender`), all infrastructure modules, and cost/utility helpers must be available in core before this story starts
- **Structural interface compliance**: Adding `implements ITurnAnalyzer` (etc.) to migrated classes is recommended to catch method signature mismatches at compile time — TypeScript's structural typing will satisfy callers even without it, but the `implements` keyword gives earlier error detection
- **Inter-scoring-module dependencies**: If a scoring module imports from another scoring module (e.g., `EfficiencyScorer` calling helpers defined in `turn-analyzer.ts`), ensure the dependency is also migrated or already available in core; update imports to `.js` extensions targeting the newly-migrated core files

### Scoring Module Import Pattern in Core
```typescript
// packages/core/src/telemetry/turn-analyzer.ts
import type { ILogger } from '../dispatch/types.js'
import type { NormalizedSpan, TurnAnalysis } from './types.js'
import type { ITurnAnalyzer } from './telemetry-pipeline.js'

export class TurnAnalyzer implements ITurnAnalyzer {
  private logger: ILogger
  constructor(logger?: ILogger) {
    this.logger = logger ?? console
  }
  analyze(spans: NormalizedSpan[]): TurnAnalysis[] {
    // ... existing implementation unchanged
  }
}
```

```typescript
// packages/core/src/telemetry/efficiency-scorer.ts
import type { ILogger } from '../dispatch/types.js'
import type { TurnAnalysis, EfficiencyScore } from './types.js'
import { estimateCost, COST_TABLE } from './cost-table.js'
import type { IEfficiencyScorer } from './telemetry-pipeline.js'

export class EfficiencyScorer implements IEfficiencyScorer {
  private logger: ILogger
  constructor(logger?: ILogger) {
    this.logger = logger ?? console
  }
  score(turns: TurnAnalysis[], taskType?: string): EfficiencyScore {
    // ... existing implementation unchanged
  }
}
```

### Re-Export Shim Pattern
```typescript
// src/modules/telemetry/turn-analyzer.ts (shim)
export { TurnAnalyzer } from '@substrate-ai/core'

// src/modules/telemetry/log-turn-analyzer.ts (shim)
export { LogTurnAnalyzer } from '@substrate-ai/core'

// src/modules/telemetry/efficiency-scorer.ts (shim)
export { EfficiencyScorer } from '@substrate-ai/core'

// src/modules/telemetry/categorizer.ts (shim)
export { Categorizer } from '@substrate-ai/core'

// src/modules/telemetry/consumer-analyzer.ts (shim)
export { ConsumerAnalyzer } from '@substrate-ai/core'

// src/modules/telemetry/recommender.ts (shim)
export { Recommender } from '@substrate-ai/core'
```

### TelemetryPipeline Shim Update (Task 7)
After 41-6b completes, the `TelemetryPipeline` core class requires dependency injection. If the monolith previously constructed `TelemetryPipeline` with `new TelemetryPipeline()` (no args), update the shim to pre-inject the concrete scoring classes:

```typescript
// src/modules/telemetry/telemetry-pipeline.ts (shim — updated after 41-6b)
import {
  TelemetryPipeline as CorePipeline,
  type RawOtlpPayload,
  type TelemetryPipelineDeps,
} from '@substrate-ai/core'
import { TurnAnalyzer } from './turn-analyzer.js'       // shim → core
import { LogTurnAnalyzer } from './log-turn-analyzer.js' // shim → core
import { Categorizer } from './categorizer.js'           // shim → core
import { ConsumerAnalyzer } from './consumer-analyzer.js'// shim → core
import { EfficiencyScorer } from './efficiency-scorer.js'// shim → core
import { Recommender } from './recommender.js'           // shim → core

export { CorePipeline as TelemetryPipeline, RawOtlpPayload, TelemetryPipelineDeps }

// If callers construct TelemetryPipeline directly with concrete scorers already
// injected in the original code, the above pass-through is sufficient.
// If callers used `new TelemetryPipeline()` with no args (scorers were wired
// internally), export a preconfigured factory or subclass that builds deps:
export function createTelemetryPipeline(persistence: ITelemetryPersistence): CorePipeline {
  return new CorePipeline({
    turnAnalyzer: new TurnAnalyzer(),
    logTurnAnalyzer: new LogTurnAnalyzer(),
    categorizer: new Categorizer(),
    consumerAnalyzer: new ConsumerAnalyzer(),
    efficiencyScorer: new EfficiencyScorer(),
    recommender: new Recommender(),
    persistence,
  })
}
```
Inspect existing monolith callers of `TelemetryPipeline` before deciding which shim variant is needed.

### Testing Requirements
- Run `tsc -b` in `packages/core/` after each Task (2–6) to catch type errors early before creating shims
- Run `npm run test:fast` after Task 7 (all shims in place) to confirm zero regressions
- The `__tests__/` directory in `src/modules/telemetry/` must NOT be modified
- **CRITICAL**: Never run tests concurrently — verify `pgrep -f vitest` returns nothing before running; use `timeout: 300000` in Bash tool
- If any test directly imports a scoring class (e.g., `import { EfficiencyScorer } from '../efficiency-scorer'`), the shim transparently satisfies that import since it re-exports the same class from core

## Interface Contracts

- **Import**: `ITurnAnalyzer`, `ILogTurnAnalyzer`, `ICategorizer`, `IConsumerAnalyzer`, `IEfficiencyScorer`, `IRecommender` @ `packages/core/src/telemetry/telemetry-pipeline.ts` (from story 41-6a)
- **Import**: `NormalizedSpan`, `NormalizedLog`, `TurnAnalysis`, `EfficiencyScore`, `Recommendation`, `RecommenderContext`, `CategoryStats`, `ConsumerStats` @ `packages/core/src/telemetry/types.ts` (from story 40-7)
- **Import**: `ILogger` @ `packages/core/src/dispatch/types.ts` (from story 41-2)
- **Import**: `estimateCost`, `COST_TABLE`, `resolveModel` @ `packages/core/src/telemetry/cost-table.ts` (from story 41-6a)
- **Export**: `TurnAnalyzer` @ `packages/core/src/telemetry/turn-analyzer.ts` (consumed by `TelemetryPipelineDeps` injection in monolith shim and by downstream packages)
- **Export**: `LogTurnAnalyzer` @ `packages/core/src/telemetry/log-turn-analyzer.ts` (consumed by `TelemetryPipelineDeps` injection)
- **Export**: `Categorizer` @ `packages/core/src/telemetry/categorizer.ts` (consumed by `TelemetryPipelineDeps` injection)
- **Export**: `ConsumerAnalyzer` @ `packages/core/src/telemetry/consumer-analyzer.ts` (consumed by `TelemetryPipelineDeps` injection)
- **Export**: `EfficiencyScorer` @ `packages/core/src/telemetry/efficiency-scorer.ts` (consumed by `TelemetryPipelineDeps` injection)
- **Export**: `Recommender` @ `packages/core/src/telemetry/recommender.ts` (consumed by `TelemetryPipelineDeps` injection)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
