# Story 1-6: Routing Telemetry and Savings Measurement

Status: ready-for-dev

## Story

As a pipeline operator,
I want to see a per-phase breakdown of model usage, token counts, and cost savings produced by model routing on each pipeline run,
so that I can validate that the routing configuration is delivering meaningful cost reductions compared to using a single frontier model for all dispatches.

## Acceptance Criteria

### AC1: RoutingAnalyzer Subscribes to Dispatch Events and Accumulates Phase Data
**Given** a `RoutingAnalyzer` constructed with an `eventBus`, `costTable`, and `logger`, and the `dispatch:model-selected` event is now emitted by the dispatcher (story 1-5)
**When** `routingAnalyzer.subscribe()` is called at run start, and multiple dispatches with different phases fire `dispatch:model-selected` events
**Then** the analyzer accumulates, keyed by `runId`, a per-phase dispatch count map `{ phase → { model: string, dispatchCount: number } }`; a single `runId` may span all three phases; events with the same phase but a different model within one run overwrite the model assignment and log a `warn`-level message (multi-model-per-phase is unsupported in v1); calling `subscribe()` twice on the same instance is a no-op (idempotent)

### AC2: computeRoutingMetrics() Distributes Tokens Proportionally and Calculates Costs
**Given** a `RoutingAnalyzer` that has received dispatch events for a run, and a `RunSummary` from `MetricsStore` containing `totalInputTokens` and `totalOutputTokens` for that run
**When** `routingAnalyzer.computeRoutingMetrics(runId, runSummary, baselineModel)` is called
**Then** it distributes `totalInputTokens` and `totalOutputTokens` proportionally across phases by dispatch count; for each phase it calls `costTable.getRateForModel(model)` and computes `estimatedCostUsd = (inputTokens * inputRate + outputTokens * outputRate)`; it computes `baselineCostUsd` as the same total tokens at `costTable.getRateForModel(baselineModel)` rates; it returns a `RoutingRunMetrics` object with `phases[]`, `totalInputTokens`, `totalOutputTokens`, `actualCostUsd`, `baselineCostUsd`, `savingsUsd`, and `savingsPct`; when `costTable.getRateForModel` returns `undefined` for a model, `estimatedCostUsd` for that phase is `0` and a `warn`-level log entry records the unknown model identifier

### AC3: Dolt Migration 014 and DoltRoutingMetricsRepository
**Given** the existing MigrationRunner applies numbered SQL files from the migrations directory
**When** the application starts with a Dolt state store
**Then** migration `014_routing_run_metrics.sql` creates a `routing_run_metrics` table with columns `run_id VARCHAR(64) NOT NULL`, `phase VARCHAR(16) NOT NULL`, `model VARCHAR(128) NOT NULL`, `dispatch_count INT NOT NULL`, `estimated_input_tokens INT NOT NULL`, `estimated_output_tokens INT NOT NULL`, `estimated_cost_usd DECIMAL(10,6) NOT NULL`, `baseline_cost_usd DECIMAL(10,6) NOT NULL`, `savings_usd DECIMAL(10,6) NOT NULL`, `savings_pct DECIMAL(5,2) NOT NULL`, `recorded_at DATETIME NOT NULL`, with a composite primary key `(run_id, phase)`; `DoltRoutingMetricsRepository` implements `IRoutingMetricsRepository` with methods `upsertPhaseRecord(record): Promise<void>` and `getRunMetrics(runId: string): Promise<RoutingPhaseRecord[]>`; all queries use parameterized statements; the migration is idempotent (`CREATE TABLE IF NOT EXISTS`)

### AC4: persistRunMetrics() Writes Routing Summary to Dolt
**Given** `RoutingAnalyzer` was constructed with a `DoltRoutingMetricsRepository` and has computed a `RoutingRunMetrics` for a completed run
**When** `routingAnalyzer.persistRunMetrics(runId, metrics)` is called at run completion
**Then** it calls `repository.upsertPhaseRecord(record)` once per phase in `metrics.phases`, setting `recorded_at` to `new Date().toISOString()`; if the repository throws, the error is caught, logged at `error` level with `{ runId, reason: err.message }`, and `persistRunMetrics` resolves without re-throwing (persistence is non-fatal — it must not abort the run)

### AC5: `substrate metrics --routing` Text Output
**Given** routing metrics exist in Dolt for at least one run (or are passed as an in-memory `RoutingRunMetrics`)
**When** `substrate metrics --routing [--run-id <id>]` is executed in default text mode
**Then** stdout displays: (a) a header line `Routing Summary for run <id>`; (b) a formatted table with columns `Phase`, `Model`, `Dispatches`, `Est. Tokens`, `Est. Cost`; one row per phase; (c) a blank line; (d) a summary block: `Total tokens: X`, `Actual cost: $X.XX`, `Baseline cost (${baselineModel}): $X.XX`, `Savings: $X.XX (Y%)`; when `--run-id` is omitted, the most recent run in `routing_run_metrics` is used; when no routing data exists at all, prints `No routing metrics available.` and exits 0

### AC6: `substrate metrics --routing --output-format json` Output
**Given** routing metrics exist for a run
**When** `substrate metrics --routing --output-format json [--run-id <id>]` is executed
**Then** stdout is a single JSON object (no trailing newline noise) with the shape:
```json
{
  "success": true,
  "runId": "...",
  "phases": [
    { "phase": "explore", "model": "...", "dispatchCount": 3, "estimatedInputTokens": 1200, "estimatedOutputTokens": 800, "estimatedCostUsd": 0.000420 }
  ],
  "totalInputTokens": 5000,
  "totalOutputTokens": 3000,
  "actualCostUsd": 0.003200,
  "baselineCostUsd": 0.006400,
  "savingsUsd": 0.003200,
  "savingsPct": 50.00
}
```
when no routing data exists: `{ "success": false, "error": "No routing metrics found for run <id>" }` with exit code 1; all number fields are unquoted JSON numbers

### AC7: Unit Tests for RoutingAnalyzer ≥80% Branch Coverage
**Given** the implementation is complete
**When** `npm run test:fast` runs the new test files
**Then** `src/modules/telemetry/__tests__/routing-analyzer.test.ts` covers: (a) `subscribe()` idempotency; (b) phase accumulation across multiple `dispatch:model-selected` events; (c) multi-model-per-phase warn path; (d) `computeRoutingMetrics` proportional token distribution for 2- and 3-phase scenarios; (e) `computeRoutingMetrics` with unknown model → cost 0 + warn; (f) `computeRoutingMetrics` with a single-phase run (only generate dispatches); (g) `persistRunMetrics` non-fatal on repository throw; all tests use `vi.fn()` mocks for `eventBus`, `costTable`, `repository`, and `logger` — no real Dolt or I/O

## Interface Contracts

- **Import**: `PipelinePhase` @ `src/modules/routing/index.ts` (from story 1-4)
- **Import**: `dispatch:model-selected` event type @ `src/core/event-bus.types.ts` (from story 1-5)
- **Export**: `IRoutingMetricsRepository`, `RoutingRunMetrics`, `RoutingPhaseRecord` @ `src/modules/telemetry/routing-analyzer.ts` (consumed by metrics CLI command and orchestrator wiring in story 1-8)

## Tasks / Subtasks

- [ ] Task 1: Define types and Zod schema for routing metrics (AC: #1, #2)
  - [ ] Create `src/modules/telemetry/routing-schemas.ts` with:
    - `RoutingPhaseRecordSchema = z.object({ runId: z.string(), phase: z.enum(['explore','generate','review']), model: z.string(), dispatchCount: z.number().int(), estimatedInputTokens: z.number().int(), estimatedOutputTokens: z.number().int(), estimatedCostUsd: z.number(), baselineCostUsd: z.number(), savingsUsd: z.number(), savingsPct: z.number(), recordedAt: z.string() })`
    - `RoutingRunMetricsSchema = z.object({ runId: z.string(), phases: z.array(RoutingPhaseRecordSchema.omit({ runId: true, recordedAt: true })), totalInputTokens: z.number().int(), totalOutputTokens: z.number().int(), actualCostUsd: z.number(), baselineCostUsd: z.number(), savingsUsd: z.number(), savingsPct: z.number() })`
    - Export inferred types: `type RoutingPhaseRecord = z.infer<typeof RoutingPhaseRecordSchema>`, `type RoutingRunMetrics = z.infer<typeof RoutingRunMetricsSchema>`
  - [ ] Define `IRoutingMetricsRepository` interface in `src/modules/telemetry/interfaces.ts` (append to existing file): `upsertPhaseRecord(record: RoutingPhaseRecord): Promise<void>` and `getRunMetrics(runId: string): Promise<RoutingPhaseRecord[]>` and `getLatestRunId(): Promise<string | undefined>`
  - [ ] Define `ModelCostRate` type (if not already in Epic 27 telemetry): `{ inputCostPer1kTokens: number; outputCostPer1kTokens: number }` and `ICostTable` interface: `getRateForModel(modelId: string): ModelCostRate | undefined`
  - [ ] Import order: Node built-ins → third-party (`zod`) → internal; no console.log

- [ ] Task 2: Implement RoutingAnalyzer class (AC: #1, #2, #4)
  - [ ] Create `src/modules/telemetry/routing-analyzer.ts`
  - [ ] Class constructor: `constructor(private readonly eventBus: TypedEventBus, private readonly costTable: ICostTable, private readonly repository: IRoutingMetricsRepository, private readonly logger: pino.Logger)` — store all as `private readonly`
  - [ ] Private fields: `private _subscribed = false` and `private _runPhaseMap = new Map<string, Map<string, { model: string; dispatchCount: number }>>()` where outer key is `runId` and inner key is `phase`
  - [ ] `subscribe(): void`: if `this._subscribed` return immediately; set flag; call `this.eventBus.on('dispatch:model-selected', (payload) => this._handleModelSelected(payload))` — use `as never` cast following the existing event bus pattern
  - [ ] `private _handleModelSelected(payload: { dispatchId: string; runId?: string; taskType: string; phase: 'explore'|'generate'|'review'; model: string; storyKey?: string }): void`: derive `runId` from payload (use `payload.runId ?? payload.storyKey ?? payload.dispatchId` as fallback key); get or create the inner Map for `runId`; if an existing entry for the phase has a different model, log `warn({ component: 'routing', runId, phase, existingModel, newModel }, 'Multiple models for same phase in one run — overwriting')` then update; otherwise increment dispatchCount (or insert with count 1)
  - [ ] `computeRoutingMetrics(runId: string, runSummary: { totalInputTokens: number; totalOutputTokens: number }, baselineModel: string): RoutingRunMetrics`: get the phase map for `runId`; if empty return a zero-metrics object; total dispatchCount = sum across phases; for each phase entry, compute `inputShare = (dispatchCount / total) * runSummary.totalInputTokens` (floored to int); compute outputShare similarly; get rates via `costTable.getRateForModel(model)` — if `undefined`, log warn and set costs to 0; compute `estimatedCostUsd = (inputShare * rate.inputCostPer1kTokens / 1000) + (outputShare * rate.outputCostPer1kTokens / 1000)`; accumulate `actualCostUsd`; compute `baselineCostUsd` using baseline model rate × total tokens; return `RoutingRunMetrics` with `savingsUsd = baselineCostUsd - actualCostUsd` and `savingsPct = baselineCostUsd > 0 ? (savingsUsd / baselineCostUsd) * 100 : 0`
  - [ ] `async persistRunMetrics(runId: string, metrics: RoutingRunMetrics): Promise<void>`: iterate `metrics.phases`; for each, build a `RoutingPhaseRecord` with `runId`, phase fields, `baselineCostUsd: metrics.baselineCostUsd / metrics.phases.length` (distribute evenly for per-row storage), `savingsUsd: (metrics.baselineCostUsd - metrics.actualCostUsd) / metrics.phases.length`, `savingsPct: metrics.savingsPct`, `recordedAt: new Date().toISOString()`; call `await this.repository.upsertPhaseRecord(record)` inside a `try/catch` that logs error and returns (non-fatal)

- [ ] Task 3: Create Dolt migration 014 and DoltRoutingMetricsRepository (AC: #3)
  - [ ] Create `migrations/014_routing_run_metrics.sql`:
    ```sql
    CREATE TABLE IF NOT EXISTS routing_run_metrics (
      run_id VARCHAR(64) NOT NULL,
      phase VARCHAR(16) NOT NULL,
      model VARCHAR(128) NOT NULL,
      dispatch_count INT NOT NULL DEFAULT 0,
      estimated_input_tokens INT NOT NULL DEFAULT 0,
      estimated_output_tokens INT NOT NULL DEFAULT 0,
      estimated_cost_usd DECIMAL(10,6) NOT NULL DEFAULT 0,
      baseline_cost_usd DECIMAL(10,6) NOT NULL DEFAULT 0,
      savings_usd DECIMAL(10,6) NOT NULL DEFAULT 0,
      savings_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      recorded_at DATETIME NOT NULL,
      PRIMARY KEY (run_id, phase)
    );
    ```
  - [ ] Create `src/modules/telemetry/dolt-routing-metrics-repository.ts`; implement `IRoutingMetricsRepository`
  - [ ] `upsertPhaseRecord(record)`: execute an `INSERT INTO routing_run_metrics (...) VALUES (?) ON DUPLICATE KEY UPDATE ...` parameterized statement; convert `estimatedCostUsd` etc. to numeric (not string); `recordedAt` stored as ISO string
  - [ ] `getRunMetrics(runId)`: `SELECT * FROM routing_run_metrics WHERE run_id = ? ORDER BY phase`; map rows to `RoutingPhaseRecord[]`
  - [ ] `getLatestRunId()`: `SELECT run_id FROM routing_run_metrics ORDER BY recorded_at DESC LIMIT 1`; return `rows[0]?.run_id ?? undefined`
  - [ ] Import order: Node built-ins → third-party → internal; constructor accepts the Dolt MySQL2 connection pool (same pattern as `DoltStateStore`)

- [ ] Task 4: Update telemetry module barrel exports (AC: #1, #7)
  - [ ] In `src/modules/telemetry/index.ts`, append exports:
    - `export type { RoutingPhaseRecord, RoutingRunMetrics } from './routing-schemas.js'`
    - `export { RoutingPhaseRecordSchema, RoutingRunMetricsSchema } from './routing-schemas.js'`
    - `export { RoutingAnalyzer } from './routing-analyzer.js'`
    - `export { DoltRoutingMetricsRepository } from './dolt-routing-metrics-repository.js'`
    - `export type { IRoutingMetricsRepository } from './interfaces.js'`
  - [ ] Run `tsc --noEmit` to confirm no circular imports or type errors

- [ ] Task 5: Extend `substrate metrics` CLI command with `--routing` flag (AC: #5, #6)
  - [ ] In `src/cli/commands/metrics.ts`, add Commander option `.option('--routing', 'Show model routing savings for a run')` and `.option('--run-id <runId>', 'Run ID for --routing flag (defaults to most recent)')`
  - [ ] In `runMetricsAction`, add a guard block: `if (options.routing) { await runRoutingMetricsAction(options, program); return; }` — mutual exclusion with existing `--efficiency`, `--recommendations` etc.
  - [ ] Implement `async function runRoutingMetricsAction(options, program)`: construct `DoltRoutingMetricsRepository` from the Dolt connection; resolve `runId` from `options.runId ?? await repo.getLatestRunId()`; if no runId, output "No routing metrics available." (text) or `{ success: false, error: "No routing metrics available." }` (JSON) and exit 0
  - [ ] Query `repo.getRunMetrics(runId)` → `RoutingPhaseRecord[]`; if empty, same "no data" output
  - [ ] Aggregate records into display form: `totalInputTokens = sum(estimated_input_tokens)`, `totalOutputTokens = sum(estimated_output_tokens)`, `actualCostUsd = sum(estimated_cost_usd)`, use first record's `baseline_cost_usd * phases.length` for total baseline, compute `savingsUsd` and `savingsPct`
  - [ ] Text mode: print header, table (padEnd for alignment), and summary block matching the style of existing `--efficiency` output; cost values formatted with `$` prefix and 6 decimal places
  - [ ] JSON mode: write `JSON.stringify({ success: true, runId, phases: [...], totalInputTokens, totalOutputTokens, actualCostUsd, baselineCostUsd, savingsUsd, savingsPct }, null, 2)` to stdout then exit 0
  - [ ] Import `DoltRoutingMetricsRepository` from `../../modules/telemetry/index.js`; follow existing import order in the file

- [ ] Task 6: Unit tests for RoutingAnalyzer (AC: #7)
  - [ ] Create `src/modules/telemetry/__tests__/routing-analyzer.test.ts`
  - [ ] Mock infrastructure:
    ```typescript
    const mockEventBus = { on: vi.fn(), off: vi.fn(), emit: vi.fn() } as unknown as TypedEventBus;
    const mockCostTable: ICostTable = { getRateForModel: vi.fn() };
    const mockRepo: IRoutingMetricsRepository = { upsertPhaseRecord: vi.fn(), getRunMetrics: vi.fn(), getLatestRunId: vi.fn() };
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger;
    ```
  - [ ] Test `subscribe()` idempotency: call twice, assert `eventBus.on` called exactly once
  - [ ] Test phase accumulation: call `subscribe()`, simulate two `dispatch:model-selected` events for `run-1` with phases `explore`+`generate`; verify internal map has both phases with `dispatchCount: 1` each
  - [ ] Test multi-model-per-phase warn: emit two events for same runId and phase but different models; assert `mockLogger.warn` was called; assert the entry holds the second model
  - [ ] Test `computeRoutingMetrics` with two phases: set up 2 explore dispatches and 1 generate dispatch (total 3); pass `runSummary = { totalInputTokens: 3000, totalOutputTokens: 1500 }`; mock `costTable.getRateForModel` to return `{ inputCostPer1kTokens: 0.25, outputCostPer1kTokens: 1.25 }` for explore-model and `{ inputCostPer1kTokens: 3.00, outputCostPer1kTokens: 15.00 }` for generate-model and same generate-model rates for baseline; assert `phases.length === 2`; assert `savingsPct` is positive (routing cheaper than all-generate baseline); assert `totalInputTokens === 3000`
  - [ ] Test unknown model cost: mock `costTable.getRateForModel` returns `undefined` for one model; assert `mockLogger.warn` called; assert that phase's `estimatedCostUsd === 0`; assert overall `actualCostUsd` is not NaN
  - [ ] Test `persistRunMetrics` non-fatal: mock `mockRepo.upsertPhaseRecord` to `vi.fn().mockRejectedValueOnce(new Error('Dolt down'))`; call `persistRunMetrics(runId, metrics)` and assert it resolves (no throw); assert `mockLogger.error` was called

- [ ] Task 7: Build and fast-test gate (AC: #1–#7)
  - [ ] Run `npm run build` — must exit 0 with zero TypeScript errors
  - [ ] Run `npm run test:fast` — must exit 0; all existing telemetry test files must pass without modification; new routing-analyzer tests must all pass; 80% branch coverage threshold must not be broken
  - [ ] Confirm `tsc --noEmit` clean after all file changes; no `any` types introduced except explicit `as unknown as X` casts for mock construction in tests

## Dev Notes

### File Paths (new or modified)
- `migrations/014_routing_run_metrics.sql` — new migration (next after 013_repo_map_meta.sql from story 1-2)
- `src/modules/telemetry/routing-schemas.ts` — new: Zod schemas and inferred types
- `src/modules/telemetry/routing-analyzer.ts` — new: RoutingAnalyzer class
- `src/modules/telemetry/dolt-routing-metrics-repository.ts` — new: Dolt repository implementation
- `src/modules/telemetry/interfaces.ts` — modified: append `IRoutingMetricsRepository` (do NOT remove existing interfaces)
- `src/modules/telemetry/index.ts` — modified: append new exports (append-only)
- `src/cli/commands/metrics.ts` — modified: add `--routing` and `--run-id` flags
- `src/modules/telemetry/__tests__/routing-analyzer.test.ts` — new test file

### Architecture Constraints
- **Do NOT modify** `dispatcher-impl.ts`, `DispatchConfig`, or `DispatchResult` in this story — all dispatcher changes were completed in story 1-5
- **Do NOT add `fs.watch` or any file-watching** — the fs.watch regression pattern documented in project memory applies; all config/repo loading is static at construction time
- `RoutingAnalyzer` must not import directly from `src/modules/routing/` — import `PipelinePhase` type only if needed; inline the `'explore' | 'generate' | 'review'` union to avoid circular dependency risk between telemetry and routing modules
- Token distribution is explicitly proportional-by-dispatch-count; this is an estimation, not exact per-dispatch tracking. The dev notes should include a `// NOTE: token distribution is estimated proportionally` comment at the computation site
- The `dispatch:model-selected` event payload from story 1-5 carries `{ dispatchId, taskType, phase, model, storyKey? }` but **does NOT carry `runId`** — use `storyKey` (if present) as the run grouping key fallback, or maintain a separate run-to-dispatchId registry if the orchestrator provides it. For this story, `storyKey` is used as the `runId` surrogate (this is accurate for the story-per-dispatch model Substrate uses). Document this assumption in a code comment.
- All Dolt SQL uses `?` placeholders (MySQL2 style), NOT `$1` (postgres style) and NOT better-sqlite3 named params
- `ICostTable.getRateForModel` — if this interface already exists in the Epic 27 telemetry module (e.g., in `src/modules/telemetry/cost-table.ts` from story 27-10), import and reuse it. Do NOT create a duplicate. Check for an existing `CostTable` or `ICostTable` before creating. If the interface doesn't exist, create it in `routing-schemas.ts`.

### Dependency on Existing Code
- `dispatch:model-selected` event type defined in `src/core/event-bus.types.ts` by story 1-5 — must be importable as a typed key from `OrchestratorEvents`
- `TypedEventBus` — import from `src/core/event-bus.js` (or wherever the project's event bus lives); follow the `as never` cast pattern documented in story 1-5 dev notes when using `eventBus.on` with event keys
- `TelemetryPersistence` / Dolt connection pool — follow the same construction pattern used in `src/cli/commands/metrics.ts` for existing `--efficiency` flag: the Dolt path is derived from `process.env.DOLT_STATE_PATH` or the project's default state directory
- `MigrationRunner` — the `014_routing_run_metrics.sql` file must be placed in the same `migrations/` directory as existing files (001–013); MigrationRunner discovers them by glob and applies in numeric order
- `pino` logger — import type as `import type pino from 'pino'`; create child loggers with `{ component: 'routing-telemetry' }`; never call `console.log`

### Testing Requirements
- Vitest (NOT Jest); `vi.mock`, `vi.fn()`, `vi.spyOn` exclusively
- No real Dolt connection in unit tests — mock `IRoutingMetricsRepository` with `vi.fn()` stubs
- No real `TypedEventBus` — mock with `{ on: vi.fn(), off: vi.fn(), emit: vi.fn() }` and capture the `on` callback manually in tests to simulate events
- Mock `ICostTable` — return controlled `ModelCostRate` values to produce predictable cost assertions
- To simulate a `dispatch:model-selected` event in tests: capture the listener registered via `mockEventBus.on` and call it directly with a typed payload
- Test file co-located in `src/modules/telemetry/__tests__/` — the directory should already exist from Epic 27; verify with `ls` before creating
- Coverage threshold is 80% enforced globally — ensure new code does not drop any existing module below threshold

### Savings Computation Example (for test reference)
Given 2 explore dispatches at `haiku` rates + 1 generate dispatch at `sonnet` rates, total 3000 input + 1500 output tokens:
- Explore input: 2000, output: 1000 → cost = (2000×0.00025 + 1000×0.00125) = $0.00050 + $0.00125 = $0.00175
- Generate input: 1000, output: 500 → cost = (1000×0.003 + 500×0.015) = $0.003 + $0.0075 = $0.0105
- Actual total: $0.01225
- Baseline (all sonnet): (3000×0.003 + 1500×0.015) = $0.009 + $0.0225 = $0.0315
- Savings: $0.0315 − $0.01225 = $0.01925 (61.1%)

(Rates above are illustrative only — use whatever `mockCostTable` returns in tests.)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
