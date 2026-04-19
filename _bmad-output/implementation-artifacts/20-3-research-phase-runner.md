# Story 20.3: Research Phase Runner

Status: ready-for-dev

## Story

As a pipeline operator,
I want the research phase to execute its 2-step workflow and persist findings to the decision store,
so that downstream phases can consume validated research context.

## Acceptance Criteria

### AC1: Step definitions
**Given** `buildResearchSteps()` is called
**When** the step definitions are returned
**Then** there are exactly 2 steps named `research-step-1-discovery` and `research-step-2-synthesis`, each with the correct `taskType` and `outputSchema` from schemas.ts

### AC2: Step context sources
**Given** the step definitions are built
**When** their context arrays are inspected
**Then** step 1 has context `{ placeholder: 'concept', source: 'param:concept' }` and step 2 has context `{ placeholder: 'concept', source: 'param:concept' }` plus `{ placeholder: 'raw_findings', source: 'step:research-step-1-discovery' }`

### AC3: Step behavior flags
**Given** the step definitions are built
**When** their flags are inspected
**Then** step 1 has `elicitate: true` and step 2 has `critique: true` (using the `critique-research` prompt registered in the manifest)

### AC4: Decision store persistence
**Given** both steps complete successfully
**When** the results are persisted
**Then** the decision store contains entries under category `research.findings` (or equivalent) with keys for each synthesis dimension: `market_context`, `competitive_landscape`, `technical_feasibility`, `risk_flags`, `opportunity_signals`

### AC5: Artifact registration
**Given** the research phase completes successfully
**When** the phase exits
**Then** a `research-findings` artifact is registered for the current run (either by the step runner via `registerArtifact` on the last step, or by the fallback path in `runResearchPhase`)

### AC6: Phase result type
**Given** the research phase completes (success or failure)
**When** the result is returned
**Then** it conforms to the `ResearchResult` interface: `result: 'success' | 'failed'`, `artifact_id?: string`, `error?: string`, `details?: string`, `tokenUsage: { input: number, output: number }` — matching the `UxDesignResult` pattern exactly

### AC7: Phase failure handling
**Given** any step fails or an exception is thrown
**When** the phase result is returned
**Then** `result: 'failed'` is returned with the error message in `error`, no `artifact_id`, and `tokenUsage` reflecting usage up to the point of failure (zero on caught exceptions)

## Tasks / Subtasks

- [ ] Task 1: Add `ResearchPhaseParams` and `ResearchResult` types to `types.ts` (AC: #6)
  - [ ] `ResearchPhaseParams`: `runId: string`, `concept: string`
  - [ ] `ResearchResult`: follow `UxDesignResult` pattern exactly — `result`, `artifact_id?`, `error?`, `details?`, `tokenUsage`
  - [ ] Add JSDoc comments following the existing style

- [ ] Task 2: Create `src/modules/phase-orchestrator/phases/research.ts` (AC: #1, #2, #3, #4, #5, #7)
  - [ ] Import `registerArtifact` from `../../../persistence/queries/decisions.js`
  - [ ] Import `runSteps` and `StepDefinition` from `../step-runner.js`
  - [ ] Import `ResearchDiscoveryOutputSchema`, `ResearchSynthesisOutputSchema` from `./schemas.js`
  - [ ] Import `ResearchPhaseParams`, `ResearchResult`, `PhaseDeps` from `./types.js`
  - [ ] Implement `buildResearchSteps(): StepDefinition[]` — returns 2 step definitions:
    - Step 1 (`research-step-1-discovery`): taskType `research-discovery`, context `param:concept`, persist discovery fields to `research` category, `elicitate: true`
    - Step 2 (`research-step-2-synthesis`): taskType `research-synthesis`, context `param:concept` + `step:research-step-1-discovery`, persist synthesis fields to `research` category with keys matching AC4, `registerArtifact` for `research-findings`, `critique: true`
  - [ ] Implement `runResearchPhase(deps, params): Promise<ResearchResult>` — follows `runUxDesignPhase` pattern exactly:
    - Call `runSteps(steps, deps, runId, 'research', { concept: params.concept })`
    - On `!result.success`: return `result: 'failed'` with error and tokenUsage
    - Extract `artifactId` from last step; if missing, call `registerArtifact` fallback
    - Return `result: 'success'` with `artifact_id` and `tokenUsage`
    - Wrap in try/catch; return `result: 'failed'` with zero tokenUsage on exception

- [ ] Task 3: Add research phase step definitions to `packs/bmad/manifest.yaml` (AC: #1, #2, #3)
  - [ ] Add research phase entry with steps array
  - [ ] Step 1: template `research-step-1-discovery`, context `[param:concept]`, elicitate true
  - [ ] Step 2: template `research-step-2-synthesis`, context `[param:concept, step:research-step-1-discovery]`, critique true
  - [ ] Follow the existing ux-design phase manifest structure exactly

- [ ] Task 4: Wire `runResearchPhase()` into `runFullPipeline()` in `src/cli/commands/run.ts` (AC: #7)
  - [ ] Add `import { runResearchPhase } from '../../modules/phase-orchestrator/phases/research.js'`
  - [ ] Add `research` case to the phase execution switch/conditional block
  - [ ] Pass `{ runId, concept }` as params (concept available from pipeline params)
  - [ ] Record token usage following analysis/planning/ux-design pattern
  - [ ] Handle `result: 'failed'` with appropriate error output and exit

- [ ] Task 5: Write unit tests for `buildResearchSteps()` (AC: #1, #2, #3)
  - [ ] Test step count is exactly 2
  - [ ] Test step names: `research-step-1-discovery`, `research-step-2-synthesis`
  - [ ] Test context sources for each step (AC2)
  - [ ] Test `elicitate: true` on step 1, `critique: true` on step 2
  - [ ] Test persist field mappings on both steps (category, keys)
  - [ ] Test `registerArtifact` config on step 2 (type `research-findings`)
  - [ ] Follow `ux-design.test.ts` test structure

- [ ] Task 6: Write unit tests for `runResearchPhase()` (AC: #5, #6, #7)
  - [ ] Mock `PhaseDeps` (db, pack, contextCompiler, dispatcher)
  - [ ] Test success path: `runSteps` returns success → artifact registered → `ResearchResult` with `result: 'success'` and `artifact_id`
  - [ ] Test success path fallback: artifact missing from last step → `registerArtifact` called manually
  - [ ] Test failure path: `runSteps` returns `!success` → `result: 'failed'` with error details
  - [ ] Test exception path: `runSteps` throws → `result: 'failed'` with zero tokenUsage
  - [ ] Follow `ux-design.test.ts` test patterns

- [ ] Task 7: Write integration test for full research phase execution (AC: #4, #5)
  - [ ] Create `src/modules/phase-orchestrator/__tests__/research-phase-integration.test.ts`
  - [ ] End-to-end with mocked dispatcher that returns valid YAML for both steps
  - [ ] Verify decision store contains expected keys after success (`market_context`, `competitive_landscape`, `technical_feasibility`, `risk_flags`, `opportunity_signals`)
  - [ ] Verify `research-findings` artifact exists in DB after success
  - [ ] Follow `ux-design-integration.test.ts` as reference

## Dev Notes

### Architecture Constraints
- Follow `ux-design.ts` implementation pattern **exactly** — same structure, same try/catch shape, same artifact registration fallback, same token usage propagation
- Step definitions use the `StepDefinition` type from `step-runner.ts` — no changes to step-runner needed
- Context sources: `param:concept` (step runner resolves from `params` passed to `runSteps`) and `step:research-step-1-discovery` (resolved from completed step outputs)
- Persist fields map step output schema fields to decision store `(category, key)` pairs — use `research` as the category for all persist entries
- Step 2's `registerArtifact` config uses type `research-findings` and path `decision-store://research/research-findings`
- The fallback `registerArtifact` call in `runResearchPhase` uses the same type and path
- The `runSteps` call signature: `runSteps(steps, deps, runId, 'research', { concept: params.concept })` — the 5th argument is the extra params object that satisfies `param:concept` context sources

### Key Files
- **New:** `src/modules/phase-orchestrator/phases/research.ts`
- **Modified:** `src/modules/phase-orchestrator/phases/types.ts` — add `ResearchPhaseParams` and `ResearchResult`
- **Reference:** `src/modules/phase-orchestrator/phases/ux-design.ts` — copy structure exactly
- **Modified:** `packs/bmad/manifest.yaml` — add research phase step definitions
- **Modified:** `src/cli/commands/run.ts` — wire into pipeline (research case added after scaffolding from 20-1)
- **New:** `src/modules/phase-orchestrator/__tests__/research-phase-integration.test.ts`
- **New:** `src/modules/phase-orchestrator/phases/__tests__/research.test.ts`

### Testing Requirements
- Test framework: **vitest** (not jest — `--testPathPattern` flag does not work, use vitest pattern matching)
- Coverage thresholds: 80% enforced — run full suite with `npm test`, not filtered runs
- Unit tests cover step definitions (structure, context sources, flags) and phase runner (success, fallback, failure, exception paths)
- Integration test verifies end-to-end decision store writes and artifact registration with mocked dispatcher
- When mocking `fs` in tests, if ConfigWatcher is involved add `watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn() }))` to prevent regressions

### Dependency on Prior Stories
- **20-1** must be complete first: provides `--research`/`--skip-research` CLI flags and phase scaffolding in `runFullPipeline()`
- **20-2** must be complete first: provides `ResearchDiscoveryOutputSchema`, `ResearchSynthesisOutputSchema`, prompt templates, and `critique-research` manifest registration
- This story (20-3) wires everything together — it depends on schemas from 20-2 and the pipeline slot from 20-1

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
