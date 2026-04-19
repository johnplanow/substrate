# Story 43-13: SDLC Phase Gate Integration with Graph Node Handlers

## Story

As a graph-based SDLC orchestrator,
I want the `SdlcPhaseHandler` to explicitly evaluate entry gates before dispatching and exit gates after dispatching — labeling each failure with its gate phase — so that phase gate failures in the graph engine carry the same diagnostic detail as the linear `PhaseOrchestrator`, and new gates registered via `GateRegistry` are automatically evaluated without changes to the graph engine.

## Acceptance Criteria

### AC1: Entry Gates Evaluated Before Phase Dispatch
**Given** a phase node `analysis [type="sdlc.phase"]` and a `PhaseOrchestrator` that exposes `evaluateEntryGates(runId)`
**When** the `SdlcPhaseHandler` executes
**Then** it calls `evaluateEntryGates(runId)` before invoking the phase runner function, and calls `advancePhase(runId)` after the runner completes — matching the pre-dispatch / post-dispatch gate ordering of the linear `PhaseOrchestrator.advancePhase()` lifecycle

### AC2: Entry Gate Failure Returns Prefixed FAILURE Outcome
**Given** a phase node for any SDLC phase (`analysis`, `planning`, or `solutioning`)
**When** `evaluateEntryGates(runId)` returns `{ passed: false, failures: [{ gate: 'artifact-present', error: 'no concept artifact' }] }`
**Then** the handler returns `{ status: 'FAILURE', failureReason: 'entry gate failed: artifact-present: no concept artifact' }` without invoking the phase runner — the graph engine's retry mechanism handles retry if `max_retries > 0` on the node

### AC3: Exit Gate Failure Returns Prefixed FAILURE Outcome
**Given** a phase node for any SDLC phase
**When** the phase runner completes successfully but `advancePhase(runId)` returns `{ advanced: false, gateFailures: [{ gate: 'prd-complete', error: 'missing sections' }] }`
**Then** the handler returns `{ status: 'FAILURE', failureReason: 'exit gate failed: prd-complete: missing sections' }` — the handler does not retry internally; retry is managed by the graph engine

### AC4: Multiple Gate Failures Concatenated with Prefix
**Given** `evaluateEntryGates` returns two failures: `[{ gate: 'g1', error: 'e1' }, { gate: 'g2', error: 'e2' }]`
**When** the handler returns
**Then** the `failureReason` is `'entry gate failed: g1: e1; g2: e2'` — all failures joined with `'; '`, single `'entry gate failed: '` prefix for the whole list

### AC5: New GateRegistry Gates Evaluated Automatically
**Given** a new gate is registered in the underlying `GateRegistry` (e.g., a `ux-artifacts-present` entry gate)
**When** the `SdlcPhaseHandler` executes
**Then** the new gate is evaluated via the injected `evaluateEntryGates(runId)` or `advancePhase(runId)` calls without any changes to the graph engine or the handler implementation

### AC6: Parity — Gate Checks Fire for All Three Phase Nodes
**Given** `substrate run --engine=graph` runs through `analysis → planning → solutioning`
**When** each phase node executes its `SdlcPhaseHandler`
**Then** entry gate evaluation fires before each runner and exit gate evaluation fires after each runner — producing the same gate-check sequence as the linear `PhaseOrchestrator`

### AC7: PhaseOrchestrator Interface Extended and Exported
**Given** the `evaluateEntryGates` method is added to the local `PhaseOrchestrator` interface in `packages/sdlc/src/handlers/types.ts`
**When** callers import `PhaseOrchestrator` from `@substrate-ai/sdlc`
**Then** the interface includes `evaluateEntryGates(runId: string): Promise<EntryGateResult>` alongside the existing `advancePhase(runId)` method, and the `EntryGateResult` type is exported from the same module

## Tasks / Subtasks

- [x] Task 1: Extend `PhaseOrchestrator` interface and add `EntryGateResult` type in `packages/sdlc/src/handlers/types.ts` (AC: #5, #7)
  - [x] Add `EntryGateResult` interface: `{ passed: boolean; failures?: GateFailure[] }` (reuse existing local `GateFailure` interface already in `types.ts`)
  - [x] Extend `PhaseOrchestrator` interface with: `evaluateEntryGates(runId: string): Promise<EntryGateResult>`
  - [x] Export `EntryGateResult` as a named export from `types.ts`
  - [x] Verify the `GateFailure` interface is exported (it is currently inline — promote to named export if needed)

- [x] Task 2: Add entry gate pre-dispatch check in `packages/sdlc/src/handlers/sdlc-phase-handler.ts` (AC: #1, #2, #4)
  - [x] Inside the returned handler, after resolving `phaseName` and `runId`, call `await deps.orchestrator.evaluateEntryGates(runId)` before invoking the runner
  - [x] If `entryGateResult.passed === false`, format failure message: `'entry gate failed: ' + (entryGateResult.failures?.map(f => \`${f.gate}: ${f.error}\`).join('; ') ?? 'no details')`
  - [x] Return `{ status: 'FAILURE', failureReason: <message> }` without calling the runner
  - [x] Wrap `evaluateEntryGates` call inside the existing outer `try/catch` so unexpected throws are caught and returned as `FAILURE`

- [x] Task 3: Update exit gate failure prefix in `packages/sdlc/src/handlers/sdlc-phase-handler.ts` (AC: #3, #4)
  - [x] Locate the `advancePhase` gate-failure handling block (currently: `advanceResult.gateFailures?.map(f => ...).join('; ')`)
  - [x] Prefix the failure reason with `'exit gate failed: '`: `'exit gate failed: ' + (advanceResult.gateFailures?.map(f => \`${f.gate}: ${f.error}\`).join('; ') ?? 'no details')`
  - [x] Confirm `'exit gate failed: '` prefix is only applied to the `advancePhase` path, not to runner dispatch errors (those remain unprefixed per existing AC3 from story 43-2)

- [x] Task 4: Update barrel export in `packages/sdlc/src/handlers/index.ts` (AC: #7)
  - [x] Add re-export of `EntryGateResult` and `GateFailure` from `./types.js` if not already exported
  - [x] Verify `PhaseOrchestrator` is already re-exported (it was added in story 43-2); if not, add it

- [x] Task 5: Write unit tests for entry gate failure path in `packages/sdlc/src/handlers/__tests__/sdlc-phase-handler.test.ts` (AC: #1, #2, #4)
  - [x] Add `evaluateEntryGates` mock to the existing `PhaseOrchestrator` mock, defaulting to `{ passed: true }`
  - [x] Test AC1: verify `evaluateEntryGates` is called before the runner — use a `vi.fn()` call order assertion or a guard mock that rejects if runner is called first
  - [x] Test AC2: `evaluateEntryGates` returns `{ passed: false, failures: [{ gate: 'g', error: 'e' }] }` → handler returns `{ status: 'FAILURE', failureReason: 'entry gate failed: g: e' }` and runner is NOT called
  - [x] Test AC4 (multi-gate): `evaluateEntryGates` returns two failures → `failureReason` is `'entry gate failed: g1: e1; g2: e2'`
  - [x] Test: `evaluateEntryGates` throws → handler catches and returns `{ status: 'FAILURE', failureReason: <error message> }` (no throw)

- [x] Task 6: Write unit tests for exit gate failure prefix in `packages/sdlc/src/handlers/__tests__/sdlc-phase-handler.test.ts` (AC: #3)
  - [x] Test AC3: `advancePhase` returns `{ advanced: false, gateFailures: [{ gate: 'prd-complete', error: 'missing sections' }] }` → `failureReason` starts with `'exit gate failed: '`
  - [x] Test: exit gate failure reason does NOT start with `'entry gate failed: '` (guard against prefix mix-up)
  - [x] Test: runner dispatch error (runner throws) → `failureReason` is just the raw error message (no prefix) — existing behavior preserved
  - [x] Run `npm run test:fast` to verify all tests pass with no regressions

- [x] Task 7: Build and parity verification (AC: #5, #6)
  - [x] Run `npm run build` from monorepo root — zero TypeScript errors
  - [x] Confirm `packages/sdlc` has no import from `@substrate-ai/factory` in handler files: `grep -r "@substrate-ai/factory" packages/sdlc/src/handlers/`
  - [x] Confirm `packages/factory` has no import from `packages/sdlc` (ADR-003 constraint)
  - [x] Run `npm run test:fast` — all tests pass, no regressions in sdlc or factory packages

## Dev Notes

### Architecture Constraints

- **ADR-003 (zero cross-package compile coupling in handlers):** `packages/sdlc/src/handlers/` files must NOT import from `@substrate-ai/factory`. The `EntryGateResult` and updated `PhaseOrchestrator` interface are defined locally in `types.ts`. The CLI composition root (`src/cli/commands/sdlc-graph-setup.ts`) is the only file permitted to import from both packages.

- **File paths (modified):**
  - `packages/sdlc/src/handlers/types.ts` — add `EntryGateResult` interface, extend `PhaseOrchestrator` with `evaluateEntryGates`, promote `GateFailure` to named export if inline
  - `packages/sdlc/src/handlers/sdlc-phase-handler.ts` — add pre-dispatch `evaluateEntryGates` call, update exit gate failure prefix
  - `packages/sdlc/src/handlers/__tests__/sdlc-phase-handler.test.ts` — extend existing tests with entry gate mock and new test cases
  - `packages/sdlc/src/handlers/index.ts` — add `EntryGateResult` and `GateFailure` re-exports if missing

- **Import style:** All relative imports use `.js` extensions (ESM): `import type { EntryGateResult } from './types.js'`

- **Failure reason format — exact strings:**
  - Entry gate failure: `'entry gate failed: ' + failures.map(f => \`${f.gate}: ${f.error}\`).join('; ')`
  - Exit gate failure: `'exit gate failed: ' + failures.map(f => \`${f.gate}: ${f.error}\`).join('; ')`
  - Runner dispatch error: raw `error.message` with no prefix (existing behavior, unchanged)
  - `evaluateEntryGates` throws: raw `error.message` with no prefix (caught by existing outer `try/catch`)

- **`evaluateEntryGates` placement in the handler:** The call must be inside the existing outer `try/catch` block, between the phase name/runner resolution and the runner invocation. This ensures unexpected throws from `evaluateEntryGates` are caught without re-throwing.

- **`advanceAfterRun` flag:** When `deps.advanceAfterRun === false`, the handler should still call `evaluateEntryGates` (entry gates are always checked). Only the `advancePhase()` post-runner call is skipped by this flag. This maintains the existing `advanceAfterRun` contract from story 43-2.

- **Null fallback for empty failures array:** If `evaluateEntryGates` returns `{ passed: false, failures: undefined }`, the handler should still return a coherent message: `'entry gate failed: no details'` (not `'entry gate failed: undefined'`).

### Updated Handler Control Flow

```
evaluateEntryGates(runId)
  └─ passed === false → return { status: 'FAILURE', failureReason: 'entry gate failed: ...' }

runner(phaseDeps, params)
  └─ throws → return { status: 'FAILURE', failureReason: error.message }

if advanceAfterRun !== false:
  advancePhase(runId)
    └─ advanced === false → return { status: 'FAILURE', failureReason: 'exit gate failed: ...' }
    └─ advanced === true  → return { status: 'SUCCESS', contextUpdates: { ...phaseOutput, advancedPhase } }

if advanceAfterRun === false:
  return { status: 'SUCCESS', contextUpdates: phaseOutput }
```

### Testing Requirements

- **Test framework:** Vitest (already configured)
- **Run during development:** `npm run test:fast` (unit-only, ~50s, no e2e/coverage)
- **Confirm pass:** look for "Test Files" line in output — exit code alone is insufficient
- **Never pipe output** through `head`, `tail`, or `grep` — this discards the vitest summary
- **Mock strategy:** Extend existing `vi.fn()` mocks for `PhaseOrchestrator` in `sdlc-phase-handler.test.ts` — add `evaluateEntryGates` as a new mock method returning `{ passed: true }` by default. No `vi.mock` needed for new tests; inject directly via `SdlcPhaseHandlerDeps`.
- **Call order assertion:** To verify entry gates fire before the runner, use a shared `callOrder: string[]` array and push `'entryGate'` / `'runner'` from each mock, then assert `callOrder[0] === 'entryGate'`.
- **Target coverage:** ≥ 90% branch coverage on updated `sdlc-phase-handler.ts`

### Context Keys

No new context keys are required. The handler reads `runId` from the graph context (set in story 43-10) and passes it to `evaluateEntryGates(runId)` and `advancePhase(runId)` — same as the existing runner dispatch.

## Interface Contracts

- **Export**: `EntryGateResult` @ `packages/sdlc/src/handlers/types.ts` (new type, consumed by CLI composition root and tests)
- **Export**: `GateFailure` @ `packages/sdlc/src/handlers/types.ts` (promoted to named export if currently inline)
- **Import**: `PhaseOrchestrator.evaluateEntryGates` (injected at runtime by CLI composition root in story 43-6; concrete implementation is the monolith's `PhaseOrchestrator` which is structurally compatible)

## Dev Agent Record

### Agent Model Used
claude-opus-4-5

### Completion Notes List
- All 7 tasks implemented and verified
- 29 tests pass in sdlc-phase-handler.test.ts (up from original count)
- Full test suite: 333 files, 7495 tests all green
- Build: zero TypeScript errors
- ADR-003 satisfied: no runtime imports from @substrate-ai/factory in handler files

### File List
- packages/sdlc/src/handlers/types.ts
- packages/sdlc/src/handlers/sdlc-phase-handler.ts
- packages/sdlc/src/handlers/__tests__/sdlc-phase-handler.test.ts
- packages/sdlc/src/handlers/index.ts

## Change Log

- 2026-03-22: Story created for Epic 43, Phase A — SDLC Pipeline as Graph
