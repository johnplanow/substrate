# Story 45-5: Per-Session Budget Enforcement (wall_clock_cap)

## Story

As a graph executor,
I want per-session wall-clock budget enforcement with a configurable cap in seconds,
so that a pipeline run halts before dispatching further nodes when elapsed time exceeds the `wall_clock_cap_seconds` limit, enforcing the highest-priority budget constraint in the convergence loop.

## Acceptance Criteria

### AC1: Session Budget Check Blocks When Elapsed Time Exceeds Cap
**Given** `wall_clock_cap_seconds=3600` configured (cap of 3600000ms)
**When** `checkSessionBudget(3601000, 3600000)` is called (3601 seconds elapsed)
**Then** it returns `{ allowed: false, reason: 'wall clock budget exhausted' }`

### AC2: Session Budget Check Allows When Cap Is 0 (Unlimited)
**Given** `wall_clock_cap_seconds=0` (unlimited)
**When** `checkSessionBudget(999999999, 0)` is called with any positive elapsed time
**Then** it returns `{ allowed: true }` — a cap of 0 disables all wall-clock enforcement

### AC3: Session Budget Check Allows When Elapsed Time Is Within Cap
**Given** `wall_clock_cap_seconds=3600` (cap of 3600000ms) and 1800 seconds (1800000ms) have elapsed
**When** `checkSessionBudget(1800000, 3600000)` is called
**Then** it returns `{ allowed: true }`

### AC4: Session Budget Check Allows When Elapsed Exactly Equals Cap
**Given** elapsed time equals the cap exactly (e.g., both 3600000ms)
**When** `checkSessionBudget(3600000, 3600000)` is called
**Then** it returns `{ allowed: true }` — only strictly exceeding the cap triggers enforcement

### AC5: SessionBudgetManager Tracks Elapsed Time From Construction
**Given** a `SessionBudgetManager` instance constructed at time T
**When** `getElapsedMs()` is called
**Then** it returns a non-negative number representing milliseconds elapsed since construction, and the value is monotonically non-decreasing across successive calls

### AC6: SessionBudgetManager.checkBudget Converts Seconds Cap to Milliseconds
**Given** a `SessionBudgetManager` and a cap of `3600` seconds
**When** `checkBudget(3600)` is called
**Then** it delegates to `checkSessionBudget(this.getElapsedMs(), 3600 * 1000)` — a cap of `0` passes `0` (unlimited) and returns `{ allowed: true }`

### AC7: SessionBudgetManager.reset Restarts the Elapsed Timer
**Given** a `SessionBudgetManager` that has been running for some time
**When** `reset()` is called and `getElapsedMs()` is called immediately after
**Then** the returned elapsed time is near zero (< 50ms) — the session start timestamp has been reset to the current time

## Tasks / Subtasks

- [ ] Task 1: Add `checkSessionBudget()` pure function to `packages/factory/src/convergence/budget.ts` (AC: #1, #2, #3, #4)
  - [ ] Implement `cap === 0` fast path — return `{ allowed: true }` immediately (unlimited mode)
  - [ ] Implement strict-greater-than check: `elapsedMs > capMs` → return `{ allowed: false, reason: 'wall clock budget exhausted' }`
  - [ ] Return `{ allowed: true }` when `elapsedMs <= capMs` and `cap > 0`
  - [ ] Add JSDoc explaining the unlimited behaviour (`cap=0`), the strict `>` boundary, and that both arguments are in milliseconds
  - [ ] Append after the existing per-pipeline section — do NOT modify existing code

- [ ] Task 2: Add `SessionBudgetManager` class to `packages/factory/src/convergence/budget.ts` (AC: #5, #6, #7)
  - [ ] Internal `private startTime: number` field set to `Date.now()` in the constructor (no constructor parameters)
  - [ ] `getElapsedMs(): number` — returns `Date.now() - this.startTime`
  - [ ] `reset(): void` — resets `this.startTime` to `Date.now()`
  - [ ] `checkBudget(capSeconds: number): BudgetCheckResult` — delegates to `checkSessionBudget(this.getElapsedMs(), capSeconds * 1000)`
  - [ ] Add JSDoc on class explaining lifecycle (one instance per pipeline run; `reset()` for test isolation; `capSeconds=0` means unlimited)
  - [ ] Add JSDoc on each method

- [ ] Task 3: Export new symbols from `packages/factory/src/convergence/index.ts` (AC: #1–#7)
  - [ ] Append exports for `checkSessionBudget` and `SessionBudgetManager` from `'./budget.js'`
  - [ ] Group them with a `// Per-session budget enforcement — story 45-5` comment
  - [ ] Preserve all existing exports without modification

- [ ] Task 4: Write unit tests in `packages/factory/src/convergence/__tests__/budget.test.ts` (AC: #1–#7)
  - [ ] Add a `describe('checkSessionBudget', ...)` block:
    - AC1: `checkSessionBudget(3601000, 3600000)` → `{ allowed: false, reason: 'wall clock budget exhausted' }`
    - AC2: `checkSessionBudget(999999999, 0)` → `{ allowed: true }` (unlimited)
    - AC3: `checkSessionBudget(1800000, 3600000)` → `{ allowed: true }` (within cap)
    - AC4: `checkSessionBudget(3600000, 3600000)` → `{ allowed: true }` (boundary: equal is allowed)
    - Additional: `checkSessionBudget(1, 0)` → `{ allowed: true }` (any elapsed + cap=0 → unlimited)
  - [ ] Add a `describe('SessionBudgetManager', ...)` block:
    - AC5: `new SessionBudgetManager(); const e = mgr.getElapsedMs()` → `e >= 0` and a second call returns `>= e`
    - AC6: construct manager, call `checkBudget(0)` → `{ allowed: true }` (cap=0 unlimited); construct second manager, allow time to pass, call `checkBudget(3600)` → `{ allowed: true }` (well within cap)
    - AC7: after some elapsed time, `reset()` → `getElapsedMs() < 50` (< 50ms from reset to read)
    - Additional: `checkBudget` with cap in seconds triggers budget check in ms domain (mock `getElapsedMs` returning 3601000ms against 3600s cap → `{ allowed: false }`)

- [ ] Task 5: Build and validate (AC: all)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all tests pass; ≥8 new assertions in `budget.test.ts`, no regressions
  - [ ] Verify `checkSessionBudget` and `SessionBudgetManager` are importable from `@substrate-ai/factory`

## Dev Notes

### Architecture Constraints

- **File locations:**
  - `packages/factory/src/convergence/budget.ts` — **modified**: append `checkSessionBudget` function and `SessionBudgetManager` class after the existing per-pipeline section (do NOT create a new file)
  - `packages/factory/src/convergence/index.ts` — **modified**: append session budget exports, preserve all existing exports
  - `packages/factory/src/convergence/__tests__/budget.test.ts` — **modified**: append session budget test cases to the existing file

- **Import style:** All relative imports within `packages/factory/src/` use `.js` extensions (ESM). `checkSessionBudget` and `SessionBudgetManager` use only `BudgetCheckResult`, which is already defined in the same `budget.ts` file — no new imports required.

- **No new files:** Story 45-5 extends the existing `budget.ts` module — do NOT create a separate file.

- **No side effects in budget.ts:** The module must remain pure functions + classes — no global state, no I/O, no event bus calls. The executor integration (wiring `SessionBudgetManager` into the dispatch loop and emitting `convergence:budget-exhausted`) is deferred to story 45-8.

- **Strict greater-than boundary:** `elapsedMs > capMs` triggers enforcement. `elapsedMs === capMs` is allowed. This matches the same semantics as `checkPipelineBudget` (story 45-4): "halts *before* dispatching further nodes when elapsed time **exceeds** the cap."

- **Cap 0 means unlimited:** `wall_clock_cap_seconds` defaults to `0` in `FactoryConfigSchema` (`packages/factory/src/config.ts`). `checkSessionBudget` must short-circuit immediately when `capMs === 0` to avoid false positives.

- **Argument units:** `checkSessionBudget` takes both arguments in **milliseconds** (ms). `SessionBudgetManager.checkBudget(capSeconds)` takes the cap in **seconds** (as stored in `FactoryConfig`) and converts to ms internally via `capSeconds * 1000`. This conversion is the responsibility of the manager, not the pure function.

- **Budget priority (architectural constraint for story 45-8):** Session wall-clock is the highest-priority budget check. Story 45-8 must check `SessionBudgetManager.checkBudget()` first, before `PipelineBudgetManager.checkBudget()`, before `NodeBudgetManager.canRetry()`. The first exhausted budget halts the pipeline immediately.

- **SessionBudgetManager lifecycle:** One instance per pipeline run, constructed at pipeline launch. Story 45-8 will call `checkBudget()` before each node dispatch. `reset()` is provided for test isolation and future pipeline reuse.

- **FactoryConfig field reference:** `wall_clock_cap_seconds` is already present in `FactoryConfigSchema` with `default(0)`. Story 45-5 provides the enforcement primitive; story 45-8 reads the config value and passes it to `checkBudget()`.

- **Testability of `getElapsedMs`:** Avoid `vi.useFakeTimers` complexity in the `checkBudget` delegation test — instead, verify the delegation by subclassing or using a spy on `getElapsedMs`. Alternatively, assert the logical behavior directly: if `getElapsedMs()` > `cap * 1000`, `checkBudget(cap)` must return `{ allowed: false }`. Keep tests simple and deterministic.

### Testing Requirements

- **Test framework:** Vitest (already configured — `packages/factory/vitest.config.ts`)
- **No temp files needed:** All functions are pure/in-memory — no filesystem or async operations required for the pure function tests
- **Boundary cases required:** Include exact-equality (AC4) and cap=0 unlimited case (AC2) — these are common miss points
- **Determinism for `SessionBudgetManager` tests:** Avoid flaky timing-sensitive assertions. For AC7 (reset), use a threshold of `< 50ms` which is safe for any test environment. For AC5, just assert `>= 0` and that two successive calls are non-decreasing.
- **Run during development:** `npm run test:fast` (unit-only, ~50s, no coverage)
- **Confirm pass:** Look for the "Test Files" summary line in output — exit code alone is insufficient
- **Never pipe output** through `head`, `tail`, or `grep` — this discards the Vitest summary
- **Target:** ≥ 8 new assertions in `budget.test.ts`, all passing. No regressions in existing tests.

### Dependency Notes

- **Depends on:** Story 45-4 (per-pipeline budget enforcement — provides the base `budget.ts` structure and `BudgetCheckResult` type that this story extends)
- **Depended on by:** Story 45-8 (convergence controller integration — wires `SessionBudgetManager` into the executor dispatch loop as the highest-priority budget check)
- This story is intentionally scoped to pure budget primitives only. The executor integration and event emission are deferred to story 45-8.

## Interface Contracts

- **Export**: `checkSessionBudget` @ `packages/factory/src/convergence/budget.ts` (consumed by story 45-8)
- **Export**: `SessionBudgetManager` @ `packages/factory/src/convergence/budget.ts` (consumed by story 45-8)
- **Import**: `BudgetCheckResult` @ `packages/factory/src/convergence/budget.ts` (from story 45-3)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-23: Story created for Epic 45, Phase B — Convergence Loop
