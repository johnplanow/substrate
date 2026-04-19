# Story 46-4: Score Display via `substrate metrics`

## Story

As an operator,
I want factory run satisfaction scores displayed in `substrate metrics` output,
so that I can monitor factory convergence quality and track score trends across iterations.

## Acceptance Criteria

### AC1: JSON output includes factory graph runs
**Given** factory graph runs exist in the database
**When** `substrate metrics --output-format json` is executed
**Then** the JSON output includes a `graph_runs` array where each entry has `run_id`, `satisfaction_score`, `iterations`, `convergence_status`, `started_at`, `total_cost_usd`, and `type: 'factory'` fields

### AC2: Factory runs distinguished from SDLC runs in JSON output
**Given** both SDLC pipeline runs and factory graph runs exist in the database
**When** metrics are displayed in JSON format (default or with `--output-format json`)
**Then** SDLC run entries carry `type: 'sdlc'` and factory run entries carry `type: 'factory'` in the JSON output

### AC3: Per-iteration score history via `--run` flag
**Given** a factory run with multiple scenario iterations exists in the database (e.g., `run_id: abc123` has 3 `scenario_results` rows with `iteration` 1, 2, 3)
**When** `substrate metrics --run abc123` is executed
**Then** output contains per-iteration records for that run with fields: `iteration`, `satisfaction_score`, `passed`, `failed`, `threshold`, `passes`, `executed_at`

### AC4: Human-readable table format for factory runs
**Given** factory graph runs exist in the database
**When** metrics are displayed in default human-readable format (no `--output-format json`)
**Then** factory runs are printed as a formatted table with columns: run_id (8-char prefix), score %, passes (✓/✗), started_at, total cost, and convergence_status

### AC5: Score formatted as percentage in human-readable output
**Given** a factory graph run with `satisfaction_score = 0.75`
**When** metrics are displayed in human-readable format
**Then** the score appears formatted as `"75.0%"` (not raw `0.75`)

### AC6: Empty state handled gracefully
**Given** no factory graph runs exist in the database (table is empty or missing)
**When** `substrate metrics` is executed (with or without `--factory`)
**Then** no error is thrown; the factory runs section is silently omitted from the output

### AC7: `--factory` flag filters output to factory runs only
**Given** the user runs `substrate metrics --factory`
**Then** only the factory graph runs section is rendered; SDLC run metrics and StateStore metrics are excluded from output

## Tasks / Subtasks

- [ ] Task 1: Add `getFactoryRunSummaries` query function to `packages/factory/src/persistence/factory-queries.ts` (AC: #1, #3)
  - [ ] Define `FactoryRunSummary` interface: `{ run_id: string; satisfaction_score: number | null; iterations: number; convergence_status: string | null; started_at: string; completed_at: string | null; total_cost_usd: number; type: 'factory' }`
  - [ ] Implement `getFactoryRunSummaries(adapter, limit?: number): Promise<FactoryRunSummary[]>` — queries `graph_runs` joined (or in a second query) with `scenario_results` to compute `iterations` (count of rows per run) and `satisfaction_score` (latest row's `satisfaction_score`); returns results ordered by `started_at DESC`
  - [ ] Export `FactoryRunSummary` and `getFactoryRunSummaries` from `packages/factory/src/index.ts`

- [ ] Task 2: Extend `MetricsOptions` and register CLI flags in `src/cli/commands/metrics.ts` (AC: #1, #3, #7)
  - [ ] Add `run?: string` field to `MetricsOptions` interface (for per-run detail mode)
  - [ ] Add `factory?: boolean` field to `MetricsOptions` interface (for factory-only filter)
  - [ ] Register `--run <run-id>` option in `registerMetricsCommand()`: `'Show per-iteration score history for a specific factory run'`
  - [ ] Register `--factory` option in `registerMetricsCommand()`: `'Show only factory graph run metrics (excludes SDLC runs)'`
  - [ ] Wire both options through the `action()` callback into the `runMetricsAction()` call

- [ ] Task 3: Wire factory run data into JSON and human-readable output (AC: #1, #2, #4, #5, #6)
  - [ ] In `runMetricsAction()`, after the existing adapter/database open block, open the same adapter for factory queries: `import type { FactoryRunSummary } from '@substrate-ai/factory'` and `import { getFactoryRunSummaries } from '@substrate-ai/factory'`
  - [ ] Call `getFactoryRunSummaries(adapter, limit)` inside a `try/catch`; on failure (table missing or adapter error), set `factoryRuns = []` and log at debug level — never throw
  - [ ] For JSON output: attach `graph_runs: factoryRuns` to the existing output object alongside the existing `runs` array (SDLC runs); ensure SDLC run objects carry `type: 'sdlc'`
  - [ ] For human-readable output (when `factory !== true`): call `printFactoryRunTable(factoryRuns)` after the SDLC run section; skip the call if `factoryRuns.length === 0`
  - [ ] Add `printFactoryRunTable(runs: FactoryRunSummary[]): void` function: prints header `\nFactory Runs (${runs.length} records)\n`, separator line `─`.repeat(80), column headers `run_id`, `score`, `passes`, `started_at`, `cost_usd`, `status`, then one row per run with `run_id.slice(0, 8)`, `(score * 100).toFixed(1) + '%'` (or `'—'` if null), `passes ? '✓' : '✗'` (or `'—'` if null), ISO timestamp (first 19 chars), `$${total_cost_usd.toFixed(4)}`, `convergence_status ?? '—'`

- [ ] Task 4: Implement `--run` per-iteration detail mode (AC: #3)
  - [ ] In `runMetricsAction()`, add an early-return block: if `run !== undefined`, call `getScenarioResultsForRun(adapter, run)` (already exported from `@substrate-ai/factory` via story 46-3)
  - [ ] If no rows are returned, emit `{ message: 'No factory run found with id: <run>' }` (JSON) or write to stderr (human); return exit code 1
  - [ ] For JSON output: emit `{ run_id: run, type: 'factory', iterations: rows }` where each row in `iterations` includes `iteration`, `satisfaction_score`, `passed`, `failed`, `threshold`, `passes`, `executed_at`
  - [ ] For human-readable output: print a per-iteration table with columns `#`, `score`, `passes`, `passed/total`, `executed_at`

- [ ] Task 5: Implement `--factory` filter (AC: #7)
  - [ ] In `runMetricsAction()`, when `factory === true`, skip all SDLC-related queries (listRunMetrics, StateStore, telemetry modes) and render only the factory runs section
  - [ ] For JSON output in factory-only mode: emit `{ graph_runs: factoryRuns }` without the `runs` (SDLC) key
  - [ ] For human-readable output in factory-only mode: print only `printFactoryRunTable(factoryRuns)` and return 0

- [ ] Task 6: Write unit tests (AC: #1–#7)
  - [ ] Create `src/cli/commands/__tests__/metrics-factory.test.ts`
  - [ ] Mock `@substrate-ai/factory` module: stub `getFactoryRunSummaries` and `getScenarioResultsForRun` with controllable return values
  - [ ] Mock `../../persistence/adapter` to return a mock `DatabaseAdapter` instance
  - [ ] Test JSON output includes `graph_runs` with correct `type: 'factory'` fields (AC1, AC2)
  - [ ] Test `--run <id>` returns iteration array in JSON (AC3); test exit 1 when no rows returned
  - [ ] Test human-readable `printFactoryRunTable` formats score as percentage and pass/fail as ✓/✗ (AC4, AC5)
  - [ ] Test empty `factoryRuns = []` produces no factory section and no error (AC6)
  - [ ] Test `--factory` flag skips SDLC output and includes only factory data (AC7)
  - [ ] Minimum 10 test cases total

## Dev Notes

### Architecture Constraints
- Import factory types and query functions using the package name `@substrate-ai/factory` — not relative paths — since `src/cli/` is in the monolith layer and `packages/factory/` is a separate package
- Import only types as `import type` when importing TypeScript interfaces from `@substrate-ai/factory` to avoid circular dependency issues at runtime
- The metrics command already calls `createDatabaseAdapter({ backend: 'auto', basePath })` near line 23 — reuse this **same adapter instance** for factory queries; do NOT open a second adapter
- All factory query calls must be wrapped in `try/catch` with debug-level logging — table may not exist in older databases that predate story 46-3
- Do NOT break existing SDLC metrics display — all factory additions are purely additive
- `--run` mode and `--factory` mode must be compatible with both `--output-format json` and default human-readable output

### Implementation Pattern for `getFactoryRunSummaries`
The function must count `iterations` and fetch the latest `satisfaction_score` for each run. Use two queries (not a JOIN) for portable SQL:
1. `SELECT * FROM graph_runs ORDER BY started_at DESC LIMIT ?` — get the run list
2. For each run, `SELECT COUNT(*) as cnt, MAX(satisfaction_score) as latest_score FROM scenario_results WHERE run_id = ?` — or, preferably, a single GROUP BY query: `SELECT run_id, COUNT(*) as iterations, MAX(satisfaction_score) as satisfaction_score FROM scenario_results GROUP BY run_id`

Combine the two result sets in TypeScript: iterate `graph_runs` rows and look up iteration count and latest score from the `scenario_results` GROUP BY result.

### Testing Requirements
- Test file: `src/cli/commands/__tests__/metrics-factory.test.ts`
- Use `vitest` with `describe` / `it` / `expect` / `vi.mock`
- Mock `@substrate-ai/factory` at the top of the test file using `vi.mock('@substrate-ai/factory', () => ({ ... }))`
- Mock `../../persistence/adapter` to return a fake `{ close: vi.fn(), query: vi.fn(), exec: vi.fn(), transaction: vi.fn() }` adapter
- The `getFactoryRunSummaries` mock should return controllable stub data; tests should cover at least: (a) non-empty result set, (b) empty result set, (c) thrown error (graceful degradation)
- For `printFactoryRunTable` formatting tests, capture `process.stdout.write` calls using `vi.spyOn(process.stdout, 'write')`

### File Paths
- **Modified**: `packages/factory/src/persistence/factory-queries.ts` — add `FactoryRunSummary` interface and `getFactoryRunSummaries()` function
- **Modified**: `packages/factory/src/index.ts` — export `FactoryRunSummary` and `getFactoryRunSummaries`
- **Modified**: `src/cli/commands/metrics.ts` — add `run?`, `factory?` to `MetricsOptions`; add factory display logic in `runMetricsAction()`; add `printFactoryRunTable()` helper; add `--run`, `--factory` CLI options in `registerMetricsCommand()`
- **New**: `src/cli/commands/__tests__/metrics-factory.test.ts` — unit tests for factory metrics display

### Dependency Notes
- Requires story 46-3 to be complete: `listGraphRuns`, `getScenarioResultsForRun`, `GraphRunRow`, `ScenarioResultRow` must be exported from `@substrate-ai/factory`
- Does NOT require stories 46-1 or 46-2 — the `satisfaction_score` value is read directly from `scenario_results.satisfaction_score` (already persisted by the executor)

## Interface Contracts

- **Export**: `FactoryRunSummary` @ `packages/factory/src/persistence/factory-queries.ts` (for story 46-4 display and future reporting)
- **Export**: `getFactoryRunSummaries` @ `packages/factory/src/persistence/factory-queries.ts` (consumed by `src/cli/commands/metrics.ts`)
- **Import**: `listGraphRuns`, `getScenarioResultsForRun`, `GraphRunRow`, `ScenarioResultRow` @ `packages/factory/src/persistence/factory-queries.ts` (from story 46-3)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
