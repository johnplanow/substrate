# Story 39-4: Fix False STALLED Verdict in Health Command

Status: ready

## Story

As a pipeline operator,
I want `substrate health` to return HEALTHY when the orchestrator process is alive,
so that the supervisor doesn't kill a healthy pipeline based on a false STALLED verdict.

Fixes issue #4: Health returns STALLED with `orchestrator_pid: null` despite active heartbeats.

## Acceptance Criteria

### AC1: PID File Alive = HEALTHY
**Given** the PID file exists at `.substrate/orchestrator.pid` and the PID is alive (verified via `ps`)
**When** I run `substrate health`
**Then** the verdict is `HEALTHY` regardless of child process detection results

### AC2: STALLED Only When Process Dead
**Given** the PID file exists but the PID is NOT alive in `ps`
**When** I run `substrate health`
**Then** the verdict is `STALLED` (process died without cleanup)

### AC3: No PID File Falls Back
**Given** no PID file exists
**When** I run `substrate health`
**Then** it falls back to command-line pattern matching (existing behavior)

### AC4: Child Process Count is Informational
**Given** the orchestrator PID is alive but `child_pids` is empty (agents between dispatches)
**When** I run `substrate health`
**Then** verdict is still `HEALTHY` — child count is informational, not a health signal

### AC5: DB Staleness as Secondary Signal
**Given** the orchestrator PID is alive but DB hasn't been updated in > 600 seconds
**When** I run `substrate health`
**Then** verdict is `HEALTHY` (PID alive is authoritative). The staleness is reported but doesn't override the PID check.

## Tasks / Subtasks

- [ ] Task 1: Refactor verdict logic (AC: #1, #2, #4, #5)
  - [ ] In `src/cli/commands/health.ts`, in the verdict determination logic, add PID-alive as the primary signal:
    - PID file exists + PID alive → HEALTHY (regardless of child count or DB staleness)
    - PID file exists + PID dead → STALLED
    - No PID file → fall through to existing heuristics (command-line matching, DB staleness)
  - [ ] Move child_pids and DB staleness to informational fields (still reported, just don't override PID verdict)

- [ ] Task 2: Tests (AC: #1, #2, #3, #4, #5)
  - [ ] Test: PID file with alive PID + empty child_pids → HEALTHY
  - [ ] Test: PID file with alive PID + stale DB (>600s) → HEALTHY
  - [ ] Test: PID file with dead PID → STALLED
  - [ ] Test: No PID file → existing fallback behavior
  - [ ] Verify existing health-bugs tests still pass

## Dev Notes

### Architecture
- **File**: `src/cli/commands/health.ts` — main change
- The current verdict logic at `getAutoHealthData()` (lines 481-502) uses multiple signals: process tree, DB staleness, story states. The bug is that when the process tree inspection fails to find children, it overrides the PID file evidence.
- The fix prioritizes: PID file alive > everything else for HEALTHY/STALLED determination
- `NO_PIPELINE_RUNNING` verdict stays the same: no run in DB with status='running'

### File List
- `src/cli/commands/health.ts` (modify)
