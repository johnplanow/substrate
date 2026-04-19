# Story 45-7: Remediation Context Injection on Retry

## Story

As a convergence controller,
I want structured remediation context built from failure data and injected into the retried node's GraphContext,
so that the retried node receives focused guidance about what failed, why it failed, and how to fix it.

## Acceptance Criteria

### AC1: RemediationContext Is Built From Required Parameters
**Given** a `BuildRemediationContextParams` with `previousFailureReason: "goal gate unsatisfied"`, a `ScenarioRunResult` with 1 failed scenario, `iterationCount: 2`, and `satisfactionScoreHistory: [0.4, 0.55]`
**When** `buildRemediationContext(params)` is called
**Then** it returns an object with all five required fields: `previousFailureReason`, `scenarioDiff`, `iterationCount`, `satisfactionScoreHistory`, and `fixScope` — shaped per architecture Section 6.5

### AC2: scenarioDiff Describes Failed Scenarios With Names and Reasons
**Given** a `ScenarioRunResult` containing scenario `{ name: "login-empty-password", status: "fail", stderr: "password cannot be empty", ... }`
**When** `formatScenarioDiff(results)` is called
**Then** the returned string contains both `"login-empty-password"` and `"password cannot be empty"` so the retried agent understands which scenario failed and why

### AC3: scenarioDiff Returns Informative Message When No Scenarios Failed
**Given** a `ScenarioRunResult` where all scenarios passed or the scenarios array is empty
**When** `formatScenarioDiff(results)` is called
**Then** it returns `"All scenarios passed"` — giving the retried node context that failure was not scenario-driven

### AC4: fixScope Lists Failing Scenario Names With Count
**Given** a `ScenarioRunResult` with 2 failed scenarios named `"login-empty-password"` and `"auth-null-token"`
**When** `deriveFixScope(results)` is called
**Then** it returns a string that contains both scenario names and the failure count (e.g., `"Fix 2 failing scenarios: login-empty-password, auth-null-token"`)

### AC5: fixScope Is Empty String When All Scenarios Pass
**Given** a `ScenarioRunResult` where all scenarios passed
**When** `deriveFixScope(results)` is called
**Then** it returns `""` — no fix scope needed when there are no scenario failures

### AC6: Remediation Is Injected Into and Retrieved From GraphContext
**Given** a fully constructed `RemediationContext` and a fresh `IGraphContext` instance
**When** `injectRemediationContext(context, remediation)` is called
**Then** `getRemediationContext(context)` returns that same remediation object; calling `getRemediationContext` on a context with no prior injection returns `undefined`

### AC7: satisfactionScoreHistory Is Stored as a Defensive Copy
**Given** `params.satisfactionScoreHistory = [0.4, 0.5, 0.55]`
**When** `buildRemediationContext(params)` is called and the caller mutates the original array afterward
**Then** `remediation.satisfactionScoreHistory` still reflects `[0.4, 0.5, 0.55]` — the builder stores a copy so external mutation does not corrupt the remediation

## Tasks / Subtasks

- [ ] Task 1: Define types and constants in `packages/factory/src/convergence/remediation.ts` (AC: #1, #6)
  - [ ] Define `REMEDIATION_CONTEXT_KEY = 'convergence.remediation'` as an exported `const` — the agreed key under which remediation is stored in `IGraphContext`
  - [ ] Define `RemediationContext` interface:
    ```typescript
    interface RemediationContext {
      previousFailureReason: string
      scenarioDiff: string
      iterationCount: number
      satisfactionScoreHistory: number[]
      fixScope: string
    }
    ```
  - [ ] Define `BuildRemediationContextParams` interface:
    ```typescript
    interface BuildRemediationContextParams {
      previousFailureReason: string
      scenarioResults?: ScenarioRunResult
      iterationCount: number
      satisfactionScoreHistory: number[]
    }
    ```
  - [ ] Import `ScenarioRunResult` from `'../events.js'` and `IGraphContext` from `'../graph/types.js'`
  - [ ] Add JSDoc on `RemediationContext` referencing architecture Section 6.5 and noting the five fields match the factory convergence spec

- [ ] Task 2: Implement `formatScenarioDiff()` pure function (AC: #2, #3)
  - [ ] Export `formatScenarioDiff(results: ScenarioRunResult): string`
  - [ ] Filter `results.scenarios` to collect only `status === 'fail'` entries
  - [ ] If no failures, return `"All scenarios passed"`
  - [ ] For each failed scenario, produce a line: `"- {name}: {stderr || stdout || '(no output)'}"` (prefer stderr; fall back to stdout; fall back to literal `'(no output)'` when both are empty)
  - [ ] Join lines with `\n` and return the complete diff string
  - [ ] Add JSDoc explaining that this is a pure formatting function with no side effects

- [ ] Task 3: Implement `deriveFixScope()` pure function (AC: #4, #5)
  - [ ] Export `deriveFixScope(results: ScenarioRunResult): string`
  - [ ] Filter `results.scenarios` to failed entries
  - [ ] If no failures, return `""`
  - [ ] Return `"Fix {n} failing scenario{s}: {name1}, {name2}, ..."` using the failed scenario names joined by `", "` — pluralize "scenario" to "scenarios" when `n > 1`
  - [ ] Add JSDoc noting this function produces human-readable fix instructions for the retried agent

- [ ] Task 4: Implement `buildRemediationContext()` builder function (AC: #1, #7)
  - [ ] Export `buildRemediationContext(params: BuildRemediationContextParams): RemediationContext`
  - [ ] Compute `scenarioDiff` via `formatScenarioDiff(params.scenarioResults)` when `scenarioResults` is provided; otherwise use `"No scenario results available"`
  - [ ] Compute `fixScope` via `deriveFixScope(params.scenarioResults)` when `scenarioResults` is provided; otherwise use `""`
  - [ ] Store `satisfactionScoreHistory` as a **defensive copy**: `[...params.satisfactionScoreHistory]`
  - [ ] Return the complete `RemediationContext` object with all five fields
  - [ ] Add JSDoc explaining that `scenarioResults` is optional (first-iteration retries may not have scenario data yet)

- [ ] Task 5: Implement `injectRemediationContext()` and `getRemediationContext()` helpers (AC: #6)
  - [ ] Export `injectRemediationContext(context: IGraphContext, remediation: RemediationContext): void` — calls `context.set(REMEDIATION_CONTEXT_KEY, remediation)`
  - [ ] Export `getRemediationContext(context: IGraphContext): RemediationContext | undefined` — reads `context.get(REMEDIATION_CONTEXT_KEY)` and returns it typed as `RemediationContext | undefined` (using `as` cast; trust the writer)
  - [ ] Add JSDoc on `injectRemediationContext` noting it is called by the executor's retry loop before dispatching to the retried node
  - [ ] Add JSDoc on `getRemediationContext` noting it is the accessor for `CodergenBackend` and other handlers that need to read remediation context

- [ ] Task 6: Append exports to `packages/factory/src/convergence/index.ts` (AC: all)
  - [ ] Add a `// Remediation context injection — story 45-7` comment followed by:
    - `export { REMEDIATION_CONTEXT_KEY, buildRemediationContext, formatScenarioDiff, deriveFixScope, injectRemediationContext, getRemediationContext } from './remediation.js'`
    - `export type { RemediationContext, BuildRemediationContextParams } from './remediation.js'`
  - [ ] Preserve all existing exports (controller, budget, plateau) without modification

- [ ] Task 7: Write unit tests in `packages/factory/src/convergence/__tests__/remediation.test.ts` (AC: #1–#7)
  - [ ] `describe('formatScenarioDiff', ...)`:
    - AC2: ScenarioRunResult with one failed scenario `{name: "login-empty-password", stderr: "password cannot be empty"}` → result contains `"login-empty-password"` and `"password cannot be empty"`
    - AC2 (multiple): Two failed scenarios → both names and stderr messages appear in the output
    - AC3: All scenarios passed → returns exactly `"All scenarios passed"`
    - AC3 (empty): `scenarios: []` → returns `"All scenarios passed"`
    - AC2 (no stderr): Failed scenario with empty `stderr` but non-empty `stdout` → falls back to stdout in the diff
    - AC2 (no output): Failed scenario with both `stderr` and `stdout` empty → uses `'(no output)'` literal
  - [ ] `describe('deriveFixScope', ...)`:
    - AC4: Two failures `"login-empty-password"` and `"auth-null-token"` → returns string starting with `"Fix 2 failing scenarios:"` and containing both names
    - AC4 (singular): One failure → `"Fix 1 failing scenario: {name}"` (singular "scenario")
    - AC5: All scenarios passed → returns `""`
    - AC5 (empty): `scenarios: []` → returns `""`
  - [ ] `describe('buildRemediationContext', ...)`:
    - AC1: With full params → returned object has all 5 fields; `previousFailureReason`, `iterationCount` match inputs
    - AC1 (no scenarioResults): `scenarioResults` omitted → `scenarioDiff = "No scenario results available"`, `fixScope = ""`
    - AC7: Mutate original `satisfactionScoreHistory` array after calling builder → `remediation.satisfactionScoreHistory` is unchanged
  - [ ] `describe('injectRemediationContext / getRemediationContext', ...)`:
    - AC6: Inject then get → same object retrieved
    - AC6 (undefined): Fresh context with no injection → `getRemediationContext(context)` returns `undefined`
    - REMEDIATION_CONTEXT_KEY is exported and equals `'convergence.remediation'`

- [ ] Task 8: Build and validate (AC: all)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all tests pass; ≥12 new assertions in `remediation.test.ts`, no regressions
  - [ ] Verify `RemediationContext`, `BuildRemediationContextParams`, `REMEDIATION_CONTEXT_KEY`, `buildRemediationContext`, `formatScenarioDiff`, `deriveFixScope`, `injectRemediationContext`, and `getRemediationContext` are importable from `@substrate-ai/factory`

## Dev Notes

### Architecture Constraints

- **File locations:**
  - `packages/factory/src/convergence/remediation.ts` — **new file**: all types (`RemediationContext`, `BuildRemediationContextParams`), constant (`REMEDIATION_CONTEXT_KEY`), and functions (`formatScenarioDiff`, `deriveFixScope`, `buildRemediationContext`, `injectRemediationContext`, `getRemediationContext`)
  - `packages/factory/src/convergence/index.ts` — **modified**: append remediation exports after the existing plateau detection section; preserve all existing exports
  - `packages/factory/src/convergence/__tests__/remediation.test.ts` — **new file**: all remediation unit tests (do NOT add to `controller.test.ts` or `plateau.test.ts`)

- **Import style:** All relative imports within `packages/factory/src/` use `.js` extensions (ESM). Cross-package imports use the bare package name.
  - `import type { ScenarioRunResult } from '../events.js'`
  - `import type { IGraphContext } from '../graph/types.js'`
  - No cross-package imports are required for this module

- **Architecture Section 6.5 — Remediation Context fields:**
  These five fields map exactly to the architecture spec. No additional fields should be added without updating the architecture document:
  - `previousFailureReason: string` — why the goal gate was not satisfied (failure reason string from the Outcome)
  - `scenarioDiff: string` — which scenarios failed and why (formatted from ScenarioRunResult)
  - `iterationCount: number` — which retry attempt this is (starts at 1 on first retry)
  - `satisfactionScoreHistory: number[]` — satisfaction scores from each previous iteration (oldest first)
  - `fixScope: string` — focused instruction for the retried agent derived from failing scenario names

- **REMEDIATION_CONTEXT_KEY constant:** Use `'convergence.remediation'` — namespaced under `convergence.` to avoid collision with user-defined context keys. Story 45-8 writes this key; CodergenBackend handlers read it via `getRemediationContext()`.

- **No side effects in pure functions:** `formatScenarioDiff()`, `deriveFixScope()`, and `buildRemediationContext()` are pure — no I/O, no event emission, no mutation of input. Only `injectRemediationContext()` has the side effect of mutating `IGraphContext`.

- **GraphContext reuse:** `IGraphContext` is already defined in `packages/factory/src/graph/types.ts` with `get()` and `set()` methods. The `injectRemediationContext()` function calls `context.set(REMEDIATION_CONTEXT_KEY, remediation)` directly — no new context interface is needed.

- **scenarioDiff stderr-first fallback:** For each failed scenario, prefer `stderr` (most useful for debugging), fall back to `stdout` (some tools write errors to stdout), then to the literal string `'(no output)'`. This fallback chain ensures the diff is always informative even when output is missing.

- **fixScope pluralization:** When exactly 1 scenario fails, use singular "scenario"; for all other counts (0, 2+), use plural "scenarios". Count 0 returns `""` as specified by AC5.

- **Optional scenarioResults:** The `scenarioResults` field in `BuildRemediationContextParams` is optional (`?`) because the first retry in a pipeline may occur before any scenario validation has run. In that case, the builder uses the fallback strings `"No scenario results available"` and `""`.

- **Defensive copy of satisfactionScoreHistory:** Spread the array `[...params.satisfactionScoreHistory]` when constructing the returned context. This prevents the caller from accidentally mutating the stored history by modifying their original array after calling the builder.

- **Story 45-8 integration context:** Story 45-8 (Convergence Controller Integration with Executor) will call `buildRemediationContext()` in the retry loop — after a goal gate fails and a retry target is resolved — then call `injectRemediationContext()` on the node's context clone before re-dispatching. `CodergenBackend` implementations will call `getRemediationContext(context)` in their `generate()` method to prepend remediation instructions to the agent prompt. This story provides the data layer only; no executor wiring is included here.

### Testing Requirements

- **Test framework:** Vitest (already configured in factory package — `packages/factory/vitest.config.ts`)
- **New test file:** `packages/factory/src/convergence/__tests__/remediation.test.ts` — do NOT add to `controller.test.ts`, `budget.test.ts`, or `plateau.test.ts`
- **Mock IGraphContext for AC6:** Use a minimal in-memory implementation:
  ```typescript
  function makeContext(): IGraphContext {
    const store = new Map<string, unknown>()
    return {
      get: (k) => store.get(k),
      set: (k, v) => { store.set(k, v) },
      getString: (k, d = '') => String(store.get(k) ?? d),
      getNumber: (k, d = 0) => Number(store.get(k) ?? d),
      getBoolean: (k, d = false) => Boolean(store.get(k) ?? d),
      applyUpdates: (u) => { for (const [k, v] of Object.entries(u)) store.set(k, v) },
      snapshot: () => Object.fromEntries(store),
      clone: () => makeContext(),
    }
  }
  ```
  No `vi.fn()` mocking needed for context — use the real-shaped stub above.
- **ScenarioRunResult test helper:** Define a `makeScenarioRunResult` helper in the test file to avoid repetitive setup:
  ```typescript
  function makeScenarioRunResult(scenarios: Array<{name: string; status: 'pass' | 'fail'; stderr?: string; stdout?: string}>): ScenarioRunResult {
    const results = scenarios.map(s => ({ ...s, exitCode: s.status === 'fail' ? 1 : 0, durationMs: 10, stderr: s.stderr ?? '', stdout: s.stdout ?? '' }))
    const failed = results.filter(s => s.status === 'fail').length
    return { scenarios: results, summary: { total: results.length, passed: results.length - failed, failed }, durationMs: 50 }
  }
  ```
- **Boundary tests required:** Include empty `scenarios: []`, mixed pass/fail, all pass, all fail — these are common miss points
- **Run during development:** `npm run test:fast` (unit-only, ~50s, no coverage)
- **Confirm pass:** Look for the "Test Files" summary line — exit code alone is insufficient
- **Never pipe output** through `head`, `tail`, or `grep` — this discards the Vitest summary
- **Target:** ≥12 new assertions in `remediation.test.ts`, all passing. No regressions in existing tests.

### Dependency Notes

- **Depends on:**
  - Story 45-2 (Retry Target Resolution Chain) — establishes `resolveRetryTarget()` which the executor calls before injecting remediation. This story provides the data for what to inject; 45-2 provides where to send the retry.
  - Story 44-5 (Scenario Runner as Graph Tool Node) — provides the `ScenarioRunResult` type shape that `formatScenarioDiff()` and `deriveFixScope()` consume. The type is imported from `events.ts` which is already stable.
- **Depended on by:** Story 45-8 (Convergence Controller Integration with Executor) — wires `buildRemediationContext()` and `injectRemediationContext()` into the graph executor's retry dispatch loop; and `getRemediationContext()` into `CodergenBackend` handler implementations.
- This story is intentionally scoped to pure remediation data construction and `IGraphContext` injection/retrieval. Executor wiring and backend prompt assembly are deferred to story 45-8.

## Interface Contracts

- **Export**: `RemediationContext` @ `packages/factory/src/convergence/remediation.ts` (consumed by story 45-8)
- **Export**: `BuildRemediationContextParams` @ `packages/factory/src/convergence/remediation.ts` (consumed by story 45-8)
- **Export**: `REMEDIATION_CONTEXT_KEY` @ `packages/factory/src/convergence/remediation.ts` (consumed by story 45-8 and CodergenBackend handlers)
- **Export**: `buildRemediationContext` @ `packages/factory/src/convergence/remediation.ts` (consumed by story 45-8)
- **Export**: `formatScenarioDiff` @ `packages/factory/src/convergence/remediation.ts` (consumed by story 45-8, testable independently)
- **Export**: `deriveFixScope` @ `packages/factory/src/convergence/remediation.ts` (consumed by story 45-8, testable independently)
- **Export**: `injectRemediationContext` @ `packages/factory/src/convergence/remediation.ts` (consumed by story 45-8 executor retry loop)
- **Export**: `getRemediationContext` @ `packages/factory/src/convergence/remediation.ts` (consumed by story 45-8 CodergenBackend handlers)
- **Import**: `ScenarioRunResult` @ `packages/factory/src/events.ts` (from story 44-1/44-2)
- **Import**: `IGraphContext` @ `packages/factory/src/graph/types.ts` (from story 42-8)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-23: Story created for Epic 45, Phase B — Convergence Loop
