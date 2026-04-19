# Story 50-1: Parallel Handler — Fan-Out with Isolated Contexts

## Story

As a pipeline author,
I want to execute multiple independent graph branches concurrently in a single pipeline run,
so that parallel workstreams (e.g., competing implementations or simultaneous analyses) can run simultaneously without context interference.

## Acceptance Criteria

### AC1: Concurrent Branch Execution
**Given** a `parallel` node (shape=component) with 3 outgoing edges to branch nodes
**When** the parallel handler executes
**Then** it clones the current context for each branch, executes all 3 branch nodes concurrently via the handler registry, and returns SUCCESS once all branches complete

### AC2: Bounded Parallelism via `maxParallel`
**Given** a parallel node with attribute `maxParallel=2` and 3 outgoing branch edges
**When** the parallel handler executes
**Then** at most 2 branches execute concurrently at any point, with the third waiting until a slot becomes free

### AC3: Context Isolation Between Branches
**Given** a parallel node with 2 branches where branch A's handler sets `context.set("output", "A")` and branch B's handler sets `context.set("output", "B")`
**When** the parallel handler executes both branches concurrently
**Then** each branch's context mutations remain isolated — the parent context's `"output"` key is unaffected by either branch, and the `contextSnapshot` in each branch's result contains only that branch's independent mutations

### AC4: Results Stored in `parallel.results`
**Given** a parallel node with 3 outgoing branches that each return a SUCCESS or FAIL outcome
**When** the parallel handler completes
**Then** the outcome's `contextUpdates` contains `"parallel.results"` as an array of `ParallelBranchResult` objects, each with `nodeId`, `status`, `contextSnapshot`, and optional `failureReason`

### AC5: `wait_all` Join Policy — All Branches Complete Before Return
**Given** a parallel node with `joinPolicy="wait_all"` (or no joinPolicy set) and 3 branches where 1 branch returns FAIL
**When** the parallel handler executes
**Then** the handler waits for all 3 branches to complete (including the failing one) before returning, and returns SUCCESS with all 3 results captured in `parallel.results`

### AC6: `GraphNode` Extended with Parallel Attributes
**Given** a DOT node definition `node [shape=component, maxParallel=2, joinPolicy="wait_all"]`
**When** the graph is parsed via `parseGraph()`
**Then** the resulting `GraphNode` has `maxParallel === 2` and `joinPolicy === "wait_all"`

### AC7: Parallel Handler Registered in Default Registry
**Given** the default handler registry is created via `createDefaultRegistry()`
**When** the registry resolves a node with `type="parallel"` or `shape="component"`
**Then** the parallel handler function is returned

## Tasks / Subtasks

- [ ] Task 1: Extend `GraphNode` type and parser with parallel-specific attributes (AC: #6)
  - [ ] Add `maxParallel?: number` field to `GraphNode` interface in `packages/factory/src/graph/types.ts`
  - [ ] Add `joinPolicy?: string` field to `GraphNode` interface in `packages/factory/src/graph/types.ts`
  - [ ] Update DOT parser (likely `packages/factory/src/graph/parser.ts`) to extract `maxParallel` (as integer) and `joinPolicy` (as string) from DOT node attributes — follow the same extraction pattern as `maxRetries`, `toolCommand`, and `backend`
  - [ ] Add `maxParallel: 0` and `joinPolicy: ''` to the `makeNode()` test helper in handler unit test files to keep tests compiling

- [ ] Task 2: Define `ParallelBranchResult` interface and `ParallelHandlerOptions` type (AC: #4)
  - [ ] Add to `packages/factory/src/handlers/types.ts`:
    ```typescript
    /** Result of a single branch execution inside a parallel node. */
    export interface ParallelBranchResult {
      /** The branch start node ID (outgoing edge target from parallel node). */
      nodeId: string
      /** Outcome status returned by the branch handler. */
      status: string
      /** Snapshot of the branch's isolated context after execution. */
      contextSnapshot: Record<string, unknown>
      /** Populated when status is 'FAIL' or 'FAILURE'. */
      failureReason?: string
    }

    /** Options for the parallel handler factory function. */
    export interface ParallelHandlerOptions {
      /** Registry used to resolve and invoke branch node handlers. */
      handlerRegistry: IHandlerRegistry
    }
    ```
  - [ ] Export both types from `packages/factory/src/handlers/index.ts`

- [ ] Task 3: Implement `createParallelHandler()` core logic — cloning and execution (AC: #1, #3, #4)
  - [ ] Create `packages/factory/src/handlers/parallel.ts`
  - [ ] Implement `export function createParallelHandler(options: ParallelHandlerOptions): NodeHandler`
  - [ ] Use `graph.outgoingEdges(node.id)` to identify branch target node IDs (use `edge.toNode` field)
  - [ ] For each branch node: call `context.clone()` to produce a fully independent `IGraphContext`
  - [ ] Resolve each branch node's handler via `options.handlerRegistry.resolve(branchNode)` and invoke it with the cloned context
  - [ ] Collect a `ParallelBranchResult` for each completed branch (status from outcome, `contextSnapshot` from `branchCtx.snapshot()`, `failureReason` if applicable)
  - [ ] Return `{ status: 'SUCCESS', contextUpdates: { 'parallel.results': results } }`

- [ ] Task 4: Implement bounded concurrency semaphore for `maxParallel` (AC: #2)
  - [ ] Inside `parallel.ts`, implement a local `runWithConcurrencyLimit` helper:
    ```typescript
    async function runWithConcurrencyLimit<T>(
      tasks: Array<() => Promise<T>>,
      limit: number,
    ): Promise<T[]> {
      const results: Array<T> = new Array(tasks.length)
      const executing = new Set<Promise<void>>()
      for (let i = 0; i < tasks.length; i++) {
        const idx = i
        const p = tasks[idx]().then((r) => { results[idx] = r }).finally(() => executing.delete(p))
        executing.add(p)
        if (executing.size >= limit) await Promise.race(executing)
      }
      await Promise.all(executing)
      return results
    }
    ```
  - [ ] Read `node.maxParallel ?? 0`; when `> 0`, use `runWithConcurrencyLimit`; when `0`, use `Promise.allSettled` directly (unlimited concurrency)

- [ ] Task 5: Implement `wait_all` join policy (AC: #5)
  - [ ] Default join policy is `"wait_all"` when `node.joinPolicy` is absent or empty
  - [ ] For `"wait_all"`: use `Promise.allSettled`-semantics so all branches run to completion regardless of individual failures
  - [ ] Individual branch failures are captured in `ParallelBranchResult.status` / `failureReason` — the parallel handler itself returns `SUCCESS` (meaning "all branches executed, results ready for fan-in")
  - [ ] Add a `// TODO(story 50-3): add first_success and quorum join policies` comment in `parallel.ts` where future policies would branch

- [ ] Task 6: Register handler and shape mapping in default registry (AC: #7)
  - [ ] In `packages/factory/src/handlers/registry.ts`, inside `createDefaultRegistry()`:
    - Add `registry.register('parallel', createParallelHandler({ handlerRegistry: registry }))` **before** other handlers are registered (safe: handler only calls `resolve()` at invocation time, not registration time)
    - Add `registry.registerShape('component', 'parallel')`
  - [ ] Export `createParallelHandler` and `ParallelHandlerOptions` from `packages/factory/src/handlers/index.ts`

- [ ] Task 7: Write unit tests for parallel handler (AC: #1–#7)
  - [ ] Create `packages/factory/src/handlers/__tests__/parallel-handler.test.ts`
  - [ ] Build test helpers: `makeParallelNode(overrides?)`, `makeGraph(nodeIds, parallelNodeId)` that returns a stub `Graph` whose `outgoingEdges(id)` returns edges to branch nodes
  - [ ] AC1 test: Mock 3 branch handlers (vi.fn() returning SUCCESS), assert all 3 are called, outcome status is SUCCESS
  - [ ] AC2 test: Use `maxParallel=2` with 3 branches that each take ~5ms; track max concurrent executions with a shared counter; assert counter never exceeds 2
  - [ ] AC3 test: Branch A handler sets `ctx.set("key", "A")`; branch B sets `ctx.set("key", "B")`; assert parent context's `"key"` is unaffected after handler returns; assert each branch result's `contextSnapshot.key` equals its own value only
  - [ ] AC4 test: Assert `outcome.contextUpdates["parallel.results"]` is an array of length 3, each element has `nodeId`, `status`, `contextSnapshot`
  - [ ] AC5 test: One of 3 branches returns `{ status: 'FAIL', failureReason: 'oops' }`; assert handler still returns SUCCESS; assert failing branch result has `status: 'FAIL'` and `failureReason: 'oops'` in `parallel.results`
  - [ ] AC7 test: Assert `createDefaultRegistry().resolve({ type: 'parallel', ... })` does not throw and returns a function

## Dev Notes

### Architecture Constraints

- **New file**: `packages/factory/src/handlers/parallel.ts`
- **Modified files**:
  - `packages/factory/src/graph/types.ts` — add `maxParallel?: number` and `joinPolicy?: string` to `GraphNode`
  - `packages/factory/src/graph/parser.ts` — extract new DOT attributes into `GraphNode` fields
  - `packages/factory/src/handlers/types.ts` — add `ParallelBranchResult` and `ParallelHandlerOptions`
  - `packages/factory/src/handlers/registry.ts` — register `parallel` handler and `component` shape
  - `packages/factory/src/handlers/index.ts` — export new types and factory function
- **Handler signature** (must match exactly): `(node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>` from `packages/factory/src/handlers/types.ts`
- **Outgoing edge access**: Use `graph.outgoingEdges(node.id)` — returns `GraphEdge[]` with `toNode` field. Do NOT filter `graph.edges` manually.
- **Context cloning**: `context.clone()` returns a fully independent `IGraphContext` backed by a separate `Map` — mutations in a cloned context never propagate to the parent or siblings
- **No external concurrency libraries**: Implement the semaphore inline in `parallel.ts`; keep the implementation self-contained with zero new npm deps

### Circular Registry Reference — Safe Pattern
Passing the registry to `createParallelHandler` before all handlers are registered is safe because the parallel handler only calls `options.handlerRegistry.resolve()` at handler *invocation* time (when a pipeline actually runs), not at factory/registration time:

```typescript
export function createDefaultRegistry(options?: CodergenHandlerOptions): HandlerRegistry {
  const registry = new HandlerRegistry()
  // Pass registry reference — safe because resolve() is only called at invocation time
  registry.register('parallel', createParallelHandler({ handlerRegistry: registry }))
  registry.register('start', startHandler)
  // ... remaining registrations
  return registry
}
```

### `parallel.ts` Implementation Skeleton

```typescript
import type { NodeHandler } from './types.js'
import type { ParallelBranchResult, ParallelHandlerOptions } from './types.js'
import type { Graph, GraphNode, IGraphContext } from '../graph/types.js'

export function createParallelHandler(options: ParallelHandlerOptions): NodeHandler {
  return async (node: GraphNode, context: IGraphContext, graph: Graph) => {
    const branchEdges = graph.outgoingEdges(node.id)
    const maxParallel = node.maxParallel ?? 0

    const tasks = branchEdges.map((edge) => async (): Promise<ParallelBranchResult> => {
      const branchNode = graph.nodes.get(edge.toNode)
      if (!branchNode) {
        return { nodeId: edge.toNode, status: 'FAIL', contextSnapshot: {}, failureReason: `Branch node "${edge.toNode}" not found in graph` }
      }
      const branchCtx = context.clone()
      const handler = options.handlerRegistry.resolve(branchNode)
      let outcome: Awaited<ReturnType<NodeHandler>>
      try {
        outcome = await handler(branchNode, branchCtx, graph)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { nodeId: branchNode.id, status: 'FAIL', contextSnapshot: branchCtx.snapshot(), failureReason: msg }
      }
      return {
        nodeId: branchNode.id,
        status: outcome.status,
        contextSnapshot: branchCtx.snapshot(),
        failureReason: outcome.failureReason,
      }
    })

    const results = maxParallel > 0
      ? await runWithConcurrencyLimit(tasks, maxParallel)
      : await Promise.all(tasks.map((t) => t()))

    return {
      status: 'SUCCESS',
      contextUpdates: { 'parallel.results': results },
    }
  }
}
```

### `GraphNode` Attribute Extraction in Parser
Find where the parser extracts fields like `maxRetries` (likely reads from a DOT attribute map). Follow the exact same pattern for `maxParallel` and `joinPolicy`:
- `maxParallel`: parse as integer — `parseInt(attrs['maxParallel'] ?? '0', 10)` or similar
- `joinPolicy`: read as string — `attrs['joinPolicy'] ?? ''`

### Testing Requirements
- **Test file**: `packages/factory/src/handlers/__tests__/parallel-handler.test.ts`
- **Graph stub pattern**: Build a minimal object matching the `Graph` interface — implement `outgoingEdges(id)` as a function that returns the test's pre-defined edges; use `nodes` as a `Map<string, GraphNode>`
- **Concurrency test**: A shared `let concurrent = 0; let maxObserved = 0` counter incremented/decremented inside mock handlers proves `maxParallel` is enforced — no wall-clock timing needed
- **Run after implementation**: `npm run test:fast` (unit tests, ~50s); confirm "Test Files" appears in output with no failures

## Interface Contracts

- **Export**: `ParallelBranchResult` @ `packages/factory/src/handlers/types.ts` — consumed by story 50-2 (fan-in handler reads `parallel.results` and expects this shape)
- **Export**: `ParallelHandlerOptions` @ `packages/factory/src/handlers/types.ts` — consumed by registry wiring

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
