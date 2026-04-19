# Story 26-5: Pipeline Metrics Migration to StateStore

Status: complete

## Story

As a pipeline operator,
I want story-level metrics routed through the StateStore abstraction,
so that when the Dolt backend is active, metrics become SQL-queryable across stories, sprints, and task types without parsing flat files or joining JSON decisions.

## Acceptance Criteria

### AC1: Metrics Callsites Write Through StateStore
**Given** the dispatcher or orchestrator records per-story metrics at the end of each story execution (currently via the `STORY_METRICS` decision category)
**When** a story completes (success, failure, or escalation) and a `StateStore` is available
**Then** `stateStore.recordMetric(metric)` is called with a complete `MetricRecord` containing: `story_key`, `task_type`, `model`, `tokens_in`, `tokens_out`, `cache_read_tokens`, `cost_usd`, `wall_clock_ms`, `review_cycles`, `stall_count`, `result`, `sprint` (optional), `timestamp` (ISO 8601)

### AC2: MetricRecord and MetricFilter Types Extended
**Given** the `MetricRecord` and `MetricFilter` interfaces in `src/modules/state/types.ts` (story 26-1)
**When** story 26-5 implementation is merged
**Then**:
- `MetricRecord` includes optional `sprint?: string`, `timestamp?: string` fields alongside all existing required fields
- `MetricFilter` includes query fields: `sprint?: string`, `story_key?: string`, `task_type?: string`, `since?: string` (ISO date), `aggregate?: boolean`

### AC3: substrate metrics CLI — Dolt-Backed Filters
**Given** the Dolt backend is active (`.substrate/state/.dolt/` directory exists) and metrics have been recorded
**When** `substrate metrics` is called with `--sprint <sprint>`, `--story <storyKey>`, `--task-type <type>`, or `--since <date>` flags
**Then** the command creates a `DoltStateStore` and calls `queryMetrics(filter)` with the appropriate filter fields, returning only matching rows

### AC4: Aggregation Output via --aggregate Flag
**Given** the Dolt backend is active with multiple metric rows across stories and task types
**When** `substrate metrics --aggregate` is called
**Then** output includes per-task-type aggregates: `AVG(cost_usd)`, `SUM(tokens_in)`, `SUM(tokens_out)`, `COUNT(*)`, plus overall totals — in both human and `--output-format json` modes

### AC5: File Backend Backward Compatibility
**Given** the file backend is configured (default, no Dolt dir present)
**When** metrics are recorded and `substrate metrics` is called (with or without the new flags)
**Then** all existing behavior is unchanged: decisions table still written via `STORY_METRICS` category, `--compare`, `--tag-baseline`, `--analysis`, `--limit` modes still function identically

### AC6: DoltStateStore queryMetrics Supports All Filters
**Given** a `DoltStateStore` backed by a Dolt repo with the metrics table populated (schema from story 26-2)
**When** `queryMetrics(filter)` is called with sprint, story_key, task_type, since, or aggregate fields
**Then** the WHERE clause and optional GROUP BY are constructed correctly and the correct rows (or aggregates) are returned

### AC7: Tests Pass with Zero Regressions
**Given** updated metrics callsites, extended types, and new CLI flags
**When** `npm run test:fast` runs
**Then** all existing tests continue to pass and new tests cover: `recordMetric` called with correct fields (mock StateStore), `queryMetrics` filter construction (mock DoltClient), aggregation output format (unit), file backend no-regression path

## Interface Contracts

- **Import**: `StateStore`, `MetricRecord`, `MetricFilter` @ `src/modules/state/types.ts` (from story 26-1)
- **Import**: `DoltStateStore`, `createDoltStateStore` @ `src/modules/state/dolt-store.ts` (from story 26-3)
- **Export**: updated `MetricRecord` (adds `sprint?`, `timestamp?` fields) @ `src/modules/state/types.ts` (consumed by stories 26-4, 26-7)
- **Export**: updated `MetricFilter` (adds `sprint?`, `story_key?`, `task_type?`, `since?`, `aggregate?`) @ `src/modules/state/types.ts` (consumed by stories 26-7, 26-8)

## Tasks / Subtasks

- [ ] Task 1: Extend `MetricRecord` and `MetricFilter` types (AC2)
  - [ ] Open `src/modules/state/types.ts` (story 26-1 output); add `sprint?: string` and `timestamp?: string` to `MetricRecord`
  - [ ] Add filter fields to `MetricFilter`: `sprint?: string`, `story_key?: string`, `task_type?: string`, `since?: string`, `aggregate?: boolean`
  - [ ] Add `AggregateMetricResult` interface: `{ task_type: string; avg_cost_usd: number; sum_tokens_in: number; sum_tokens_out: number; count: number }`
  - [ ] Export `AggregateMetricResult` from `src/modules/state/index.ts`
  - [ ] Verify `MetricRecord` in `src/modules/state/schema.sql` (story 26-2) includes `sprint TEXT` and `timestamp TEXT NOT NULL` columns; add them if missing

- [ ] Task 2: Update `DoltStateStore.queryMetrics` to support all filter fields (AC6)
  - [ ] Open `src/modules/state/dolt-store.ts` (story 26-3 output)
  - [ ] In `queryMetrics(filter)`: build WHERE clause from `filter.sprint`, `filter.story_key`, `filter.task_type`, `filter.since` (using `timestamp >= ?`)
  - [ ] When `filter.aggregate === true`: execute `SELECT task_type, AVG(cost_usd) as avg_cost_usd, SUM(tokens_in) as sum_tokens_in, SUM(tokens_out) as sum_tokens_out, COUNT(*) as count FROM metrics [WHERE ...] GROUP BY task_type`; return as typed `AggregateMetricResult[]`
  - [ ] Unit tests: mock `DoltClient.query` and assert SQL contains correct WHERE predicates and GROUP BY for each filter combination

- [ ] Task 3: Locate and update metrics recording callsites (AC1)
  - [ ] Search codebase for `STORY_METRICS` from `src/persistence/schemas/operational.ts` — find where story-level metrics are currently recorded (likely `src/modules/agent-dispatch/dispatcher-impl.ts` or orchestrator-impl)
  - [ ] Accept `StateStore` via the existing dependency injection object at that callsite (add `stateStore?: StateStore` to the deps interface)
  - [ ] After the existing `STORY_METRICS` decision write, call `await stateStore.recordMetric({ story_key, task_type, model, tokens_in, tokens_out, cache_read_tokens, cost_usd, wall_clock_ms, review_cycles, stall_count, result, sprint, timestamp: new Date().toISOString() })` when `stateStore` is present
  - [ ] Map existing metric fields from current storage format to `MetricRecord` — align names carefully (`input_tokens` → `tokens_in`, `output_tokens` → `tokens_out`, `wall_clock_seconds * 1000` → `wall_clock_ms` if needed)
  - [ ] Unit test: construct dispatcher/orchestrator with mock StateStore, trigger story completion, assert `stateStore.recordMetric` called once with all required fields

- [ ] Task 4: Extend `metrics` CLI with new flags and Dolt query path (AC3, AC4, AC5)
  - [ ] In `src/cli/commands/metrics.ts`, extend `MetricsOptions` interface: add `sprint?: string`, `story?: string`, `taskType?: string`, `since?: string`, `aggregate?: boolean`
  - [ ] Add CLI options in `registerMetricsCommand`: `--sprint <sprint>`, `--story <storyKey>`, `--task-type <type>`, `--since <date>`, `--aggregate`
  - [ ] In `runMetricsAction`: detect Dolt backend by checking `existsSync(join(dbRoot, '.substrate', 'state', '.dolt'))` — only use StateStore path when Dolt dir is present AND any new filter flag is provided OR `--aggregate` is passed
  - [ ] Dolt path: create `DoltStateStore` (via `createStateStore({ backend: 'dolt', basePath: join(dbRoot, '.substrate', 'state') })`), call `queryMetrics(filter)`, format and output results
  - [ ] Aggregation output (human format): table with columns `task_type | count | avg_cost_usd | sum_tokens_in | sum_tokens_out`
  - [ ] File path (default): preserve all existing logic untouched — do not alter any existing branch

- [ ] Task 5: Unit and integration tests (AC7)
  - [ ] Create `src/modules/state/__tests__/metrics-routing.test.ts`:
    - [ ] Mock StateStore via `vi.fn()` for `recordMetric`; invoke the metrics recording path; assert called with correct `MetricRecord` shape
    - [ ] Test `queryMetrics` filter building: assert sprint/story/task-type/since filters produce correct SQL (via mocked DoltClient)
    - [ ] Test aggregation query: assert GROUP BY SQL emitted when `aggregate: true`
  - [ ] Create/update `src/cli/commands/__tests__/metrics.test.ts`:
    - [ ] Test new flags parsed correctly and passed to `runMetricsAction`
    - [ ] Test Dolt path activated when `.substrate/state/.dolt/` exists (mock `existsSync`)
    - [ ] Test file path preserved when Dolt dir absent (mock `existsSync` returns false)
  - [ ] Run `npm run test:fast` — all tests must pass including existing metrics tests

## Dev Notes

### Architecture Constraints
- **File paths to modify**: `src/modules/state/types.ts`, `src/modules/state/dolt-store.ts`, `src/modules/state/index.ts`, `src/cli/commands/metrics.ts`
- **File paths to discover**: find metrics recording callsite by searching for `STORY_METRICS` usage (`grep -r STORY_METRICS src/`)
- **Import style**: ES modules with `.js` extensions on all local imports (e.g., `import { StateStore } from './types.js'`)
- **Node builtins**: use `node:` prefix (`import { existsSync } from 'node:fs'`)
- **Type imports**: use `import type { ... }` for type-only imports
- **StateStore import path** (from CLI): `import { createStateStore } from '../../modules/state/index.js'`
- **Logger**: `import { createLogger } from '../../utils/logger.js'`; namespace `'cli:metrics'`
- **Story 26-1 dependency**: `MetricRecord`, `MetricFilter`, `StateStore` types from `src/modules/state/types.ts` — must be present; if not yet merged, create local stubs
- **Story 26-3 dependency**: `DoltStateStore`, `createStateStore` from `src/modules/state/dolt-store.ts` — must be present for Dolt path; guard Dolt-specific code with runtime check for `.dolt/` dir
- **No parallel SQLite + Dolt writes for run-level metrics**: only story-level metrics (per story_key) go through StateStore; the `run_metrics` SQLite table written by the orchestrator at pipeline start/end is out of scope for this story
- **Field name alignment**: current STORY_METRICS decisions use `input_tokens`/`output_tokens`/`wall_clock_seconds`; `MetricRecord` uses `tokens_in`/`tokens_out`/`wall_clock_ms` — apply mapping at the recording callsite
- **Dolt detection**: use `existsSync(join(dbRoot, '.substrate', 'state', '.dolt'))` — do not assume Dolt is running; use CLI fallback from `DoltClient`

### Testing Requirements
- **Framework**: vitest (NOT jest). Run with `npm run test:fast`.
- **Coverage threshold**: 80% — do not drop below.
- **Mock strategy**: mock `StateStore` with `vi.fn()` for unit tests; mock `existsSync` to control Dolt vs file path selection in CLI tests
- **Dolt integration**: guard with `try { execSync('dolt version') } catch { context.skip() }` for tests that require a real Dolt binary
- **Test file locations**: `src/modules/state/__tests__/metrics-routing.test.ts`, `src/cli/commands/__tests__/metrics.test.ts`
- **No jest APIs**: `describe`, `it`, `expect`, `vi.fn()`, `beforeEach`, `afterEach` — all from vitest

### Current Metrics Storage (for reference)
The current metrics CLI reads two things from SQLite:
1. **Run-level metrics** via `listRunMetrics(db, limit)` from `src/persistence/queries/metrics.ts` — these are out of scope
2. **Story-level metrics** via `getDecisionsByCategory(db, STORY_METRICS)` from `src/persistence/queries/decisions.ts` — key format `{storyKey}:{runId}`, value is JSON with `wall_clock_seconds`, `input_tokens`, `output_tokens`, `review_cycles`, `stalled`, `cost_usd`

Story 26-5 routes story-level metrics through StateStore. The recording callsite (where decisions are written with `STORY_METRICS` category) is the place to inject the StateStore call.

### Dolt metrics table schema (from story 26-2)
```sql
CREATE TABLE IF NOT EXISTS metrics (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  story_key      TEXT NOT NULL,
  task_type      TEXT NOT NULL,
  model          TEXT,
  tokens_in      INTEGER NOT NULL DEFAULT 0,
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0.0,
  wall_clock_ms  INTEGER NOT NULL DEFAULT 0,
  review_cycles  INTEGER NOT NULL DEFAULT 0,
  stall_count    INTEGER NOT NULL DEFAULT 0,
  result         TEXT NOT NULL,
  sprint         TEXT,
  timestamp      TEXT NOT NULL,
  INDEX idx_metrics_story (story_key),
  INDEX idx_metrics_sprint (sprint),
  INDEX idx_metrics_type (task_type)
);
```
Note: If story 26-2 schema does not include `sprint` and `timestamp` columns, add them in Task 1 of this story via ALTER TABLE in a new migration or by modifying schema.sql and re-running `dolt sql -f`.

### Aggregation Query Pattern
```typescript
// aggregate mode
const sql = `
  SELECT task_type,
         AVG(cost_usd)    AS avg_cost_usd,
         SUM(tokens_in)   AS sum_tokens_in,
         SUM(tokens_out)  AS sum_tokens_out,
         COUNT(*)         AS count
  FROM metrics
  ${whereClause}
  GROUP BY task_type
  ORDER BY sum_tokens_in DESC
`
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
