# Story 39-3: Fix Status Endpoint to Track Current Run

Status: review

## Story

As a pipeline operator,
I want `substrate status` to show the current active run's data immediately after starting a new run,
so that I don't see stale data from a previous run.

Fixes issue #2: Stale status endpoint after starting a new run.

## Acceptance Criteria

### AC1: Current Run ID Persisted
**Given** a new pipeline run starts
**When** the orchestrator creates a `pipeline_runs` record
**Then** the current run_id is written to `.substrate/current-run-id` alongside the PID file

### AC2: Status Reads Current Run ID
**Given** `.substrate/current-run-id` exists
**When** I run `substrate status`
**Then** it queries `pipeline_runs` by the ID in that file, not by `getLatestRun()` timestamp ordering

### AC3: Fallback to Latest Run
**Given** `.substrate/current-run-id` does NOT exist (older substrate version or no active run)
**When** I run `substrate status`
**Then** it falls back to `getLatestRun()` (backward compatibility)

### AC4: Run ID File Cleanup
**Given** a pipeline run completes or is terminated
**When** the process exits
**Then** the run ID file is cleaned up (same as PID file cleanup)

### AC5: Cross-Run Transition
**Given** run A completed and run B just started
**When** I run `substrate status` immediately after run B starts
**Then** I see run B's stories and phase, not run A's

## Tasks / Subtasks

- [x] Task 1: Write run ID file on pipeline start (AC: #1, #4)
  - [x] In `src/cli/commands/run.ts`, after `createPipelineRun()` returns the run record, write `run.id` to `.substrate/current-run-id`
  - [x] Register cleanup on `exit`, `SIGTERM`, `SIGINT` (same pattern as PID file at lines 256-267)
  - [x] Write in both the implementation-only path and the full pipeline path

- [x] Task 2: Read run ID file in status command (AC: #2, #3)
  - [x] In `src/cli/commands/status.ts`, before calling `getLatestRun()`, try to read `.substrate/current-run-id`
  - [x] If file exists and contains a valid UUID, call `getPipelineRunById(adapter, runId)` instead
  - [x] If file doesn't exist or read fails, fall back to `getLatestRun()` (existing behavior)

- [x] Task 3: Read run ID file in health command (AC: #2)
  - [x] In `src/cli/commands/health.ts`, also read `.substrate/current-run-id` for run identification
  - [x] Use this to ensure health reports on the correct run, not a stale one

- [x] Task 4: Integration test (AC: #5)
  - [x] Test: create run A, complete it, create run B — `status` shows run B's data
  - [x] Test: no run ID file — falls back to `getLatestRun()` (backward compat)

## Dev Notes

### Architecture
- **Files**: `src/cli/commands/run.ts`, `src/cli/commands/status.ts`, `src/cli/commands/health.ts`
- The run ID file path should be `join(substrateDirPath, 'current-run-id')` — same directory as `orchestrator.pid`
- The PID file pattern at `run.ts:249-270` is the template: write on start, cleanup on exit/signal
- `getLatestRun()` at `decisions.ts:487-492` queries by `created_at DESC` — this stays as the fallback

### File List
- `src/cli/commands/run.ts` (modify — write run ID file)
- `src/cli/commands/status.ts` (modify — read run ID file)
- `src/cli/commands/health.ts` (modify — read run ID file)
- `src/cli/commands/__tests__/current-run-id.test.ts` (new — integration tests for AC2, AC3, AC5)
