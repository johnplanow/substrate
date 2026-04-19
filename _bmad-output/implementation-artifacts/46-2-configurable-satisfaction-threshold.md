# Story 46-2: Configurable Satisfaction Threshold

## Story

As a factory pipeline developer,
I want the satisfaction threshold from factory config to flow through goal gate evaluation and the scenario scorer,
so that goal gates pass or fail based on the operator-configured threshold rather than a hardcoded default.

## Acceptance Criteria

### AC1: Score Below Threshold Fails Goal Gate
**Given** a `goalGate=true` node in the graph, `satisfaction_score=0.79` in context, and `satisfactionThreshold=0.8` passed to `checkGoalGates()`
**When** the executor reaches the exit node and evaluates goal gates
**Then** `GoalGateResult.satisfied` is `false` and the failing gate node id appears in `failedGates`

### AC2: Score At Threshold Passes Goal Gate (>=, Not >)
**Given** a `goalGate=true` node in the graph, `satisfaction_score=0.80` in context, and `satisfactionThreshold=0.8`
**When** `checkGoalGates()` is called with the context and threshold
**Then** `GoalGateResult.satisfied` is `true` and `failedGates` is empty — boundary is inclusive (>=)

### AC3: Relaxed Threshold Passes With Lower Score
**Given** `satisfactionThreshold=0.5` and `satisfaction_score=0.6` in context
**When** `checkGoalGates()` is called
**Then** `GoalGateResult.satisfied` is `true` and `failedGates` is empty

### AC4: Hot-Reload — Threshold Updated on Config Object Reflects in Subsequent Evaluations
**Given** `GraphExecutorConfig.satisfactionThreshold` is initially `0.8` and a score of `0.6` causes a gate failure
**When** `satisfactionThreshold` is updated to `0.5` on the config object before the next exit node evaluation
**Then** the gate evaluation reads the new value and a score of `0.6` now passes — no caching of the threshold between iterations

### AC5: Tool Handler Uses Config Threshold When Provided
**Given** `ToolHandlerOptions.satisfactionThreshold=0.5` and a `ScenarioRunResult` stdout with `passed=3, total=5` (score=0.6)
**When** the tool handler processes the scenario output
**Then** `computeSatisfactionScore()` is called with threshold `0.5`, `SatisfactionScore.passes=true`, and `satisfaction_score=0.6` is written to context

### AC6: Backward Compatibility — Omitting Threshold Falls Back to Outcome-Status Evaluation
**Given** `checkGoalGates()` is called without `satisfactionThreshold` in options (or without options entirely)
**Then** goal gate satisfaction is determined by node outcome status (`SUCCESS` or `PARTIAL_SUCCESS`) as before — no regressions in existing tests

### AC7: Score Included in `graph:goal-gate-checked` Event When Threshold Is Used
**Given** `checkGoalGates()` is called with `satisfactionThreshold=0.7` and `satisfaction_score=0.65` in context
**When** the event bus receives `graph:goal-gate-checked`
**Then** the event payload includes `score=0.65` and `satisfied=false`

## Tasks / Subtasks

- [ ] Task 1: Extend `checkGoalGates()` with optional context and threshold (AC: #1–#4, #6–#7)
  - [ ] In `packages/factory/src/convergence/controller.ts`, add import: `import type { IGraphContext } from '../graph/types.js'`
  - [ ] Define and export `CheckGoalGatesOptions` interface: `{ context?: IGraphContext; satisfactionThreshold?: number }`
  - [ ] Update the `ConvergenceController` interface: add `options?: CheckGoalGatesOptions` as the 4th parameter of `checkGoalGates()`
  - [ ] Update `createConvergenceController()` implementation: add the 4th `options?` parameter to `checkGoalGates()`
  - [ ] In the implementation body: when both `options.satisfactionThreshold !== undefined` and `options.context !== undefined`, use score-based evaluation — `const score = options.context.getNumber('satisfaction_score', 0); const satisfied = score >= options.satisfactionThreshold`; emit `{ runId, nodeId: id, satisfied, score }` on the event bus
  - [ ] Otherwise (no options or partial options): preserve the existing outcome-status path (`status === 'SUCCESS' || status === 'PARTIAL_SUCCESS'`); emit `{ runId, nodeId: id, satisfied }` without `score` (backward-compatible)
  - [ ] Export `CheckGoalGatesOptions` from `packages/factory/src/convergence/index.ts`

- [ ] Task 2: Add `satisfactionThreshold` to `GraphExecutorConfig` and thread to `checkGoalGates()` (AC: #1–#4)
  - [ ] In `packages/factory/src/graph/executor.ts`, add `satisfactionThreshold?: number` field to `GraphExecutorConfig` with JSDoc: "Satisfaction score threshold for goal gate evaluation (0–1). When set, checkGoalGates() compares satisfaction_score from context against this threshold. Wired from FactoryConfig.satisfaction_threshold in the factory run command."
  - [ ] In `createGraphExecutor().run()`, at the exit node block, replace the existing `controller.checkGoalGates(graph, config.runId, config.eventBus)` call with: `controller.checkGoalGates(graph, config.runId, config.eventBus, config.satisfactionThreshold !== undefined ? { context, satisfactionThreshold: config.satisfactionThreshold } : undefined)`
  - [ ] Verify `context` (the `IGraphContext` instance) is in scope at that call site — it is declared as `let context: IGraphContext = new GraphContext()` earlier in the function

- [ ] Task 3: Update `ToolHandlerOptions` to accept and thread `satisfactionThreshold` (AC: #5)
  - [ ] In `packages/factory/src/handlers/tool.ts`, add `satisfactionThreshold?: number` field to `ToolHandlerOptions` with JSDoc: "Override the satisfaction threshold passed to computeSatisfactionScore() (default 0.8 when omitted)."
  - [ ] In the `isScenarioRunResult` branch, replace `computeSatisfactionScore(parsed)` with `computeSatisfactionScore(parsed, options?.satisfactionThreshold)` — the second argument is passed through verbatim; `computeSatisfactionScore` already handles `undefined` by defaulting to 0.8

- [ ] Task 4: Write unit tests for threshold-based `checkGoalGates()` (AC: #1–#4, #6–#7)
  - [ ] In `packages/factory/src/convergence/__tests__/controller.test.ts`, add a new `describe('checkGoalGates() — satisfaction threshold (story 46-2)')` block below the existing tests — do NOT modify any existing describe blocks or tests
  - [ ] Import `type { IGraphContext }` from `'../../graph/types.js'` (add to existing imports if not already present)
  - [ ] Add a `makeContext(score: number): IGraphContext` helper in the new describe block using an inline Map-backed implementation (same pattern as `remediation.test.ts`):
    ```typescript
    function makeContext(score: number): IGraphContext {
      const store = new Map<string, unknown>([['satisfaction_score', score]])
      return {
        get: (k) => store.get(k),
        set: (k, v) => { store.set(k, v) },
        getString: (k, d = '') => String(store.get(k) ?? d),
        getNumber: (k, d = 0) => Number(store.get(k) ?? d),
        getBoolean: (k, d = false) => Boolean(store.get(k) ?? d),
        applyUpdates: (u) => { for (const [k, v] of Object.entries(u)) store.set(k, v) },
        snapshot: () => Object.fromEntries(store),
        clone: () => makeContext(score),
      }
    }
    ```
  - [ ] **Test AC1**: single `goalGate=true` node, score=0.79, threshold=0.8 → `satisfied: false`, node id in `failedGates`
  - [ ] **Test AC2**: score=0.80, threshold=0.8 → `satisfied: true`, `failedGates: []`
  - [ ] **Test AC2b**: score exactly equals threshold (0.5, threshold=0.5) → `satisfied: true`
  - [ ] **Test AC3**: score=0.6, threshold=0.5 → `satisfied: true`
  - [ ] **Test AC4a**: call with threshold=0.8 and score=0.6 → `satisfied: false`; call again with threshold=0.5 and score=0.6 → `satisfied: true` (no state cached between calls)
  - [ ] **Test AC6a**: no options, goalGate node with `SUCCESS` outcome → `satisfied: true` (outcome-status path)
  - [ ] **Test AC6b**: no options, goalGate node with `FAILURE` outcome → `satisfied: false` (outcome-status path preserved)
  - [ ] **Test AC7**: score=0.65, threshold=0.7 → event payload has `score: 0.65` and `satisfied: false`
  - [ ] **Test AC7b**: backward-compat path (no threshold) → event emitted without `score` field (or `score` is `undefined`)
  - [ ] Aim for ≥ 9 new tests in this describe block

- [ ] Task 5: Write unit tests for `ToolHandlerOptions.satisfactionThreshold` (AC: #5)
  - [ ] In `packages/factory/src/handlers/__tests__/tool-scenario.test.ts`, add a new `describe('ToolHandlerOptions.satisfactionThreshold (story 46-2)')` block — do NOT modify existing blocks
  - [ ] **Test AC5a**: `satisfactionThreshold=0.5`, 3/5 pass (score=0.6) → `outcome.contextUpdates['satisfaction_score']` is `0.6`; inspect by calling `computeSatisfactionScore(result, 0.5)` directly to confirm `passes=true`
  - [ ] **Test AC5b**: `satisfactionThreshold=0.8`, 3/5 pass (score=0.6) → `satisfaction_score` is still `0.6` in context (score is always written; `passes` is internal to the score object, not surfaced to context)
  - [ ] **Test AC5c**: no `satisfactionThreshold` in options → same behavior as existing tests (default 0.8 used by scorer; `satisfaction_score=0.6` written to context)
  - [ ] Aim for ≥ 3 new tests in this describe block

- [ ] Task 6: Build and validate (AC: all)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` — verify "Test Files" summary line appears in output; all tests pass
  - [ ] Confirm no regressions in the 7809-test baseline

## Dev Notes

### Architecture Constraints

- **Files to modify (production):**
  - `packages/factory/src/convergence/controller.ts` — add import of `IGraphContext`; define `CheckGoalGatesOptions`; extend `checkGoalGates()` signature with optional 4th param; implement score-based and legacy outcome-status paths
  - `packages/factory/src/convergence/index.ts` — export `CheckGoalGatesOptions`
  - `packages/factory/src/graph/executor.ts` — add `satisfactionThreshold?: number` to `GraphExecutorConfig`; thread through to `checkGoalGates()` at exit node
  - `packages/factory/src/handlers/tool.ts` — add `satisfactionThreshold?: number` to `ToolHandlerOptions`; pass to `computeSatisfactionScore()`

- **Files to extend (tests):**
  - `packages/factory/src/convergence/__tests__/controller.test.ts` — add new `describe` blocks only; never modify existing describe blocks or individual tests
  - `packages/factory/src/handlers/__tests__/tool-scenario.test.ts` — add new `describe` blocks only; never modify existing blocks

- **`CheckGoalGatesOptions` interface:**
  ```typescript
  export interface CheckGoalGatesOptions {
    /** Pipeline context for reading satisfaction_score. Required when satisfactionThreshold is set. */
    context?: IGraphContext
    /** Threshold for satisfaction gate: gate passes when satisfaction_score >= satisfactionThreshold. */
    satisfactionThreshold?: number
  }
  ```

- **Updated `checkGoalGates` signature (both interface and implementation):**
  ```typescript
  checkGoalGates(
    graph: Graph,
    runId: string,
    eventBus?: TypedEventBus<FactoryEvents>,
    options?: CheckGoalGatesOptions,
  ): GoalGateResult
  ```

- **Score-based gate evaluation logic in implementation:**
  ```typescript
  for (const [id, node] of graph.nodes) {
    if (!node.goalGate) continue
    if (options?.satisfactionThreshold !== undefined && options?.context !== undefined) {
      const score = options.context.getNumber('satisfaction_score', 0)
      const satisfied = score >= options.satisfactionThreshold
      eventBus?.emit('graph:goal-gate-checked', { runId, nodeId: id, satisfied, score })
      if (!satisfied) failedGates.push(id)
    } else {
      const status = outcomes.get(id)
      const satisfied = status === 'SUCCESS' || status === 'PARTIAL_SUCCESS'
      eventBus?.emit('graph:goal-gate-checked', { runId, nodeId: id, satisfied })
      if (!satisfied) failedGates.push(id)
    }
  }
  ```

- **`graph:goal-gate-checked` event** already has `score?: number` field in `events.ts` (do NOT modify `events.ts`):
  ```typescript
  'graph:goal-gate-checked': { runId: string; nodeId: string; satisfied: boolean; score?: number }
  ```

- **Executor exit node update (add 4th argument to existing call):**
  ```typescript
  const gateResult = controller.checkGoalGates(
    graph,
    config.runId,
    config.eventBus,
    config.satisfactionThreshold !== undefined
      ? { context, satisfactionThreshold: config.satisfactionThreshold }
      : undefined,
  )
  ```
  The `context` variable (`let context: IGraphContext = new GraphContext()`) is the live context that has already been updated by the tool handler with `satisfaction_score`. Reading it at this point gives the latest score.

- **Hot-reload (AC4):** The threshold is accessed as `config.satisfactionThreshold` on each gate evaluation — it is NOT copied to a local variable. If the factory run command holds a mutable reference to the same config object and updates `satisfactionThreshold` when config hot-reloads, subsequent evaluations automatically pick up the new value. No additional machinery is required.

- **Tool handler update — minimal change:**
  ```typescript
  // Before:
  const scored = computeSatisfactionScore(parsed)
  // After:
  const scored = computeSatisfactionScore(parsed, options?.satisfactionThreshold)
  ```
  `computeSatisfactionScore` already accepts `threshold` as an optional second argument (defaults to `0.8` when `undefined` is passed). This is backward-compatible.

- **Import style:** ESM with `.js` extensions on all relative imports within the factory package.

- **Story 46-1 dependency:** `computeSatisfactionScore()` in `scorer.ts` already accepts an optional `threshold` parameter from story 44-5. Story 46-1 is expected to enhance weighted scoring but preserve the `threshold` parameter. If 46-1 changes the function signature, align accordingly; if it remains compatible, no changes to `scorer.ts` are needed by this story.

- **Test helper pattern for context** — use a Map-backed inline implementation (from `remediation.test.ts`), NOT `GraphContext` class import, to avoid cross-package import complexity in unit tests:
  ```typescript
  function makeContext(score: number): IGraphContext {
    const store = new Map<string, unknown>([['satisfaction_score', score]])
    return {
      get: (k) => store.get(k),
      set: (k, v) => { store.set(k, v) },
      getString: (k, d = '') => String(store.get(k) ?? d),
      getNumber: (k, d = 0) => Number(store.get(k) ?? d),
      getBoolean: (k, d = false) => Boolean(store.get(k) ?? d),
      applyUpdates: (u) => { for (const [k, v] of Object.entries(u)) store.set(k, v) },
      snapshot: () => Object.fromEntries(store),
      clone: () => makeContext(score),
    }
  }
  ```

### Testing Requirements

- **Framework:** Vitest — `import { describe, it, expect, beforeEach } from 'vitest'`
- **Run command:** `npm run test:fast` with `timeout: 300000` — verify "Test Files" summary line appears in output
- **NEVER pipe output** through `head`, `tail`, or `grep`
- **Minimum new tests:** ≥ 12 tests total (≥ 9 in controller describe block, ≥ 3 in tool handler describe block)
- **No regressions:** All 7809 existing tests must continue to pass
- **In-memory only:** No disk I/O or database needed

### Dependency Chain

- **Depends on:** Story 46-1 (weighted scorer — `computeSatisfactionScore()` enhanced; `threshold` param still accepted)
- **Depends on:** Story 45-1 (goal gate infrastructure — `checkGoalGates()` base implementation in `controller.ts`)
- **Depends on:** Story 45-8 (executor integration — exit node block in `executor.ts` that calls `checkGoalGates()`)
- **Consumed by:** Story 46-5 (dual-signal mode reads threshold from config via `GraphExecutorConfig.satisfactionThreshold`)
- **Consumed by:** Story 46-8 (end-to-end integration test validates threshold wiring end-to-end)

## Interface Contracts

- **Export**: `CheckGoalGatesOptions` @ `packages/factory/src/convergence/controller.ts` (consumed by executor and stories 46-5, 46-6)
- **Export**: `CheckGoalGatesOptions` @ `packages/factory/src/convergence/index.ts` (re-exported for external consumers)
- **Import**: `IGraphContext` @ `packages/factory/src/graph/types.ts` (existing type, from story 42-8)
- **Import**: `GoalGateResult`, `ConvergenceController` @ `packages/factory/src/convergence/controller.ts` (extended by this story, originated in story 45-1)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-23: Story created for Epic 46 — Satisfaction Scoring
