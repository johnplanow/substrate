# Story 46-5: Parallel Running — Dual Signal (Code Review + Scenario)

## Story

As a factory pipeline operator,
I want both code review and scenario validation signals evaluated and compared after each story iteration,
so that I can monitor signal agreement while code review remains the authoritative Phase 2 decision-maker.

## Acceptance Criteria

### AC1: Both signals evaluated and combined result returned
**Given** a `DualSignalCoordinator` with threshold `0.8` and runId `'run-1'`
**When** `coordinator.evaluate('SHIP_IT', 0.85, 'run-1')` is called
**Then** the returned `DualSignalResult` includes both `codeReviewPassed: true` and `scenarioPassed: true` with `agreement: 'AGREE'`

### AC2: Disagreement detected when code review passes but scenario fails
**Given** code review verdict `SHIP_IT` and scenario score `0.6` with threshold `0.8`
**When** `evaluateDualSignal('SHIP_IT', 0.6, 0.8)` is called
**Then** the result has `agreement: 'DISAGREE'`, `codeReviewPassed: true`, `scenarioPassed: false`, and `authoritativeDecision: 'SHIP_IT'`

### AC3: Disagreement detected when code review fails but scenario passes
**Given** code review verdict `NEEDS_MINOR_FIXES` and scenario score `0.9` with threshold `0.8`
**When** `evaluateDualSignal('NEEDS_MINOR_FIXES', 0.9, 0.8)` is called
**Then** the result has `agreement: 'DISAGREE'`, `codeReviewPassed: false`, `scenarioPassed: true`, and `authoritativeDecision: 'NEEDS_MINOR_FIXES'`

### AC4: Code review is the authoritative decision — overrides failing scenario
**Given** code review verdict `SHIP_IT` and scenario score `0.3` (fails threshold `0.8`)
**When** `evaluateDualSignal('SHIP_IT', 0.3, 0.8)` is called
**Then** `authoritativeDecision: 'SHIP_IT'` is returned — the code review verdict is always authoritative regardless of scenario outcome

### AC5: `scenario:score-computed` event emitted by coordinator with full dual-signal payload
**Given** a `DualSignalCoordinator` with mock event bus, threshold `0.8`, code review verdict `SHIP_IT`, and scenario score `0.6`
**When** `coordinator.evaluate('SHIP_IT', 0.6, 'run-1')` is called
**Then** the event bus emits `'scenario:score-computed'` with payload `{ runId: 'run-1', score: 0.6, threshold: 0.8, passes: false, agreement: 'DISAGREE', codeReviewPassed: true, scenarioPassed: false, authoritativeDecision: 'SHIP_IT' }`

### AC6: `LGTM_WITH_NOTES` treated as code review pass
**Given** code review verdict `LGTM_WITH_NOTES` and scenario score `0.7` with threshold `0.8`
**When** `evaluateDualSignal('LGTM_WITH_NOTES', 0.7, 0.8)` is called
**Then** `codeReviewPassed: true` and `agreement: 'DISAGREE'` (scenario fails the threshold)

### AC7: Agreement detected when both signals fail
**Given** code review verdict `NEEDS_MAJOR_REWORK` and scenario score `0.5` with threshold `0.8`
**When** `evaluateDualSignal('NEEDS_MAJOR_REWORK', 0.5, 0.8)` is called
**Then** the result has `agreement: 'AGREE'`, `codeReviewPassed: false`, `scenarioPassed: false`

## Tasks / Subtasks

- [ ] Task 1: Add `scenario:score-computed` event type to `FactoryEvents` in `packages/factory/src/events.ts` (AC: #5)
  - [ ] Add `'scenario:score-computed': { runId: string; score: number; threshold: number; passes: boolean; agreement: 'AGREE' | 'DISAGREE'; codeReviewPassed: boolean; scenarioPassed: boolean; authoritativeDecision: string }` to the `FactoryEvents` intersection type in the "Scenario validation events" comment block
  - [ ] Verify the new key does not conflict with any existing event name in `FactoryEvents`

- [ ] Task 2: Create `packages/factory/src/convergence/dual-signal.ts` with types, pure function, and coordinator (AC: #1–#7)
  - [ ] Define `DualSignalVerdict` union: `'SHIP_IT' | 'NEEDS_MINOR_FIXES' | 'NEEDS_MAJOR_REWORK' | 'LGTM_WITH_NOTES'` — mirrors `CodeReviewResult.verdict` from story 43-5 without importing from `@substrate-ai/sdlc`
  - [ ] Define `DualSignalAgreement` union: `'AGREE' | 'DISAGREE'`
  - [ ] Define `DualSignalResult` interface: `{ codeReviewPassed: boolean; scenarioPassed: boolean; agreement: DualSignalAgreement; authoritativeDecision: DualSignalVerdict; score: number; threshold: number }`
  - [ ] Define `DualSignalCoordinatorOptions` interface: `{ eventBus: TypedEventBus<FactoryEvents>; threshold: number }`
  - [ ] Define `DualSignalCoordinator` interface with `evaluate(codeReviewVerdict: DualSignalVerdict, scenarioScore: number, runId: string): DualSignalResult`
  - [ ] Implement `evaluateDualSignal(verdict: DualSignalVerdict, score: number, threshold: number): DualSignalResult` as a **pure function** (no side effects):
    - `codeReviewPassed` = `verdict === 'SHIP_IT' || verdict === 'LGTM_WITH_NOTES'`
    - `scenarioPassed` = `score >= threshold`
    - `agreement` = `codeReviewPassed === scenarioPassed ? 'AGREE' : 'DISAGREE'`
    - `authoritativeDecision` = `verdict` (code review is authoritative in Phase 2)
  - [ ] Implement `createDualSignalCoordinator(options: DualSignalCoordinatorOptions): DualSignalCoordinator`:
    - `evaluate(verdict, score, runId)` calls `evaluateDualSignal(verdict, score, options.threshold)`, then emits `'scenario:score-computed'` on `options.eventBus`, and returns the `DualSignalResult`

- [ ] Task 3: Export dual-signal public API from `packages/factory/src/convergence/index.ts` (AC: #1–#7)
  - [ ] Add a `// Dual-signal coordinator — story 46-5` comment block followed by:
    ```
    export type { DualSignalVerdict, DualSignalAgreement, DualSignalResult, DualSignalCoordinator, DualSignalCoordinatorOptions } from './dual-signal.js'
    export { evaluateDualSignal, createDualSignalCoordinator } from './dual-signal.js'
    ```
  - [ ] Confirm `packages/factory/src/index.ts` already re-exports `* from './convergence/index.js'` — no changes needed there

- [ ] Task 4: Write unit tests in `packages/factory/src/convergence/__tests__/dual-signal.test.ts` (AC: #1–#7)
  - [ ] Test `evaluateDualSignal` AGREE/pass: `SHIP_IT` + `0.9` + `0.8` → `agreement: 'AGREE'`, both passed (AC1)
  - [ ] Test `evaluateDualSignal` AGREE/fail: `NEEDS_MAJOR_REWORK` + `0.5` + `0.8` → `agreement: 'AGREE'`, both failed (AC7)
  - [ ] Test `evaluateDualSignal` DISAGREE: `SHIP_IT` + `0.6` + `0.8` → `agreement: 'DISAGREE'`, `codeReviewPassed: true`, `scenarioPassed: false` (AC2)
  - [ ] Test `evaluateDualSignal` DISAGREE: `NEEDS_MINOR_FIXES` + `0.9` + `0.8` → `agreement: 'DISAGREE'`, `codeReviewPassed: false`, `scenarioPassed: true` (AC3)
  - [ ] Test `evaluateDualSignal` authoritative decision: `SHIP_IT` + `0.3` + `0.8` → `authoritativeDecision: 'SHIP_IT'` (AC4)
  - [ ] Test `evaluateDualSignal` `LGTM_WITH_NOTES` treated as pass: `LGTM_WITH_NOTES` + `0.7` + `0.8` → `codeReviewPassed: true`, `agreement: 'DISAGREE'` (AC6)
  - [ ] Test `evaluateDualSignal` threshold boundary: score exactly at threshold (`score === threshold`) → `scenarioPassed: true`
  - [ ] Test `evaluateDualSignal` `NEEDS_MAJOR_REWORK` authoritative: `authoritativeDecision: 'NEEDS_MAJOR_REWORK'` even when scenario passes
  - [ ] Test coordinator `evaluate()` emits `scenario:score-computed` with exact payload (AC5)
  - [ ] Test coordinator `evaluate()` emits only once per call
  - [ ] Test coordinator returns the `DualSignalResult` from `evaluate()` (confirms return value matches emitted payload)
  - [ ] Test coordinator passes `runId` correctly into emitted event payload
  - [ ] Minimum 12 test cases total; use `vi.fn()` for mock event bus `emit` — no `vi.mock()` required for pure-function tests

## Dev Notes

### Architecture Constraints
- All imports in `dual-signal.ts` must use `.js` extension (ESM): e.g., `import type { FactoryEvents } from '../events.js'`
- Import `TypedEventBus` from `@substrate-ai/core` (not a relative path): `import type { TypedEventBus } from '@substrate-ai/core'`
- `evaluateDualSignal` must be a pure function — no event bus parameter, no side effects. This makes it independently testable without any mocking.
- `createDualSignalCoordinator` is the only side-effect boundary (event emission). Keep it thin: it calls `evaluateDualSignal` and emits.
- `DualSignalVerdict` must NOT import from `@substrate-ai/sdlc` — the SDLC package does not compile-time-depend on factory (ADR-003 pattern). Define the union locally by mirroring the values in `CodeReviewResult.verdict`.
- `FactoryConfigSchema` is NOT modified in this story — `quality_mode` config belongs to story 46-6. This story delivers the utility module only.

### Implementation Pattern for `createDualSignalCoordinator`

```typescript
export function createDualSignalCoordinator(options: DualSignalCoordinatorOptions): DualSignalCoordinator {
  return {
    evaluate(verdict: DualSignalVerdict, score: number, runId: string): DualSignalResult {
      const result = evaluateDualSignal(verdict, score, options.threshold)
      options.eventBus.emit('scenario:score-computed', {
        runId,
        score: result.score,
        threshold: result.threshold,
        passes: result.scenarioPassed,
        agreement: result.agreement,
        codeReviewPassed: result.codeReviewPassed,
        scenarioPassed: result.scenarioPassed,
        authoritativeDecision: result.authoritativeDecision,
      })
      return result
    },
  }
}
```

### Mock Event Bus Pattern for Tests

```typescript
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'

const mockBus = { emit: vi.fn() } as unknown as TypedEventBus<FactoryEvents>
```

### Testing Requirements
- Test file: `packages/factory/src/convergence/__tests__/dual-signal.test.ts`
- Use `vitest` with `describe` / `it` / `expect` / `vi.fn()`
- No `vi.mock()` needed for `evaluateDualSignal` tests — it is a pure function
- For coordinator tests, verify `emit` was called: `expect(mockBus.emit).toHaveBeenCalledWith('scenario:score-computed', expect.objectContaining({ runId: 'run-1', agreement: 'DISAGREE' }))`
- After implementation, run: `npm run test:fast` (with `timeout: 300000`); confirm "Test Files" line appears in output — do NOT pipe output through `grep` or `head`

### File Paths
- **Modified**: `packages/factory/src/events.ts` — add `'scenario:score-computed'` event to `FactoryEvents`
- **New**: `packages/factory/src/convergence/dual-signal.ts` — types, `evaluateDualSignal`, `DualSignalCoordinator`, `createDualSignalCoordinator`
- **Modified**: `packages/factory/src/convergence/index.ts` — export dual-signal public API
- **New**: `packages/factory/src/convergence/__tests__/dual-signal.test.ts` — unit tests (≥12 test cases)

### Dependency Notes
- **Depends on 46-2**: The `satisfactionThreshold` field was threaded through `CheckGoalGatesOptions` and `ToolHandlerOptions`. Use the same threshold concept in `DualSignalCoordinatorOptions.threshold`.
- **Depends on 43-5**: `SdlcCodeReviewHandler` defines `CodeReviewResult.verdict`. Do NOT import from `@substrate-ai/sdlc`. Mirror the union values locally as `DualSignalVerdict`.
- **Does NOT require 46-3 or 46-4**: The dual-signal module is a pure in-memory evaluation utility — no database persistence needed in this story.
- **Story 46-6 depends on this story**: It will extend `dual-signal.ts` with scenario-primary mode and wire `quality_mode` config.

## Interface Contracts

- **Export**: `DualSignalResult` @ `packages/factory/src/convergence/dual-signal.ts` (consumed by story 46-6 for scenario-primary mode)
- **Export**: `DualSignalVerdict` @ `packages/factory/src/convergence/dual-signal.ts` (consumed by story 46-6)
- **Export**: `evaluateDualSignal` @ `packages/factory/src/convergence/dual-signal.ts` (consumed by story 46-6 and CLI composition root)
- **Export**: `createDualSignalCoordinator` @ `packages/factory/src/convergence/dual-signal.ts` (consumed by story 46-6 and CLI composition root)
- **Import**: `FactoryEvents` @ `packages/factory/src/events.ts` (for TypedEventBus generic parameter)
- **Import**: `TypedEventBus` @ `@substrate-ai/core` (event bus type)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
