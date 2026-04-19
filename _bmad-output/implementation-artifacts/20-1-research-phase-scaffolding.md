# Story 20.1: Research Phase Scaffolding

Status: ready-for-dev

## Story

As a pipeline operator,
I want a research phase registered in the phase orchestrator,
so that the pipeline can optionally run research before analysis.

## Acceptance Criteria

### AC1: Manifest flag enables research phase
**Given** the pack manifest has `research: true`
**When** the pipeline initializes
**Then** the research phase is registered as the first phase, before analysis

### AC2: Manifest flag disabled preserves current behavior
**Given** the pack manifest has `research: false` or the key is absent
**When** the pipeline initializes
**Then** the research phase is NOT registered and the pipeline starts with analysis as before

### AC3: Phase definition structure
**Given** `createResearchPhaseDefinition()` is called
**When** the phase definition is returned
**Then** entry gates are an empty array (research is the first phase when enabled) and exit gate requires a `research-findings` artifact to exist

### AC4: CLI override flags
**Given** the user runs the pipeline
**When** `--research` is passed
**Then** it overrides `research: false` in manifest to enable research
**When** `--skip-research` is passed
**Then** it overrides `research: true` in manifest to disable research

### AC5: Phase order with research enabled
**Given** research is enabled (via manifest or CLI flag)
**When** the pipeline phase order is constructed
**Then** the order is: research → analysis → planning → [ux-design] → solutioning → implementation

### AC6: `createBuiltInPhases` config integration
**Given** `createBuiltInPhases` is called with `researchEnabled: true`
**When** the phase list is returned
**Then** the research phase definition appears first, before analysis

### AC7: Analysis entry gate added when research is enabled
**Given** research is enabled
**When** the analysis phase entry gates are evaluated
**Then** the `research-findings` artifact from the research phase must exist before analysis can start

## Tasks / Subtasks

- [ ] Task 1: Add `research?: boolean` to manifest type and pack loader (AC: #1, #2)
  - [ ] Update `MethodologyPackManifest` type in `src/modules/methodology-pack/types.ts` — add `research?: boolean` field with JSDoc comment
  - [ ] Add default `false` handling in the pack loader so absent key behaves identically to `research: false`

- [ ] Task 2: Create `createResearchPhaseDefinition()` in `built-in-phases.ts` (AC: #3)
  - [ ] Add the function alongside `createAnalysisPhaseDefinition`, `createPlanningPhaseDefinition`, etc.
  - [ ] Entry gates: empty array (research is always the pipeline entrypoint when enabled)
  - [ ] Exit gates: `{ type: 'artifact-exists', artifactType: 'research-findings' }`
  - [ ] onEnter/onExit logging following existing phase pattern
  - [ ] Phase id: `'research'`, name: `'Research'`

- [ ] Task 3: Update `createBuiltInPhases()` to conditionally include research phase (AC: #5, #6, #7)
  - [ ] Add `researchEnabled?: boolean` to `BuiltInPhasesConfig` type
  - [ ] When `researchEnabled` is true, insert the research phase definition at position 0 of the phases array
  - [ ] When `researchEnabled` is true, add `{ type: 'artifact-exists', artifactType: 'research-findings' }` as an entry gate to the analysis phase definition (AC: #7)
  - [ ] When `researchEnabled` is false/absent, analysis entry gates remain empty (AC: #2, preserving current behavior)

- [ ] Task 4: Add `--research` and `--skip-research` CLI flags to `run.ts` (AC: #4)
  - [ ] Follow the `--skip-ux` / `uxDesign` pattern exactly
  - [ ] Register both flags in the yargs command definition
  - [ ] Resolve effective research setting: CLI `--research` wins over manifest `false`; CLI `--skip-research` wins over manifest `true`; otherwise use manifest value (defaulting to `false`)
  - [ ] Pass resolved value as `researchEnabled` into `createBuiltInPhases` config

- [ ] Task 5: Add `'research'` to phase order in `runFullPipeline()` (AC: #5)
  - [ ] When research is enabled, prepend `'research'` to the `phaseOrder` array before `'analysis'`
  - [ ] When research is disabled, `phaseOrder` is unchanged from current behavior

- [ ] Task 6: Write unit tests for `createResearchPhaseDefinition()` (AC: #3)
  - [ ] Test entry gates array is empty
  - [ ] Test exit gate checks for `research-findings` artifact type
  - [ ] Test phase id is `'research'`
  - [ ] Follow existing `built-in-phases.test.ts` patterns

- [ ] Task 7: Write integration tests for research-enabled and research-disabled pipelines (AC: #1, #2, #5, #7)
  - [ ] Create `src/modules/phase-orchestrator/__tests__/research-enabled-integration.test.ts`
  - [ ] Create `src/modules/phase-orchestrator/__tests__/research-disabled-integration.test.ts`
  - [ ] Follow pattern from `ux-enabled-integration.test.ts` and `ux-skipped-integration.test.ts`
  - [ ] Verify phase order contains research as first element when enabled
  - [ ] Verify phase order does NOT contain research when disabled
  - [ ] Verify analysis entry gate contains `research-findings` requirement when enabled
  - [ ] Verify analysis entry gate is empty when disabled (no regression)

## Dev Notes

### Architecture Constraints
- Follow the UX design optional phase pattern **exactly** — same `createBuiltInPhases` config approach, same manifest flag approach, same CLI flag pattern
- Research phase is the FIRST phase when enabled (before analysis), unlike UX design which goes between planning and solutioning
- The analysis phase entry gate must be **conditionally modified** — when research is enabled, analysis requires a `research-findings` artifact; when disabled, analysis has no entry gates (preserving current behavior)
- Do NOT add a `runResearchPhase()` call to `runFullPipeline()` in this story — that wiring happens in Story 20-3. This story only scaffolds the phase definition and CLI flags.

### Key Files

#### Files to modify
- `src/modules/methodology-pack/types.ts` — add `research?: boolean` to `MethodologyPackManifest`
- `src/modules/phase-orchestrator/built-in-phases.ts` — add `createResearchPhaseDefinition()`, update `createBuiltInPhases()` and `BuiltInPhasesConfig`
- `src/cli/commands/run.ts` — add `--research` and `--skip-research` CLI flags, resolve and pass `researchEnabled`

#### Reference files (read before implementing)
- `src/modules/phase-orchestrator/built-in-phases.ts` — copy `createUxDesignPhaseDefinition` as the template for `createResearchPhaseDefinition`
- `src/cli/commands/run.ts` — find `--skip-ux` flag registration and replicate the pattern for research
- `src/modules/phase-orchestrator/__tests__/ux-enabled-integration.test.ts` — integration test reference
- `src/modules/phase-orchestrator/__tests__/ux-skipped-integration.test.ts` — integration test reference

#### New test files to create
- `src/modules/phase-orchestrator/__tests__/research-enabled-integration.test.ts`
- `src/modules/phase-orchestrator/__tests__/research-disabled-integration.test.ts`

### Testing Requirements
- Test framework: **vitest** (not jest — `--testPathPattern` flag does not work, use vitest pattern matching)
- Coverage thresholds: 80% enforced — run full suite with `npm test`, not filtered runs
- Unit tests for the new phase definition (gates, id, name)
- Integration tests for both enabled and disabled paths — verify no regression on existing phase ordering when research is disabled
- When mocking `fs` in tests, if ConfigWatcher is involved add `watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn() }))` to prevent regressions

### Scope Boundary
- This story: manifest type, phase definition, `createBuiltInPhases` config, CLI flags, phase order in pipeline
- Story 20-2: prompt templates and Zod output schemas
- Story 20-3: `runResearchPhase()` implementation and wiring into `runFullPipeline()`
- Story 20-4: `{{research_findings}}` injection into analysis prompt

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
