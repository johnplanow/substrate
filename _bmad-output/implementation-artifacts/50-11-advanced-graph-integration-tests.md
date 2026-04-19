# Story 50-11: Advanced Graph Integration Tests

## Story

As a pipeline developer,
I want a comprehensive integration test suite covering all Epic 50 advanced graph features,
so that I can validate that parallel fan-out/fan-in, LLM-evaluated edges, subgraphs, manager loops, event extensions, and pipeline templates work correctly both individually and in combination.

## Acceptance Criteria

### AC1: Parallel Fan-Out/Fan-In Integration Tests
**Given** a DOT graph with a 3-branch parallel fan-out node, three codergen branches, and a fan-in node with best-candidate selection
**When** the graph executor runs with mock codergen handlers that return different scores per branch
**Then** the pipeline completes with SUCCESS, the fan-in node selects the highest-scoring branch, the winning branch's context updates are present in the final context, and tests cover wait_all, first_success, quorum policies, bounded concurrency, heuristic selection, and context isolation (≥15 `it(...)` cases)

### AC2: LLM-Evaluated Edge Integration Tests
**Given** a DOT graph with outgoing edges including one labeled `llm:` condition from a decision node
**When** the executor runs with mock LLM functions that return affirmative or negative answers
**Then** the correct edge is selected in all cases (affirmative → refine path, negative → forward path, error → fallback `false`), and `graph:llm-edge-evaluated` is emitted for every evaluation attempt including failures (≥12 `it(...)` cases)

### AC3: Subgraph Execution Integration Tests
**Given** a parent DOT graph with a `stack.subgraph` node that references a child DOT graph via a mock `graphFileLoader`
**When** the executor runs the parent graph
**Then** the child graph runs to completion, its outcome merges into the parent context, the parent graph continues to exit, and edge cases are covered: child failure, nested depth, max-depth exceeded, shared runId, and context isolation (≥12 `it(...)` cases)

### AC4: Manager Loop Handler Integration Tests
**Given** a DOT graph with a `stack.manager_loop` node configured with `maxIterations` and a success condition
**When** the loop runs with mock sub-agent handlers
**Then** the loop exits with SUCCESS when the condition is met within the iteration budget, ESCALATE/FAILURE when exhausted, and the iteration count is recorded in context; tests also cover loop detection and steering signal consumption (≥10 `it(...)` cases)

### AC5: Advanced Event Stream Integration Tests
**Given** a combined graph exercising parallel fan-out/fan-in, a subgraph node, and an LLM-evaluated edge, all with an event bus attached
**When** the executor runs end-to-end
**Then** all seven advanced event types (`graph:parallel-started`, `graph:parallel-branch-started`, `graph:parallel-branch-completed`, `graph:parallel-completed`, `graph:subgraph-started`, `graph:subgraph-completed`, `graph:llm-edge-evaluated`) appear in correct causal order, and no existing event types are missing or renamed (≥8 `it(...)` cases)

### AC6: Pipeline Templates Execute End-to-End
**Given** each of the four pipeline templates (`trycycle`, `dual-review`, `parallel-exploration`, `staged-validation`) produced by story 50-10
**When** each template's `dotContent` is parsed then run with mock handlers that resolve all node types
**Then** all four templates produce pipelines that execute to the exit node without errors, confirming the templates are not only syntactically valid but executable (≥7 `it(...)` cases)

### AC7: Test Suite Size — At Least 80 New Tests Pass
**Given** all integration test files introduced by this story
**When** `npm run test:fast` executes
**Then** at least 80 `it(...)` cases across all new files pass with zero failures; confirm by checking the "Test Files" summary line showing all new files green

## Tasks / Subtasks

- [ ] Task 1: Create DOT fixture files for integration tests (AC: #1, #2, #3, #4, #5)
  - [ ] Before writing any DOT content, discover exact registered type strings: `grep -rn "registerHandler\|'stack\." packages/factory/src/handlers/registry.ts`
  - [ ] Create directory `packages/factory/src/__tests__/fixtures/` if it does not exist
  - [ ] Create `packages/factory/src/__tests__/fixtures/parallel-fan-out-fan-in.dot.ts` — exports `PARALLEL_FAN_OUT_DOT` (3-branch wait_all) and `FIRST_SUCCESS_POLICY_DOT` (2-branch first_success) as const strings; nodes: `start`, fan-out (stack.parallel), three codergen branches, fan-in (stack.fan_in), `exit`
  - [ ] Create `packages/factory/src/__tests__/fixtures/llm-edge-routing.dot.ts` — exports `LLM_EDGE_ROUTING_DOT`: a graph with a decision node having two outgoing edges — one labeled `llm:should we iterate?` (back-edge to a refinement node) and one labeled `done` (forward to exit)
  - [ ] Create `packages/factory/src/__tests__/fixtures/subgraph-parent.dot.ts` — exports `SUBGRAPH_PARENT_DOT` (parent with a `stack.subgraph` node pointing to `child.dot`) and `CHILD_GRAPH_DOT` (minimal child: `start → codergen → exit`)
  - [ ] Create `packages/factory/src/__tests__/fixtures/manager-loop.dot.ts` — exports `MANAGER_LOOP_DOT`: a graph with a `stack.manager_loop` node with `maxIterations="3"` attribute; full path: `start → manager_loop → exit`
  - [ ] All fixture files use `.js` ESM import extensions in their own imports; fixture strings use the exact type strings found via grep

- [ ] Task 2: Create parallel fan-out/fan-in integration tests (AC: #1)
  - [ ] Create `packages/factory/src/__tests__/integration/parallel-fan-out-fan-in.test.ts`
  - [ ] Discover exports: `grep -n "^export" packages/factory/src/graph/executor.ts` and `grep -n "^export" packages/factory/src/handlers/registry.ts`; use exact names
  - [ ] Build helper: `makeRegistry(overrides?)` that calls `createDefaultRegistry` and optionally replaces the `codergen` handler with a `vi.fn()`
  - [ ] Test (wait_all): 3 mock branches all succeed with different scores; fan-in selects highest-scoring branch; assert `result.status === 'SUCCESS'` and winning branch context key visible
  - [ ] Test (wait_all, one branch fails): 2 succeed, 1 fails; fan-in selects best of successful branches; pipeline completes
  - [ ] Test (first_success): first branch resolves immediately with SUCCESS; remaining branches cancelled; assert pipeline exits quickly and `cancelledCount > 0` from emitted event
  - [ ] Test (quorum): 3 branches, quorum=2; 2 succeed → pipeline proceeds; 1 succeeds → pipeline fails quorum
  - [ ] Test (maxParallel=2 with 4 branches): assert at most 2 mock handlers invoked simultaneously via call ordering
  - [ ] Test: fan-in heuristic mode — no `prompt` attribute; winner ranked by status (SUCCESS > PARTIAL_SUCCESS) then score descending
  - [ ] Test: fan-in LLM mode — `prompt` attribute set; mock LLM returns specific `branch_id`; assert that branch's context is merged
  - [ ] Test: context isolation — mutation to context in branch_a (setting `key_a`) not visible in branch_b's isolated context
  - [ ] Test: `graph:parallel-started` emitted once with correct `branchCount`
  - [ ] Test: `graph:parallel-branch-started` emitted once per branch, in order
  - [ ] Test: `graph:parallel-branch-completed` emitted once per branch with `durationMs >= 0`
  - [ ] Test: `graph:parallel-completed` emitted once; `completedCount + cancelledCount === totalBranches`
  - [ ] Test: missing `eventBus` in config — executor runs without TypeError
  - [ ] Test: empty parallel node (0 branches) — executor returns FAILURE or handles gracefully without crash
  - [ ] Minimum 15 `it(...)` cases in this file

- [ ] Task 3: Create LLM-evaluated edge integration tests (AC: #2)
  - [ ] Create `packages/factory/src/__tests__/integration/llm-edge-routing.test.ts`
  - [ ] Discover exports: `grep -n "^export" packages/factory/src/graph/edge-selector.ts`; use exact `selectEdge` / `SelectEdgeOptions` names
  - [ ] Test: mock LLM returns affirmative text → back-edge (`llm:should we iterate?`) selected → loop iteration occurs
  - [ ] Test: mock LLM returns negative text → forward edge (`done`) selected → pipeline exits
  - [ ] Test: LLM throws error → fallback `false` → forward edge taken; no exception propagated to caller
  - [ ] Test: `graph:llm-edge-evaluated` emitted with `result: true` on affirmative response
  - [ ] Test: `graph:llm-edge-evaluated` emitted with `result: false` on negative response
  - [ ] Test: `graph:llm-edge-evaluated` emitted with `result: false` on error fallback (LLM throws)
  - [ ] Test: full pipeline run — mock LLM returns "no" on iteration 1 then "yes" on iteration 2; pipeline completes after 2 cycles; assert `graph:llm-edge-evaluated` emitted twice
  - [ ] Test: edge without `llm:` prefix is not routed through LLM evaluator; mock LLM never called
  - [ ] Test: graph with one LLM edge and two static label edges — static label matching still works correctly for non-LLM branches
  - [ ] Test: `runId` flows through to event payload — `graph:llm-edge-evaluated.runId` matches executor config runId
  - [ ] Test: absent `eventBus` — `selectEdge` completes without TypeError
  - [ ] Test: LLM response is ambiguous/empty — fallback to `false`; no crash
  - [ ] Minimum 12 `it(...)` cases in this file

- [ ] Task 4: Create subgraph execution integration tests (AC: #3)
  - [ ] Create `packages/factory/src/__tests__/integration/subgraph-execution.test.ts`
  - [ ] Discover exports: `grep -n "^export" packages/factory/src/handlers/subgraph.ts`; verify `createSubgraphHandler` signature and `SubgraphHandlerOptions` fields
  - [ ] Build helper: `makeMockLoader(dotString)` — returns a `graphFileLoader` `vi.fn()` resolving with the given DOT string
  - [ ] Test: basic subgraph — child runs to completion; parent context updated with child output (e.g., `child_result` key); parent continues to exit node
  - [ ] Test: child graph failure — child node returns FAILURE; parent receives FAILURE outcome from subgraph handler
  - [ ] Test: `graph:subgraph-started` emitted with `depth: 0` and correct `graphFile` value
  - [ ] Test: `graph:subgraph-completed` emitted with `durationMs >= 0` and `status` matching child outcome
  - [ ] Test: nested subgraph (child itself has a subgraph node) — grandchild events carry `depth: 1`; parent events carry `depth: 0`
  - [ ] Test: max-depth exceeded — executor returns FAILURE and does not recurse indefinitely
  - [ ] Test: shared runId — `graph:subgraph-started` and child `graph:node-started` both carry the same `runId`
  - [ ] Test: context isolation — parent context key `parent_key` not visible in child's initial context
  - [ ] Test: after subgraph completes, child output keys are merged into parent context and accessible
  - [ ] Test: missing `graphFileLoader` — handler returns FAILURE with descriptive error
  - [ ] Test: absent `eventBus` — subgraph handler runs without TypeError
  - [ ] Minimum 12 `it(...)` cases in this file

- [ ] Task 5: Create manager loop and event stream integration tests (AC: #4, #5)
  - [ ] Create `packages/factory/src/__tests__/integration/manager-loop.test.ts`
  - [ ] Discover exports: `grep -n "^export" packages/factory/src/handlers/manager-loop.ts`; verify `createManagerLoopHandler` signature and options
  - [ ] Test: loop succeeds within maxIterations — mock sub-agent returns SUCCESS on iteration 2 of 3; assert `status === 'SUCCESS'` and iteration count written to context
  - [ ] Test: loop exhausts maxIterations (3/3) without success — assert `status` is ESCALATE or FAILURE (check handler spec from story 50-8 for exact status)
  - [ ] Test: loop reads steering signal from context key (e.g., `manager_loop.steering`) and adjusts prompt on next iteration
  - [ ] Test: loop detection — if context state identical on two consecutive iterations, loop breaks with appropriate outcome
  - [ ] Test: budget control — if configured cost budget exceeded, loop exits early with NEEDS_RETRY
  - [ ] Test: iteration count key written to context (e.g., `manager_loop.iteration_count`) matches actual number of iterations run
  - [ ] Test: `graph:node-started` / `graph:node-completed` emitted for each sub-agent call within the loop
  - [ ] Test: absent `eventBus` — manager loop runs without TypeError
  - [ ] Test: `maxIterations=1` — loop runs exactly once regardless of outcome
  - [ ] Test: loop with zero `maxIterations` — handler returns FAILURE immediately or treats as 1
  - [ ] Minimum 10 `it(...)` cases in this file
  - [ ] Create `packages/factory/src/__tests__/integration/advanced-graph-events.test.ts`
  - [ ] Build a single combined graph: `start → parallel_node → [branch_a, branch_b] → fan_in → subgraph_node → llm_decision → [llm:keep_going?, done] → exit`
  - [ ] Attach `mockBus = { emit: vi.fn() }` and record all emitted events in order
  - [ ] Test: `graph:parallel-started` appears in emitted stream before any `graph:parallel-branch-started`
  - [ ] Test: both `graph:parallel-branch-started` and `graph:parallel-branch-completed` appear for each branch
  - [ ] Test: `graph:parallel-completed` appears after all branch-completed events
  - [ ] Test: `graph:subgraph-started` appears before child graph events; `graph:subgraph-completed` appears after
  - [ ] Test: `graph:llm-edge-evaluated` appears with correct `nodeId` referencing the decision node
  - [ ] Test: `graph:llm-edge-evaluated` still emitted when LLM call throws (error-fallback path)
  - [ ] Test: no existing event types (`graph:node-started`, `graph:node-completed`, `graph:run-started`, `graph:run-completed`) are missing from the stream
  - [ ] Test: all seven new event type payloads contain non-empty `runId` matching the executor config
  - [ ] Minimum 8 `it(...)` cases in this file

- [ ] Task 6: Create pipeline templates end-to-end execution tests (AC: #6)
  - [ ] Create `packages/factory/src/__tests__/integration/pipeline-templates-integration.test.ts`
  - [ ] Import `listPipelineTemplates`, `getPipelineTemplate` from `'../../templates/index.js'`
  - [ ] Import `parseGraph` from `'../../graph/parser.js'`
  - [ ] Build a `makeUniversalRegistry()` helper that registers `vi.fn()` handlers for all node types used across the four templates (at minimum: `codergen`, `start`, `exit`, plus the fan-out and fan-in type strings)
  - [ ] For each template (`trycycle`, `dual-review`, `parallel-exploration`, `staged-validation`):
    - Test: `parseGraph(template.dotContent)` succeeds and returns a non-empty graph object
    - Test: executor runs the parsed graph with mock handlers and returns a non-error outcome (SUCCESS or terminal status)
  - [ ] Test: `trycycle` executed — eval nodes are reached during run; mock always returns "approved" so pipeline exits without looping
  - [ ] Test: `dual-review` executed — both reviewer branches invoked; fan-in selects a winner; pipeline reaches exit
  - [ ] Test: `parallel-exploration` executed — both approach branches invoked; best candidate selected; pipeline reaches exit
  - [ ] Test: `staged-validation` executed — all sequential stages invoked in order (implement → lint → test → validate → exit); no parallel nodes invoked
  - [ ] Minimum 7 `it(...)` cases in this file

- [ ] Task 7: Run build and tests to confirm ≥80 new tests pass (AC: #7)
  - [ ] Run `npm run build`; confirm zero TypeScript errors across all new test files and fixtures
  - [ ] Count new `it(` calls: `grep -rn "^\s*it(" packages/factory/src/__tests__/integration/ | wc -l` — confirm ≥80
  - [ ] Run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line shows all new files green with zero failures
  - [ ] NEVER pipe test output through `tail`, `head`, `grep`, or any filtering command

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): e.g., `import { ... } from '../../graph/executor.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- Use `vitest` (`describe`, `it`, `expect`, `vi`) — no Jest globals, no `jest.fn()`
- Integration tests MUST NOT make real LLM calls — mock all LLM interactions via `vi.fn()` injected into handler or executor options
- Integration tests MUST NOT read files from disk — use inline DOT strings or mock `graphFileLoader` functions
- Handler signature: `(node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>` — never add a fourth argument; all cross-cutting concerns (eventBus, runId) are captured in handler closures via factory options

### Import Pattern Discovery (do this before writing any test)
Run these greps before writing any test import to use the correct exported names:
```bash
grep -n "^export" packages/factory/src/graph/executor.ts
grep -n "^export" packages/factory/src/handlers/registry.ts
grep -n "^export" packages/factory/src/graph/edge-selector.ts
grep -n "^export" packages/factory/src/handlers/parallel.ts
grep -n "^export" packages/factory/src/handlers/fan-in.ts
grep -n "^export" packages/factory/src/handlers/subgraph.ts
grep -n "^export" packages/factory/src/handlers/manager-loop.ts
grep -n "^export" packages/factory/src/graph/parser.ts
grep -n "^export" packages/factory/src/templates/index.ts
```

### Node Type String Discovery
All DOT fixture strings MUST use the exact type strings registered in the handler registry — do NOT guess:
```bash
grep -rn "registerHandler\|'stack\." packages/factory/src/handlers/registry.ts
```
Expected values (verify before use): `stack.parallel`, `stack.fan_in`, `stack.subgraph`, `stack.manager_loop`, `codergen`, `start`, `exit`.

### Graph Context Construction
Check the actual context factory before using it:
```bash
grep -n "^export" packages/factory/src/graph/context.ts
```
Likely pattern (verify):
```typescript
import { createGraphContext } from '../../graph/context.js'
const ctx = createGraphContext({ initialKeys: { runId: 'test-run' } })
```

### Registry Override Pattern
Check `createDefaultRegistry` signature to see if it accepts an `overrides` map:
```bash
grep -n "overrides\|DefaultRegistryOptions" packages/factory/src/handlers/registry.ts
```
If an `overrides` option exists:
```typescript
const registry = createDefaultRegistry({ overrides: { codergen: vi.fn().mockResolvedValue({ status: 'SUCCESS', contextUpdates: {} }) } })
```
If not, build a minimal registry manually using `registerHandler`.

### Executor Construction Pattern
Read the executor's constructor or factory function signature before instantiating:
```bash
grep -n "class GraphExecutor\|function createExecutor\|export.*Executor" packages/factory/src/graph/executor.ts
```
Typical pattern:
```typescript
const executor = new GraphExecutor(parsedGraph, registry, {
  eventBus: mockBus,
  runId: 'test-run-123',
})
const result = await executor.run(ctx)
```

### LLM Mock for Edge Selection
Inject a mock `llmCall` into `SelectEdgeOptions` for unit-level tests:
```typescript
const mockLlm = vi.fn().mockResolvedValue('yes, we should iterate')
const edge = await selectEdge(node, outcome, context, graph, {
  llmCall: mockLlm,
  eventBus: mockBus,
  runId: 'test-run',
})
```
For full executor runs, check if `GraphExecutorConfig` has an `llmCall` field or if it is injected via another mechanism.

### Event Bus Mock Pattern
```typescript
const emittedEvents: Array<[string, unknown]> = []
const mockBus = {
  emit: vi.fn((type: string, payload: unknown) => {
    emittedEvents.push([type, payload])
  }),
}
```
Assert ordering:
```typescript
const types = emittedEvents.map(([t]) => t)
const parallelStartIdx = types.indexOf('graph:parallel-started')
const firstBranchStartIdx = types.indexOf('graph:parallel-branch-started')
expect(parallelStartIdx).toBeLessThan(firstBranchStartIdx)
```

### Fixture DOT String Format
```typescript
// packages/factory/src/__tests__/fixtures/parallel-fan-out-fan-in.dot.ts
// Replace 'stack.parallel' and 'stack.fan_in' with exact strings from registry grep
export const PARALLEL_FAN_OUT_DOT = `
digraph parallel_test {
  start    [type="start"];
  fan_out  [type="stack.parallel", policy="wait_all"];
  branch_a [type="codergen", label="Branch A"];
  branch_b [type="codergen", label="Branch B"];
  branch_c [type="codergen", label="Branch C"];
  fan_in   [type="stack.fan_in"];
  exit     [type="exit"];

  start -> fan_out;
  fan_out -> branch_a;
  fan_out -> branch_b;
  fan_out -> branch_c;
  branch_a -> fan_in;
  branch_b -> fan_in;
  branch_c -> fan_in;
  fan_in -> exit;
}
`
```

### Manager Loop Attribute Discovery
Before writing the manager loop fixture DOT string, check what attributes `stack.manager_loop` reads from graph nodes:
```bash
grep -n "attributes\|maxIterations\|max_iterations\|budget" packages/factory/src/handlers/manager-loop.ts | head -20
```
Use the exact attribute names found in the handler implementation.

### Status Values Reference
Valid `OutcomeStatus` values: `'SUCCESS'` | `'PARTIAL_SUCCESS'` | `'FAILURE'` | `'NEEDS_RETRY'` | `'ESCALATE'`
Do NOT use `'FAIL'` or `'RETRY'` (Attractor shorthand, not valid in this codebase).

### New File Paths
```
packages/factory/src/__tests__/fixtures/parallel-fan-out-fan-in.dot.ts         — DOT fixture strings
packages/factory/src/__tests__/fixtures/llm-edge-routing.dot.ts                — DOT fixture string
packages/factory/src/__tests__/fixtures/subgraph-parent.dot.ts                 — parent + child DOT strings
packages/factory/src/__tests__/fixtures/manager-loop.dot.ts                    — DOT fixture string
packages/factory/src/__tests__/integration/parallel-fan-out-fan-in.test.ts     — ≥15 cases (AC1)
packages/factory/src/__tests__/integration/llm-edge-routing.test.ts            — ≥12 cases (AC2)
packages/factory/src/__tests__/integration/subgraph-execution.test.ts          — ≥12 cases (AC3)
packages/factory/src/__tests__/integration/manager-loop.test.ts                — ≥10 cases (AC4)
packages/factory/src/__tests__/integration/advanced-graph-events.test.ts       — ≥8 cases (AC5)
packages/factory/src/__tests__/integration/pipeline-templates-integration.test.ts — ≥7 cases (AC6)
```

### Testing Requirements
- Framework: `vitest` (`describe`, `it`, `expect`, `vi`) — no Jest globals
- All LLM calls mocked — no real network/API requests
- All file I/O mocked — no `fs` calls in tests; inline DOT strings used throughout
- Total new `it(...)` cases: ≥80 across all integration test files
- Run `npm run build` first (catches TypeScript errors); then `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line; NEVER pipe output through `tail`, `head`, `grep`, or any filtering command

## Interface Contracts

- **Import**: `GraphExecutor` (or equivalent factory fn) @ `packages/factory/src/graph/executor.ts` (from Epic 42)
- **Import**: `createDefaultRegistry`, `DefaultRegistryOptions` @ `packages/factory/src/handlers/registry.ts` (from story 50-9)
- **Import**: `createParallelHandler`, `ParallelHandlerOptions` @ `packages/factory/src/handlers/parallel.ts` (from story 50-1)
- **Import**: `createFanInHandler`, `FanInHandlerOptions` @ `packages/factory/src/handlers/fan-in.ts` (from story 50-2)
- **Import**: `selectEdge`, `SelectEdgeOptions` @ `packages/factory/src/graph/edge-selector.ts` (from story 50-4; updated by 50-9)
- **Import**: `createSubgraphHandler`, `SubgraphHandlerOptions` @ `packages/factory/src/handlers/subgraph.ts` (from story 50-5)
- **Import**: `createManagerLoopHandler` @ `packages/factory/src/handlers/manager-loop.ts` (from story 50-8)
- **Import**: `listPipelineTemplates`, `getPipelineTemplate` @ `packages/factory/src/templates/index.ts` (from story 50-10)
- **Import**: `parseGraph` @ `packages/factory/src/graph/parser.ts` (from Epic 42)
- **Import**: `FactoryEvents` (7 advanced event types) @ `packages/factory/src/events.ts` (from story 50-9)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
