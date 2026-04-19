# Story 39-2: Skip Phase Detection When --stories Provided

Status: review

## Story

As a pipeline operator,
I want `substrate run --events --stories H2-1,H2-2` to go directly to implementation,
so that I don't need `--from implementation` and don't get "needs a concept" errors when prior phase artifacts don't exist.

Fixes issue #3: Pipeline state loss between runs.

## Acceptance Criteria

### AC1: --stories Bypasses Phase Detection
**Given** a project with story files for H2-1 through H2-4 but no analysis/planning/solutioning artifacts
**When** I run `substrate run --events --stories H2-1,H2-2`
**Then** the pipeline starts implementation directly without requiring `--from implementation` or `--concept`

### AC2: --from Still Works
**Given** the existing `--from` flag
**When** I run `substrate run --from solutioning --events`
**Then** it works as before (backward compatibility)

### AC3: No --stories Preserves Auto-Detection
**Given** a project with no `--stories` flag
**When** I run `substrate run --events`
**Then** `detectStartPhase()` runs as before to determine where to start

### AC4: Error Message on Missing Stories
**Given** `--stories H2-1` but no story file exists for H2-1
**When** the pipeline tries to start implementation
**Then** a clear error message is shown (not a cryptic "needs a concept" error)

## Tasks / Subtasks

- [x] Task 1: Add --stories fast path in run command (AC: #1, #3)
  - [x] In `src/cli/commands/run.ts`, before the `detectStartPhase()` call, check if `--stories` was provided
  - [x] If `--stories` is present, set `effectiveStartPhase = 'implementation'` directly
  - [x] Skip `detectStartPhase()` entirely — the user is explicitly specifying what to run
  - [x] If `--stories` is NOT present, fall through to existing `detectStartPhase()` logic

- [x] Task 2: Validate story files exist (AC: #4)
  - [x] Before starting implementation, verify that story files exist for the provided keys
  - [x] If any story key doesn't resolve to a file, emit a clear error: "Story file not found for key: H2-1"
  - [x] Uses `readdirSync` against `_bmad-output/implementation-artifacts/` to check for files

- [x] Task 3: Tests (AC: #1, #2, #3)
  - [x] Add test: `--stories` flag bypasses phase detection
  - [x] Add test: `--from` still triggers phase detection (backward compat)
  - [x] Add test: no `--stories` and no `--from` triggers auto-detection
  - [x] Verify existing auto-pipeline tests still pass

## Dev Notes

### Architecture
- **File**: `src/cli/commands/run.ts` — main change
- **File**: `src/modules/phase-orchestrator/phase-detection.ts` — no changes needed
- The key insight: `--stories` is an explicit user instruction. Phase detection is only needed when the user says "figure out where to start." When stories are provided, the answer is always "implementation."
- `detectStartPhase()` at `phase-detection.ts:48-60` already has a fast path for story discovery, but it requires `resolveStoryKeys()` to succeed, which may fail on new story keys not yet in the system

### File List
- `src/cli/commands/run.ts` (modify)
