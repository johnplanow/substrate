# Story 43.12: SDLC-as-Graph Cross-Project Validation

## Story

As a substrate pipeline maintainer,
I want the graph engine validated against a realistic reference-project profile (ynab) using fixture-based execution,
so that cross-project behavioral parity between `--engine=graph` and the linear engine is assured before production adoption.

## Acceptance Criteria

### AC1: Cross-Project Validation Test File
**Given** the test file at `packages/sdlc/src/__tests__/cross-project-validation.test.ts`
**When** `npm run test:fast` is executed
**Then** all cross-project validation tests complete without network calls, without real LLM dispatch, and without reading or writing actual ynab project files

### AC2: Ynab Project Fixture with Representative Scenarios
**Given** a fixture file at `packages/sdlc/src/__tests__/fixtures/ynab-cross-project-fixture.ts`
**When** imported by the validation test
**Then** it exports five story entries using realistic ynab story keys (`'1-1'` through `'1-5'`), each with a story content string, expected completion status (`complete` | `escalated`), and optional conflict-group tag — with entries `'1-4'` and `'1-5'` sharing `conflictGroup: 'contracts-g1'`

### AC3: Story Outcome Parity Across All Five Stories
**Given** both graph and linear engines run against the five ynab fixture stories with `maxConcurrency: 1`
**When** each engine completes
**Then** the per-story completion status (complete/escalated) matches between engines for all five stories, and the aggregate `{ successCount, failureCount, totalStories }` summary is identical

### AC4: NDJSON Event Type Sequence Parity
**Given** `orchestrator:*` events captured from both engines for the happy-path story (`'1-1'`) and the rework-cycle story (`'1-2'`)
**When** event-name sequences are compared using `assertEventSequenceParity` from the story 43-11 parity harness
**Then** the sequences are identical (same event names in same order) for both stories — reusing the parity harness's comparison logic rather than duplicating it

### AC5: Conflict-Group Serialization Parity
**Given** stories `'1-4'` and `'1-5'` share `conflictGroup: 'contracts-g1'` and `maxConcurrency: 2`
**When** both engines process the pair
**Then** for both engines: story `'1-5'`'s first `orchestrator:story-phase-start` event appears after story `'1-4'`'s `orchestrator:story-complete` event in the captured event stream, confirming conflict-group serialization is identical

### AC6: Performance Overhead Within Acceptable Bounds
**Given** wall-clock timing is recorded for both engines completing the five-story fixture with a uniform mock executor
**When** the ratio `(graphMs - linearMs) / linearMs` is computed
**Then** the test logs both durations and asserts the ratio is ≤ 0.20 (20%) — using a warn-only assertion that records the value without hard-failing on CI to avoid flakiness from process startup variance

### AC7: Divergence in Fixture Causes Structured Failure
**Given** an injected fixture override that forces the graph engine to emit an extra `orchestrator:story-phase-start` event for story `'1-1'`
**When** `assertEventSequenceParity` compares the injected stream against the linear reference
**Then** the comparison throws with an error message that includes the story key (`'1-1'`) and the index of first divergence — confirming the harness catches realistic cross-project regressions

## Tasks / Subtasks

- [x] Task 1: Create ynab cross-project fixture file (AC: #2)
  - [x] Create `packages/sdlc/src/__tests__/fixtures/ynab-cross-project-fixture.ts` exporting `YnabFixtureStory` interface: `{ storyKey: string; storyContent: string; expectedStatus: 'complete' | 'escalated'; conflictGroup?: string; phases: Array<{ nodeId: string; outcomeStatus: 'SUCCESS' | 'FAIL' }> }`
  - [x] Export `YNAB_FIXTURE_STORIES: YnabFixtureStory[]` with five entries: `'1-1'` happy-path (all SUCCESS), `'1-2'` rework-cycle (code_review FAIL then SUCCESS), `'1-3'` escalation (code_review always FAIL, maxReviewCycles=2), `'1-4'` and `'1-5'` conflict-group pair (both happy-path, `conflictGroup: 'contracts-g1'`)
  - [x] Export `YNAB_PROJECT_CONFIG` object: `{ projectRoot: '/fixtures/ynab', methodologyPack: 'default', maxConcurrency: 1, maxReviewCycles: 2 }`

- [x] Task 2: Create event capture helpers for cross-project test (AC: #3, #4, #7)
  - [x] If `packages/sdlc/src/__tests__/fixtures/event-captor.ts` does not exist from story 43-11, create it with: `CapturedEvent` type `{ eventName: string; storyKey: string; sequenceIdx: number }`, `buildEventCaptor(bus)` factory that intercepts `orchestrator:*` events and returns `{ events: CapturedEvent[]; reset(): void }`, and `assertEventSequenceParity(linearEvents, graphEvents, storyKey)` that compares `.eventName` arrays and throws with story key + divergence index on mismatch
  - [x] If `event-captor.ts` already exists (created by 43-11), read its exports and extend with `assertEventSequenceParity` if not already present — do not duplicate

- [x] Task 3: Implement `runFixtureScenario()` helper that drives both engines (AC: #1, #3, #4)
  - [x] In `cross-project-validation.test.ts`, implement `runFixtureScenario(story: YnabFixtureStory, config: typeof YNAB_PROJECT_CONFIG)` that: creates a per-story `EventEmitter` (Node.js built-in), instantiates `createSdlcEventBridge` with story key and a capture bus, emits `graph:node-started` / `graph:node-completed` / `graph:node-retried` / `graph:goal-gate-unsatisfied` / `graph:completed` events per story's `phases` array, tears down the bridge in `finally`, and returns `{ capturedEvents: CapturedEvent[]; status: 'complete' | 'escalated' }`
  - [x] Import `createSdlcEventBridge` from `../handlers/event-bridge.js` and `EventEmitter` from `node:events`
  - [x] Derive terminal event: if any phase has `nodeId === 'code_review'` with `outcomeStatus === 'FAIL'` and it is the last phase, emit `graph:goal-gate-unsatisfied`; otherwise emit `graph:completed`

- [x] Task 4: Write happy-path and rework-cycle cross-project parity tests (AC: #3, #4)
  - [x] Test `"ynab 1-1 happy-path: graph engine events match linear reference"` — call `runFixtureScenario` for story `'1-1'`, build reference events using `buildReferenceEvents` (from story 43-11 harness or reimplemented locally), call `assertEventSequenceParity`, assert `status === 'complete'`
  - [x] Test `"ynab 1-2 rework-cycle: graph engine emits rework events matching linear"` — call `runFixtureScenario` for story `'1-2'` (two dev+review cycles), assert parity including the repeated `orchestrator:story-phase-start { phase: 'dev' }` event; assert `status === 'complete'`

- [x] Task 5: Write escalation and outcome summary parity tests (AC: #3)
  - [x] Test `"ynab 1-3 escalation: graph engine escalates after maxReviewCycles"` — run story `'1-3'` (code_review always FAIL, 3 dev_story attempts), assert `status === 'escalated'`, assert terminal event is `orchestrator:story-escalated`
  - [x] Test `"ynab all-five: aggregate summary matches between engines"` — run all five fixture stories through `runFixtureScenario`, accumulate counts, assert `{ successCount: 4, failureCount: 1, totalStories: 5 }` (stories 1-1, 1-2, 1-4, 1-5 succeed; 1-3 escalates)

- [x] Task 6: Write conflict-group serialization parity test (AC: #5)
  - [x] Test `"ynab 1-4+1-5 conflict-group: graph engine serializes pair in same order as linear"` — run stories `'1-4'` and `'1-5'` sequentially through `runFixtureScenario` simulating a `maxConcurrency: 2` serialization constraint (run `'1-4'` to completion, then `'1-5'`), capture a merged event stream, assert that `'1-5'`'s `orchestrator:story-phase-start` event appears after `'1-4'`'s `orchestrator:story-complete` event — i.e., `merged.findIndex(e => e.storyKey === '1-5' && e.eventName === 'orchestrator:story-phase-start') > merged.findIndex(e => e.storyKey === '1-4' && e.eventName === 'orchestrator:story-complete')`

- [x] Task 7: Write performance overhead measurement test (AC: #6)
  - [x] Test `"ynab performance: graph engine overhead within acceptable bounds"` — implement `withTiming(label, fn)` helper returning `{ result, ms }`, run all five fixture stories twice (once with linear shim, once with graph scenario runner), compute overhead ratio, log both values via `console.log`, assert `overheadRatio <= 0.20` using `expect.soft()` (non-fatal assertion) so CI does not fail on timing variance
  - [x] For linear shim timing: use a no-op async function that resolves after `0ms` (the base reference), not an actual linear orchestrator instantiation — the point is measuring graph-path overhead relative to the fastest possible baseline

- [x] Task 8: Divergence detection test and build verification (AC: #7, all)
  - [x] Test `"divergence detection: assertEventSequenceParity catches cross-project regression"` — construct a `dirtyStream` by inserting an extra `{ eventName: 'orchestrator:story-phase-start', storyKey: '1-1', sequenceIdx: 99 }` before the terminal event; assert `assertEventSequenceParity` throws with message containing `'1-1'`
  - [x] Run `npm run build` — zero TypeScript errors
  - [x] Run `npm run test:fast` — all new cross-project tests pass; confirm "Test Files" summary line with zero failures; existing test count unchanged or increased

## Dev Notes

### Architecture Constraints
- **ADR-003**: `cross-project-validation.test.ts` is a test file in `packages/sdlc/src/__tests__/` — it may import from `packages/sdlc/src/` but must NOT import production values from the monolith `src/` (the root CLI layer). Factory types should be duck-typed rather than imported directly from `@substrate-ai/factory`.
- **No real project files**: The ynab fixture uses hardcoded story content strings — do not read from `/home/jplanow/code/jplanow/ynab` at test time. The fixture path `'/fixtures/ynab'` is a symbolic string, not an actual filesystem path.
- **Reuse 43-11 harness patterns**: If `parity-test.ts` (story 43-11) exports `buildReferenceEvents`, `ParityEvent`, or `assertParity`, import and reuse them from `./parity-test.js` rather than duplicating. If 43-11 does not export these (they are local helpers), re-implement the minimal subset needed in `fixtures/event-captor.ts`.
- **Import style**: Use `.js` extensions for all relative imports (ESM project convention), e.g. `import { createSdlcEventBridge } from '../handlers/event-bridge.js'`

### File Paths

- **New**: `packages/sdlc/src/__tests__/cross-project-validation.test.ts` — main validation test suite
- **New**: `packages/sdlc/src/__tests__/fixtures/ynab-cross-project-fixture.ts` — ynab project fixture with 5 representative stories
- **New or extend**: `packages/sdlc/src/__tests__/fixtures/event-captor.ts` — event capture and parity assertion helpers
- **Read (no modification)**: `packages/sdlc/src/handlers/event-bridge.ts` — `createSdlcEventBridge`, `SdlcEventBridgeOptions`
- **Read (no modification)**: `packages/sdlc/src/__tests__/parity-test.ts` — check for exported helpers to reuse (story 43-11)
- **Read (no modification)**: `packages/sdlc/src/orchestrator/__tests__/graph-orchestrator.test.ts` — reference for established test patterns

### Mock Executor Event Emission for Fixture Stories

Each `YnabFixtureStory.phases` array drives the per-story `EventEmitter`. The event sequence for a rework-cycle story (`'1-2'`) looks like:

```
graph:node-started      { nodeId: 'create_story' }
graph:node-completed    { nodeId: 'create_story', outcome: { status: 'SUCCESS' } }
graph:node-started      { nodeId: 'dev_story' }
graph:node-completed    { nodeId: 'dev_story', outcome: { status: 'SUCCESS' } }
graph:node-started      { nodeId: 'code_review' }
graph:node-completed    { nodeId: 'code_review', outcome: { status: 'FAIL' } }
graph:node-retried      { nodeId: 'dev_story' }
graph:node-started      { nodeId: 'dev_story' }
graph:node-completed    { nodeId: 'dev_story', outcome: { status: 'SUCCESS' } }
graph:node-started      { nodeId: 'code_review' }
graph:node-completed    { nodeId: 'code_review', outcome: { status: 'SUCCESS' } }
graph:completed         { finalOutcome: { status: 'SUCCESS' } }
```

The `SdlcEventBridge` (story 43-9) translates these to `orchestrator:story-phase-start/complete` events and the terminal `orchestrator:story-complete { reviewCycles: 1 }`. Study `packages/sdlc/src/handlers/__tests__/event-bridge.test.ts` for the exact translation contract before implementing `runFixtureScenario`.

### Ynab Fixture Story Content Strings

Use minimal but realistic story content to satisfy any downstream content validation in the handlers. A safe template:

```typescript
export const STORY_CONTENT_TEMPLATE = (storyKey: string) =>
  `# Story ${storyKey}: Test Story\n\n## Story\nAs a developer, I want to implement story ${storyKey}.\n\n## Acceptance Criteria\n\n### AC1:\n**Given** context\n**When** action\n**Then** outcome\n`
```

### Testing Requirements
- **Framework**: Vitest (same as all other sdlc package tests)
- **EventEmitter**: Use Node.js built-in `EventEmitter` from `'node:events'` for the per-story factory bus — it satisfies `GraphEventEmitter` duck-type natively
- **SDLC bus mock**: Use `{ emit: vi.fn() }` or a plain capture array; do not instantiate a real `TypedEventBus`
- **`expect.soft()`** for the performance overhead assertion — prevents flaky CI failures from timing variance in mock workloads
- **Test isolation**: Each test creates fresh `EventEmitter`, bridge, and captured events array; no shared state between tests
- **Run command**: `npm run test:fast` from monorepo root; verify "Test Files" summary line in output

## Interface Contracts

- **Import**: `createSdlcEventBridge`, `SdlcEventBridgeOptions` @ `packages/sdlc/src/handlers/event-bridge.ts` (from story 43-9)
- **Import (conditional)**: `buildReferenceEvents`, `ParityEvent`, `assertParity` @ `packages/sdlc/src/__tests__/parity-test.ts` (from story 43-11, if exported)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-22: Story created for Epic 43, Phase A — SDLC Pipeline as Graph
