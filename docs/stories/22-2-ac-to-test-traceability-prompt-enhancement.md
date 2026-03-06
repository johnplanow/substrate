# Story 22-2: AC-to-Test Traceability via Code-Review Enhancement

Status: done

## User Story

As a pipeline operator,
I want code-review to verify that each acceptance criterion has corresponding test evidence,
so that stories aren't marked COMPLETE with untested ACs.

## Background

Code-review currently validates AC implementation against the git diff but does not verify that each AC has a corresponding test. Dev-story emits `ac_met[]` claims but these are self-reported by the dev agent. Adding traceability instructions to the existing code-review prompt is the lightest possible implementation — zero code changes, just prompt enhancement.

## Acceptance Criteria

### AC1: Traceability Instructions in Code-Review Prompt
**Given** the code-review prompt template
**When** a code review is dispatched
**Then** the prompt includes instructions to identify the specific test validating each AC and flag any AC without test evidence as a major issue

### AC2: AC Without Test Evidence Flagged
**Given** a story implementation where AC3 has no corresponding test
**When** code-review runs
**Then** the review output includes a major-severity issue: "AC3 has no test evidence"

## Tasks

- [ ] Task 1: Add traceability instructions to `packs/bmad/prompts/code-review.md` (AC: #1, #2)
  - [ ] Add new review dimension: "AC-to-Test Traceability"
  - [ ] Instruct reviewer to map each AC to its validating test file/function
  - [ ] Flag ACs without test evidence as major issues

## Dev Notes

### Key Files
- `packs/bmad/prompts/code-review.md` — only file modified
