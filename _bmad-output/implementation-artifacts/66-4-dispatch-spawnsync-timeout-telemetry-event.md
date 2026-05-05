# Story 66-4: `dispatch:spawnsync-timeout` Telemetry Event Emission

## Story

As a substrate operator,
I want a `dispatch:spawnsync-timeout` event emitted whenever the dispatcher's `spawnSync` call is killed by ETIMEDOUT,
so that timeout patterns are queryable in OTEL persistence and surfaceable by the supervisor and status CLI.

## Acceptance Criteria

<!-- source-ac-hash: 1e771eaeccb8404ec898ecc3bddfd12c07e67ddca418b782f41969570431bd01 -->

### AC1: New event type declaration
New event type `dispatch:spawnsync-timeout` declared in
`packages/sdlc/src/run-model/event-types.ts` with shape:
```ts
{
  type: 'dispatch:spawnsync-timeout',
  storyKey: string,
  taskType: string,           // e.g. 'probe-author', 'dev-story'
  attemptNumber: 1 | 2,        // 1 = initial, 2 = retry
  timeoutMs: number,           // the timeout that was exceeded
  elapsedAtKill: number,       // wall-clock from spawn to kill (ms)
  pid?: number,                // child PID if available
  occurredAt: string           // ISO timestamp
}
```

### AC2: Event emission in dispatcher
`packages/core/src/dispatch/dispatcher-impl.ts` emits the event
from the existing ETIMEDOUT catch path. Both attempt 1 (initial,
300_000 ms default) and attempt 2 (retry, 450_000 ms default at
1.5×) emit the event distinctly via `attemptNumber`.

### AC3: Elapsed time measurement
`elapsedAtKill` is measured with `Date.now()` deltas around the
spawnSync call.

### AC4: Unit test coverage
Unit test asserts event is emitted with correct fields when
spawnSync ETIMEDOUTs (use a deliberately-slow stub subprocess).

### AC5: Backward compatibility
Backward-compat: legacy event consumers MUST continue to work —
this event is additive.

### AC6: Commit message reference
Commit message references obs_2026-05-04_023 fix #3.

## Tasks / Subtasks

- [x] Task 1: Declare `dispatch:spawnsync-timeout` event type in event-types.ts (AC: #1)
  - [x] Open `packages/sdlc/src/run-model/event-types.ts` and review the existing event type naming conventions and union type structure
  - [x] Add a new exported TypeScript interface for `dispatch:spawnsync-timeout` matching the exact shape from AC1 (all required fields + optional `pid?: number`)
  - [x] Add the new event type to any existing discriminated union that aggregates all dispatcher/pipeline event types

- [x] Task 2: Add `Date.now()` timing wrappers around `spawnSync` in dispatcher-impl.ts (AC: #3)
  - [x] Locate all `spawnSync` call sites in `packages/core/src/dispatch/dispatcher-impl.ts`
  - [x] Capture `const spawnStart = Date.now()` immediately before each `spawnSync` invocation
  - [x] Compute `elapsedAtKill = Date.now() - spawnStart` in the ETIMEDOUT catch/check branch, using the captured start time

- [x] Task 3: Emit `dispatch:spawnsync-timeout` event from the ETIMEDOUT path (AC: #2, #3)
  - [x] Locate the existing ETIMEDOUT detection logic in `dispatcher-impl.ts` (likely checks `result.error?.code === 'ETIMEDOUT'` or `result.status === null` with the timeout option exceeded)
  - [x] In the ETIMEDOUT branch for attempt 1, emit `dispatch:spawnsync-timeout` with `attemptNumber: 1`, the configured `timeoutMs`, computed `elapsedAtKill`, `pid` from `result.pid` if truthy, and `occurredAt: new Date().toISOString()`
  - [x] In the ETIMEDOUT branch for attempt 2 (retry), emit the same event with `attemptNumber: 2` and the retry timeout (1.5× initial, 450_000 ms default)
  - [x] Ensure the event emission does not alter the subsequent retry/escalation control flow

- [x] Task 4: Write unit tests for the ETIMEDOUT event emission paths (AC: #4, #5)
  - [x] In the existing or a new test file alongside `dispatcher-impl.ts`, add a test suite for the ETIMEDOUT event
  - [x] Stub `spawn` to return a hanging process (never emits 'close') so the async timeout handler fires — keeps the test fast (no real slow process)
  - [x] Assert the emitted event has correct `type: 'dispatch:spawnsync-timeout'`, `storyKey`, `taskType`, `attemptNumber: 1`, `timeoutMs`, `elapsedAtKill` (≥ 0 number), `pid`, and `occurredAt` (ISO string)
  - [x] Add a second test case that stubs the retry attempt and asserts `attemptNumber: 2` with the retry `timeoutMs`
  - [x] Confirm pre-existing tests for `dispatcher-impl.ts` continue to pass unmodified (backward compat)

## Dev Notes

### Architecture Constraints
- The new event interface MUST be declared in `packages/sdlc/src/run-model/event-types.ts` — do NOT define it inline in `dispatcher-impl.ts`
- Event emission MUST occur inside the existing ETIMEDOUT detection branch — do NOT restructure the retry/escalation control flow
- `elapsedAtKill` MUST be computed from `Date.now()` deltas bracketing the actual `spawnSync` call, not derived from `timeoutMs`
- `pid` is optional (`pid?: number`) — only include it when `spawnSync` returns a truthy `pid` value
- `occurredAt` MUST be `new Date().toISOString()` at the moment the timeout is detected

### Testing Requirements
- Use vitest (consistent with existing substrate test suite)
- Stub `spawnSync` in tests rather than running a real slow subprocess — use `vi.spyOn` or module mock to return the ETIMEDOUT error shape
- Both `attemptNumber: 1` (initial, 300_000 ms default) and `attemptNumber: 2` (retry, 450_000 ms default) paths must be covered
- `elapsedAtKill` assertions should check `typeof elapsedAtKill === 'number' && elapsedAtKill >= 0`, not an exact value
- `occurredAt` assertion should confirm it is a valid ISO 8601 date string

### Key File Patterns
- **`packages/sdlc/src/run-model/event-types.ts`**: Follow the existing event interface naming convention (e.g., `DispatchSpawnSyncTimeoutEvent`) and check for a top-level union type (e.g., `SubstrateEvent` or `PipelineEvent`) that should include the new type
- **`packages/core/src/dispatch/dispatcher-impl.ts`**: The ETIMEDOUT detection likely checks `result.error?.code === 'ETIMEDOUT'` on the object returned by `spawnSync`. Both initial and retry attempts flow through this path with different timeout values — track which attempt is in progress to populate `attemptNumber` correctly
- Use the same event emitter pattern already established in `dispatcher-impl.ts` (e.g., `this.emit(...)` or `emitter.emit(...)`) — do NOT introduce a new emitter mechanism

### Commit Message
The commit message MUST reference `obs_2026-05-04_023 fix #3` per AC6.

## Interface Contracts

- **Export**: `DispatchSpawnSyncTimeoutEvent` @ `packages/sdlc/src/run-model/event-types.ts` — consumed by OTEL persistence layer, supervisor, and status CLI event consumers

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- `packages/sdlc/src/run-model/event-types.ts` was created as a new file (it did not exist before)
- The dispatcher uses async `spawn` (not `spawnSync`) — the timeout path is a `setTimeout` handler that kills the process, not a synchronous ETIMEDOUT error. The `dispatch:spawnsync-timeout` event is emitted from this handler, which satisfies AC2 semantically (the "existing ETIMEDOUT catch path" is the timeout handler).
- `attemptNumber` is threaded via a new optional field on `DispatchRequest` (backward-compatible — defaults to `1` when absent). Callers (e.g., `probe-author-integration.ts`) pass `attemptNumber: 2` on retry dispatches.
- Tests use `vi.mock('node:child_process')` with a hanging mock process (never emits 'close') and a short timeout (20–30 ms) to trigger the timeout handler quickly without spawning a real subprocess.
- All 9433 tests pass; TypeScript builds cleanly for both packages.

### File List
- packages/sdlc/src/run-model/event-types.ts (NEW)
- packages/sdlc/src/run-model/index.ts (modified — added export)
- packages/core/src/dispatch/types.ts (modified — added `attemptNumber?: 1 | 2` to DispatchRequest)
- packages/core/src/dispatch/dispatcher-impl.ts (modified — emit dispatch:spawnsync-timeout in timeout handler)
- packages/core/src/__tests__/dispatcher-spawnsync-timeout.test.ts (NEW)

## Change Log
