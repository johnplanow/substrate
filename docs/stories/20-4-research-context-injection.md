# Story 20.4: Research Context Injection into Analysis

Status: draft

## Story

As a pipeline operator,
I want research findings injected into the analysis phase,
so that product vision and scope are grounded in evidence when research data is available.

## Acceptance Criteria

### AC1: Context wiring in manifest
**Given** the manifest step definition for `analysis-step-1-vision`
**When** research is enabled and the step context is resolved
**Then** a `{{research_findings}}` placeholder is injected from `decision:research.findings`

### AC2: Graceful absence
**Given** research is disabled (no research findings in decision store)
**When** the analysis step 1 prompt is rendered
**Then** `{{research_findings}}` resolves to empty string and the prompt works exactly as it does today

### AC3: Prompt template updated
**Given** the `analysis-step-1-vision.md` prompt template
**When** research findings are present
**Then** the prompt contains a "Research Context" section with the findings, instructing the agent to ground its vision analysis in evidence

### AC4: Prompt template unchanged path
**Given** the `analysis-step-1-vision.md` prompt template
**When** research findings are absent (empty string)
**Then** the "Research Context" section is omitted or empty, and the prompt produces the same output quality as before

### AC5: Decision store read
**Given** research phase completed and wrote to `research.findings`
**When** analysis step 1 resolves `decision:research.findings`
**Then** it receives the synthesized market context, competitive landscape, technical feasibility, risk flags, and opportunity signals

### AC6: Analysis step 2 receives research context indirectly
**Given** analysis step 1 has access to research findings
**When** step 1 produces a vision output
**Then** step 2 (scope) receives the research-informed vision output via `step:analysis-step-1-vision` (no direct research injection needed for step 2)

### AC7: End-to-end pipeline with research
**Given** research is enabled and the full pipeline runs
**When** the pipeline completes analysis
**Then** the product brief reflects research findings (mentions competitive context, market validation, or technical feasibility signals that were not in the original concept)

## Tasks / Subtasks

- [ ] Task 1: Add research_findings context to analysis step 1 in `manifest.yaml` (AC: #1)
  - [ ] Add `{ placeholder: research_findings, source: "decision:research.findings" }` to analysis-step-1-vision context array
- [ ] Task 2: Update `analysis-step-1-vision.md` prompt template (AC: #3, #4)
  - [ ] Add optional "Research Context" section that renders when `{{research_findings}}` is non-empty
  - [ ] Add instruction to ground vision in research evidence when available
  - [ ] Ensure prompt works identically when research_findings is empty
- [ ] Task 3: Verify step runner handles missing decision store context gracefully (AC: #2)
  - [ ] Confirm that `decision:research.findings` resolves to empty string when research phase was skipped
  - [ ] Add test if this behavior isn't already covered
- [ ] Task 4: Write integration test — research enabled pipeline (AC: #5, #7)
  - [ ] Seed decision store with research.findings entries
  - [ ] Run analysis phase with mocked dispatcher
  - [ ] Verify the assembled prompt contains research context
- [ ] Task 5: Write integration test — research disabled pipeline (AC: #2, #4)
  - [ ] Run analysis phase without research findings in decision store
  - [ ] Verify the assembled prompt does NOT contain research context section
  - [ ] Verify analysis output quality is unchanged
- [ ] Task 6: Write regression test — existing analysis tests still pass (AC: #4, #6)
  - [ ] Run full existing analysis test suite
  - [ ] Confirm no regressions from the prompt template change

## Dev Notes

### Architecture Constraints
- The step runner already resolves `decision:phase.category` context sources — if the category has no entries, it returns empty string. This is existing behavior; no step runner changes needed.
- The prompt template change must be backward-compatible. When `{{research_findings}}` is empty, the prompt must produce identical behavior to the current version.
- Do NOT add research_findings to analysis-step-2-scope — step 2 already gets step 1's output which will be research-informed. Adding direct research injection to step 2 would be redundant context bloat.
- Template conditional pattern: use a section header and content that only adds value when non-empty. The step runner replaces `{{research_findings}}` with the resolved content. If empty, the section header remains but is harmless.

### Key Files
- `packs/bmad/manifest.yaml` — add context entry to analysis-step-1-vision
- `packs/bmad/prompts/analysis-step-1-vision.md` — add optional Research Context section
- `src/modules/phase-orchestrator/step-runner.ts` — no changes expected (verify only)
- Existing test files for analysis phase — regression check

### Testing Requirements
- Integration test with research findings seeded in decision store
- Integration test without research findings (regression)
- Verify existing analysis test suite passes

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
