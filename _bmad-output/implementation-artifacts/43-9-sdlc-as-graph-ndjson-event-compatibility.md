# Story 43.9: SDLC-as-Graph NDJSON Event Compatibility

## Story

As a graph-based SDLC orchestrator,
I want a thin event bridge that translates graph executor lifecycle events into SDLC orchestrator events,
so that existing consumers (supervisor, CLI polling, telemetry) receive the same `orchestrator:story-phase-*` NDJSON events they expect, with no modifications required to any downstream consumer.

## Acceptance Criteria

### AC1: graph:node-started → orchestrator:story-phase-start
**Given** the graph executor emits `graph:node-started` for a SDLC node (e.g. `dev_story`, `code_review`, `create_story`, `analysis`, `planning`, `solutioning`)
**When** the SDLC event bridge is active for a story run
**Then** it emits `orchestrator:story-phase-start` with payload `{ storyKey, phase, pipelineRunId? }` where `phase` is the SDLC phase name mapped from the node ID

### AC2: graph:node-completed → orchestrator:story-phase-complete
**Given** the graph executor emits `graph:node-completed` for a SDLC node
**When** the SDLC event bridge is active
**Then** it emits `orchestrator:story-phase-complete` with payload `{ storyKey, phase, result: outcome, pipelineRunId? }` — matching the payload shape of the existing linear orchestrator

### AC3: graph:completed (success) → orchestrator:story-complete
**Given** the graph executor emits `graph:completed` with `finalOutcome.status === 'SUCCESS'`
**When** the SDLC event bridge is active
**Then** it emits `orchestrator:story-complete` with payload `{ storyKey, reviewCycles }` where `reviewCycles` equals the number of `graph:node-retried` events observed for the `dev_story` node during the run

### AC4: graph:goal-gate-unsatisfied → orchestrator:story-escalated
**Given** the graph executor emits `graph:goal-gate-unsatisfied` for the `dev_story` node (retries exhausted, story escalated)
**When** the SDLC event bridge is active
**Then** it emits `orchestrator:story-escalated` with payload `{ storyKey, lastVerdict: 'NEEDS_MAJOR_REWORK', reviewCycles, issues: [] }` — signalling escalation to the supervisor

### AC5: Non-SDLC Nodes Are Silently Ignored
**Given** the graph executor emits `graph:node-started` or `graph:node-completed` for infrastructure nodes (`start`, `exit`) that are not in the SDLC phase map
**When** the SDLC event bridge handles these events
**Then** no `orchestrator:*` events are emitted (the bridge silently skips unmapped node IDs)

### AC6: Existing Consumers Work Without Modification
**Given** the SDLC event bridge is wired into `GraphOrchestrator` for each story run
**When** `substrate run --engine=graph --events` executes
**Then** the NDJSON event stream received by the supervisor, CLI polling, and telemetry pipeline is structurally identical to the stream produced by the existing linear `ImplementationOrchestrator` (same event names, same payload field names, no new required fields)

### AC7: Bridge Teardown Removes All Graph Event Listeners
**Given** a story run completes (success, failure, or escalation)
**When** the `teardown()` function returned by `createSdlcEventBridge()` is called
**Then** all graph event listeners registered by the bridge are removed, preventing memory leaks in long multi-story runs

## Tasks / Subtasks

- [ ] Task 1: Implement SDLC node phase map and `createSdlcEventBridge()` core (AC: #1, #2, #5)
  - [ ] Create `packages/sdlc/src/handlers/event-bridge.ts`
  - [ ] Define local duck-typed interfaces: `GraphEventEmitter` (`on/off`) and `SdlcEventBus` (`emit`) — ADR-003, no factory import
  - [ ] Define `SDLC_NODE_PHASE_MAP: Record<string, string>` mapping `{ analysis, planning, solutioning, create_story → 'create', dev_story → 'dev', code_review → 'review' }`
  - [ ] Define `SdlcEventBridgeOptions` interface: `{ storyKey, pipelineRunId?, sdlcBus, graphEvents }`
  - [ ] Implement `createSdlcEventBridge(opts)`: subscribe `graph:node-started` → emit `orchestrator:story-phase-start`; subscribe `graph:node-completed` → emit `orchestrator:story-phase-complete`; skip unmapped node IDs
  - [ ] Return `{ teardown() }` object that calls `graphEvents.off(...)` for all registered listeners

- [ ] Task 2: Implement story-complete and story-escalated translations (AC: #3, #4, #7)
  - [ ] Inside `createSdlcEventBridge()`, add a local `devStoryRetries` counter (initialized to 0)
  - [ ] Subscribe `graph:node-retried`: if `nodeId === 'dev_story'`, increment `devStoryRetries`
  - [ ] Subscribe `graph:completed`: if `finalOutcome.status === 'SUCCESS'`, emit `orchestrator:story-complete` with `{ storyKey, reviewCycles: devStoryRetries }`
  - [ ] Subscribe `graph:goal-gate-unsatisfied`: if `nodeId === 'dev_story'`, emit `orchestrator:story-escalated` with `{ storyKey, lastVerdict: 'NEEDS_MAJOR_REWORK', reviewCycles: devStoryRetries, issues: [] }`
  - [ ] Include all four new listeners in the `teardown()` function's cleanup

- [ ] Task 3: Integrate bridge into `GraphOrchestrator.run()` per-story execution (AC: #6)
  - [ ] In `packages/sdlc/src/orchestrator/graph-orchestrator.ts` (from story 43-7), locate the per-story execution loop
  - [ ] For each story: create a per-story factory event bus (or obtain the graph executor's event emitter); instantiate the bridge via `createSdlcEventBridge({ storyKey, pipelineRunId, sdlcBus: this.config.eventBus, graphEvents: factoryBus as unknown as GraphEventEmitter })`
  - [ ] Pass the factory event bus into the graph executor config so the executor emits its lifecycle events on it
  - [ ] After the per-story execution resolves (success, failure, or escalation), call `bridge.teardown()`
  - [ ] Ensure teardown is called in both the happy path and error/exception paths (use try/finally)

- [ ] Task 4: Write unit tests for the event bridge (AC: #1, #2, #3, #4, #5, #7)
  - [ ] Create `packages/sdlc/src/handlers/__tests__/event-bridge.test.ts`
  - [ ] Use Vitest; mock `graphEvents` as a simple `EventEmitter` instance (or minimal stub with `on/off/emit`)
  - [ ] Test AC1: `graph:node-started` for `dev_story` → `orchestrator:story-phase-start` with `{ storyKey: 'test-1', phase: 'dev' }`
  - [ ] Test AC1 (all nodes): verify each SDLC node maps to correct phase string
  - [ ] Test AC2: `graph:node-completed` for `code_review` → `orchestrator:story-phase-complete` with outcome in `result`
  - [ ] Test AC3: `graph:completed` with `status: 'SUCCESS'` after two retries → `orchestrator:story-complete` with `reviewCycles: 2`
  - [ ] Test AC4: `graph:goal-gate-unsatisfied` for `dev_story` → `orchestrator:story-escalated` with `lastVerdict: 'NEEDS_MAJOR_REWORK'`
  - [ ] Test AC5: `graph:node-started` for `start` node → no SDLC events emitted
  - [ ] Test AC7: after `teardown()`, firing graph events produces no further SDLC emissions

- [ ] Task 5: Write integration smoke test for bridge wired in GraphOrchestrator (AC: #6)
  - [ ] In `packages/sdlc/src/orchestrator/__tests__/graph-orchestrator.test.ts` (from story 43-7/43-8)
  - [ ] Add a test that constructs a minimal `GraphOrchestrator` with a mock SDLC event bus and a mock graph executor that emits `graph:node-started` / `graph:node-completed` / `graph:completed` for a two-node path (`dev_story` → `code_review`)
  - [ ] Assert that the SDLC event bus receives `orchestrator:story-phase-start` for `dev` and `review` phases in order
  - [ ] Assert that `orchestrator:story-complete` is received after `graph:completed`

- [ ] Task 6: Export and build verification (AC: all)
  - [ ] Export `createSdlcEventBridge` and `SdlcEventBridgeOptions` from `packages/sdlc/src/handlers/index.ts`
  - [ ] Add re-export from `packages/sdlc/src/index.ts` if not already covered by handlers barrel
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors, no circular dependencies introduced
  - [ ] Run `npm run test:fast` — all new tests pass, no regressions in sdlc or factory tests

## Dev Notes

### Architecture Constraints

- **ADR-003 (no cross-package runtime coupling)**: `event-bridge.ts` lives in `packages/sdlc/src/handlers/` and **must NOT** import any runtime value from `@substrate-ai/factory`. All coupling to the factory event bus shape is via local duck-typed interfaces (`GraphEventEmitter`, `SdlcEventBus`). This allows the bridge to subscribe to the factory bus at runtime (through the composition root) without creating a compile-time circular dependency.
- **Permitted type-only imports**: The bridge may use `import type` from `@substrate-ai/factory` if the type is needed for documentation or type assertion. However, the implementation should work correctly with only the local duck-typed interfaces — the `import type` is optional.
- **Per-story bus pattern**: The graph executor (from `@substrate-ai/factory`) emits lifecycle events on a `TypedEventBus<FactoryEvents>` that is injected into its config at construction time. The `GraphOrchestrator` (story 43-7) must create a separate per-story factory bus for each story execution and pass it to both the executor config and the bridge. This ensures bridge listeners are scoped to a single story run.
- **SDLC event payload parity**: The `orchestrator:story-phase-start` payload must include exactly `{ storyKey, phase, pipelineRunId? }` — no extra fields. Similarly for `orchestrator:story-phase-complete`: `{ storyKey, phase, result, pipelineRunId? }`. Mismatched payload shapes will break the supervisor's stall detection which pattern-matches on `phase`.
- **`reviewCycles` semantics**: `reviewCycles` in `orchestrator:story-complete` and `orchestrator:story-escalated` represents the number of code-review retry cycles (i.e. `graph:node-retried` count for `dev_story`). A story with zero retries has `reviewCycles: 0`. This matches the linear orchestrator's `reviewCycles` value.

### File Paths

- **New**: `packages/sdlc/src/handlers/event-bridge.ts` — the event bridge implementation
- **New**: `packages/sdlc/src/handlers/__tests__/event-bridge.test.ts` — unit tests
- **Modify**: `packages/sdlc/src/handlers/index.ts` — add export of `createSdlcEventBridge`, `SdlcEventBridgeOptions`
- **Modify**: `packages/sdlc/src/orchestrator/graph-orchestrator.ts` — wire bridge creation and teardown into per-story execution loop
- **Modify (if needed)**: `packages/sdlc/src/index.ts` — re-export from handlers barrel
- **Extend**: `packages/sdlc/src/orchestrator/__tests__/graph-orchestrator.test.ts` — add integration smoke test

### SDLC Node Phase Map

| Graph Node ID  | SDLC Phase Name | Notes                                    |
|----------------|-----------------|------------------------------------------|
| `analysis`     | `'analysis'`    | Phase handler node                       |
| `planning`     | `'planning'`    | Phase handler node                       |
| `solutioning`  | `'solutioning'` | Phase handler node                       |
| `create_story` | `'create'`      | Create-story handler node                |
| `dev_story`    | `'dev'`         | Dev-story handler node (may retry)       |
| `code_review`  | `'review'`      | Code-review handler node (conditional)  |
| `start`        | *(ignored)*     | Graph infrastructure node — no SDLC event |
| `exit`         | *(ignored)*     | Graph infrastructure node — no SDLC event |

### Event Mapping Reference

| Graph Event                   | SDLC Event                       | Condition                            |
|-------------------------------|----------------------------------|--------------------------------------|
| `graph:node-started`          | `orchestrator:story-phase-start` | node in SDLC_NODE_PHASE_MAP          |
| `graph:node-completed`        | `orchestrator:story-phase-complete` | node in SDLC_NODE_PHASE_MAP       |
| `graph:node-retried`          | *(counter only)*                 | nodeId === 'dev_story'               |
| `graph:completed`             | `orchestrator:story-complete`    | finalOutcome.status === 'SUCCESS'    |
| `graph:goal-gate-unsatisfied` | `orchestrator:story-escalated`   | nodeId === 'dev_story'               |
| `graph:node-failed`           | *(no mapping)*                   | Not consumed — failure propagates via graph:completed |
| `graph:edge-selected`         | *(no mapping)*                   | No SDLC equivalent                   |

### Implementation Sketch

```typescript
// packages/sdlc/src/handlers/event-bridge.ts

// ADR-003: local duck-typed interfaces — NO factory import at runtime

/** Structurally compatible with Node.js EventEmitter or TypedEventBus<FactoryEvents> */
interface GraphEventEmitter {
  on(event: string, handler: (data: unknown) => void): this
  off(event: string, handler: (data: unknown) => void): this
}

/** Structurally compatible with TypedEventBus<SdlcEvents>.emit */
interface SdlcEventBus {
  emit(event: string, payload: unknown): void
}

export interface SdlcEventBridgeOptions {
  storyKey: string
  pipelineRunId?: string
  sdlcBus: SdlcEventBus
  graphEvents: GraphEventEmitter
}

/** SDLC node IDs that map to phase names; all others are silently ignored. */
const SDLC_NODE_PHASE_MAP: Record<string, string> = {
  analysis:     'analysis',
  planning:     'planning',
  solutioning:  'solutioning',
  create_story: 'create',
  dev_story:    'dev',
  code_review:  'review',
}

/**
 * Creates an event bridge that translates graph executor lifecycle events into
 * SDLC orchestrator events for backward compatibility with existing consumers.
 *
 * Returns a `teardown()` function that removes all graph event listeners.
 * Call teardown() after story execution completes (use try/finally).
 */
export function createSdlcEventBridge(opts: SdlcEventBridgeOptions): { teardown(): void } {
  const { storyKey, pipelineRunId, sdlcBus, graphEvents } = opts
  let devStoryRetries = 0

  const onNodeStarted = (data: unknown) => {
    const { nodeId } = data as { nodeId: string }
    const phase = SDLC_NODE_PHASE_MAP[nodeId]
    if (!phase) return
    sdlcBus.emit('orchestrator:story-phase-start', { storyKey, phase, pipelineRunId })
  }

  const onNodeCompleted = (data: unknown) => {
    const { nodeId, outcome } = data as { nodeId: string; outcome: unknown }
    const phase = SDLC_NODE_PHASE_MAP[nodeId]
    if (!phase) return
    sdlcBus.emit('orchestrator:story-phase-complete', { storyKey, phase, result: outcome, pipelineRunId })
  }

  const onNodeRetried = (data: unknown) => {
    const { nodeId } = data as { nodeId: string }
    if (nodeId === 'dev_story') devStoryRetries++
  }

  const onGraphCompleted = (data: unknown) => {
    const { finalOutcome } = data as { finalOutcome: { status: string } }
    if (finalOutcome.status === 'SUCCESS') {
      sdlcBus.emit('orchestrator:story-complete', { storyKey, reviewCycles: devStoryRetries })
    }
  }

  const onGoalGateUnsatisfied = (data: unknown) => {
    const { nodeId } = data as { nodeId: string }
    if (nodeId === 'dev_story') {
      sdlcBus.emit('orchestrator:story-escalated', {
        storyKey,
        lastVerdict: 'NEEDS_MAJOR_REWORK',
        reviewCycles: devStoryRetries,
        issues: [],
      })
    }
  }

  graphEvents.on('graph:node-started', onNodeStarted)
  graphEvents.on('graph:node-completed', onNodeCompleted)
  graphEvents.on('graph:node-retried', onNodeRetried)
  graphEvents.on('graph:completed', onGraphCompleted)
  graphEvents.on('graph:goal-gate-unsatisfied', onGoalGateUnsatisfied)

  return {
    teardown() {
      graphEvents.off('graph:node-started', onNodeStarted)
      graphEvents.off('graph:node-completed', onNodeCompleted)
      graphEvents.off('graph:node-retried', onNodeRetried)
      graphEvents.off('graph:completed', onGraphCompleted)
      graphEvents.off('graph:goal-gate-unsatisfied', onGoalGateUnsatisfied)
    },
  }
}
```

### GraphOrchestrator Integration Pattern

```typescript
// Inside GraphOrchestrator.run() — per-story execution (packages/sdlc/src/orchestrator/graph-orchestrator.ts)

// Obtain the factory event bus type-import if available; otherwise use unknown cast
// This is the composition point where the SDLC orchestrator wires into factory internals
import { createTypedEventBus } from '@substrate-ai/core'  // or factory equivalent
import { createSdlcEventBridge } from '../handlers/event-bridge.js'

// ... inside per-story dispatch:
const factoryBus = createTypedEventBus() // per-story scope
const bridge = createSdlcEventBridge({
  storyKey,
  pipelineRunId: this.config.pipelineRunId,
  sdlcBus: this.config.eventBus as unknown as { emit(e: string, p: unknown): void },
  graphEvents: factoryBus as unknown as { on(...): this; off(...): this },
})
try {
  await executor.run(storyGraph, context, { eventBus: factoryBus })
} finally {
  bridge.teardown()
}
```

> **Note:** The cast `as unknown as GraphEventEmitter` is deliberate: it avoids a compile-time `@substrate-ai/factory` type dependency in the SDLC orchestrator module while remaining safe at runtime because `TypedEventBus` structurally satisfies the duck-typed `GraphEventEmitter` interface. This pattern is established in story 43-7 (ADR-003 duck-typing bridge).

### Import Pattern

```typescript
// event-bridge.ts — no factory import at all (ADR-003)
// All graph event shapes decoded via local cast from `unknown`

// graph-orchestrator.ts — existing factory imports remain unchanged
import { parseGraph } from '@substrate-ai/factory'
import type { Graph } from '@substrate-ai/factory'
// Add only:
import { createSdlcEventBridge } from '../handlers/event-bridge.js'
```

### Testing Requirements

- **Framework**: Vitest (same as all sdlc package tests)
- **EventEmitter mock**: Use Node.js built-in `EventEmitter` as the `graphEvents` mock — it satisfies the `GraphEventEmitter` duck-type with native `on/off/emit` support
- **SdlcEventBus mock**: Simple `vi.fn()` stub: `const sdlcBus = { emit: vi.fn() }` — inspect `.mock.calls` to verify emitted events
- **Test isolation**: Construct a fresh `EventEmitter` and bridge per test case; do not share state between tests
- **Payload shape assertions**: Use `expect(sdlcBus.emit).toHaveBeenCalledWith('orchestrator:story-phase-start', expect.objectContaining({ storyKey: '43-9', phase: 'dev' }))` — verify exact field names
- **teardown test**: After calling `bridge.teardown()`, emit additional graph events and assert `sdlcBus.emit` call count does not increase
- **Run**: `npm run test:fast` from monorepo root; confirm zero new failures

### Context Keys Reference

The event bridge reads no `IGraphContext` keys directly — the `storyKey` and `pipelineRunId` values are injected via `SdlcEventBridgeOptions` by the `GraphOrchestrator`. No context key protocol changes are needed in this story.

## Interface Contracts

- **Import**: `createSdlcEventBridge`, `SdlcEventBridgeOptions` @ `packages/sdlc/src/handlers/event-bridge.ts` (consumed by story 43-10 — `--engine` flag wiring, which instantiates `GraphOrchestrator` with event bus config)
- **Import (internal)**: `createSdlcEventBridge` used by `packages/sdlc/src/orchestrator/graph-orchestrator.ts` (story 43-7 composition root)
- **Export (consumed by 43-10)**: `GraphOrchestrator` config shape must include `eventBus` field that accepts the SDLC event bus — confirm this was wired in story 43-7 or add it here

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-22: Story created for Epic 43, Phase A — SDLC Pipeline as Graph
