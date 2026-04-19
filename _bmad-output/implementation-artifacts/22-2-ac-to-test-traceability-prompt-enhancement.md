# Story 22-2: AC-to-Test Traceability via Code-Review Enhancement

Status: review

## Story

As a pipeline operator,
I want code-review to verify that each acceptance criterion has corresponding test evidence,
so that stories aren't marked COMPLETE with untested ACs.

## Acceptance Criteria

### AC1: Traceability Dimension in Code-Review Prompt
**Given** the code-review prompt template at `packs/bmad/prompts/code-review.md`
**When** a code review is dispatched for any story
**Then** the prompt includes an explicit "AC-to-Test Traceability" review dimension instructing the reviewer to identify, for each AC, the specific test file and test function that directly validates it

### AC2: Missing Test Evidence Flagged as Major Issue
**Given** a story implementation where one or more ACs have no corresponding test coverage
**When** the code-review agent executes its review
**Then** each AC without test evidence is reported as a major-severity issue using the message format "AC{N} has no test evidence"

### AC3: Tangential Tests Explicitly Excluded
**Given** the code-review prompt instructs AC-to-test traceability
**When** a test file exists but exercises the code only tangentially rather than directly validating the behavior described in the AC
**Then** the prompt makes explicit that such tangential tests do not satisfy the traceability requirement and must not be cited as evidence

### AC4: Evidence Citations in AC Checklist Output
**Given** the code-review agent processes a story with the updated prompt
**When** it produces the `ac_checklist` output
**Then** each entry with `status: met` includes an `evidence` value citing the specific test file and test function that validates the AC

## Tasks / Subtasks

- [x] Task 1: Add AC-to-Test Traceability dimension to the review instructions (AC: #1, #2, #3)
  - [x] Open `packs/bmad/prompts/code-review.md` and locate the "Execute adversarial review" section
  - [x] Add "AC-to-Test Traceability" as a named review dimension alongside "AC Validation"
  - [x] Write instruction: for each AC, identify the specific test file and test function that validates it
  - [x] Write rule: if an AC has no corresponding test, flag it as a major issue: "AC{N} has no test evidence"
  - [x] Write clarification: a test "covers" an AC only if it directly exercises the behavior described in the criterion — tangential tests do not count

- [x] Task 2: Update evidence guidance in the output contract section (AC: #4)
  - [x] Locate the `ac_checklist` example in the Output Contract section of `code-review.md`
  - [x] Ensure the example evidence strings for `status: met` entries cite test files/functions (e.g. `"Covered by src/modules/foo/__tests__/foo.test.ts:it('AC2 ...')"`)
  - [x] Confirm the output contract comment instructs the agent to cite specific test evidence

## Dev Notes

### Architecture Constraints
- **Prompt-only change** — no TypeScript source code modifications required
- The only file modified is `packs/bmad/prompts/code-review.md`
- The output schema (`CodeReviewResultSchema` in `src/modules/compiled-workflows/schemas.ts`) already supports `ac_checklist[].evidence` — no schema changes needed
- No new npm dependencies

### Key Files
- `packs/bmad/prompts/code-review.md` — the only file to be modified
- `src/modules/compiled-workflows/code-review.ts` — reference for how the prompt is assembled and dispatched (read-only)
- `src/modules/compiled-workflows/schemas.ts` — `AcChecklistEntrySchema` with `evidence` field (read-only)

### Prompt Structure Context
The code-review.md prompt is structured as:
1. Context injection placeholders (`{{story_content}}`, `{{git_diff}}`, `{{previous_findings}}`, `{{arch_constraints}}`, `{{prior_findings}}`)
2. Mission statement
3. Instructions (numbered 1–5), with instruction 4 being "Execute adversarial review across N dimensions"
4. Output Contract with YAML example

The new "AC-to-Test Traceability" dimension belongs inside instruction 4, alongside the existing "AC Validation" bullet.

### Severity Mapping
- Missing test evidence for any AC → **major** severity (not minor) — an untested AC cannot be considered shipped

### Testing Requirements
- No new unit tests required for this prompt-only change
- Verify the updated `packs/bmad/prompts/code-review.md` manually to confirm:
  - The new traceability dimension is present in the review instructions
  - The major-issue rule for missing test evidence is explicit
  - The tangential-tests exclusion clause is present
  - The output contract example shows test-citing evidence strings for `met` ACs

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All 4 ACs were already implemented in packs/bmad/prompts/code-review.md prior to this run
- AC-to-Test Traceability dimension present at instruction 4 alongside AC Validation
- Major-issue rule "AC{N} has no test evidence" explicitly stated
- Tangential-tests exclusion clause present
- Evidence citations in ac_checklist example already cite test files/functions
- No TypeScript source changes required (prompt-only change)
- No new tests required

### File List
- /home/jplanow/code/jplanow/substrate/packs/bmad/prompts/code-review.md

## Change Log
