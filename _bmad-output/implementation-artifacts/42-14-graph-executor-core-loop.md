# Story 42-14: Graph Executor Core Loop

## Story

As a graph engine developer,
I want a graph executor that drives end-to-end traversal of a factory graph by dispatching handlers, applying retry logic, writing checkpoints, selecting edges, and emitting events,
so that any valid DOT graph can run from start node to exit node (or resume from a checkpoint) with full observability and fault tolerance.

## Acceptance Criteria

### AC1: Basic 3-Node Graph Traversal
**Given** a valid 3-node graph (`start → codergen → exit`) with a mock `IHandlerRegistry` that returns instant-SUCCESS handlers for all nodes
**When** `executor.run(graph, config)` is awaited
**Then** the executor resolves start, dispatches each handler in traversal order, writes a checkpoint after each node, selects the outgoing edge, advances to exit, and returns a final `Outcome` with `status: 'SUCCESS'`

### AC2: Handler Exceptions Converted to FAIL Outcome
**Given** the executor and a node whose handler throws an unexpected runtime exception (any `Error`)
**When** the executor dispatches that node
**Then** the exception is caught, converted into an `Outcome` with `status: 'FAIL'` and `failureReason` set to the error message, and execution continues to edge selection (which may route to a retry or fallback target)

### AC3: Retry with Exponential Backoff
**Given** a node with `max_retries=2` (3 total attempts) whose handler returns `{ status: 'FAIL' }` on every invocation
**When** the executor runs that node
**Then** it retries up to 2 additional times using exponential backoff: base delay 200ms, factor 2×, cap 60,000ms, jitter ±50% of computed delay; the per-node retry counter stored in `nodeRetries` increments on each attempt; after all retries are exhausted the final FAIL outcome is passed to edge selection

### AC4: Checkpoint Written After Each Node, Resume from Checkpoint
**Given** an executor in a normal run
**When** each node completes (success or final failure after retries)
**Then** `checkpointManager.save(logsRoot, params)` is called with the current `currentNode`, `completedNodes`, `nodeRetries`, and `context` before advancing; additionally, when `config.checkpointPath` is provided, the executor loads and resumes from that checkpoint, skipping already-completed nodes and applying `ResumeState.firstResumedNodeFidelity` to the first resumed node

### AC5: Six FactoryEvents Emitted at the Correct Points
**Given** a `TypedEventBus<FactoryEvents>` passed in `config.eventBus`
**When** execution proceeds
**Then** these events are emitted with exact payloads (all including `runId: config.runId`):
  - `graph:node-started` — before handler invocation: `{ runId, nodeId, nodeType }`
  - `graph:node-retried` — before each retry attempt: `{ runId, nodeId, attempt, maxAttempts, delayMs }`
  - `graph:node-completed` — after successful outcome: `{ runId, nodeId, outcome }`
  - `graph:node-failed` — after final FAIL outcome (post-retries): `{ runId, nodeId, failureReason }`
  - `graph:edge-selected` — after edge selection: `{ runId, fromNode, toNode, step, edgeLabel? }`
  - `graph:checkpoint-saved` — after each checkpoint write: `{ runId, nodeId, checkpointPath }`

### AC6: Per-Node Transition Overhead Under 100ms
**Given** a 20-node linear graph with instant-return mock handlers (no `await` delay, no I/O)
**When** executor traversal overhead is measured (time for one full run minus handler wall-clock time)
**Then** the average per-node transition time is under 100ms (total overhead ÷ 20 nodes)

### AC7: All Unit Tests Pass
**Given** the executor implementation
**When** `npm run test:fast` is run
**Then** all unit tests for this story pass and the "Test Files" summary line appears in output

## Tasks / Subtasks

- [ ] Task 1: Define `GraphExecutorConfig`, scaffold `executor.ts`, and update barrel exports (AC: #1, #5)
  - [ ] Create `packages/factory/src/graph/executor.ts`
  - [ ] Define and export `GraphExecutorConfig` interface:
    ```ts
    export interface GraphExecutorConfig {
      /** Unique identifier for this run — included in every emitted event */
      runId: string
      /** Directory where checkpoint.json and node log subdirs are written */
      logsRoot: string
      /** Handler registry used to resolve node type → handler function */
      handlerRegistry: IHandlerRegistry
      /** Typed event bus for emitting graph:* events */
      eventBus: TypedEventBus<FactoryEvents>
      /**
       * If provided, the executor loads this checkpoint file and resumes
       * from the last completed node rather than starting at the start node.
       */
      checkpointPath?: string
    }
    ```
  - [ ] Define and export `createGraphExecutor(): GraphExecutor` factory where `GraphExecutor` is `{ run(graph: Graph, config: GraphExecutorConfig): Promise<Outcome> }`
  - [ ] Import `Graph`, `GraphNode`, `GraphEdge`, `IGraphContext`, `Outcome`, `Checkpoint`, `ResumeState` from `'./types.js'`
  - [ ] Import `GraphContext` from `'./context.js'`
  - [ ] Import `selectEdge` from `'./edge-selector.js'`
  - [ ] Import `CheckpointManager` from `'./checkpoint.js'`
  - [ ] Import `IHandlerRegistry` from `'../handlers/types.js'`
  - [ ] Import `TypedEventBus` from `'@substrate-ai/core'`
  - [ ] Import `FactoryEvents` from `'../events.js'`
  - [ ] Update `packages/factory/src/graph/index.ts` to re-export `createGraphExecutor`, `GraphExecutorConfig`, and `GraphExecutor` from `'./executor.js'`

- [ ] Task 2: Implement core traversal loop with handler dispatch and exception handling (AC: #1, #2)
  - [ ] Implement `run(graph, config)`:
    - Instantiate a `CheckpointManager`
    - Determine starting node: `graph.startNode()` (or resume node from checkpoint — Task 4)
    - Initialize `completedNodes: string[] = []`, `nodeRetries: Record<string, number> = {}`, `context: IGraphContext = new GraphContext()`
    - Enter `while` loop: check if current node is exit (`graph.exitNode().id`); if so, break and return `{ status: 'SUCCESS' }`
    - Resolve handler: `config.handlerRegistry.resolve(currentNode)`
    - Dispatch handler (see Task 3 for retry wrapper)
    - Apply `outcome.contextUpdates` to context via `context.set(key, value)` for each entry
    - Push `currentNode.id` to `completedNodes`
    - Write checkpoint (Task 4)
    - Select next edge: `const edge = selectEdge(currentNode, outcome, context, graph)`
    - If `edge === null`: return `{ status: 'FAIL', failureReason: 'No outgoing edge from node ${currentNode.id}' }`
    - Handle `edge.loopRestart === true`: advance to `edge.toNode` but **do not push** to `completedNodes` on next iteration (treat as a fresh re-entry)
    - Advance: `currentNode = graph.nodes.get(edge.toNode)` (throw if node not found)
  - [ ] Exception handling: wrap handler invocation in try/catch; catch converts to `Outcome = { status: 'FAIL', failureReason: err.message ?? String(err) }`
  - [ ] Emit `graph:node-started` before dispatch; emit `graph:edge-selected` after edge selection (use loop iteration counter as `step`, include `edge.label` as `edgeLabel` if non-empty)

- [ ] Task 3: Implement retry loop with exponential backoff (AC: #3)
  - [ ] Extract `dispatchWithRetry(node, context, graph, config, nodeRetries, checkpointManager)` helper function
  - [ ] Implement `computeBackoffDelay(attempt: number): number`:
    - `rawDelay = Math.min(200 * Math.pow(2, attempt), 60_000)`
    - `jitter = rawDelay * 0.5 * (2 * Math.random() - 1)` — ±50% of rawDelay
    - Return `Math.max(0, rawDelay + jitter)` (floor at 0)
  - [ ] Retry loop:
    - `const maxRetries = node.maxRetries ?? 0` (read attribute; default 0 = no retry)
    - `let attempt = 0`; `const maxAttempts = maxRetries + 1`
    - Loop: resolve handler, dispatch (with exception catch), check outcome
    - If outcome is FAIL and `attempt < maxRetries`: increment `nodeRetries[node.id]`, compute delay, emit `graph:node-retried` with `{ attempt: attempt + 1, maxAttempts, delayMs }`, await delay, increment `attempt`, continue
    - Otherwise: break and return outcome
  - [ ] Emit `graph:node-completed` when outcome is not FAIL; emit `graph:node-failed` when final outcome is FAIL (after exhausting retries)

- [ ] Task 4: Integrate `CheckpointManager` — save after each node and resume from checkpoint (AC: #4)
  - [ ] **Save path** (called from core loop after each node):
    - Call `await checkpointManager.save(config.logsRoot, { currentNode: node.id, completedNodes, nodeRetries, context })`
    - Emit `graph:checkpoint-saved` with `{ runId, nodeId: node.id, checkpointPath: path.join(config.logsRoot, 'checkpoint.json') }`
  - [ ] **Resume path** (before entering the loop):
    - If `config.checkpointPath` is set: `const checkpoint = await checkpointManager.load(config.checkpointPath)`; `const resumeState = checkpointManager.resume(graph, checkpoint)`
    - Seed execution state: `context = resumeState.context`, `completedNodes = [...resumeState.completedNodes]`, `nodeRetries = resumeState.nodeRetries`
    - Set `currentNode` to the node after the checkpoint's `currentNode` by finding its first outgoing edge target; or stay at `currentNode` if it was not yet completed
    - Track `firstResumedNodeFidelity = resumeState.firstResumedNodeFidelity` — override the first non-skipped node's `fidelity` attribute in the loop (mutate a local copy of the node or pass fidelity override to handler separately)
    - Skip nodes already in `completedNodes` set by checking `if (resumeState.completedNodes.has(currentNode.id))` and advancing via edge selection without dispatching

- [ ] Task 5: Validate build and run test:fast (AC: #7)
  - [ ] Run `npm run build` from repo root; confirm zero TypeScript errors before writing tests
  - [ ] Fix any type errors in `executor.ts` (missing properties, wrong imports, etc.)
  - [ ] Verify `packages/factory/src/graph/index.ts` barrel exports compile without circular deps

- [ ] Task 6: Write unit tests for the executor (AC: #1–#6, #7)
  - [ ] Create `packages/factory/src/graph/__tests__/executor.test.ts`
  - [ ] Import `describe, it, expect, vi, beforeEach, afterEach` from `'vitest'`
  - [ ] Build a minimal 3-node graph stub conforming to the `Graph` interface (use the same pattern as 42-13 tests)
  - [ ] Mock `IHandlerRegistry.resolve()` to return a spy handler; mock `TypedEventBus` with `vi.fn()` for `emit`; mock `CheckpointManager.save` and `CheckpointManager.load`
  - [ ] **AC1 test**: run 3-node graph, assert final outcome `status === 'SUCCESS'`; assert `emit` was called with `'graph:node-started'` once per node and `'graph:checkpoint-saved'` once per node
  - [ ] **AC2 test**: handler throws `new Error('boom')`; assert `dispatchWithRetry` returns `{ status: 'FAIL', failureReason: 'boom' }`; assert no retry attempted (node has default `max_retries=0`)
  - [ ] **AC3 test**: handler always returns `{ status: 'FAIL' }`; node has `max_retries=2`; mock `setTimeout`/delay using `vi.useFakeTimers()`; assert handler was called 3 times; assert `'graph:node-retried'` was emitted twice; assert final outcome is FAIL
  - [ ] **AC4 test (save)**: verify `CheckpointManager.save` is called once per node with correct `currentNode` and `completedNodes`
  - [ ] **AC4 test (resume)**: provide `checkpointPath` pointing to a valid checkpoint; verify executor skips nodes in `completedNodes` and starts dispatching from the resumed node
  - [ ] **AC5 test**: spy on all 6 event types; run a 2-node graph (start → exit); verify `graph:node-started` fires for each node with correct payload; verify `graph:edge-selected` fires with `runId` and valid `toNode`
  - [ ] **AC6 perf test**: build a 20-node linear graph (node0 → node1 → ... → node19); all handlers are `async () => ({ status: 'SUCCESS' })`; measure `Date.now()` before and after `run()`; compute `(elapsed - 0) / 20`; `expect(avgPerNode).toBeLessThan(100)` — note: 0ms handler time means elapsed ≈ overhead only
  - [ ] Run `pgrep -f vitest` first; run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" in output

- [ ] Task 7: Edge case handling and loop safety (AC: #1, #2)
  - [ ] Guard against infinite loops: track `visitCount: Map<string, number>`; if any node is visited more than `graph.nodes.size * 3` times, throw `Error('Graph cycle detected: node ${id} visited ${count} times')`; this does NOT apply to `loopRestart` edges which are intentional
  - [ ] Guard against `graph.nodes.get(edge.toNode)` returning `undefined`; throw `Error('Edge target node "${toNode}" not found in graph')` with descriptive message
  - [ ] Handle missing `config.eventBus`: emit calls should be no-ops if `eventBus` is undefined — add null check before all `emit()` calls so callers may omit the bus in tests

## Dev Notes

### Architecture Constraints
- **New files:**
  - `packages/factory/src/graph/executor.ts` — main implementation
  - `packages/factory/src/graph/__tests__/executor.test.ts` — unit tests
- **Modified files:**
  - `packages/factory/src/graph/index.ts` — add barrel exports for `createGraphExecutor`, `GraphExecutorConfig`, `GraphExecutor`
- All relative imports within `packages/factory/src/` must use ESM `.js` extensions (e.g., `import { selectEdge } from './edge-selector.js'`)
- Node built-ins must use the `node:` prefix (e.g., `import path from 'node:path'`)
- TypeScript strict mode — no `any`; `unknown` for error catches only
- No circular dependencies — executor must not be imported by handlers or graph utilities

### Key Consumed APIs (read these files before coding)
- **`selectEdge(node, outcome, context, graph): GraphEdge | null`** — `packages/factory/src/graph/edge-selector.ts`; call with `context` (implements `IGraphContext`); returns the selected `GraphEdge` or `null` if none
- **`CheckpointManager.save(logsRoot, params): Promise<void>`** / **`load(path): Promise<Checkpoint>`** / **`resume(graph, checkpoint): ResumeState`** — `packages/factory/src/graph/checkpoint.ts`; read 42-13 story for exact `CheckpointSaveParams` shape
- **`IHandlerRegistry.resolve(node): NodeHandler`** — `packages/factory/src/handlers/types.ts`; `NodeHandler` is `(node, context, graph) => Promise<Outcome>`
- **`TypedEventBus<FactoryEvents>.emit(event, payload)`** — `@substrate-ai/core`; `FactoryEvents` already defined in `packages/factory/src/events.ts` with exact payload shapes
- **`graph.outgoingEdges(nodeId): GraphEdge[]`** — use this (NOT `graph.edges.filter(...)`) when implementing the resume node-skip logic; also used inside `selectEdge()`

### GraphNode Attribute: maxRetries
Read `packages/factory/src/graph/types.ts` before implementing Task 3. The `GraphNode` interface has a `maxRetries` field (snake_case in DOT, camelCase in TypeScript). Default should be `0` when the attribute is absent (meaning: no retry, one attempt only).

### Checkpoint Path Convention
The checkpoint is always written to `path.join(config.logsRoot, 'checkpoint.json')`. Store this as a constant in `executor.ts` or derive it inline — do not parameterize the filename itself. The `graph:checkpoint-saved` event payload's `checkpointPath` must equal this derived path.

### Event `step` Field in `graph:edge-selected`
The `step` field in `graph:edge-selected` represents the iteration counter of the main traversal loop (0-indexed: start node = step 0, second node = step 1, etc.). It does NOT require changes to the `selectEdge()` API. Track a `let step = 0` counter in the main loop and increment after each successful edge selection.

### Resume: Determining the Resumed Start Node
When resuming from a checkpoint, `checkpoint.currentNode` is the **last completed node** (the node that was executing when the checkpoint was written). The executor should resume from the *next* node — i.e., select the outgoing edge of `checkpoint.currentNode` from the checkpoint's context, then start dispatching from `edge.toNode`.

However, if `checkpoint.currentNode` is not in `checkpoint.completedNodes`, the last run may have been interrupted mid-node — treat it as the resumed start node (re-dispatch it) rather than skipping it.

### Fidelity Override on Resume
`ResumeState.firstResumedNodeFidelity` is a string (e.g., `'summary:high'` or `''`). When non-empty, create a local node copy with the fidelity field overridden for that one dispatch:
```ts
const nodeToDispatch = firstResumedFidelity
  ? { ...currentNode, fidelity: firstResumedFidelity }
  : currentNode
firstResumedFidelity = '' // clear after first use
```
Pass `nodeToDispatch` (not `currentNode`) to the handler for the first resumed node only.

### Testing Strategy
- Use `vi.useFakeTimers()` for retry backoff tests — prevents real 200ms waits in CI
- Mock `CheckpointManager` methods with `vi.fn()` — tests should not write real files
- Build `Graph` stubs using the same pattern documented in 42-13 Dev Notes (minimal conforming object with `nodes: new Map(...)`, `edges: []`, `outgoingEdges()`, `startNode()`, `exitNode()`)
- Keep each test isolated: call `vi.clearAllMocks()` in `beforeEach`

### Testing Requirements
- Test framework: Vitest (`import { describe, it, expect, vi } from 'vitest'`)
- Run: `npm run test:fast` — never pipe output; confirm "Test Files" summary line appears
- Never run tests concurrently: `pgrep -f vitest` must return nothing before starting
- Verify build compiles with `npm run build` before running tests

## Interface Contracts

- **Import**: `Graph`, `GraphNode`, `GraphEdge`, `IGraphContext`, `Outcome`, `Checkpoint`, `ResumeState` @ `packages/factory/src/graph/types.ts` (from stories 42-2, 42-8, 42-13)
- **Import**: `GraphContext` @ `packages/factory/src/graph/context.ts` (from story 42-8)
- **Import**: `selectEdge` @ `packages/factory/src/graph/edge-selector.ts` (from story 42-12)
- **Import**: `CheckpointManager`, `CheckpointSaveParams` @ `packages/factory/src/graph/checkpoint.ts` (from story 42-13)
- **Import**: `IHandlerRegistry`, `NodeHandler` @ `packages/factory/src/handlers/types.ts` (from story 42-9)
- **Import**: `FactoryEvents` @ `packages/factory/src/events.ts` (already defined)
- **Import**: `TypedEventBus` @ `@substrate-ai/core` (core package)
- **Export**: `GraphExecutorConfig`, `GraphExecutor`, `createGraphExecutor` @ `packages/factory/src/graph/executor.ts` — consumed by story 42-15 (integration tests) and story 42-17 (Attractor compliance tests)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
