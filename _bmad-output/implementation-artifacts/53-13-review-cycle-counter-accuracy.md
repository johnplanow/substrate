# Story 53-13: Review Cycle Counter Accuracy

## Story

As a pipeline operator,
I want the review cycle counter to accurately reflect the number of code review dispatches that occurred,
so that `story:done` and `story:metrics` events report a consistent, correct count for telemetry and observability.

## Acceptance Criteria

### AC1: Single-Pass SHIP_IT Reports review_cycles: 1 in story:done
**Given** a story that receives a SHIP_IT (or LGTM_WITH_NOTES) verdict on its first code review dispatch
**When** the story completes and the `story:done` NDJSON event is emitted via the `orchestrator:story-complete` bridge
**Then** the `review_cycles` field equals `1` (not `0`)

### AC2: Two-Pass Story Reports review_cycles: 2 in story:done
**Given** a story that receives `NEEDS_MINOR_FIXES` on the first review and `SHIP_IT` on the second
**When** the story completes and the `story:done` NDJSON event is emitted
**Then** the `review_cycles` field equals `2`

### AC3: story:done and story:metrics Report the Same review_cycles Value
**Given** a story that completes via any code review path (SHIP_IT, NEEDS_MINOR_FIXES → SHIP_IT, or auto-approved)
**When** both `story:done` and `story:metrics` events are emitted for that story
**Then** the `review_cycles` value in `story:done` equals the `reviewCycles` value in `story:metrics`
**And** neither event ever reports `0` for a story that had at least one code review dispatch

### AC4: Auto-Approved Story Reports Actual Dispatch Count in story:done
**Given** a story where max review cycles is exhausted with only `NEEDS_MINOR_FIXES` verdicts
**When** the story is auto-approved and `story:done` is emitted
**Then** `review_cycles` equals the actual number of code review dispatches that occurred (equal to the `maxReviewCycles` config value)
**And** this matches the `reviewCycles` value already emitted in the `story:auto-approved` event

### AC5: Unit Tests Verify Counter Values for 1-Cycle and 2-Cycle Scenarios
**Given** the orchestrator unit test suite
**When** tests exercise the code review loop completion paths
**Then** a test verifies `reviewCycles: 1` in the `orchestrator:story-complete` payload for a single-pass SHIP_IT story
**And** a test verifies `reviewCycles: 2` in the `orchestrator:story-complete` payload for a two-pass NEEDS_MINOR_FIXES → SHIP_IT story

## Tasks / Subtasks

- [x] Task 1: Confirm root cause in orchestrator-impl.ts (AC: #1, #2, #3)
  - [x] Read `src/modules/implementation-orchestrator/orchestrator-impl.ts` around lines 2619–2960 to confirm the exact state of the SHIP_IT exit path
  - [x] Verify the known discrepancy: `writeStoryMetricsBestEffort` uses `reviewCycles + 1` (line 2957) while `eventBus.emit('orchestrator:story-complete', ...)` uses bare `reviewCycles` (line 2959)
  - [x] Confirm the auto-approve path (around line 3081–3212) uses `finalReviewCycles = reviewCycles + 1` consistently — this path is expected to be correct already

- [x] Task 2: Fix the SHIP_IT exit path counter (AC: #1, #2, #3)
  - [x] In `orchestrator-impl.ts`, in the SHIP_IT / LGTM_WITH_NOTES verdict branch (around line 2957–2959), introduce a local variable `const completedReviewCycles = reviewCycles + 1` before the emit
  - [x] Change the `eventBus.emit('orchestrator:story-complete', ...)` call to use `reviewCycles: completedReviewCycles`
  - [x] Verify `writeStoryMetricsBestEffort` and `writeStoryOutcomeBestEffort` also use `completedReviewCycles` (they likely already use `reviewCycles + 1` — align them to the named variable for clarity)

- [x] Task 3: Audit event-bridge.ts graph-engine path (AC: #3)
  - [x] Read `packages/sdlc/src/handlers/event-bridge.ts` and check the `onGraphCompleted` handler which emits `orchestrator:story-complete` with `reviewCycles: devStoryRetries`
  - [x] Determine whether `devStoryRetries` counts code-review node retries: it increments via `onNodeRetried` when `nodeId === 'dev_story'` — `devStoryRetries` is 0 on a first-pass SHIP_IT (same bug pattern confirmed)
  - [x] Fixed: `onGraphCompleted` now emits `reviewCycles: devStoryRetries + 1` — same +1 pattern as the linear fix. Each `dev_story` retry corresponds to one failed code review + 1 base dispatch = total dispatches.
  - [x] Updated parity-test.ts and event-bridge unit tests to reflect correct values

- [x] Task 4: Add unit tests for counter accuracy (AC: #5)
  - [x] Locate `src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts` and find the existing test "emits orchestrator:story-complete (not escalated) for minor fixes at limit"
  - [x] Add test: story with mock code-review returning SHIP_IT verdict on first dispatch → capture `orchestrator:story-complete` event → assert `payload.reviewCycles === 1`
  - [x] Add test: story with mock code-review returning NEEDS_MINOR_FIXES then SHIP_IT → capture event → assert `payload.reviewCycles === 2`
  - [x] Updated existing tests in event-bridge.test.ts and parity-test.ts that were asserting old buggy values

## Dev Notes

### Architecture Constraints
- The fix lives entirely in `orchestrator-impl.ts` (linear path) and optionally `event-bridge.ts` (graph path) — no new files required
- Import style: `.js` extension on all local ESM imports
- **Do NOT change `src/cli/commands/run.ts`** — it bridges `orchestrator:story-complete` payload `.reviewCycles` → `review_cycles` in `story:done` NDJSON transparently; fix the counter at its source
- The `story:metrics` and `story:done` consistency guarantee (AC3) is achieved by ensuring a single source of truth: the `completedReviewCycles` variable in the SHIP_IT path and `finalReviewCycles` in the auto-approve path

### Key File Paths
- **Modify**: `src/modules/implementation-orchestrator/orchestrator-impl.ts` — fix SHIP_IT path counter at ~line 2959
- **Modify**: `src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts` — add 1-cycle and 2-cycle regression tests
- **Inspect (may modify)**: `packages/sdlc/src/handlers/event-bridge.ts` — verify `devStoryRetries` tracks code-review dispatches correctly for the graph-engine path
- **Inspect (no change expected)**: `src/cli/commands/run.ts` — bridge from `orchestrator:story-complete` to `story:done` (fix at source, not here)
- **Inspect (no change expected)**: `src/core/event-bus.types.ts` — `StoryDoneEvent.review_cycles` field definition

### Counter Bug Root Cause (Canonical)

The bug is a one-liner off-by-one in the SHIP_IT exit path:

```typescript
// orchestrator-impl.ts — current (buggy):
let reviewCycles = 0    // initialized before the while (keepReviewing) loop
while (keepReviewing) {
  // ... dispatch code review ...
  if (verdict === 'SHIP_IT' || verdict === 'LGTM_WITH_NOTES') {
    await writeStoryMetricsBestEffort(storyKey, verdict, reviewCycles + 1)  // ✅ correct: 1
    await writeStoryOutcomeBestEffort(storyKey, 'complete', reviewCycles + 1)  // ✅ correct: 1
    eventBus.emit('orchestrator:story-complete', { storyKey, reviewCycles })  // ❌ bug: 0 on first pass
    // ...
  }
  reviewCycles++  // only increments when looping; never fires for SHIP_IT exit
}

// Fix:
if (verdict === 'SHIP_IT' || verdict === 'LGTM_WITH_NOTES') {
  const completedReviewCycles = reviewCycles + 1
  await writeStoryMetricsBestEffort(storyKey, verdict, completedReviewCycles)
  await writeStoryOutcomeBestEffort(storyKey, 'complete', completedReviewCycles)
  eventBus.emit('orchestrator:story-complete', { storyKey, reviewCycles: completedReviewCycles })  // ✅ 1
}
```

The auto-approve path already uses `const finalReviewCycles = reviewCycles + 1` correctly and does not need changes.

### event-bridge.ts Graph Engine Path

In `packages/sdlc/src/handlers/event-bridge.ts`, the `onGraphCompleted` handler emits `orchestrator:story-complete` with `reviewCycles: devStoryRetries`. The `devStoryRetries` variable increments when `nodeId === 'dev_story'` retries. If the graph pipeline models code review as a separate `code_review` node (distinct from `dev_story`), then a first-pass success of `code_review` produces `devStoryRetries = 0` — the same off-by-one pattern. Audit this handler and apply an equivalent fix if the graph path is actively used for code review.

### Testing Requirements
- Framework: Vitest — `import { describe, it, expect, vi } from 'vitest'`
- Tests are in `src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts`
- Mock the code-review agent dispatch (likely `config.agentRunner` or equivalent) to return SHIP_IT or NEEDS_MINOR_FIXES verdict objects
- Use an event listener on `eventBus` to capture the `orchestrator:story-complete` event payload
- The 1-cycle test is the primary regression test for the reported bug (was incorrectly `0`, should be `1`)
- No changes to `packages/sdlc/` test files unless the event-bridge.ts fix is applied

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Fixed off-by-one in orchestrator-impl.ts SHIP_IT path: introduced `completedReviewCycles = reviewCycles + 1` and used it consistently in metrics, outcome, and story-complete event
- Fixed same pattern in event-bridge.ts: `onGraphCompleted` now emits `reviewCycles: devStoryRetries + 1`
- Updated 3 existing event-bridge.test.ts assertions that were testing old buggy `reviewCycles: 0` behavior
- Updated parity-test.ts reference model and rework scenario assertion to use corrected values

### File List
- src/modules/implementation-orchestrator/orchestrator-impl.ts
- src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts
- packages/sdlc/src/handlers/event-bridge.ts
- packages/sdlc/src/handlers/__tests__/event-bridge.test.ts
- packages/sdlc/src/__tests__/parity-test.ts

## Change Log

- 2026-04-07: Story created (Epic 53, Phase D Autonomous Operations)
- 2026-04-07: Implemented — all 5 ACs met, 8680 tests passing
