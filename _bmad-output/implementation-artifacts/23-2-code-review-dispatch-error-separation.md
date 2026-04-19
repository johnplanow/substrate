# Story 23-2: Code-Review Dispatch Error Separation

Status: review

## Story

As a pipeline operator,
I want code-review dispatch failures (process crash, git-helper errors) to be distinguished from schema validation failures (malformed YAML output),
so that the orchestrator can retry or escalate broken dispatches instead of producing phantom review verdicts that waste fix-agent tokens.

Addresses finding 4 (silent code-review fallback verdicts) from `docs/findings-cross-project-epic4-2026-03-05.md`.

## Acceptance Criteria

### AC1: Dispatch Failure Returns Distinct Error Type
**Given** a code-review dispatch that fails (exit code != 0, process crash, or timeout)
**When** `runCodeReview()` returns the result
**Then** the result includes `error: 'dispatch_failed'` (not `'schema_validation_failed'`) and `verdict: 'NEEDS_MINOR_FIXES'` is NOT set — instead, a new `dispatchFailed: true` flag is set

### AC2: Orchestrator Distinguishes Dispatch Failure from Review Verdict
**Given** a code-review result with `dispatchFailed: true`
**When** the orchestrator processes the review result
**Then** it retries the review dispatch (up to 1 retry) before falling back to escalation, rather than dispatching a fix agent with no real findings

### AC3: Git-Helper Skips Nonexistent Files
**Given** `git add --intent-to-add` is called with a list of file paths, some of which no longer exist on disk
**When** the git helper runs
**Then** nonexistent files are silently skipped (with a debug log) and the diff is computed for the remaining files, instead of failing the entire operation

### AC4: Empty Diff After Git-Helper Errors Skips Review
**Given** all files in the diff list were nonexistent (git-helper returns empty diff after skipping)
**When** the code-review workflow is about to dispatch
**Then** the review is skipped entirely with verdict `SHIP_IT` and a note `'no_changes_to_review'`, since there is nothing to review

### AC5: Schema Validation Failure Retains Existing Behavior
**Given** a code-review dispatch that succeeds (exit code 0) but produces unparseable YAML
**When** `runCodeReview()` processes the output
**Then** the existing behavior is preserved: `verdict: 'NEEDS_MINOR_FIXES'`, `error: 'schema_validation_failed'` — this path is unchanged

### AC6: Phantom Review Detection Enhanced
**Given** the v0.2.21 phantom review detection in the orchestrator
**When** a `dispatchFailed: true` result is received
**Then** it is treated as a phantom review (triggers the existing retry-once logic) without requiring the heuristic check of `issue_list.length === 0 && error`

## Tasks / Subtasks

- [x] Task 1: Add `dispatchFailed` flag to `CodeReviewResult` type (AC: #1)
  - [x] Add `dispatchFailed?: boolean` to `CodeReviewResult` in `src/modules/compiled-workflows/types.ts`
  - [x] Update `defaultFailResult()` in `code-review.ts` to set `dispatchFailed: true`
  - [x] Ensure schema validation failure path does NOT set `dispatchFailed`

- [x] Task 2: Git-helper resilience for nonexistent files (AC: #3)
  - [x] In `src/modules/compiled-workflows/git-helpers.ts`, before `git add --intent-to-add`, filter file list through `fs.existsSync()`
  - [x] Log skipped files at debug level
  - [x] If all files filtered out, return empty string (not error)
  - [x] Write unit tests: mix of existing/nonexistent files, all nonexistent, all existing

- [x] Task 3: Empty-diff short-circuit in `runCodeReview()` (AC: #4)
  - [x] After git-helper returns the diff, check if it's empty/whitespace-only
  - [x] If empty: return `{ verdict: 'SHIP_IT', issues: 0, issue_list: [], notes: 'no_changes_to_review' }` without dispatching
  - [x] Write unit test for empty-diff short-circuit

- [x] Task 4: Orchestrator dispatch-failure handling (AC: #2, #6)
  - [x] In orchestrator review loop (`orchestrator-impl.ts`), check `reviewResult.dispatchFailed`
  - [x] If `dispatchFailed` and not yet retried: retry the review dispatch once
  - [x] If `dispatchFailed` after retry: escalate the story (don't dispatch a fix agent)
  - [x] Update phantom review detection to also trigger on `dispatchFailed: true`

- [x] Task 5: Update existing tests (AC: #1–#6)
  - [x] Update `code-review.test.ts` dispatch failure tests to assert `dispatchFailed: true`
  - [x] Add test for empty-diff SHIP_IT short-circuit
  - [x] Add orchestrator test for dispatch-failure retry path
  - [x] Update `git-helpers.test.ts` for file filtering behavior

## Dev Notes

### Architecture Constraints
- **Files**:
  - `src/modules/compiled-workflows/code-review.ts` — dispatch result handling
  - `src/modules/compiled-workflows/git-helpers.ts` — file existence filtering
  - `src/modules/compiled-workflows/types.ts` — `CodeReviewResult` type
  - `src/modules/implementation-orchestrator/orchestrator-impl.ts` — review loop
- **Modular Monolith (ADR-001)**: Git-helper is a utility within compiled-workflows; orchestrator consumes the result type.
- **Import style**: `.js` extension on all local imports (ESM).
- **Test framework**: vitest (not jest).

### Key Context
- The v0.2.19 change (commit `a63b69e`) intentionally changed schema-failure fallback from `NEEDS_MAJOR_REWORK` to `NEEDS_MINOR_FIXES`. That decision was correct for schema failures. The bug is that dispatch failures (process didn't run at all) use the same fallback.
- The v0.2.21 phantom review detection (line ~894-906 in orchestrator-impl.ts) is a partial fix — it retries once when issue_list is empty + error. This story makes it explicit via the `dispatchFailed` flag.
- `git add --intent-to-add` failure cascade: git-helpers returns empty diff → code-review gets empty diff → dispatches review agent with no code to review → agent can't produce valid YAML → schema failure → phantom NEEDS_MINOR_FIXES.

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest).
- Run: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3` to verify.

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All 5 tasks implemented. 4649 tests passing (182 test files).
- Fixed pre-existing syntax error in seed-methodology-context.ts (corrupted string literal at line 122) that was blocking orchestrator tests.
- AC1: `dispatchFailed?: boolean` added to `CodeReviewResult`; `defaultFailResult()` sets it to true for all dispatch failures (crash, non-zero exit, timeout, thrown exceptions).
- AC2: Orchestrator `dispatchRetried` flag added; first `dispatchFailed` retries, second escalates with `lastVerdict: 'dispatch-failed'`.
- AC3: `stageIntentToAdd` in git-helpers.ts now filters nonexistent files via `existsSync` before calling `git add -N`.
- AC4: Empty/whitespace-only git diff short-circuits `runCodeReview` returning `SHIP_IT` with `notes: 'no_changes_to_review'` without dispatching.
- AC5: Schema validation failure paths return literal objects without calling `defaultFailResult`, so `dispatchFailed` remains `undefined`.
- AC6: `dispatchFailed: true` check happens before phantom review detection, providing explicit flag-based detection.

### File List
- src/modules/compiled-workflows/types.ts
- src/modules/compiled-workflows/code-review.ts
- src/modules/compiled-workflows/git-helpers.ts
- src/modules/implementation-orchestrator/orchestrator-impl.ts
- src/modules/implementation-orchestrator/seed-methodology-context.ts
- src/modules/compiled-workflows/__tests__/code-review.test.ts
- src/modules/compiled-workflows/__tests__/git-helpers.test.ts
- src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts

## Change Log
