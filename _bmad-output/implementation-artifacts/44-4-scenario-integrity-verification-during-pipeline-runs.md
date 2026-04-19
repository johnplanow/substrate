# Story 44-4: Scenario Integrity Verification During Pipeline Runs

## Story

As a factory graph executor,
I want to verify scenario file checksums before each scenario validation node executes,
so that any file modification between pipeline iterations is detected and halts the run rather than producing a false pass.

## Acceptance Criteria

### AC1: Manifest Captured at Pipeline Start
**Given** a `GraphExecutorConfig` with a `scenarioStore` field set to a `ScenarioStore` instance
**When** `executor.run()` is called
**Then** `store.discover()` is called once at the start of `run()` to capture a `ScenarioManifest`, and the manifest is held for the duration of the run

### AC2: Integrity Check Runs Before Each Tool Node
**Given** a pipeline containing a `tool` type node and a `ScenarioStore` in the executor config
**When** execution reaches the `tool` node (before the node's handler is dispatched)
**Then** `store.verifyIntegrity(manifest)` is called with the manifest captured in AC1, and the integrity result determines whether execution proceeds

### AC3: Tampered Scenario File Halts Pipeline with Event
**Given** a scenario file is modified on disk after the manifest was captured (between iterations)
**When** the integrity check runs before a `tool` node executes
**Then** the executor emits `scenario:integrity-failed` (with `runId`, `nodeId`, and `tampered` file names), returns `{ status: 'FAIL', failureReason: ... }`, and the pipeline halts — the `tool` node's handler is never dispatched

### AC4: Unmodified Scenarios Emit Pass Event and Proceed
**Given** scenario files are unmodified since manifest capture
**When** the integrity check runs before a `tool` node executes
**Then** the executor emits `scenario:integrity-passed` (with `runId`, `nodeId`, and `scenarioCount`), and execution continues to dispatch the node handler normally

### AC5: Integrity Check Skipped for Non-Tool Nodes
**Given** the same pipeline with `ScenarioStore` configured
**When** execution reaches a node of type `start`, `exit`, `conditional`, or `codergen`
**Then** `store.verifyIntegrity()` is NOT called for those nodes — the check is exclusive to `tool` type nodes

### AC6: Backward-Compatible — No ScenarioStore Means No Integrity Checks
**Given** a `GraphExecutorConfig` with no `scenarioStore` field (the common case for all existing tests)
**When** `executor.run()` is called
**Then** execution proceeds exactly as before — `discover()` is never called, no integrity events are emitted, and no behavior changes (full backward compatibility)

### AC7: New Integrity Events Exported from FactoryEvents
**Given** a consumer that imports `FactoryEvents` from `@substrate-ai/factory`
**When** they inspect the event map type
**Then** `scenario:integrity-passed` and `scenario:integrity-failed` are present with their documented payload shapes

## Tasks / Subtasks

- [ ] Task 1: Add `verifyIntegrity()` method to `ScenarioStore` (AC: #2, #3, #4)
  - [ ] Open `packages/factory/src/scenarios/store.ts`
  - [ ] Add `async verifyIntegrity(manifest: ScenarioManifest): Promise<ScenarioStoreVerifyResult>` method to the `ScenarioStore` class
  - [ ] Implement it by delegating to the existing `verify()` method: `return this.verify(manifest)`
  - [ ] Add JSDoc: "Pipeline-facing integrity check. Delegates to `verify()`. Call this before dispatching a scenario validation node to confirm no files were tampered with since manifest capture."
  - [ ] No changes to `verify()` itself — preserve existing behavior and tests

- [ ] Task 2: Add `scenario:integrity-passed` and `scenario:integrity-failed` events to `events.ts` (AC: #7)
  - [ ] Open `packages/factory/src/events.ts`
  - [ ] In the `FactoryEvents` type, under the `// Scenario validation events` block, add:
    ```typescript
    /** Scenario integrity check passed — files unmodified since manifest capture */
    'scenario:integrity-passed': { runId: string; nodeId: string; scenarioCount: number }

    /** Scenario integrity check failed — one or more files were tampered with */
    'scenario:integrity-failed': { runId: string; nodeId: string; tampered: string[] }
    ```
  - [ ] Place both new event entries immediately after `scenario:completed` (preserving logical grouping)

- [ ] Task 3: Extend `GraphExecutorConfig` with optional `scenarioStore` (AC: #1, #6)
  - [ ] Open `packages/factory/src/graph/executor.ts`
  - [ ] Add `import type { ScenarioStore, ScenarioManifest } from '../scenarios/index.js'` at the top of the imports section
  - [ ] In the `GraphExecutorConfig` interface, add:
    ```typescript
    /**
     * When provided, the executor captures a scenario manifest at run start and
     * verifies integrity before each `tool` node executes (story 44-4).
     * Omit to skip all scenario integrity checks (backward-compatible default).
     */
    scenarioStore?: ScenarioStore
    ```

- [ ] Task 4: Capture manifest at run start in `executor.run()` (AC: #1, #6)
  - [ ] In the `run()` method body, after the local variable declarations (`let completedNodes`, `let nodeRetries`, etc.) and before the resume/start node determination block, add:
    ```typescript
    // Capture scenario manifest for integrity checks (story 44-4).
    // Only runs when scenarioStore is configured; otherwise skipped (backward-compatible).
    let scenarioManifest: ScenarioManifest | null = null
    if (config.scenarioStore) {
      scenarioManifest = await config.scenarioStore.discover()
    }
    ```
  - [ ] Verify TypeScript is happy with the `ScenarioManifest | null` typing (no strict null errors)

- [ ] Task 5: Integrate integrity check before each tool node dispatch (AC: #2, #3, #4, #5)
  - [ ] In the main `while (true)` traversal loop, locate the `graph:node-started` emit block
  - [ ] Immediately BEFORE the `graph:node-started` emit (so integrity failure prevents even the started event), add:
    ```typescript
    // Integrity check: verify scenario files before dispatching any tool node (story 44-4)
    if (currentNode.type === 'tool' && config.scenarioStore && scenarioManifest) {
      const integrityResult = await config.scenarioStore.verifyIntegrity(scenarioManifest)
      if (!integrityResult.valid) {
        config.eventBus?.emit('scenario:integrity-failed', {
          runId: config.runId,
          nodeId: currentNode.id,
          tampered: integrityResult.tampered,
        })
        return {
          status: 'FAIL',
          failureReason: `Scenario integrity violation detected before node "${currentNode.id}": tampered files: ${integrityResult.tampered.join(', ')}`,
        }
      }
      config.eventBus?.emit('scenario:integrity-passed', {
        runId: config.runId,
        nodeId: currentNode.id,
        scenarioCount: scenarioManifest.scenarios.length,
      })
    }
    ```
  - [ ] Verify: the check runs BEFORE `graph:node-started` so a tamper failure does NOT emit a spurious `graph:node-started` event

- [ ] Task 6: Write unit and integration tests (AC: #1–#6)
  - [ ] Create `packages/factory/src/scenarios/__tests__/integrity-pipeline.test.ts`
  - [ ] Use a real `ScenarioStore` instance with a temp directory (same pattern as `store.test.ts`)
  - [ ] Use the `helpers.ts` test harness from `packages/factory/src/__tests__/integration/` to build minimal tool-node graphs
  - [ ] Test AC1: executor captures manifest when `scenarioStore` configured — spy on `store.discover()`, verify called once at run start
  - [ ] Test AC2: `verifyIntegrity()` called before each tool node — spy on `store.verifyIntegrity()`, verify called once per tool node visit
  - [ ] Test AC3 (tamper → FAIL): write a scenario file, capture manifest, then modify the file; run a graph with a `tool` node; assert executor returns `{ status: 'FAIL' }` and `scenario:integrity-failed` event was emitted with correct `tampered` array
  - [ ] Test AC3 (deleted → FAIL): same as above but delete the scenario file instead of modifying it
  - [ ] Test AC4 (no tamper → pass): unmodified scenarios; assert `scenario:integrity-passed` emitted and executor returns SUCCESS after tool node completes
  - [ ] Test AC5: graph with `start → conditional → exit` nodes, `scenarioStore` configured; assert `verifyIntegrity()` never called (no tool nodes)
  - [ ] Test AC6: no `scenarioStore` in config; assert `discover()` never called, `scenario:integrity-*` events never emitted, run completes normally
  - [ ] Test: `verifyIntegrity()` delegates to `verify()` — unit test on `ScenarioStore` directly
  - [ ] Minimum 8 test cases in `integrity-pipeline.test.ts`, all passing

- [ ] Task 7: Build and validate (AC: #7)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all tests pass, no regressions in existing tests
  - [ ] Confirm `scenario:integrity-passed` and `scenario:integrity-failed` are present in the `FactoryEvents` type (compile-time check)
  - [ ] Confirm `ScenarioStore.verifyIntegrity()` is callable from a consumer of `@substrate-ai/factory`

## Dev Notes

### Architecture Constraints

- **Modified files:**
  - `packages/factory/src/scenarios/store.ts` — add `verifyIntegrity()` method (delegate to `verify()`)
  - `packages/factory/src/events.ts` — add `scenario:integrity-passed` and `scenario:integrity-failed` to `FactoryEvents`
  - `packages/factory/src/graph/executor.ts` — extend `GraphExecutorConfig`, capture manifest at start, add integrity check before tool nodes

- **New file:**
  - `packages/factory/src/scenarios/__tests__/integrity-pipeline.test.ts` — executor integration tests

- **Import style:** All relative imports within factory package use `.js` extensions (ESM). Example: `import type { ScenarioStore, ScenarioManifest } from '../scenarios/index.js'`

- **No new top-level modules:** This story does not introduce new modules — it wires existing components together.

- **`verifyIntegrity()` placement:** The method goes on `ScenarioStore` (not `ScenarioRunner`). The store owns checksum state; the runner owns execution. Keep the separation clean.

### Integrity Check Placement in the Executor Loop

The integrity check block must appear **before** the `graph:node-started` emit in the traversal loop:

```
[resume skip check]
[cycle detection]
[--- INTEGRITY CHECK: only for tool nodes ---]   ← Task 5 goes here
[graph:node-started emit]
[fidelity override]
[dispatchWithRetry]
...
```

This ordering ensures:
- If integrity fails, no `graph:node-started` event is emitted (clean event stream)
- The check happens after cycle detection (so infinite loops are still detected first)
- The check happens before the handler fires (security guarantee)

### Detecting `tool` Nodes

Check `currentNode.type === 'tool'`. This is a string field on `GraphNode` (defined in `packages/factory/src/graph/types.ts`). The value `'tool'` aligns with the DOT `type="tool"` attribute used for scenario validation nodes (established in story 42-11 and expanded in 44-5).

Do NOT check `currentNode.toolCommand` — that field may be empty for some tool nodes, and the check should be based on node type, not command content.

### ScenarioManifest Lifetime

The manifest is captured ONCE at the start of `run()` via `store.discover()`. This snapshot is the baseline for all subsequent `verifyIntegrity()` calls throughout the run. If scenarios are modified between iterations (e.g., between loop iterations in a retry graph), the stored manifest checksums will no longer match the on-disk files, triggering the failure.

### `ScenarioStore.verifyIntegrity()` vs `verify()`

Both methods do the same thing — `verifyIntegrity()` simply delegates to `verify()`. The reason for adding `verifyIntegrity()` is semantic clarity: calling code in the executor reads as "checking integrity before pipeline execution", not as "running an ad-hoc verification". Both methods remain public; `verify()` is retained for backward compatibility (story 44-1 tests rely on it).

### Backward Compatibility

`GraphExecutorConfig.scenarioStore` is an **optional** field. All existing executor tests that do not set `scenarioStore` continue to work without modification. The manifest capture and integrity check are completely behind the `if (config.scenarioStore)` guard.

### Testing Requirements

- **Framework:** Vitest (`import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`)
- **Temp directories:** Use `mkdtempSync(join(os.tmpdir(), 'substrate-integrity-test-'))` + `afterEach` cleanup with `rmSync(tmpDir, { recursive: true, force: true })`
- **Mock event bus:** Use the real `TypedEventBus` from `@substrate-ai/core` (already used in executor integration tests) OR a simple `{ emit: vi.fn() }` typed mock — either is acceptable
- **Graph construction:** Use `parseGraph()` and `createGraphExecutor()` from the package; build minimal DOT strings with a `tool` node; wire a `MockCodergenBackend` or similar stub as the handler (see `packages/factory/src/__tests__/integration/helpers.ts` for patterns)
- **Spy pattern for `verifyIntegrity`:**
  ```typescript
  const store = new ScenarioStore()
  const verifySpy = vi.spyOn(store, 'verifyIntegrity')
  ```
- **Run tests:** `npm run test:fast` (unit-only, ~50s)
- **Never pipe output** through `head`/`tail`/`grep` — look for the `Test Files` summary line
- **Minimum:** 8 tests in `integrity-pipeline.test.ts`, all passing. No regressions in the existing suite.

### Dependency Notes

- **Depends on:** 44-1 (`ScenarioStore`, `ScenarioManifest`, `ScenarioStoreVerifyResult` — already implemented)
- **Depends on:** 44-2 (`ScenarioRunner` — for test graph wiring, though this story does not call the runner directly)
- **Depends on:** 44-3 (Isolation — ensures scenario files are not visible to dispatched agents; integrity verification builds on this guarantee)
- **Unblocks:** 44-5 (Scenario Validation as Graph Tool Node — which wires a real `tool` node that calls the scenario runner; integrity check infrastructure must be in place first)

## Interface Contracts

- **Export**: `verifyIntegrity(manifest: ScenarioManifest): Promise<ScenarioStoreVerifyResult>` added to `ScenarioStore` class @ `packages/factory/src/scenarios/store.ts` (consumed by executor and story 44-5 tests)
- **Export**: `'scenario:integrity-passed'` event @ `packages/factory/src/events.ts` (consumed by story 44-10 integration test)
- **Export**: `'scenario:integrity-failed'` event @ `packages/factory/src/events.ts` (consumed by story 44-10 integration test)
- **Import**: `ScenarioStore`, `ScenarioManifest` @ `packages/factory/src/scenarios/index.ts` (imported into `executor.ts`, from story 44-1)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-22: Story created for Epic 44, Phase B — Scenario Store + Runner
