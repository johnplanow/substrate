# Story 17.1: Pipeline Supervisor — Watchdog Loop

Status: ready
Blocked-by: 16-7

## Story

As a pipeline operator (human or parent agent),
I want a long-running `substrate auto supervisor` command that monitors active pipeline runs and takes corrective action on stalls,
so that pipelines self-heal without manual intervention.

## Context

Story 16-7 added heartbeat events, watchdog timers, and `substrate auto health`. These are passive — they emit signals but nobody is listening. This story closes the loop: a supervisor process that consumes those signals and acts.

Today's workflow is: run pipeline → notice it's been quiet → manually run health check → diagnose → kill → restart. The supervisor automates this entire cycle.

## Acceptance Criteria

### AC1: Supervisor Command Registration
**Given** substrate is installed
**When** the user runs `substrate auto supervisor`
**Then** a long-running process starts that monitors the active pipeline run
**And** the command supports `--poll-interval <seconds>` (default: 60)
**And** the command supports `--output-format json|human` (default: human)
**And** the command supports `--project-root <path>`

### AC2: Health Polling Loop
**Given** the supervisor is running
**When** the poll interval elapses
**Then** it queries pipeline health (equivalent to `auto health --output-format json`)
**And** logs the verdict and key metrics to stdout
**And** continues polling until the pipeline reaches a terminal state or is interrupted

### AC3: Stall Detection and Kill
**Given** the supervisor detects a STALLED verdict
**When** the staleness exceeds `--stall-threshold <seconds>` (default: 600)
**Then** the supervisor kills the stalled orchestrator process tree
**And** logs the kill action with PIDs, staleness, and reason
**And** emits a structured event: `{"type":"supervisor:kill","ts":"...","reason":"stall","pids":[...]}`

### AC4: Automatic Restart After Kill
**Given** the supervisor has killed a stalled pipeline
**When** the kill is confirmed (process no longer running)
**Then** the supervisor restarts the pipeline with `substrate auto resume --run-id <id>`
**And** logs the restart action
**And** emits `{"type":"supervisor:restart","ts":"...","run_id":"..."}`
**And** resumes polling the new process

### AC5: Terminal State Summary
**Given** the pipeline reaches a terminal state (completed, failed, stopped)
**When** the supervisor detects this via health check
**Then** it prints a final summary: total time, stories succeeded/failed/escalated, restarts performed
**And** exits with code 0 (all succeeded) or 1 (any failed/escalated)

### AC6: Max Restarts Safety Valve
**Given** the supervisor has restarted the pipeline
**When** the restart count exceeds `--max-restarts <n>` (default: 3)
**Then** the supervisor stops attempting restarts
**And** prints a diagnostic summary and exits with code 2
**And** emits `{"type":"supervisor:abort","ts":"...","reason":"max_restarts_exceeded"}`

### AC7: Existing Tests Pass
**Given** the supervisor is implemented
**When** the full test suite runs
**Then** all existing tests pass and coverage thresholds are maintained

## Dev Notes

### Architecture

- New command: `substrate auto supervisor` registered in `auto.ts`
- Reuses `runAutoHealth()` internals (not shelling out — direct function call)
- Kill via `process.kill(pid, 'SIGTERM')` with SIGKILL fallback after 5s
- Resume via programmatic invocation of `runAutoResume()` or direct orchestrator restart
- Supervisor state machine: `POLLING → STALL_DETECTED → KILLING → RESTARTING → POLLING`
- All supervisor events follow the NDJSON protocol for `--events` consumers

### Supervisor Event Schema
```json
{"type":"supervisor:kill","ts":"...","run_id":"...","reason":"stall","staleness_seconds":720,"pids":[12345,12346]}
{"type":"supervisor:restart","ts":"...","run_id":"...","attempt":1}
{"type":"supervisor:abort","ts":"...","run_id":"...","reason":"max_restarts_exceeded","attempts":3}
{"type":"supervisor:summary","ts":"...","run_id":"...","elapsed_seconds":3600,"succeeded":["7-1"],"failed":[],"escalated":["7-2"],"restarts":1}
```

## Tasks

- [ ] Register `substrate auto supervisor` command with CLI options (AC1)
- [ ] Implement health polling loop with configurable interval (AC2)
- [ ] Implement stall detection → process kill logic (AC3)
- [ ] Implement automatic resume after kill (AC4)
- [ ] Implement terminal state summary and exit codes (AC5)
- [ ] Implement max-restarts safety valve (AC6)
- [ ] Add supervisor event types to event-types.ts and help-agent.ts
- [ ] Write unit tests for supervisor state machine
- [ ] Write integration test for stall→kill→restart cycle (mocked processes)
- [ ] Verify full test suite passes (AC7)
