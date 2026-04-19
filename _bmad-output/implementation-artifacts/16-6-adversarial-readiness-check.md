# Story 16.6: Adversarial Readiness Check

Status: review
Blocked-by: 16-3, 16-4

## Story

As a pipeline operator,
I want the readiness check to be a proper adversarial review (not keyword matching),
so that the pipeline catches real gaps in FR coverage, architectural contradictions, story quality issues, and UX alignment before entering implementation.

## Context

The current readiness check uses a `QualityGate` with keyword substring matching — it checks whether FR text keywords appear somewhere in story text. This is nearly useless for real validation (a story mentioning "concurrent" would "match" any FR containing that word). The BMAD interactive workflow has a 6-step adversarial readiness check that validates FR coverage, architecture compliance, UX alignment, story quality, and produces a hard READY/NEEDS WORK/NOT READY verdict. This story replaces the keyword matcher with a proper sub-agent dispatch that performs meaningful validation.

## Acceptance Criteria

### AC1: Adversarial Readiness Dispatch
**Given** the story generation sub-phase completes and a `stories` artifact is registered
**When** the readiness check runs
**Then** a sub-agent is dispatched with: all FRs, all NFRs, all architecture decisions, all stories (and UX decisions if available)
**And** the dispatch uses task type `readiness-check`
**And** the prompt instructs the agent to actively look for failures, not confirm success

### AC2: Readiness Output Structure
**Given** the readiness agent completes its review
**When** it returns results
**Then** the output contains: `verdict` (READY | NEEDS_WORK | NOT_READY), `coverage_score` (0-100), `findings` array
**And** each finding has: `category` (fr_coverage | architecture_compliance | story_quality | ux_alignment | dependency_validity), `severity` (blocker | major | minor), `description`, `affected_items` (FR IDs, story keys, decision keys)
**And** the output is validated against a `ReadinessOutputSchema` (Zod)

### AC3: FR Coverage Validation
**Given** the readiness agent reviews FR coverage
**When** it compares FRs to stories
**Then** every FR must be traceable to at least one story's acceptance criteria
**And** FRs that are not covered are reported as blocker findings
**And** FRs with weak/partial coverage are reported as major findings

### AC4: Architecture Compliance Check
**Given** the readiness agent reviews architecture compliance
**When** it compares stories to architecture decisions
**Then** stories that contradict architecture decisions are reported (e.g., story uses REST when architecture specifies GraphQL)
**And** stories that reference technologies not in the architecture are flagged

### AC5: Story Quality Assessment
**Given** the readiness agent reviews story quality
**When** it examines each story
**Then** it checks: acceptance criteria are testable (Given/When/Then), tasks are granular, dependencies are valid
**And** vague or untestable ACs are reported as major findings

### AC6: Retry with Gap Analysis
**Given** the readiness check returns `NEEDS_WORK`
**When** blocker findings exist
**Then** the pipeline retries story generation with the findings injected as `{{gap_analysis}}`
**And** the retry prompt instructs the agent to specifically address each blocker finding
**And** after retry, readiness check runs again (max 1 retry, 2 total checks)

### AC7: NOT_READY Handling
**Given** the readiness check returns `NOT_READY` (after retry or on first pass with critical failures)
**When** the pipeline processes the verdict
**Then** the solutioning phase is marked as `failed`
**And** the findings are stored in the decision store
**And** a detailed failure report is emitted via the event bus
**And** the pipeline does not proceed to implementation

### AC8: READY Handling
**Given** the readiness check returns `READY`
**When** the pipeline processes the verdict
**Then** the `solutioning-readiness` gate is satisfied
**And** any minor findings are logged as warnings
**And** the pipeline proceeds to implementation

### AC9: UX Alignment (Conditional)
**Given** the UX design phase ran and produced decisions
**When** the readiness agent reviews UX alignment
**Then** it checks that stories account for UX decisions (component choices, accessibility requirements, user journey flows)
**And** UX gaps are reported as major findings
**Given** the UX design phase was skipped
**Then** UX alignment checks are omitted from the review

## Dev Notes

### Architecture

- New file: `packs/bmad/prompts/readiness-check.md`
  - Adversarial prompt: "You are a senior engineering lead conducting a go/no-go review. Your success is measured by finding gaps others missed."
  - Structured sections: FR Coverage → Architecture Compliance → Story Quality → UX Alignment (conditional) → Dependency Validity → Verdict

- New schema: `src/modules/phase-orchestrator/schemas/readiness-output.ts`
  - `ReadinessOutputSchema` — Zod schema for readiness agent output

- Modified: `src/modules/phase-orchestrator/phases/solutioning.ts`
  - Replace `QualityGate` keyword matching with adversarial sub-agent dispatch
  - Implement retry-with-gap-analysis flow
  - Handle READY/NEEDS_WORK/NOT_READY verdicts

- Modified: `src/modules/agent-dispatch/types.ts`
  - Add `readiness-check` to `DEFAULT_MAX_TURNS` (20 turns) and `DEFAULT_TIMEOUTS` (600,000ms / 10 min)

### Readiness Prompt Context Assembly

The readiness prompt needs comprehensive context but must stay within budget. Assembly order:
1. All FRs and NFRs (required, never truncated)
2. Architecture decisions (required, summarized if needed)
3. All stories with ACs (required, summarized if needed)
4. UX decisions (optional, included if available)

If total context exceeds budget, stories are summarized to: key + title + AC count + FR coverage claim. Architecture decisions are summarized to: key + value (no rationale).

## Tasks

- [ ] Design `ReadinessOutputSchema` Zod schema (AC2)
- [ ] Create adversarial readiness prompt template (AC1, AC3, AC4, AC5, AC9)
- [ ] Replace keyword-matching QualityGate with sub-agent dispatch (AC1)
- [ ] Implement READY/NEEDS_WORK/NOT_READY verdict handling (AC7, AC8)
- [ ] Implement retry-with-gap-analysis flow (AC6)
- [ ] Add `readiness-check` to DEFAULT_MAX_TURNS and DEFAULT_TIMEOUTS
- [ ] Handle conditional UX alignment section (AC9)
- [ ] Store readiness findings in decision store
- [ ] Emit readiness events via event bus
- [ ] Write unit tests for readiness output schema
- [ ] Write unit tests for verdict handling (all 3 paths)
- [ ] Write unit tests for retry flow
- [ ] Write integration test for full readiness check with mock stories
