# Story 39-1: Wire NDJSON Emitter in Full Pipeline Path

Status: ready

## Story

As a pipeline operator,
I want `--from <phase> --events` to produce the same NDJSON event stream as `--events` alone,
so that monitoring tools (supervisor, CLI polling) work identically regardless of how the pipeline was started.

Fixes issue #9: `--from implementation` loses NDJSON events.

## Acceptance Criteria

### AC1: Full Pipeline Path Emits NDJSON Events
**Given** a pipeline started with `substrate run --from implementation --events --stories 1-1`
**When** the pipeline runs
**Then** NDJSON events (heartbeats, story phase transitions, dispatches, completions) are emitted to stdout identically to `substrate run --events --stories 1-1`

### AC2: Shared Event Subscription Logic
**Given** the NDJSON event subscription block in `run.ts`
**When** I inspect the code
**Then** a single shared function wires all event subscriptions, called from both the implementation-only path and the full pipeline path

### AC3: Phase Transition Events in Full Pipeline
**Given** a pipeline started with `--from analysis --events`
**When** analysis completes and planning starts
**Then** `pipeline:phase-complete` and `pipeline:phase-start` events are emitted as NDJSON

### AC4: Backward Compatibility
**Given** a pipeline started without `--events`
**When** the pipeline runs
**Then** no NDJSON is emitted (existing behavior preserved)

## Tasks / Subtasks

- [ ] Task 1: Extract event subscription into shared helper (AC: #2)
  - [ ] In `src/cli/commands/run.ts`, extract lines 906-1039 (the NDJSON event subscription block) into a function like `wireNdjsonEmitter(eventBus, emitter)`
  - [ ] Call this function from the implementation-only path where the subscriptions currently live
  - [ ] Verify implementation-only path still works identically

- [ ] Task 2: Wire NDJSON in `runFullPipeline()` (AC: #1, #3)
  - [ ] In the full pipeline path (`runFullPipeline()`, around line 1711), create the NDJSON emitter when `eventsFlag === true`
  - [ ] Call the shared `wireNdjsonEmitter()` function with the phase orchestrator's event bus
  - [ ] Ensure heartbeats, story events, and phase transition events are all subscribed

- [ ] Task 3: Tests (AC: #1, #4)
  - [ ] Add test: `--from implementation --events` produces NDJSON output (at minimum a `pipeline:start` event)
  - [ ] Add test: `--from implementation` without `--events` produces no NDJSON
  - [ ] Verify existing event-flow tests still pass

## Dev Notes

### Architecture
- **File**: `src/cli/commands/run.ts` — main change
- The implementation-only path (lines 906-1039) has ~20 event subscriptions (story:phase, story:dispatch, story:complete, story:escalation, heartbeats, etc.)
- The full pipeline path (`runFullPipeline()`) at line 1711 only creates a local emitter for error reporting
- The fix is mechanical: extract + reuse
- The event bus is available in both paths — `runFullPipeline()` creates an orchestrator that has an event bus

### File List
- `src/cli/commands/run.ts` (modify)
