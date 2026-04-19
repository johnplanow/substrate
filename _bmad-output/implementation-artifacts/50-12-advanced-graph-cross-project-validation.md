# Story 50-12: Advanced Graph Cross-Project Validation

## Story

As a substrate platform developer,
I want to run all Epic 50 advanced graph features together in a comprehensive end-to-end validation against a reference project fixture,
so that I can confirm the full advanced graph pipeline — parallel fan-out/fan-in, subgraph composition, LLM-evaluated routing, and manager loop convergence — works correctly in production-like conditions, with all seven advanced event types emitted and the manager loop converging without stall detection.

## Acceptance Criteria

### AC1: Comprehensive Validation DOT Graph Created and Passes Lint
**Given** a DOT graph fixture authored at `packages/factory/src/__tests__/fixtures/advanced-cross-project-validation.dot.ts` exercising all five major Epic 50 handler types: `stack.manager_loop` as the outermost wrapper, `stack.parallel` (fan-out, 2 branches) as the loop body, `stack.subgraph` inside branch_a referencing a child graph, `stack.fan_in` (best-candidate) collecting both branches, and one LLM-evaluated exit edge (`condition="llm:has the implementation satisfied the acceptance criteria?"`) from the fan-in node to the terminal
**When** `GraphValidator.validate(parsedGraph)` is called on the loaded DOT file
**Then** zero lint errors are returned, the graph parses without exception, and all five handler type strings are present in the parsed node attributes; the child graph fixture also parses without error

### AC2: Reference Project Fixture Exists with Realistic Source Files
**Given** a minimal TypeScript reference project at `packages/factory/src/__tests__/fixtures/reference-project/src/utils.ts` containing 3–4 simple utility functions (e.g., `clamp`, `capitalize`, `slugify`, `chunk`) with no accompanying test file, and a `packages/factory/src/__tests__/fixtures/reference-project/package.json` with `{ "name": "reference-project", "version": "0.1.0" }`
**When** the validation test setup reads these fixture files via `fs.readFileSync`
**Then** both files exist, `utils.ts` contains at least 3 exported function definitions, and the package.json parses as valid JSON; these fixtures represent a realistic "add unit tests to this codebase" task suitable for a factory pipeline

### AC3: Full Pipeline Executes End-to-End Without Errors
**Given** mock codergen handlers injected for branch_a (returns `{ status: 'SUCCESS', contextUpdates: { 'impl.approach': 'approach_a', 'impl.score': 0.85 } }`) and branch_b (returns `{ status: 'SUCCESS', contextUpdates: { 'impl.approach': 'approach_b', 'impl.score': 0.60 } }`), a mock `graphFileLoader` returning the child DOT string, and a mock LLM client returning `"yes"` for all LLM calls
**When** `GraphExecutor` runs the comprehensive validation DOT graph with these mocks and a `runId: 'cross-project-validation-001'`
**Then** the executor returns `{ status: 'SUCCESS' }`, both branch mock handlers are called at least once, `context.get('impl.approach')` equals `'approach_a'` (winner's context update applied to root), and the exit node is reached without uncaught exceptions

### AC4: All Seven Advanced Event Types Are Emitted in the Event Stream
**Given** an `eventBus` mock (`{ emit: vi.fn() }`) attached to the executor in AC3 that records all emitted events
**When** the full executor run completes
**Then** the collected event log contains at least one occurrence of each of the seven advanced event types: `graph:parallel-started`, `graph:parallel-branch-started`, `graph:parallel-branch-completed`, `graph:parallel-completed`, `graph:subgraph-started`, `graph:subgraph-completed`, and `graph:llm-edge-evaluated`; each assertion is explicit (`expect(types).toContain(...)` for every type), and every advanced event payload contains a non-empty `runId` matching `'cross-project-validation-001'`

### AC5: Context State Is Fully Correct After Pipeline Completion
**Given** the completed validation run context from AC3
**When** `context.get(key)` is called for each expected key
**Then** all of the following assertions pass:
- `context.get('parallel.results')` is an array of length 2
- `context.get('parallel.fan_in.best_id')` equals `0` (branch_a, higher score 0.85)
- `context.get('parallel.fan_in.best_outcome')` equals `'SUCCESS'`
- `context.get('impl.approach')` equals `'approach_a'` (winner's updates propagated to root)
- `context.get('llm.edge_eval_count')` is `≥ 1`
- `context.get('manager_loop.cycles_completed')` equals `1`

### AC6: Manager Loop Converges on First Cycle Without Stall
**Given** the outermost `stack.manager_loop` node configured with `max_cycles=3` and `stop_condition="llm:has the implementation satisfied the acceptance criteria?"` and the mock LLM returning `"yes"` on all calls
**When** the manager loop evaluates its stop condition after the first inner execution completes
**Then** `context.get('manager_loop.cycles_completed')` equals `1`, `context.get('manager_loop.stop_reason')` equals `'stop_condition_met'`, no stall-detection steering is injected (`context.get('manager_loop.steering')` is `undefined`, `null`, or `{ mode: 'none' }`), and the pipeline does not run cycles 2 or 3 (convergence achieved before budget exhaustion)

### AC7: Validation Report Written to _bmad-output/
**Given** all prior ACs pass in the validation test suite
**When** the test `afterAll` hook executes after all test cases complete
**Then** a markdown file is written to `_bmad-output/validation-reports/50-12-advanced-graph-validation.md` documenting: run timestamp, `runId`, a pass/fail row for each AC (1–6), event type counts (with counts for all 7 advanced types), final context key values, manager loop cycles completed, convergence verdict, and an overall PASS/FAIL summary line

## Tasks / Subtasks

- [ ] Task 1: Create comprehensive validation DOT graph fixtures (AC: #1)
  - [ ] Before writing any DOT content, discover exact registered handler type strings: `grep -rn "registerHandler\|'stack\." packages/factory/src/handlers/registry.ts`
  - [ ] Create `packages/factory/src/__tests__/fixtures/advanced-cross-project-validation.dot.ts` exporting `ADVANCED_VALIDATION_DOT` — a digraph where: `start` (type=start) → `manager_loop` (type=stack.manager_loop, max_cycles=3, stop_condition="llm:has the implementation satisfied the acceptance criteria?") → `parallel_node` (type=stack.parallel, policy=wait_all, maxParallel=2) → [`branch_a` (type=codergen), `branch_b` (type=codergen)]; `branch_a` → `subgraph_node` (type=stack.subgraph, graph_file="child.dot"); both `subgraph_node` and `branch_b` → `fan_in` (type=stack.fan_in, selection=best_candidate); `fan_in` →[condition="llm:has the implementation satisfied the acceptance criteria?"] `exit` (type=exit)
  - [ ] Create `packages/factory/src/__tests__/fixtures/advanced-cross-project-validation.dot.ts` also exporting `CHILD_GRAPH_DOT` — a minimal 3-node digraph: `child_start` (type=start) → `child_work` (type=codergen, label="Implement in child context") → `child_exit` (type=exit)
  - [ ] In the same file, add a `validateFixtures()` test-helper that imports `parseGraph` and calls it on both DOT strings, throwing if either throws

- [ ] Task 2: Create reference project fixture files (AC: #2)
  - [ ] Create directory `packages/factory/src/__tests__/fixtures/reference-project/src/`
  - [ ] Create `packages/factory/src/__tests__/fixtures/reference-project/src/utils.ts` with at least 4 exported functions: `export function clamp(val: number, min: number, max: number): number`, `export function capitalize(s: string): string`, `export function slugify(s: string): string`, `export function chunk<T>(arr: T[], size: number): T[][]` — each with a simple implementation; no test file included
  - [ ] Create `packages/factory/src/__tests__/fixtures/reference-project/package.json` with content `{"name":"reference-project","version":"0.1.0","description":"Fixture: a small TS project with no tests, used for advanced graph cross-project validation"}`
  - [ ] The fixture files are plain TypeScript/JSON — no special substrate imports or dependencies

- [ ] Task 3: Write validation test file skeleton and full pipeline execution test (AC: #3)
  - [ ] Create `packages/factory/src/__tests__/validation/advanced-cross-project.test.ts`
  - [ ] Discover `GraphExecutor` constructor/factory signature: `grep -n "class GraphExecutor\|function createExecutor\|export.*Executor" packages/factory/src/graph/executor.ts`
  - [ ] Discover `createDefaultRegistry` / `registerHandler` patterns: `grep -n "createDefaultRegistry\|DefaultRegistryOptions\|registerHandler" packages/factory/src/handlers/registry.ts`
  - [ ] Discover graph context factory: `grep -n "^export" packages/factory/src/graph/context.ts`
  - [ ] Build shared test setup in a `beforeAll` or top-level block: parse `ADVANCED_VALIDATION_DOT`, create mock codergen handlers using `vi.fn()` (branch_a returns score 0.85, branch_b returns score 0.60), create mock `graphFileLoader` (`vi.fn()` resolving with `CHILD_GRAPH_DOT`), create mock LLM client returning `"yes"`, create mock eventBus (`{ emit: vi.fn() }`), run executor, store `result` and `collectedEvents`
  - [ ] Write `it('full pipeline returns SUCCESS with all mocks wired')`: assert `result.status === 'SUCCESS'`, both branch mocks called, exit node reached
  - [ ] Wrap all tests in `describe('Advanced Graph Cross-Project Validation', ...)`

- [ ] Task 4: Implement all-seven-events assertion (AC: #4)
  - [ ] Discover exact event type strings: `grep -n "graph:parallel\|graph:subgraph\|graph:llm-edge" packages/factory/src/events.ts`
  - [ ] Define `const REQUIRED_EVENT_TYPES = ["graph:parallel-started", "graph:parallel-branch-started", "graph:parallel-branch-completed", "graph:parallel-completed", "graph:subgraph-started", "graph:subgraph-completed", "graph:llm-edge-evaluated"]` — replace strings with exact values from grep
  - [ ] Write `it('emits all 7 advanced event types')`: extract types array from `collectedEvents`, loop over `REQUIRED_EVENT_TYPES`, assert each `types.includes(t)` is true
  - [ ] Write `it('every advanced event payload carries the correct runId')`: for each event in `REQUIRED_EVENT_TYPES`, find first matching event and assert `payload.runId === 'cross-project-validation-001'`
  - [ ] Write `it('graph:parallel-branch-started fires once per branch (2 times)')`: assert `types.filter(t => t === 'graph:parallel-branch-started').length === 2`

- [ ] Task 5: Implement context state assertions (AC: #5)
  - [ ] Discover fan-in context key names: `grep -n "fan_in\." packages/factory/src/handlers/fan-in.ts | head -20`
  - [ ] Discover parallel results key name: `grep -n "parallel\.results\|parallel\.fan_in" packages/factory/src/handlers/parallel.ts packages/factory/src/handlers/fan-in.ts | head -20`
  - [ ] Write `it('context.parallel.results has 2 entries')`: assert `context.get('parallel.results')` array length equals 2
  - [ ] Write `it('fan-in selects branch_a as best candidate')`: assert `context.get('parallel.fan_in.best_id') === 0` and `context.get('parallel.fan_in.best_outcome') === 'SUCCESS'`
  - [ ] Write `it('winner context updates propagated to root context')`: assert `context.get('impl.approach') === 'approach_a'`
  - [ ] Write `it('llm.edge_eval_count is at least 1')`: assert `(context.get('llm.edge_eval_count') as number) >= 1`
  - [ ] Write `it('manager_loop.cycles_completed equals 1')`: assert `context.get('manager_loop.cycles_completed') === 1`

- [ ] Task 6: Implement manager loop convergence assertions (AC: #6)
  - [ ] Discover manager-loop context key names: `grep -n "manager_loop\.\|cycles_completed\|stop_reason\|steering" packages/factory/src/handlers/manager-loop.ts | head -30`
  - [ ] Write `it('manager loop stop reason is stop_condition_met')`: assert `context.get('manager_loop.stop_reason') === 'stop_condition_met'`
  - [ ] Write `it('manager loop did not inject stall-detection steering')`: retrieve `context.get('manager_loop.steering')`; assert it is `undefined`, `null`, or an object with `mode === 'none'`
  - [ ] Write `it('manager loop converged before exhausting budget (cycles 2 and 3 not run)')`: assert `context.get('manager_loop.cycles_completed') < 3` (pipeline stopped before max_cycles exhausted)
  - [ ] Write `it('convergence rate meets 90% threshold')`: compute `rate = 1 / context.get('manager_loop.cycles_completed')`; assert `rate >= 0.9` (converging in 1 of 1 attempted cycles = 100%)

- [ ] Task 7: Write validation report generator (AC: #7)
  - [ ] At the top of the test file, import `fs` from `'fs'` and `path` from `'path'`
  - [ ] Add an `afterAll` hook that: collects all AC outcomes (result.status, context key values, event types captured), builds a markdown string with sections: `# Advanced Graph Cross-Project Validation Report`, run timestamp, runId, a `## AC Results` table (AC | Description | Result), a `## Event Coverage` table (Event Type | Count), `## Context State` key-value table, `## Manager Loop Convergence` section, and `## Overall: PASS/FAIL`
  - [ ] Ensure the output directory exists: `fs.mkdirSync(path.resolve('_bmad-output/validation-reports'), { recursive: true })`
  - [ ] Write to `path.resolve('_bmad-output/validation-reports/50-12-advanced-graph-validation.md')`
  - [ ] Write `it('validation report file is written to _bmad-output/validation-reports/')`: after `afterAll` completes (use a separate `describe` block or check file existence at test teardown), assert the file exists via `fs.existsSync(...)`

- [ ] Task 8: Run build and tests, verify all ACs pass (AC: #1–#7)
  - [ ] Run `npm run build`; confirm zero TypeScript errors across the new fixture and test files
  - [ ] Count new `it(` calls in the validation test: `grep -rn "^\s*it(" packages/factory/src/__tests__/validation/ | wc -l` — confirm ≥ 15 test cases
  - [ ] Run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line shows the new validation test file green with zero failures
  - [ ] Confirm the validation report file was written: `ls -la _bmad-output/validation-reports/50-12-advanced-graph-validation.md`
  - [ ] NEVER pipe test output through `tail`, `head`, `grep`, or any filtering command

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): e.g., `import { ADVANCED_VALIDATION_DOT } from '../../__tests__/fixtures/advanced-cross-project-validation.dot.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- Use `vitest` (`describe`, `it`, `expect`, `vi`, `beforeAll`, `afterAll`) — no Jest globals, no `jest.fn()`
- Tests MUST NOT make real LLM calls — mock all LLM interactions via `vi.fn()` returning `"yes"` or configured response strings
- Tests MUST NOT read DOT fixture files from disk at test runtime — embed DOT strings inline as exported `const` strings in `.dot.ts` fixture modules
- Handler signature: `(node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>` — all cross-cutting concerns (eventBus, runId, llmClient) injected via handler factory options, not as handler arguments
- This story depends on stories 50-1 through 50-11 being complete; all handler type strings, context key names, and event types must be verified via grep before use — do NOT assume from story docs

### Import Pattern Discovery (run before writing any test import)
```bash
grep -n "^export" packages/factory/src/graph/executor.ts
grep -n "^export" packages/factory/src/graph/parser.ts
grep -n "^export" packages/factory/src/graph/context.ts
grep -n "^export" packages/factory/src/handlers/registry.ts
grep -n "^export" packages/factory/src/handlers/parallel.ts
grep -n "^export" packages/factory/src/handlers/fan-in.ts
grep -n "^export" packages/factory/src/handlers/subgraph.ts
grep -n "^export" packages/factory/src/handlers/manager-loop.ts
grep -n "^export" packages/factory/src/events.ts
```

### Node Type String Discovery
All DOT fixture strings MUST use the exact type strings registered in the handler registry — do NOT guess:
```bash
grep -rn "registerHandler\|'stack\." packages/factory/src/handlers/registry.ts
```
Expected values (verify before use): `stack.parallel`, `stack.fan_in`, `stack.subgraph`, `stack.manager_loop`, `codergen`, `start`, `exit`.

### Manager Loop Attribute Discovery
Before writing the outer manager_loop node attributes, check what attribute names the handler reads:
```bash
grep -n "attributes\|maxIterations\|max_cycles\|stopCondition\|stop_condition" packages/factory/src/handlers/manager-loop.ts | head -20
```
Use the exact attribute names found — attribute names in the DOT graph must exactly match what the handler reads.

### Context Key Discovery
Before writing context assertions, verify the actual key names written by each handler:
```bash
grep -n "parallel\.results\|parallel\.fan_in\|fan_in\.best" packages/factory/src/handlers/fan-in.ts packages/factory/src/handlers/parallel.ts | head -20
grep -n "manager_loop\.\|cycles_completed\|stop_reason\|steering" packages/factory/src/handlers/manager-loop.ts | head -20
grep -n "llm\.edge_eval" packages/factory/src/graph/edge-selector.ts | head -10
```
Replace every context key in the assertions with the exact strings found by these greps.

### Executor Construction Pattern
Read the executor's constructor/factory signature before instantiating:
```bash
grep -n "class GraphExecutor\|function createExecutor\|export.*Executor" packages/factory/src/graph/executor.ts
```
Typical pattern (verify names first):
```typescript
const executor = new GraphExecutor(parsedGraph, registry, {
  eventBus: mockBus,
  runId: 'cross-project-validation-001',
  llmClient: mockLlmClient,
  graphFileLoader: mockFileLoader,
})
const context = createGraphContext({ initialKeys: {} })
const result = await executor.run(context)
```

### Mock Codergen Handler Pattern
```typescript
const mockBranchA = vi.fn().mockResolvedValue({
  status: 'SUCCESS' as const,
  contextUpdates: { 'impl.approach': 'approach_a', 'impl.score': 0.85 },
})
const mockBranchB = vi.fn().mockResolvedValue({
  status: 'SUCCESS' as const,
  contextUpdates: { 'impl.approach': 'approach_b', 'impl.score': 0.60 },
})
```
Check how to differentiate branch_a vs branch_b mock handlers in the registry — inspect `createDefaultRegistry` and registry override patterns:
```bash
grep -n "overrides\|DefaultRegistryOptions\|label\|nodeId" packages/factory/src/handlers/registry.ts | head -20
```
If the registry routes by node ID or label, use that mechanism. If all `codergen` nodes share one handler, use the call order or node attribute to distinguish.

### Event Bus Mock Pattern
```typescript
const collectedEvents: Array<{ type: string; payload: Record<string, unknown> }> = []
const mockBus = {
  emit: vi.fn((type: string, payload: Record<string, unknown>) => {
    collectedEvents.push({ type, payload })
  }),
}
```
Extract types for ordering assertions:
```typescript
const types = collectedEvents.map(e => e.type)
const parallelStartIdx = types.indexOf('graph:parallel-started')
const firstBranchStartIdx = types.indexOf('graph:parallel-branch-started')
expect(parallelStartIdx).toBeLessThan(firstBranchStartIdx)
```

### Validation DOT Graph Example Structure
```typescript
// Replace all type strings with exact values from registry grep
export const ADVANCED_VALIDATION_DOT = `
digraph advanced_cross_project {
  start           [type="start"];
  manager_loop    [type="stack.manager_loop", max_cycles="3", stop_condition="llm:has the implementation satisfied the acceptance criteria?"];
  parallel_node   [type="stack.parallel", policy="wait_all", maxParallel="2"];
  branch_a        [type="codergen", label="Implement approach A"];
  subgraph_node   [type="stack.subgraph", graph_file="child.dot"];
  branch_b        [type="codergen", label="Implement approach B"];
  fan_in          [type="stack.fan_in", selection="best_candidate"];
  exit            [type="exit"];

  start -> manager_loop;
  manager_loop -> parallel_node;
  parallel_node -> branch_a;
  parallel_node -> branch_b;
  branch_a -> subgraph_node;
  subgraph_node -> fan_in;
  branch_b -> fan_in;
  fan_in -> exit [condition="llm:has the implementation satisfied the acceptance criteria?"];
}
`

export const CHILD_GRAPH_DOT = `
digraph child_branch {
  child_start [type="start"];
  child_work  [type="codergen", label="Implement in child context"];
  child_exit  [type="exit"];

  child_start -> child_work;
  child_work -> child_exit;
}
`
```
**NOTE:** Verify attribute names (`max_cycles`, `stop_condition`, `maxParallel`, `selection`) match exactly what each handler reads before finalizing. Adjust DOT content based on grep results.

### Status Values Reference
Valid `OutcomeStatus` values: `'SUCCESS'` | `'PARTIAL_SUCCESS'` | `'FAILURE'` | `'NEEDS_RETRY'` | `'ESCALATE'`
Do NOT use `'FAIL'` or `'RETRY'` (Attractor shorthand, not valid in this codebase).

### New File Paths
```
packages/factory/src/__tests__/fixtures/advanced-cross-project-validation.dot.ts     — DOT fixture strings (ADVANCED_VALIDATION_DOT + CHILD_GRAPH_DOT)
packages/factory/src/__tests__/fixtures/reference-project/src/utils.ts               — Reference project TypeScript source (4 utility functions, no tests)
packages/factory/src/__tests__/fixtures/reference-project/package.json               — Reference project manifest
packages/factory/src/__tests__/validation/advanced-cross-project.test.ts             — Main validation test file (≥15 it() cases)
_bmad-output/validation-reports/50-12-advanced-graph-validation.md                   — Written by afterAll hook after test run
```

### Testing Requirements
- Framework: `vitest` (`describe`, `it`, `expect`, `vi`, `beforeAll`, `afterAll`) — no Jest globals
- All LLM calls mocked — no real network/API requests in any test
- All file I/O for DOT graphs mocked — use inline strings and mock `graphFileLoader`; `fs.readFileSync` is allowed only in the `afterAll` report-writer and the AC2 fixture-existence assertion
- Minimum 15 `it(...)` cases in `advanced-cross-project.test.ts`
- Run `npm run build` first (catches TypeScript errors); then `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line; NEVER pipe output through `tail`, `head`, `grep`, or any filtering command

## Interface Contracts

- **Import**: `GraphExecutor` (or equivalent factory fn) @ `packages/factory/src/graph/executor.ts` (from Epic 42)
- **Import**: `parseGraph` @ `packages/factory/src/graph/parser.ts` (from Epic 42)
- **Import**: `createGraphContext` @ `packages/factory/src/graph/context.ts` (from Epic 42)
- **Import**: `createDefaultRegistry` @ `packages/factory/src/handlers/registry.ts` (updated by story 50-9)
- **Import**: `createParallelHandler`, `ParallelHandlerOptions` @ `packages/factory/src/handlers/parallel.ts` (from story 50-1)
- **Import**: `createFanInHandler`, `FanInHandlerOptions` @ `packages/factory/src/handlers/fan-in.ts` (from story 50-2)
- **Import**: `createSubgraphHandler`, `SubgraphHandlerOptions` @ `packages/factory/src/handlers/subgraph.ts` (from story 50-5)
- **Import**: `createManagerLoopHandler` @ `packages/factory/src/handlers/manager-loop.ts` (from story 50-8)
- **Import**: `FactoryEvents` (7 advanced event types) @ `packages/factory/src/events.ts` (from story 50-9)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
