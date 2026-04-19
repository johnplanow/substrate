# Story 41.7: Supervisor, Budget, Cost-Tracker, and Monitor Migration

## Story

As a substrate-core package consumer,
I want `analyzeTokenEfficiency`, `analyzeTimings`, `generateRecommendations`, `Experimenter`, `BudgetTracker`, `CostTracker`, `CostTrackerSubscriber`, `MonitorAgent`, and supporting monitor utilities available from `@substrate-ai/core`,
so that downstream packages can perform run analysis, budget enforcement, cost recording, and agent performance monitoring without importing from the monolith's `src/modules/`.

## Acceptance Criteria

### AC1: Supervisor analysis functions migrated to packages/core/src/supervisor/ (excluding analyzeReviewCycles)
**Given** `src/modules/supervisor/analysis.ts` contains `analyzeTokenEfficiency`, `analyzeReviewCycles`, `analyzeTimings`, `generateRecommendations`, `generateAnalysisReport`, and `writeAnalysisReport`
**When** story 41-7 is complete
**Then** `packages/core/src/supervisor/analysis.ts` contains all functions and types from the original **except** `analyzeReviewCycles`, `ReviewCycleFinding`, and `ReviewCycleAnalysis`; all imports use `.js` extensions and resolve only to `../persistence/` paths within core or `node:` built-ins; no imports from `src/`

### AC2: analyzeReviewCycles remains in the monolith and is not present in core
**Given** `analyzeReviewCycles` operates on SDLC-specific `review_cycles` fields that carry story-phase semantics
**When** the supervisor shim at `src/modules/supervisor/analysis.ts` is written
**Then** `analyzeReviewCycles` is implemented in a new file `src/modules/supervisor/review-cycle-analysis.ts` that imports from `@substrate-ai/core` for persistence types; the shim re-exports everything from `@substrate-ai/core/supervisor` plus `analyzeReviewCycles` from `./review-cycle-analysis.js`; `packages/core/src/supervisor/` has no mention of `analyzeReviewCycles`

### AC3: Experimenter migrated to core with duck-typed SpawnFn interface
**Given** `src/modules/supervisor/experimenter.ts` imports `spawnGit` from `../git-worktree/git-utils.js` (not yet in core as of story 41-7) and uses `SpawnFn` as an injectable abstraction
**When** `packages/core/src/supervisor/experimenter.ts` is created
**Then** `SpawnFn`, `ExperimenterDeps`, `ExperimentConfig`, `ExperimentRunOptions`, `Experimenter`, `ExperimentResult`, `ExperimentPhase`, `ExperimentVerdict`, `ExperimentMetricDeltas`, `SupervisorRecommendation`, `RunStoryFn`, `buildBranchName`, `buildWorktreePath`, `buildModificationDirective`, `resolvePromptFile`, `determineVerdict`, `buildPRBody`, `buildAuditLogEntry`, and `createExperimenter` are all exported from core; `spawnGit` is **not** imported — `SpawnFn` is caller-supplied via `ExperimenterDeps`; all persistence imports resolve to local core paths; no imports from `src/`

### AC4: BudgetTracker and CostTracker modules migrated to core
**Given** `src/modules/budget/budget-tracker.ts` depends on `TypedEventBus` (already in core) and `createLogger`; `src/modules/cost-tracker/` contains `cost-tracker-impl.ts`, `cost-tracker-subscriber.ts`, `token-rates.ts`, and `types.ts`
**When** `packages/core/src/budget/` and `packages/core/src/cost-tracker/` are populated
**Then** `BudgetTracker`, `BudgetTrackerImpl`, `BudgetTrackerOptions`, `createBudgetTracker`, `CostTracker`, `CostTrackerImpl`, `CostTrackerOptions`, `createCostTracker`, `CostTrackerSubscriber`, `CostTrackerSubscriberOptions`, `createCostTrackerSubscriber`, `TokenRates`, `ModelRates`, `TOKEN_RATES`, `PROVIDER_ALIASES`, `getTokenRate`, `estimateCost`, `estimateCostSafe`, `CostEntry`, `TaskCostSummary`, `AgentCostBreakdown`, and `SessionCostSummary` are all exported from `@substrate-ai/core`; `createLogger` calls are replaced with `logger?: ILogger` from `../dispatch/types.js` defaulting to `console`; `BaseService` dependency is satisfied by a locally defined `IBaseService` interface in `packages/core/src/types.ts` or inline duck type; no imports from `src/`

### AC5: Monitor module migrated to core
**Given** `src/modules/monitor/` contains 7 files implementing `MonitorAgent`, `MonitorAgentImpl`, `TaskTypeClassifier`, `RecommendationEngine`, `ReportGenerator`, `RecommendationTypes`, and `PerformanceAggregates`; these depend on `MonitorDatabase` from `../../persistence/monitor-database.js`
**When** `packages/core/src/monitor/` is populated
**Then** all 7 files are migrated with `.js` extension imports; `MonitorDatabase` is imported from `../persistence/monitor-database.js` (core-relative path); `createLogger` replaced with `ILogger` injection; `BaseService` satisfied by the same `IBaseService` interface used in AC4; all exported symbols (`MonitorAgent`, `TaskMetrics`, `MonitorAgentImpl`, `MonitorConfig`, `MonitorAgentOptions`, `createMonitorAgent`, `TaskTypeClassifier`, `createTaskTypeClassifier`, `DEFAULT_TAXONOMY`, `RecommendationEngine`, `createRecommendationEngine`, `MonitorRecommendationConfig`, `MonitorReport`, `ReportGeneratorOptions`, `generateMonitorReport`, `Recommendation`, `ConfidenceLevel`, `RecommendationFilters`, `RecommendationExport`, `createRecommendation`, `AgentPerformanceMetrics`, `TaskTypeBreakdownResult`) are importable from `@substrate-ai/core`

### AC6: packages/core barrel exports all new symbols and tsc builds clean
**Given** new implementations are added across `packages/core/src/{supervisor,budget,cost-tracker,monitor}/`
**When** `packages/core/src/index.ts` and each module's `index.ts` are updated
**Then** all new symbols from ACs 1–5 are importable from `@substrate-ai/core`; running `tsc -b packages/core/` exits with code 0 and no type errors or warnings

### AC7: Re-export shims installed at all original src/modules/ paths and all existing tests pass
**Given** monolith callers import from `src/modules/{supervisor,budget,cost-tracker,monitor}/`
**When** implementation files in those directories are replaced with thin re-export shims
**Then** each original `index.ts` re-exports all previously visible symbols from `@substrate-ai/core` (plus `analyzeReviewCycles` from the local `review-cycle-analysis.ts` in the supervisor shim); running `npm run test:fast` exits 0 and the output contains a "Test Files" summary line with no failures

## Tasks / Subtasks

- [ ] Task 1: Migrate supervisor analysis functions to `packages/core/src/supervisor/analysis.ts` (AC: #1)
  - [ ] Create `packages/core/src/supervisor/` directory; copy `src/modules/supervisor/analysis.ts` as the starting point
  - [ ] Remove `analyzeReviewCycles`, `ReviewCycleFinding`, and `ReviewCycleAnalysis` from the core file; keep all remaining types and functions (`PhaseDurations`, `TokenEfficiencyFinding`, `TimingFinding`, `TimingAnalysis`, `RecommendationType`, `AnalysisRecommendation`, `AnalysisSummary`, `AnalysisFindings`, `AnalysisReport`, `analyzeTokenEfficiency`, `analyzeTimings`, `generateRecommendations`, `generateAnalysisReport`, `writeAnalysisReport`)
  - [ ] Update all imports to `.js` extensions and core-relative paths (e.g., `../persistence/queries/metrics.js`); remove any `createLogger` / `pino` usage; use `node:fs` and `node:path` for file I/O unchanged
  - [ ] Run `tsc -b packages/core/` and fix any type errors before proceeding

- [ ] Task 2: Migrate Experimenter to `packages/core/src/supervisor/experimenter.ts` (AC: #3)
  - [ ] Copy `src/modules/supervisor/experimenter.ts` to `packages/core/src/supervisor/experimenter.ts`
  - [ ] Remove the `import { spawnGit, GitSpawnResult, SpawnOptions }` from `../git-worktree/git-utils.js`; ensure `SpawnFn` is defined locally as `type SpawnFn = (args: string[], options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>` (or match the actual signature); confirm `ExperimenterDeps` already includes `spawnGit: SpawnFn` so the git dependency is caller-supplied
  - [ ] Update all persistence imports to core-relative paths: `../persistence/queries/metrics.js`, `../persistence/queries/decisions.js`, `../persistence/schemas/operational.js`, `../persistence/adapter.js`; use `.js` extensions throughout; remove any `createLogger` usage
  - [ ] Create `packages/core/src/supervisor/index.ts` that re-exports all symbols from `./analysis.js` and `./experimenter.js`; run `tsc -b packages/core/` and fix any type errors

- [ ] Task 3: Create supervisor shim and extract analyzeReviewCycles to monolith-only file (AC: #2)
  - [ ] Create `src/modules/supervisor/review-cycle-analysis.ts` containing `analyzeReviewCycles`, `ReviewCycleFinding`, and `ReviewCycleAnalysis`; it may import persistence types from `@substrate-ai/core` and monolith persistence paths; do not change the function logic
  - [ ] Replace `src/modules/supervisor/analysis.ts` with a thin re-export shim: `export { analyzeTokenEfficiency, analyzeTimings, generateRecommendations, generateAnalysisReport, writeAnalysisReport, ... } from '@substrate-ai/core'` (all migrated types and functions)
  - [ ] Replace `src/modules/supervisor/index.ts` with a shim that re-exports from `@substrate-ai/core` for migrated symbols plus `export { analyzeReviewCycles, ReviewCycleFinding, ReviewCycleAnalysis } from './review-cycle-analysis.js'`
  - [ ] Run `npm run test:fast` after this task and confirm supervisor tests still pass

- [ ] Task 4: Migrate budget module to `packages/core/src/budget/` (AC: #4, partial)
  - [ ] Create `packages/core/src/budget/budget-tracker.ts`; if `BaseService` is not already exported from `@substrate-ai/core`, define a minimal `IBaseService` interface locally in `packages/core/src/types.ts` (or equivalent) with `initialize(): Promise<void>` and `shutdown(): Promise<void>` methods; use it instead of the monolith's `BaseService`
  - [ ] Replace `import { TypedEventBus } from '../../core/event-bus.js'` with `import type { TypedEventBus } from '../events/index.js'`; replace `createLogger` with `logger?: ILogger` from `../dispatch/types.js` defaulting to `console`; update all imports to `.js` extensions
  - [ ] Create `packages/core/src/budget/index.ts` exporting all budget symbols; run `tsc -b packages/core/` and fix any type errors; create shim at `src/modules/budget/budget-tracker.ts` and update `src/modules/budget/index.ts`

- [ ] Task 5: Migrate cost-tracker module to `packages/core/src/cost-tracker/` (AC: #4, partial)
  - [ ] Copy `token-rates.ts` first (no monolith deps); update to `.js` extensions; export `TokenRates`, `ModelRates`, `TOKEN_RATES`, `PROVIDER_ALIASES`, `getTokenRate`, `estimateCost`, `estimateCostSafe`
  - [ ] Copy `types.ts`; redirect the re-export of `CostEntry`, `TaskCostSummary`, `AgentCostBreakdown`, `SessionCostSummary` to `../persistence/cost-types.js` (core-relative path instead of the current `../../packages/core/src/persistence/cost-types.js` path)
  - [ ] Copy `cost-tracker-impl.ts`; replace `TypedEventBus` import with core path (`../events/index.js`); replace `DatabaseAdapter` import with `../persistence/adapter.js`; replace persistence query imports with core-relative paths; replace `createLogger` with `ILogger` injection; update `BaseService` if needed
  - [ ] Copy `cost-tracker-subscriber.ts`; update all imports similarly; create `packages/core/src/cost-tracker/index.ts` barrel; run `tsc -b packages/core/` and fix any type errors; create shims for all 4 files in `src/modules/cost-tracker/`

- [ ] Task 6: Migrate monitor module to `packages/core/src/monitor/` (AC: #5)
  - [ ] Start with pure type/utility files: copy `recommendation-types.ts`, `performance-aggregates.ts`, and `task-type-classifier.ts` to `packages/core/src/monitor/`; update to `.js` extensions; no monolith deps expected in these files; run `tsc -b packages/core/` after each file
  - [ ] Copy `recommendation-engine.ts`; update `MonitorDatabase` import to `../persistence/monitor-database.js`; update `recommendation-types.js` import to `./recommendation-types.js`; replace `createLogger` with `ILogger` injection; run `tsc -b packages/core/`
  - [ ] Copy `report-generator.ts`; update `MonitorDatabase` and `RecommendationEngine` imports to core-relative paths; replace `createLogger` with `ILogger` injection; run `tsc -b packages/core/`
  - [ ] Copy `monitor-agent.ts` (interface file); update `BaseService` to use `IBaseService` (same solution as AC4); copy `monitor-agent-impl.ts`; update `TypedEventBus`, `MonitorDatabase`, `TaskTypeClassifier`, `RecommendationEngine`, `Recommendation` imports to core-relative paths; replace `createLogger` with `ILogger` injection
  - [ ] Create `packages/core/src/monitor/index.ts` barrel exporting all symbols; run `tsc -b packages/core/` and ensure zero errors; create shims for all 7 files in `src/modules/monitor/`

- [ ] Task 7: Update packages/core barrel exports (AC: #6)
  - [ ] Update `packages/core/src/index.ts` to add re-exports from `./supervisor/index.js`, `./budget/index.js`, `./cost-tracker/index.js`, `./monitor/index.js`; include all symbols listed in ACs 1, 3, 4, and 5
  - [ ] Run `tsc -b packages/core/` and confirm exit code 0 with no errors; spot-check that key symbols (`analyzeTokenEfficiency`, `createExperimenter`, `BudgetTrackerImpl`, `CostTrackerImpl`, `MonitorAgentImpl`, `TOKEN_RATES`) are importable from `@substrate-ai/core` by checking the compiled output in `packages/core/dist/`

- [ ] Task 8: Install all shims and verify full test suite passes (AC: #7)
  - [ ] Verify all shim files are in place for: `src/modules/supervisor/` (analysis.ts, experimenter.ts, index.ts), `src/modules/budget/` (budget-tracker.ts, index.ts), `src/modules/cost-tracker/` (all 4 files + index.ts), `src/modules/monitor/` (all 7 files + index.ts)
  - [ ] Run `npm run build` and confirm it exits 0
  - [ ] Confirm no vitest processes are running (`pgrep -f vitest` returns nothing); then run `npm run test:fast` with a 300-second timeout; confirm output contains "Test Files" summary line with zero failures

## Dev Notes

### Architecture Constraints
- All intra-package imports in `packages/core/src/` **must** use `.js` extensions (e.g., `./analysis.js`, `../persistence/adapter.js`)
- No file in `packages/core/src/` may import from `src/` (monolith paths are forbidden)
- Replace all `createLogger()` / `pino` usage with `logger?: ILogger` injection; import `ILogger` from `../dispatch/types.js`; default to `console` in constructors
- `BaseService` from `src/core/di.ts` is a monolith type — define `IBaseService { initialize(): Promise<void>; shutdown(): Promise<void> }` in `packages/core/src/types.ts` if not already present, then satisfy the constraint by implementing that interface instead
- Error classes in core must extend plain `Error`, not `AppError` from the monolith
- `spawnGit` from `src/modules/git-worktree/` is NOT yet in core (migrates in story 41-8) — Experimenter must satisfy the `SpawnFn` interface via caller injection through `ExperimenterDeps`, not by importing `spawnGit` directly

### Key Import Path Mappings (monolith → core-relative)
| Monolith import | Core-relative import |
|---|---|
| `../../core/event-bus.js` | `../events/index.js` |
| `../../persistence/adapter.js` | `../persistence/adapter.js` |
| `../../persistence/queries/metrics.js` | `../persistence/queries/metrics.js` |
| `../../persistence/queries/decisions.js` | `../persistence/queries/decisions.js` |
| `../../persistence/queries/cost.js` | `../persistence/queries/cost.js` |
| `../../persistence/schemas/operational.js` | `../persistence/schemas/operational.js` |
| `../../persistence/monitor-database.js` | `../persistence/monitor-database.js` |
| `../../core/di.js` (BaseService) | define `IBaseService` locally in core |
| `../../utils/logger.js` (createLogger) | remove; use `ILogger` from `../dispatch/types.js` |
| `../git-worktree/git-utils.js` (spawnGit) | remove; use caller-supplied `SpawnFn` in `ExperimenterDeps` |

### SDLC Boundary (Critical)
- `analyzeReviewCycles`, `ReviewCycleFinding`, and `ReviewCycleAnalysis` are **SDLC-specific** and must **not** be present in `packages/core/src/supervisor/`
- These belong in `src/modules/supervisor/review-cycle-analysis.ts` (a new monolith-only file)
- The supervisor shim at `src/modules/supervisor/index.ts` must still export them so existing callers see no API change

### MonitorDatabase Dependency
- `MonitorDatabase` is imported from `../../persistence/monitor-database.js` in the monolith; verify that `packages/core/src/persistence/monitor-database.ts` exists (it should have been created in story 41-3); if not, check the persistence barrel and use the correct core-relative path

### Testing Requirements
- **Never run tests concurrently** — verify `pgrep -f vitest` returns nothing before running
- **Always use `timeout: 300000`** (5 min) when running tests
- **Never pipe test output** — must see raw vitest output including "Test Files" summary line
- Prefer `npm run test:fast` during iteration (unit tests only, ~50s)
- After all shims are in place, run `npm run build` then `npm run test:fast`

### Build Verification Cycle
For each task, the recommended micro-loop is:
1. Copy implementation file(s) to `packages/core/src/<module>/`
2. Update imports to `.js` extensions and core-relative paths
3. Run `tsc -b packages/core/` — must exit 0 before proceeding
4. Create the re-export shim
5. Run `npm run test:fast` after completing a full module (shim + core)

### File Layout Summary
```
packages/core/src/
├── supervisor/
│   ├── analysis.ts          (migrated, no analyzeReviewCycles)
│   ├── experimenter.ts      (migrated, SpawnFn caller-supplied)
│   └── index.ts             (barrel)
├── budget/
│   ├── budget-tracker.ts    (migrated, ILogger injection)
│   └── index.ts             (barrel)
├── cost-tracker/
│   ├── token-rates.ts       (migrated)
│   ├── types.ts             (redirected re-export)
│   ├── cost-tracker-impl.ts (migrated)
│   ├── cost-tracker-subscriber.ts (migrated)
│   └── index.ts             (barrel)
└── monitor/
    ├── recommendation-types.ts  (migrated)
    ├── performance-aggregates.ts (migrated)
    ├── task-type-classifier.ts  (migrated)
    ├── recommendation-engine.ts (migrated)
    ├── report-generator.ts      (migrated)
    ├── monitor-agent.ts         (interface, IBaseService)
    ├── monitor-agent-impl.ts    (migrated)
    └── index.ts                 (barrel)

src/modules/supervisor/
├── analysis.ts               → shim → @substrate-ai/core
├── experimenter.ts           → shim → @substrate-ai/core
├── review-cycle-analysis.ts  → NEW (SDLC-specific, not shimmed)
└── index.ts                  → shim + re-export from review-cycle-analysis.ts

src/modules/budget/
├── budget-tracker.ts         → shim → @substrate-ai/core
└── index.ts                  → shim → @substrate-ai/core

src/modules/cost-tracker/
├── token-rates.ts            → shim → @substrate-ai/core
├── types.ts                  → shim → @substrate-ai/core
├── cost-tracker-impl.ts      → shim → @substrate-ai/core
├── cost-tracker-subscriber.ts → shim → @substrate-ai/core
└── index.ts                  → shim → @substrate-ai/core

src/modules/monitor/
├── monitor-agent.ts          → shim → @substrate-ai/core
├── monitor-agent-impl.ts     → shim → @substrate-ai/core
├── recommendation-types.ts   → shim → @substrate-ai/core
├── recommendation-engine.ts  → shim → @substrate-ai/core
├── report-generator.ts       → shim → @substrate-ai/core
├── task-type-classifier.ts   → shim → @substrate-ai/core
├── performance-aggregates.ts → shim → @substrate-ai/core
└── index.ts                  → shim → @substrate-ai/core
```

## Interface Contracts

- **Export**: `SpawnFn` @ `packages/core/src/supervisor/experimenter.ts` (caller-injectable git spawn abstraction; story 41-8 will supply a concrete implementation)
- **Export**: `IBaseService` @ `packages/core/src/types.ts` (service lifecycle interface; satisfies budget, cost-tracker, and monitor BaseService dependencies)
- **Import**: `TypedEventBus` @ `packages/core/src/events/index.ts` (from story 41-1)
- **Import**: `DatabaseAdapter` @ `packages/core/src/persistence/adapter.ts` (from story 41-3)
- **Import**: `ILogger` @ `packages/core/src/dispatch/types.ts` (from story 41-2)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
