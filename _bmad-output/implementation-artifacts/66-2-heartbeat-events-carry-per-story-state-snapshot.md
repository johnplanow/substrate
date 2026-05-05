# Story 66-2: Heartbeat Events Carry per_story_state Snapshot

## Story

As an operator monitoring a substrate pipeline run,
I want each `pipeline:heartbeat` event to include a snapshot of per-story phase and status,
so that I can detect obs_022-class drift between the orchestrator's in-memory state and the persisted manifest in real-time without waiting for the orchestrator to die.

## Acceptance Criteria

<!-- source-ac-hash: b96052b9feae89fb03f589ff1345e1d2250feea6a5c5d096e3724097ae6b0e98 -->

1. `pipeline:heartbeat` event schema in `packages/sdlc/src/run-model/event-types.ts`
   gains a new optional field
   `per_story_state: Record<string, { phase: string; status: string }>`
   alongside the existing `completed_dispatches: number` field.
2. Orchestrator's heartbeat emission populates the new field with the
   current in-memory `state.phase` and `state.status` for each active
   story.
3. Existing heartbeat consumers (CLI status output, supervisor) MUST
   continue to work without modification — the field is additive and
   optional.
4. Unit tests assert: (a) heartbeat event includes the new field when
   stories are active; (b) heartbeat event omits the field (or emits
   empty object) when no stories are dispatched; (c) field shape
   matches the schema.
5. `substrate status --output-format json` surfaces the latest
   heartbeat-emitted `per_story_state` snapshot under a top-level
   `latest_heartbeat_per_story_state` key (or equivalent), so
   operators can `jq` the drift check.
6. Commit message references obs_2026-05-03_022 fix #2.

## Tasks / Subtasks

- [x] Task 1: Extend `pipeline:heartbeat` schema in `event-types.ts` (AC: #1)
  - [x] Locate the `PipelineHeartbeatEvent` type (or equivalent) in `packages/sdlc/src/run-model/event-types.ts`
  - [x] Add optional field `per_story_state?: Record<string, { phase: string; status: string }>` alongside `completed_dispatches`
  - [x] Optionally define a named type alias `HeartbeatStorySnapshot = { phase: string; status: string }` if it improves readability

- [x] Task 2: Update orchestrator heartbeat emission to populate new field (AC: #2, #3)
  - [x] Locate the heartbeat emission site in `src/modules/implementation-orchestrator/orchestrator-impl.ts`
  - [x] At emission time, collect `state.phase` and `state.status` from the in-memory state map for each active story
  - [x] Populate `per_story_state` on the emitted event; omit or set to `{}` when no stories are active
  - [x] Confirm the field is optional so existing consumers (supervisor, CLI) require no changes

- [x] Task 3: Surface latest heartbeat snapshot in `substrate status` JSON output (AC: #5)
  - [x] Locate where status JSON is assembled in `src/cli/commands/status.ts`
  - [x] Track the latest heartbeat event's `per_story_state` value (in-memory cache updated on each heartbeat)
  - [x] Add `latest_heartbeat_per_story_state` as a top-level key in the JSON output (value is the `per_story_state` map, or `{}` / omitted when none received yet)
  - [x] Verify `substrate status --output-format json | jq '.latest_heartbeat_per_story_state'` produces a usable output

- [x] Task 4: Write unit tests (AC: #4)
  - [x] Test (a): when active stories are present in the orchestrator state map, the emitted heartbeat event has a `per_story_state` field with correct `phase` and `status` entries for each story key
  - [x] Test (b): when no stories are dispatched, the heartbeat event either omits `per_story_state` or emits an empty object `{}`
  - [x] Test (c): the emitted `per_story_state` value satisfies the TypeScript type `Record<string, { phase: string; status: string }>` (assert key/value shapes directly)
  - [x] Test (d): status command JSON output includes `latest_heartbeat_per_story_state` reflecting the most recently received heartbeat's `per_story_state`

## Dev Notes

### Architecture Constraints
- The `per_story_state` field MUST be optional (`?`) in the event schema — this preserves backward compatibility for all existing heartbeat consumers (CLI status, supervisor) per AC3; those consumers must not require modification
- Do not alter the heartbeat emission interval, trigger conditions, or any other aspect of the existing heartbeat mechanism
- Read from in-memory orchestrator state only — no new external state dependencies introduced by this story
- Follow existing import and export conventions in `event-types.ts` (likely index-exported from `packages/sdlc/src/run-model/`)

### Key Files
| File | Purpose |
|---|---|
| `packages/sdlc/src/run-model/event-types.ts` | Add optional `per_story_state` field to heartbeat event schema |
| `src/modules/implementation-orchestrator/orchestrator-impl.ts` | Populate `per_story_state` at heartbeat emission time |
| `src/cli/commands/status.ts` | Cache latest heartbeat `per_story_state`; surface under `latest_heartbeat_per_story_state` in JSON output |
| Corresponding `*.test.ts` files near each source file | Unit tests per AC4 |

### Testing Requirements
- Use `npm run test:fast` during iteration (unit tests only, ~50s)
- Use `npm run test:changed` for targeted validation against changed files
- Full suite: `npm test` before merging
- NEVER run tests concurrently — verify `pgrep -f vitest` returns nothing first
- ALWAYS use `timeout: 300000` (5 min) when invoking the test suite
- NEVER pipe test output through `tail`, `head`, `grep`, or similar — pipes discard the vitest summary

### How to Locate the Heartbeat Emission Site
Search for `pipeline:heartbeat` string in `src/modules/implementation-orchestrator/orchestrator-impl.ts`. The emission likely occurs inside a `setInterval`-based timer or a dedicated `emitHeartbeat` helper. Collect the in-memory per-story state at that point — look for a `Map` or `Record` keyed by story key where `phase` and `status` are tracked.

### Status CLI Pattern
Look at how existing top-level fields are assembled in `substrate status --output-format json`. The status command likely reads from a running orchestrator's event stream or a cached state object. Add `latest_heartbeat_per_story_state` by caching the most recently received heartbeat event's `per_story_state` field (update on each heartbeat event received; initialize to `undefined` or `{}`).

### Commit Message Requirement (AC6)
The commit message must reference `obs_2026-05-03_022 fix #2`. Example:
```
feat(orchestrator): heartbeat events carry per_story_state snapshot (obs_2026-05-03_022 fix #2)
```

## Interface Contracts

- **Export**: `PipelineHeartbeatEvent` (extended with optional `per_story_state`) @ `packages/sdlc/src/run-model/event-types.ts`

## Dev Agent Record

### Agent Model Used
claude-opus-4-5

### Completion Notes List
- `PipelineHeartbeatEvent` actual location is `src/modules/implementation-orchestrator/event-types.ts` (not `packages/sdlc/src/run-model/event-types.ts` as the story specifies — the sdlc package's event-types.ts only contains `DispatchSpawnSyncTimeoutEvent`). Added `HeartbeatStorySnapshot` type and `per_story_state?` field to the correct file.
- Added `perStoryState?` to `orchestrator:heartbeat` in `src/core/event-bus.types.ts` for the internal event bus.
- Heartbeat sidecar file approach: since `substrate status` is a one-shot command (no live event stream), the orchestrator writes `per_story_state` to `.substrate/latest-heartbeat-per-story-state.json` on each heartbeat tick; status reads this file.
- `storyPhaseToStatus()` helper maps internal `StoryPhase` → consumer-facing status string (matching `PerStoryStatus` values from per-story-state.ts).
- 6 new tests: 3 in heartbeat-watchdog.test.ts (AC4a/b/c), 3 in new status-heartbeat-snapshot.test.ts (AC4d).
- All 9443 tests pass; build clean.

### File List
- `src/modules/implementation-orchestrator/event-types.ts` (modified)
- `src/core/event-bus.types.ts` (modified)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (modified)
- `src/cli/commands/run.ts` (modified)
- `src/cli/commands/resume.ts` (modified)
- `src/cli/commands/status.ts` (modified)
- `src/modules/implementation-orchestrator/__tests__/heartbeat-watchdog.test.ts` (modified)
- `src/cli/commands/__tests__/status-heartbeat-snapshot.test.ts` (created)

## Change Log
