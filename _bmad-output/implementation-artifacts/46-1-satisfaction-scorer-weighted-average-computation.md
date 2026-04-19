# Story 46-1: Satisfaction Scorer — Weighted Average Computation

## Story

As a factory pipeline developer,
I want a `SatisfactionScorer` that computes a weighted average score from scenario results with a per-scenario `breakdown`,
so that the pipeline can evaluate story quality using configurable per-scenario weights and operators can inspect which scenarios contributed most to the final score.

## Acceptance Criteria

### AC1: Unweighted Score — 3 of 5 Passing
**Given** a `ScenarioRunResult` with 5 scenarios where 3 have status `pass` and 2 have status `fail`, and no explicit weights
**When** `scorer.compute(result)` is called with default threshold 0.8
**Then** `score = 0.6`, `passes = false`, and `breakdown` contains exactly 5 entries (one per scenario, all weight 1.0)

### AC2: Weighted Score — Unequal Weights
**Given** 3 scenarios named `login` (weight 3.0), `checkout` (weight 1.0), `profile` (weight 1.0), where only `login` passes
**When** `scorer.compute(result, { login: 3.0, checkout: 1.0, profile: 1.0 })` is called
**Then** `score = 0.6` (3.0 / 5.0) and `passes = false` (threshold 0.8)

### AC3: All Scenarios Pass
**Given** a `ScenarioRunResult` where every scenario has status `pass`
**When** `scorer.compute(result)` is called
**Then** `score = 1.0` and `passes = true`

### AC4: No Scenarios — Zero Score
**Given** a `ScenarioRunResult` with an empty `scenarios` array
**When** `scorer.compute(result)` is called
**Then** `score = 0.0`, `passes = false`, and `breakdown = []`

### AC5: Breakdown Contains Per-Scenario Detail
**Given** scenarios `login` (pass, weight 3.0), `checkout` (fail, weight 1.0), `profile` (fail, weight 1.0) with totalWeight = 5.0
**When** `scorer.compute(result, { login: 3.0, checkout: 1.0, profile: 1.0 })` is called
**Then** `breakdown` contains one entry per scenario; `login` has `passed = true`, `weight = 3.0`, `contribution = 0.6`; `checkout` has `passed = false`, `weight = 1.0`, `contribution = 0.0`; `profile` has `passed = false`, `weight = 1.0`, `contribution = 0.0`

### AC6: `computeSatisfactionScore` Backward Compatibility with Breakdown
**Given** the existing `computeSatisfactionScore(result, threshold?)` function
**When** it is called with a `ScenarioRunResult` containing named scenarios
**Then** the result includes a `breakdown` array with one entry per scenario (all weight 1.0), `passes` and `score` remain unchanged, and all existing callers compile without modification

### AC7: New Types Exported from `@substrate-ai/factory`
**Given** the `@substrate-ai/factory` public API
**When** `createSatisfactionScorer`, `SatisfactionScorer`, `ScenarioScoreDetail`, and `ScenarioWeights` are imported
**Then** all are available; `createSatisfactionScorer()` returns a `SatisfactionScorer` whose `compute()` is callable and returns the full `SatisfactionScore` including `breakdown`

## Tasks / Subtasks

- [ ] Task 1: Add `ScenarioScoreDetail`, `ScenarioWeights`, update `SatisfactionScore` in `scorer.ts` (AC: #1, #2, #5, #6)
  - [ ] Add `ScenarioScoreDetail` interface with fields `name: string`, `passed: boolean`, `weight: number`, `contribution: number` and JSDoc per field
  - [ ] Add `ScenarioWeights` type alias: `Record<string, number>` with JSDoc noting it maps scenario name to weight (default 1.0)
  - [ ] Extend `SatisfactionScore` interface with required field `breakdown: ScenarioScoreDetail[]` and a JSDoc note: "per-scenario score detail; empty array when no scenarios"

- [ ] Task 2: Add `SatisfactionScorer` interface and `createSatisfactionScorer` factory (AC: #1, #2, #3, #4, #5, #7)
  - [ ] Define and export `SatisfactionScorer` interface with method: `compute(results: ScenarioRunResult, weights?: ScenarioWeights): SatisfactionScore`
  - [ ] Implement `createSatisfactionScorer(threshold = 0.8): SatisfactionScorer` factory function using the weighted algorithm:
    - For each scenario, resolve weight from `weights[name] ?? 1.0`
    - `totalWeight = sum(all resolved weights)`; if `totalWeight === 0` return `{ score: 0, passes: false, threshold, breakdown: [] }`
    - For each scenario: `passed = status === 'pass'`; `contribution = weight * (passed ? 1 : 0) / totalWeight`
    - `score = sum(contributions)`
    - `breakdown = [{name, passed, weight, contribution}, ...]` in scenario order
    - Return `{ score, passes: score >= threshold, threshold, breakdown }`

- [ ] Task 3: Update `computeSatisfactionScore` to include `breakdown` (AC: #6)
  - [ ] Replace the existing implementation body in `computeSatisfactionScore(result, threshold)` to compute `breakdown` from `result.scenarios` (all weight 1.0) before the score calculation
  - [ ] Each entry: `{ name: s.name, passed: s.status === 'pass', weight: 1.0, contribution: totalWeight > 0 ? (s.status === 'pass' ? 1.0 / totalWeight : 0) : 0 }`
  - [ ] Include `breakdown` in the returned object
  - [ ] Update the JSDoc comment to reference Epic 46 and note the new `breakdown` field

- [ ] Task 4: Update `scenarios/index.ts` exports (AC: #7)
  - [ ] Add exports for `createSatisfactionScorer` and `SatisfactionScorer` from `'./scorer.js'`
  - [ ] Add type exports for `ScenarioScoreDetail` and `ScenarioWeights` from `'./scorer.js'`
  - [ ] Update the inline comment from `// Scorer (story 44-5)` to `// Scorer (stories 44-5, 46-1)`

- [ ] Task 5: Write unit tests in a new test file (AC: #1–#7)
  - [ ] Create `packages/factory/src/scenarios/__tests__/scorer.test.ts` with `import { describe, it, expect } from 'vitest'`
  - [ ] Import `createSatisfactionScorer` and `computeSatisfactionScore` from `'../scorer.js'`
  - [ ] **AC1 test**: build `ScenarioRunResult` with 5 scenarios, 3 pass, 2 fail; call `scorer.compute(result)` → verify `score ≈ 0.6`, `passes = false`, `breakdown.length === 5`
  - [ ] **AC2 test**: 3 named scenarios `login`/`checkout`/`profile` with weights `{login: 3.0, checkout: 1.0, profile: 1.0}`, only login passes → `score ≈ 0.6`, `passes = false`
  - [ ] **AC3 test**: all scenarios pass → `score = 1.0`, `passes = true`
  - [ ] **AC4 test**: empty scenarios array → `score = 0.0`, `passes = false`, `breakdown = []`
  - [ ] **AC5 test**: weighted breakdown — verify login `contribution ≈ 0.6`, checkout `contribution = 0.0`, profile `contribution = 0.0`; verify `weight` fields are 3.0, 1.0, 1.0 respectively
  - [ ] **AC5 detail test**: verify `breakdown[0].passed = true`, `breakdown[1].passed = false`
  - [ ] **AC6 test**: call `computeSatisfactionScore` with a 3-scenario result → verify `breakdown.length === 3`, all weights 1.0, `score` unchanged
  - [ ] **AC6 backward-compat test**: call `computeSatisfactionScore` with custom threshold 0.5 → `passes = true` when score > 0.5
  - [ ] **AC7 test**: `typeof createSatisfactionScorer === 'function'` and `typeof scorer.compute === 'function'`
  - [ ] Aim for ≥ 12 tests in the describe block

- [ ] Task 6: Build and validate (AC: all)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` — verify "Test Files" summary line appears; all tests pass
  - [ ] Confirm no regressions in the 7,809-test baseline

## Dev Notes

### Architecture Constraints

- **Primary file to modify:** `packages/factory/src/scenarios/scorer.ts` — all new types, interface, and factory live here
- **Barrel to update:** `packages/factory/src/scenarios/index.ts` — add exports for new types/functions
- **New test file:** `packages/factory/src/scenarios/__tests__/scorer.test.ts` — new file, do NOT modify the epic44 coverage gate test
- **ESM imports:** All relative imports within the factory package use `.js` extensions (e.g., `import type { ScenarioRunResult } from '../events.js'`)
- **Do NOT modify:** `packages/factory/src/events.ts` — `ScenarioRunResult` and `ScenarioResult` types are already correct
- **Backward compat:** `computeSatisfactionScore` signature does not change — only its return value gains `breakdown`; all existing tests must continue to pass without modification

### New Type Definitions

```typescript
/**
 * Per-scenario contribution detail in a SatisfactionScore.
 */
export interface ScenarioScoreDetail {
  /** Scenario file name (e.g., 'scenario-login.sh') */
  name: string
  /** Whether this scenario passed (exit code 0) */
  passed: boolean
  /** Weight assigned to this scenario (default 1.0) */
  weight: number
  /**
   * Normalised contribution: weight * (passed ? 1 : 0) / totalWeight.
   * Sum of all contributions equals the overall score.
   */
  contribution: number
}

/** Maps scenario name to its weight multiplier. Default weight is 1.0. */
export type ScenarioWeights = Record<string, number>
```

### Extended `SatisfactionScore` Interface

```typescript
export interface SatisfactionScore {
  /** Ratio of weighted-passing scenarios: 0.0 when total weight is 0. */
  score: number
  /** Whether score meets or exceeds the threshold. */
  passes: boolean
  /** The threshold used for the passes comparison. */
  threshold: number
  /** Per-scenario score detail. Empty array when no scenarios ran. */
  breakdown: ScenarioScoreDetail[]
}
```

### `SatisfactionScorer` Interface and Factory Signature

```typescript
export interface SatisfactionScorer {
  /**
   * Compute a weighted satisfaction score from a ScenarioRunResult.
   *
   * @param results  - The aggregated scenario run result.
   * @param weights  - Optional per-scenario weight map. Missing entries default to 1.0.
   * @returns A SatisfactionScore with weighted score, passes, threshold, and breakdown.
   */
  compute(results: ScenarioRunResult, weights?: ScenarioWeights): SatisfactionScore
}

/**
 * Create a SatisfactionScorer that computes weighted average scores.
 *
 * @param threshold - Minimum score to consider passing (default 0.8).
 */
export function createSatisfactionScorer(threshold = 0.8): SatisfactionScorer
```

### Weighted Scoring Algorithm

```
For each scenario s_i with resolved weight w_i = weights[s_i.name] ?? 1.0:
  totalWeight = Σ w_i

If totalWeight === 0:
  return { score: 0, passes: false, threshold, breakdown: [] }

For each scenario s_i:
  passed_i     = (s_i.status === 'pass')
  contribution_i = w_i * (passed_i ? 1 : 0) / totalWeight

score = Σ contribution_i
passes = score >= threshold
breakdown = [{ name, passed, weight, contribution }, ...] in scenario order
```

### Helper for Building Test Fixtures

```typescript
function makeResult(scenarios: Array<{ name: string; status: 'pass' | 'fail' }>): ScenarioRunResult {
  const passed = scenarios.filter(s => s.status === 'pass').length
  return {
    scenarios: scenarios.map(s => ({
      name: s.name, status: s.status, exitCode: s.status === 'pass' ? 0 : 1,
      stdout: '', stderr: '', durationMs: 10,
    })),
    summary: { total: scenarios.length, passed, failed: scenarios.length - passed },
    durationMs: 50,
  }
}
```

### Testing Requirements

- **Framework:** Vitest — `import { describe, it, expect } from 'vitest'`
- **Run command:** `npm run test:fast` with `timeout: 300000`
- **NEVER pipe** test output through `head`, `tail`, or `grep`
- **Confirm results** by checking for "Test Files" summary line in output
- **Minimum new tests:** ≥ 12 tests in the new `scorer.test.ts`
- **No regressions:** All 7,809 existing tests must continue to pass

### Dependency Chain

- **Depends on:** Story 44-5 (existing `computeSatisfactionScore`, `SatisfactionScore`, `ScenarioRunResult`)
- **Consumed by:** Story 46-2 (`createSatisfactionScorer` is wired into `ConvergenceController` threshold check)
- **Consumed by:** Story 46-3 (score breakdown is persisted to `scenario_results` table)
- **Consumed by:** Story 46-5 (dual-signal mode computes score via `SatisfactionScorer`)

## Interface Contracts

- **Export**: `SatisfactionScorer` @ `packages/factory/src/scenarios/scorer.ts` (consumed by story 46-2)
- **Export**: `ScenarioScoreDetail` @ `packages/factory/src/scenarios/scorer.ts` (consumed by story 46-3)
- **Export**: `ScenarioWeights` @ `packages/factory/src/scenarios/scorer.ts` (consumed by stories 46-2, 46-5)
- **Export**: `createSatisfactionScorer` @ `packages/factory/src/scenarios/scorer.ts` (consumed by story 46-2)
- **Export**: `SatisfactionScore` (extended) @ `packages/factory/src/scenarios/scorer.ts` — backward-compat extension; existing callers of `computeSatisfactionScore` gain `breakdown` field without interface break

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-23: Story created for Epic 46 — Satisfaction Scoring
