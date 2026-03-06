# Story 21-2: Supervisor Reliability Fixes

Status: done (all ACs shipped across v0.2.12–v0.2.15)

## Story

As a pipeline operator,
I want the supervisor to correctly recover from stalls, monitor all pipeline phases, and clean up child processes on kill,
so that supervised pipelines can self-heal without manual intervention or resource leaks.

## Background

Three bugs were identified during a code-review-agent pipeline supervision session (2026-03-04). Together they make the supervisor unreliable for long-running pipelines — it kills stalled pipelines but can't restart them properly, exits prematurely during early phases, and leaks orphan processes that consume memory.

## Acceptance Criteria

### AC1: Restart Uses `resume` Instead of `run`
**Given** the supervisor detects a stall and kills the orchestrator
**When** it attempts to restart the pipeline
**Then** it invokes `substrate resume --run-id {run_id}` (not `substrate run`), so the pipeline continues from where it left off rather than re-running analysis on a project with existing artifacts

### AC2: Analysis-Step Failure No Longer Occurs on Restart
**Given** a project has completed stories 1-1 through 1-3 and stalls on 1-4
**When** the supervisor restarts the pipeline
**Then** the restart succeeds and picks up from story 1-4 (not from analysis-step-1-vision)

### AC3: Supervisor Monitors All Pipeline Phases
**Given** a pipeline is running in analysis, planning, or solutioning phase
**When** the supervisor polls status
**Then** it reports `HEALTHY` (not `NO_PIPELINE_RUNNING`) and continues monitoring; it only exits when the pipeline has truly completed or failed — not during phase transitions

### AC4: Phase Transition Grace Period
**Given** the supervisor sees `NO_PIPELINE_RUNNING` in a single poll
**When** the next poll occurs 30 seconds later
**Then** the supervisor re-checks before concluding the pipeline has exited; it requires N consecutive `NO_PIPELINE_RUNNING` polls (e.g., 3) before declaring the pipeline done

### AC5: Orphan Child Processes Killed on Orchestrator Kill
**Given** the supervisor kills an orchestrator process (PID X)
**When** the kill signal is sent
**Then** the supervisor also kills the orchestrator's entire process group (or walks the child PID tree) so that spawned `claude -p` agent subprocesses do not survive as orphans consuming memory

### AC6: Orphan Cleanup Verified by Process Check
**Given** the supervisor has killed an orchestrator and its children
**When** the supervisor polls 10 seconds after the kill
**Then** no processes from the killed orchestrator's process tree are still running (verified via `pgrep -P` or `/proc` walk)

## Tasks / Subtasks

- [x] Task 1: Change supervisor restart to use `resume` (AC: #1, #2) — shipped v0.2.12
  - [x] `substrate resume --run-id {run_id}` in supervisor restart logic
  - [x] Pass through relevant flags (--concurrency, --output-format, etc.)
  - [x] Test: supervisor restart after stall continues from correct story

- [x] Task 2: Monitor all pipeline phases (AC: #3) — shipped v0.2.12
  - [x] Supervisor recognizes analysis/planning/solutioning as active phases
  - [x] `NO_PIPELINE_RUNNING` only when no phase has `status: "running"`

- [x] Task 3: Add phase transition grace period (AC: #4) — shipped v0.2.12
  - [x] Track consecutive `NO_PIPELINE_RUNNING` count
  - [x] 5s liveness check with retries before declaring pipeline done
  - [x] Reset counter if any poll shows activity

- [x] Task 4: Kill process group on orchestrator kill (AC: #5, #6) — shipped v0.2.12
  - [x] `getAllDescendantPids()` walks child PID tree recursively
  - [x] SIGTERM + 5s grace period + SIGKILL escalation
  - [x] Post-kill verification: checks for surviving children

## Dev Notes

### Key Files
- Supervisor implementation: `src/cli/commands/supervisor.ts`
- Supervisor restart logic: look for `supervisor:restart` event emission
- Process kill logic: look for `supervisor:kill` event emission

### Observed Failure Modes (2026-03-04)
- **Restart → analysis failure**: Supervisor ran `substrate run` on restart, hit `analysis-step-1-vision` failure because project already had analysis artifacts. Happened on every restart attempt (3/3 failed).
- **Premature exit**: nextgen-ticketing pipeline in analysis phase — supervisor saw `NO_PIPELINE_RUNNING` on first poll and exited immediately. Pipeline was still active.
- **Orphan agents**: PID 6333 (`claude -p` code-review agent) survived orchestrator kill, ran for 8+ minutes as orphan consuming 380MB RSS. Work was lost since no orchestrator tracked the output.

## Change Log
- 2026-03-04: Story created from bugs identified during code-review-agent pipeline supervision
