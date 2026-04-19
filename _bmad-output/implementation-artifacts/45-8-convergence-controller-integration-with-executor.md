# Story 45-8: Convergence Controller Integration with Executor

## Story

As a graph executor,
I want all convergence components (goal gate resolution, retry routing, budget enforcement, plateau detection, and remediation context) wired into the execution loop,
so that the factory pipeline automatically iterates toward goal satisfaction with bounded cost, stall detection, and actionable remediation context on each retry.

## Acceptance Criteria

### AC1: Session Budget Halt Takes Highest Priority
**Given** `GraphExecutorConfig.wallClockCapMs` is set to a non-zero cap and elapsed wall-clock time since run start exceeds that cap
**When** the executor evaluates the top of any main loop iteration (before dispatch or goal gate checks)
**Then** it returns `{ status: 'FAIL', failureReason: 'Session budget exceeded: ...' }` immediately — no node is dispatched and no goal gate is checked

### AC2: Pipeline Budget Halt Takes Second Priority
**Given** `GraphExecutorConfig.pipelineBudgetCapUsd` is set to a non-zero cap and accumulated pipeline cost (tracked via `pipelineManager.accumulate()` from per-node context updates) exceeds that cap
**When** the executor evaluates the pipeline budget check after the session check passes
**Then** it returns `{ status: 'FAIL', failureReason: 'Pipeline budget exceeded: ...' }` immediately

### AC3: Retry Target Resolved via `controller.resolveRetryTarget()` at Exit Node
**Given** a goal gate node has an unsatisfied outcome at the exit node and `controller.resolveRetryTarget(failingGateNode, graph)` returns a non-null target node ID
**When** the executor processes the exit node with unsatisfied goal gates
**Then** execution routes to the resolved retry target node — the inline 4-step chain (`failingGateNode.retryTarget || fallbackRetryTarget || graph.retryTarget || graph.fallbackRetryTarget`) is removed and replaced by the single `controller.resolveRetryTarget()` call

### AC4: No Retry Target Resolves to FAIL Return
**Given** a goal gate is unsatisfied at the exit node and `controller.resolveRetryTarget()` returns `null`
**When** the executor processes the exit node
**Then** it returns `{ status: 'FAIL', failureReason: 'Goal gate failed: no retry target' }`

### AC5: Plateau Detection Halts Convergence Loop With FAIL
**Given** a `PlateauDetector` initialized from `config.plateauWindow` (default 3) and `config.plateauThreshold` (default 0.05) has recorded enough satisfaction scores for plateau detection to fire
**When** the executor reaches the exit node, goal gates are unsatisfied, and `checkPlateauAndEmit()` returns `{ plateaued: true }`
**Then** the executor emits `convergence:plateau-detected` (via `checkPlateauAndEmit`) and returns `{ status: 'FAIL', failureReason: 'Convergence plateau detected after N iterations: scores plateaued at [...]' }` instead of retrying

### AC6: Remediation Context Injected Into `IGraphContext` Before Retry Dispatch
**Given** a goal gate fails at the exit node, a retry target is resolved, and plateau detection does not fire
**When** the executor routes to the retry target
**Then** `buildRemediationContext()` is called with `previousFailureReason`, `iterationCount`, and `satisfactionScoreHistory` from the plateau detector, and `injectRemediationContext(context, remediation)` is called before `currentNode` is set to the retry target — so the retry target's handler receives the remediation context on its next dispatch

### AC7: Convergence Loop Exits `SUCCESS` When Goal Gates Are Satisfied
**Given** goal gates are unsatisfied on the first iteration (triggering a retry loop) but satisfied on the second iteration
**When** the executor reaches the exit node on the second iteration and `controller.checkGoalGates()` returns `{ satisfied: true }`
**Then** the executor returns `{ status: 'SUCCESS' }` — the convergence loop terminates normally

## Tasks / Subtasks

- [ ] Task 1: Add convergence config fields to `GraphExecutorConfig` in `packages/factory/src/graph/executor.ts` (AC: #1, #2, #5)
  - [ ] Add four optional fields to the `GraphExecutorConfig` interface after `dotSource`:
    ```typescript
    /**
     * Session wall-clock budget in milliseconds (0 = unlimited).
     * Checked at the top of each main loop iteration — highest budget priority.
     * Wired to FactoryConfig.wall_clock_cap_ms in the factory run command.
     */
    wallClockCapMs?: number
    /**
     * Pipeline cost budget in USD (0 = unlimited).
     * Checked after the session budget — second-highest priority.
     * Accumulates per-node costs read from context key 'factory.lastNodeCostUsd'.
     */
    pipelineBudgetCapUsd?: number
    /**
     * Plateau detector window size — number of satisfaction scores to compare.
     * Defaults to 3 when omitted. Passed to createPlateauDetector().
     */
    plateauWindow?: number
    /**
     * Plateau detector threshold — max−min delta below which plateau is declared.
     * Defaults to 0.05 when omitted. Passed to createPlateauDetector().
     */
    plateauThreshold?: number
    ```
  - [ ] Add JSDoc comment above the config block noting that the four fields were added in story 45-8 as part of convergence loop wiring

- [ ] Task 2: Import convergence modules and initialize managers in `run()` (AC: all)
  - [ ] Extend the existing convergence import line in `executor.ts` to add:
    ```typescript
    import {
      createConvergenceController,
      SessionBudgetManager,
      PipelineBudgetManager,
      createPlateauDetector,
      checkPlateauAndEmit,
      buildRemediationContext,
      injectRemediationContext,
    } from '../convergence/index.js'
    ```
  - [ ] In `run()`, immediately after `const controller = createConvergenceController()`, add:
    ```typescript
    // Convergence budget and plateau managers (story 45-8)
    const sessionStartMs = Date.now()
    const sessionManager = new SessionBudgetManager(config.wallClockCapMs ?? 0)
    const pipelineManager = new PipelineBudgetManager(config.pipelineBudgetCapUsd ?? 0)
    const plateauDetector = createPlateauDetector({
      window: config.plateauWindow,
      threshold: config.plateauThreshold,
    })
    let convergenceIteration = 0
    ```
  - [ ] Verify the existing `createConvergenceController` import remains present and is not duplicated

- [ ] Task 3: Session and pipeline budget checks at top of main loop (AC: #1, #2)
  - [ ] At the very top of the `while (true)` loop body, before the `exitNode` constant declaration, add:
    ```typescript
    // --- Budget checks (story 45-8): session first (highest priority), then pipeline ---
    const elapsedMs = Date.now() - sessionStartMs
    const sessionResult = sessionManager.check(elapsedMs)
    if (!sessionResult.allowed) {
      return { status: 'FAIL', failureReason: sessionResult.reason }
    }
    const pipelineResult = pipelineManager.check()
    if (!pipelineResult.allowed) {
      return { status: 'FAIL', failureReason: pipelineResult.reason }
    }
    ```
  - [ ] Position these checks BEFORE the `const exitNode = graph.exitNode()` line so they apply to both normal dispatch and exit-node goal gate evaluation paths
  - [ ] Add an inline comment explaining budget enforcement priority order (session > pipeline > node retries)

- [ ] Task 4: Refactor exit node block — use `resolveRetryTarget`, plateau detection, and remediation injection (AC: #3, #4, #5, #6, #7)
  - [ ] Replace the existing inline 4-step retry target chain inside the `if (currentNode.id === exitNode.id)` block:
    ```typescript
    // BEFORE (story 42-16 inline chain):
    const retryTarget =
      failingGateNode?.retryTarget ||
      failingGateNode?.fallbackRetryTarget ||
      graph.retryTarget ||
      graph.fallbackRetryTarget
    ```
    With the `controller.resolveRetryTarget()` call from story 45-2:
    ```typescript
    // AFTER (story 45-8 — use ConvergenceController resolution):
    const retryTargetId = failingGateNode
      ? controller.resolveRetryTarget(failingGateNode, graph)
      : null
    ```
  - [ ] After resolving `retryTargetId`, handle the null case immediately:
    ```typescript
    if (!retryTargetId) {
      return { status: 'FAIL', failureReason: 'Goal gate failed: no retry target' }
    }
    const retryNode = graph.nodes.get(retryTargetId)
    if (!retryNode) {
      throw new Error(`Retry target node "${retryTargetId}" not found in graph`)
    }
    ```
  - [ ] Increment iteration counter and read satisfaction score from context:
    ```typescript
    convergenceIteration++
    const satisfactionScore = context.getNumber('convergence.satisfactionScore', 0.0)
    plateauDetector.recordScore(convergenceIteration, satisfactionScore)
    ```
  - [ ] Call `checkPlateauAndEmit` and handle plateau:
    ```typescript
    const plateauResult = checkPlateauAndEmit(plateauDetector, {
      runId: config.runId,
      nodeId: retryTargetId,
      eventBus: config.eventBus,
    })
    if (plateauResult.plateaued) {
      return {
        status: 'FAIL',
        failureReason: `Convergence plateau detected after ${convergenceIteration} iteration(s): scores plateaued at [${plateauResult.scores.join(', ')}]`,
      }
    }
    ```
  - [ ] Build and inject remediation context then route to retry target:
    ```typescript
    const remediation = buildRemediationContext({
      previousFailureReason: `Goal gate unsatisfied: ${gateResult.failedGates.join(', ')}`,
      iterationCount: convergenceIteration,
      satisfactionScoreHistory: plateauResult.scores,
    })
    injectRemediationContext(context, remediation)
    currentNode = retryNode
    continue
    ```

- [ ] Task 5: Refactor mid-graph FAIL routing to use `controller.resolveRetryTarget()` (AC: #3, #4)
  - [ ] Locate the FAIL routing block in the main loop (currently `if (outcome.status === 'FAIL')` at lines ~547-565) which uses the same inline 4-step chain for per-node failures
  - [ ] Replace the inline chain:
    ```typescript
    // BEFORE:
    const retryTarget =
      currentNode.retryTarget ||
      currentNode.fallbackRetryTarget ||
      graph.retryTarget ||
      graph.fallbackRetryTarget
    ```
    With `controller.resolveRetryTarget()`:
    ```typescript
    // AFTER:
    const retryTarget = controller.resolveRetryTarget(currentNode, graph)
    ```
  - [ ] Keep the `if (retryTarget)` guard and `graph.nodes.get(retryTarget)` null-check logic intact — only replace the resolution chain itself
  - [ ] Add a comment: `// Resolves via 4-level chain: node.retryTarget → node.fallbackRetryTarget → graph.retryTarget → graph.fallbackRetryTarget → null (story 45-2)`

- [ ] Task 6: Accumulate per-node pipeline cost from context updates (AC: #2)
  - [ ] After the `if (outcome.contextUpdates)` block that applies context updates (around lines 513-517), add:
    ```typescript
    // Accumulate per-node cost for pipeline budget tracking (story 45-8)
    // Convention: CodergenBackend writes 'factory.lastNodeCostUsd' to contextUpdates.
    const nodeCost = context.getNumber('factory.lastNodeCostUsd', 0)
    if (nodeCost > 0) {
      pipelineManager.accumulate(nodeCost)
    }
    ```
  - [ ] Position this accumulation AFTER `outcome.contextUpdates` are applied to `context` so `context.getNumber('factory.lastNodeCostUsd')` reflects the latest handler output
  - [ ] Add a JSDoc comment explaining the `factory.lastNodeCostUsd` convention so future backend implementors know to set it

- [ ] Task 7: Write unit tests in `packages/factory/src/graph/__tests__/executor-convergence.test.ts` (AC: #1–#7)
  - [ ] Create a new test file `packages/factory/src/graph/__tests__/executor-convergence.test.ts` — do NOT add to the existing `executor.test.ts`; this is a focused integration test for the convergence loop integration
  - [ ] Define minimal test helpers:
    - `makeGraph(nodes, edges, opts?)` that returns a minimal `Graph` with start/exit nodes and optional `retryTarget`/`fallbackRetryTarget` fields
    - `makeGoalGateNode(id)` returning a `GraphNode` with `goalGate: true`
    - `makeHandlerRegistry(handlers)` mapping node IDs to handler functions
    - `makeTestConfig(overrides?)` returning a `GraphExecutorConfig` with test defaults
  - [ ] **AC1 — Session budget halt**:
    - Set `wallClockCapMs: 1` (1ms — immediately exceeded on any real machine)
    - Wait via `await new Promise(r => setTimeout(r, 5))` to ensure elapsed > cap before run
    - Run executor and expect `{ status: 'FAIL' }` with `failureReason` containing `'Session budget exceeded'`
    - Verify no handler was called (handler call count = 0)
  - [ ] **AC2 — Pipeline budget halt**:
    - Set `pipelineBudgetCapUsd: 0.01`
    - Handler sets `contextUpdates: { 'factory.lastNodeCostUsd': '0.02' }` on first node
    - Verify second node receives `{ status: 'FAIL' }` with `failureReason` containing `'Pipeline budget exceeded'`
  - [ ] **AC3 + AC4 — resolveRetryTarget at exit node**:
    - Build a graph with one `goalGate=true` node wired to return FAILURE, and a `retryTarget` pointing to a "fix" node
    - First iteration: goal gate unsatisfied → retry to "fix" node
    - Second iteration: goal gate returns SUCCESS → `{ status: 'SUCCESS' }`
    - Separately: a graph where no retryTarget exists → `{ status: 'FAIL', failureReason: 'Goal gate failed: no retry target' }`
  - [ ] **AC5 — Plateau detection**:
    - Set `plateauWindow: 3, plateauThreshold: 0.5` (wide threshold for easy triggering)
    - Mock goal gate to always return FAILURE; mock context `convergence.satisfactionScore` to return `0.5` each iteration
    - After 3 iterations with identical scores (delta = 0 < 0.5), expect `{ status: 'FAIL' }` with `failureReason` containing `'Convergence plateau detected'`
  - [ ] **AC6 — Remediation context injection**:
    - Graph with goalGate node → retry target "fix" node that reads `getRemediationContext(context)`
    - Verify fix node receives a non-null `RemediationContext` with correct `iterationCount`
    - Verify `previousFailureReason` mentions the failing goal gate node ID
  - [ ] **AC7 — Successful convergence over 2 iterations**:
    - First iteration: goal gate handler returns FAILURE → retry to fix node
    - Second iteration: goal gate handler returns SUCCESS → expect `{ status: 'SUCCESS' }`

- [ ] Task 8: Build and validate (AC: all)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` — verify "Test Files" summary line appears; all tests pass; ≥14 new assertions in `executor-convergence.test.ts`, no regressions
  - [ ] Verify that `wallClockCapMs`, `pipelineBudgetCapUsd`, `plateauWindow`, and `plateauThreshold` appear in the `GraphExecutorConfig` type signature and are importable from `@substrate-ai/factory`

## Dev Notes

### Architecture Constraints

- **File to modify (production):**
  - `packages/factory/src/graph/executor.ts` — all changes are in this single file: config interface extension, import additions, manager initialization, budget checks, exit node refactor, FAIL routing refactor, cost accumulation

- **New test file:**
  - `packages/factory/src/graph/__tests__/executor-convergence.test.ts` — new file; do NOT modify `executor.test.ts`; all convergence integration tests go here to keep them isolated from the core traversal test suite

- **Import style:** All relative imports within `packages/factory/src/` use `.js` extensions (ESM). The convergence import is already present (`createConvergenceController`); extend it to include the new symbols in a single import statement.

- **Budget enforcement priority (architecture Section 6.3):**
  1. **Session budget** (per `wallClockCapMs`) — checked first at the top of each main loop iteration using `SessionBudgetManager.check(elapsedMs)`
  2. **Pipeline budget** (per `pipelineBudgetCapUsd`) — checked second using `PipelineBudgetManager.check()`
  3. **Per-node retries** (per `node.maxRetries`) — handled by `dispatchWithRetry()`; NOT changed in this story. The `NodeBudgetManager` from story 45-3 is not wired here to avoid scope creep — it remains available for a future refactor of `dispatchWithRetry`.

- **`resolveRetryTarget()` replaces inline chain in TWO places:**
  1. Exit node goal gate failure (lines ~331–335 in current executor.ts)
  2. Mid-graph FAIL routing (lines ~548–552 in current executor.ts)
  Both inline chains use the same 4-level resolution order, so both should use `controller.resolveRetryTarget(node, graph)`.

- **Satisfaction score context key:** `'convergence.satisfactionScore'` — the convention for the satisfaction scoring node (Epic 46) to write the numeric satisfaction score to `IGraphContext`. The executor reads this via `context.getNumber('convergence.satisfactionScore', 0.0)`. Defaulting to 0.0 is safe: if no scoring node has run, the plateau detector receives 0.0 for every iteration, which will cause plateau detection only if the threshold is very small. In production graphs, a scoring node always precedes the exit node.

- **Pipeline cost context key:** `'factory.lastNodeCostUsd'` — the convention for `CodergenBackend` (and other cost-bearing handlers) to write the per-node cost in USD to `IGraphContext`. The executor accumulates this after each node dispatch via `pipelineManager.accumulate(nodeCost)`. The key holds only the LAST node's cost; the `PipelineBudgetManager` owns the running total.

- **Convergence loop iteration counter:** `convergenceIteration` starts at 0 and is incremented to 1 on the first time a goal gate fails. It serves as the `iteration` argument to `plateauDetector.recordScore()` and the `iterationCount` argument to `buildRemediationContext()`. It is NOT a general step counter — only goal-gate-failure events increment it.

- **Plateau detection placement:** `plateauDetector.recordScore()` and `checkPlateauAndEmit()` are called ONLY in the exit node block when goal gates are unsatisfied — NOT on every loop iteration. The plateau detector tracks convergence progress across retry attempts, not individual node completions.

- **Remediation context on context mutation:** `injectRemediationContext(context, remediation)` mutates the `IGraphContext` in place. The retry target node will read it via `getRemediationContext(context)` in its handler (e.g., `CodergenBackend.generate()`). The context is shared across the entire convergence loop, so remediation context from a prior iteration is overwritten on each new retry — this is intentional (only the most recent remediation is relevant).

- **`skipCycleCheck` flag for retry routing:** When routing to a retry target from the exit node (convergence loop), the cycle detector should be suppressed for the same reason as mid-graph FAIL routing. Set `skipCycleCheck = true` before `currentNode = retryNode` in the exit node retry path. (The FAIL routing block already sets this flag — replicate the pattern for the exit node retry path.)

- **BudgetCheckResult interface:** Both `SessionBudgetManager.check()` and `PipelineBudgetManager.check()` return `{ allowed: boolean; reason?: string }`. The `reason` field is present when `allowed === false` and contains a human-readable explanation. Use it directly as `failureReason` in the returned Outcome.

- **`SessionBudgetManager` constructor signature (story 45-5):** Takes `capMs: number`. The manager records internal start time. The `check(elapsedMs)` method compares elapsed against the cap. Alternatively, if the story 45-5 implementation takes `(capMs, startTime)`, initialize with `new SessionBudgetManager(config.wallClockCapMs ?? 0, Date.now())` and call `check()` with no args. Follow whatever constructor signature story 45-5 implements — consult `packages/factory/src/convergence/budget.ts` at implementation time.

- **`PipelineBudgetManager` state:** The manager holds an internal running total. Methods expected: `accumulate(costUsd: number): void` and `check(): BudgetCheckResult`. Initialize with `new PipelineBudgetManager(config.pipelineBudgetCapUsd ?? 0)`.

- **`createPlateauDetector` options are optional:** Passing `{ window: undefined, threshold: undefined }` is equivalent to passing `{}` — the detector uses defaults (window=3, threshold=0.05). This means `config.plateauWindow` and `config.plateauThreshold` can be omitted from the `GraphExecutorConfig` and the defaults will apply automatically.

- **No new FactoryEvents required:** This story does not add new event types. The `convergence:plateau-detected` event is already defined in `packages/factory/src/events.ts` (added by story 45-6). The story emits it indirectly via `checkPlateauAndEmit()`.

- **Test file location:** `packages/factory/src/graph/__tests__/executor-convergence.test.ts`. The factory package's `vitest.config.ts` already discovers test files in `src/**/__tests__/*.test.ts`.

### Testing Requirements

- **Test framework:** Vitest (configured in `packages/factory/vitest.config.ts`)
- **New test file only:** `packages/factory/src/graph/__tests__/executor-convergence.test.ts` — do NOT append to `executor.test.ts` or any existing test file
- **Handler mocks:** Use `vi.fn()` returning `Promise.resolve(outcome)` for test handlers. Register them via a minimal in-memory `IHandlerRegistry` stub (map of node IDs to handlers).
- **Graph construction:** Build minimal graphs directly as `Graph` objects using the interfaces from `packages/factory/src/graph/types.ts` — no need to parse DOT for unit tests.
- **Cycle detection bypass in tests:** Set `wallClockCapMs: 0` (unlimited) and keep graphs small (≤ 5 nodes) to avoid cycle detection limits. The convergence loop test (AC7) visits the goal gate node twice, which is intentional — the cycle detection threshold is `graph.nodes.size * 3`.
- **Plateau test timing:** Do not rely on wall-clock timing for plateau tests. Instead, configure `wallClockCapMs: 0` (unlimited) and use a tight `plateauWindow: 2, plateauThreshold: 0.5` to trigger plateau after just 2 iterations with identical mock scores.
- **Run command:** `npm run test:fast` with `timeout: 300000` — unit tests only, no coverage, ~50s
- **Confirm pass:** Look for the "Test Files" summary line in output — exit code alone is insufficient
- **NEVER pipe output** through `head`, `tail`, or `grep`
- **Target:** ≥14 new assertions in `executor-convergence.test.ts`, all passing; no regressions in the 7672-test baseline

### Dependency Notes

- **Depends on (all must be implemented before this story):**
  - Story 45-1 (`checkGoalGates` on `ConvergenceController`, `GoalGateResult` type)
  - Story 45-2 (`resolveRetryTarget` on `ConvergenceController`)
  - Story 45-3 (`NodeBudgetManager`, `checkNodeBudget` — not wired in this story but must exist in budget.ts for the import to resolve)
  - Story 45-4 (`PipelineBudgetManager`, `checkPipelineBudget`)
  - Story 45-5 (`SessionBudgetManager`, `checkSessionBudget`)
  - Story 45-6 (`createPlateauDetector`, `checkPlateauAndEmit`, `PlateauDetector`)
  - Story 45-7 (`buildRemediationContext`, `injectRemediationContext`, `RemediationContext`)
- **Depended on by:**
  - Story 45-9 (end-to-end convergence loop integration test — runs against the executor wired in this story)
  - Epic 46 (Satisfaction Scoring — adds the scoring node that writes `convergence.satisfactionScore` to context, consumed by the plateau detector wired here)

## Interface Contracts

- **Import**: `SessionBudgetManager` @ `packages/factory/src/convergence/budget.ts` (from story 45-5)
- **Import**: `PipelineBudgetManager` @ `packages/factory/src/convergence/budget.ts` (from story 45-4)
- **Import**: `createPlateauDetector`, `checkPlateauAndEmit` @ `packages/factory/src/convergence/plateau.ts` (from story 45-6)
- **Import**: `buildRemediationContext`, `injectRemediationContext` @ `packages/factory/src/convergence/remediation.ts` (from story 45-7)
- **Export**: `GraphExecutorConfig` (extended with `wallClockCapMs`, `pipelineBudgetCapUsd`, `plateauWindow`, `plateauThreshold`) @ `packages/factory/src/graph/executor.ts` (consumed by story 45-9, Epic 46 factory runner, and `substrate factory run` CLI)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-23: Story created for Epic 45, Phase B — Convergence Loop
