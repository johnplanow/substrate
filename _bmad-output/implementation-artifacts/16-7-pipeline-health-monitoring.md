# Story 16.7: Pipeline Health Monitoring and Stall Detection

Status: review

## Story

As a pipeline operator (human or parent agent),
I want the pipeline to detect stalls, emit heartbeat signals, and expose a quick health-check command,
so that I can distinguish "working silently" from "stuck" without manually inspecting process trees.

## Context

During a production pipeline run (stories 16-1, 16-2), the orchestrator stalled silently for 2+ hours after an EPIPE broke its promise chain. The only way to diagnose this was manual inspection of process trees, zombie children, CPU usage, and git state — six commands and 10 minutes of forensics. The pipeline needs self-monitoring so that both human operators and parent agents can detect problems quickly.

The EPIPE root cause was fixed in v0.1.20 (`b95da99`), but the observability gap remains: if *any* future bug causes a stall, the operator has no automated way to detect it.

## Acceptance Criteria

### AC1: Heartbeat Events
**Given** the pipeline is running with `--events` mode active
**When** no progress event has been emitted for 30 seconds
**Then** the orchestrator emits a `{"type":"heartbeat","ts":"...","active_dispatches":N}` NDJSON event
**And** the heartbeat includes counts of running, queued, and completed dispatches

### AC2: Watchdog Timer
**Given** the orchestrator has dispatched a sub-agent
**When** no sub-agent completes or produces output for longer than `watchdog_timeout` (default: 10 minutes)
**Then** the orchestrator emits a `story:stall` event with diagnostic info (child PIDs, elapsed time)
**And** the stall event is logged at WARN level

### AC3: Health Check Command
**Given** a pipeline run is in progress
**When** the user runs `substrate auto health`
**Then** the output includes:
  - Process tree status (orchestrator PID, child PIDs, zombie detection)
  - Time since last progress event
  - Dispatch count vs completion count per story
  - Overall verdict: `HEALTHY`, `STALLED`, or `NO_PIPELINE_RUNNING`
**And** the command supports `--output-format json` for programmatic consumption

### AC4: Status Command Enhancement
**Given** a pipeline run is in progress
**When** the user runs `substrate auto status --output-format json`
**Then** the response includes `last_event_ts` (timestamp of most recent progress event)
**And** the response includes `active_dispatches` count
**And** a parent agent can detect stalls by comparing `last_event_ts` to current time

### AC5: Stall Auto-Recovery (Stretch)
**Given** the watchdog detects a stall
**When** the stalled sub-agent has exceeded 2x its `DEFAULT_TIMEOUT`
**Then** the orchestrator kills the stalled child process
**And** retries the dispatch once
**And** emits a `story:recovery` event

### AC7: Supervisor Monitors All Phases
**Given** the supervisor is running and a pipeline is in research, analysis, planning, or solutioning phase
**When** the supervisor polls health
**Then** it correctly detects the pipeline as running (not `NO_PIPELINE_RUNNING`)
**And** stall detection works for all phases, not just implementation

_Context: Currently `getAutoHealthData` derives verdict from `run.status === 'running'` which works for all phases, but the process tree inspection (`isOrchestratorProcessLine`) only matches `substrate run` processes. Pre-implementation phases (research, analysis, planning, solutioning) are run via `substrate run --from <phase>` so this should already match, but needs explicit test coverage._

### AC8: Supervisor Kills Orphan Child Processes on Stall Recovery
**Given** the supervisor kills a stalled orchestrator
**When** the orchestrator had spawned `claude -p` sub-agents
**Then** the supervisor also kills those child processes (not just the orchestrator PID)
**And** no orphan `claude` or `node` processes remain consuming memory

_Context: Current code kills `health.process.child_pids` (direct children of orchestrator). But `claude -p` may spawn its own children (node subprocesses) forming a process tree. Need to kill the entire process group or walk the tree._

### AC9: Existing Tests Pass
**Given** the monitoring features are implemented
**When** the full test suite runs
**Then** all existing tests pass
**And** coverage thresholds are maintained

## Dev Notes

### Architecture

- Modified: `src/modules/implementation-orchestrator/orchestrator-impl.ts`
  - Add heartbeat interval timer (30s) that emits via event bus when `--events` active
  - Add watchdog timer per active dispatch that fires on timeout
  - Track `last_progress_ts` updated on every sub-agent completion or event

- Modified: `src/cli/commands/auto.ts`
  - Register `auto health` subcommand
  - Wire heartbeat events to NDJSON emitter
  - Wire stall events to NDJSON emitter
  - Add `last_event_ts` and `active_dispatches` to status JSON output

- New: `src/cli/commands/auto-health.ts` (or inline in auto.ts)
  - Process tree inspection via `child_process.execSync('ps ...')`
  - Zombie detection (`<defunct>` in ps output)
  - Query pipeline run status from DB
  - Compute health verdict

### Supervisor Bug Fixes (folded in from MEMORY.md 2026-03-04 findings)

**Bug 1: "Restart uses `run` instead of `resume`"** — Already fixed. `supervisor.ts:469` calls `resumePipeline()` which delegates to `runResumeAction`. No work needed.

**Bug 2: "Only monitors implementation phase"** (AC7) — The health verdict logic in `health.ts:243` checks `run.status === 'running'` which is phase-agnostic. The process tree detection (`isOrchestratorProcessLine`) matches `substrate run` which is the same binary for all phases. Risk is low but needs explicit test coverage for non-implementation phases to prevent regressions.

**Bug 3: "Orphan child processes"** (AC8) — `supervisor.ts:400-416` kills `health.process.child_pids` (direct children of orchestrator PID). But `claude -p` sub-agents spawn their own node children, forming a 3+ level process tree. Only the immediate children are killed; grandchildren become orphans reparented to PID 1. Fix: use process group kill (`kill -SIGTERM -<pgid>`) or walk `/proc`/`ps` tree recursively to collect all descendants before killing.

### Heartbeat Event Schema
```json
{"type":"heartbeat","ts":"2026-02-28T19:30:00Z","run_id":"...","active_dispatches":2,"completed_dispatches":1,"queued_dispatches":0}
```

### Stall Event Schema
```json
{"type":"story:stall","ts":"...","run_id":"...","story_key":"16-2","phase":"dev-story","elapsed_ms":600000,"child_pid":12345}
```

## Tasks

- [ ] Add heartbeat timer to implementation orchestrator (AC1)
- [ ] Wire heartbeat events to NDJSON `--events` emitter (AC1)
- [ ] Add watchdog timer per active dispatch (AC2)
- [ ] Emit `story:stall` event on watchdog timeout (AC2)
- [ ] Implement `substrate auto health` command (AC3)
- [ ] Add `last_event_ts` and `active_dispatches` to status JSON (AC4)
- [ ] Add test coverage for supervisor health detection across all phases — research, analysis, planning, solutioning, implementation (AC7)
- [ ] Implement recursive process tree kill in supervisor stall recovery — kill entire process group or walk descendant tree (AC8)
- [ ] Add tests for orphan cleanup: mock a 3-level process tree, verify all descendants killed (AC8)
- [ ] Write unit tests for heartbeat and watchdog timers
- [ ] Write unit tests for health command output
- [ ] Write integration test for stall detection
- [ ] Verify full test suite passes (AC9)
