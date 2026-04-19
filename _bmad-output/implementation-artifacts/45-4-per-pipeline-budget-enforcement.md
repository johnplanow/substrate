# Story 45-4: Per-Pipeline Budget Enforcement (budget_cap_usd)

## Story

As a graph executor,
I want per-pipeline cost budget enforcement with a configurable cap,
so that a pipeline run halts before dispatching further nodes when accumulated cost exceeds the `budget_cap_usd` limit, preventing runaway spend during a convergence loop.

## Acceptance Criteria

### AC1: Budget Check Blocks When Accumulated Cost Exceeds Cap
**Given** `budget_cap_usd=5.00` is configured and accumulated cost is $5.01
**When** `checkPipelineBudget(5.01, 5.00)` is called
**Then** it returns `{ allowed: false, reason: 'pipeline budget exhausted: $5.01 > $5.00' }`

### AC2: Budget Check Allows When Cap Is 0 (Unlimited)
**Given** `budget_cap_usd=0` (unlimited)
**When** `checkPipelineBudget(9999.99, 0)` is called
**Then** it returns `{ allowed: true }` — a cap of 0 disables all cost enforcement

### AC3: Budget Check Allows When Cost Is Within Cap
**Given** `budget_cap_usd=10.00` and accumulated cost is $5.00
**When** `checkPipelineBudget(5.00, 10.00)` is called
**Then** it returns `{ allowed: true }`

### AC4: Budget Check Allows When Cost Exactly Equals Cap
**Given** accumulated cost equals the cap exactly
**When** `checkPipelineBudget(5.00, 5.00)` is called
**Then** it returns `{ allowed: true }` — only strictly exceeding the cap triggers enforcement

### AC5: Reason String Formats Costs to Two Decimal Places
**Given** accumulated cost $5.006 exceeds cap $5.00
**When** `checkPipelineBudget(5.006, 5.00)` is called
**Then** the reason reads `'pipeline budget exhausted: $5.01 > $5.00'` — both values formatted with `toFixed(2)`

### AC6: PipelineBudgetManager Accumulates Cost Across Multiple Additions
**Given** a fresh `PipelineBudgetManager` instance
**When** `addCost(1.50)` and `addCost(2.00)` are called sequentially
**Then** `getTotalCost()` returns `3.50`

### AC7: PipelineBudgetManager Reset Clears Accumulated Cost
**Given** a `PipelineBudgetManager` with accumulated cost greater than zero
**When** `reset()` is called
**Then** `getTotalCost()` returns `0`

## Tasks / Subtasks

- [ ] Task 1: Add `checkPipelineBudget()` pure function to `packages/factory/src/convergence/budget.ts` (AC: #1, #2, #3, #4, #5)
  - [ ] Implement `cap === 0` fast path — return `{ allowed: true }` immediately (unlimited mode)
  - [ ] Implement strict-greater-than check: `accumulatedCost > cap` → return `{ allowed: false, reason: 'pipeline budget exhausted: $X.XX > $Y.YY' }`
  - [ ] Format both values with `.toFixed(2)` in the reason string
  - [ ] Return `{ allowed: true }` when `accumulatedCost <= cap` and `cap > 0`
  - [ ] Add JSDoc explaining the unlimited behaviour (`cap=0`) and the strict `>` boundary

- [ ] Task 2: Add `PipelineBudgetManager` class to `packages/factory/src/convergence/budget.ts` (AC: #6, #7)
  - [ ] Internal `private totalCost = 0` field
  - [ ] `addCost(amount: number): void` — adds to the running total
  - [ ] `getTotalCost(): number` — returns the current total
  - [ ] `reset(): void` — resets the total to 0
  - [ ] `checkBudget(cap: number): BudgetCheckResult` — delegates to `checkPipelineBudget(this.totalCost, cap)`
  - [ ] Add JSDoc on class and each method explaining lifecycle (one instance per pipeline run; reset between runs)

- [ ] Task 3: Export new symbols from `packages/factory/src/convergence/index.ts` (AC: #1–#7)
  - [ ] Append exports for `checkPipelineBudget` and `PipelineBudgetManager` from `'./budget.js'`
  - [ ] Group them with a `// Per-pipeline budget enforcement — story 45-4` comment
  - [ ] Preserve all existing exports without modification

- [ ] Task 4: Write unit tests in `packages/factory/src/convergence/__tests__/budget.test.ts` (AC: #1–#7)
  - [ ] Add a `describe('checkPipelineBudget', ...)` block:
    - AC1: cost $5.01 with cap $5.00 → `{ allowed: false, reason: 'pipeline budget exhausted: $5.01 > $5.00' }`
    - AC2: cost $9999.99 with cap $0 → `{ allowed: true }`
    - AC3: cost $5.00 with cap $10.00 → `{ allowed: true }`
    - AC4: cost $5.00 with cap $5.00 → `{ allowed: true }` (boundary: equal is allowed)
    - AC5: cost $5.006 with cap $5.00 → reason string contains `'$5.01'` and `'$5.00'`
  - [ ] Add a `describe('PipelineBudgetManager', ...)` block:
    - AC6: `addCost(1.50)` + `addCost(2.00)` → `getTotalCost()` returns `3.50`
    - AC7: after `addCost(10)`, `reset()` → `getTotalCost()` returns `0`
    - `checkBudget()`: verify it delegates to `checkPipelineBudget` (cap exceeded → `allowed: false`; cap 0 → `allowed: true`)

- [ ] Task 5: Build and validate (AC: all)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all tests pass; ≥8 new assertions in `budget.test.ts`, no regressions
  - [ ] Verify `checkPipelineBudget` and `PipelineBudgetManager` are importable from `@substrate-ai/factory`

## Dev Notes

### Architecture Constraints

- **File locations:**
  - `packages/factory/src/convergence/budget.ts` — **modified**: append `checkPipelineBudget` function and `PipelineBudgetManager` class after the existing per-node section (do NOT create a new file)
  - `packages/factory/src/convergence/index.ts` — **modified**: append pipeline budget exports, preserve existing exports
  - `packages/factory/src/convergence/__tests__/budget.test.ts` — **modified**: append pipeline budget test cases to the existing file

- **Import style:** All relative imports within `packages/factory/src/` use `.js` extensions (ESM). `checkPipelineBudget` and `PipelineBudgetManager` use only `BudgetCheckResult`, which is already defined in the same `budget.ts` file — no new imports required.

- **No new files:** Story 45-4 extends the existing `budget.ts` module — do NOT create a separate file.

- **No side effects in budget.ts:** The module must remain pure functions + classes — no global state, no I/O, no event bus calls. The executor integration (wiring `PipelineBudgetManager` into the dispatch loop and emitting `convergence:budget-exhausted`) is deferred to story 45-8.

- **Strict greater-than boundary:** `accumulatedCost > cap` triggers enforcement. `accumulatedCost === cap` is allowed. This matches the PRD: "halts *before* dispatching further nodes when accumulated cost **exceeds** the cap."

- **Cap 0 means unlimited:** `budget_cap_usd` defaults to `0` in `FactoryConfigSchema` (`packages/factory/src/config.ts`). `checkPipelineBudget` must short-circuit immediately when `cap === 0` to avoid false positives for any positive accumulated cost.

- **Reason string format:** `'pipeline budget exhausted: $X.XX > $Y.YY'` where both values use `.toFixed(2)`. This handles rounding at the display level (e.g., `$5.006 → $5.01`).

- **PipelineBudgetManager lifecycle:** One instance per pipeline run. Story 45-8 will call `addCost()` after each node dispatch completes and `checkBudget()` before the next dispatch. `reset()` is provided for test isolation and future pipeline reuse.

- **FactoryConfig field reference:** `budget_cap_usd` is already present in `FactoryConfigSchema` with `default(0)`. Story 45-4 provides the enforcement primitive; story 45-8 reads the config value and passes it to `checkBudget()`.

### Testing Requirements

- **Test framework:** Vitest (already configured — `packages/factory/vitest.config.ts`)
- **No temp files needed:** All functions are pure/in-memory — no filesystem or async operations
- **Boundary cases required:** Include exact-equality (AC4) and rounding (AC5) — these are common miss points
- **Run during development:** `npm run test:fast` (unit-only, ~50s, no coverage)
- **Confirm pass:** Look for the "Test Files" summary line in output — exit code alone is insufficient
- **Never pipe output** through `head`, `tail`, or `grep` — this discards the Vitest summary
- **Target:** ≥ 8 new assertions in `budget.test.ts`, all passing. No regressions in existing tests.

### Dependency Notes

- **Depends on:** Story 45-3 (per-node budget enforcement — provides `BudgetCheckResult` type and the base `budget.ts` file that this story extends)
- **Depended on by:** Story 45-5 (per-session wall-clock enforcement — extends `budget.ts` with session-level cap) and Story 45-8 (convergence controller integration — wires `PipelineBudgetManager` into the executor dispatch loop and emits `convergence:budget-exhausted`)
- This story is intentionally scoped to pure budget primitives only. The executor integration and event emission are deferred to story 45-8.

## Interface Contracts

- **Export**: `checkPipelineBudget` @ `packages/factory/src/convergence/budget.ts` (consumed by story 45-8)
- **Export**: `PipelineBudgetManager` @ `packages/factory/src/convergence/budget.ts` (consumed by story 45-8)
- **Import**: `BudgetCheckResult` @ `packages/factory/src/convergence/budget.ts` (from story 45-3)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-23: Story created for Epic 45, Phase B — Convergence Loop
