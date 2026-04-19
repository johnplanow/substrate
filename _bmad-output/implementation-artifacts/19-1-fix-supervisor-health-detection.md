# Story 19.1: Fix Supervisor Health Detection Bugs

Status: review

## Story

As a pipeline operator (human or parent agent),
I want the supervisor's stall detection and process inspection to work correctly regardless of timezone or invocation method,
so that stalled pipelines are actually detected and recovered instead of silently ignored.

## Context

During a live monitoring session of Story 18-1's pipeline run, we discovered that the supervisor's core health detection is broken in two independent ways. Together, they render the supervisor's stall-detection and process-inspection capabilities non-functional for most real-world usage.

### Bug 1: Staleness always negative (timezone mismatch) — CRITICAL

The pipeline stores `updated_at` timestamps in SQLite as UTC strings without a `Z` suffix (e.g. `"2026-03-02 04:01:56"`). In `health.ts:163`, `new Date(run.updated_at)` parses this as **local time**, shifting the timestamp forward by the local UTC offset. On a machine in MST (UTC-7), this produces timestamps 7 hours in the future, yielding staleness values of approximately **-25,000 seconds**.

The supervisor's stall check (`staleness_seconds >= stallThreshold`) can **never** trigger because staleness is always deeply negative. This means:
- Stalled pipelines are never killed
- Automatic restarts never happen
- The supervisor loops silently, doing nothing, forever

**Reproduction**: Run `substrate health --output-format json` on any machine not in UTC. Observe `staleness_seconds` is negative.

**Affected code**:
- `src/cli/commands/health.ts:163-164` — `getAutoHealthData()`
- `src/cli/commands/health.ts:290-291` — `runHealthAction()` (duplicated logic)

**Fix**: `new Date(run.updated_at + 'Z')` or `new Date(run.updated_at.endsWith('Z') ? run.updated_at : run.updated_at + 'Z')` to ensure UTC parsing.

### Bug 2: Process detection misses npm/node invocations

`inspectProcessTree()` in `health.ts:70-109` scans `ps -eo pid,ppid,stat,command` for lines containing `'substrate run'`. When the pipeline is invoked via `npm run substrate:dev -- run` (the documented dev workflow) or `npx substrate run`, the `ps` command line shows:

```
node dist/cli/index.js run --events --stories 18-1
```

This does **not** match `'substrate run'`, so `orchestrator_pid` is always `null`. With no orchestrator PID:
- Child process enumeration doesn't work (keyed off orchestrator PPID)
- Zombie detection (`stat.includes('Z')`) never runs
- The `STALLED` condition at line 200 (orchestrator alive but no children with active stories) can never trigger

Stall detection falls back entirely to raw staleness — which is broken by Bug 1.

**Affected code**: `src/cli/commands/health.ts:79`

**Fix**: Match against multiple patterns: `'substrate run'`, `'index.js run'`, `'substrate-ai run'`, or better yet, look for any process whose command contains `run` and `--events` or `--stories` and is a node process.

## Acceptance Criteria

### AC1: Staleness Correctly Computed Regardless of Timezone
**Given** the pipeline stores `updated_at` as a UTC string without Z suffix
**When** `getAutoHealthData()` or `runHealthAction()` computes staleness
**Then** `staleness_seconds` is a non-negative number reflecting actual seconds since last activity
**And** the result is identical whether the machine is in UTC, MST, EST, or any other timezone

### AC2: Process Detection Works for All Invocation Methods
**Given** the pipeline was started via `npm run substrate:dev -- run`, `npx substrate run`, or a direct `substrate run`
**When** `inspectProcessTree()` scans the process tree
**Then** `orchestrator_pid` is correctly identified regardless of invocation method
**And** child processes and zombies are correctly enumerated

### AC3: Stall Detection Is Functional End-to-End
**Given** the staleness and process detection bugs are fixed
**When** a pipeline is genuinely stalled (no DB updates for > stallThreshold seconds)
**Then** the supervisor detects the stall, emits `supervisor:kill`, and initiates recovery
**And** this works on machines in any timezone

### AC4: Health Command Reports Correct Staleness
**Given** a running pipeline
**When** the user runs `substrate health --output-format json`
**Then** `staleness_seconds` is a non-negative number
**And** the value matches wall-clock seconds since the pipeline last wrote to the DB

### AC5: Deduplicate Health Logic
**Given** `getAutoHealthData()` (line 122-226) and `runHealthAction()` (line 232-397) contain duplicated staleness computation and verdict derivation
**When** the fix is applied
**Then** `runHealthAction()` delegates to `getAutoHealthData()` for core health data
**And** `runHealthAction()` only handles formatting/output concerns
**And** the hardcoded 600s stall threshold in verdict derivation is extracted to a named constant

## Dev Notes

- The timezone fix is a one-liner but affects two locations (three with the duplicate). Fix the root cause, then deduplicate.
- `new Date("2026-03-02 04:01:56")` in JavaScript: parsed as local time per spec. `new Date("2026-03-02T04:01:56Z")` parsed as UTC. Appending `'Z'` or converting to ISO format fixes it.
- For process detection, consider also storing the orchestrator PID in the DB at pipeline start (more reliable than ps scanning).
- The `staleness > 600` hardcode in `getAutoHealthData()` line 198 should use the same constant as the supervisor's configurable threshold, or at minimum be a named constant rather than a magic number.
- Run existing supervisor tests to ensure no regressions: `npm test -- "supervisor"` and `npm test -- "health"`

## Tasks

- [x] Fix timezone parsing in `getAutoHealthData()` — append 'Z' to `run.updated_at` before `new Date()`
- [x] Fix timezone parsing in `runHealthAction()` (same fix, duplicated code)
- [x] Refactor `runHealthAction()` to delegate to `getAutoHealthData()` instead of duplicating logic
- [x] Extract hardcoded 600s stall threshold to a named constant
- [x] Update `inspectProcessTree()` to match `index.js run` and `npx substrate` in addition to `substrate run`
- [x] Add unit test: staleness is non-negative for UTC timestamps without Z suffix
- [x] Add unit test: `inspectProcessTree()` finds orchestrator PID from `node dist/cli/index.js run` command
- [x] Add integration test: supervisor detects stall and emits kill event (mock deps)
- [x] Verify existing supervisor and health tests pass
