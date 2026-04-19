# Story 19.2: Supervisor Heartbeat Events for Agent Consumption

Status: backlog
Blocked-by: 19-1

## Story

As a parent agent (Claude Code session) monitoring the pipeline via the supervisor,
I want the supervisor to emit periodic heartbeat events in JSON mode,
so that I can track pipeline progress, report status to the user, and detect issues without relying solely on stall/kill events.

## Context

During live monitoring of a 1+ hour pipeline run (Story 18-1), the supervisor with `--output-format json` emitted **zero events** for the entire duration. The pipeline was healthy and progressing, but the agent consumer received complete silence.

The supervisor's `emitEvent()` function only fires on state transitions: stall detection, kill, restart, abort, and terminal summary. The per-poll `log()` calls (line 174-177 of `supervisor.ts`) only write when `outputFormat === 'human'`. In JSON mode, no per-poll output is produced.

This means an agent monitoring the supervisor has no way to:
- Confirm the supervisor is alive and polling
- Track story progress (phase transitions, review cycles)
- Know token consumption or cost as the run progresses
- Distinguish "everything is fine" silence from "supervisor crashed" silence

The supervisor skill documentation (`substrate-supervisor`) lists `supervisor:poll` as a key event type to handle, but the event doesn't actually exist in the implementation.

## Acceptance Criteria

### AC1: Heartbeat Event on Every Poll Cycle
**Given** the supervisor is running with `--output-format json`
**When** each poll cycle completes
**Then** a `supervisor:poll` NDJSON event is emitted to stdout containing:
  - `type: "supervisor:poll"`
  - `ts: string` (ISO 8601 timestamp)
  - `run_id: string | null`
  - `verdict: "HEALTHY" | "STALLED" | "NO_PIPELINE_RUNNING"`
  - `staleness_seconds: number`
  - `stories: { active: number, completed: number, escalated: number }`

### AC2: Story Progress in Heartbeat
**Given** the pipeline has active stories
**When** the heartbeat event is emitted
**Then** the event includes `story_details: Record<string, { phase: string, review_cycles: number }>`
**And** story phase transitions are visible across consecutive heartbeat events

### AC3: Token/Cost Snapshot in Heartbeat
**Given** token usage data is available from the pipeline run
**When** the heartbeat event is emitted
**Then** the event includes `tokens: { input: number, output: number, cost_usd: number }`
**And** the values reflect the latest cumulative token usage for the run

### AC4: Process Health in Heartbeat
**Given** the supervisor polls process health
**When** the heartbeat event is emitted
**Then** the event includes `process: { orchestrator_pid: number | null, child_count: number, zombie_count: number }`

### AC5: Human Mode Unaffected
**Given** the supervisor is running with `--output-format human` (default)
**When** the poll cycle completes
**Then** the existing human-readable log line is printed (no behavior change)
**And** no JSON events are emitted

## Dev Notes

- This is a straightforward addition to the supervisor's main loop (line 170-438 of `supervisor.ts`)
- After the `getHealth()` call and before the terminal state / stall checks, emit the heartbeat
- Token usage can be read from the health output's run data or queried from the DB
- The `PipelineHealthOutput` type already contains most of the needed fields — the heartbeat is essentially a structured serialization of the health poll result
- Keep the event payload lean — agents will receive one per poll interval (default 30-60s), so avoid large nested objects
- Consider adding a `poll_number: number` field (incrementing counter) so agents can detect missed polls

## Tasks

- [ ] Add `supervisor:poll` event type to `src/modules/implementation-orchestrator/event-types.ts`
- [ ] Emit `supervisor:poll` event after each `getHealth()` call in the supervisor loop
- [ ] Include story details, token snapshot, and process info in the event payload
- [ ] Add token/cost data to the heartbeat (query from run metrics or DB)
- [ ] Add unit test: supervisor emits poll event on each cycle in JSON mode
- [ ] Add unit test: supervisor does NOT emit poll event in human mode
- [ ] Update supervisor skill documentation to reflect that `supervisor:poll` is now implemented
