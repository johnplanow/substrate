# Story 46-6: Phase 3 Quality Transition — Scenario Primary

## Story

As a factory pipeline operator,
I want `quality_mode: 'scenario-primary'` to make the satisfaction score the authoritative decision for goal gates while code review runs as an observable advisory signal,
so that I can decouple code review opinion from convergence decisions and use empirical test results to drive the pipeline.

## Acceptance Criteria

### AC1: `FactoryConfigSchema` accepts `quality_mode` field
**Given** a `config.yaml` with `factory: { quality_mode: 'scenario-primary' }`
**When** `loadFactoryConfig()` parses it
**Then** `factoryConfig.factory.quality_mode` equals `'scenario-primary'` and the schema accepts all four valid values: `'code-review'`, `'dual-signal'`, `'scenario-primary'`, `'scenario-only'`; an invalid value throws a Zod validation error; the default when omitted is `'dual-signal'`

### AC2: `scenario-primary` mode — scenario passes, code review fails → goal gate passes
**Given** a graph executor configured with `qualityMode: 'scenario-primary'`, `satisfactionThreshold: 0.8`, `satisfaction_score: 0.9` in context, and `factory.codeReviewVerdict: 'NEEDS_MAJOR_REWORK'` in context
**When** the executor reaches the exit node and evaluates the goal gate
**Then** the goal gate is satisfied (`gateResult.satisfied === true`) and a `graph:goal-gate-checked` event is emitted with `satisfied: true, score: 0.9`

### AC3: `scenario-primary` mode — scenario fails, code review passes → goal gate fails
**Given** a graph executor configured with `qualityMode: 'scenario-primary'`, `satisfactionThreshold: 0.8`, `satisfaction_score: 0.6` in context, and `factory.codeReviewVerdict: 'SHIP_IT'` in context
**When** the executor reaches the exit node and evaluates the goal gate
**Then** the goal gate is NOT satisfied (`gateResult.satisfied === false`) and a `graph:goal-gate-checked` event is emitted with `satisfied: false, score: 0.6`

### AC4: Code review result emitted as `scenario:advisory-computed` event in scenario-primary mode
**Given** a graph executor configured with `qualityMode: 'scenario-primary'`, `satisfaction_score: 0.9` in context, and `factory.codeReviewVerdict: 'NEEDS_MAJOR_REWORK'` in context
**When** the executor evaluates the goal gate at the exit node
**Then** a `scenario:advisory-computed` event is emitted with `{ verdict: 'NEEDS_MAJOR_REWORK', codeReviewPassed: false, score: 0.9, threshold: 0.8, agreement: 'DISAGREE' }`; the event appears in the NDJSON stream but does NOT affect the gate decision

### AC5: `dual-signal` mode (default) is unaffected — outcome-status-based evaluation continues
**Given** a graph executor configured with `qualityMode: 'dual-signal'` (or `qualityMode` omitted) and no `satisfactionThreshold`
**When** the executor reaches the exit node
**Then** goal gate evaluation falls back to outcome status (existing Phase 2 behavior); no `scenario:advisory-computed` event is emitted

### AC6: `factory run` command wires `quality_mode` and `satisfaction_threshold` from config to executor
**Given** a `config.yaml` with `factory: { quality_mode: 'scenario-primary', satisfaction_threshold: 0.85 }`
**When** `factory run` is invoked
**Then** the executor is called with `qualityMode: 'scenario-primary'` and `satisfactionThreshold: 0.85`

### AC7: `QualityMode` type and `CONTEXT_KEY_CODE_REVIEW_VERDICT` constant exported from public API
**Given** the `@substrate-ai/factory` package
**When** consumers import from it
**Then** `QualityMode`, `CONTEXT_KEY_CODE_REVIEW_VERDICT`, and the updated `DualSignalCoordinatorOptions` (with `qualityMode` field) are all accessible

## Tasks / Subtasks

- [x] Task 1: Add `quality_mode` field to `FactoryConfigSchema` in `packages/factory/src/config.ts` (AC: #1)
  - [x] Add `quality_mode: z.enum(['code-review', 'dual-signal', 'scenario-primary', 'scenario-only']).default('dual-signal')` inside `FactoryConfigSchema.object({...})` after `backend`
  - [x] Verify `FactoryConfig` type inference picks up the new field (no manual type changes needed — `z.infer<typeof FactoryConfigSchema>` handles it)
  - [x] Remove `.strict()` from `FactoryConfigSchema` if it blocks the new field, or ensure it is included in the strict shape

- [x] Task 2: Add `QualityMode` type, `CONTEXT_KEY_CODE_REVIEW_VERDICT`, and `scenario:advisory-computed` event (AC: #4, #7)
  - [x] In `packages/factory/src/convergence/dual-signal.ts`, add after the `DualSignalAgreement` type:
    ```typescript
    /**
     * Quality mode determines which signal is authoritative for goal gate decisions.
     * Story 46-6.
     */
    export type QualityMode = 'code-review' | 'dual-signal' | 'scenario-primary' | 'scenario-only'

    /**
     * Context key under which code review handlers store their verdict.
     * Used by the executor to read the verdict when emitting advisory events.
     * Story 46-6.
     */
    export const CONTEXT_KEY_CODE_REVIEW_VERDICT = 'factory.codeReviewVerdict'
    ```
  - [x] In `packages/factory/src/events.ts`, add the following to `FactoryEvents` after `'scenario:score-computed'`:
    ```typescript
    /** Code review verdict logged as advisory when scenario is the authoritative decision-maker — story 46-6 */
    'scenario:advisory-computed': { runId: string; verdict: string; codeReviewPassed: boolean; score: number; threshold: number; agreement: 'AGREE' | 'DISAGREE' }
    ```

- [x] Task 3: Extend `DualSignalCoordinatorOptions` and `createDualSignalCoordinator` for scenario-primary mode (AC: #4, #5)
  - [x] Add `qualityMode?: QualityMode` to `DualSignalCoordinatorOptions` interface in `packages/factory/src/convergence/dual-signal.ts`
  - [x] Update `createDualSignalCoordinator` implementation: when `options.qualityMode === 'scenario-primary'`, emit `'scenario:advisory-computed'` after the existing `'scenario:score-computed'` emission
    - Advisory payload: `{ runId, verdict: result.authoritativeDecision, codeReviewPassed: result.codeReviewPassed, score: result.score, threshold: result.threshold, agreement: result.agreement }`
  - [x] The `'scenario:score-computed'` emission is unchanged — it still reflects `passes: result.scenarioPassed` (already correct for scenario-primary since `scenarioPassed` is scenario-based)
  - [x] No changes to `evaluateDualSignal` pure function — it remains mode-agnostic

- [x] Task 4: Add `qualityMode` to `GraphExecutorConfig` and wire it into goal gate evaluation in `packages/factory/src/graph/executor.ts` (AC: #2, #3, #4, #5)
  - [x] Import `QualityMode`, `CONTEXT_KEY_CODE_REVIEW_VERDICT`, `createDualSignalCoordinator` from `'../convergence/index.js'`; also import `DualSignalVerdict` type
  - [x] Add `qualityMode?: QualityMode` field to `GraphExecutorConfig` interface with JSDoc: `/** Quality mode for goal gate evaluation — wired from FactoryConfig.quality_mode. Story 46-6. */`
  - [x] In the exit-node goal gate section (around line 474), modify the `checkGoalGates` call to also use satisfaction score when `qualityMode === 'scenario-primary'`:
    ```typescript
    const useScenarioPrimary = config.qualityMode === 'scenario-primary'
    const gateResult = controller.checkGoalGates(
      graph,
      config.runId,
      config.eventBus,
      (useScenarioPrimary || config.satisfactionThreshold !== undefined)
        ? { context, satisfactionThreshold: config.satisfactionThreshold ?? 0.8 }
        : undefined,
    )
    ```
  - [x] After `checkGoalGates`, when `useScenarioPrimary` is true and `eventBus` is present, emit `scenario:advisory-computed` by creating a `DualSignalCoordinator` and calling `evaluate`:
    ```typescript
    if (useScenarioPrimary && config.eventBus) {
      const codeReviewVerdict = context.getString(CONTEXT_KEY_CODE_REVIEW_VERDICT, '') as DualSignalVerdict
      if (codeReviewVerdict !== '') {
        const coordinator = createDualSignalCoordinator({
          eventBus: config.eventBus,
          threshold: config.satisfactionThreshold ?? 0.8,
          qualityMode: 'scenario-primary',
        })
        const score = context.getNumber('satisfaction_score', 0)
        coordinator.evaluate(codeReviewVerdict, score, config.runId)
      }
    }
    ```

- [x] Task 5: Wire `quality_mode` and `satisfactionThreshold` in `factory-command.ts` (AC: #6)
  - [x] In `packages/factory/src/factory-command.ts`, inside `executor.run(graph, { ... })`, add after `plateauThreshold`:
    ```typescript
    satisfactionThreshold: factoryConfig.factory?.satisfaction_threshold ?? 0.8,
    qualityMode: factoryConfig.factory?.quality_mode ?? 'dual-signal',
    ```
  - [x] No new imports needed — `QualityMode` is inferred via `GraphExecutorConfig`

- [x] Task 6: Update barrel exports in `packages/factory/src/convergence/index.ts` and verify factory `index.ts` re-exports (AC: #7)
  - [x] In `packages/factory/src/convergence/index.ts`, extend the dual-signal export block:
    ```typescript
    // Dual-signal coordinator — story 46-5/46-6
    export type { DualSignalVerdict, DualSignalAgreement, DualSignalResult, DualSignalCoordinator, DualSignalCoordinatorOptions, QualityMode } from './dual-signal.js'
    export { evaluateDualSignal, createDualSignalCoordinator, CONTEXT_KEY_CODE_REVIEW_VERDICT } from './dual-signal.js'
    ```
  - [x] Confirm `packages/factory/src/index.ts` re-exports `* from './convergence/index.js'` — no changes needed there

- [x] Task 7: Write unit tests (AC: #1–#7)
  - [x] Create `packages/factory/src/convergence/__tests__/scenario-primary.test.ts` with ≥ 12 test cases:
    - Test coordinator emits `scenario:advisory-computed` when `qualityMode === 'scenario-primary'` and verdict is provided
    - Test advisory event payload: `verdict`, `codeReviewPassed`, `score`, `threshold`, `agreement` all correct
    - Test coordinator in `scenario-primary` mode: `SHIP_IT` + score 0.3 → advisory emitted with `codeReviewPassed: true`, `agreement: 'DISAGREE'`
    - Test coordinator in `scenario-primary` mode: `NEEDS_MAJOR_REWORK` + score 0.9 → advisory emitted with `codeReviewPassed: false`, `agreement: 'DISAGREE'`
    - Test coordinator in `dual-signal` mode (default): no `scenario:advisory-computed` emitted
    - Test `scenario:score-computed` still emitted in `scenario-primary` mode (dual emission)
  - [x] Create `packages/factory/src/config.__tests__/quality-mode.test.ts` (or add to nearest existing config test file) with ≥ 4 test cases:
    - Test `quality_mode: 'scenario-primary'` parses correctly
    - Test `quality_mode: 'dual-signal'` is the default when omitted
    - Test invalid `quality_mode` value throws Zod error
    - Test all four valid values parse without error
  - [x] Executor-level tests added in `packages/factory/src/__tests__/integration/epic46-scenario-primary-executor.test.ts` for AC2, AC3 (executor gateResult.satisfied verification)
  - [x] AC6 wiring tests added in `packages/factory/src/__tests__/factory-run-command.test.ts` for quality_mode and satisfaction_threshold pass-through
  - [x] After implementation, run: `npm run test:fast` (with `timeout: 300000`); confirm "Test Files" line appears in output — do NOT pipe through `grep` or `head`

## Dev Notes

### Architecture Constraints
- All imports in `dual-signal.ts` must use `.js` extension (ESM): e.g., `import type { FactoryEvents } from '../events.js'`
- Import `TypedEventBus` from `@substrate-ai/core` (not a relative path)
- `evaluateDualSignal` pure function must NOT be modified — it has no `qualityMode` parameter and remains side-effect free. The `qualityMode` branching lives entirely in `createDualSignalCoordinator` (the side-effect boundary)
- `CONTEXT_KEY_CODE_REVIEW_VERDICT = 'factory.codeReviewVerdict'` is the convention for how SDLC/codergen handlers store their code review verdict in context. SDLC handlers may import this constant from `@substrate-ai/factory` — this is safe because SDLC → factory dependency is allowed (ADR-003 prohibits factory → sdlc, not sdlc → factory)
- `FactoryConfigSchema` uses `.strict()` — the new `quality_mode` field must be added inside the `z.object({...})` block, not appended after `.strict()`
- Do NOT add `quality_mode` to `FactoryExtendedConfigSchema` separately — it inherits from `FactoryConfigSchema` via `SubstrateConfigSchema.extend({ factory: FactoryConfigSchema.optional() })`

### Goal Gate Logic After This Story
| `qualityMode` | `satisfactionThreshold` provided | Gate uses |
|---|---|---|
| `'dual-signal'` (default) | No | Outcome status (code review verdict → node SUCCESS/FAIL) |
| `'dual-signal'` | Yes | Satisfaction score |
| `'scenario-primary'` | Any | Satisfaction score (forced, default 0.8) |
| `'code-review'` | No | Outcome status |

### Advisory Event Emission Pattern
The `scenario:advisory-computed` event is emitted ONLY when:
1. `qualityMode === 'scenario-primary'`
2. `context.getString(CONTEXT_KEY_CODE_REVIEW_VERDICT, '')` is non-empty
3. An `eventBus` is present

If no code review verdict is in context (e.g., the pipeline didn't include a code review node), the advisory event is silently skipped — the gate still uses satisfaction score.

### Mock Pattern for Advisory Event Tests
```typescript
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'

const mockBus = { emit: vi.fn() } as unknown as TypedEventBus<FactoryEvents>
const coordinator = createDualSignalCoordinator({
  eventBus: mockBus,
  threshold: 0.8,
  qualityMode: 'scenario-primary',
})
coordinator.evaluate('NEEDS_MAJOR_REWORK', 0.9, 'run-1')
expect(mockBus.emit).toHaveBeenCalledWith('scenario:advisory-computed', expect.objectContaining({
  runId: 'run-1',
  verdict: 'NEEDS_MAJOR_REWORK',
  codeReviewPassed: false,
  score: 0.9,
  threshold: 0.8,
  agreement: 'DISAGREE',
}))
```

### File Paths
- **Modified**: `packages/factory/src/config.ts` — add `quality_mode` to `FactoryConfigSchema`
- **Modified**: `packages/factory/src/events.ts` — add `'scenario:advisory-computed'` event
- **Modified**: `packages/factory/src/convergence/dual-signal.ts` — add `QualityMode`, `CONTEXT_KEY_CODE_REVIEW_VERDICT`, extend `DualSignalCoordinatorOptions`, update `createDualSignalCoordinator`
- **Modified**: `packages/factory/src/convergence/index.ts` — re-export new exports from dual-signal
- **Modified**: `packages/factory/src/graph/executor.ts` — add `qualityMode` to config, scenario-primary goal gate logic, advisory event emission
- **Modified**: `packages/factory/src/factory-command.ts` — wire `quality_mode` and `satisfaction_threshold` from config to executor
- **New**: `packages/factory/src/convergence/__tests__/scenario-primary.test.ts` — coordinator advisory tests (≥ 6 test cases)
- **New or Modified**: config test file — `quality_mode` schema tests (≥ 4 test cases)

### Dependency Notes
- **Depends on 46-5**: `dual-signal.ts`, `DualSignalCoordinatorOptions`, `evaluateDualSignal`, and `createDualSignalCoordinator` all exist from story 46-5. This story extends them.
- **Depends on 46-2**: `CheckGoalGatesOptions` interface and `satisfactionThreshold` flow through `checkGoalGates()` were set up in story 46-2. This story relies on that infrastructure working.
- **Does NOT require SDLC changes**: The `CONTEXT_KEY_CODE_REVIEW_VERDICT` convention is defined here; SDLC handlers that write the verdict are updated separately (not in scope for this story).
- **Story 46-7 and 46-8 depend on this story**: Integration tests and cross-project validation will rely on `quality_mode` being wired end-to-end.

### Testing Requirements
- Test files: use `vitest` with `describe` / `it` / `expect` / `vi.fn()`
- No `vi.mock()` needed — all side effects are injectable via `mockBus`
- Verify both `scenario:score-computed` AND `scenario:advisory-computed` are emitted in scenario-primary mode (dual emission)
- After implementation, run `npm run test:fast` with `timeout: 300000` — confirm "Test Files" line in output; never pipe output through `grep` or `head`

## Interface Contracts

- **Export**: `QualityMode` @ `packages/factory/src/convergence/dual-signal.ts` (consumed by executor config and factory-command.ts)
- **Export**: `CONTEXT_KEY_CODE_REVIEW_VERDICT` @ `packages/factory/src/convergence/dual-signal.ts` (used by SDLC handlers to write verdict; consumed by executor to read it)
- **Import**: `DualSignalCoordinatorOptions` @ `packages/factory/src/convergence/dual-signal.ts` (from story 46-5, extended in this story)
- **Import**: `evaluateDualSignal` @ `packages/factory/src/convergence/dual-signal.ts` (from story 46-5, unchanged)
- **Import**: `FactoryConfig.satisfaction_threshold` @ `packages/factory/src/config.ts` (from story 46-2, now wired in factory-command.ts)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
