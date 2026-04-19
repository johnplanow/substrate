# Story 45-1: Goal Gate Evaluation at Terminal Node

## Story

As a factory pipeline developer,
I want a `checkGoalGates()` method on the `ConvergenceController` that evaluates each goal gate node and emits observable events when the executor reaches the exit node,
so that the pipeline can determine whether to exit normally or retry, and operators can observe which specific gates passed or failed.

## Acceptance Criteria

### AC1: Satisfied Gate Returns True
**Given** a graph with a `goalGate=true` node that has recorded outcome `SUCCESS`
**When** the executor reaches the exit node and calls `checkGoalGates(graph, runId, eventBus)`
**Then** the return value is `{satisfied: true, failedGates: []}` and the pipeline exits with `SUCCESS`

### AC2: Unsatisfied Gate Returns False
**Given** a `goalGate=true` node that has recorded outcome `FAILURE`
**When** the executor reaches the exit node and calls `checkGoalGates(graph, runId, eventBus)`
**Then** the return value is `{satisfied: false, failedGates: ['<nodeId>']}` with the failing node id present in `failedGates`

### AC3: Any Unsatisfied Gate Fails the Whole Check
**Given** two `goalGate=true` nodes — one with `SUCCESS` outcome and one with `FAILURE` outcome
**When** `checkGoalGates()` is called
**Then** `satisfied` is `false`, the failing node appears in `failedGates`, and the satisfied node does not

### AC4: PARTIAL_SUCCESS Satisfies Goal Gates
**Given** a `goalGate=true` node that completed with `PARTIAL_SUCCESS`
**When** `checkGoalGates()` is called
**Then** it is treated as satisfied — `satisfied` is `true` and `failedGates` is empty

### AC5: graph:goal-gate-checked Event Emitted Per Gate
**Given** a graph with one or more `goalGate=true` nodes and an attached event bus
**When** `checkGoalGates(graph, runId, eventBus)` is called
**Then** the event bus receives exactly one `graph:goal-gate-checked` event per `goalGate=true` node, each containing `{runId, nodeId, satisfied}` in its payload

### AC6: Vacuous Satisfaction for Graphs With No Goal Gates
**Given** a graph with no `goalGate=true` nodes
**When** `checkGoalGates()` is called
**Then** it returns `{satisfied: true, failedGates: []}` without emitting any events

## Tasks / Subtasks

- [ ] Task 1: Add `GoalGateResult` type and extend `ConvergenceController` interface (AC: #1–#6)
  - [ ] In `packages/factory/src/convergence/controller.ts`, add imports at the top: `import type { TypedEventBus } from '@substrate-ai/core'` and `import type { FactoryEvents } from '../events.js'`
  - [ ] Define and export `GoalGateResult` interface: `{ satisfied: boolean; failedGates: string[] }`
  - [ ] Add method signature to `ConvergenceController` interface with JSDoc: `checkGoalGates(graph: Graph, runId: string, eventBus?: TypedEventBus<FactoryEvents>): GoalGateResult`

- [ ] Task 2: Implement `checkGoalGates()` in `createConvergenceController()` (AC: #1–#6)
  - [ ] Add method body: iterate over `graph.nodes`, filter for nodes with `goalGate === true`
  - [ ] For each gate node: determine `satisfied` — `true` when recorded outcome is `'SUCCESS'` or `'PARTIAL_SUCCESS'`; emit `graph:goal-gate-checked` via `eventBus?.emit(...)` with `{runId, nodeId: id, satisfied}`; collect unsatisfied node ids into `failedGates`
  - [ ] Return `{ satisfied: failedGates.length === 0, failedGates }`
  - [ ] Export `GoalGateResult` from `packages/factory/src/convergence/index.ts`

- [ ] Task 3: Update graph executor to use `checkGoalGates()` (AC: #1, #2, #5)
  - [ ] In `packages/factory/src/graph/executor.ts`, locate the exit node detection block (the `if (currentNode.id === exitNode.id)` branch introduced in story 42-16)
  - [ ] Replace `controller.evaluateGates(graph)` with `controller.checkGoalGates(graph, config.runId, config.eventBus)` and assign to `gateResult`
  - [ ] Update the downstream reference from `gateResult.failingNodes[0]` to `gateResult.failedGates[0]` in the retry target resolution block

- [ ] Task 4: Write unit tests for `checkGoalGates()` (AC: #1–#6)
  - [ ] In `packages/factory/src/convergence/__tests__/controller.test.ts`, add a new `describe('checkGoalGates()')` block below the existing tests — do NOT modify existing tests
  - [ ] Import `TypedEventBusImpl` from `'@substrate-ai/core'` and `type { FactoryEvents }` from `'../../events.js'`; reuse existing `minimalNode`, `makeGateNode`, `makeNonGateNode`, `makeGraph` helpers from the test file
  - [ ] **Test AC1**: `SUCCESS` outcome on sole goalGate node → `{satisfied: true, failedGates: []}`
  - [ ] **Test AC2**: `FAILURE` outcome on sole goalGate node → `{satisfied: false, failedGates: ['gate-node']}`
  - [ ] **Test AC3a**: two goal gates, first `SUCCESS`, second `FAILURE` → `satisfied: false`, only failing node in `failedGates`
  - [ ] **Test AC3b**: two goal gates, first `FAILURE`, second `SUCCESS` → `satisfied: false`, failing node in `failedGates`, passing node absent
  - [ ] **Test AC4**: `PARTIAL_SUCCESS` outcome → `{satisfied: true, failedGates: []}`
  - [ ] **Test AC5a**: one goalGate node → exactly one `graph:goal-gate-checked` event emitted on the event bus
  - [ ] **Test AC5b**: event payload contains `runId === 'test-run'`, `nodeId === 'gate-node'`, `satisfied === true`
  - [ ] **Test AC5c**: FAILURE gate → event emitted with `satisfied: false`
  - [ ] **Test AC5d**: no `eventBus` argument → method completes without throwing
  - [ ] **Test AC6**: graph with no goalGate nodes → `{satisfied: true, failedGates: []}`, zero `graph:goal-gate-checked` events emitted
  - [ ] Aim for ≥ 10 new tests

- [ ] Task 5: Build and validate (AC: all)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` — verify "Test Files" summary line appears in output; all tests pass
  - [ ] Confirm no regressions in the 7672-test baseline

## Dev Notes

### Architecture Constraints

- **Files to modify (production):**
  - `packages/factory/src/convergence/controller.ts` — add imports, `GoalGateResult` type, `checkGoalGates` method to interface and implementation
  - `packages/factory/src/convergence/index.ts` — export `GoalGateResult` type
  - `packages/factory/src/graph/executor.ts` — replace `evaluateGates()` call with `checkGoalGates()` at exit node; update `.failingNodes[0]` → `.failedGates[0]`

- **File to extend (tests):**
  - `packages/factory/src/convergence/__tests__/controller.test.ts` — add new `describe` blocks only; never modify existing describe blocks or individual tests

- **Existing `evaluateGates()` method:** Leave it intact with its existing signature `evaluateGates(graph: Graph): { satisfied: boolean; failingNodes: string[] }`. All existing unit tests cover it and the method is preserved for backward compatibility. The executor will call `checkGoalGates()` as the production code path going forward.

- **Import additions for `controller.ts`:**
  ```typescript
  import type { TypedEventBus } from '@substrate-ai/core'
  import type { FactoryEvents } from '../events.js'
  ```

- **`graph:goal-gate-checked` event type** (already defined in `events.ts` — do NOT modify):
  ```typescript
  'graph:goal-gate-checked': { runId: string; nodeId: string; satisfied: boolean; score?: number }
  ```
  Omit `score` from the emission in this story — it is reserved for future satisfaction scoring (Epic 46). The field is optional so omitting it is type-safe.

- **Import style:** ESM with `.js` extensions on all relative imports within the factory package.

- **Do NOT modify `events.ts`** — `graph:goal-gate-checked` is already defined there.

- **Executor update scope:** The existing exit node block in `executor.ts` (story 42-16) uses `controller.evaluateGates(graph)` and then manually resolves retry targets inline. Replace only the `evaluateGates()` call with `checkGoalGates()` — leave the inline retry resolution logic unchanged. It will be refactored by story 45-8 after `resolveRetryTarget()` is added in story 45-2.

### `checkGoalGates` Method Signature

```typescript
export interface GoalGateResult {
  satisfied: boolean
  failedGates: string[]
}

export interface ConvergenceController {
  recordOutcome(nodeId: string, status: OutcomeStatus): void
  evaluateGates(graph: Graph): { satisfied: boolean; failingNodes: string[] }
  /**
   * Evaluate all goal gate nodes and emit graph:goal-gate-checked for each.
   * Returns satisfied=true only when every goalGate=true node recorded
   * SUCCESS or PARTIAL_SUCCESS. Graphs with no goal gate nodes are vacuously satisfied.
   */
  checkGoalGates(graph: Graph, runId: string, eventBus?: TypedEventBus<FactoryEvents>): GoalGateResult
}
```

### Event Bus in Unit Tests

```typescript
import { TypedEventBusImpl } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'

const eventBus = new TypedEventBusImpl<FactoryEvents>()
const emitted: Array<{ nodeId: string; satisfied: boolean }> = []
eventBus.on('graph:goal-gate-checked', (payload) => {
  emitted.push({ nodeId: payload.nodeId, satisfied: payload.satisfied })
})
```

### Executor Exit Node Block (Before / After)

**Before (story 42-16):**
```typescript
const gateResult = controller.evaluateGates(graph)
if (!gateResult.satisfied) {
  const failingNodeId = gateResult.failingNodes[0]!
  ...
}
```

**After (story 45-1):**
```typescript
const gateResult = controller.checkGoalGates(graph, config.runId, config.eventBus)
if (!gateResult.satisfied) {
  const failingNodeId = gateResult.failedGates[0]!
  ...
}
```

### Testing Requirements

- **Framework:** Vitest — `import { describe, it, expect, beforeEach } from 'vitest'`
- **Run command:** `npm run test:fast` with `timeout: 300000` — verify "Test Files" summary line appears in output
- **NEVER pipe output** through `head`, `tail`, or `grep`
- **Minimum new tests:** ≥ 10 tests in the `checkGoalGates` describe blocks
- **No regressions:** All 7672 existing tests must continue to pass
- **In-memory only:** No disk I/O or database needed — `TypedEventBusImpl` is fully in-memory

### Dependency Chain

- **Depends on:** Story 42-16 (ConvergenceController foundation with `recordOutcome()`, `evaluateGates()`)
- **Depends on:** Story 42-14 (Graph executor — `createGraphExecutor()` in `executor.ts` is the file being modified)
- **Consumed by:** Story 45-2 (`resolveRetryTarget` extends the same `ConvergenceController` interface; depends on this story being complete)
- **Consumed by:** Story 45-8 (full executor integration refactors the inline retry routing to use `resolveRetryTarget()`)

## Interface Contracts

- **Export**: `GoalGateResult` @ `packages/factory/src/convergence/controller.ts` (consumed by story 45-8)
- **Export**: `ConvergenceController` (extended with `checkGoalGates`) @ `packages/factory/src/convergence/controller.ts` (consumed by stories 45-2, 45-8)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-23: Story created for Epic 45 — Convergence Loop + Scoring
