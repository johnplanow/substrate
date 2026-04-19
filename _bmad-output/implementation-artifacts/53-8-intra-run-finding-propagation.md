# Story 53-8: Intra-Run Finding Propagation

## Story

As a substrate developer,
I want findings from a failing story to be persisted immediately and injected into subsequent stories within the same run,
so that the pipeline avoids repeating the same mistake within a single pipeline execution.

## Acceptance Criteria

### AC1: Failure Handler Calls classifyAndPersist Immediately
**Given** a story's dev-story workflow completes with a failure result
**When** `sdlc-dev-story-handler.ts` processes the outcome
**Then** `classifyAndPersist()` is called with a `StoryFailureContext` (storyKey, runId, error, affectedFiles, buildFailed, testsFailed) before the handler returns, and any errors are caught and logged without breaking the handler flow

### AC2: FindingsInjector Called Before Each Story Dispatch
**Given** a story is about to be dispatched
**When** the dev-story handler (or dispatch preparation step) assembles the prompt
**Then** `FindingsInjector.inject(db, injectionContext)` is called with an `InjectionContext` that includes the current `runId`, and any non-empty result is prepended to the story content passed to the agent

### AC3: Intra-Run Finding Available to Subsequent Stories
**Given** story N fails and `classifyAndPersist()` persists a finding with the current `run_id`
**When** story N+K is dispatched in the same pipeline run (with overlapping target files)
**Then** the finding from story N appears in `FindingsInjector.inject()` scored candidates for story N+K (subject to relevance threshold ≥ 0.3), confirming intra-run propagation works end-to-end

### AC4: Success Handler Retires Contradicted Findings
**Given** a story completes successfully and modifies files that appear in one or more active findings
**When** `sdlc-dev-story-handler.ts` processes the success outcome
**Then** `FindingLifecycleManager.retireContradictedFindings()` is called with the modified files and current `run_id`, and errors are caught and logged without breaking the handler flow

### AC5: Graceful Degradation When Database Is Unavailable
**Given** the Dolt database throws an error during any learning call
**When** `classifyAndPersist()`, `FindingsInjector.inject()`, or `retireContradictedFindings()` is called
**Then** the error is caught, a warning is logged, and story dispatch or outcome processing continues normally with no change in behavior

### AC6: pipeline:finding-captured Event Emitted on Persistence
**Given** `classifyAndPersist()` successfully persists a finding
**When** control returns to the handler after the persist call
**Then** a `pipeline:finding-captured` event is emitted containing `storyKey`, `runId`, and `rootCause` fields

### AC7: Integration Test Validates Full Intra-Run Propagation Flow
**Given** a simulated pipeline run where story 1 fails with a namespace-collision touching `src/foo.ts`
**When** story 2 (with `src/foo.ts` among its target files) is prepared for dispatch
**Then** `FindingsInjector.inject()` returns a non-empty prompt string that includes the finding from story 1, proving intra-run propagation is functional

## Tasks / Subtasks

- [ ] Task 1: Wire classifyAndPersist to failure path in sdlc-dev-story-handler.ts (AC: #1, #5, #6)
  - [ ] Add imports: `classifyAndPersist`, `StoryFailureContext` from `../learning/failure-classifier` (or `../learning/types`)
  - [ ] In the failure branch (result !== 'success'), build a `StoryFailureContext` from handler-available data: `storyKey`, `runId` (from pipeline context), `error` (from workflowResult), `affectedFiles` (from workflowResult.files_modified), `buildFailed`, `testsFailed`
  - [ ] Call `await classifyAndPersist(failureCtx, db)` inside a `try-catch`; on catch, log warning and continue
  - [ ] After successful persist, emit `pipeline:finding-captured` event with `{ storyKey, runId, rootCause }` following the existing event-bridge / event-emitter pattern in this handler

- [ ] Task 2: Wire FindingsInjector.inject() into dispatch preparation (AC: #2, #3, #5)
  - [ ] Add imports: `FindingsInjector`, `extractTargetFilesFromStoryContent` from `../learning/findings-injector`
  - [ ] Before story content is passed to the agent dispatch call, build `InjectionContext`: `{ storyKey, runId, targetFiles: extractTargetFilesFromStoryContent(storyContent), packageName }` (infer packageName from storyKey prefix if available)
  - [ ] Call `const findingsPrompt = await FindingsInjector.inject(db, injectionCtx)` inside a `try-catch`; on catch, log warning and use empty string
  - [ ] If `findingsPrompt` is non-empty, prepend it (with a separator line) to the story content sent to the agent

- [ ] Task 3: Wire retireContradictedFindings to success path (AC: #4, #5)
  - [ ] Add import: `FindingLifecycleManager` from `../learning/finding-lifecycle`
  - [ ] In the success branch (result === 'success'), call `await FindingLifecycleManager.retireContradictedFindings(successCtx, db)` where `successCtx` contains `modifiedFiles` from workflowResult and `runId`; wrap in `try-catch` and log warning on error
  - [ ] Confirm `retireContradictedFindings` signature in `finding-lifecycle.ts` and align the success context shape accordingly

- [ ] Task 4: Define pipeline:finding-captured event type (AC: #6)
  - [ ] Locate the event type definitions file (search for where other `pipeline:*` event types like `pipeline:start` or `pipeline:story-complete` are declared — likely in `packages/core/src/events/` or `packages/sdlc/src/events/`)
  - [ ] Add `pipeline:finding-captured` with payload type `{ storyKey: string; runId: string; rootCause: string }`
  - [ ] Export from the appropriate barrel file

- [ ] Task 5: Unit tests for handler learning integration (AC: #1, #4, #5)
  - [ ] Create `packages/sdlc/src/handlers/__tests__/sdlc-dev-story-handler-learning.test.ts`
  - [ ] Mock `../learning/failure-classifier` module with `vi.mock()`; assert `classifyAndPersist` is called on failure with correct storyKey/runId
  - [ ] Assert `pipeline:finding-captured` event is emitted after successful classifyAndPersist
  - [ ] Mock `../learning/finding-lifecycle` module; assert `retireContradictedFindings` is called on success with modified files
  - [ ] Test DB error path: when `classifyAndPersist` throws, handler still returns a valid failure outcome

- [ ] Task 6: Integration test for intra-run propagation flow (AC: #3, #7)
  - [ ] Create `packages/sdlc/src/learning/__tests__/intra-run-propagation.test.ts`
  - [ ] Seed an in-memory mock DB (matching existing test patterns in `__tests__/`) with a finding: `{ run_id: 'run-123', story_key: '53-1', root_cause: 'namespace-collision', affected_files: ['src/foo.ts'], confidence: 'high', expires_after_runs: 5 }`
  - [ ] Build an `InjectionContext` for story `53-2` with `runId: 'run-123'` and `targetFiles: ['src/foo.ts']`
  - [ ] Call `FindingsInjector.inject(db, context)` and assert the returned string is non-empty and references the finding
  - [ ] Assert the finding passes the default relevance threshold (0.3) due to file overlap

## Dev Notes

### Architecture Constraints
- All three learning calls (`classifyAndPersist`, `FindingsInjector.inject`, `retireContradictedFindings`) MUST be wrapped in individual try-catch blocks — they are advisory and must never block pipeline execution
- Use the existing `db` reference already available in `sdlc-dev-story-handler.ts`; do NOT instantiate a new DB connection
- The `pipeline:finding-captured` event must follow the same emission pattern as existing events in the handler (look for how `pipeline:story-complete` or similar events are emitted)
- The `FindingsInjector.inject()` query returns findings from ALL runs (no run_id filter at query level); intra-run findings are naturally included because `persistFinding()` writes immediately to Dolt on the same connection
- Import paths must use relative paths within the sdlc package, not cross-package paths

### Key File Paths to Modify or Create
- **Modify**: `packages/sdlc/src/handlers/sdlc-dev-story-handler.ts` — add failure hook (classifyAndPersist + event), success hook (retireContradicted), and pre-dispatch injection call
- **Possibly Modify**: `packages/sdlc/src/dev-story.ts` — if injection needs to happen at the prompt assembly layer rather than the handler layer; check where story content is finalized before agent dispatch
- **Modify**: Event type definitions file (search for `pipeline:story-complete` to locate it) — add `pipeline:finding-captured`
- **New**: `packages/sdlc/src/handlers/__tests__/sdlc-dev-story-handler-learning.test.ts`
- **New**: `packages/sdlc/src/learning/__tests__/intra-run-propagation.test.ts`

### Testing Requirements
- Test framework: Vitest with `vi.mock()` for module mocking
- Use `vi.fn()` for all learning module functions — never call the real DB in unit tests
- For the integration test, use an in-memory mock matching the pattern in existing `__tests__/` files in the learning directory
- Run `npm run test:fast` during iteration; `npm test` before finalizing

### Related Story Context
- **53-5** (complete): Defines `StoryFailureContext`, `Finding`, `RootCauseCategory`, `classifyAndPersist()` at `packages/sdlc/src/learning/failure-classifier.ts` and `types.ts`
- **53-6** (complete): Defines `FindingsInjector`, `InjectionContext`, `extractTargetFilesFromStoryContent()` at `packages/sdlc/src/learning/findings-injector.ts`
- **53-7** (complete): Defines `FindingLifecycleManager.retireContradictedFindings()` at `packages/sdlc/src/learning/finding-lifecycle.ts`; also note that lifecycle processing (dedup, expiry, file validation) already runs inside `FindingsInjector.inject()` — no double-calling needed

## Interface Contracts

- **Import**: `classifyAndPersist`, `StoryFailureContext` @ `packages/sdlc/src/learning/failure-classifier.ts` (from story 53-5)
- **Import**: `FindingsInjector`, `extractTargetFilesFromStoryContent` @ `packages/sdlc/src/learning/findings-injector.ts` (from story 53-6)
- **Import**: `FindingLifecycleManager` @ `packages/sdlc/src/learning/finding-lifecycle.ts` (from story 53-7)
- **Export**: `pipeline:finding-captured` event type @ event types definition file (consumed by observability and monitoring stories)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
