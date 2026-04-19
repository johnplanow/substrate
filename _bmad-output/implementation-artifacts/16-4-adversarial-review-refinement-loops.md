# Story 16.4: Adversarial Review & Refinement Loops

Status: review
Blocked-by: 16-2

## Story

As a pipeline operator,
I want each phase to run a generate-critique-refine loop on its output artifacts,
so that artifacts are reviewed for gaps, contradictions, and quality issues before the pipeline advances to the next phase.

## Context

The BMAD interactive workflows achieve quality through iterative refinement: the user reviews output, requests changes, and the agent re-presents. The compiled pipeline currently has no review or refinement mechanism — each phase produces output once and moves on. This story introduces a bounded adversarial review loop: after a phase produces its artifact, a critique agent reviews it, and if issues are found, a refinement agent incorporates the feedback. The loop runs at most 2 iterations to bound cost and time.

## Acceptance Criteria

### AC1: Critique Dispatch After Phase Completion
**Given** a phase's final step produces an artifact (product brief, PRD, architecture, stories)
**When** the artifact is registered
**Then** a critique sub-agent is dispatched with the artifact content and a critique prompt
**And** the dispatch uses task type `critique` with max turns and timeout from `DEFAULT_MAX_TURNS`

### AC2: Critique Output Structure
**Given** the critique agent reviews an artifact
**When** it returns its assessment
**Then** the output contains: `verdict` (pass | needs_work), `issue_count`, and `issues` array
**And** each issue has: `severity` (blocker | major | minor), `category`, `description`, and `suggestion`
**And** the output is validated against a `CritiqueOutputSchema` (Zod)

### AC3: Refinement Dispatch on Needs-Work Verdict
**Given** the critique returns `verdict: needs_work` with blocker or major issues
**When** the pipeline processes the critique
**Then** a refinement sub-agent is dispatched with: the original artifact, the critique issues, and instructions to address each issue
**And** the refinement agent returns an updated artifact

### AC4: Bounded Loop (Max 2 Iterations)
**Given** the critique-refine loop is running
**When** iteration count reaches 2
**Then** the loop terminates regardless of the critique verdict
**And** any remaining issues are logged as warnings via the event bus
**And** the pipeline proceeds with the best available artifact

### AC5: Pass-Through on Clean Critique
**Given** the critique returns `verdict: pass` (no blocker or major issues)
**When** the pipeline processes the critique
**Then** no refinement dispatch occurs
**And** the phase advances immediately
**And** minor issues are logged as informational

### AC6: Critique Prompts Per Phase
**Given** different phases produce different artifact types
**When** the critique agent is dispatched
**Then** the critique prompt is phase-specific:
- **Analysis critique**: checks problem clarity, user persona specificity, metrics measurability, scope boundaries
- **Planning critique**: checks FR completeness, NFR measurability, user story quality, tech stack justification, requirement traceability
- **Architecture critique**: checks decision consistency (no contradictions), technology version currency, scalability considerations, security coverage, pattern coherence
- **Stories critique**: checks FR coverage, acceptance criteria testability, task granularity, dependency validity

### AC7: Critique Results Stored
**Given** a critique completes
**When** results are processed
**Then** the critique verdict, issue count, and issues are stored in the decision store with category `critique`
**And** if refinement ran, the delta between original and refined artifact is logged

### AC8: Cost and Time Tracking
**Given** critique and refinement dispatches consume tokens
**When** the loop completes
**Then** critique and refinement token costs are tracked separately
**And** total loop time is recorded
**And** both are included in the pipeline run summary

## Dev Notes

### Architecture

- New file: `src/modules/phase-orchestrator/critique-loop.ts`
  - `runCritiqueLoop(artifact: string, phaseId: string, options: CritiqueOptions): CritiqueLoopResult`
  - Orchestrates: dispatch critique → check verdict → dispatch refinement if needed → repeat up to maxIterations
  - Returns: final artifact content, critique history, total iterations, token costs

- New file: `packs/bmad/prompts/critique-analysis.md`
- New file: `packs/bmad/prompts/critique-planning.md`
- New file: `packs/bmad/prompts/critique-architecture.md`
- New file: `packs/bmad/prompts/critique-stories.md`
- New file: `packs/bmad/prompts/refine-artifact.md`

- New schema: `src/modules/phase-orchestrator/schemas/critique-output.ts`
  - `CritiqueOutputSchema` — Zod schema for critique agent output

- Modified: `src/modules/phase-orchestrator/step-runner.ts`
  - After final step of each phase, run critique loop before registering artifact

- Modified: `packs/bmad/manifest.yaml`
  - Add `critique: true` flag on final steps of each phase
  - Map phase IDs to critique prompt templates

### Critique Prompt Design Principles

Each critique prompt should:
1. Adopt an adversarial reviewer persona ("Your job is to find what's wrong")
2. Reference the specific quality standards for that artifact type
3. Require structured output (not prose) — issues array with severity/category/description/suggestion
4. Include domain context from the decision store so critiques are project-specific, not generic

## Tasks

- [x] Design `CritiqueOutputSchema` Zod schema (AC2)
- [x] Implement `critique-loop.ts` with bounded iteration (AC1, AC3, AC4, AC5)
- [x] Create phase-specific critique prompt templates (AC6)
- [x] Create refinement prompt template (AC3)
- [x] Integrate critique loop into step runner (AC1)
- [ ] Store critique results in decision store (AC7)
- [ ] Add cost and time tracking for critique/refinement (AC8)
- [ ] Write unit tests for critique loop (pass, needs_work, max iterations)
- [ ] Write unit tests for critique output schema validation
- [ ] Write integration test for critique loop in architecture phase
- [ ] Verify critique prompts produce actionable, structured output
