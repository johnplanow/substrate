# Story 45-6: Diminishing Returns / Plateau Detection

## Story

As a convergence controller,
I want a PlateauDetector that tracks satisfaction scores across iterations and detects when scores have stopped improving,
so that the pipeline can escalate instead of retrying when further iterations are unlikely to yield meaningful improvement.

## Acceptance Criteria

### AC1: Plateau Detected When Score Spread Falls Below Threshold
**Given** a PlateauDetector with window=3 and threshold=0.05
**When** scores [0.6, 0.61, 0.59] are recorded (max−min = 0.02 < 0.05)
**Then** `isPlateaued()` returns `true`

### AC2: No Plateau When Scores Are Still Improving
**Given** a PlateauDetector with window=3 and threshold=0.05
**When** scores [0.6, 0.7, 0.8] are recorded (max−min = 0.2 > 0.05)
**Then** `isPlateaued()` returns `false`

### AC3: Insufficient Data Returns False
**Given** a PlateauDetector with window=3
**When** fewer than 3 scores have been recorded (0, 1, or 2 scores)
**Then** `isPlateaued()` returns `false` for each count — insufficient data to declare plateau

### AC4: Sliding Window — Only Last N Scores Considered
**Given** a PlateauDetector with window=3
**When** 5 scores are recorded as [0.1, 0.9, 0.6, 0.61, 0.59]
**Then** `isPlateaued()` returns `true` — only the last 3 scores [0.6, 0.61, 0.59] are considered; early scores that would inflate the spread are discarded

### AC5: Strict Threshold Boundary — Equal Delta Is Not a Plateau
**Given** a PlateauDetector with window=3 and threshold=0.05
**When** scores [0.60, 0.65, 0.60] are recorded (max−min = 0.05, exactly equal to threshold)
**Then** `isPlateaued()` returns `false` — only a strictly less-than comparison (`delta < threshold`) declares plateau

### AC6: Configurable Window and Threshold via Options
**Given** a `PlateauDetectorOptions` object with custom `window` and `threshold` values
**When** `createPlateauDetector({ window: 5, threshold: 0.02 })` is constructed
**Then** the detector uses window=5 and threshold=0.02 for all checks; when called with no options, defaults are window=3 and threshold=0.05

### AC7: Event Emission via checkPlateauAndEmit
**Given** a PlateauDetector that has detected a plateau and a mock TypedEventBus
**When** `checkPlateauAndEmit(detector, { runId: 'run-1', nodeId: 'score-node', eventBus })` is called
**Then** it emits `convergence:plateau-detected` with payload `{ runId: 'run-1', nodeId: 'score-node', scores: [...], window: 3 }` and returns `{ plateaued: true, scores: [...] }`; when not yet plateaued, no event is emitted and it returns `{ plateaued: false, scores: [...] }`

## Tasks / Subtasks

- [ ] Task 1: Implement `PlateauDetector` interface and `createPlateauDetector()` factory in `packages/factory/src/convergence/plateau.ts` (AC: #1, #2, #3, #4, #5, #6)
  - [ ] Define `PlateauDetectorOptions` interface: `{ window?: number; threshold?: number }` — both fields optional; defaults are `window=3`, `threshold=0.05`
  - [ ] Define `PlateauDetector` interface with four methods:
    - `recordScore(iteration: number, score: number): void` — append score and slide window
    - `isPlateaued(): boolean` — check if current window qualifies as a plateau
    - `getWindow(): number` — return configured window size (used by checkPlateauAndEmit for event payload)
    - `getScores(): number[]` — return defensive copy of current score window
  - [ ] Implement `createPlateauDetector(options?: PlateauDetectorOptions): PlateauDetector`:
    - Internal `scores: number[]` array; after each `recordScore`, slice to keep only last `window` entries (`scores = scores.slice(-window)`)
    - `isPlateaued()`: return `false` when `scores.length < window`; otherwise compute `Math.max(...scores) - Math.min(...scores)` and return `delta < threshold` (strict less-than)
    - `getWindow()`: return the resolved window value
    - `getScores()`: return `[...scores]` (spread copy — never expose internal array directly)
  - [ ] Add JSDoc on `PlateauDetector` interface explaining the algorithm: "Track the last N satisfaction scores. If max−min of the window falls strictly below threshold, declare plateau."
  - [ ] Add JSDoc on `createPlateauDetector()` explaining defaults and the insufficient-data guard

- [ ] Task 2: Implement `checkPlateauAndEmit()` helper in the same `plateau.ts` file (AC: #7)
  - [ ] Define `PlateauCheckContext` interface: `{ runId: string; nodeId: string; eventBus?: TypedEventBus<FactoryEvents> }`
  - [ ] Define `PlateauCheckResult` interface: `{ plateaued: boolean; scores: number[] }`
  - [ ] Export `checkPlateauAndEmit(detector: PlateauDetector, context: PlateauCheckContext): PlateauCheckResult`:
    - Capture `scores = detector.getScores()` once (used in both event payload and return value)
    - If `detector.isPlateaued()`: emit `convergence:plateau-detected` with `{ runId, nodeId, scores, window: detector.getWindow() }` on `context.eventBus` (if provided); return `{ plateaued: true, scores }`
    - If not plateaued: return `{ plateaued: false, scores }` — do NOT emit any event
  - [ ] Import `TypedEventBus` from `'@substrate-ai/core'` and `FactoryEvents` from `'../events.js'`
  - [ ] Add JSDoc explaining this mirrors the `checkGoalGates()` pattern: pure detection in `PlateauDetector`; event emission isolated in this wrapper; callers may omit `eventBus` for pure check behavior

- [ ] Task 3: Append exports to `packages/factory/src/convergence/index.ts` (AC: all)
  - [ ] Add a `// Plateau detection — story 45-6` comment followed by:
    - `export type { PlateauDetectorOptions, PlateauDetector, PlateauCheckContext, PlateauCheckResult } from './plateau.js'`
    - `export { createPlateauDetector, checkPlateauAndEmit } from './plateau.js'`
  - [ ] Preserve all existing exports without modification

- [ ] Task 4: Write unit tests in `packages/factory/src/convergence/__tests__/plateau.test.ts` (AC: #1–#7)
  - [ ] `describe('createPlateauDetector', ...)`:
    - AC1: Record [0.6, 0.61, 0.59] with default options → `isPlateaued()` = `true`
    - AC2: Record [0.6, 0.7, 0.8] with default options → `isPlateaued()` = `false`
    - AC3: 0 scores recorded → `false`; 1 score recorded → `false`; 2 scores recorded → `false` (window=3)
    - AC4: Record [0.1, 0.9, 0.6, 0.61, 0.59] with window=3 → `isPlateaued()` = `true`; verify `getScores()` returns exactly `[0.6, 0.61, 0.59]`
    - AC5: Record [0.60, 0.65, 0.60] with threshold=0.05 → `isPlateaued()` = `false` (delta === threshold, strict < fails)
    - AC6: `createPlateauDetector({ window: 5, threshold: 0.02 })` — needs 5 scores; 4 scores returns false; 5 tight scores return true
    - AC6 defaults: `createPlateauDetector()` → `getWindow()` = 3
    - Additional: `getScores()` returns a defensive copy — mutating the returned array does not change `isPlateaued()` behavior
  - [ ] `describe('checkPlateauAndEmit', ...)`:
    - AC7 plateaued: Record plateau scores, call with mock `{ emit: vi.fn() }` → emits `convergence:plateau-detected` with correct payload; returns `{ plateaued: true, scores }`
    - AC7 not plateaued: Insufficient scores, call with mock eventBus → `emit` is NOT called; returns `{ plateaued: false, scores: [] }` (or partial scores)
    - Additional: Works with no eventBus (undefined) — no throw when `eventBus` is omitted; returns correct `PlateauCheckResult`

- [ ] Task 5: Build and validate (AC: all)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all tests pass; ≥10 new assertions in `plateau.test.ts`, no regressions
  - [ ] Verify `PlateauDetector`, `createPlateauDetector`, `checkPlateauAndEmit`, `PlateauCheckContext`, `PlateauCheckResult`, and `PlateauDetectorOptions` are importable from `@substrate-ai/factory`

## Dev Notes

### Architecture Constraints

- **File locations:**
  - `packages/factory/src/convergence/plateau.ts` — **new file**: all types (`PlateauDetectorOptions`, `PlateauDetector`, `PlateauCheckContext`, `PlateauCheckResult`), factory (`createPlateauDetector`), and helper (`checkPlateauAndEmit`)
  - `packages/factory/src/convergence/index.ts` — **modified**: append plateau exports after the existing per-session budget section; preserve all existing exports
  - `packages/factory/src/convergence/__tests__/plateau.test.ts` — **new file**: all plateau unit tests (do NOT add to `budget.test.ts`)

- **Import style:** All relative imports within `packages/factory/src/` use `.js` extensions (ESM). Example: `import type { FactoryEvents } from '../events.js'`. Cross-package imports use the bare package name: `import type { TypedEventBus } from '@substrate-ai/core'`.

- **PlateauDetector interface from architecture (Section 6.4):**
  ```typescript
  interface PlateauDetector {
    recordScore(iteration: number, score: number): void
    isPlateaued(): boolean
  }
  ```
  Extend with `getWindow(): number` and `getScores(): number[]` to support `checkPlateauAndEmit`. These additional methods are not in the architecture spec but are required for the event emission helper to construct the `convergence:plateau-detected` payload without re-computing state.

- **Algorithm specification (architecture Section 6.4):** Track the last N satisfaction scores (N = `window`, default 3). After each `recordScore`, slice to keep only the last N entries. `isPlateaued()` returns `false` if `scores.length < window` (insufficient data guard). Otherwise computes `Math.max(...scores) - Math.min(...scores)` and returns `true` only when this delta is **strictly less than** `threshold`. Equal-to-threshold is NOT a plateau.

- **No side effects in core PlateauDetector:** `createPlateauDetector()` returns a pure in-memory data structure — no I/O, no event emission, no global state. Event emission is isolated to `checkPlateauAndEmit()`, matching the pattern established by `checkGoalGates()` in `controller.ts`.

- **Event payload (from `FactoryEvents` in `packages/factory/src/events.ts`):**
  ```typescript
  'convergence:plateau-detected': { runId: string; nodeId: string; scores: number[]; window: number }
  ```
  The `scores` field contains the current window contents (result of `getScores()`). The `window` field is the configured window size (result of `getWindow()`).

- **Defensive copy in `getScores()`:** Return `[...scores]` so callers cannot mutate the detector's internal array and corrupt plateau detection state.

- **Default option values:** `window: 3`, `threshold: 0.05` — match `FactoryConfigSchema.plateau_window` and `FactoryConfigSchema.plateau_threshold` in `packages/factory/src/config.ts`. Story 45-8 will read these values from `FactoryConfig` and pass them to `createPlateauDetector`.

- **Story 45-8 integration context:** Story 45-8 will wire `PlateauDetector` into the executor's convergence loop: create one `PlateauDetector` per pipeline run using config values, call `detector.recordScore(iteration, score)` after each scoring step, then call `checkPlateauAndEmit(detector, { runId, nodeId, eventBus })`. This story provides the primitives only — no executor wiring.

### Testing Requirements

- **Test framework:** Vitest (already configured in factory package — `packages/factory/vitest.config.ts`)
- **New test file:** `packages/factory/src/convergence/__tests__/plateau.test.ts` — do NOT append to `budget.test.ts`
- **Mock eventBus for AC7:** Use `vi.fn()` to create a mock `emit` function; construct a minimal mock object `{ emit: vi.fn() }` cast as `TypedEventBus<FactoryEvents>` and pass it as `context.eventBus`
- **Boundary tests required:** Include exact-equal-to-threshold (AC5) and all three insufficient-data counts 0/1/2 (AC3) — these are common miss points
- **Sliding window test (AC4):** Record 5 scores and verify that old scores outside the window do not affect plateau detection, AND that `getScores()` returns only the last 3
- **Run during development:** `npm run test:fast` (unit-only, ~50s, no coverage)
- **Confirm pass:** Look for the "Test Files" summary line in output — exit code alone is insufficient
- **Never pipe output** through `head`, `tail`, or `grep` — this discards the Vitest summary
- **Target:** ≥10 new assertions in `plateau.test.ts`, all passing. No regressions in existing tests.

### Dependency Notes

- **Depends on:** Story 45-5 (per-session budget enforcement — establishes the `convergence/` module structure and `budget.ts` patterns this story follows). The `convergence/index.ts` barrel already exports budget symbols; this story appends plateau exports.
- **Depended on by:** Story 45-8 (convergence controller integration — wires `PlateauDetector` and `checkPlateauAndEmit` into the graph executor dispatch loop as the plateau-detection step)
- This story is intentionally scoped to pure plateau detection primitives + event emission helper only. The executor integration and config wiring are deferred to story 45-8.

## Interface Contracts

- **Export**: `PlateauDetector` @ `packages/factory/src/convergence/plateau.ts` (consumed by story 45-8)
- **Export**: `PlateauDetectorOptions` @ `packages/factory/src/convergence/plateau.ts` (consumed by story 45-8)
- **Export**: `createPlateauDetector` @ `packages/factory/src/convergence/plateau.ts` (consumed by story 45-8)
- **Export**: `checkPlateauAndEmit` @ `packages/factory/src/convergence/plateau.ts` (consumed by story 45-8)
- **Export**: `PlateauCheckContext` @ `packages/factory/src/convergence/plateau.ts` (consumed by story 45-8)
- **Export**: `PlateauCheckResult` @ `packages/factory/src/convergence/plateau.ts` (consumed by story 45-8)
- **Import**: `TypedEventBus` @ `@substrate-ai/core` (platform utility — already used in `controller.ts`)
- **Import**: `FactoryEvents` @ `packages/factory/src/events.ts` (from story 44-1)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-23: Story created for Epic 45, Phase B — Convergence Loop
