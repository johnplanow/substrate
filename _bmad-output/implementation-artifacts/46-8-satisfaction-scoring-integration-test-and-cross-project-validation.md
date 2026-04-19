# Story 46-8: Satisfaction Scoring Integration Test and Cross-Project Validation

## Story

As a factory pipeline operator,
I want an end-to-end validated satisfaction scoring pipeline,
so that I can trust that weighted scenario evaluation, dual-signal coordination, score persistence, and metrics display all compose correctly before Phase C development begins.

## Acceptance Criteria

### AC1: Weighted Scoring Accuracy — Boundary and Edge Cases
**Given** a factory run with one critical scenario (weight=3.0, passes), one standard scenario (weight=1.0, passes), and one standard scenario (weight=1.0, fails)
**When** `createSatisfactionScorer(0.8).compute(runResult, weights)` is called
**Then** the returned score equals exactly 4/5 = 0.80, `passes` is `true`, and the breakdown contains 3 entries with contributions `0.60`, `0.20`, and `0.00` respectively; and when the critical scenario fails instead, score equals 2/5 = 0.40 and `passes` is `false`

### AC2: Dual-Signal Phase 2 — Agreement Tracking Across 10 Evaluations
**Given** 10 mock evaluations: 8 agreeing pairs (SHIP_IT/score≥0.8 or NEEDS_MAJOR_REWORK/score<0.8) and 2 disagreeing pairs (SHIP_IT/score<0.8 and NEEDS_MINOR_FIXES/score≥0.8)
**When** `evaluateDualSignal` is called for each pair with threshold 0.8
**Then** exactly 8 evaluations return `agreement: 'AGREE'` and 2 return `agreement: 'DISAGREE'`; the `authoritativeDecision` in every case equals the code review verdict (Phase 2 authority)

### AC3: Scenario-Primary Mode — Advisory Events Emitted and Gate Controlled by Score
**Given** a `DualSignalCoordinator` created with `{ qualityMode: 'scenario-primary', threshold: 0.8 }` and a mock event bus
**When** `coordinator.evaluate('NEEDS_MAJOR_REWORK', 0.9, 'run-1')` is called (score passes, code review fails)
**Then** the bus emits `scenario:score-computed` with `passes: true`, and also emits `scenario:advisory-computed` with `{ agreement: 'DISAGREE', verdict: 'NEEDS_MAJOR_REWORK', codeReviewPassed: false, score: 0.9 }`; and when `coordinator.evaluate('SHIP_IT', 0.6, 'run-2')` is called (score fails, code review passes), the bus emits `scenario:score-computed` with `passes: false`

### AC4: Score Persistence Roundtrip with Full Breakdown
**Given** an in-memory database adapter with `factorySchema` applied and a parent `graph_runs` row inserted via `upsertGraphRun`
**When** `insertScenarioResult` is called with a `ScenarioResultInput` containing `satisfaction_score: 0.8`, `passes: true`, and a non-empty `details` breakdown array, then `getScenarioResultsForRun` is called with the same `run_id`
**Then** exactly 1 row is returned with all fields matching the input; `JSON.parse(row.details)` equals the original breakdown array with correct `name`, `passed`, `weight`, and `contribution` fields

### AC5: Multi-Iteration Score History Queryable
**Given** 3 `insertScenarioResult` calls for the same `run_id` with `iteration` values 1, 2, 3 and `satisfaction_score` values 0.60, 0.72, 0.85 respectively
**When** `getScenarioResultsForRun(adapter, runId)` is called
**Then** exactly 3 rows are returned in ascending `iteration` order with the correct scores; the final row has `passes: true` (threshold 0.8) and earlier rows have `passes: false`

### AC6: Factory Run Listing After Persistence
**Given** two completed factory runs persisted via `upsertGraphRun` (first with `status: 'running'`, then updated to `status: 'completed'` with `final_outcome: 'SUCCESS'`)
**When** `listGraphRuns(adapter, 10)` is called
**Then** both runs appear in descending `started_at` order; the completed run has `status: 'completed'` and `final_outcome: 'SUCCESS'`; calling `upsertGraphRun` a second time for the same `run_id` overwrites (does not duplicate) the row

### AC7: Epic 46 Coverage Gate — ≥40 New Tests Pass
**Given** all test files created or modified across Epic 46 stories (scorer.test.ts, dual-signal.test.ts, factory-queries.test.ts, metrics-factory.test.ts, scenario-primary.test.ts, quality-mode.test.ts, factory-validate-command.test.ts, scoring-integration.test.ts, epic46-integration.test.ts)
**When** `npm run test:fast` completes
**Then** the combined new test count across all Epic 46 test files is ≥40 and zero tests fail; the "Test Files" summary line appears in output with no failures

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/scenarios/__tests__/scoring-integration.test.ts` with weighted scoring accuracy tests (AC: #1)
  - [ ] Import `createSatisfactionScorer`, `computeSatisfactionScore` from `'../scorer.js'` and `type { ScenarioRunResult, ScenarioWeights, SatisfactionScore }` from `'../scorer.js'`
  - [ ] Write `describe('Weighted scoring accuracy')` block with test for exact 4/5 = 0.80 score (critical=3.0 passes, standard-1=1.0 passes, standard-2=1.0 fails)
  - [ ] Assert `score` is within `Number.EPSILON` of 0.80 using `Math.abs(result.score - 0.80) < 1e-10`; assert `passes === true`; assert `breakdown.length === 3`
  - [ ] Assert per-entry contributions: critical = 3/5 = 0.60, standard-1 = 1/5 = 0.20, standard-2 = 0.00
  - [ ] Write test for critical-fails case: same weights, critical fails → score = 2/5 = 0.40, `passes === false`
  - [ ] Write test for all-pass case: all three scenarios pass → score = 1.0, `passes === true`
  - [ ] Write test for all-fail case: all three fail → score = 0.0, `passes === false`
  - [ ] Write test for zero-weight guard: `totalWeight === 0` returns `{ score: 0, passes: false, breakdown: [] }`
  - [ ] Write test for single-scenario: one scenario weight=1.0 passes → score = 1.0
  - [ ] Write test for exact threshold boundary: score exactly equals threshold → `passes === true`
  - [ ] Write test for `computeSatisfactionScore` backward-compat: no weights, all-pass → `score === 1.0` and `breakdown` field present
  - [ ] Write test for custom threshold (0.9): score 0.85 with threshold 0.9 → `passes === false`
  - [ ] Write test for uniform weights (all weight=1.0): score = fraction of passing scenarios
  - [ ] Verify at least 12 `it(...)` cases in this describe block

- [ ] Task 2: Create `packages/factory/src/convergence/__tests__/epic46-integration.test.ts` with dual-signal Phase 2 agreement tests (AC: #2)
  - [ ] Import `evaluateDualSignal`, `createDualSignalCoordinator` from `'../dual-signal.js'` and `type { DualSignalVerdict }` from `'../dual-signal.js'`
  - [ ] Import `type { TypedEventBus }` from `'@substrate-ai/core'` and `type { FactoryEvents }` from `'../../events.js'`
  - [ ] Write `describe('Dual-signal Phase 2 agreement tracking')` block
  - [ ] Define 10 test cases as an array: 8 agreeing pairs and 2 disagreeing pairs
  - [ ] Assert all 10 results using `it.each` or separate `it` calls; verify 8 have `agreement: 'AGREE'` and 2 have `agreement: 'DISAGREE'`
  - [ ] Assert `authoritativeDecision` equals the code review verdict in all 10 cases (Phase 2 authority)
  - [ ] Add separate tests for `LGTM_WITH_NOTES` treated as code review pass and threshold boundary (score === threshold → `scenarioPassed: true`)
  - [ ] Minimum 12 `it(...)` cases in this describe block

- [ ] Task 3: Add scenario-primary coordinator integration tests to `epic46-integration.test.ts` (AC: #3)
  - [ ] Add `describe('Scenario-primary mode — advisory events and gate control')` block
  - [ ] Create `mockBus = { emit: vi.fn() } as unknown as TypedEventBus<FactoryEvents>` in `beforeEach`; call `vi.clearAllMocks()` in `beforeEach`
  - [ ] Create coordinator: `createDualSignalCoordinator({ eventBus: mockBus, threshold: 0.8, qualityMode: 'scenario-primary' })`
  - [ ] Test: `coordinator.evaluate('NEEDS_MAJOR_REWORK', 0.9, 'run-1')` → `emit` called with `'scenario:score-computed'` (passes=true) AND `'scenario:advisory-computed'` (agreement=DISAGREE, codeReviewPassed=false)
  - [ ] Test: `coordinator.evaluate('SHIP_IT', 0.6, 'run-2')` → `'scenario:score-computed'` with `passes: false`; `'scenario:advisory-computed'` with `agreement: 'DISAGREE'`, `codeReviewPassed: true`
  - [ ] Test: `coordinator.evaluate('SHIP_IT', 0.85, 'run-3')` → both agree; `'scenario:advisory-computed'` with `agreement: 'AGREE'`
  - [ ] Test: dual-signal mode (default, no qualityMode) → only `'scenario:score-computed'` emitted, NO `'scenario:advisory-computed'`
  - [ ] Test: `runId` correctly threaded into both emitted event payloads
  - [ ] Test: coordinator returns `DualSignalResult` from `evaluate()` confirming return value matches emitted payload
  - [ ] Minimum 6 `it(...)` cases in this describe block

- [ ] Task 4: Add persistence roundtrip and multi-iteration tests to `epic46-integration.test.ts` (AC: #4, #5)
  - [ ] Import `createDatabaseAdapter` from `'@substrate-ai/core'`, `factorySchema` from `'../../persistence/factory-schema.js'`, `upsertGraphRun, insertScenarioResult, getScenarioResultsForRun` from `'../../persistence/factory-queries.js'`
  - [ ] Import `type { ScenarioResultInput }` from `'../../persistence/factory-queries.js'`
  - [ ] Add `describe('Score persistence roundtrip')` with `beforeEach` creating fresh in-memory adapter and calling `await factorySchema(adapter)`
  - [ ] Seed a parent `graph_runs` row via `upsertGraphRun` before each scenario_results insert (FK constraint)
  - [ ] Test AC4: insert one `ScenarioResultInput` with `satisfaction_score: 0.8`, `passes: true`, `details: JSON.stringify([{ name: 'critical', passed: true, weight: 3, contribution: 0.6 }])`; retrieve and assert all fields match; assert `JSON.parse(row.details)` equals original breakdown
  - [ ] Test: empty `details` (null or empty string) does not cause parse error on retrieve
  - [ ] Test AC5: insert 3 iterations with scores 0.60, 0.72, 0.85; retrieve and assert order (iteration 1, 2, 3), scores match, first two have `passes: false`, last has `passes: true`
  - [ ] Test: `getScenarioResultsForRun` returns empty array for unknown run_id (no error)
  - [ ] Minimum 6 `it(...)` cases in this describe block

- [ ] Task 5: Add factory run listing tests to `epic46-integration.test.ts` (AC: #6)
  - [ ] Import `listGraphRuns` from `'../../persistence/factory-queries.js'` and `type { GraphRunInput }` from `'../../persistence/factory-queries.js'`
  - [ ] Add `describe('Factory run listing and upsert semantics')` with fresh adapter per `beforeEach`
  - [ ] Test: `upsertGraphRun` with `status: 'running'`, then same `run_id` with `status: 'completed'` + `final_outcome: 'SUCCESS'` → `listGraphRuns` returns 1 row (not 2) with `status: 'completed'`
  - [ ] Test: two distinct run_ids → `listGraphRuns` returns 2 rows in descending `started_at` order
  - [ ] Test: `listGraphRuns` with `limit: 1` returns only the most-recent run
  - [ ] Test: `listGraphRuns` on empty database returns empty array (no error)
  - [ ] Minimum 4 `it(...)` cases in this describe block

- [ ] Task 6: Add combined end-to-end flow test to `epic46-integration.test.ts` (AC: #1–#6)
  - [ ] Add `describe('End-to-end: scoring → persistence → listing')` block
  - [ ] Compute a weighted satisfaction score using `createSatisfactionScorer(0.8)` with mock scenario results
  - [ ] Persist the run and score via `upsertGraphRun` + `insertScenarioResult` using the computed score and breakdown
  - [ ] Retrieve via `getScenarioResultsForRun` and assert `satisfaction_score` matches computed value (within floating-point tolerance)
  - [ ] Call `listGraphRuns` and assert the run appears with `status: 'running'`; update to completed and re-query to confirm upsert worked
  - [ ] Minimum 4 `it(...)` cases in this describe block

- [ ] Task 7: Run full test suite and verify coverage gate (AC: #7)
  - [ ] Run `npm run test:fast` with `timeout: 300000`; confirm the "Test Files" summary line appears in output with zero failures
  - [ ] Do NOT pipe test output through `grep`, `head`, `tail`, or any other command — check the raw output for the summary line
  - [ ] Count `it(...)` calls across all new Epic 46 test files: `scoring-integration.test.ts` (≥12) + `epic46-integration.test.ts` (≥28) = ≥40 new tests from this story alone
  - [ ] If any import fails (e.g., missing `.js` extension, wrong path), fix the import and re-run
  - [ ] If `factorySchema` is async, ensure all test `beforeEach` blocks use `await`

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import { foo } from '../bar.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- `createDatabaseAdapter` import: `import { createDatabaseAdapter } from '@substrate-ai/core'` (package import, not relative)
- `TypedEventBus` import: `import type { TypedEventBus } from '@substrate-ai/core'`
- `DatabaseAdapter` import: `import type { DatabaseAdapter } from '@substrate-ai/core'`
- Test files belong in `__tests__/` subdirectory co-located with source, using `*.test.ts` naming
- Use `vitest` (`describe`, `it`, `expect`, `vi.fn`, `vi.clearAllMocks`) — no Jest globals
- In-memory adapter for persistence tests — no SQLite, no file I/O; use `createDatabaseAdapter({ backend: 'memory' })`
- Always call `factorySchema(adapter)` before any factory query in persistence tests (ensures tables exist)

### Module Import Paths

```typescript
// scoring-integration.test.ts
import { createSatisfactionScorer, computeSatisfactionScore } from '../scorer.js'
import type { ScenarioRunResult, ScenarioWeights, SatisfactionScore } from '../scorer.js'

// epic46-integration.test.ts
import { evaluateDualSignal, createDualSignalCoordinator } from '../dual-signal.js'
import type { DualSignalVerdict, DualSignalResult, DualSignalCoordinatorOptions } from '../dual-signal.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'
import { createDatabaseAdapter } from '@substrate-ai/core'
import { factorySchema } from '../../persistence/factory-schema.js'
import {
  upsertGraphRun,
  insertScenarioResult,
  getScenarioResultsForRun,
  listGraphRuns,
} from '../../persistence/factory-queries.js'
import type { GraphRunInput, ScenarioResultInput } from '../../persistence/factory-queries.js'
```

### Reference Mock Data

```typescript
// Weighted scoring mock — 3 scenarios, scores 0.80 exactly
const mockRunResult: ScenarioRunResult = {
  scenarios: [
    { name: 'critical', status: 'pass', durationMs: 120, stdout: '', stderr: '' },
    { name: 'standard-1', status: 'pass', durationMs: 80, stdout: '', stderr: '' },
    { name: 'standard-2', status: 'fail', durationMs: 45, stdout: '', stderr: 'assertion failed' },
  ]
}
const weights: ScenarioWeights = { critical: 3.0, 'standard-1': 1.0, 'standard-2': 1.0 }
// totalWeight = 5.0
// score = (3/5)*1 + (1/5)*1 + (1/5)*0 = 0.60 + 0.20 + 0.00 = 0.80
```

### Mock Pattern for Advisory Event Tests

```typescript
const mockBus = { emit: vi.fn() } as unknown as TypedEventBus<FactoryEvents>
const coordinator = createDualSignalCoordinator({
  eventBus: mockBus,
  threshold: 0.8,
  qualityMode: 'scenario-primary',
})
coordinator.evaluate('NEEDS_MAJOR_REWORK', 0.9, 'run-1')
expect(mockBus.emit).toHaveBeenCalledWith('scenario:advisory-computed', expect.objectContaining({
  runId: 'run-1',
  verdict: 'NEEDS_MAJOR_REWORK',
  codeReviewPassed: false,
  score: 0.9,
  threshold: 0.8,
  agreement: 'DISAGREE',
}))
```

### Persistence Test Pattern

```typescript
// Always use fresh adapter per beforeEach
let adapter: DatabaseAdapter

beforeEach(async () => {
  adapter = createDatabaseAdapter({ backend: 'memory' })
  await factorySchema(adapter)
})

// Seed parent graph_runs row before scenario_results (FK constraint)
const runId = 'test-run-001'
await upsertGraphRun(adapter, {
  run_id: runId,
  status: 'running',
  graph_file: 'pipeline.dot',
  goal: 'test',
  node_count: 3,
  started_at: new Date().toISOString(),
})

// Insert scenario result with breakdown
const breakdown = [{ name: 'critical', passed: true, weight: 3.0, contribution: 0.60 }]
await insertScenarioResult(adapter, {
  run_id: runId,
  node_id: 'scenario-node',
  iteration: 1,
  total_scenarios: 1,
  passed: 1,
  failed: 0,
  satisfaction_score: 0.80,
  threshold: 0.80,
  passes: true,
  details: JSON.stringify(breakdown),
})

const rows = await getScenarioResultsForRun(adapter, runId)
expect(rows).toHaveLength(1)
expect(rows[0].satisfaction_score).toBeCloseTo(0.80, 10)
expect(JSON.parse(rows[0].details)).toEqual(breakdown)
```

### Floating-Point Assertions

For scores computed via weighted division, use `toBeCloseTo` with sufficient precision rather than `toBe`:
```typescript
expect(result.score).toBeCloseTo(0.80, 10)   // 10 decimal places
// OR check within epsilon:
expect(Math.abs(result.score - 0.80)).toBeLessThan(1e-10)
```

For breakdown contributions:
```typescript
expect(result.breakdown[0].contribution).toBeCloseTo(0.60, 10)
```

### Dependency Notes

- **Requires 46-1**: `createSatisfactionScorer` with `weights` parameter, `breakdown` field in `SatisfactionScore`
- **Requires 46-2**: `satisfactionThreshold` threading through `CheckGoalGatesOptions` (tested indirectly via coordinator)
- **Requires 46-3**: `insertScenarioResult`, `getScenarioResultsForRun`, `upsertGraphRun`, `listGraphRuns`, `factorySchema`
- **Requires 46-5**: `evaluateDualSignal`, `createDualSignalCoordinator`, `DualSignalVerdict`
- **Requires 46-6**: `qualityMode` field on `DualSignalCoordinatorOptions`; `scenario:advisory-computed` event in `FactoryEvents`
- **Requires 46-7**: validate CLI integration (not tested here — 46-7 has its own test file `factory-validate-command.test.ts`; this story does not duplicate those tests)
- **Story 46-4** (`getFactoryRunSummaries`): if this function exists, add a test in the factory run listing block; if not, skip it gracefully — `listGraphRuns` provides equivalent coverage for this story

### Testing Requirements

- Framework: `vitest` with `describe`, `it`, `expect`, `vi.fn`, `beforeEach`, `vi.clearAllMocks`
- No `vi.mock()` needed for pure function tests (`evaluateDualSignal`)
- For coordinator tests: inject `mockBus = { emit: vi.fn() }` — no module mocking required
- For persistence tests: use `createDatabaseAdapter({ backend: 'memory' })` — no SQLite or Dolt required
- Each `describe` block must call `vi.clearAllMocks()` in `beforeEach` to prevent cross-test state leakage
- Run tests with: `npm run test:fast` — use `timeout: 300000` (5 min) in Bash tool; NEVER pipe output
- Confirm results by checking for "Test Files" summary line in raw output

### File Paths

- **New**: `packages/factory/src/scenarios/__tests__/scoring-integration.test.ts` — weighted scoring accuracy tests (≥12 test cases)
- **New**: `packages/factory/src/convergence/__tests__/epic46-integration.test.ts` — dual-signal, scenario-primary, persistence, and listing tests (≥28 test cases)
- **No source modifications**: this story only writes tests, not new production code

## Interface Contracts

- **Import**: `createSatisfactionScorer`, `computeSatisfactionScore`, `ScenarioRunResult`, `ScenarioWeights`, `SatisfactionScore` @ `packages/factory/src/scenarios/scorer.ts` (from story 46-1)
- **Import**: `evaluateDualSignal`, `createDualSignalCoordinator`, `DualSignalVerdict`, `DualSignalResult`, `DualSignalCoordinatorOptions` @ `packages/factory/src/convergence/dual-signal.ts` (from stories 46-5 and 46-6)
- **Import**: `QualityMode` @ `packages/factory/src/convergence/dual-signal.ts` (from story 46-6)
- **Import**: `upsertGraphRun`, `insertScenarioResult`, `getScenarioResultsForRun`, `listGraphRuns`, `GraphRunInput`, `ScenarioResultInput` @ `packages/factory/src/persistence/factory-queries.ts` (from story 46-3)
- **Import**: `factorySchema` @ `packages/factory/src/persistence/factory-schema.ts` (from story 44-6)
- **Import**: `createDatabaseAdapter`, `TypedEventBus`, `DatabaseAdapter` @ `@substrate-ai/core`

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
