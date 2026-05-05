# Story 66-1: orchestrator phase-advancement persistence audit + invariant test

## Story

As a substrate pipeline operator,
I want every orchestrator phase transition to persistently write the new phase to the manifest via `_writeChain.patchStoryState`,
so that `substrate resume` after a crash or restart can correctly reconstruct pipeline state without re-dispatching already-completed phases.

## Acceptance Criteria

<!-- source-ac-hash: 0c73510d512f46d43aa69022b0f42aebda5e9307d944a500ca304f7b54abd78e -->

### AC1: All phase transitions emit patchStoryState({phase})
Every phase transition (IN_STORY_CREATION → IN_TEST_PLANNING → IN_DEV → IN_REVIEW → IN_VERIFICATION → COMPLETE; plus ESCALATED side-states) in orchestrator-impl.ts emits a `_writeChain.patchStoryState({phase: <next>})` call within 1 statement of the in-memory `state.phase` update.

### AC2: Phase write failures are non-fatal
Phase write failures log a warning (`logger.warn`) but do not throw or fail the dispatch — preserves the best-effort contract of `_writeChain.patchStoryState`.

### AC3: Invariant test asserts all phase transitions
New invariant test in `src/modules/implementation-orchestrator/__tests__/phase-advancement-persistence.test.ts` asserts each transition emits a `patchStoryState({phase})` call. Test FAILS if a future code change adds a phase transition without a corresponding write.

### AC4: Mock _writeChain records calls
Test uses a mock `_writeChain` that records all `patchStoryState` calls; assertions check call count + ordering of phase values.

### AC5: Existing patchStoryState calls unchanged
Existing `patchStoryState(retry_count)`, `patchStoryState(cost_usd)`, `patchStoryState(dispatched)`, `patchStoryState(<status>)` calls remain unchanged (this story adds; does not remove).

### AC6: Commit references obs_022
Commit message references obs_2026-05-03_022 fix #1.

## Tasks / Subtasks

- [ ] Task 1: Audit orchestrator-impl.ts for all phase-transition sites (AC: #1, #5)
  - [ ] Search for all assignments to `state.phase` (and related in-memory phase mutations) in orchestrator-impl.ts
  - [ ] Map each assignment to its surrounding control-flow context (transition name, storyKey, guard conditions)
  - [ ] Identify which transitions already emit `_writeChain.patchStoryState({phase})` and which are missing
  - [ ] Confirm existing non-phase `patchStoryState` calls (retry_count, cost_usd, dispatched, status) are catalogued and left untouched

- [ ] Task 2: Wire missing patchStoryState({phase}) calls for all transitions (AC: #1, #2)
  - [ ] Add `_writeChain.patchStoryState(storyKey, { phase: <next> })` within 1 statement after each in-memory `state.phase` update for: IN_STORY_CREATION, IN_TEST_PLANNING, IN_DEV, IN_REVIEW, IN_VERIFICATION, COMPLETE
  - [ ] Wire for ESCALATED side-state transitions
  - [ ] Wrap each new write in try/catch that calls `logger.warn` on failure without re-throwing (mirrors existing cost_usd pattern at line ~842)
  - [ ] Verify all pre-existing patchStoryState calls (retry_count, cost_usd, dispatched, status) remain unchanged

- [ ] Task 3: Implement phase-advancement-persistence.test.ts invariant test (AC: #3, #4)
  - [ ] Create `src/modules/implementation-orchestrator/__tests__/phase-advancement-persistence.test.ts`
  - [ ] Build a stub orchestrator wired with a recording mock `_writeChain` (vitest spy that captures all patchStoryState calls)
  - [ ] Drive the orchestrator (or the phase-transition helpers directly) through each known phase transition path
  - [ ] Assert each transition emitted a `patchStoryState` call containing `{ phase: <expected-value> }`
  - [ ] Assert call ordering matches the expected phase progression (IN_STORY_CREATION → IN_TEST_PLANNING → IN_DEV → IN_REVIEW → IN_VERIFICATION → COMPLETE)
  - [ ] Assert ESCALATED side-state transitions also emit corresponding phase writes
  - [ ] Verify test design is structured so that a future phase transition added without a patchStoryState write will fail the assertion (document this invariant contract in a comment)

- [ ] Task 4: Run test suite and validate (AC: #3, #5)
  - [ ] Run `npm run test:fast` to confirm new test passes and no existing tests regress
  - [ ] Confirm existing patchStoryState-related tests (retry_count, cost_usd, dispatched, status) still pass

## Dev Notes

### Architecture Constraints

- Primary file: `src/modules/implementation-orchestrator/orchestrator-impl.ts`
- New test file: `src/modules/implementation-orchestrator/__tests__/phase-advancement-persistence.test.ts`
- `_writeChain` is the existing manifest-write abstraction. Phase writes MUST follow the same best-effort pattern as `patchStoryState(cost_usd)` at line ~842: wrapped in try/catch, `logger.warn` on failure, never re-throw.
- The new writes must be placed within 1 statement of the corresponding in-memory `state.phase =` assignment — not deferred, not batched with other writes.
- Phase string values to cover: `IN_STORY_CREATION`, `IN_TEST_PLANNING`, `IN_DEV`, `IN_REVIEW`, `IN_VERIFICATION`, `COMPLETE`, `ESCALATED` (and any sub-states like `ESCALATED_*` if they exist).

### Testing Requirements

- Framework: vitest (existing project standard; do NOT use jest directly)
- The mock `_writeChain` should be a plain object whose `patchStoryState` method is a `vi.fn()` spy. Record all calls in an array for ordered assertion.
- The test is an **invariant test**: its value comes from failing fast when a future engineer adds a phase transition without a write. Add a clear comment stating this contract at the top of the test file.
- Strategy options for driving transitions:
  - **Preferred**: if orchestrator phase-transition logic is extractable or delegates to small helpers, test those helpers directly with the mock chain injected.
  - **Alternative**: construct a minimal orchestrator stub (mock all external collaborators) and drive it through a full story lifecycle, then assert on recorded `patchStoryState` calls filtered to `{phase: ...}` entries.
- Assertions must check: (a) call count equals the number of expected phase transitions, (b) `phase` values in calls match the expected sequence in order, (c) no phase transition is skipped.

### Pattern Reference for New Phase Writes

Existing best-effort write pattern (mirrors cost_usd at line ~842):
```typescript
try {
  await this._writeChain.patchStoryState(storyKey, { phase: nextPhase });
} catch (err) {
  this._logger.warn('Failed to persist phase transition to manifest', {
    storyKey,
    phase: nextPhase,
    err,
  });
}
```

Place immediately after the corresponding `state.phase = nextPhase` (or equivalent) assignment.

### Obs-022 Context

obs_2026-05-03_022 observed that the orchestrator advances through phases (IN_STORY_CREATION → IN_TEST_PLANNING → IN_DEV, 9 files written) without persisting the manifest beyond the initial `IN_STORY_CREATION dispatched`. This story closes that gap by ensuring every phase transition leaves a durable manifest write so `substrate resume` can reconstruct state correctly.

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
