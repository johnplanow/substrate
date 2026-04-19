# Story 23-6: Process Detection Cross-Project Fix

Status: review

## Story

As a pipeline operator running substrate against any project,
I want health checks and supervisor to correctly detect orchestrator and child agent processes,
so that stall detection, health verdicts, and supervisor decisions are based on accurate process state.

Addresses finding 6 (process detection always returns null) from `docs/findings-cross-project-epic4-2026-03-05.md`.

## Acceptance Criteria

### AC1: Orchestrator PID Detected During Cross-Project Runs
**Given** a substrate pipeline running against a non-substrate project
**When** `substrate health` or the supervisor queries process state
**Then** `orchestrator_pid` is non-null and matches the actual orchestrator process

### AC2: Child PIDs Detected During Active Dispatches
**Given** one or more child agent processes (claude -p) spawned by the dispatcher
**When** process detection runs
**Then** `child_pids` contains the correct PIDs of active child processes

### AC3: Process Detection Not Tied to Project-Specific Paths
**Given** the v0.2.13 project-scoped process detection (`inspectProcessTree`)
**When** running against a project at a different path than substrate
**Then** detection still works by matching on the pipeline run's known process tree (not hardcoded paths)

### AC4: Health Verdict Reflects Real State
**Given** a running pipeline with active child processes
**When** `substrate health` reports
**Then** the verdict is NOT `NO_PIPELINE_RUNNING` (it was incorrectly reporting this during the Epic 4 run)

## Tasks / Subtasks

- [x] Task 1: Diagnose cross-project process detection failure (AC: #1, #3)
  - [x] Review `inspectProcessTree` in supervisor module
  - [x] Identify why project-scoping fails when target project path differs from substrate install path
  - [x] Document root cause in this story file

- [x] Task 2: Fix process detection to work cross-project (AC: #1, #2, #3)
  - [x] Fix the project-scoping logic to use the target project's `--project-root` path
  - [x] Ensure child processes spawned with the target project's working directory are matched
  - [x] Verify zombie detection still works

- [x] Task 3: Fix health verdict logic (AC: #4)
  - [x] Ensure health endpoint uses corrected process detection
  - [x] `NO_PIPELINE_RUNNING` should only be reported when no orchestrator PID exists AND no pipeline run is in `RUNNING` state in the DB

- [x] Task 4: Write tests (AC: #1–#4)
  - [x] Test: process detection with non-default project root
  - [x] Test: health verdict with active processes at non-substrate path
  - [x] Test: health verdict with no processes and no running pipeline → NO_PIPELINE_RUNNING

## Dev Notes

### Architecture Constraints
- **Files**:
  - `src/modules/supervisor/` — `inspectProcessTree`, health verdict logic
  - `src/modules/implementation-orchestrator/` — health endpoint
- **Test framework**: vitest (not jest).

### Key Context
- v0.2.13 (commit `f796859`) added project-scoped process detection to avoid cross-project false positives. The fix may have been too aggressive — filtering out processes for the target project entirely.
- The health check consistently reported `orchestrator_pid: null, child_pids: [], zombies: []` while both orchestrator and child agents were actively running during the Epic 4 run.
- This is a prerequisite for story 23-7 (activity heartbeat stall detection).

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest).

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Root cause: `isOrchestratorProcessLine(line, projectRoot)` used `line.includes(projectRoot)` for project-scoping. When `substrate run` is invoked from a project directory (CWD = project root) without `--project-root` flag, the project root path never appears in the process command line (`ps` output), so detection always returned null.
- Fix: Write `process.pid` to `.substrate/orchestrator.pid` when the pipeline starts (`run.ts`). `inspectProcessTree` reads this file first (primary path), verifies the PID is alive in ps output, then finds children normally. Falls back to command-line matching if PID file absent.
- AC4 fix: Removed the `orchestrator_pid === null && active === 0 && completed > 0 → NO_PIPELINE_RUNNING` inference from within the `run.status === 'running'` block. When the DB says the run is running, trust that; only emit NO_PIPELINE_RUNNING for terminal DB statuses.
- All 4660 tests pass, 17 new tests added.

### File List
- `/Users/John.Planow/code/jplanow/substrate/src/cli/commands/health.ts`
- `/Users/John.Planow/code/jplanow/substrate/src/cli/commands/run.ts`
- `/Users/John.Planow/code/jplanow/substrate/src/cli/commands/__tests__/cross-project-process-detection.test.ts`

## Change Log
