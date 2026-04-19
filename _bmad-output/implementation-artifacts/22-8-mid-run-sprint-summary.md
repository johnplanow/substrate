# Story 22-8: Mid-Run Sprint Summary

Status: review

## User Story

As a parent Claude agent monitoring a long-running pipeline,
I want a queryable mid-run sprint summary that shows per-story progress, elapsed time, and phase breakdown,
so that I can report meaningful progress to the user without waiting for the pipeline to complete.

## Background

The existing `substrate status` command provides basic pipeline run metadata (run_id, current_phase, token_usage, staleness_seconds). During long runs with 6+ stories, the agent polling `substrate status` can only report "pipeline is running" without granular story-level progress.

The orchestrator already tracks per-story state (phase, review cycles) in memory and emits NDJSON heartbeat events with `active_dispatches` and `completed_dispatches` counts. Story phase transitions are emitted as `story:phase` events. The status command queries the SQLite decision store but doesn't aggregate story-level progress from the pipeline_runs table's `state_json` field.

## Acceptance Criteria

### AC1: Per-Story Status in Status Output
**Given** a pipeline run is in progress with multiple stories
**When** `substrate status --output-format json` is queried
**Then** the JSON output includes a `stories` object with `details` keyed by story key, each containing `phase` (current phase string) and `review_cycles` (number)

### AC2: Sprint Progress Counts
**Given** a pipeline run has some stories completed and some in progress
**When** `substrate status --output-format json` is queried
**Then** the output includes `stories.completed`, `stories.in_progress`, `stories.escalated`, and `stories.pending` integer counts

### AC3: Elapsed Time Per Story
**Given** a story has started processing
**When** the status is queried
**Then** `stories.details.<key>.elapsed_seconds` reports wall-clock seconds since the story's first phase began

### AC4: Human-Readable Sprint Summary
**Given** a pipeline is running with `--output-format human` (default)
**When** `substrate status` is queried
**Then** the output includes a sprint progress table showing each story's key, current phase, review cycles, and elapsed time

### AC5: State Deserialization from pipeline_runs
**Given** the orchestrator persists state to `pipeline_runs.state_json`
**When** the status command reads the latest run
**Then** it deserializes `state_json` to extract per-story progress without requiring the orchestrator to be in-process

### AC6: Graceful Fallback When No Story State
**Given** a pipeline run exists but `state_json` is null or empty (e.g., pre-implementation phases)
**When** `substrate status` is queried
**Then** the stories section is omitted or shows empty counts without errors

## Dev Notes

### Key Files
- `src/cli/commands/status.ts` — main status command implementation
- `src/cli/commands/pipeline-shared.ts` — shared formatting utilities (`buildPipelineStatusOutput`, `formatPipelineStatusHuman`)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — `persistState()` writes `state_json` to pipeline_runs
- `src/modules/implementation-orchestrator/types.ts` — `OrchestratorState`, `StoryState` types

### Architecture Constraints
- ADR-001: Services consumed via dependency injection
- ADR-003: SQLite WAL mode, synchronous queries
- ADR-005: All imports use .js extension (ESM)
- Test framework: Vitest (NOT jest)
- Coverage: 80% enforced
- Run targeted tests: `npx vitest run --no-coverage -- "status"`

### Implementation Approach
The orchestrator already calls `persistState()` which writes a JSON blob to `pipeline_runs.state_json`. The status command needs to:
1. Read `state_json` from the pipeline_runs row
2. Parse it to extract per-story `{ phase, reviewCycles, startedAt }` entries
3. Compute elapsed_seconds as `now - startedAt` for in-progress stories
4. Add story counts (completed, in_progress, escalated, pending) to the status output
5. Format a human-readable progress table

### State JSON Shape (from orchestrator)
The `state_json` field contains a serialized `OrchestratorState` which includes a `stories` map. Each story entry has `phase` (StoryPhase string) and `reviewCycles` (number). The orchestrator updates this on every phase transition.

## Tasks

- [x] Task 1: Parse state_json in status command (AC: #5, #6)
  - Read `state_json` from pipeline_runs row
  - Deserialize and extract story entries
  - Handle null/empty gracefully
- [x] Task 2: Build per-story detail object (AC: #1, #3)
  - Map story entries to `{ phase, review_cycles, elapsed_seconds }`
  - Compute elapsed_seconds from story start timestamps
- [x] Task 3: Compute sprint progress counts (AC: #2)
  - Count stories by phase category: completed (COMPLETE), in_progress (IN_*), escalated (ESCALATED), pending (not started)
- [x] Task 4: Add stories to JSON output (AC: #1, #2, #3)
  - Extend `buildPipelineStatusOutput()` to include stories object
- [x] Task 5: Add human-readable sprint table (AC: #4)
  - Format progress table in `formatPipelineStatusHuman()`
  - Show story key, phase, review cycles, elapsed time
- [x] Task 6: Write tests (AC: #1-#6)
  - Test state_json parsing with various shapes
  - Test count computation
  - Test human format rendering
  - Test null/empty fallback
