# Story 15.1: Event Protocol Foundation

Status: ready

## Story

As a pipeline consumer (AI agent or tooling),
I want `substrate auto run --events` to emit structured NDJSON events on stdout,
so that I can programmatically observe pipeline progress, make decisions on escalations, and drive the pipeline conversationally.

## Context

Currently `substrate auto run` outputs unstructured pino JSON logs to stderr. AI agents like Claude Code cannot reliably parse these to understand pipeline state. The event protocol establishes a typed, stable contract that any consumer can depend on — forming the foundation for agent integration (Story 15-3, 15-4), human-readable output (Story 15-2), and TUI rendering (Story 15-5).

## Acceptance Criteria

### AC1: --events Flag
**Given** the user runs `substrate auto run --events`
**When** the pipeline executes
**Then** structured NDJSON events are written to stdout (one JSON object per line)
**And** pino logs continue to write to stderr (no interference)
**And** each event line is valid JSON parseable by `JSON.parse()`

### AC2: Pipeline Lifecycle Events
**Given** the pipeline starts and completes
**When** events are emitted
**Then** `pipeline:start` is the first event, containing `run_id`, `stories` array, and `concurrency`
**And** `pipeline:complete` is the last event, containing `succeeded`, `failed`, and `escalated` arrays
**And** every story key from the start event appears in exactly one of the three completion arrays

### AC3: Story Phase Events
**Given** a story transitions between phases (create-story, dev-story, code-review, fix)
**When** the phase starts or completes
**Then** a `story:phase` event is emitted with `key`, `phase`, and `status`
**And** `status: 'complete'` events include `verdict` for code-review phases
**And** `status: 'complete'` events include `file` for create-story phases (path to generated story file)

### AC4: Story Completion Events
**Given** a story reaches a terminal state
**When** the story succeeds or fails
**Then** a `story:done` event is emitted with `key`, `result`, and `review_cycles` count

### AC5: Escalation Events
**Given** a story fails code review after the maximum review cycles
**When** the orchestrator escalates
**Then** a `story:escalation` event is emitted with `key`, `reason`, `cycles`, and `issues` array
**And** each issue in the array contains `severity`, `file`, and `desc`

### AC6: Warning and Log Events
**Given** the pipeline encounters non-fatal warnings (e.g., token ceiling truncation)
**When** the warning occurs
**Then** a `story:warn` event is emitted with `key` and `msg`
**And** optionally `story:log` events may be emitted for informational messages

### AC7: Timestamp on All Events
**Given** any event is emitted
**Then** it includes a `ts` field with an ISO-8601 timestamp
**And** timestamps are generated at emit time (not from upstream data)

### AC8: Event Type Definitions Exported
**Given** a TypeScript consumer wants to use the event types
**When** they import from substrate
**Then** `PipelineEvent` discriminated union type and all constituent event types are exported from the package

### AC9: No Events Without --events Flag
**Given** the user runs `substrate auto run` without `--events`
**When** the pipeline executes
**Then** no NDJSON events are written to stdout
**And** existing behavior (pino logs to stderr) is unchanged

## Dev Notes

### Architecture

- New file: `src/modules/implementation-orchestrator/event-emitter.ts`
  - `createEventEmitter(stream: Writable): EventEmitter` — factory that returns an emitter bound to the output stream
  - `emit(event: PipelineEvent): void` — JSON.stringify + newline + write
  - Fire-and-forget: write errors are swallowed (don't crash pipeline for a broken stdout pipe)
- New file: `src/modules/implementation-orchestrator/event-types.ts`
  - TypeScript discriminated union: `PipelineEvent`
  - All 7 event type interfaces
  - Exported from package index for external consumers
- Modified: `src/cli/commands/auto.ts`
  - Add `--events` flag to the command definition
  - Instantiate event emitter when flag is present (bound to `process.stdout`)
  - Pass emitter into pipeline orchestrator
  - Emit events at each pipeline state transition
- Modified: `src/modules/implementation-orchestrator/index.ts`
  - Accept optional `EventEmitter` in pipeline options
  - Emit events at phase transitions, completions, escalations

### Event Sequence Invariants (for testing)

1. `pipeline:start` is always the first event
2. `pipeline:complete` is always the last event
3. Every `story:phase` with `status: 'in_progress'` is followed by a matching `status: 'complete'` or `status: 'failed'`
4. Every story key in `pipeline:start.stories` appears in exactly one terminal event (`story:done` or `story:escalation`)
5. `story:done` and `story:escalation` are mutually exclusive per story key
6. Event order within a story is: phase events (chronological) -> done/escalation

### Backpressure

stdout is buffered by Node.js. If the consumer is slow, events accumulate in the buffer. The pipeline does NOT await drain events — fire-and-forget semantics. If the buffer fills and the write returns false, we continue without blocking.

## Tasks

- [ ] Define `PipelineEvent` discriminated union in `event-types.ts`
- [ ] Implement `createEventEmitter()` factory in `event-emitter.ts`
- [ ] Add `--events` flag to auto command in `auto.ts`
- [ ] Wire event emitter into pipeline orchestrator
- [ ] Emit `pipeline:start` and `pipeline:complete` events
- [ ] Emit `story:phase` events at each phase transition
- [ ] Emit `story:done` events on story completion
- [ ] Emit `story:escalation` events on review cycle limit
- [ ] Emit `story:warn` events for token ceiling and other warnings
- [ ] Export event types from package index
- [ ] Write unit tests for event emitter (emit, serialization, error swallowing)
- [ ] Write contract tests for event type definitions
- [ ] Write integration test: 2-story pipeline with --events, assert event sequence invariants
- [ ] Verify no events emitted without --events flag
