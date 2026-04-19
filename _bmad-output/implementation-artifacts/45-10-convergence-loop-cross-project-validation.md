# Story 45-10: Convergence Loop Cross-Project Validation

## Story

As a factory pipeline maintainer,
I want the full convergence loop stack validated end-to-end from CLI configuration through executor integration,
so that Epic 45 budget enforcement, retry routing, plateau detection, and remediation context are confirmed working together before the Epic 46 satisfaction scoring layer is added.

## Acceptance Criteria

### AC1: Convergence Config Wired from FactoryConfig to GraphExecutorConfig in CLI
**Given** `factory-command.ts` loads a `FactoryConfig` with `wall_clock_cap_seconds`, `budget_cap_usd`, `plateau_window`, and `plateau_threshold`
**When** `substrate factory run --graph trycycle.dot` executes
**Then** the executor receives `wallClockCapMs`, `pipelineBudgetCapUsd`, `plateauWindow`, and `plateauThreshold` derived from the loaded config — specifically `wallClockCapMs = wall_clock_cap_seconds * 1000` and the plateau fields forwarded as-is

### AC2: `trycycle.dot` Fixture Defines a Valid Convergence Graph
**Given** the fixture file at `packages/factory/src/__tests__/integration/fixtures/trycycle.dot`
**When** parsed by `parseGraph()` and validated by `createValidator().validateOrRaise()`
**Then** the graph contains exactly 5 nodes (`start`, `implement`, `validate`, `conditional`, `exit`), the `implement` node has `goal_gate=true` and `retry_target=implement`, and the graph-level `retryTarget` attribute points to `implement` — with zero validation errors

### AC3: Two-Iteration Convergence — Goal Gate Fails Then Passes
**Given** a mock `validate` tool-node handler returning `{passed: 2, total: 3}` (score ≈ 0.667) on the first call and `{passed: 3, total: 3}` (score = 1.0) on the second, and the `implement` goal gate node configured with `goal_gate=true`
**When** the graph executor runs `trycycle.dot` with these mocked handlers
**Then** after iteration 1 the goal gate fails (score 0.667 < threshold 0.8), execution routes to the `implement` retry target; after iteration 2 the goal gate passes (score 1.0 ≥ 0.8), the executor returns `{ status: 'SUCCESS' }`

### AC4: Pipeline Budget Cap Halts Convergence Loop
**Given** `pipelineBudgetCapUsd = 0.05` in `GraphExecutorConfig` and a mock `implement` handler that sets `contextUpdates: { 'factory.lastNodeCostUsd': '0.04' }` on each call
**When** the executor processes the second iteration (accumulated cost = $0.08 > $0.05 cap)
**Then** the pipeline halts with `{ status: 'FAIL' }` and a `failureReason` containing `'Pipeline budget exceeded'` — no node is dispatched after the second implement completes

### AC5: Plateau Detection Halts Loop When Scores Stop Improving
**Given** `plateauWindow = 3`, `plateauThreshold = 0.5`, and a mock validate handler that always returns `{passed: 1, total: 3}` (score ≈ 0.333, constant across all iterations)
**When** the executor runs 3 goal-gate failure iterations with the same constant mock score
**Then** the executor returns `{ status: 'FAIL' }` with a `failureReason` containing `'Convergence plateau detected'` and the plateau score array — execution does not continue to a fourth iteration

### AC6: Remediation Context Injected on Retry Dispatch
**Given** a convergence loop where the goal gate fails on iteration 1 and the test captures the `IGraphContext` passed to the `implement` handler on the second dispatch
**When** the `implement` handler is called for the retry iteration
**Then** `getRemediationContext(context)` returns a non-null `RemediationContext` with `iterationCount === 1` and a non-empty `previousFailureReason` that mentions the failing goal gate node

### AC7: Epic 45 Coverage Gate — Build and Tests Pass
**Given** all Epic 45 convergence components (stories 45-1 through 45-9) implemented
**When** `npm run build` and `npm run test:fast` are executed
**Then** zero TypeScript errors; `convergence-validation.test.ts` contributes ≥ 20 passing assertions; no regressions against the 7,672-test baseline from Epic 44

## Tasks / Subtasks

- [ ] Task 1: Wire convergence config from FactoryConfig to GraphExecutorConfig in `factory-command.ts` (AC: #1)
  - [ ] In the `factory run` action function (inside `registerFactoryCommand`), load the factory config using the existing `loadFactoryConfig(projectDir, opts.config)` call that already exists in `resolveGraphPath` — refactor to load config once and reuse it for both graph path resolution and executor config
  - [ ] After constructing `executor` and before calling `executor.run()`, pass four new config fields to the `GraphExecutorConfig`:
    ```typescript
    wallClockCapMs: (config.factory?.wall_clock_cap_seconds ?? 0) * 1000,
    pipelineBudgetCapUsd: config.factory?.budget_cap_usd ?? 0,
    plateauWindow: config.factory?.plateau_window ?? 3,
    plateauThreshold: config.factory?.plateau_threshold ?? 0.05,
    ```
  - [ ] Avoid loading config twice — refactor `resolveGraphPath` to accept the pre-loaded config or inline graph path resolution into the action body if that is simpler. The config already loaded once for graph path resolution should be reused.
  - [ ] Add JSDoc comments on the four new config fields noting they were added in story 45-10 to wire convergence budget and plateau controls from `FactoryConfig`

- [ ] Task 2: Create `trycycle.dot` fixture file (AC: #2)
  - [ ] Create `packages/factory/src/__tests__/integration/fixtures/trycycle.dot` with this content:
    ```dot
    digraph trycycle {
      graph [
        goal        = "Implement the feature so all holdout scenarios pass",
        label       = "Convergence Loop Cross-Project Validation Fixture",
        retryTarget = "implement"
      ]

      start       [shape=Mdiamond]
      implement   [shape=box,
                   goal_gate    = "true",
                   retry_target = "implement",
                   prompt       = "Implement the feature based on the failing scenarios"]
      validate    [shape=parallelogram,
                   type         = "tool",
                   tool_command = "substrate scenarios run --format json",
                   label        = "Validate against holdout scenarios"]
      conditional [shape=diamond]
      exit        [shape=Msquare]

      start       -> implement
      implement   -> validate
      validate    -> conditional
      conditional -> exit        [condition="satisfaction_score>=0.8"]
      conditional -> implement
    }
    ```
  - [ ] Verify the fixture parses without errors by running the parse+validate logic mentally: 5 nodes, 5 edges (start→implement, implement→validate, validate→conditional, conditional→exit, conditional→implement), `implement` has `goal_gate=true` and `retry_target=implement`, graph has `retryTarget=implement`

- [ ] Task 3: Write two-iteration convergence and remediation context tests (AC: #3, #6)
  - [ ] Create `packages/factory/src/__tests__/integration/convergence-validation.test.ts` — do NOT modify any existing test file
  - [ ] Import pattern (reuse existing integration test imports):
    ```typescript
    import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
    import { parseGraph } from '../../graph/parser.js'
    import { createValidator } from '../../graph/validator.js'
    import { createGraphExecutor } from '../../graph/executor.js'
    import { getRemediationContext } from '../../convergence/remediation.js'
    import {
      makeTmpDir,
      cleanDir,
      makeEventSpy,
      buildScenarioRunResult,
      createMockSpawnProcess,
    } from './helpers.js'
    ```
  - [ ] Add a helper `readTrycycleDot(): string` that reads `fixtures/trycycle.dot` using `readFileSync` — follow the same pattern as `readFixtureDot()` in `helpers.ts`
  - [ ] **Test AC2a** — "trycycle.dot parses and validates without errors": call `parseGraph(readTrycycleDot())`, then `createValidator().validateOrRaise(graph)`. Assert graph has exactly 5 nodes and the `implement` node has `goalGate === true`.
  - [ ] **Test AC2b** — "trycycle.dot implement node has retryTarget=implement": parse graph, find `implement` node via `graph.nodes.get('implement')`, assert `node.retryTarget === 'implement'`
  - [ ] **Test AC3a** — "two-iteration convergence: goal gate fails then passes — executor returns SUCCESS": mock `child_process.spawn` (or the tool handler) to return `buildScenarioRunResult(2, 3)` on first validate call and `buildScenarioRunResult(3, 3)` on second. Wire a custom `IHandlerRegistry` that uses the tool handler for `validate` and mock handlers for other nodes. Run executor with `plateauWindow: 3, plateauThreshold: 0.05`. Assert `result.status === 'SUCCESS'`.
  - [ ] **Test AC3b** — "two-iteration convergence: validate node handler called exactly twice": after the run, assert the validate handler spy was called 2 times
  - [ ] **Test AC3c** — "two-iteration convergence: goal_gate node dispatched twice total": assert `implement` handler called twice (once initially, once as retry target)
  - [ ] **Test AC6a** — "remediation context injected: second implement dispatch receives RemediationContext": capture `IGraphContext` passed to `implement` handler on each call. On the second call (retry dispatch), call `getRemediationContext(capturedContext)`. Assert result is non-null, `result.iterationCount === 1`, `result.previousFailureReason` is a non-empty string.
  - [ ] **Test AC6b** — "remediation context previousFailureReason mentions implement node": assert `result.previousFailureReason` contains the string `'implement'` (the failing goal gate node ID)
  - [ ] Aim for ≥ 8 assertions in this test block

- [ ] Task 4: Write pipeline budget cap and plateau detection tests (AC: #4, #5)
  - [ ] **Test AC4a** — "pipeline budget cap halts after second iteration": create a graph executor config with `pipelineBudgetCapUsd: 0.05`. Wire `implement` handler to return `{ status: 'SUCCESS', contextUpdates: { 'factory.lastNodeCostUsd': '0.04' } }`. Wire validate handler to always return `buildScenarioRunResult(0, 3)` (always fail). Run executor. Assert `result.status === 'FAIL'` and `result.failureReason` contains `'Pipeline budget exceeded'`.
  - [ ] **Test AC4b** — "pipeline budget cap: implement handler called at most twice before halt": after the AC4a run, assert `implement` handler spy was called ≤ 2 times (not 3+)
  - [ ] **Test AC5a** — "plateau detection halts loop after 3 identical scores": configure `plateauWindow: 3, plateauThreshold: 0.5`. Wire validate handler to always return `buildScenarioRunResult(1, 3)` (score = 0.333, constant). Wire implement handler to return SUCCESS on every call. Run executor. Assert `result.status === 'FAIL'` and `result.failureReason` contains `'Convergence plateau detected'`.
  - [ ] **Test AC5b** — "plateau detection failure reason includes score history": assert `result.failureReason` contains `'0.333'` or the scores array representation (to confirm score history is embedded in the failure message)
  - [ ] **Test AC5c** — "plateau detection does not fire before window is filled": configure `plateauWindow: 4, plateauThreshold: 0.5`, return only 3 identical mock scores (i.e., after 3 goal gate failures). Assert plateau has NOT fired after 3 iterations — run fails on budget or node retry exhaustion, not plateau. Use `toContain` negation: `expect(result.failureReason).not.toContain('plateau')`.
  - [ ] Aim for ≥ 6 assertions in this test block

- [ ] Task 5: Write factory CLI convergence config wiring test (AC: #1)
  - [ ] Add a new `describe` block in `packages/factory/src/__tests__/factory-run-command.test.ts` — do NOT create a new file; append to the existing unit test suite for the CLI command
  - [ ] **Test AC1a** — "factory run wires wallClockCapMs from FactoryConfig": mock `loadFactoryConfig` to return a config with `factory.wall_clock_cap_seconds = 60`. Capture the config passed to `executor.run()`. Assert `capturedConfig.wallClockCapMs === 60000`.
  - [ ] **Test AC1b** — "factory run wires pipelineBudgetCapUsd from FactoryConfig": mock config with `factory.budget_cap_usd = 5.0`. Assert `capturedConfig.pipelineBudgetCapUsd === 5.0`.
  - [ ] **Test AC1c** — "factory run wires plateauWindow and plateauThreshold": mock config with `factory.plateau_window = 4, factory.plateau_threshold = 0.03`. Assert `capturedConfig.plateauWindow === 4` and `capturedConfig.plateauThreshold === 0.03`.
  - [ ] **Test AC1d** — "factory run uses defaults when FactoryConfig fields are absent": mock config with no `factory` key (or `factory: {}`). Assert `capturedConfig.wallClockCapMs === 0`, `capturedConfig.pipelineBudgetCapUsd === 0`, `capturedConfig.plateauWindow === 3`, `capturedConfig.plateauThreshold === 0.05`.
  - [ ] Aim for ≥ 4 assertions in this test block

- [ ] Task 6: Update `helpers.ts` if needed and write Epic 45 coverage gate (AC: #7)
  - [ ] If `helpers.ts` does not export a `readFixtureDot(name?: string)` overload that accepts a fixture filename parameter, add a `readNamedFixtureDot(name: string): string` export that reads from `fixtures/{name}` — this avoids duplicating the `__dirname` resolution in `convergence-validation.test.ts`. If the existing `readFixtureDot()` can be used by passing a parameter, prefer that approach.
  - [ ] In `packages/factory/src/__tests__/integration/epic44-coverage-gate.test.ts` (or a new sibling file `epic45-coverage-gate.test.ts`), add a coverage gate test block:
    - Import `createConvergenceController` from `'../../convergence/controller.js'`
    - Import `SessionBudgetManager, PipelineBudgetManager` from `'../../convergence/budget.js'`
    - Import `createPlateauDetector` from `'../../convergence/plateau.js'`
    - Import `buildRemediationContext, getRemediationContext` from `'../../convergence/remediation.js'`
    - Assert all five are defined/importable
    - Add a block comment documenting expected convergence test counts: `// 45-1 through 45-4: ~35, 45-5: ~8, 45-6: ~8, 45-7: ~10, 45-8: ~14, 45-9: ~8, 45-10: ~25 → Total ≥ 108`

- [ ] Task 7: Build and validate (AC: #7)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` — verify "Test Files" summary line appears; do NOT pipe output
  - [ ] Confirm `convergence-validation.test.ts` contributes ≥ 20 new passing assertions
  - [ ] Confirm no regressions against the 7,672-test baseline (all pre-existing tests still pass)
  - [ ] Confirm factory-run-command.test.ts convergence wiring tests pass

## Dev Notes

### Architecture Constraints

- **Production file to modify:** `packages/factory/src/factory-command.ts` — add 4 convergence config fields to the `executor.run()` call, refactor config loading to avoid double-load. This is the only production file that should change in this story.

- **New test file:** `packages/factory/src/__tests__/integration/convergence-validation.test.ts` — do NOT modify `scenario-pipeline.test.ts`, `events.test.ts`, `persistence.test.ts`, or `integrity.test.ts` from story 44-10. Create a new, focused convergence validation test file.

- **New fixture file:** `packages/factory/src/__tests__/integration/fixtures/trycycle.dot` — a DOT graph representing a convergence "try cycle" (implement → validate → conditional → exit or retry). Stored alongside the existing `pipeline.dot` fixture.

- **Modify test file:** `packages/factory/src/__tests__/factory-run-command.test.ts` — append a new `describe` block for convergence config wiring tests. The existing `vi.mock` declarations at the top of this file are already present and will work for the new tests.

- **Import style:** All relative imports within `packages/factory/src/` use `.js` extensions (ESM). Example: `import { getRemediationContext } from '../../convergence/remediation.js'`

- **Do NOT import from `@substrate-ai/sdlc`** — factory test files may only import from `@substrate-ai/core`, `@substrate-ai/factory`, or relative paths within `packages/factory/`

- **`FactoryConfig` config refactor guidance:** The current `factory-command.ts` calls `loadFactoryConfig` inside `resolveGraphPath()` and again potentially inside the action. Refactor the action to: (1) call `loadFactoryConfig` once upfront, (2) derive the graph path from the loaded config (removing the `resolveGraphPath` helper or inlining it), (3) pass config fields to `executor.run()`. This avoids double-reading the config file. If refactoring `resolveGraphPath` introduces risk, an acceptable alternative is calling `loadFactoryConfig` twice (once in `resolveGraphPath` for graph path resolution, once inline in the action for config fields) since the function is idempotent.

- **`wallClockCapMs` conversion:** `FactoryConfig.wall_clock_cap_seconds` is in seconds; `GraphExecutorConfig.wallClockCapMs` is in milliseconds. The conversion is `wallClockCapMs = wall_clock_cap_seconds * 1000`. When `wall_clock_cap_seconds === 0` (unlimited), `wallClockCapMs === 0` which is the correct "unlimited" sentinel for the executor.

- **Mock handler context capture for AC6:** To capture the `IGraphContext` passed to the `implement` handler, the test should use a `vi.fn()` handler spy that stores the context argument:
  ```typescript
  let capturedContextOnRetry: IGraphContext | undefined
  let implementCallCount = 0
  const implementSpy = vi.fn().mockImplementation(async (_node, context) => {
    implementCallCount++
    if (implementCallCount === 2) {
      capturedContextOnRetry = context
    }
    return { status: 'SUCCESS' } as Outcome
  })
  ```
  Then after the run: `const remediation = getRemediationContext(capturedContextOnRetry!)`

- **Mock child_process for tool node (validate):** The `validate` tool node uses `substrate scenarios run --format json` which spawns a child process. Mock `child_process.spawn` using `vi.mock('child_process', ...)` at the top of `convergence-validation.test.ts` (same pattern as `scenario-pipeline.test.ts`). Use `createMockSpawnProcess` from `helpers.ts` with `buildScenarioRunResult(passed, total)` JSON as stdout. Use `mockImplementationOnce` for sequenced return values (different results on iteration 1 vs iteration 2).

- **Context updates format:** The `pipelineManager.accumulate()` reads from `context.getNumber('factory.lastNodeCostUsd', 0)`. Context updates are applied as string values in `contextUpdates` (e.g., `'factory.lastNodeCostUsd': '0.04'`). The executor applies these to context before reading, so `getNumber` parses the string to a number.

- **Satisfaction score context key for conditional routing:** In `trycycle.dot`, the conditional node routes to `exit` when `satisfaction_score>=0.8`. The validate tool node (story 44-5) writes the satisfaction score to context key `'satisfaction_score'` (without prefix) when `computeSatisfactionScore` runs. The convergence executor reads from `'convergence.satisfactionScore'` (with prefix) for plateau detection. These are two different keys. The conditional routing uses the unprefixed key; plateau detection uses the prefixed key. Verify the tool handler writes BOTH or that 45-9's test confirms the correct key. If only one key is written, adjust plateau detection assertions accordingly.

- **Goal gate node resolution:** The `trycycle.dot` graph has `implement` as a goal gate node (`goal_gate=true`). When the executor visits the exit node after traversal, `controller.checkGoalGates()` evaluates all visited goal gate nodes. For the mock scenario, the goal gate check should pass when `satisfaction_score >= threshold`. If the mock handler doesn't write the `satisfaction_score` key (since it's a custom spy, not the real tool handler), the goal gate may always return `{satisfied: false}` because the score context key is absent. Solution: in the test, either (a) use the real tool handler for validate + mock spawn, or (b) make the mock implement handler also write `context.set('convergence.satisfactionScore', 1.0)` on the second call to simulate a satisfied score that the goal gate evaluates.

- **Vitest mock hoisting:** `vi.mock(...)` calls are hoisted to the top of the module by Vitest — they must appear before any `import` that uses the mocked module. The `child_process` mock is already present in `scenario-pipeline.test.ts`; replicate this pattern in `convergence-validation.test.ts`. Each test file needs its own `vi.mock` declaration.

- **Test isolation:** Each `describe` block should use `beforeEach`/`afterEach` for temp directory creation and cleanup. Spy/mock state should be reset between tests with `vi.clearAllMocks()` or `beforeEach(() => vi.resetAllMocks())`.

- **Cycle detection in convergence loop:** `trycycle.dot` intentionally cycles `conditional → implement → validate → conditional` on failure. The executor's cycle detector uses a threshold of `graph.nodes.size * 3 = 5 * 3 = 15` visits before raising an error. Tests with `plateauWindow: 3` will execute at most 3 goal-gate-failure iterations = ~12 node dispatches, safely below the threshold. For the pipeline budget test (AC4), only 2 iterations run before budget is exhausted.

### Testing Requirements

- **Framework:** Vitest (configured in `packages/factory/vitest.config.ts`)
- **Mock pattern for child_process:** `vi.mock('child_process', async (importOriginal) => { const actual = await importOriginal(); return { ...actual, spawn: vi.fn() } })` — use `importOriginal` to preserve `exec`, `execFile`, and other exports used by `@substrate-ai/core`
- **Mock sequence:** Use `mockImplementationOnce` chaining for multi-call sequences; use `mockImplementation` for uniform behavior across all calls
- **Run command:** `npm run test:fast` with `timeout: 300000` — unit tests only, no coverage, ~50s
- **NEVER pipe output** through `head`, `tail`, or `grep` — pipes discard the Vitest summary line
- **Confirm pass:** Look for "Test Files" in output — exit code alone is insufficient
- **Target:** ≥ 20 new assertions in `convergence-validation.test.ts` + ≥ 4 in `factory-run-command.test.ts`; all passing; no regressions

### Dependency Notes

- **Depends on (must be implemented before this story):**
  - Story 45-1 (`checkGoalGates` on `ConvergenceController`, `GoalGateResult`)
  - Story 45-2 (`resolveRetryTarget` on `ConvergenceController`)
  - Story 45-3 (`NodeBudgetManager`, `checkNodeBudget`)
  - Story 45-4 (`PipelineBudgetManager`)
  - Story 45-5 (`SessionBudgetManager`)
  - Story 45-6 (`createPlateauDetector`, `checkPlateauAndEmit`)
  - Story 45-7 (`buildRemediationContext`, `injectRemediationContext`, `getRemediationContext`)
  - Story 45-8 (convergence controller wired into executor — `wallClockCapMs`, `pipelineBudgetCapUsd`, `plateauWindow`, `plateauThreshold` on `GraphExecutorConfig`)
  - Story 45-9 (convergence loop end-to-end test — confirms executor works before this integration layer validates the CLI)
- **Depended on by:**
  - Epic 46 (Satisfaction Scoring — builds on the convergence loop validated here)
  - This story is the **Epic 45 completion gate** — Epic 45 is considered complete when this story passes

## Interface Contracts

- **Import**: `getRemediationContext` @ `packages/factory/src/convergence/remediation.ts` (from story 45-7)
- **Import**: `GraphExecutorConfig` (with `wallClockCapMs`, `pipelineBudgetCapUsd`, `plateauWindow`, `plateauThreshold`) @ `packages/factory/src/graph/executor.ts` (from story 45-8)
- **Import**: `FactoryConfig` @ `packages/factory/src/config.ts` (from story 44-9, with budget/plateau fields)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-23: Story created for Epic 45, Phase B — Convergence Loop Cross-Project Validation (final Epic 45 story)
