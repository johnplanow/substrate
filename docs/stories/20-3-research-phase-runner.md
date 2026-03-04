# Story 20.3: Research Phase Runner

Status: draft

## Story

As a pipeline operator,
I want the research phase to execute its 2-step workflow and persist findings to the decision store,
so that downstream phases can consume research context.

## Acceptance Criteria

### AC1: Step definitions
**Given** `buildResearchSteps()` is called
**When** the step definitions are returned
**Then** there are exactly 2 steps: `research-step-1-discovery` and `research-step-2-synthesis`

### AC2: Step 1 context injection
**Given** step 1 executes
**When** the prompt is assembled
**Then** `{{concept}}` is injected from `param:concept`

### AC3: Step 2 context injection
**Given** step 2 executes
**When** the prompt is assembled
**Then** `{{concept}}` is injected from `param:concept` and `{{raw_findings}}` is injected from step 1 output

### AC4: Decision store persistence
**Given** both steps complete successfully
**When** the results are persisted
**Then** the decision store contains entries under `research.findings` with keys for each research dimension (market_context, competitive_landscape, technical_feasibility, risk_flags, opportunity_signals)

### AC5: Artifact registration
**Given** the research phase completes successfully
**When** the phase exits
**Then** a `research-findings` artifact is registered for the current run

### AC6: Elicitation on step 1
**Given** step 1 has `elicitate: true`
**When** the step runner processes it
**Then** 1-2 elicitation methods are selected and dispatched

### AC7: Critique on step 2
**Given** step 2 has `critique: true`
**When** the step runner processes it
**Then** the critique loop runs using `critique-research` prompt

### AC8: Phase failure handling
**Given** any step fails
**When** the phase result is returned
**Then** `result: 'failed'` is returned with error details and token usage

### AC9: Phase result type
**Given** the research phase completes
**When** the result is returned
**Then** it conforms to `ResearchResult` type with `result`, `artifact_id`, `error`, `details`, `tokenUsage` fields

## Tasks / Subtasks

- [ ] Task 1: Add `ResearchPhaseParams` and `ResearchResult` types to `types.ts` (AC: #9)
  - [ ] `ResearchPhaseParams`: `runId`, `concept`
  - [ ] `ResearchResult`: follow `UxDesignResult` pattern exactly
- [ ] Task 2: Create `research.ts` phase implementation (AC: #1, #2, #3, #4, #5, #6, #7, #8)
  - [ ] `buildResearchSteps()` — returns 2 step definitions
  - [ ] Step 1: context from `param:concept`, elicitate true, persist discovery fields
  - [ ] Step 2: context from `param:concept` + `step:research-step-1-discovery`, critique true, register artifact
  - [ ] `runResearchPhase()` — calls `runSteps()`, handles failure, registers artifact fallback
  - [ ] Follow `ux-design.ts` implementation pattern exactly
- [ ] Task 3: Add manifest step definitions for research phase (AC: #1, #2, #3)
  - [ ] Add research phase with steps to `manifest.yaml` phases array
  - [ ] Step 1: template, context (param:concept), elicitate true
  - [ ] Step 2: template, context (param:concept + step reference), critique true
- [ ] Task 4: Wire `runResearchPhase()` into `runFullPipeline()` in `run.ts` (AC: #8, #9)
  - [ ] Add `research` case to the phase execution switch
  - [ ] Token usage recording (follow analysis/planning pattern)
  - [ ] Error handling and output formatting
- [ ] Task 5: Write unit tests for `buildResearchSteps()` (AC: #1, #2, #3, #6, #7)
  - [ ] Verify step count, names, task types
  - [ ] Verify context sources for each step
  - [ ] Verify elicitate/critique flags
  - [ ] Verify persist field mappings
- [ ] Task 6: Write unit tests for `runResearchPhase()` (AC: #4, #5, #8, #9)
  - [ ] Mock deps and dispatcher
  - [ ] Test success path — artifact registered, token usage returned
  - [ ] Test failure path — error propagated, no artifact
  - [ ] Follow `ux-design.ts` test patterns
- [ ] Task 7: Write integration test for full research phase execution (AC: #4, #5)
  - [ ] End-to-end with mocked dispatcher
  - [ ] Verify decision store contains expected keys after success
  - [ ] Verify artifact exists in DB after success

## Dev Notes

### Architecture Constraints
- Follow `ux-design.ts` implementation pattern exactly — same structure, same error handling, same artifact registration fallback
- Step definitions use the same `StepDefinition` type from `step-runner.ts`
- Context sources: `param:concept` and `step:research-step-1-discovery` (the step runner resolves these)
- Persist fields map step output schema fields to decision store `(phase, category, key)` triples
- The phase writes to `research.findings` category — downstream analysis reads via `decision:research.findings`

### Key Files
- New: `src/modules/phase-orchestrator/phases/research.ts`
- `src/modules/phase-orchestrator/phases/types.ts` — new types
- `src/modules/phase-orchestrator/phases/ux-design.ts` — reference implementation
- `src/modules/phase-orchestrator/step-runner.ts` — step runner (no changes needed)
- `src/cli/commands/run.ts` — wire into pipeline
- `packs/bmad/manifest.yaml` — step definitions

### Testing Requirements
- Unit tests for step definitions (structure, context, flags)
- Unit tests for phase runner (success/failure paths)
- Integration test with mocked dispatcher verifying decision store writes

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
