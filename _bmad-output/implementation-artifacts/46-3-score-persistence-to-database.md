# Story 46-3: Score Persistence to Database

## Story

As a substrate factory pipeline,
I want satisfaction scores and graph execution results persisted to the database after every run,
so that score history and per-node outcomes are durable across sessions and queryable via `substrate metrics`.

## Acceptance Criteria

### AC1: Scenario Result Row Persisted
**Given** a graph execution run in which a scenario node completes with a satisfaction score of 0.85 (e.g., 17/20 scenarios passed, threshold 0.8)
**When** the scenario node finishes and the executor persists results to the adapter
**Then** a row is written to `scenario_results` with all fields populated: `run_id`, `node_id`, `iteration`, `total_scenarios`, `passed`, `failed`, `satisfaction_score`, `threshold`, `passes` (true), and `details` (JSON string of the score breakdown)

### AC2: Multiple Iterations Queryable by run_id
**Given** a factory run that completed 3 convergence iterations (3 scenario:completed events for the same run_id)
**When** `getScenarioResultsForRun(adapter, runId)` is called
**Then** exactly 3 rows are returned, each with distinct `iteration` values (1, 2, 3) and the correct `satisfaction_score` for each iteration

### AC3: Graph Run Record Created on Start and Updated on Completion
**Given** a factory graph execution with a known `runId`, `graph_file`, and `goal`
**When** execution starts with an adapter provided
**Then** a `graph_runs` row is inserted with `status: 'running'` and `started_at` set
**And** when the run terminates (success or fail)
**Then** the same row is updated with `status: 'completed'` or `'failed'`, `final_outcome`, `total_cost_usd`, and `completed_at`

### AC4: Graph Node Result Row Written Per Node
**Given** a graph execution with multiple nodes (e.g., node-A at attempt 1, node-B at attempt 2)
**When** each node finishes execution (post allowPartial demotion)
**Then** one `graph_node_results` row is written per node-execution with `run_id`, `node_id`, `attempt`, `status`, `started_at`, `completed_at`, `duration_ms`, and `cost_usd`

### AC5: Persistence Is Optional and Backward-Compatible
**Given** a `GraphExecutorConfig` with no `adapter` field
**When** the executor runs a graph
**Then** execution completes normally with no persistence calls made and no errors thrown (all persistence is guarded by `if (config.adapter)` checks)

### AC6: Factory Query Functions Exported from Package
**Given** the `@substrate-ai/factory` package is imported
**When** named exports are destructured
**Then** `upsertGraphRun`, `insertGraphNodeResult`, `insertScenarioResult`, `getScenarioResultsForRun`, and `listGraphRuns` are all available as named exports

### AC7: Unit Tests for All Query Functions Pass
**Given** the `factory-queries.test.ts` test suite running against an in-memory adapter with `factorySchema` initialized
**When** all tests are executed
**Then** tests for insert, read, and upsert (overwrite on second call) pass for all five query functions with ≥10 test cases total

## Tasks / Subtasks

- [x] Task 1: Create `packages/factory/src/persistence/factory-queries.ts` (AC: #1, #2, #3, #4, #6)
  - [x] Define TypeScript interfaces: `GraphRunInput`, `GraphRunRow`, `GraphNodeResultInput`, `GraphNodeResultRow`, `ScenarioResultInput`, `ScenarioResultRow`
  - [x] Implement `upsertGraphRun(adapter, input)` — portable select-then-delete-then-insert inside a transaction; on first call inserts with `status: 'running'`; on second call (completion) replaces the row with updated `status`, `completed_at`, `final_outcome`, `total_cost_usd`
  - [x] Implement `insertGraphNodeResult(adapter, input)` — append a `graph_node_results` row; no upsert needed since each attempt is a distinct row
  - [x] Implement `insertScenarioResult(adapter, input)` — append a `scenario_results` row; serialize `details` breakdown as JSON string when present
  - [x] Implement `getScenarioResultsForRun(adapter, runId)` — `SELECT * FROM scenario_results WHERE run_id = ? ORDER BY iteration ASC`
  - [x] Implement `listGraphRuns(adapter, limit?)` — `SELECT * FROM graph_runs ORDER BY started_at DESC LIMIT ?` (default limit 20)

- [x] Task 2: Integrate persistence into `packages/factory/src/graph/executor.ts` (AC: #1, #3, #4, #5)
  - [x] Add optional `adapter?: DatabaseAdapter` field and optional `satisfactionThreshold?: number` (default 0.8) to `GraphExecutorConfig` interface
  - [x] At run start (before the main traversal loop): call `upsertGraphRun` with `status: 'running'`, `graph_file`, `goal`, `node_count`, when adapter is provided
  - [x] After each node completes (after allowPartial demotion, before edge selection): call `insertGraphNodeResult` with `nodeId`, `attempt` (from `nodeRetries` map), `status`, timing (`startedAt` / `Date.now()`), and `cost_usd` from context key `factory.lastNodeCostUsd`
  - [x] Subscribe to `scenario:completed` event on `config.eventBus` during initialization: when the event fires, call `computeSatisfactionScore(results, threshold)` then `insertScenarioResult` with `run_id`, `nodeId` (from event context), `iteration` (convergenceIteration at time of event), and serialized breakdown
  - [x] At run exit (just before the final `return { status: 'SUCCESS' }` and all `return { status: 'FAIL' }` paths): call `upsertGraphRun` with `status: 'completed'`/`'failed'`, `final_outcome`, `total_cost_usd` from `pipelineManager.getTotalCost()`, `completed_at: new Date().toISOString()`

- [x] Task 3: Write unit tests `packages/factory/src/persistence/__tests__/factory-queries.test.ts` (AC: #1, #2, #3, #4, #7)
  - [x] Set up `beforeEach` with `createDatabaseAdapter({ backend: 'memory' })` + `factorySchema(adapter)`
  - [x] Test `upsertGraphRun`: first call inserts a row with `status: 'running'`; second call with same `id` replaces the row with `status: 'completed'` and new `final_outcome`
  - [x] Test `insertScenarioResult`: inserts row with all fields; `details` field round-trips as JSON
  - [x] Test `getScenarioResultsForRun`: returns rows in iteration order; empty array when no rows exist
  - [x] Test `insertGraphNodeResult`: inserts row with timing and cost data; multiple rows for same `run_id` are all returned
  - [x] Test `listGraphRuns`: returns rows in descending `started_at` order; respects `limit` parameter

- [x] Task 4: Export factory queries from `packages/factory/src/index.ts` (AC: #6)
  - [x] Add `export * from './persistence/factory-queries.js'` to `packages/factory/src/index.ts`
  - [x] Verify no name conflicts with existing exports (check `GraphRunInput` / `GraphRunRow` are not already exported)
  - [x] Run `npm run build` and confirm zero TypeScript errors

## Dev Notes

### Architecture Constraints
- Import `DatabaseAdapter` as a **type** only from `@substrate-ai/core`: `import type { DatabaseAdapter } from '@substrate-ai/core'`
- All query functions follow the established pattern from `packages/core/src/persistence/queries/metrics.ts`: accept `adapter` as first arg, use `adapter.query<T>(sql, params)` for reads and `adapter.exec(sql)` / `adapter.transaction(async tx => { ... })` for writes
- The `upsertGraphRun` implementation must be portable across InMemoryDatabaseAdapter and DoltDatabaseAdapter — use the select-then-delete-then-insert pattern inside `adapter.transaction()` (not `INSERT OR REPLACE` which is SQLite-specific)
- `details` column in `scenario_results` is `TEXT` — serialize with `JSON.stringify(breakdown)` on write; parse with `JSON.parse` on read in `ScenarioResultRow`
- Do NOT import concrete adapter classes (`InMemoryDatabaseAdapter`, `DoltDatabaseAdapter`) in factory code — only use the `DatabaseAdapter` interface
- The executor's `pipelineManager` tracks cumulative cost via `pipelineManager.addCost(nodeCost)` already. Add a `getTotalCost()` method to `PipelineBudgetManager` if not already present, or read the cost from the context key `factory.totalPipelineCostUsd` if the manager writes it there

### Testing Requirements
- Test file: `packages/factory/src/persistence/__tests__/factory-queries.test.ts`
- Use `vitest` with `describe` / `it` / `expect` / `beforeEach` — same pattern as `factory-schema.test.ts`
- Always call `factorySchema(adapter)` in `beforeEach` to ensure tables exist before queries run
- Insert a parent `graph_runs` row before inserting `graph_node_results` or `scenario_results` (FK constraint)
- Use string ISO timestamps (`new Date().toISOString()`) for `started_at` / `completed_at` fields in test data

### Executor Integration Notes
- Add `adapter?: DatabaseAdapter` and `satisfactionThreshold?: number` to the `GraphExecutorConfig` interface declared at the top of `executor.ts`
- Import `computeSatisfactionScore` from `'../scenarios/scorer.js'` (already re-exported via `../scenarios/index.js`)
- Import the query functions from `'../persistence/factory-queries.js'`
- For the `scenario:completed` subscription, use `config.eventBus?.on('scenario:completed', handler)` or subscribe to the event inside the run method. Since `TypedEventBus` is used, the handler signature is `(payload: { runId: string; results: ScenarioRunResult; iteration: number }) => void`
- The `nodeId` for `scenario_results` rows should come from the `currentNode.id` at the time of the scenario:completed event, or track it via a module-level variable set when a scenario node starts
- The `iteration` field in `scenario_results` corresponds to `convergenceIteration` at the time of the scenario completion event
- All persistence calls must be wrapped in `if (config.adapter)` guards — never assume adapter is present

### File Paths
- **New**: `packages/factory/src/persistence/factory-queries.ts`
- **New**: `packages/factory/src/persistence/__tests__/factory-queries.test.ts`
- **Modified**: `packages/factory/src/graph/executor.ts` — add `adapter?` and `satisfactionThreshold?` to `GraphExecutorConfig`; add persistence calls at run start, per-node, on scenario:completed, and at run exit
- **Modified**: `packages/factory/src/index.ts` — add `export * from './persistence/factory-queries.js'`

## Interface Contracts

- **Export**: `GraphRunInput`, `GraphRunRow`, `GraphNodeResultInput`, `GraphNodeResultRow`, `ScenarioResultInput`, `ScenarioResultRow` @ `packages/factory/src/persistence/factory-queries.ts` (from story 46-3)
- **Export**: `upsertGraphRun`, `insertGraphNodeResult`, `insertScenarioResult`, `getScenarioResultsForRun`, `listGraphRuns` @ `packages/factory/src/persistence/factory-queries.ts` (from story 46-3)
- **Import**: `factorySchema` @ `packages/factory/src/persistence/factory-schema.ts` (from story 44-6)
- **Import**: `computeSatisfactionScore`, `SatisfactionScore` @ `packages/factory/src/scenarios/scorer.ts` (story 46-1 adds weighted support; basic version from story 44-5 is sufficient for persistence)
- **Import**: `DatabaseAdapter` @ `@substrate-ai/core` (existing interface)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
