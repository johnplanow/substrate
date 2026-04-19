# Story 24-1: Zero-Diff Detection Gate

Status: ready

## Story

As a pipeline operator,
I want the orchestrator to verify that a dev-story agent actually modified files before marking a story COMPLETE,
so that phantom completions (zero code on disk) are caught and escalated instead of silently passed.

Addresses: Epic 23 Sprint 1 (story 23-3) and Sprint 3 (story 23-7) phantom completions where pipeline reported COMPLETE with zero code changes.

## Acceptance Criteria

### AC1: Zero-Diff Detection After Dev-Story
**Given** a dev-story agent subprocess has exited with a COMPLETE result
**When** the orchestrator processes the result
**Then** it runs `git diff --name-only HEAD` (or equivalent) to check for file modifications in the working tree

### AC2: Zero-Diff Escalation
**Given** the dev-story result is COMPLETE but `git diff --name-only` returns an empty string (no files changed)
**When** the orchestrator evaluates the story outcome
**Then** the story status is set to `NEEDS_ESCALATION` with reason `zero-diff-on-complete` instead of proceeding to code-review

### AC3: Non-Zero Diff Passes Through
**Given** the dev-story result is COMPLETE and `git diff --name-only` returns one or more file paths
**When** the orchestrator evaluates the story outcome
**Then** the story proceeds to code-review as normal (existing behavior preserved)

### AC4: Staged Files Count
**Given** the dev-story agent staged files with `git add` but did not commit
**When** the zero-diff check runs
**Then** staged files are detected (check includes `git diff --cached --name-only` in addition to unstaged diff)

### AC5: Non-COMPLETE Results Bypass Check
**Given** a dev-story result of NEEDS_MINOR_FIXES, NEEDS_MAJOR_REWORK, or NEEDS_ESCALATION
**When** the orchestrator processes the result
**Then** the zero-diff check is skipped (only applies to COMPLETE verdicts)

### AC6: Structured Event Emission
**Given** a zero-diff escalation occurs
**When** the orchestrator sets the story to NEEDS_ESCALATION
**Then** a structured NDJSON event is emitted: `{ type: "story:zero-diff-escalation", storyKey, reason: "zero-diff-on-complete" }`

## Tasks / Subtasks

- [ ] Task 1: Add zero-diff check to dispatcher after dev-story completion (AC: #1, #3, #5)
  - [ ] In `dispatcher-impl.ts`, after `executeDevStory()` resolves with COMPLETE
  - [ ] Run `git diff --name-only HEAD` and `git diff --cached --name-only` via `execSync` or existing git helper
  - [ ] If both return empty: override result to NEEDS_ESCALATION with reason
  - [ ] If non-empty: pass through to existing code-review flow
  - [ ] Skip check for non-COMPLETE results

- [ ] Task 2: Add structured event for zero-diff escalation (AC: #6)
  - [ ] Emit NDJSON event with type `story:zero-diff-escalation`
  - [ ] Include storyKey and reason in event payload

- [ ] Task 3: Unit tests (AC: #1-#6)
  - [ ] Test: COMPLETE + empty diff → NEEDS_ESCALATION
  - [ ] Test: COMPLETE + non-empty diff → proceeds to review
  - [ ] Test: COMPLETE + staged-only files → proceeds to review
  - [ ] Test: NEEDS_MINOR_FIXES → skips check entirely
  - [ ] Test: NEEDS_ESCALATION → skips check entirely
  - [ ] Test: event emission on zero-diff escalation

## Dev Notes

### Architecture Constraints
- **File**: `src/modules/agent-dispatch/dispatcher-impl.ts` — post-dev-story result handling
- **Git helpers**: Check `src/utils/git-root.ts` and `src/utils/helpers.ts` for existing git utility functions
- **Modular Monolith (ADR-001)**: Keep the check inline in the dispatcher; no new module needed
- **SQLite WAL (ADR-003)**: Status updates via existing `DatabaseWrapper` calls
- **Import style**: `.js` extension on all local imports (ESM)
- **Test framework**: vitest (not jest)

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest)
- Mock `execSync` or equivalent git calls in tests
- Ensure fake-timer tests are not affected (this story does not add `sleep()`)
- Run: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3` to verify

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
