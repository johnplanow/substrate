# Story 33-1: ValidationHarness Interface + Cascade Runner

## Story

As a pipeline operator,
I want a structured, ordered validation cascade that can run pluggable validation levels against a story's outputs,
so that the orchestrator has a deterministic, extensible framework to validate agent results and short-circuit on first failure.

## Acceptance Criteria

### AC1: ValidationHarness Interface
**Given** the validation module exists at `src/modules/validation/`
**When** a consumer imports `ValidationHarness`
**Then** the interface exposes `runCascade(story: StoryRecord, result: unknown, attempt: number): Promise<ValidationResult>`

### AC2: ValidationResult Type
**Given** a cascade run completes (pass or fail)
**When** `runCascade` resolves
**Then** the returned `ValidationResult` includes: `passed: boolean`, `highestLevelReached: number`, `failures: LevelFailure[]`, `canAutoRemediate: boolean`, and `remediationContext: RemediationContext | null`

### AC3: Cascade Short-Circuits on First Failure
**Given** multiple validation levels are registered
**When** a level fails
**Then** cascade execution stops immediately and returns a `ValidationResult` with `passed: false` — levels after the failing level are not executed

### AC4: ValidationLevel Interface
**Given** the types module
**When** a consumer implements `ValidationLevel`
**Then** the interface requires `level: number`, `name: string`, and `run(context: ValidationContext): Promise<LevelResult>` — where `LevelResult` has `passed: boolean`, `failures: LevelFailure[]`, and `canAutoRemediate: boolean`

### AC5: Plugin-Style Level Registration
**Given** a `CascadeRunner` instance
**When** levels are registered via `registerLevel(level: ValidationLevel)`
**Then** the runner stores and executes them in ascending `level` order — no level implementations are hardcoded into the runner

### AC6: maxLevel Configuration
**Given** `CascadeRunnerConfig` includes `maxLevel?: number`
**When** `maxLevel` is set (e.g., `maxLevel: 1`)
**Then** the cascade only executes levels whose `level` number is ≤ `maxLevel`, allowing fast-feedback runs (Levels 0-1 only) vs full validation (Levels 0-3)

### AC7: Per-Level Timing and Debug Logging
**Given** a level executes
**When** it completes (pass or fail)
**Then** the runner logs at debug level: level number, level name, result (pass/fail), and elapsed milliseconds — using the project's `createLogger` utility

### AC8: Unit Tests for Cascade Behavior
**Given** the cascade runner is implemented
**When** the test suite runs
**Then** tests cover: all levels pass, first-level failure short-circuits, mid-cascade failure short-circuits, maxLevel truncates levels, level ordering is ascending regardless of registration order, and canAutoRemediate reflects the failing level's value

## Tasks / Subtasks

- [ ] Task 1: Define core types in `src/modules/validation/types.ts` (AC: #1, #2, #4)
  - [ ] Define `ValidationLevel` interface: `level: number`, `name: string`, `run(context: ValidationContext): Promise<LevelResult>`
  - [ ] Define `LevelResult`: `passed: boolean`, `failures: LevelFailure[]`, `canAutoRemediate: boolean`
  - [ ] Define `LevelFailure`: `category: 'schema' | 'build' | 'test' | 'invariant'`, `description: string`, `location?: string`, `evidence: string`, `suggestedAction?: string`
  - [ ] Define `ValidationContext`: `story: StoryRecord`, `result: unknown`, `attempt: number`, `projectRoot: string`
  - [ ] Define `ValidationResult`: `passed: boolean`, `highestLevelReached: number`, `failures: LevelFailure[]`, `canAutoRemediate: boolean`, `remediationContext: RemediationContext | null`
  - [ ] Define `RemediationContext`: `level: number`, `failures: LevelFailure[]`, `retryBudget: { spent: number; remaining: number }`, `scope: 'surgical' | 'partial' | 'full'`, `canAutoRemediate: boolean`
  - [ ] Define `CascadeRunnerConfig`: `maxLevel?: number`, `projectRoot: string`

- [ ] Task 2: Implement `ValidationHarness` interface and `CascadeRunner` class in `src/modules/validation/harness.ts` (AC: #1, #3, #5, #6, #7)
  - [ ] Declare `ValidationHarness` interface with `runCascade` signature
  - [ ] Implement `CascadeRunner` class with `registerLevel(level: ValidationLevel): void`
  - [ ] In `runCascade`: sort registered levels by `level` ascending, filter by `maxLevel`, execute each in order, short-circuit on first failure
  - [ ] Wrap each level execution in a try/catch — unhandled exceptions produce a `LevelFailure` with the error message as evidence
  - [ ] Record `Date.now()` before and after each level call; log at debug via `createLogger('validation:cascade')`
  - [ ] Build and return `ValidationResult` from the collected level results

- [ ] Task 3: Create public exports in `src/modules/validation/index.ts` (AC: #1, #4)
  - [ ] Re-export all types from `types.ts`
  - [ ] Re-export `ValidationHarness` interface and `CascadeRunner` class from `harness.ts`

- [ ] Task 4: Write unit tests in `src/modules/validation/__tests__/harness.test.ts` (AC: #8)
  - [ ] Test: all levels pass → `ValidationResult.passed = true`, `highestLevelReached` = highest registered level number
  - [ ] Test: level 0 fails → cascade stops, levels 1+ not called, `passed = false`
  - [ ] Test: level 1 fails (level 0 passes) → cascade stops after level 1, `passed = false`, `highestLevelReached = 1`
  - [ ] Test: `maxLevel: 1` with levels 0-3 registered → only levels 0 and 1 execute
  - [ ] Test: levels registered out of order (2, 0, 1) → executed in ascending order (0, 1, 2)
  - [ ] Test: failing level with `canAutoRemediate: false` → `ValidationResult.canAutoRemediate = false`
  - [ ] Test: unhandled exception in a level → caught and treated as failure with evidence from error message
  - [ ] Test: `remediationContext` is `null` when all levels pass, non-null when any level fails

## Dev Notes

### Architecture Constraints
- **New module location**: `src/modules/validation/` — this directory does not exist yet; create it
- **File structure**:
  - `src/modules/validation/types.ts` — all shared types (no implementation)
  - `src/modules/validation/harness.ts` — `ValidationHarness` interface + `CascadeRunner` class
  - `src/modules/validation/index.ts` — public re-exports
  - `src/modules/validation/__tests__/harness.test.ts` — unit tests
- **Import style**: `.js` extension on all local imports (ESM project)
- **Logger**: use `createLogger` from `../../utils/logger.js` — pattern: `createLogger('validation:cascade')`
- **StoryRecord**: import from `../state/index.js` (already used in orchestrator-impl.ts)
- **No orchestrator changes in this story** — the cascade runner is scaffolded but not yet wired into the orchestrator (that happens in Story 33-4)
- **Test framework**: vitest (not jest)
- **Coverage threshold**: 80% enforced by vitest config

### Testing Requirements
- Mock `ValidationLevel` implementations using simple objects with stub `run()` functions — no real build or test execution in unit tests
- Use `vi.fn()` for level `run()` methods to assert call counts (verifying short-circuit)
- Tests live in `src/modules/validation/__tests__/harness.test.ts`
- Run targeted tests: `npm run test:fast` (verifying harness.test.ts passes)

### Key Design Decisions
- `remediationContext` in `ValidationResult` is derived from the first failing level's `LevelResult` — it packages the failures and sets `scope` based on failure count heuristics. For this story, the runner should compute a basic `RemediationContext` from failures (scope defaults to `'partial'` when building from raw failures; the specialized levels in 33-2 through 33-6 will set scope precisely)
- `retryBudget` in `RemediationContext` is not tracked by the cascade runner itself — the caller (orchestrator, Story 33-4) injects spent/remaining values. For now, `remediationContext.retryBudget` defaults to `{ spent: 0, remaining: 3 }` (budget tracking is wired in Story 33-4)
- The cascade runner does **not** own retry logic — it only runs levels and returns results. Retry orchestration lives in `RetryStrategy` (Story 33-4)

## Interface Contracts

- **Export**: `ValidationHarness`, `CascadeRunner` @ `src/modules/validation/harness.ts` (consumed by Story 33-4: RetryStrategy + orchestrator integration)
- **Export**: `ValidationResult`, `ValidationLevel`, `LevelResult`, `LevelFailure`, `ValidationContext`, `RemediationContext`, `CascadeRunnerConfig` @ `src/modules/validation/types.ts` (consumed by Stories 33-2, 33-3, 33-4, 33-5, 33-6, 33-7, 33-8)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
