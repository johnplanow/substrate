# Story 22-1: Learning Loop — Implementation-Phase Injection

Status: done

## User Story

As a pipeline operator,
I want findings from previous pipeline runs to be automatically injected into dev-story and code-review prompts,
so that the pipeline learns from past mistakes and avoids repeating them.

## Background

The decision store already captures operational findings (v0.2.16, Story 21-1), story metrics, and experiment results. Supervisor analysis reports identify token regressions, high review cycle stories, and timing bottlenecks. But none of this feeds back into future runs — each pipeline execution is amnesiac.

The step-runner already supports `decision:phase.category` context refs and the prompt assembler handles `{{placeholder}}` injection. The amendment system (`src/cli/commands/amend.ts`) demonstrates the exact pattern needed: load prior decisions, format as markdown, inject into prompts.

## Acceptance Criteria

### AC1: Project Findings Query
**Given** a project has completed one or more pipeline runs with story outcomes persisted to the decision store
**When** a new pipeline run starts on the same project
**Then** a `getProjectFindings(projectRoot)` function returns a markdown summary of prior findings (recurring review issues, escalation patterns, stall history), max 2000 chars

### AC2: Dev-Story Prompt Injection
**Given** prior findings exist for the project
**When** the dev-story compiled workflow assembles its prompt
**Then** a `{{prior_findings}}` placeholder is populated with the findings summary, instructing the dev agent to avoid repeating known issues

### AC3: Code-Review Prompt Injection
**Given** prior findings exist for the project
**When** the code-review compiled workflow assembles its prompt
**Then** a `{{prior_findings}}` placeholder is populated with the findings summary, directing the reviewer to pay special attention to recurring patterns

### AC4: Story Outcome Persistence
**Given** a story completes (COMPLETE or ESCALATED)
**When** the orchestrator records the final status
**Then** a compact finding is written to the decision store with category `story-outcome` containing: story key, review cycles, verdict history, and any recurring issue patterns

### AC5: Empty Findings Graceful Fallback
**Given** no prior findings exist for the project (first run)
**When** the prompt assembler resolves `{{prior_findings}}`
**Then** the placeholder resolves to an empty string with no error

## Tasks

- [ ] Task 1: Create `getProjectFindings()` query function (AC: #1)
  - [ ] Query decision store for `story-outcome`, `operational-finding`, `story-metrics` categories
  - [ ] Group by recurring patterns (e.g. "error handling flagged in 3/5 reviews")
  - [ ] Return formatted markdown, truncated to 2000 chars
- [ ] Task 2: Add `{{prior_findings}}` to dev-story.md prompt (AC: #2)
  - [ ] Add placeholder with framing: "Previous runs encountered these issues — avoid repeating them"
  - [ ] Wire prompt assembly to call `getProjectFindings()`
- [ ] Task 3: Add `{{prior_findings}}` to code-review.md prompt (AC: #3)
  - [ ] Add placeholder with framing: "Previous reviews found these recurring patterns"
  - [ ] Wire prompt assembly to call `getProjectFindings()`
- [ ] Task 4: Persist story outcomes after completion (AC: #4)
  - [ ] Add event handler for `orchestrator:story-complete` and `orchestrator:story-escalated`
  - [ ] Write compact finding to decision store
- [ ] Task 5: Handle empty findings case (AC: #5)
  - [ ] Ensure prompt assembler returns empty string when no findings exist

## Dev Notes

### Key Files
- `src/modules/phase-orchestrator/step-runner.ts` — `resolveContext()` handles `decision:` refs
- `src/persistence/schemas/operational.ts` — existing decision categories
- `packs/bmad/prompts/dev-story.md` — dev-story prompt template
- `packs/bmad/prompts/code-review.md` — code-review prompt template
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — story completion events
- `src/cli/commands/amend.ts` — reference implementation for decision injection pattern
