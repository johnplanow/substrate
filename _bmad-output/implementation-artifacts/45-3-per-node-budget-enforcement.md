# Story 45-3: Per-Node Budget Enforcement — max_retries with Backoff

## Story

As a graph executor,
I want per-node retry budget enforcement with exponential backoff and jitter,
so that nodes with transient failures are retried up to their configured limit with progressively longer delays, and nodes with `allow_partial=true` accept partial success when their retry budget is exhausted.

## Acceptance Criteria

### AC1: Budget Allows Retries Within Limit
**Given** a node configured with `max_retries=2`
**When** `checkNodeBudget(nodeId, 0, 2)` and `checkNodeBudget(nodeId, 1, 2)` are called
**Then** both return `{ allowed: true }` — retryCount 0 and 1 are each below the limit of 2

### AC2: Budget Rejects Retries When Exhausted
**Given** a node configured with `max_retries=2`
**When** `checkNodeBudget(nodeId, 2, 2)` is called (retryCount equals maxRetries)
**Then** it returns `{ allowed: false, reason: 'max retries exhausted' }` — no further attempts are permitted

### AC3: max_retries=0 Means Immediate Failure (No Retries)
**Given** a node configured with `max_retries=0`
**When** `checkNodeBudget(nodeId, 0, 0)` is called
**Then** it returns `{ allowed: false, reason: 'max retries exhausted' }` — the node cannot be retried at all

### AC4: Exponential Backoff With 60s Cap
**Given** `computeBackoffDelay` is called with `attemptIndex` 0, 1, 2, 8, and 9
**When** jitter is controlled (jitterFactor=0 in options)
**Then** the base delays are 200ms, 400ms, 800ms for indices 0–2; delays are capped at 60000ms for high indices; the formula is `min(200 * 2^attemptIndex, 60000)` before jitter

### AC5: Jitter Applied Within ±50% of Capped Delay
**Given** `computeBackoffDelay(2)` is called (base capped delay = 800ms) with default jitter settings
**When** called 100 times
**Then** every returned value falls within `[400, 1200]` (i.e., within ±50% of 800ms) and the distribution is not constant — jitter is non-zero

### AC6: allow_partial=true Accepts PARTIAL_SUCCESS on Exhaustion
**Given** a node's retry budget is exhausted
**When** `resolveExhaustedOutcome('PARTIAL_SUCCESS', true)` is called
**Then** it returns `'PARTIAL_SUCCESS'` — partial success is accepted rather than demoted to failure
**And** `resolveExhaustedOutcome('PARTIAL_SUCCESS', false)` returns `'FAILURE'` — without the flag the status is demoted
**And** `resolveExhaustedOutcome('FAILURE', true)` returns `'FAILURE'` — only PARTIAL_SUCCESS benefits from the flag

### AC7: NodeBudgetManager Tracks Per-Node Retry Counts Independently
**Given** a `NodeBudgetManager` instance with two nodes `node-a` and `node-b`
**When** `incrementRetry('node-a')` is called twice and `incrementRetry('node-b')` is called once
**Then** `getRetryCount('node-a')` returns 2 and `getRetryCount('node-b')` returns 1 — counts are isolated per node

## Tasks / Subtasks

- [ ] Task 1: Define types in `packages/factory/src/convergence/budget.ts` (AC: #1, #2, #3, #6)
  - [ ] Define `BudgetCheckResult` discriminated union: `{ allowed: true } | { allowed: false; reason: string }`
  - [ ] Define `BackoffOptions` interface: `{ initialDelay?: number; factor?: number; maxDelay?: number; jitterFactor?: number }` with defaults 200ms / 2 / 60000ms / 0.5
  - [ ] Add JSDoc on each type explaining its role in the convergence loop

- [ ] Task 2: Implement `checkNodeBudget()` and `resolveExhaustedOutcome()` (AC: #1, #2, #3, #6)
  - [ ] Export `checkNodeBudget(nodeId: string, retryCount: number, maxRetries: number): BudgetCheckResult`
    - Returns `{ allowed: true }` when `retryCount < maxRetries`
    - Returns `{ allowed: false, reason: 'max retries exhausted' }` when `retryCount >= maxRetries`
  - [ ] Export `resolveExhaustedOutcome(status: OutcomeStatus, allowPartial: boolean): OutcomeStatus`
    - Returns `status` unchanged when `allowPartial=true` and `status === 'PARTIAL_SUCCESS'`
    - Returns `'FAILURE'` in all other exhaustion cases
  - [ ] Import `OutcomeStatus` from `'../graph/types.js'`

- [ ] Task 3: Implement `computeBackoffDelay()` with exponential formula and jitter (AC: #4, #5)
  - [ ] Export `computeBackoffDelay(attemptIndex: number, options?: BackoffOptions): number`
  - [ ] Apply the formula: `baseDelay = initialDelay * factor^attemptIndex`
  - [ ] Cap at `maxDelay`: `cappedDelay = Math.min(baseDelay, maxDelay)`
  - [ ] Apply jitter: `jitter = (Math.random() * 2 - 1) * jitterFactor * cappedDelay` (uniform ±jitterFactor fraction)
  - [ ] Return `Math.max(0, Math.round(cappedDelay + jitter))` to prevent negative delays
  - [ ] Default options: `{ initialDelay: 200, factor: 2, maxDelay: 60000, jitterFactor: 0.5 }`

- [ ] Task 4: Implement `NodeBudgetManager` class (AC: #7)
  - [ ] Export `NodeBudgetManager` class with internal `Map<string, number>` for retry counts
  - [ ] `incrementRetry(nodeId: string): void` — increments count for the given node (starts from 0)
  - [ ] `getRetryCount(nodeId: string): number` — returns current retry count, or 0 if unseen
  - [ ] `canRetry(nodeId: string, maxRetries: number): BudgetCheckResult` — delegates to `checkNodeBudget` with the stored count
  - [ ] `reset(nodeId: string): void` — resets a node's count (for test isolation and future pipeline reuse)

- [ ] Task 5: Add barrel exports to `packages/factory/src/convergence/index.ts` (AC: #1–#7)
  - [ ] Append exports to existing `packages/factory/src/convergence/index.ts`:
    - `export type { BudgetCheckResult, BackoffOptions } from './budget.js'`
    - `export { checkNodeBudget, computeBackoffDelay, resolveExhaustedOutcome, NodeBudgetManager } from './budget.js'`
  - [ ] Do NOT remove existing `ConvergenceController` exports from the file

- [ ] Task 6: Add public re-exports to `packages/factory/src/index.ts` (AC: all)
  - [ ] Verify `packages/factory/src/index.ts` already re-exports `'./convergence/index.js'` — if so, no change needed
  - [ ] If not present, add `export * from './convergence/index.js'`
  - [ ] Check for name collisions with existing exports — `BudgetCheckResult`, `BackoffOptions`, `NodeBudgetManager` are new names

- [ ] Task 7: Write unit tests in `packages/factory/src/convergence/__tests__/budget.test.ts` (AC: #1–#7)
  - [ ] Test AC1: `checkNodeBudget(id, 0, 2)` → `{ allowed: true }`; `checkNodeBudget(id, 1, 2)` → `{ allowed: true }`
  - [ ] Test AC2: `checkNodeBudget(id, 2, 2)` → `{ allowed: false, reason: 'max retries exhausted' }`
  - [ ] Test AC3: `checkNodeBudget(id, 0, 0)` → `{ allowed: false, reason: 'max retries exhausted' }`
  - [ ] Test AC4: `computeBackoffDelay(0, { jitterFactor: 0 })` = 200; delay for index 1 = 400; index 2 = 800; very high index capped at 60000
  - [ ] Test AC5: Call `computeBackoffDelay(2)` (base 800ms) 100 times — all values in `[400, 1200]` and not all equal
  - [ ] Test AC6: `resolveExhaustedOutcome('PARTIAL_SUCCESS', true)` = `'PARTIAL_SUCCESS'`; `('PARTIAL_SUCCESS', false)` = `'FAILURE'`; `('FAILURE', true)` = `'FAILURE'`
  - [ ] Test AC7: `NodeBudgetManager` increments counts independently per nodeId; `canRetry` delegates correctly
  - [ ] Test: `NodeBudgetManager.reset()` clears a node's count back to 0

- [ ] Task 8: Build and validate (AC: all)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all tests pass, ≥8 tests in `budget.test.ts`, no regressions
  - [ ] Verify `checkNodeBudget`, `computeBackoffDelay`, `resolveExhaustedOutcome`, `NodeBudgetManager`, `BudgetCheckResult`, `BackoffOptions` are all importable from `@substrate-ai/factory`

## Dev Notes

### Architecture Constraints

- **File locations:**
  - `packages/factory/src/convergence/budget.ts` — **new file**: all types, functions, and `NodeBudgetManager` class
  - `packages/factory/src/convergence/index.ts` — **modified**: append budget exports (preserve existing ConvergenceController exports)
  - `packages/factory/src/convergence/__tests__/budget.test.ts` — **new file**: unit tests
  - `packages/factory/src/index.ts` — **conditionally modified**: add convergence re-export if not already present

- **Import style:** All relative imports within `packages/factory/src/` use `.js` extensions (ESM), e.g., `import type { OutcomeStatus } from '../graph/types.js'`. Cross-package imports use the package name.

- **OutcomeStatus type location:** `OutcomeStatus` is defined in `packages/factory/src/graph/types.ts` as:
  ```
  'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE' | 'NEEDS_RETRY' | 'ESCALATE'
  ```
  Import it with `import type { OutcomeStatus } from '../graph/types.js'`

- **No side effects in budget.ts:** The module must be pure functions + class — no global state, no I/O, no event bus calls. The executor integrates budget enforcement in story 45-8.

- **Jitter formula:** Use `(Math.random() * 2 - 1) * jitterFactor * cappedDelay` for symmetric ±jitterFactor jitter. The `jitterFactor=0.5` default produces ±50% variance. Return `Math.max(0, Math.round(cappedDelay + jitter))` to ensure non-negative integer milliseconds.

- **Budget check semantics:** `retryCount` represents the number of retries already attempted (0 on first failure). `maxRetries` is the node's configured maximum. The check `retryCount < maxRetries` means: "has this node used fewer retries than allowed?" This aligns with `GraphNode.maxRetries` from `packages/factory/src/graph/types.ts`.

- **allow_partial integration context:** The `resolveExhaustedOutcome` function is a pure helper for story 45-8's executor integration. It does NOT modify the GraphContext or emit events — it simply maps an outcome status given the node's `allowPartial` flag.

- **NodeBudgetManager initialization:** The manager starts with an empty map. `getRetryCount` on an unseen node returns 0 (never throws). `incrementRetry` on an unseen node creates the entry starting at 1.

### Testing Requirements

- **Test framework:** Vitest (already configured in factory package — `packages/factory/vitest.config.ts`)
- **No temp files needed:** All functions are pure/in-memory — no filesystem or async operations
- **Backoff determinism for AC4:** Pass `{ jitterFactor: 0 }` to `computeBackoffDelay` to disable jitter and get exact expected values
- **Jitter distribution for AC5:** Run 100 iterations with default options; assert all results are within `[400, 1200]` and that `new Set(results).size > 1` (values vary)
- **Run during development:** `npm run test:fast` (unit-only, ~50s, no coverage)
- **Confirm pass:** Look for the "Test Files" summary line in output — exit code alone is insufficient
- **Never pipe output** through `head`, `tail`, or `grep` — this discards the Vitest summary
- **Target:** ≥ 8 tests in `budget.test.ts`, all passing. No regressions in existing tests.

### Dependency Notes

- **Depends on:** Story 42-14 (graph executor core loop — provides `OutcomeStatus` and `GraphNode` types including `maxRetries` and `allowPartial` fields)
- **Depended on by:** Story 45-4 (per-pipeline budget enforcement builds on the budget primitives), Story 45-8 (convergence controller integration wires `NodeBudgetManager` into the executor)
- This story is intentionally scoped to the pure budget module only. The executor integration (wiring `NodeBudgetManager` into the graph executor's node dispatch loop) is deferred to story 45-8.

## Interface Contracts

- **Export**: `BudgetCheckResult` @ `packages/factory/src/convergence/budget.ts` (consumed by stories 45-4, 45-8)
- **Export**: `BackoffOptions` @ `packages/factory/src/convergence/budget.ts` (consumed by story 45-8)
- **Export**: `checkNodeBudget` @ `packages/factory/src/convergence/budget.ts` (consumed by stories 45-4, 45-8)
- **Export**: `computeBackoffDelay` @ `packages/factory/src/convergence/budget.ts` (consumed by story 45-8)
- **Export**: `resolveExhaustedOutcome` @ `packages/factory/src/convergence/budget.ts` (consumed by story 45-8)
- **Export**: `NodeBudgetManager` @ `packages/factory/src/convergence/budget.ts` (consumed by story 45-8)
- **Import**: `OutcomeStatus` @ `packages/factory/src/graph/types.ts` (from story 42-8)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-23: Story created for Epic 45, Phase B — Convergence Loop
