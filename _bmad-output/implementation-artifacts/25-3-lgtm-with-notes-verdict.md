# Story 25-3: LGTM_WITH_NOTES Code-Review Verdict

Status: review

## User Story

As a pipeline operator,
I want code reviews to pass with advisory notes without triggering a fix cycle,
so that stories with only style/advisory findings ship faster and don't waste tokens on unnecessary review-fix iterations.

## Background

In the v0.2.29 cross-project run, both stories went through 2 review-fix cycles. 58% of story 4-6's wall-clock time was review/fix. When the code-review agent finds only style or advisory issues (no correctness bugs), the story should ship without a fix cycle. Currently, the only passing verdict is `SHIP_IT` — anything else triggers a fix cycle.

Adding `LGTM_WITH_NOTES` as a new verdict allows the code-review agent to approve code while recording advisory feedback for future reference. This feedback is persisted in the decision store and included in `prior_findings` for subsequent runs, so the pipeline learns from advisory patterns over time without blocking the current story.

## Acceptance Criteria

### AC1: Schema Addition
**Given** the code-review result schema
**When** the schema is updated
**Then** `LGTM_WITH_NOTES` is a valid verdict value alongside `SHIP_IT`, `NEEDS_MINOR_FIXES`, and `NEEDS_MAJOR_REWORK`

### AC2: Story Completion Behavior
**Given** a code-review returns `LGTM_WITH_NOTES` verdict
**When** the orchestrator processes the review result
**Then** the story is marked COMPLETE (same flow as `SHIP_IT`) and the advisory notes are persisted in the decision store

### AC3: Code-Review Prompt Guidance
**Given** the code-review prompt template
**When** updated
**Then** it instructs the review agent: use `LGTM_WITH_NOTES` when all findings are advisory/style-only and no correctness issues exist

### AC4: Advisory Notes in Prior Findings
**Given** a story completed with `LGTM_WITH_NOTES` and advisory notes were persisted
**When** a future pipeline run assembles prompts
**Then** the advisory notes are included in the story's `prior_findings` context for future reference

### AC5: Pipeline Metrics Tracking
**Given** a story completes with `LGTM_WITH_NOTES` verdict
**When** pipeline metrics are recorded
**Then** `LGTM_WITH_NOTES` is tracked as a distinct verdict in metrics, separate from `SHIP_IT`

## Dev Notes

- The `CodeReviewResultSchema` is defined in `src/modules/compiled-workflows/schemas.ts` — add `LGTM_WITH_NOTES` to the verdict enum
- The orchestrator's review result handling is in `orchestrator-impl.ts` — the switch/if on verdict needs a new branch that treats `LGTM_WITH_NOTES` like `SHIP_IT` but also persists notes
- The code-review prompt is at `packs/bmad/prompts/code-review.md` — add guidance for when to use the new verdict
- Decision store persistence: use category `advisory-notes` with the story key, so `getProjectFindings()` can pick them up
- Story metrics should record the verdict string as-is — the metrics system already captures verdict, just need to ensure LGTM_WITH_NOTES flows through

## Tasks

- [x] Task 1: Add `LGTM_WITH_NOTES` to `CodeReviewResultSchema` verdict enum in `src/modules/compiled-workflows/schemas.ts` (AC: #1)
- [x] Task 2: Update orchestrator review result handling to treat `LGTM_WITH_NOTES` as a passing verdict (AC: #2)
  - [x] In the verdict switch/branch, handle `LGTM_WITH_NOTES` same as `SHIP_IT` (mark story COMPLETE)
  - [x] Persist advisory notes to decision store with category `advisory-notes`
- [x] Task 3: Update code-review prompt template at `packs/bmad/prompts/code-review.md` (AC: #3)
  - [x] Add instruction: "Use LGTM_WITH_NOTES when all findings are advisory or style-related and there are no correctness, logic, or security issues"
  - [x] Add example of when to use LGTM_WITH_NOTES vs NEEDS_MINOR_FIXES
- [x] Task 4: Verify advisory notes appear in prior_findings (AC: #4)
  - [x] Ensure `getProjectFindings()` queries `advisory-notes` category
  - [x] Format advisory notes in the prior_findings markdown output
- [x] Task 5: Verify metrics track LGTM_WITH_NOTES distinctly (AC: #5)
  - [x] Confirm verdict string flows through to story_metrics without transformation
- [x] Task 6: Write unit tests (AC: #1-#5)
  - [x] Test: LGTM_WITH_NOTES is valid in schema
  - [x] Test: orchestrator marks story COMPLETE on LGTM_WITH_NOTES
  - [x] Test: advisory notes are persisted to decision store
  - [x] Test: advisory notes appear in prior_findings query
  - [x] Test: metrics record LGTM_WITH_NOTES as distinct verdict

## File List

- `src/modules/compiled-workflows/schemas.ts` — Added LGTM_WITH_NOTES to verdict enum, updated transform
- `src/modules/compiled-workflows/types.ts` — Added LGTM_WITH_NOTES to CodeReviewResult verdict types
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — Handle LGTM_WITH_NOTES as passing verdict, persist advisory notes, update verdictRank and phantom-review detection
- `src/modules/implementation-orchestrator/project-findings.ts` — Query advisory-notes category, include in prior_findings output
- `src/persistence/schemas/operational.ts` — Added ADVISORY_NOTES constant
- `packs/bmad/prompts/code-review.md` — Added LGTM_WITH_NOTES guidance with examples
- `src/modules/compiled-workflows/__tests__/schemas.test.ts` — Tests for AC1 (schema validation)
- `src/modules/implementation-orchestrator/__tests__/project-findings.test.ts` — Tests for AC4 (advisory notes in prior_findings)
- `src/modules/implementation-orchestrator/__tests__/lgtm-with-notes.test.ts` — Tests for AC2, AC4, AC5
