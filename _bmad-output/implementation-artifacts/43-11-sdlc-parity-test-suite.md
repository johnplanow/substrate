# Story 43.11: SDLC Parity Test Suite

## Story

As a substrate developer,
I want an automated parity test suite that runs the same story scenarios through both the linear and graph SDLC engines and compares their SDLC bus event sequences,
so that any behavioral divergence between the graph engine and the linear reference is caught before code is merged.

## Acceptance Criteria

### AC1: Happy-Path Parity — Events and Summary Match
**Given** a mock executor scenario where all SDLC phases (create_story → dev_story → code_review) succeed on the first attempt
**When** the parity harness runs the scenario through the graph engine and compares against the linear reference event sequence
**Then** the ordered sequence of `orchestrator:story-*` event names captured from the SDLC bus is identical to the linear reference, and the `GraphRunSummary` shows `{ successCount: 1, failureCount: 0, totalStories: 1 }`

### AC2: Rework-Cycle Parity — Review Retry Event Sequence Matches
**Given** a mock executor scenario where code_review returns a fail outcome on the first attempt and success on the second (one rework cycle, `maxReviewCycles: 2`)
**When** the parity harness runs the scenario through the graph engine
**Then** the SDLC bus emits two `orchestrator:story-phase-start` events for the `dev` phase, two for `review`, and `orchestrator:story-complete` with `reviewCycles: 1` — matching the linear reference sequence

### AC3: Escalation Parity — Escalated Events Match
**Given** a mock executor scenario where code_review always returns fail (retries exhausted, `maxReviewCycles: 2`)
**When** the parity harness runs the scenario through the graph engine
**Then** the SDLC bus emits `orchestrator:story-escalated` (not `orchestrator:story-complete`), and the `GraphRunSummary` shows `{ successCount: 0, failureCount: 1, totalStories: 1 }` — matching the linear reference

### AC4: Multi-Story Batch Parity — Per-Story Events Are Isolated
**Given** a two-story batch where story A always succeeds and story B always escalates, run with `maxConcurrency: 1`
**When** the parity harness runs through the graph engine
**Then** the SDLC bus events for story A match the happy-path reference and events for story B match the escalation reference, with no cross-story event contamination; the summary shows `{ successCount: 1, failureCount: 1, totalStories: 2 }`

### AC5: Phase Event Payload Shape Matches Linear Contract
**Given** the happy-path scenario
**When** the parity harness captures `orchestrator:story-phase-start` and `orchestrator:story-phase-complete` events from the graph engine
**Then** each event payload contains exactly the fields `{ storyKey, phase, pipelineRunId? }` (for start) and `{ storyKey, phase, result, pipelineRunId? }` (for complete) — matching the payload shape documented in story 43-9 and expected by the supervisor

### AC6: Parity Tests Run in `npm run test:fast` Without External I/O
**Given** the test file at `packages/sdlc/src/__tests__/parity-test.ts`
**When** `npm run test:fast` is executed from the monorepo root
**Then** all parity tests complete without timeout, without network calls, and without actual dispatcher invocations — all execution is driven by in-process mock executors emitting synthetic graph events

### AC7: Divergence Causes Clear Test Failure
**Given** an intentionally injected divergence (e.g., the mock executor emits an extra `graph:node-started` for an unmapped node that leaks an extra `orchestrator:story-phase-start`)
**When** the parity assertion helper compares graph engine events against the linear reference
**Then** the test fails and the assertion message shows the differing event at the index of divergence (e.g., `expected [...] to equal [...]`)

## Tasks / Subtasks

- [x] Task 1: Create `packages/sdlc/src/__tests__/parity-test.ts` with shared harness types (AC: #1, #2, #3, #4, #5, #6)
  - [x] Define `ParityEvent` interface: `{ name: string; payload: Record<string, unknown> }`
  - [x] Define `PariityScenario` type: `{ storyKey: string; phases: Array<{ nodeId: string; outcomeStatus: 'SUCCESS' | 'FAIL' }> }`
  - [x] Define `ParityCapture` interface: `{ events: ParityEvent[]; summary: { successCount: number; failureCount: number; totalStories: number } }`
  - [x] Implement `buildReferenceEvents(scenario: PariityScenario): ParityEvent[]` — derives the expected linear-engine event sequence from the `SDLC_NODE_PHASE_MAP` and scenario phases (e.g., `[phase-start(create), phase-complete(create), phase-start(dev), ...]`); append `story-complete` or `story-escalated` as terminal event
  - [x] Keep all helpers in the same test file; no new source files needed

- [x] Task 2: Implement `runGraphScenario()` — drives `createGraphOrchestrator` with mock executor (AC: #1, #2, #3, #4)
  - [x] Import `createGraphOrchestrator`, `GraphShape`, `IGraphExecutorLocal`, `GraphRunResult`, `GraphOrchestratorConfig` from `../orchestrator/graph-orchestrator.js`
  - [x] Import `createSdlcEventBridge` from `../handlers/event-bridge.js`
  - [x] Build a minimal `GraphShape` using the 8 SDLC nodes (ids matching `SDLC_NODE_PHASE_MAP` plus `start` and `exit`)
  - [x] Create a per-call mock `IGraphExecutorLocal` whose `run()` method uses a local `EventEmitter` to emit `graph:node-started`, `graph:node-completed`, `graph:node-retried`, `graph:completed`, and `graph:goal-gate-unsatisfied` events according to the scenario phases
  - [x] Wire the `SdlcEventBridge` inside `runGraphScenario` by attaching it to the per-story `EventEmitter` and a capture bus (`{ emit: vi.fn() }`); call `bridge.teardown()` in a `finally` block
  - [x] Collect captured bus events into `ParityCapture.events`; derive `summary` from the executor mock's invocation result

- [x] Task 3: Implement `assertParity()` comparison helper (AC: #5, #7)
  - [x] Accept `linear: ParityEvent[]` and `graph: ParityEvent[]` parameters
  - [x] Assert `graph.map(e => e.name)` deep-equals `linear.map(e => e.name)` — catches ordering/count divergences
  - [x] For each matching index, assert `graph[i].payload` contains all fields present in `linear[i].payload` using `expect.objectContaining()`
  - [x] If event counts differ, include count in the failure message

- [x] Task 4: Write happy-path parity test (AC: #1, #5)
  - [x] Define `happyPathScenario`: create_story → SUCCESS, dev_story → SUCCESS, code_review → SUCCESS
  - [x] Call `buildReferenceEvents(happyPathScenario)` to get the linear reference
  - [x] Call `runGraphScenario(happyPathScenario, { maxReviewCycles: 2 })` to get the graph capture
  - [x] Assert `capture.summary` equals `{ successCount: 1, failureCount: 0, totalStories: 1 }`
  - [x] Call `assertParity(referenceEvents, capture.events)` and expect it to pass

- [x] Task 5: Write rework-cycle parity test (AC: #2)
  - [x] Define `reworkScenario`: create_story → SUCCESS, dev_story → SUCCESS, code_review → FAIL (first), dev_story → SUCCESS (retry), code_review → SUCCESS (second)
  - [x] Build reference events: the linear engine would emit phase-start/complete for dev then review twice, ending with `story-complete { reviewCycles: 1 }`
  - [x] Run graph scenario and assert parity; verify terminal `story-complete` event has `reviewCycles: 1`

- [x] Task 6: Write escalation and multi-story batch parity tests (AC: #3, #4)
  - [x] Define `escalationScenario` with `maxReviewCycles: 2`: dev_story always succeeds but code_review always returns FAIL — after 2 retries, `graph:goal-gate-unsatisfied` fires
  - [x] Assert `story-escalated` is the terminal event; assert summary `failureCount: 1`
  - [x] Define `batchScenarios`: `[{ storyKey: 'test-A', phases: happyPath }, { storyKey: 'test-B', phases: escalation }]`
  - [x] Run both stories through the graph orchestrator with `maxConcurrency: 1`; assert per-story event isolation and `{ successCount: 1, failureCount: 1, totalStories: 2 }`

- [x] Task 7: Write divergence detection test (AC: #7)
  - [x] Construct a `dirtyGraphCapture` that adds one extra `orchestrator:story-phase-start` event before the terminal event
  - [x] Assert that `assertParity(referenceEvents, dirtyCapture.events)` throws (wrap in `expect(() => assertParity(...)).toThrow()`)
  - [x] Confirms the harness can catch real behavioral divergences

- [x] Task 8: Build verification (AC: #6, all)
  - [x] Run `npm run build` from monorepo root — zero TypeScript errors
  - [x] Run `npm run test:fast` — all parity tests pass, no regressions in other test files; confirm "Test Files" summary line in output

## Dev Notes

### Architecture Constraints

- **ADR-003 (no circular cross-package imports)**: `parity-test.ts` lives in `packages/sdlc/src/__tests__/`. It may import from `packages/sdlc/src/` and `@substrate-ai/factory` (for `parseGraph`/type imports) but must NOT import runtime values from `src/` (the monolith). This is a standalone package test — no CLI imports.
- **No new source files required**: All harness code lives inside `parity-test.ts`. Helper functions (`buildReferenceEvents`, `runGraphScenario`, `assertParity`) are local to the test file. This keeps the surface area minimal and avoids polluting production exports.
- **Mock executor drives graph events**: The `IGraphExecutorLocal.run()` mock must emit `graph:*` events synchronously or in microtask order on a local `EventEmitter` — this is what the `SdlcEventBridge` (story 43-9) subscribes to. The event bridge must be manually instantiated and wired in `runGraphScenario` since the graph orchestrator's internal per-story bus is what the bridge attaches to.
- **`createGraphOrchestrator` needs a real graph shape**: The orchestrator validates the graph at construction time (`GraphOrchestratorInitError` if `nodes` or `edges` are missing). Use a minimal but valid 8-node `GraphShape` matching the SDLC pipeline topology. Node `type` values must satisfy the handler registry — pass an empty `handlerRegistry` `{}` since the mock executor bypasses handler dispatch.
- **`reviewCycles` counter lives in the event bridge**: The `SdlcEventBridge` counts `graph:node-retried` events for `dev_story`. The mock executor must emit `graph:node-retried` for each retry before the final `graph:goal-gate-unsatisfied` (escalation) or `graph:completed` (success). See story 43-9 for the exact event sequence.

### File Paths

- **New**: `packages/sdlc/src/__tests__/parity-test.ts` — parity test suite (entire story output)
- **Read (no modification)**: `packages/sdlc/src/orchestrator/graph-orchestrator.ts` — `createGraphOrchestrator`, `GraphShape`, `IGraphExecutorLocal`, `GraphRunSummary`, `GraphOrchestratorConfig`
- **Read (no modification)**: `packages/sdlc/src/handlers/event-bridge.ts` — `createSdlcEventBridge`, `SdlcEventBridgeOptions`
- **Read (no modification)**: `packages/sdlc/src/orchestrator/__tests__/graph-orchestrator.test.ts` — reference for `makeMinimalGraphShape()` and `makeBaseConfig()` patterns

### Mock Executor Event Emission Pattern

The parity test's mock executor must emit graph lifecycle events on a per-story `EventEmitter` that the `SdlcEventBridge` listens to. Wire it manually inside `runGraphScenario`:

```typescript
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import { createGraphOrchestrator } from '../orchestrator/graph-orchestrator.js'
import type { IGraphExecutorLocal, GraphRunResult } from '../orchestrator/graph-orchestrator.js'
import { createSdlcEventBridge } from '../handlers/event-bridge.js'

async function runGraphScenario(
  scenario: PariityScenario,
  opts: { maxReviewCycles?: number } = {},
): Promise<ParityCapture> {
  const capturedEvents: ParityEvent[] = []
  const sdlcBus = { emit: (name: string, payload: unknown) => { capturedEvents.push({ name, payload: payload as Record<string, unknown> }) } }

  // Per-story factory event bus — the bridge subscribes to this
  const factoryBus = new EventEmitter()
  const bridge = createSdlcEventBridge({
    storyKey: scenario.storyKey,
    pipelineRunId: 'test-run-id',
    sdlcBus,
    graphEvents: factoryBus as unknown as { on(...): any; off(...): any },
  })

  try {
    // Simulate the graph executor driving the scenario
    for (const phase of scenario.phases) {
      factoryBus.emit('graph:node-started', { nodeId: phase.nodeId })
      if (phase.nodeId === 'dev_story' && phase.outcomeStatus === 'FAIL') {
        // Rework: emit node-completed for review, then node-retried for dev_story
        factoryBus.emit('graph:node-completed', { nodeId: phase.nodeId, outcome: { status: 'FAIL' } })
        factoryBus.emit('graph:node-retried', { nodeId: 'dev_story' })
      } else {
        factoryBus.emit('graph:node-completed', { nodeId: phase.nodeId, outcome: { status: phase.outcomeStatus } })
      }
    }
    // Terminal event
    const escalated = scenario.phases.some(p => p.nodeId === 'code_review' && p.outcomeStatus === 'FAIL' && /* final attempt */ true)
    if (/* retries exhausted */ escalated) {
      factoryBus.emit('graph:goal-gate-unsatisfied', { nodeId: 'dev_story' })
    } else {
      factoryBus.emit('graph:completed', { finalOutcome: { status: 'SUCCESS' } })
    }
  } finally {
    bridge.teardown()
  }
  // ... derive summary and return ParityCapture
}
```

> **Note:** The sketch above is illustrative. The dev agent should adapt the escalation/rework logic to correctly model the scenario's phase sequence. Study `graph-orchestrator.test.ts` for the established `makeMinimalGraphShape` helper pattern.

### Reference Event Sequence for Happy Path

The `buildReferenceEvents()` helper should produce this sequence for the happy-path scenario (matching the linear orchestrator's documented output):

| # | Event Name                       | Key Payload Fields                                |
|---|----------------------------------|---------------------------------------------------|
| 1 | `orchestrator:story-phase-start` | `{ storyKey, phase: 'create' }`                   |
| 2 | `orchestrator:story-phase-complete` | `{ storyKey, phase: 'create', result: ... }`   |
| 3 | `orchestrator:story-phase-start` | `{ storyKey, phase: 'dev' }`                      |
| 4 | `orchestrator:story-phase-complete` | `{ storyKey, phase: 'dev', result: ... }`      |
| 5 | `orchestrator:story-phase-start` | `{ storyKey, phase: 'review' }`                   |
| 6 | `orchestrator:story-phase-complete` | `{ storyKey, phase: 'review', result: ... }`   |
| 7 | `orchestrator:story-complete`    | `{ storyKey, reviewCycles: 0 }`                   |

For the rework cycle scenario, events 3–6 appear twice (for the repeated dev+review cycle) and the terminal event is `story-complete { reviewCycles: 1 }`.

### Testing Requirements

- **Framework**: Vitest (same as all other sdlc package tests)
- **EventEmitter mock**: Use Node.js built-in `EventEmitter` as the per-story factory bus — it satisfies `GraphEventEmitter` duck-type natively (same pattern as story 43-9 tests)
- **SDLC bus mock**: Use a plain object `{ emit: vi.fn() }` for the SDLC event bus; collect calls into `capturedEvents` array
- **No `vi.mock()` needed**: `runGraphScenario` manually wires `createSdlcEventBridge` directly without mocking — this is an integration test of the event bridge + orchestrator together
- **Isolation**: Each test creates fresh `EventEmitter`, `bridge`, and `capturedEvents` array; no shared state between tests
- **Run**: `npm run test:fast` from monorepo root; confirm "Test Files" summary line with zero failures

### `GraphOrchestratorConfig` for Parity Tests

When calling `createGraphOrchestrator` (if needed for multi-story tests using Task 2), provide:
- `graph`: the minimal 8-node `GraphShape` (nodes: `start, analysis, planning, solutioning, create_story, dev_story, code_review, exit`)
- `executor`: a mock `IGraphExecutorLocal` whose `run()` drives the per-story factory bus
- `handlerRegistry`: `{}` (empty — handler dispatch is bypassed by the mock executor)
- `projectRoot`: `'/test/root'`
- `methodologyPack`: `'default'`
- `maxConcurrency`: `1`
- `logsRoot`: `'/test/logs'`
- `runId`: `'parity-test-run'`
- `gcPauseMs`: `0` (no GC pause in tests)

Reference: see `makeBaseConfig()` in `packages/sdlc/src/orchestrator/__tests__/graph-orchestrator.test.ts`.

## Interface Contracts

- **Import**: `createGraphOrchestrator`, `GraphShape`, `IGraphExecutorLocal`, `GraphRunResult`, `GraphOrchestratorConfig`, `GraphRunSummary` @ `packages/sdlc/src/orchestrator/graph-orchestrator.ts` (from story 43-7)
- **Import**: `createSdlcEventBridge`, `SdlcEventBridgeOptions` @ `packages/sdlc/src/handlers/event-bridge.ts` (from story 43-9)

## Dev Agent Record

### Agent Model Used
claude-opus-4-5

### Completion Notes List
- `parity-test.ts` uses `for...of` with `.entries()` throughout to satisfy `noUncheckedIndexedAccess: true` TypeScript compiler option; non-null assertions (`!`) are used only where the array bounds are logically guaranteed.
- `runGraphScenario` manually wires `createSdlcEventBridge` (not via `createGraphOrchestrator`) for single-story tests; the multi-story batch test (AC4) uses `createGraphOrchestrator` directly with a per-story mock executor.
- vitest.config.ts updated to add `packages/**/*-test.ts` to the `include` array so that `parity-test.ts` (which uses `-test.ts` suffix per story spec) is discoverable by test runner.
- Escalation scenario uses 3 code_review FAIL phases (2 node-retried + 1 goal-gate-unsatisfied) yielding `reviewCycles: 2` matching `maxReviewCycles: 2`.

### File List
- packages/sdlc/src/__tests__/parity-test.ts (new)
- vitest.config.ts (modified — added `packages/**/*-test.ts` to include list)

## Change Log

- 2026-03-22: Story created for Epic 43, Phase A — SDLC Pipeline as Graph
