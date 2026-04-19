# Story 23-7: Activity Heartbeat Stall Detection

Status: done

## Story

As a pipeline operator,
I want stall detection to account for active child processes and dispatch heartbeats,
so that long-running but actively-working dev-story agents are not falsely flagged as stalled.

Addresses finding 5 (false stall detection during dev-story) from `docs/findings-cross-project-epic4-2026-03-05.md`.

Depends on: Story 23-6 (process detection must work cross-project first).

## Acceptance Criteria

### AC1: Heartbeat Updates last_activity
**Given** a heartbeat event showing `active_dispatches > 0`
**When** the watchdog checks staleness
**Then** `last_activity` is updated to the heartbeat timestamp, resetting the staleness timer

### AC2: Child Liveness Overrides Staleness
**Given** `staleness_seconds` exceeds the stall threshold
**When** at least one child process PID exists and has CPU > 0%
**Then** the stall event is suppressed and a debug log is emitted: `Staleness exceeded but child process {pid} is active — suppressing stall`

### AC3: Dev-Story Stall Threshold Elevated
**Given** a story in the `dev-story` phase
**When** the watchdog evaluates staleness
**Then** the effective stall threshold is 900s (15 min) instead of the default 600s, since dev-story commonly runs 10-15 minutes

### AC4: Non-Dev Phases Use Default Threshold
**Given** a story in `create-story` or `code-review` phase
**When** the watchdog evaluates staleness
**Then** the default 600s threshold applies

### AC5: Stall Events Include Child Liveness Data
**Given** a `story:stall` event is emitted (after liveness check fails)
**When** the event payload is constructed
**Then** it includes `child_pids: number[]` and `child_active: boolean` fields for diagnostic clarity

## Tasks / Subtasks

- [x] Task 1: Update heartbeat handler to refresh `last_activity` (AC: #1)
  - [x] In the watchdog stall check, when child processes are active, reset `_lastProgressTs`

- [x] Task 2: Add child liveness check to stall verdict (AC: #2)
  - [x] Before emitting `story:stall`, query child process liveness via `inspectProcessTree()`
  - [x] If any child is active (not zombie), suppress the stall event
  - [x] Uses 23-6's `inspectProcessTree` for cross-project detection

- [x] Task 3: Phase-aware stall thresholds (AC: #3, #4)
  - [x] Add `DEV_STORY_STALL_THRESHOLD_MS = 900_000` (15 min)
  - [x] In stall evaluation, check current story phase; use elevated threshold for IN_DEV
  - [x] Default threshold (600s) for all other phases

- [x] Task 4: Enrich stall event payload (AC: #5)
  - [x] Add `child_pids` and `child_active` to `StoryStallEvent` and event-bus types
  - [x] Populate from `inspectProcessTree()` results

- [x] Task 5: Write tests (AC: #1–#5)
  - [x] Test: stale + active child → stall suppressed and timer reset
  - [x] Test: stale + no active child → stall emitted with child_pids/child_active
  - [x] Test: stale + all children zombies → stall emitted
  - [x] Test: dev-story phase uses 900s threshold
  - [x] Test: create-story phase uses 600s threshold

## Dev Notes

### Architecture Constraints
- **Files**:
  - `src/modules/implementation-orchestrator/orchestrator-impl.ts` — heartbeat, watchdog, stall logic
  - `src/modules/implementation-orchestrator/event-types.ts` — stall event type
  - `src/modules/supervisor/` — child process liveness
- **Test framework**: vitest (not jest).

### Key Context
- During the Epic 4 run, `staleness_seconds` climbed to 600+ during a 13-minute dev-story while the child agent was actively working at 5% CPU with 900+ lines of new code.
- `child_pid: null` in the stall event confirms process detection was broken (finding 6). Fix 23-6 first.
- The supervisor in v0.2.13 added child liveness check in verdict logic, but the orchestrator's own watchdog doesn't use it.

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest).

## Dev Agent Record

### Agent Model Used
claude-opus-4-6 (manual implementation — pipeline false-positive)

### Completion Notes List
- Pipeline reported 23-7 as COMPLETE but produced zero code changes (same false-positive pattern as Sprint 1)
- Implemented manually: phase-aware stall thresholds (600s default, 900s for IN_DEV), child liveness check via `inspectProcessTree()`, stall suppression when live children exist, enriched stall event payload with `child_pids`/`child_active`
- Also fixed 23-8's missing `getMemoryState` mock in 6 test files, added `gcPauseMs: 0` and sleep mock to heartbeat tests
- All 4690 tests pass

### File List
- src/core/event-bus.types.ts
- src/modules/implementation-orchestrator/event-types.ts
- src/modules/implementation-orchestrator/orchestrator-impl.ts
- src/cli/commands/run.ts
- src/modules/implementation-orchestrator/__tests__/heartbeat-watchdog.test.ts
- src/cli/commands/__tests__/epic-15-event-flow.integration.test.ts
- src/__tests__/e2e/epic-10-integration.test.ts
- src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts
- src/modules/implementation-orchestrator/__tests__/story-metrics-integration.test.ts
- src/modules/implementation-orchestrator/__tests__/decomposition-observability.test.ts
- src/modules/implementation-orchestrator/__tests__/batched-dev-story-dispatch.test.ts

## Change Log
