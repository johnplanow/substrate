# Story 57.2: Await Verification-Result Persist Before COMPLETE Transition

## Story

As an operator running the substrate pipeline,
I want the orchestrator to await the verification-result manifest write before marking a story COMPLETE,
so that `per_story_state[storyKey].verification_result` is always populated when a story finishes successfully and is never silently dropped by a concurrent write race.

## Acceptance Criteria

### AC1: `persistVerificationResult` Returns the Underlying Promise
**Given** the `persistVerificationResult` helper in `verification-integration.ts` currently returns `void` (fire-and-forget)
**When** the function is called with a valid `RunManifest`
**Then** it returns the `Promise<void>` produced by `runManifest.patchStoryState(...)` (still with `.catch()` attached for non-fatal error logging), so callers can optionally `await` it

### AC2: Orchestrator Awaits Verification Persist on LGTM_WITH_NOTES Path
**Given** the orchestrator reaches the LGTM_WITH_NOTES → COMPLETE transition (around line 3018 in `orchestrator-impl.ts`)
**When** `verifSummary.status` is `'pass'` or `'warn'` (fall-through to COMPLETE)
**Then** the `persistVerificationResult(storyKey, verifSummary, runManifest)` call is awaited before the `updateStory({ phase: 'COMPLETE', ... })` call fires

### AC3: Orchestrator Awaits Verification Persist on Auto-Approve Path
**Given** the orchestrator reaches the auto-approve → COMPLETE transition (around line 3296 in `orchestrator-impl.ts`)
**When** `verifSummary.status` is `'pass'` or `'warn'` (fall-through to COMPLETE)
**Then** the `persistVerificationResult(storyKey, verifSummary, runManifest)` call is awaited before the auto-approve event and subsequent COMPLETE transition

### AC4: Post-COMPLETE Invariant Warning When `verification_result` Is Absent
**Given** `config.skipVerification` is not `true` and a story has just transitioned to COMPLETE
**When** `runManifest` is non-null and `per_story_state[storyKey].verification_result` is `undefined` after the final patch
**Then** a `warn`-level log is emitted with `{ storyKey, category: 'verification-result-missing' }` — advisory only, pipeline continues normally

### AC5: Non-Fatal Posture Preserved
**Given** `patchStoryState` throws or rejects during the awaited verification persist
**When** the rejection propagates through the `.catch()` handler
**Then** the error is logged as `warn` (not `error`) and the function resolves without rethrowing — the orchestrator `await` receives `undefined`, not a rejection, and the story continues to COMPLETE normally

### AC6: Unit Test — Verification Persist Awaited Before COMPLETE on LGTM_WITH_NOTES Path
**Given** a mocked orchestrator flow for the LGTM_WITH_NOTES path
**When** `persistVerificationResult` resolves asynchronously
**Then** the test asserts that the phase-COMPLETE `updateStory` call happens strictly after the persist resolves (ordering enforced)

### AC7: Unit Test — Invariant Warning Fires When `verification_result` Absent Post-COMPLETE
**Given** a scenario where `runManifest.patchStoryState` is called but the resulting manifest read-back shows `verification_result` as `undefined` (simulated write failure)
**When** the post-COMPLETE invariant check runs
**Then** `logger.warn` is called with `category: 'verification-result-missing'` and the correct `storyKey`

## Tasks / Subtasks

- [ ] Task 1: Modify `persistVerificationResult` to return `Promise<void>` (AC: #1, #5)
  - [ ] Change function return type from `void` to `Promise<void>`
  - [ ] Return the promise chain produced by `runManifest.patchStoryState(...).catch(...)` instead of discarding it
  - [ ] When `runManifest` is `null`/`undefined`, return `Promise.resolve()` so callers can always safely `await`
  - [ ] Verify all existing fire-and-forget call sites still compile without changes (they discard the returned promise, which is valid)

- [ ] Task 2: Await verification persist on LGTM_WITH_NOTES path in `orchestrator-impl.ts` (AC: #2)
  - [ ] Locate the `persistVerificationResult` call near line 3018 (LGTM_WITH_NOTES → COMPLETE flow)
  - [ ] Add `await` before the call
  - [ ] Confirm the `await` sits between the `verifSummary.status === 'fail'` early-return guard and the `updateStory({ phase: 'COMPLETE' })` call
  - [ ] Do NOT await when `verifSummary.status === 'fail'` (early return path — no COMPLETE transition occurs)

- [ ] Task 3: Await verification persist on auto-approve path in `orchestrator-impl.ts` (AC: #3)
  - [ ] Locate the `persistVerificationResult` call near line 3296 (auto-approve → COMPLETE flow)
  - [ ] Add `await` before the call
  - [ ] Confirm the `await` sits before the `story:auto-approved` event emission and COMPLETE transition

- [ ] Task 4: Implement post-COMPLETE invariant check (AC: #4, #5)
  - [ ] After the COMPLETE `updateStory` call on both paths, add a guard block:
    - Check `config.skipVerification !== true && runManifest != null`
    - Read back `runManifest.read()` (or use the in-memory state if available) to inspect `per_story_state[storyKey]?.verification_result`
    - If `undefined`, emit `logger.warn({ storyKey, category: 'verification-result-missing' }, ...)`
  - [ ] Wrap the read-back in `.catch()` so a manifest read error doesn't break the COMPLETE transition

- [ ] Task 5: Extend `verification-integration.test.ts` with ordering and invariant tests (AC: #6, #7)
  - [ ] Add test: `persistVerificationResult returns a promise that resolves after patchStoryState settles`
  - [ ] Add test: `persistVerificationResult with null runManifest returns resolved promise`
  - [ ] Add test: `persistVerificationResult swallows patchStoryState rejection and resolves` (AC #5)
  - [ ] Add orchestrator-level test (in the existing or new test file) using vi.fn() mocks: assert `patchStoryState` resolves before `updateStory(phase:COMPLETE)` is called on LGTM_WITH_NOTES path
  - [ ] Add test: invariant warning fires when `verification_result` is absent post-COMPLETE

## Dev Notes

### Architecture Constraints
- **File paths are fixed** — modify exactly:
  - `src/modules/implementation-orchestrator/verification-integration.ts` (change return type + return value)
  - `src/modules/implementation-orchestrator/orchestrator-impl.ts` (two `await` additions + invariant check)
  - `src/modules/implementation-orchestrator/__tests__/verification-integration.test.ts` (extend with new tests)
- **Import style**: ESM with `.js` extension suffixes on all relative imports
- **Test framework**: Vitest (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`) — do not use Jest
- **Logger**: the local `_logger` (in `verification-integration.ts`) and `logger` (in `orchestrator-impl.ts`) — do not introduce new loggers

### Key Implementation Notes

#### `persistVerificationResult` return-type change
The function currently returns `void`:
```ts
export function persistVerificationResult(
  storyKey: string,
  summary: VerificationSummary,
  runManifest: RunManifest | null | undefined,
): void {
  if (runManifest == null) { return }
  runManifest.patchStoryState(...).catch(...)  // discarded
}
```

After this story it must return `Promise<void>`:
```ts
export function persistVerificationResult(
  storyKey: string,
  summary: VerificationSummary,
  runManifest: RunManifest | null | undefined,
): Promise<void> {
  if (runManifest == null) { return Promise.resolve() }
  return runManifest
    .patchStoryState(storyKey, { verification_result: summary })
    .catch((err: unknown) =>
      _logger.warn({ err, storyKey }, 'manifest verification_result write failed — pipeline continues'),
    )
}
```

Fire-and-forget callers that do not use the return value will continue to compile and work correctly — a discarded `Promise<void>` is valid TypeScript (no `no-floating-promises` rule enforced here).

#### Orchestrator await sites
Both await sites follow the same guard structure (fail path exits early, pass/warn falls through):

```ts
const verifSummary = await verificationPipeline.run(verifContext, 'A')
verificationStore.set(storyKey, verifSummary)
// BEFORE (57-1 chain handles concurrent safety, 57-2 adds explicit ordering guarantee):
await persistVerificationResult(storyKey, verifSummary, runManifest)
if (verifSummary.status === 'fail') {
  // early return — no COMPLETE
  return
}
// COMPLETE path proceeds here — verification_result is now guaranteed flushed
updateStory(storyKey, { phase: 'COMPLETE', ... })
```

The `await` must be placed **before** the `if (verifSummary.status === 'fail')` guard (not inside the pass/warn branch) so a single await covers all non-fail paths.

#### Post-COMPLETE invariant check
The invariant check is lightweight and non-blocking. Because `RunManifest.read()` is async, use a fire-and-forget pattern with explicit `.catch()` to avoid blocking the COMPLETE transition:

```ts
// Post-COMPLETE invariant: verification_result should be present unless skipVerification
if (config.skipVerification !== true && runManifest != null) {
  runManifest.read().then((manifest) => {
    if (manifest?.per_story_state?.[storyKey]?.verification_result == null) {
      logger.warn({ storyKey, category: 'verification-result-missing' },
        'post-COMPLETE invariant: verification_result absent in manifest')
    }
  }).catch(() => { /* read failure — invariant check best-effort only */ })
}
```

### Testing Requirements
- Extend existing `verification-integration.test.ts` — do NOT create a separate file for these tests
- Use real `RunManifest` instances backed by a temp directory (same pattern as existing tests in that file)
- For the orchestrator ordering test: mock `RunManifest.patchStoryState` with a delayed promise (e.g., `new Promise(resolve => setTimeout(resolve, 10))`) and mock `updateStory` as a `vi.fn()`, then assert call order
- For the invariant test: mock `runManifest.read()` to return a manifest without `verification_result` and assert `logger.warn` was called with the correct category

## Interface Contracts

- **Import**: `persistVerificationResult` @ `src/modules/implementation-orchestrator/verification-integration.ts` — return type changes from `void` to `Promise<void>`; consumed by `orchestrator-impl.ts` at two `await` sites

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
