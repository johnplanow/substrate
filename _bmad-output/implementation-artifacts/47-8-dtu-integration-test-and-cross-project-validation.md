# Story 47-8: DTU Integration Test and Cross-Project Validation

## Story

As a factory developer,
I want integration tests that exercise the full Digital Twin Universe (DTU) lifecycle — from registry and Docker Compose orchestration through scenario execution and persistence —
so that all Epic 47 components are verified to work correctly together before shipping Digital Twin Foundation to production.

## Acceptance Criteria

### AC1: Full twin lifecycle integration — coordinator wires registry to scenario runner
**Given** a `TwinCoordinator` constructed with a mock `TwinManager` (injectable, no real Docker) and a `TwinRegistry` loaded with a 'localstack' definition, and a `ScenarioManifest` with `twins: ['localstack']`
**When** `runner.run(manifest, projectRoot)` is called with `twinCoordinator` injected in `ScenarioRunnerOptions`
**Then** `twinManager.start()` is called before any scenario subprocess is spawned, the scenario subprocess env contains the port env var (e.g. `LOCALSTACK_URL`), and `twinManager.stop()` is called exactly once in the finally block

### AC2: Scenario runner health gate blocks execution when a twin is unhealthy
**Given** a `TwinHealthMonitor` whose `getStatus()` returns `{ 'localstack': 'unhealthy' }` and a `ScenarioRunner` constructed with that monitor injected as `twinHealthMonitor` in `ScenarioRunnerOptions`
**When** `runner.run(manifest, projectRoot)` is called with `manifest.twins: ['localstack']`
**Then** no scenario scripts are executed, `summary.failed` equals `manifest.scenarios.length`, and the first `ScenarioResult.stderr` contains `"Twin 'localstack' is unhealthy"`

### AC3: TwinHealthMonitor mid-run crash detection — 3 consecutive failures yield unhealthy status
**Given** a `TwinHealthMonitor` started with a twin that has `healthcheck.url` set, and `fetch` mocked to succeed on the first poll then reject on the next three consecutive polls (using fake timers)
**When** the polling interval fires four times (1 success + 3 failures)
**Then** `twin:health-warning` is emitted twice (after failures 1 and 2), `twin:health-failed` is emitted once (after failure 3), `getStatus()` returns `'unhealthy'` for that twin, and no further polls fire after the hard failure

### AC4: TwinPersistenceCoordinator records twin:started and twin:stopped to DB
**Given** a `TwinPersistenceCoordinator` wired to a `MemoryDatabaseAdapter` (with `factorySchema` applied) and a real event bus
**When** a `twin:started` event is emitted (with `twinName: 'localstack'`, `ports: [{ host: 4566, container: 4566 }]`, `run_id: 'run-001'`) followed by a `twin:stopped` event (with `twinName: 'localstack'`)
**Then** `getTwinRunsForRun(adapter, 'run-001')` returns one `TwinRunSummary` with `twin_name: 'localstack'`, `status: 'stopped'`, a non-null `stopped_at`, and `ports` parsed as `[{ host: 4566, container: 4566 }]`

### AC5: Persistence layer aggregates health failures across twin lifecycle
**Given** a `MemoryDatabaseAdapter` with `factorySchema` applied and a known `run_id`
**When** `insertTwinRun` is called once (to create a run record) and then `recordTwinHealthFailure` is called three times for the same `twin_name` and `run_id`
**Then** `getTwinRunsForRun(adapter, run_id)` returns one entry with `health_failure_count: 3`

### AC6: End-to-end assembly — all Epic 47 components compose without errors
**Given** all Epic 47 components assembled in a single test: `TwinRegistry` (in-memory fixture), mock `TwinManager` (resolves immediately, no Docker), `TwinCoordinator` adapter, `ScenarioRunner`, `TwinHealthMonitor` (started with the same twin), `TwinPersistenceCoordinator` wired to `MemoryDatabaseAdapter`
**When** `runner.run()` executes a scenario script that exits 0, and after run completion `twin:stopped` is emitted with the correct `twinName`
**Then** `getTwinRunsForRun` returns exactly one entry with `status: 'stopped'`; the scenario result has `summary.passed: 1`; and no TypeScript compile errors exist

### AC7: Epic 47 test suite reaches minimum 40 new tests
**Given** all test files from stories 47-1 through 47-8 across `packages/factory/src/twins/__tests__/` and `packages/factory/src/scenarios/__tests__/`
**When** `npm run test:fast` executes and the vitest summary is read
**Then** at least 40 new tests introduced by Epic 47 pass (integration tests from this story contribute a minimum of 15 new test cases toward the total)

## Tasks / Subtasks

- [ ] Task 1: Create integration test directory and shared helper fixtures (AC: #1, #4, #6)
  - [ ] Create `packages/factory/src/twins/__tests__/integration/` directory
  - [ ] Create `packages/factory/src/twins/__tests__/integration/helpers.ts` with the following exports:
    - `makeMockTwinManager(): TwinManager` — returns a stub with `start` resolving to `undefined` (emitting no events — tests do that), `stop` resolving to `undefined`; both are `vi.fn()` for call-count assertions
    - `makeLocalstackTwinDef(): TwinDefinition` — returns `{ name: 'localstack', image: 'localstack/localstack:latest', ports: [{ host: 4566, container: 4566 }], environment: { SERVICES: 's3' }, healthcheck: { url: 'http://localhost:4566/health', timeout_ms: 5000 } }`
    - `makeTmpScenario(twins?: string[], exitCode?: number)` — creates a temp `.sh` script (in `os.tmpdir()`) that `echo "{}"` and exits with `exitCode` (default 0), computes sha256 checksum, returns `{ manifest: ScenarioManifest, cleanup: () => void }` where `cleanup` calls `fs.rmSync` on the temp dir; use `fs.mkdtempSync(path.join(os.tmpdir(), 'tw-integ-'))`
  - [ ] Import types from `@substrate-ai/factory` — use named imports with `.js` extension for local cross-file references
  - [ ] Keep the helper file free of `vi.fn()` at module level — all stubs are created inside the factory functions so each test gets a fresh instance

- [ ] Task 2: Write twin lifecycle integration tests (AC: #1)
  - [ ] Create `packages/factory/src/twins/__tests__/integration/lifecycle.test.ts`
  - [ ] **Test 1 — start called before scenario**: assemble `ScenarioRunner` with mock `TwinCoordinator` (`startTwins: vi.fn().mockResolvedValue({})`, `stopTwins: vi.fn().mockResolvedValue(undefined)`); use a temp scenario script; verify `startTwins` called once before script executes (use a boolean flag set inside `startTwins` mock, assert flag is true inside script)
  - [ ] **Test 2 — stop called in finally (pass)**: scenario exits 0; assert `stopTwins` called exactly once after run
  - [ ] **Test 3 — stop called in finally (fail)**: scenario exits 1; assert `stopTwins` called exactly once despite failure
  - [ ] **Test 4 — startup failure returns all-failed result without calling stopTwins**: mock `startTwins` to reject with `new Error('Docker not found')`; assert returned `ScenarioRunResult` has `summary.failed === manifest.scenarios.length`, each scenario `stderr` contains `'Docker not found'`, and `stopTwins` NOT called
  - [ ] **Test 5 — env vars injected into scenario subprocess**: mock `startTwins` to return `{ TWIN_TEST_PORT: '19999' }`; scenario script does `printf '{"v":"%s"}' "$TWIN_TEST_PORT"`; assert `stdout` of first result contains `19999`
  - [ ] Clean up temp files in `afterEach`

- [ ] Task 3: Write health monitor integration tests (AC: #2, #3)
  - [ ] Create `packages/factory/src/twins/__tests__/integration/health-monitor-integration.test.ts`
  - [ ] Use `vi.useFakeTimers()` in `beforeEach` and `vi.useRealTimers()` + `vi.unstubAllGlobals()` in `afterEach`
  - [ ] **Test 1 — unhealthy twin aborts ScenarioRunner before execution**: create a spy `TwinHealthMonitor` with `getStatus: vi.fn().mockReturnValue({ 'localstack': 'unhealthy' })`; inject as `twinHealthMonitor` in ScenarioRunner options; call `runner.run(manifest, projectRoot)`; assert result `summary.failed > 0` and first scenario `stderr` contains `"Twin 'localstack' is unhealthy"`; assert NO scenario `.sh` was exec-d (spy on `spawn` or check stderr of script)
  - [ ] **Test 2 — healthy twin allows runner to proceed**: `getStatus` returns `{ 'localstack': 'healthy' }`; assert run completes with `summary.passed > 0`
  - [ ] **Test 3 — 3 consecutive failures → twin:health-failed**: mock `fetch` to fail every call; spy event bus; create real `createTwinHealthMonitor(eventBus, { monitorIntervalMs: 1000, maxConsecutiveFailures: 3 })`; `monitor.start([makeLocalstackTwinDef()])`; `await vi.advanceTimersByTimeAsync(3100)`; assert `eventBus.emit` called with `'twin:health-failed'`; assert `monitor.getStatus()['localstack'] === 'unhealthy'`; `monitor.stop()`
  - [ ] **Test 4 — success-then-fail-then-recover**: mock `fetch` to fail once then succeed; start; advance 2100ms; assert `getStatus()['localstack'] === 'healthy'`; assert `twin:health-failed` NOT emitted; `monitor.stop()`
  - [ ] **Test 5 — polling stops after hard failure**: mock `fetch` to always fail; start; advance 4000ms (4 × 1s interval); assert `fetch` called exactly 3 times (polling stopped after 3rd failure); `monitor.stop()`

- [ ] Task 4: Write persistence coordinator integration tests (AC: #4, #5)
  - [ ] Create `packages/factory/src/twins/__tests__/integration/persistence-integration.test.ts`
  - [ ] In `beforeEach`: create fresh `MemoryDatabaseAdapter`, call `await factorySchema(adapter)`, create a real `TypedEventBus<FactoryEvents>` (use the actual event emitter from `@substrate-ai/core`), construct `createTwinPersistenceCoordinator(adapter, eventBus)`
  - [ ] **Test 1 — twin:started emits insertTwinRun row**: emit `twin:started` with `{ twinName: 'localstack', ports: [{ host: 4566, container: 4566 }], healthStatus: 'healthy', runId: 'run-001' }`; `await nextTick()`; call `getTwinRunsForRun(adapter, 'run-001')`; assert one entry with `twin_name: 'localstack'`, `status: 'running'`
  - [ ] **Test 2 — twin:stopped updates row to stopped**: emit started then stopped; `await nextTick()` after each; assert entry has `status: 'stopped'` and `stopped_at` is non-null
  - [ ] **Test 3 — ports are parsed correctly on read**: ports emitted as `[{ host: 4566, container: 4566 }]`; assert `getTwinRunsForRun` returns `ports[0].host === 4566`
  - [ ] **Test 4 — health failures accumulate via recordTwinHealthFailure**: call `insertTwinRun` then `recordTwinHealthFailure` three times with the same `twin_name` and `run_id`; assert `health_failure_count === 3`
  - [ ] **Test 5 — multiple twins in one run**: emit `twin:started` for 'localstack' and 'wiremock' (same `runId`); emit `twin:stopped` for both; assert `getTwinRunsForRun` returns exactly two entries
  - [ ] Helper `nextTick()` — `return new Promise(r => setTimeout(r, 0))` — needed to flush async event bus handlers

- [ ] Task 5: Write end-to-end assembly test (AC: #6)
  - [ ] Create `packages/factory/src/twins/__tests__/integration/e2e.test.ts`
  - [ ] In `beforeEach`: create all Epic 47 components: `MemoryDatabaseAdapter` → `factorySchema` → `createTwinPersistenceCoordinator` → `createTwinHealthMonitor` (with no real health URL — no timers needed) → mock `TwinManager` → mock `TwinCoordinator` → `createScenarioRunner({ twinCoordinator, twinHealthMonitor })`
  - [ ] **Test 1 — full pipeline, scenario passes**: make temp scenario that exits 0; `runner.run(manifest, projectRoot)` completes; manually emit `twin:stopped` event; `await nextTick()`; assert `result.summary.passed === 1`; assert `getTwinRunsForRun(adapter, runId)` returns 1 entry with `status: 'stopped'`
  - [ ] **Test 2 — full pipeline, scenario fails, stop still called**: scenario exits 1; assert `mockTwinManager.stop` called once; assert `result.summary.failed === 1`
  - [ ] **Test 3 — no twins in manifest, no coordinator methods called**: manifest with `twins: undefined`; assert `mockTwinManager.start` NOT called; assert `mockTwinManager.stop` NOT called
  - [ ] Clean up temp files in `afterEach`

- [ ] Task 6: Build and integration test validation (AC: #6, #7)
  - [ ] Run `npm run build` from the monorepo root — zero TypeScript errors required; fix any import path or type errors before proceeding
  - [ ] Run `npm run test:fast` with `timeout: 300000` — confirm "Test Files" summary line is present in output; never pipe output through `head`, `tail`, or `grep`
  - [ ] Count the new test cases contributed by this story — minimum 15 new tests in the integration test files
  - [ ] Verify the combined new test count from stories 47-1 through 47-8 totals ≥ 40

- [ ] Task 7: Clean up and regression guard (all ACs)
  - [ ] Ensure all temp directories created via `fs.mkdtempSync` are removed in `afterEach` or `afterAll` — no temp directories left in `os.tmpdir()` prefixed with `tw-integ-`
  - [ ] Confirm no integration test depends on Docker, real network, or real LocalStack — all external calls must be mocked
  - [ ] Run `npm run test:fast` a second time to verify no flakiness (all integration tests are deterministic)
  - [ ] Confirm no regressions in the existing 7,965-test baseline — output should show 0 failing test files from prior epics

## Dev Notes

### Architecture Constraints

- **File paths — all new:**
  - `packages/factory/src/twins/__tests__/integration/helpers.ts`
  - `packages/factory/src/twins/__tests__/integration/lifecycle.test.ts`
  - `packages/factory/src/twins/__tests__/integration/health-monitor-integration.test.ts`
  - `packages/factory/src/twins/__tests__/integration/persistence-integration.test.ts`
  - `packages/factory/src/twins/__tests__/integration/e2e.test.ts`
- **No production code changes** — this story adds tests only; if a gap is discovered during implementation (e.g., a missing export or broken interface), escalate rather than patching production code unilaterally
- **ESM imports**: All relative imports within `packages/factory/` require `.js` extensions. Cross-package imports (`@substrate-ai/core`, `@substrate-ai/factory`) use bare specifiers
- **TypeScript**: No `any` types. Explicit return types on all helper functions in `helpers.ts`. Cast mocks with `as unknown as InterfaceType` pattern
- **Test framework**: Vitest — `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`; use `vi.useFakeTimers()` for health monitor timer tests only (restore immediately in `afterEach`)
- **No real Docker/network/filesystem** in any integration test — mock `fetch` via `vi.stubGlobal('fetch', vi.fn())`, mock `TwinManager` via `makeMockTwinManager()` helper, use `MemoryDatabaseAdapter` for all DB operations
- **Event bus**: Use the real `TypedEventBus` from `@substrate-ai/core` in persistence tests (not a spy) so actual subscription and emission mechanics are exercised; use a spy bus `{ emit: vi.fn(), on: vi.fn(), off: vi.fn() }` only for health monitor isolation tests
- **Package boundary**: Integration tests in `packages/factory/` must NOT import from `@substrate-ai/sdlc` (ADR-003)

### Key Import Patterns

```typescript
// In integration test files:
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TwinDefinition, TwinManager } from '../../index.js'
import { createTwinHealthMonitor } from '../../health-monitor.js'
import { createTwinPersistenceCoordinator, getTwinRunsForRun, insertTwinRun, recordTwinHealthFailure } from '../../persistence.js'
import { factorySchema } from '../../../persistence/factory-schema.js'
import type { FactoryEvents } from '../../../events.js'
import { createScenarioRunner } from '../../../scenarios/runner.js'
import type { ScenarioManifest, TwinCoordinator } from '../../../scenarios/runner.js'
import type { TypedEventBus, MemoryDatabaseAdapter } from '@substrate-ai/core'
// MemoryDatabaseAdapter import path — check existing test files for exact import pattern
```

### nextTick Helper Pattern

Async event bus handlers (in `TwinPersistenceCoordinator`) run asynchronously after emit. Use this helper to flush them before asserting DB state:

```typescript
const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
// After emit: await nextTick()
```

### Mock TwinCoordinator Pattern for Integration Tests

The `TwinCoordinator` interface (from story 47-3) has `startTwins(names: string[]): Promise<Record<string, string>>` and `stopTwins(): Promise<void>`. For lifecycle tests, create a realistic adapter that wraps the mock `TwinManager`:

```typescript
function makeMockTwinCoordinator(
  manager: TwinManager,
  envOverride?: Record<string, string>
): TwinCoordinator {
  return {
    startTwins: vi.fn().mockImplementation(async (_names: string[]) => {
      await manager.start([])
      return envOverride ?? { LOCALSTACK_URL: 'http://localhost:4566' }
    }),
    stopTwins: vi.fn().mockImplementation(async () => {
      await manager.stop()
    }),
  }
}
```

### TwinPersistenceCoordinator Event Subscription Note

Story 47-7 specifies the `TwinPersistenceCoordinator` subscribes to `twin:started` and `twin:stopped`. If during implementation the coordinator is found to also need `twin:health-failed` subscription (to call `recordTwinHealthFailure` automatically), that is acceptable as a minor implementation-time extension — it does not change the observable contract tested by AC4. AC5 tests `recordTwinHealthFailure` via direct function call to keep the test deterministic regardless of the coordinator's subscription model.

### Testing Requirements

- **Minimum test count**: 15 new test cases across the 4 integration test files (5 per test file on average)
- **Fake timers isolation**: Only `health-monitor-integration.test.ts` uses `vi.useFakeTimers()`; all other integration tests run with real timers; never mix fake and real timers within a file
- **Temp file discipline**: Every test that creates a temp `.sh` file must clean it up in `afterEach` — use `makeTmpScenario().cleanup()` in `afterEach`, not `afterAll`, to avoid test-order coupling
- **No sleep/polling in tests**: Tests are deterministic — use `await nextTick()` for event bus flush and `await vi.advanceTimersByTimeAsync()` for timer-based tests; never use `await new Promise(r => setTimeout(r, 1000))` with real wait times

### Dependency Map for This Story

| Import | Source Story |
|---|---|
| `TwinDefinition`, `TwinManager`, `createTwinManager`, `TwinError` | 47-2 |
| `TwinCoordinator`, `ScenarioRunner`, `createScenarioRunner` | 47-3 |
| `TwinHealthMonitor`, `createTwinHealthMonitor`, `TwinHealthStatus` | 47-6 |
| `TwinPersistenceCoordinator`, `createTwinPersistenceCoordinator` | 47-7 |
| `insertTwinRun`, `recordTwinHealthFailure`, `getTwinRunsForRun` | 47-7 |
| `factorySchema` | 47-7 (extends 44-6) |
| `twin:started`, `twin:stopped` events | 47-2 |
| `twin:health-warning`, `twin:health-failed` events | 47-6 |
| `MemoryDatabaseAdapter`, `TypedEventBus` | `@substrate-ai/core` |

## Interface Contracts

- **Import**: `TwinManager`, `createTwinManager` @ `packages/factory/src/twins/docker-compose.ts` (from story 47-2)
- **Import**: `TwinCoordinator`, `ScenarioRunnerOptions`, `createScenarioRunner` @ `packages/factory/src/scenarios/runner.ts` (from story 47-3)
- **Import**: `TwinHealthMonitor`, `createTwinHealthMonitor`, `TwinHealthStatus` @ `packages/factory/src/twins/health-monitor.ts` (from story 47-6)
- **Import**: `TwinPersistenceCoordinator`, `createTwinPersistenceCoordinator`, `insertTwinRun`, `recordTwinHealthFailure`, `getTwinRunsForRun` @ `packages/factory/src/twins/persistence.ts` (from story 47-7)
- **Import**: `factorySchema` @ `packages/factory/src/persistence/factory-schema.ts` (extended by story 47-7)
- **Import**: `MemoryDatabaseAdapter`, `TypedEventBus` @ `@substrate-ai/core`

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-23: Story created for Epic 47 — Digital Twin Foundation
