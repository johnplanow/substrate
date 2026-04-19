# Story 24-5: Code-Review AC Verification Checklist

Status: review

## Story

As a pipeline operator,
I want the code-review agent to produce a structured per-AC checklist verifying each acceptance criterion against the actual diff,
so that stories cannot be marked COMPLETE when core ACs are unimplemented (as happened with code-review-agent story 4-5).

Addresses: Cross-project Epic 4 run where story 4-5 passed code review twice despite missing its core AC (LLM-as-judge call). The reviewer assessed general code quality but never verified per-AC implementation.

## Acceptance Criteria

### AC1: AC Checklist Field in CodeReviewResultSchema
**Given** the code-review sub-agent emits its YAML output
**When** the pipeline parses the result
**Then** the schema includes an `ac_checklist` array field where each entry has `ac_id` (string, e.g. "AC1"), `status` (enum: "met", "not_met", "partial"), and `evidence` (string describing the code location or reason)

### AC2: Code-Review Prompt Requires AC Checklist
**Given** the code-review prompt template (`packs/bmad/prompts/code-review.md`)
**When** the reviewer executes
**Then** the instructions require the agent to emit an `ac_checklist` entry for every AC found in the story file, with explicit evidence for each status determination

### AC3: Unmet AC Produces Major Issue
**Given** the code-review agent marks an AC as `not_met` in the checklist
**When** the pipeline processes the result
**Then** a `major` severity issue is auto-injected into `issue_list` with description "AC{N} not implemented: {evidence}" if the agent did not already include a corresponding issue — ensuring unmet ACs always surface as reviewable issues

### AC4: Verdict Reflects AC Compliance
**Given** the `ac_checklist` contains one or more `not_met` entries
**When** `computeVerdict` runs
**Then** the verdict is at least `NEEDS_MINOR_FIXES` (cannot be `SHIP_IT` with unmet ACs)

### AC5: Empty AC Checklist Tolerated
**Given** a story file with no parseable acceptance criteria (e.g. a refactoring story)
**When** the code-review agent cannot extract ACs
**Then** the `ac_checklist` field may be an empty array and the review proceeds normally without AC-based verdict enforcement

### AC6: Backward Compatibility
**Given** an older code-review agent output that lacks the `ac_checklist` field
**When** the schema parses the result
**Then** `ac_checklist` defaults to an empty array (field is optional with `.default([])`) and existing behavior is preserved

## Tasks / Subtasks

- [x] Task 1: Add `ac_checklist` to `CodeReviewResultSchema` (AC: #1, #5, #6)
  - [x] In `src/modules/compiled-workflows/schemas.ts`, add `AcChecklistEntrySchema` with `ac_id: z.string()`, `status: z.enum(['met', 'not_met', 'partial'])`, `evidence: z.string()`
  - [x] Add `ac_checklist: z.array(AcChecklistEntrySchema).default([])` to `CodeReviewResultSchema`
  - [x] Export the new types

- [x] Task 2: Update `computeVerdict` to consider AC compliance (AC: #3, #4)
  - [x] In the `.transform()` of `CodeReviewResultSchema`, iterate `ac_checklist` entries
  - [x] For each `not_met` entry, check if `issue_list` already contains a major/blocker for that AC
  - [x] If not, inject a `{ severity: 'major', description: "AC{ac_id} not implemented: {evidence}", file: '' }` into the issue list
  - [x] Recompute verdict after injection (existing `computeVerdict` logic handles the rest)

- [x] Task 3: Update code-review prompt template (AC: #2)
  - [x] In `packs/bmad/prompts/code-review.md`, add instruction step between current steps 2 and 3:
    "3. **Build AC Checklist** — For each acceptance criterion (AC1, AC2, ...) in the story, determine: met (code implements it), not_met (code does not implement it), or partial (partially implemented). Cite the specific file and function as evidence."
  - [x] Update the Output Contract section to include `ac_checklist` in the YAML example
  - [x] Renumber existing steps accordingly

- [x] Task 4: Unit tests (AC: #1-#6)
  - [x] Test: schema parses output with `ac_checklist` containing met/not_met/partial entries
  - [x] Test: schema parses output without `ac_checklist` field (defaults to `[]`)
  - [x] Test: `not_met` entry auto-injects major issue when not already present
  - [x] Test: `not_met` entry does NOT duplicate if agent already flagged the AC as major
  - [x] Test: verdict cannot be `SHIP_IT` when `ac_checklist` has `not_met` entries
  - [x] Test: empty `ac_checklist` does not affect verdict

## Dev Notes

### Key Files
- `src/modules/compiled-workflows/schemas.ts` — `CodeReviewResultSchema`, `computeVerdict`
- `packs/bmad/prompts/code-review.md` — prompt template
- `src/modules/compiled-workflows/__tests__/code-review.test.ts` — existing test file
- `src/modules/compiled-workflows/code-review.ts` — `runCodeReview` (no changes expected, schema handles it)

### Design Decisions
- AC checklist is optional (`.default([])`) for backward compatibility — older agents and non-BMAD packs won't break
- Auto-injection of issues for unmet ACs ensures the existing verdict computation pipeline handles everything — no new verdict logic needed beyond the injection step
- The prompt change is additive — existing review dimensions remain unchanged

## Change Log
- 2026-03-06: Story created from cross-project pipeline findings (code-review-agent 4-5)
