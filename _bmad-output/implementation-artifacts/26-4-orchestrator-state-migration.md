# Story 26-4: Orchestrator State Migration

Status: complete

## Story

As a pipeline engineer,
I want the implementation orchestrator to persist all story state through the `StateStore` abstraction,
so that story lifecycle state survives process restarts, is queryable via SQL, and is ready for Dolt branch isolation in story 26-7.

## Acceptance Criteria

### AC1: StateStore Injected Into OrchestratorDeps
**Given** the `OrchestratorDeps` interface in `src/modules/implementation-orchestrator/orchestrator-impl.ts`
**When** a caller creates an orchestrator
**Then** `OrchestratorDeps` includes an optional `stateStore?: StateStore` field; when present, the orchestrator uses it for all story state I/O; when absent, behavior is identical to current (in-memory `_stories` Map only)

### AC2: Story State Transitions Write Through StateStore
**Given** an orchestrator constructed with a `stateStore`
**When** a story transitions between phases (PENDING → IN_STORY_CREATION → IN_DEV → IN_REVIEW → COMPLETE/ESCALATED/NEEDS_FIXES)
**Then** each transition calls `stateStore.setStoryState(storyKey, storyRecord)` with the full `StoryRecord` (phase, reviewCycles, lastVerdict, error, startedAt, completedAt), and the in-memory `_stories` Map is updated in parallel (so existing status reads are unaffected)

### AC3: Status Queries Prefer StateStore
**Given** an orchestrator constructed with a `stateStore`
**When** `getStatus()` is called (or the orchestrator builds `OrchestratorStatus`)
**Then** story state is read from `stateStore.queryStories({})` and merged with in-memory state; if a story exists in StateStore but not in the in-memory Map, it is included in the status response

### AC4: Review Verdicts and Outcomes Persisted in StoryRecord
**Given** an orchestrator using a `stateStore` and a story completes a code review cycle
**When** the review verdict (`LGTM`, `NEEDS_MINOR_FIXES`, `NEEDS_MAJOR_REWORK`, `LGTM_WITH_NOTES`) is received
**Then** `storyRecord.lastVerdict` is updated in StateStore via `setStoryState`, and on story completion or escalation the `completedAt` timestamp and `error` (if any) are written; these fields shadow the equivalent `createDecision` calls for story outcome (the SQLite decision writes are kept as-is for backward compatibility)

### AC5: File Backend: No Behavioral Change
**Given** an orchestrator constructed without a `stateStore` (the default)
**When** the full orchestrator test suite runs
**Then** all existing tests pass without modification — the `stateStore` field is purely additive and does not alter control flow when absent

### AC6: StateStore Backend: Tests Pass Against FileStateStore
**Given** a new test file `src/modules/implementation-orchestrator/__tests__/orchestrator-state-store.test.ts`
**When** the orchestrator is instantiated with a `FileStateStore` from story 26-1
**Then** the tests verify: (a) `setStoryState` is called on each phase transition, (b) `getStatus()` includes state from the store, (c) review verdict is reflected in the StoryRecord stored, (d) `close()` is called on the stateStore when the orchestrator completes

### AC7: StateStore Lifecycle Managed by Orchestrator
**Given** an orchestrator constructed with a `stateStore`
**When** `run()` begins
**Then** `stateStore.initialize()` is called before any story is dispatched; when `run()` resolves or rejects, `stateStore.close()` is called in a `finally` block to release resources

## Interface Contracts

- **Import**: `StateStore`, `StoryRecord`, `StoryFilter`, `StateStoreConfig`, `createStateStore` @ `src/modules/state/index.ts` (from story 26-1)

## Tasks / Subtasks

- [ ] Task 1: Add `stateStore` to `OrchestratorDeps` and import StateStore types (AC1)
  - [ ] Add `import type { StateStore, StoryRecord } from '../state/index.js'` to `orchestrator-impl.ts`
  - [ ] Add `stateStore?: StateStore` optional field to the `OrchestratorDeps` interface (after `tokenCeilings`)
  - [ ] Destructure `stateStore` in the factory function body alongside existing deps
  - [ ] Run `npm run build` to confirm no TypeScript errors

- [ ] Task 2: Implement StateStore lifecycle management (AC7)
  - [ ] At the top of `run()`, if `stateStore` is defined, call `await stateStore.initialize()` before the pre-flight check
  - [ ] Wrap the existing `run()` body in a `try/finally` block; in the `finally`, if `stateStore` is defined, call `await stateStore.close().catch(...)` (best-effort, log warning on error)
  - [ ] Unit test: stub stateStore with `vi.fn()` methods; assert `initialize()` called before first story dispatch, `close()` called on completion

- [ ] Task 3: Create `setStoryStateSync` helper and wire story state transitions (AC2)
  - [ ] Add a private async helper `persistStoryState(storyKey: string, state: StoryState): Promise<void>` that:
    - Reads the current in-memory state from `_stories.get(storyKey)`
    - Builds a `StoryRecord` from `{ storyKey, phase: state.phase, reviewCycles: state.reviewCycles, lastVerdict: state.lastVerdict, error: state.error, startedAt: state.startedAt, completedAt: state.completedAt }`
    - Calls `stateStore.setStoryState(storyKey, record)` if stateStore is defined
    - Logs warn on error (best-effort — never throws)
  - [ ] Call `persistStoryState()` (fire-and-forget with `.catch(logger.warn)`) immediately after every `_stories.set(storyKey, ...)` mutation in the orchestrator
  - [ ] Identify all `_stories.set` call sites (initial PENDING initialization, each phase transition) and add the `persistStoryState` call next to each

- [ ] Task 4: Initialize PENDING state for all stories in StateStore (AC2)
  - [ ] In the story initialization loop (where `_stories.set(key, { phase: 'PENDING', reviewCycles: 0 })` is called), also call `persistStoryState` for each story after the loop
  - [ ] Ensure the sprint field is populated in the `StoryRecord` if available from `OrchestratorConfig`

- [ ] Task 5: Populate review verdict and outcome fields in StoryRecord (AC4)
  - [ ] After a code-review verdict is received and stored in `_stories` (via `lastVerdict` update), call `persistStoryState` so StateStore reflects the latest verdict
  - [ ] On COMPLETE/ESCALATED transitions, ensure `completedAt` and `error` (if any) are included in the `StoryRecord` before calling `persistStoryState`
  - [ ] Confirm SQLite `createDecision` calls for `STORY_OUTCOME` and `STORY_METRICS` remain unchanged (backward compat)

- [ ] Task 6: Update `getStatus()` to merge StateStore data (AC3)
  - [ ] In the `getStatus()` method (or wherever `OrchestratorStatus.stories` is assembled), if `stateStore` is defined, call `await stateStore.queryStories({})` and merge results into the returned stories map
  - [ ] In-memory `_stories` Map takes precedence for any key present in both sources (in-memory is authoritative for the running process)
  - [ ] If stateStore query fails, log warn and fall back to in-memory only (never let a StateStore failure break status reporting)

- [ ] Task 7: Write StateStore integration tests for the orchestrator (AC6, AC5)
  - [ ] Create `src/modules/implementation-orchestrator/__tests__/orchestrator-state-store.test.ts`
  - [ ] Use `FileStateStore` (from `src/modules/state/file-store.ts`) as the injected stateStore — no mocking of StateStore itself
  - [ ] Test: orchestrator with `stateStore` → after a story is marked COMPLETE, `stateStore.getStoryState(storyKey)` returns record with `phase: 'COMPLETE'`
  - [ ] Test: orchestrator with `stateStore` → after a code-review verdict, `stateStore.getStoryState(storyKey)` reflects `lastVerdict`
  - [ ] Test: `stateStore.initialize()` called before dispatch; `stateStore.close()` called in finally (use `vi.spyOn`)
  - [ ] Test: existing orchestrator tests (without stateStore) are unaffected — import and re-run a key scenario without the stateStore dep to prove AC5
  - [ ] Run `npm run test:fast` to confirm all tests pass including new file

- [ ] Task 8: Verify build and full test suite (AC1–AC7)
  - [ ] Run `npm run build` — confirm zero TypeScript errors
  - [ ] Run `npm run test:fast` — confirm all tests pass with no regressions
  - [ ] Run `npm run test:changed` to confirm new and modified files are covered

## Dev Notes

### Architecture Constraints
- **Import style**: use `.js` extension on all relative imports (ESM): `import type { StateStore } from '../state/index.js'`
- **Node builtins**: use `node:` prefix where applicable
- **Type imports**: use `import type { ... }` for type-only imports
- **No new npm dependencies**: this story uses `StateStore` from story 26-1; no new packages
- **Backward compatibility**: `stateStore` in `OrchestratorDeps` is optional (`?`); when absent, all existing behavior is preserved — do NOT gate any control-flow logic on the backend type; always check `if (stateStore)` only
- **Logger**: existing `createLogger('implementation-orchestrator')` — use the same logger instance
- **Best-effort pattern**: StateStore calls must never throw into the orchestrator's main execution path; wrap all `stateStore.*` calls with `.catch(err => logger.warn({ err }, 'StateStore write failed'))`
- **StoryRecord mapping**: map from the orchestrator's internal `StoryState` type (in `types.ts`) to `StoryRecord` (from `src/modules/state/types.ts`); the fields are very similar — `phase`, `reviewCycles`, `lastVerdict`, `error`, `startedAt`, `completedAt`; add `storyKey` (required by `StoryRecord`) and `sprint` (from config if available)
- **Do NOT remove the `_stories` Map**: it remains the in-process source of truth; StateStore is an additional persistence layer, not a replacement in this story (branch-per-story execution in 26-7 will complete the transition)
- **`createStateStore` factory**: the dev agent does not need to call `createStateStore` — callers (CLI commands, tests) pass the stateStore instance in; the orchestrator only consumes it

### Story 26-1 Dependency
The `StateStore` interface, `StoryRecord`, and `StoryFilter` types must be imported from `src/modules/state/types.ts` (via `src/modules/state/index.ts`). If story 26-1 is not yet merged to main, create stub interfaces locally in `orchestrator-impl.ts` to unblock development:
```typescript
// TODO: remove when story 26-1 is merged
interface StoryRecord {
  storyKey: string
  phase: StoryPhase
  reviewCycles: number
  lastVerdict?: string
  error?: string
  startedAt?: string
  completedAt?: string
  sprint?: string
}
interface StateStore {
  initialize(): Promise<void>
  close(): Promise<void>
  setStoryState(key: string, record: StoryRecord): Promise<void>
  getStoryState(key: string): Promise<StoryRecord | undefined>
  queryStories(filter: Record<string, unknown>): Promise<StoryRecord[]>
  // ... other methods are no-ops for this story
}
```

### Key Mutation Sites in orchestrator-impl.ts
Search for all `_stories.set(` occurrences — these are the state transition points to wire up:
1. Initial PENDING initialization (before `run()` dispatches)
2. Phase transitions to `IN_STORY_CREATION`, `IN_DEV`, `IN_REVIEW`, `NEEDS_FIXES`
3. Terminal transitions to `COMPLETE`, `ESCALATED`
Each `_stories.set(key, ...)` must be immediately followed by `persistStoryState(key, newState).catch(...)`.

### Testing Requirements
- **Framework**: vitest (NOT jest). Run tests with `npm run test:fast`
- **Coverage threshold**: 80% — must not drop below this
- **FileStateStore**: import `FileStateStore` from `../../modules/state/file-store.js` (story 26-1); construct with no args for in-memory operation (no DB required)
- **Spy pattern**: use `vi.spyOn(stateStore, 'initialize')` and `vi.spyOn(stateStore, 'close')` to assert lifecycle calls without mocking the entire object
- **Isolation**: each test should use a fresh `FileStateStore` instance to avoid state bleed
- **Test file location**: `src/modules/implementation-orchestrator/__tests__/orchestrator-state-store.test.ts`

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
