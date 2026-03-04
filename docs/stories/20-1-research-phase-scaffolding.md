# Story 20.1: Research Phase Scaffolding

Status: draft

## Story

As a pipeline operator,
I want a research phase registered in the phase orchestrator,
so that the pipeline can optionally run research before analysis.

## Acceptance Criteria

### AC1: Manifest flag
**Given** the pack manifest has `research: true`
**When** the pipeline initializes
**Then** the research phase is registered between the start of the pipeline and the analysis phase

### AC2: Manifest flag disabled
**Given** the pack manifest has `research: false` (or the key is absent)
**When** the pipeline initializes
**Then** the research phase is NOT registered and the pipeline starts with analysis as before

### AC3: Phase definition
**Given** the research phase is registered
**When** gates are evaluated
**Then** entry gates are empty (first phase when enabled) and exit gate requires a `research-findings` artifact

### AC4: CLI flags
**Given** the user runs the pipeline
**When** `--research` is passed, it overrides `research: false` in manifest to enable research
**When** `--skip-research` is passed, it overrides `research: true` in manifest to disable research

### AC5: Phase order preserved
**Given** research is enabled
**When** the pipeline phase order is constructed
**Then** the order is: research → analysis → planning → [ux-design] → solutioning → implementation

### AC6: Built-in phases config
**Given** `createBuiltInPhases` is called with `researchEnabled: true`
**When** the phase list is returned
**Then** the research phase definition appears first, before analysis

### AC7: Analysis entry gate updated
**Given** research is enabled
**When** the analysis phase entry gates are evaluated
**Then** the `research-findings` artifact from research must exist (research must complete before analysis starts)

### AC8: Analysis entry gate unchanged when research disabled
**Given** research is disabled
**When** the analysis phase entry gates are evaluated
**Then** no research-related gate exists (analysis has no entry gates, same as today)

## Tasks / Subtasks

- [ ] Task 1: Add `research?: boolean` to manifest type and pack loader (AC: #1, #2)
  - [ ] Update `MethodologyPackManifest` type in `src/modules/methodology-pack/types.ts`
  - [ ] Add default `false` handling in pack loader
- [ ] Task 2: Create `createResearchPhaseDefinition()` in `built-in-phases.ts` (AC: #3)
  - [ ] Entry gates: empty array
  - [ ] Exit gates: `research-findings` artifact exists
  - [ ] onEnter/onExit logging (follow existing pattern)
- [ ] Task 3: Update `createBuiltInPhases()` to conditionally include research phase (AC: #5, #6)
  - [ ] Add `researchEnabled?: boolean` to `BuiltInPhasesConfig`
  - [ ] Insert research phase at position 0 when enabled
  - [ ] Conditionally add research-findings entry gate to analysis phase when research is enabled (AC: #7, #8)
- [ ] Task 4: Add `--research` and `--skip-research` CLI flags to `run.ts` (AC: #4)
  - [ ] Follow the `--skip-ux` / `uxDesign` pattern exactly
  - [ ] Wire flags through to `createBuiltInPhases` config
- [ ] Task 5: Update phase order construction in `runFullPipeline()` (AC: #5)
  - [ ] Add `'research'` to the `phaseOrder` array when enabled
- [ ] Task 6: Write unit tests for `createResearchPhaseDefinition` (AC: #3)
  - [ ] Test entry gates are empty
  - [ ] Test exit gate checks for research-findings artifact
- [ ] Task 7: Write integration tests for research-enabled and research-disabled pipelines (AC: #1, #2, #5, #7, #8)
  - [ ] Follow pattern from `ux-enabled-integration.test.ts` and `ux-skipped-integration.test.ts`
  - [ ] Verify phase order with research enabled
  - [ ] Verify phase order with research disabled
  - [ ] Verify analysis entry gate with research enabled/disabled

## Dev Notes

### Architecture Constraints
- Follow the UX design optional phase pattern exactly — same `createBuiltInPhases` config approach, same manifest flag approach
- Research phase is the FIRST phase when enabled (before analysis), unlike UX which goes between planning and solutioning
- The analysis phase entry gate must be conditionally modified — when research is enabled, analysis requires `research-findings` artifact; when disabled, analysis has no entry gates (preserving current behavior)

### Key Files
- `src/modules/methodology-pack/types.ts` — manifest type
- `src/modules/phase-orchestrator/built-in-phases.ts` — phase definitions
- `src/cli/commands/run.ts` — CLI flags and phase order
- `src/modules/phase-orchestrator/__tests__/built-in-phases.test.ts` — unit tests
- New: `src/modules/phase-orchestrator/__tests__/research-enabled-integration.test.ts`
- New: `src/modules/phase-orchestrator/__tests__/research-disabled-integration.test.ts`

### Testing Requirements
- Unit tests for the new phase definition (gates)
- Integration tests for both enabled and disabled paths
- Verify no regression on existing phase ordering when research is disabled

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
