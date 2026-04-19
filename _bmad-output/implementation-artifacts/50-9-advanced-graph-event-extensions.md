# Story 50-9: Advanced Graph Event Extensions

## Story

As a pipeline operator,
I want the NDJSON event stream to include lifecycle events for parallel fan-out/fan-in, subgraph execution, and LLM-evaluated edge conditions,
so that I can observe, debug, and trace advanced graph features in real time without modifying existing event consumers.

## Acceptance Criteria

### AC1: Parallel Lifecycle Events Emitted
**Given** a `parallel` node (implemented in Story 50-1) executes with N branches and a join policy
**When** execution proceeds through fan-out, per-branch execution, and completion
**Then** four event types are emitted in order: `graph:parallel-started` (once, with `branchCount` and `policy`), `graph:parallel-branch-started` (once per branch, with `branchIndex`), `graph:parallel-branch-completed` (once per branch after it resolves, with `status` and `durationMs`), and `graph:parallel-completed` (once, with `completedCount` and `cancelledCount`)

### AC2: Subgraph Lifecycle Events Emitted
**Given** a `subgraph` node (implemented in Story 50-5) references an external `.dot` file
**When** the subgraph handler starts and finishes execution
**Then** `graph:subgraph-started` is emitted before the sub-executor runs (with `graphFile` and `depth`) and `graph:subgraph-completed` is emitted after the sub-executor returns (with `status` and `durationMs`); the sub-executor is also given the same `eventBus` so that nested graph events flow on the same bus

### AC3: LLM Edge Evaluation Event Emitted
**Given** an edge with an `llm:` condition (implemented in Story 50-4) is evaluated inside `selectEdge()`
**When** `evaluateLlmCondition()` returns a result (affirmative, negative, or error-fallback `false`)
**Then** `graph:llm-edge-evaluated` is emitted with `{ runId, nodeId, question, result }` regardless of the boolean outcome; the event is also emitted on the error-fallback path so that cost accounting accurately reflects every LLM call attempt

### AC4: EventBus and RunId Threaded to All Emission Sites
**Given** a `GraphExecutorConfig` with `eventBus` and `runId` fields
**When** the executor initialises a run
**Then** (a) `config.runId` is written to context under key `"__runId"` at the start of `run()` so handlers can read it via `context.getString("__runId", "unknown")`, (b) `DefaultRegistryOptions` accepts `eventBus?` and `runId?` which are forwarded to `createParallelHandler()` and `createSubgraphHandler()` via their respective options, and (c) all three `await selectEdge()` call sites in `executor.ts` pass `{ eventBus: config.eventBus, runId: config.runId }` inside their `SelectEdgeOptions` object

### AC5: All Seven New Event Types Declared in FactoryEvents
**Given** `packages/factory/src/events.ts` contains the `FactoryEvents` interface
**When** the TypeScript compiler processes the project
**Then** all seven event types — `graph:parallel-started`, `graph:parallel-branch-started`, `graph:parallel-branch-completed`, `graph:parallel-completed`, `graph:subgraph-started`, `graph:subgraph-completed`, `graph:llm-edge-evaluated` — are present with the exact payload interfaces specified in Dev Notes, and `npm run build` completes with zero errors

### AC6: Backward Compatibility — No Existing Events or Tests Broken
**Given** all event type strings, payload field names, and emission semantics defined before this story
**When** new events are emitted alongside existing ones
**Then** no existing event type is modified, renamed, or removed; all existing tests continue to pass; and consumers that switch on event type strings silently ignore the seven new types

### AC7: Unit Tests Cover All Emission Paths
**Given** three new test files covering parallel events, subgraph events, and LLM edge events
**When** `npm run test:fast` runs
**Then** at least 15 `it(...)` cases pass covering: `graph:parallel-started` / `graph:parallel-branch-started` / `graph:parallel-branch-completed` / `graph:parallel-completed` correctness (4 cases), `graph:subgraph-started` / `graph:subgraph-completed` correctness (2 cases), `graph:llm-edge-evaluated` for affirmative, negative, and error-fallback (3 cases), no-op when `eventBus` is absent in all three call sites (3 cases), and payload field type conformance to `FactoryEvents` declarations (3 cases)

## Tasks / Subtasks

- [ ] Task 1: Add seven new event types to `packages/factory/src/events.ts` (AC: #5, #6)
  - [ ] Read the existing `FactoryEvents` interface structure to understand where to insert new entries (after `graph:goal-gate-unsatisfied` is a natural grouping for new `graph:` events)
  - [ ] Add `'graph:parallel-started'` payload: `{ runId: string; nodeId: string; branchCount: number; maxParallel: number; policy: string }`
  - [ ] Add `'graph:parallel-branch-started'` payload: `{ runId: string; nodeId: string; branchIndex: number }`
  - [ ] Add `'graph:parallel-branch-completed'` payload: `{ runId: string; nodeId: string; branchIndex: number; status: StageStatus; durationMs: number }`
  - [ ] Add `'graph:parallel-completed'` payload: `{ runId: string; nodeId: string; completedCount: number; cancelledCount: number; policy: string }`
  - [ ] Add `'graph:subgraph-started'` payload: `{ runId: string; nodeId: string; graphFile: string; depth: number }`
  - [ ] Add `'graph:subgraph-completed'` payload: `{ runId: string; nodeId: string; graphFile: string; depth: number; status: StageStatus; durationMs: number }`
  - [ ] Add `'graph:llm-edge-evaluated'` payload: `{ runId: string; nodeId: string; question: string; result: boolean }`
  - [ ] Run `npm run build` to confirm zero TypeScript errors before proceeding to later tasks

- [ ] Task 2: Extend handler option types and registry to thread eventBus (AC: #4)
  - [ ] Read `packages/factory/src/graph/types.ts` to find the exact TypeScript type used for `GraphExecutorConfig.eventBus` (e.g., `TypedEventEmitter<FactoryEvents>` or a named interface); use this exact type in all additions below
  - [ ] In `packages/factory/src/handlers/types.ts`: add optional `eventBus?` field (same type) and `runId?: string` to `ParallelHandlerOptions` (from Story 50-1)
  - [ ] In `packages/factory/src/handlers/types.ts`: add optional `eventBus?` field (same type) and `runId?: string` to `SubgraphHandlerOptions` (from Story 50-5)
  - [ ] In `packages/factory/src/handlers/registry.ts`: add `eventBus?` (same type) and `runId?: string` to `DefaultRegistryOptions`; update `createDefaultRegistry()` to pass `eventBus: options?.eventBus` and `runId: options?.runId` to both `createParallelHandler(...)` and `createSubgraphHandler(...)` call sites
  - [ ] In `packages/factory/src/graph/edge-selector.ts`: add `eventBus?: <same type>` and `runId?: string` to the existing `SelectEdgeOptions` interface (from Story 50-4) — do NOT remove `llmCall?`

- [ ] Task 3: Write `config.runId` to context in executor (AC: #4)
  - [ ] Read `packages/factory/src/graph/executor.ts` to find where `run()` creates or initialises the `IGraphContext` (likely within the first ~50 lines of `run()`)
  - [ ] Add `context.set("__runId", config.runId ?? "unknown")` immediately after the context is ready and before any node is dispatched
  - [ ] Update all three `await selectEdge(...)` call sites to pass `options` that include `eventBus: config.eventBus` and `runId: config.runId` (merge with any existing options object already passed); grep for all call sites first: `grep -n "selectEdge" packages/factory/src/graph/executor.ts`
  - [ ] Run `npm run build` to confirm the executor still compiles cleanly

- [ ] Task 4: Emit parallel lifecycle events in `packages/factory/src/handlers/parallel.ts` (AC: #1)
  - [ ] Read the file to confirm existing structure from Story 50-1 (branchCount, maxParallel, joinPolicy attributes, Promise.all or bounded concurrency loop)
  - [ ] At the top of the handler body: `const runId = context.getString("__runId", "unknown")`
  - [ ] After branch list is built: `options.eventBus?.emit("graph:parallel-started", { runId, nodeId: node.id, branchCount: branches.length, maxParallel: options.maxParallel ?? branches.length, policy: options.joinPolicy ?? "wait_all" })`
  - [ ] Before launching each branch: `options.eventBus?.emit("graph:parallel-branch-started", { runId, nodeId: node.id, branchIndex: i })`
  - [ ] After each branch Promise settles: record `const durationMs = Date.now() - branchStart`; emit `graph:parallel-branch-completed` with `{ runId, nodeId: node.id, branchIndex: i, status: normalizeStatus(result.status), durationMs }` where `normalizeStatus` converts `OutcomeStatus` → `StageStatus` using the same helper already present in the codebase
  - [ ] After all branches are settled and join policy is resolved: emit `graph:parallel-completed` with `{ runId, nodeId: node.id, completedCount, cancelledCount, policy: ... }` derived from branch results
  - [ ] All emissions use `options.eventBus?.emit(...)` with optional chaining — no-op when absent

- [ ] Task 5: Emit subgraph lifecycle events in `packages/factory/src/handlers/subgraph.ts` (AC: #2)
  - [ ] Read the file to confirm existing structure from Story 50-5 (resolvedPath, depth check, graphFileLoader, sub-executor creation, contextUpdates merge)
  - [ ] At the top of the handler body: `const runId = context.getString("__runId", "unknown")`
  - [ ] After `resolvedPath` is computed and before sub-executor runs: record `const subgraphStart = Date.now()`; emit `graph:subgraph-started` with `{ runId, nodeId: node.id, graphFile: resolvedPath, depth: currentDepth }`
  - [ ] When creating the sub-executor config: include `eventBus: options.eventBus` so that nested events (node-started, node-completed, etc.) also flow through the parent bus; include `runId: options.runId` for correlation
  - [ ] After sub-executor `run()` returns: `const durationMs = Date.now() - subgraphStart`; emit `graph:subgraph-completed` with `{ runId, nodeId: node.id, graphFile: resolvedPath, depth: currentDepth, status: normalizeStatus(subOutcome.status), durationMs }`
  - [ ] Emit `graph:subgraph-completed` on the failure path as well (inside the catch block or failure branch), so the event is always paired with `graph:subgraph-started`

- [ ] Task 6: Emit LLM edge evaluation event in `packages/factory/src/graph/edge-selector.ts` (AC: #3)
  - [ ] Read the LLM evaluation path in `selectEdge()` (from Story 50-4) to find where `evaluateLlmCondition()` is called and where the error path sets the fallback `false`
  - [ ] After the `try` block: `options?.eventBus?.emit("graph:llm-edge-evaluated", { runId: options.runId ?? "unknown", nodeId: node.id, question: extractLlmQuestion(edge.condition), result: evaluationResult })`
  - [ ] In the `catch` block (error fallback): emit the same `graph:llm-edge-evaluated` event with `result: false` before continuing (so every LLM call attempt, including failed ones, is counted)
  - [ ] Verify that `node.id` is accessible at the point of emission; if not, pass the node reference through the existing closure

- [ ] Task 7: Write unit tests for event emission (AC: #7)
  - [ ] Create `packages/factory/src/handlers/__tests__/parallel-events.test.ts`:
    - Build a `mockEventBus = { emit: vi.fn() }` and pass it via `createParallelHandler({ ..., eventBus: mockEventBus })`
    - Provide 2 mock branches that resolve immediately with `{ status: "SUCCESS" }`
    - Test: `graph:parallel-started` called once with `branchCount: 2`
    - Test: `graph:parallel-branch-started` called twice (once per branch)
    - Test: `graph:parallel-branch-completed` called twice, each with `durationMs >= 0`
    - Test: `graph:parallel-completed` called once with `completedCount: 2, cancelledCount: 0`
    - Test: with no `eventBus` in options, execution succeeds without TypeError
  - [ ] Create `packages/factory/src/handlers/__tests__/subgraph-events.test.ts`:
    - Provide a mock `graphFileLoader` returning a minimal valid DOT graph string (one start node, one exit node)
    - Provide a mock sub-executor `run()` that resolves with `{ status: "SUCCESS", contextUpdates: {} }`
    - Test: `graph:subgraph-started` emitted with correct `graphFile` and `depth: 0`
    - Test: `graph:subgraph-completed` emitted with `status` matching mock outcome and `durationMs >= 0`
    - Test: with no `eventBus`, execution succeeds without TypeError
  - [ ] Create `packages/factory/src/graph/__tests__/edge-selector-events.test.ts`:
    - Extend the async `selectEdge` test pattern from Story 50-4 — add `eventBus: { emit: vi.fn() }` and `runId: "test-run"` to `SelectEdgeOptions`
    - Test: LLM condition evaluates `true` → `graph:llm-edge-evaluated` emitted with `result: true`
    - Test: LLM condition evaluates `false` → `graph:llm-edge-evaluated` emitted with `result: false`
    - Test: LLM call throws → `graph:llm-edge-evaluated` still emitted with `result: false`
    - Test: no `eventBus` in options → `selectEdge` still works without TypeError
  - [ ] Run `npm run build` then `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line with zero failures; NEVER pipe output

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): e.g., `import { ... } from './types.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- New event entries in `FactoryEvents` are **additions only** — do NOT alter, rename, or reorder any existing event type or payload field
- Handler signatures `(node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>` MUST NOT change — `eventBus` is captured in the handler closure via factory options, not passed as a fourth argument
- `eventBus` in handler options MUST use the exact same TypeScript type as `GraphExecutorConfig.eventBus` — read it from `packages/factory/src/graph/types.ts` before writing; do NOT introduce a new event emitter type
- Use `vitest` (`describe`, `it`, `expect`, `vi`) — no Jest globals
- Test files live in `__tests__/` subdirectory co-located with source, using `*.test.ts` naming
- **Do NOT remove or rename existing fields** on `ParallelHandlerOptions`, `SubgraphHandlerOptions`, or `SelectEdgeOptions` — only append new optional fields

### New File Paths
```
packages/factory/src/handlers/__tests__/parallel-events.test.ts    — parallel lifecycle event tests (≥5 cases)
packages/factory/src/handlers/__tests__/subgraph-events.test.ts    — subgraph lifecycle event tests (≥3 cases)
packages/factory/src/graph/__tests__/edge-selector-events.test.ts  — LLM edge event tests (≥4 cases)
```

### Modified File Paths
```
packages/factory/src/events.ts                        — add 7 new event types to FactoryEvents interface
packages/factory/src/handlers/types.ts                — add eventBus? + runId? to ParallelHandlerOptions and SubgraphHandlerOptions
packages/factory/src/handlers/registry.ts             — add eventBus? + runId? to DefaultRegistryOptions; pass through to handler factories
packages/factory/src/graph/edge-selector.ts           — add eventBus? + runId? to SelectEdgeOptions; emit graph:llm-edge-evaluated
packages/factory/src/graph/executor.ts                — set context["__runId"] at run() start; pass eventBus+runId to selectEdge() call sites
packages/factory/src/handlers/parallel.ts             — emit 4 parallel lifecycle events via options.eventBus
packages/factory/src/handlers/subgraph.ts             — emit 2 subgraph lifecycle events; pass eventBus to sub-executor config
```

### Key Event Payload Types

```typescript
// Additions to FactoryEvents in packages/factory/src/events.ts

'graph:parallel-started': {
  runId: string
  nodeId: string
  branchCount: number
  maxParallel: number
  policy: string          // 'wait_all' | 'first_success' | 'quorum'
}

'graph:parallel-branch-started': {
  runId: string
  nodeId: string          // id of the parallel node, not the branch sub-node
  branchIndex: number     // 0-based index of the branch
}

'graph:parallel-branch-completed': {
  runId: string
  nodeId: string
  branchIndex: number
  status: StageStatus     // normalized from OutcomeStatus
  durationMs: number      // wall-clock time for this branch
}

'graph:parallel-completed': {
  runId: string
  nodeId: string
  completedCount: number  // branches that reached SUCCESS or PARTIAL_SUCCESS
  cancelledCount: number  // branches cancelled by first_success / quorum policy
  policy: string
}

'graph:subgraph-started': {
  runId: string
  nodeId: string          // id of the subgraph node in the parent graph
  graphFile: string       // resolved absolute path to the .dot file
  depth: number           // current nesting depth (0 = top-level subgraph)
}

'graph:subgraph-completed': {
  runId: string
  nodeId: string
  graphFile: string
  depth: number
  status: StageStatus     // normalized outcome of the sub-executor run
  durationMs: number
}

'graph:llm-edge-evaluated': {
  runId: string
  nodeId: string          // id of the node whose outgoing edges are being evaluated
  question: string        // extracted question text (after stripping "llm:" prefix)
  result: boolean         // true = affirmative / false = negative or error fallback
}
```

### RunId Context Key
The executor writes `config.runId` to context using the well-known key `"__runId"` at the start of `run()`:

```typescript
// In executor.ts, after context is created and before first node dispatch:
context.set("__runId", config.runId ?? "unknown")
```

Handlers read it as:
```typescript
const runId = context.getString("__runId", "unknown")
```

### EventBus Type Discovery
Before adding `eventBus?` to any interface, run:
```
grep -n "eventBus" packages/factory/src/graph/types.ts
```
Use the exact resolved TypeScript type from `GraphExecutorConfig.eventBus` (not a re-declared interface). This ensures handlers remain assignment-compatible with executor configs without extra casting.

### SelectEdgeOptions Extension (Story 50-4 Compatibility)
```typescript
// packages/factory/src/graph/edge-selector.ts — extend existing interface only
export interface SelectEdgeOptions {
  llmCall?: (prompt: string) => Promise<string>    // existing — do NOT remove
  eventBus?: GraphExecutorConfig['eventBus']        // new
  runId?: string                                    // new
}
```

### Executor selectEdge Call Site Update
```typescript
// All three await selectEdge() sites in executor.ts become:
const edge = await selectEdge(currentNode, outcome as unknown as GraphOutcome, context, graph, {
  llmCall: /* existing binding or omit if not set */,
  eventBus: config.eventBus,
  runId: config.runId,
})
```

Read the actual existing call sites first (`grep -n "selectEdge" packages/factory/src/graph/executor.ts`) to confirm the exact argument pattern, then add `eventBus` and `runId` to the options object already being passed (or create the options object if absent from earlier stories).

### Status Normalization
Both `parallel.ts` and `subgraph.ts` need to convert `OutcomeStatus` → `StageStatus` for event payloads. Check whether a `normalizeOutcomeStatus()` or `denormalizeStatus()` helper already exists in the codebase (it was referenced in Story 50-5's notes for the reverse direction):
```
grep -rn "normalizeOutcomeStatus\|normalizeStatus\|denormalizeStatus" packages/factory/src/
```
Reuse whichever helper is available, or add a trivial local mapping if none exists.

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect`, `vi`
- Mock eventBus as `{ emit: vi.fn() }` — assert via `expect(mockBus.emit).toHaveBeenCalledWith("event:type", expect.objectContaining({ ... }))`
- Do NOT mock `@substrate-ai/core` or the full executor — inject controlled branches / sub-executor via handler options
- For `subgraph-events.test.ts`: provide a mock `graphFileLoader` returning `'digraph G { start [type="start"]; exit [type="exit"]; start -> exit; }'` and a mock sub-executor (override the factory with `vi.fn()` returning a SUCCESS outcome)
- Run `npm run build` first (catches any TypeScript errors in new event types or interface changes); then `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line; NEVER pipe output

## Interface Contracts

- **Import**: `ParallelHandlerOptions` @ `packages/factory/src/handlers/types.ts` (from story 50-1) — add `eventBus?` and `runId?`
- **Import**: `SubgraphHandlerOptions` @ `packages/factory/src/handlers/types.ts` (from story 50-5) — add `eventBus?` and `runId?`
- **Import**: `SelectEdgeOptions` @ `packages/factory/src/graph/edge-selector.ts` (from story 50-4) — add `eventBus?` and `runId?`
- **Import**: `DefaultRegistryOptions` @ `packages/factory/src/handlers/registry.ts` (from story 50-6) — add `eventBus?` and `runId?`
- **Export**: Updated `FactoryEvents` with 7 new event types @ `packages/factory/src/events.ts` (consumed by story 50-11, 50-12)
- **Export**: Updated `SelectEdgeOptions` with `eventBus?` and `runId?` @ `packages/factory/src/graph/edge-selector.ts` (consumed by story 50-11)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
