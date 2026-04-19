# Story 23-9: Status Endpoint Consistency

Status: review

## Story

As a pipeline operator or monitoring agent,
I want `substrate status` and `substrate health` to report consistent story counts and pipeline state,
so that I can trust either endpoint for progress monitoring.

Addresses finding 11 (status endpoint inconsistencies) from `docs/findings-cross-project-epic4-2026-03-05.md`.

## Acceptance Criteria

### AC1: Status Reports Correct Story Counts
**Given** a pipeline run with N stories, M completed
**When** `substrate status --output-format json` is queried
**Then** `stories_count` equals N and `stories_completed` equals M (was reporting `stories_count: 0` throughout the run)

### AC2: Status and Health Agree on Counts
**Given** a pipeline run in progress
**When** both `substrate status` and `substrate health` are queried
**Then** the story completion counts match between the two endpoints

### AC3: Status Updates in Real-Time
**Given** a story completes during a pipeline run
**When** `substrate status` is queried immediately after
**Then** the completed count reflects the new completion (not stale from pipeline start)

## Tasks / Subtasks

- [x] Task 1: Diagnose why status reports stories_count: 0 (AC: #1)
  - [x] Trace the status command's data path — likely not reading from the same source as health
  - [x] Identify whether it's a query bug or a persistence timing issue

- [x] Task 2: Fix status story count reporting (AC: #1, #3)
  - [x] Ensure status reads from the same pipeline run state that health uses
  - [x] Verify counts update on each `persistState()` call

- [x] Task 3: Align status and health data sources (AC: #2)
  - [x] If they use different query paths, unify to a single source of truth
  - [x] Or ensure both paths produce identical results

- [x] Task 4: Write tests (AC: #1–#3)
  - [x] Test: status reports correct stories_count during run
  - [x] Test: status and health return same completion counts
  - [x] Test: status count updates after story completion

## Dev Notes

### Architecture Constraints
- **Files**:
  - `src/cli/commands/status.ts` — status command
  - `src/cli/commands/health.ts` — health command
  - `src/modules/implementation-orchestrator/orchestrator-impl.ts` — `persistState()`
- **Test framework**: vitest (not jest).

### Key Context
- During the Epic 4 run, `substrate status --output-format json` consistently reported `stories_count: 0` while stories were completing. The health endpoint correctly tracked counts.
- This is likely a simple query or data-path bug — the orchestrator persists state correctly (health endpoint works), but the status command reads from a different or stale source.

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest).

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Root cause: `buildPipelineStatusOutput` used the `storiesCount` param (from `requirements` table, always 0 for implementation-only runs) for `stories_count`. Health command correctly reads from `token_usage_json`.
- Fix: When `storiesSummary` is available (parsed from `token_usage_json`), derive `stories_count` from total across all phases and add `stories_completed` field matching health's `stories.completed`.
- Added `stories_completed: number` to `PipelineStatusOutput` interface.
- Both endpoints now read from same source (`token_usage_json`) for story counts.

### File List
- /Users/John.Planow/code/jplanow/substrate/src/cli/commands/pipeline-shared.ts
- /Users/John.Planow/code/jplanow/substrate/src/cli/commands/__tests__/status-story-count.test.ts

## Change Log
