# Story 43-2: SDLC Phase Handler

## Story

As a graph engine operator,
I want an `SdlcPhaseHandler` that executes SDLC pipeline phases via a `NodeHandler`-compatible factory function,
so that analysis, planning, and solutioning phase nodes in the SDLC DOT graph delegate correctly to the existing phase orchestration logic — including entry/exit gate evaluation — and return a typed `Outcome` to the graph executor.

## Acceptance Criteria

### AC1: Analysis Phase Delegation
**Given** a graph node with `id="analysis"`, `type="sdlc.phase"`, and `prompt="Analyze project concept"` and a context with `runId` and `concept` set
**When** the handler executes
**Then** it calls `runAnalysisPhase(deps, { runId, concept })` and, on success, returns `{ status: 'SUCCESS' }` with the phase artifact data in `contextUpdates`

### AC2: Planning Phase Delegation
**Given** a graph node with `id="planning"`, `type="sdlc.phase"`, and a context with `runId` set
**When** the handler executes and the phase completes successfully
**Then** it returns `{ status: 'SUCCESS' }` with the phase output included in `contextUpdates`

### AC3: Phase Dispatch Failure Returns FAILURE Outcome
**Given** a graph node for any SDLC phase (e.g., `solutioning`)
**When** the underlying `run*Phase` function throws or returns an error
**Then** the handler returns `{ status: 'FAILURE', failureReason: <error message> }` without re-throwing, matching the existing phase failure contract

### AC4: Gate Failure Returns FAILURE Outcome
**Given** a graph node for any SDLC phase
**When** `PhaseOrchestrator.advancePhase(runId)` reports that entry or exit gates failed (i.e., `advanced === false`)
**Then** the handler returns `{ status: 'FAILURE', failureReason: <concatenated gate failure messages> }`, exactly preserving the gate failure detail from `AdvancePhaseResult.gateFailures`

### AC5: Phase Name Resolved from Node ID
**Given** a graph node with `id="solutioning"` and `type="sdlc.phase"`
**When** the handler is invoked
**Then** it dispatches to `runSolutioningPhase` (not analysis or planning), proving phase selection is driven by `node.id`

### AC6: Factory Function Pattern and Dependency Injection
**Given** the exported `createSdlcPhaseHandler(deps)` factory is called with a complete `SdlcPhaseHandlerDeps` object
**When** the returned handler function is invoked
**Then** it uses the injected `orchestrator`, `phaseDeps`, and optional `advanceAfterRun` flag without accessing any external singletons

### AC7: Unknown Phase Node Returns FAILURE Outcome
**Given** a graph node with `id="unsupported-phase"` and `type="sdlc.phase"` that has no corresponding runner
**When** the handler executes
**Then** it returns `{ status: 'FAILURE', failureReason: 'No phase runner registered for phase: unsupported-phase' }` without throwing

## Tasks / Subtasks

- [ ] Task 1: Define `SdlcPhaseHandlerDeps` interface and local handler type alias in `packages/sdlc/src/handlers/types.ts` (AC: #6)
  - [ ] Define `SdlcNodeHandler` as a local type alias: `(node: { id: string; label: string; prompt: string }, context: { getString(key: string, defaultValue?: string): string }, graph: unknown) => Promise<SdlcOutcome>`
  - [ ] Define `SdlcOutcome` interface with fields: `status: 'SUCCESS' | 'FAILURE' | 'PARTIAL_SUCCESS' | 'NEEDS_RETRY' | 'ESCALATE'`, `failureReason?: string`, `contextUpdates?: Record<string, unknown>`, `notes?: string`
  - [ ] Define `SdlcPhaseHandlerDeps` interface with: `orchestrator: PhaseOrchestrator`, `phaseDeps: PhaseDeps`, `advanceAfterRun?: boolean` (defaults to `true` — call `advancePhase` after each phase runner)
  - [ ] Import `PhaseOrchestrator` from `../../modules/phase-orchestrator/phase-orchestrator.js` (monolith path, pre-extraction) and `PhaseDeps` from `../../modules/phase-orchestrator/phases/types.js`
  - [ ] Export all defined types as named exports

- [ ] Task 2: Implement `createSdlcPhaseHandler` factory in `packages/sdlc/src/handlers/sdlc-phase-handler.ts` (AC: #1, #2, #5, #6)
  - [ ] Create `packages/sdlc/src/handlers/` directory if not present
  - [ ] Import `runAnalysisPhase` from `../../modules/phase-orchestrator/phases/analysis.js`, `runPlanningPhase` from `./phases/planning.js`, `runSolutioningPhase` from `./phases/solutioning.js` (monolith source paths)
  - [ ] Import types from `./types.js`
  - [ ] Build a `PHASE_RUNNERS` map: `Map<string, (deps: PhaseDeps, params: any) => Promise<Record<string, unknown>>>`
    - Key `'analysis'` → calls `runAnalysisPhase(deps, { runId, concept })` and returns `{ analysisResult: result }` in a plain object
    - Key `'planning'` → calls `runPlanningPhase(deps, { runId })` and returns `{ planningResult: result }`
    - Key `'solutioning'` → calls `runSolutioningPhase(deps, { runId })` and returns `{ solutioningResult: result }`
  - [ ] Implement `createSdlcPhaseHandler(deps: SdlcPhaseHandlerDeps): SdlcNodeHandler` as a factory function
  - [ ] The returned handler: (a) extracts `phaseName = node.id`; (b) extracts `runId = context.getString('runId')`; (c) extracts `concept = context.getString('concept')` for analysis phase
  - [ ] Export `createSdlcPhaseHandler` as a named export

- [ ] Task 3: Implement phase dispatch and gate-advance logic (AC: #1, #2, #4, #5)
  - [ ] Inside the returned handler, look up the runner: `const runner = PHASE_RUNNERS.get(phaseName)`
  - [ ] If no runner found → return `{ status: 'FAILURE', failureReason: \`No phase runner registered for phase: ${phaseName}\` }` (satisfies AC7)
  - [ ] Wrap runner call in `try/catch`; on error return `{ status: 'FAILURE', failureReason: error.message ?? String(error) }` (satisfies AC3)
  - [ ] If `deps.advanceAfterRun !== false`, call `deps.orchestrator.advancePhase(runId)` after runner completes
  - [ ] If `advancePhase` returns `{ advanced: false }`, collect gate failure messages: `result.gateFailures?.map(f => \`${f.gate}: ${f.error}\`).join('; ')` and return `{ status: 'FAILURE', failureReason: <message> }` (satisfies AC4)
  - [ ] On full success, return `{ status: 'SUCCESS', contextUpdates: { ...phaseOutput, advancedPhase: advanceResult.phase } }`

- [ ] Task 4: Create barrel export `packages/sdlc/src/handlers/index.ts` (AC: all)
  - [ ] Create or update `packages/sdlc/src/handlers/index.ts`
  - [ ] Re-export `createSdlcPhaseHandler` from `./sdlc-phase-handler.js`
  - [ ] Re-export `SdlcPhaseHandlerDeps`, `SdlcNodeHandler`, `SdlcOutcome` from `./types.js`

- [ ] Task 5: Update `packages/sdlc/src/index.ts` to re-export handlers barrel (AC: #6)
  - [ ] Add `export * from './handlers/index.js'` to `packages/sdlc/src/index.ts`

- [ ] Task 6: Write unit tests in `packages/sdlc/src/handlers/__tests__/sdlc-phase-handler.test.ts` (AC: #1–#7)
  - [ ] Create `packages/sdlc/src/handlers/__tests__/` directory
  - [ ] Mock `runAnalysisPhase`, `runPlanningPhase`, `runSolutioningPhase` using `vi.mock`
  - [ ] Mock `PhaseOrchestrator.advancePhase` returning `{ advanced: true, phase: 'planning' }` by default
  - [ ] Test AC1: node.id=`analysis` dispatches `runAnalysisPhase`; result in contextUpdates; status=`SUCCESS`
  - [ ] Test AC2: node.id=`planning` dispatches `runPlanningPhase`; result in contextUpdates; status=`SUCCESS`
  - [ ] Test AC3: runner throws `new Error('dispatch failed')` → `{ status: 'FAILURE', failureReason: 'dispatch failed' }`
  - [ ] Test AC4: `advancePhase` returns `{ advanced: false, gateFailures: [{ gate: 'analysis-complete', error: 'no artifact' }] }` → `{ status: 'FAILURE', failureReason: 'analysis-complete: no artifact' }`
  - [ ] Test AC5: node.id=`solutioning` calls `runSolutioningPhase`, NOT analysis or planning
  - [ ] Test AC6: factory function accepts deps, returned handler has correct arity
  - [ ] Test AC7: node.id=`unsupported-phase` → `{ status: 'FAILURE', failureReason: 'No phase runner registered for phase: unsupported-phase' }`
  - [ ] Test `advanceAfterRun: false` flag skips `advancePhase` call
  - [ ] Run `npm run test:fast` to verify all tests pass

- [ ] Task 7: Verify build succeeds and no circular dependencies introduced (AC: all)
  - [ ] Run `npm run build` from monorepo root
  - [ ] Confirm `packages/sdlc` has no import from `packages/factory` (check with `grep -r "@substrate-ai/factory" packages/sdlc/src/`)
  - [ ] Confirm `packages/factory` has no import from `packages/sdlc` (structural constraint from ADR-003)

## Dev Notes

### Architecture Constraints

- **File paths (new):**
  - `packages/sdlc/src/handlers/types.ts` — local type aliases for node/context/outcome shapes; does NOT import from `@substrate-ai/factory`
  - `packages/sdlc/src/handlers/sdlc-phase-handler.ts` — factory function + PHASE_RUNNERS map
  - `packages/sdlc/src/handlers/index.ts` — barrel; re-exports handler and types
  - `packages/sdlc/src/handlers/__tests__/sdlc-phase-handler.test.ts` — Vitest unit tests
- **File paths (modified):**
  - `packages/sdlc/src/index.ts` — add `export * from './handlers/index.js'`

- **Cross-package import constraint (ADR-003):** `packages/sdlc` must NOT import from `@substrate-ai/factory`. The `SdlcNodeHandler` type defined locally in `packages/sdlc/src/handlers/types.ts` is structurally compatible with `NodeHandler` from `@substrate-ai/factory` — TypeScript's structural typing ensures the CLI composition root can assign one to the other without any sdlc→factory import.

- **Import style:** All relative imports use `.js` extensions (ESM): e.g., `import { runAnalysisPhase } from '../../modules/phase-orchestrator/phases/analysis.js'`

- **Monolith source paths:** During Epic 43, the phase runner functions (`runAnalysisPhase`, etc.) still live in `src/modules/phase-orchestrator/phases/`. The `packages/sdlc` package imports them from the monolith at dev time. If the build setup disallows cross-package monolith imports, use path aliases defined in `tsconfig.json` (check existing pattern in the sdlc package).

- **`advanceAfterRun` flag:** Defaults to `true`. This allows callers (CLI, tests) to disable the advance step when they manage phase advancement externally or in integration scenarios where only the phase runner is being tested.

- **`concept` extraction:** Only the analysis phase uses `concept`. Extract it as `context.getString('concept', '')`. Other phases ignore it; include in the runner call only when `phaseName === 'analysis'`.

- **Error boundary:** The outer `try/catch` wraps both the runner call AND the `advancePhase` call. If `advancePhase` itself throws (network/DB error), the handler catches it and returns `{ status: 'FAILURE', failureReason: 'advancePhase error: ...' }`.

### Phase Runner Dispatch Table

| node.id | Runner function | Phase params |
|---|---|---|
| `analysis` | `runAnalysisPhase` | `{ runId, concept }` |
| `planning` | `runPlanningPhase` | `{ runId }` |
| `solutioning` | `runSolutioningPhase` | `{ runId }` |

Additional phases (e.g., `ux-design`) can be added to `PHASE_RUNNERS` in a follow-on story without modifying the handler core.

### Testing Requirements

- **Test framework:** Vitest (already configured in the monorepo)
- **Run during development:** `npm run test:fast` (unit-only, ~50s, no e2e)
- **Confirm pass:** look for "Test Files" line in output — exit code alone is insufficient
- **Never pipe output** through `head`, `tail`, or `grep` — this discards the vitest summary
- **Mock strategy:** Use `vi.mock` at the module level to stub `runAnalysisPhase`, `runPlanningPhase`, `runSolutioningPhase`, and `PhaseOrchestrator`; avoid real DB or LLM calls
- **Target coverage:** ≥ 90% branch coverage on `sdlc-phase-handler.ts`

### Context Keys

The handler reads these keys from `IGraphContext` (or the locally typed equivalent):

| Key | Type | Required by |
|---|---|---|
| `runId` | string | all phases |
| `concept` | string | analysis phase only |

The CLI or graph initialization step (story 43-10) is responsible for writing these values into the context before the graph executes.

## Interface Contracts

- **Export**: `createSdlcPhaseHandler` @ `packages/sdlc/src/handlers/sdlc-phase-handler.ts` (consumed by CLI composition root in story 43-6 for handler registry registration)
- **Export**: `SdlcPhaseHandlerDeps` @ `packages/sdlc/src/handlers/types.ts` (consumed by CLI in story 43-6)
- **Export**: `SdlcNodeHandler`, `SdlcOutcome` @ `packages/sdlc/src/handlers/types.ts` (consumed by other SDLC handler stories 43-3, 43-4, 43-5 for type consistency)
- **Import**: `runAnalysisPhase` @ `src/modules/phase-orchestrator/phases/analysis.ts` (from monolith, pre-existing)
- **Import**: `runPlanningPhase` @ `src/modules/phase-orchestrator/phases/planning.ts` (from monolith, pre-existing)
- **Import**: `runSolutioningPhase` @ `src/modules/phase-orchestrator/phases/solutioning.ts` (from monolith, pre-existing)
- **Import**: `PhaseOrchestrator` @ `src/modules/phase-orchestrator/phase-orchestrator.ts` (from monolith, pre-existing)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
