# Story 23-3: Story File Validation on Reuse

Status: review

## Story

As a pipeline operator re-running a pipeline after a previous failure,
I want the create-story phase to validate that an existing story file is non-empty and structurally valid before skipping creation,
so that a 0-byte or corrupt file from a failed run doesn't silently propagate as a "completed" story.

Addresses finding 10 (create-story reuses stale files without validation) from `docs/findings-cross-project-epic4-2026-03-05.md`.

## Acceptance Criteria

### AC1: Non-Empty File Check
**Given** an existing story file is found on disk during the create-story phase
**When** the orchestrator checks whether to skip story creation
**Then** the file is read and verified to be non-empty (> 0 bytes) before skipping; a 0-byte file triggers re-creation

### AC2: Minimum Structure Check
**Given** an existing story file with non-zero size
**When** the validation runs
**Then** the file must contain at least a heading (`#`) and either "Acceptance Criteria" or "AC1" to be considered valid; files without these markers trigger re-creation

### AC3: Re-Creation Logs Warning
**Given** an existing story file that fails validation (empty or missing structure)
**When** re-creation is triggered
**Then** a warning is logged: `Existing story file for {storyKey} is invalid ({reason}) — re-creating`

### AC4: Valid Files Are Not Re-Created
**Given** an existing story file that passes both non-empty and structure checks
**When** the create-story phase runs
**Then** the file is reused as before (no behavioral change for valid files)

## Tasks / Subtasks

- [x] Task 1: Add `isValidStoryFile(filePath: string): { valid: boolean; reason?: string }` utility (AC: #1, #2)
  - [x] Read file content with `fs.readFile`
  - [x] Check non-empty (> 0 bytes after trim)
  - [x] Check contains `#` and either `Acceptance Criteria` or `AC1` (case-insensitive)
  - [x] Return `{ valid: true }` or `{ valid: false, reason: 'empty' | 'missing_structure' }`
  - [x] Co-locate in `src/modules/compiled-workflows/create-story.ts` or a small utility file
  - [x] Write unit tests for: valid file, empty file, file with content but no AC markers

- [x] Task 2: Integrate validation into orchestrator story-file reuse check (AC: #1, #2, #3, #4)
  - [x] In `orchestrator-impl.ts`, where the existing story file path is checked before skipping create-story
  - [x] Call `isValidStoryFile()` on the found file
  - [x] If invalid: log warning (AC3), set `storyFilePath = undefined` to trigger re-creation
  - [x] If valid: continue with existing skip behavior

- [x] Task 3: Write integration-level test (AC: #1–#4)
  - [x] Mock a 0-byte story file → verify create-story is invoked
  - [x] Mock a valid story file → verify create-story is skipped
  - [x] Mock a file with content but no AC markers → verify re-creation

## Dev Notes

### Architecture Constraints
- **Files**:
  - `src/modules/compiled-workflows/create-story.ts` or new utility — validation function
  - `src/modules/implementation-orchestrator/orchestrator-impl.ts` — reuse check integration
- **Modular Monolith (ADR-001)**: Validation logic is a utility; orchestrator consumes it.
- **Test framework**: vitest (not jest).

### Key Context
- The orchestrator checks for existing story files in the `_bmad-output/implementation-artifacts/` directory.
- On the cross-project run, a 0-byte file from a failed first run caused the second run to skip create-story entirely, reporting success.
- This is a small, focused change — intentionally minimal to avoid scope creep.

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest).
- Run: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3` to verify.

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Added `isValidStoryFile()` exported function to `create-story.ts` using `readFile` from `node:fs/promises`
- Integrated validation call in `orchestrator-impl.ts` before the existing skip-create-story path
- Warning log matches AC3 format: `Existing story file for {storyKey} is invalid ({reason}) — re-creating`
- 9 unit tests + 6 integration tests added; all 15 pass
- Pre-existing failures in `git-helpers.test.ts` and `seed-methodology-context.test.ts` are unrelated to this story

### File List
- `src/modules/compiled-workflows/create-story.ts` — added `isValidStoryFile` export + `readFile` import
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — integrated `isValidStoryFile` call in reuse check
- `src/modules/compiled-workflows/__tests__/story-file-validation.test.ts` — new unit tests (9 tests)
- `src/modules/implementation-orchestrator/__tests__/story-file-validation-integration.test.ts` — new integration tests (6 tests)

## Change Log
- 2026-03-06: Story implemented by claude-sonnet-4-5
