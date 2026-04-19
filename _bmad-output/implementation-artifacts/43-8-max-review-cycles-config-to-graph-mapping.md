# Story 43.8: maxReviewCycles Config-to-Graph Mapping

## Story

As a graph-based SDLC orchestrator,
I want the `maxReviewCycles` configuration value applied as `max_retries` on the `dev_story` node at graph load time,
so that the graph executor enforces the same review cycle limit as the existing linear `ImplementationOrchestrator`, maintaining behavioral parity.

## Acceptance Criteria

### AC1: maxReviewCycles=2 Sets dev_story max_retries=2
**Given** a parsed SDLC pipeline graph and `maxReviewCycles=2` in the orchestrator config
**When** `applyConfigToGraph(graph, { maxReviewCycles: 2 })` is called
**Then** `graph.nodes.get('dev_story')!.maxRetries === 2` (1 initial attempt + 2 retries = 3 total)

### AC2: maxReviewCycles=0 Sets dev_story max_retries=0
**Given** a parsed SDLC pipeline graph and `maxReviewCycles=0` in the orchestrator config
**When** `applyConfigToGraph(graph, { maxReviewCycles: 0 })` is called
**Then** `graph.nodes.get('dev_story')!.maxRetries === 0` (no retries — one attempt only)

### AC3: Non-dev_story Nodes Are Not Modified
**Given** a parsed SDLC pipeline graph with nodes `analysis`, `planning`, `create_story`, `code_review`
**When** `applyConfigToGraph(graph, { maxReviewCycles: 5 })` is called
**Then** none of those nodes have their `maxRetries` value changed (only `dev_story` is patched)

### AC4: Missing dev_story Node Throws a Clear Error
**Given** a graph that does not contain a node with id `'dev_story'`
**When** `applyConfigToGraph(graph, { maxReviewCycles: 2 })` is called
**Then** it throws an `Error` with message `"applyConfigToGraph: graph does not contain a 'dev_story' node"`

### AC5: GraphOrchestrator Calls applyConfigToGraph Before Execution
**Given** a `GraphOrchestrator` instance configured with `maxReviewCycles=3`
**When** `orchestrator.run()` is invoked
**Then** the parsed SDLC graph has its `dev_story` node's `maxRetries` patched to `3` before any story graph instance executes

### AC6: Behavioral Parity — Retry Count Matches maxReviewCycles Semantics
**Given** `maxReviewCycles=2` applied to the graph via `applyConfigToGraph`
**When** the graph executor runs with a `dev_story` handler that fails twice then succeeds
**Then** the executor exhausts retries exactly on the third attempt — matching the existing `ImplementationOrchestrator` behavior where `maxReviewCycles=2` allows 3 total attempts

### AC7: applyConfigToGraph Is Exported from the sdlc Orchestrator Module
**Given** the implementation is complete
**When** consumers import from `@substrate-ai/sdlc`
**Then** `applyConfigToGraph` is accessible via `packages/sdlc/src/orchestrator/graph-orchestrator.ts` and re-exported from `packages/sdlc/src/index.ts`

## Tasks / Subtasks

- [ ] Task 1: Implement `applyConfigToGraph` in graph-orchestrator.ts (AC: #1, #2, #3, #4)
  - [ ] Add an `ApplyConfigOptions` interface: `{ maxReviewCycles: number }`
  - [ ] Implement `export function applyConfigToGraph(graph: Graph, options: ApplyConfigOptions): void`
  - [ ] Retrieve `graph.nodes.get('dev_story')` — throw `Error("applyConfigToGraph: graph does not contain a 'dev_story' node")` if absent
  - [ ] Set `devStoryNode.maxRetries = options.maxReviewCycles` (1:1 mapping — both represent retry count, not total attempts)
  - [ ] Leave all other nodes untouched

- [ ] Task 2: Integrate applyConfigToGraph into GraphOrchestrator.run() (AC: #5)
  - [ ] Locate the graph-loading step inside `GraphOrchestrator.run()` (created in story 43-7)
  - [ ] After `parseGraph(dotSource)` returns the `Graph` object and before any story graph instance executes, call `applyConfigToGraph(graph, { maxReviewCycles: this.config.maxReviewCycles })`
  - [ ] Confirm the single patched `Graph` instance is shared across all story graph instances for the run (no re-parsing per story)

- [ ] Task 3: Write unit tests for applyConfigToGraph (AC: #1, #2, #3, #4)
  - [ ] Create or extend `packages/sdlc/src/orchestrator/__tests__/graph-orchestrator.test.ts`
  - [ ] Test: `applyConfigToGraph` with `maxReviewCycles=2` → `dev_story.maxRetries === 2`
  - [ ] Test: `applyConfigToGraph` with `maxReviewCycles=0` → `dev_story.maxRetries === 0`
  - [ ] Test: `applyConfigToGraph` with high value (e.g. `maxReviewCycles=10`) → `dev_story.maxRetries === 10`
  - [ ] Test: other node `maxRetries` values unchanged after `applyConfigToGraph`
  - [ ] Test: graph missing `dev_story` node → throws `Error` with the prescribed message

- [ ] Task 4: Write integration test for GraphOrchestrator applying config (AC: #5, #6)
  - [ ] In the same test file, add a test that constructs a minimal `GraphOrchestrator` with `maxReviewCycles=3` and a mock graph loader
  - [ ] Assert that after `run()` is called (or after the parse-and-patch step is triggered), the `dev_story` node in the loaded graph has `maxRetries === 3`
  - [ ] Optionally: test the retry count by wiring a mock `sdlc.dev-story` handler that fails twice then succeeds, confirming the executor makes exactly 3 total calls

- [ ] Task 5: Export and build verification (AC: #7)
  - [ ] Ensure `applyConfigToGraph` and `ApplyConfigOptions` are exported from `packages/sdlc/src/orchestrator/graph-orchestrator.ts`
  - [ ] Add re-export from `packages/sdlc/src/index.ts` if not already covered by the orchestrator barrel
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors, no circular dependencies
  - [ ] Run `npm run test:fast` — all new tests pass, no regressions in existing sdlc or factory tests

## Dev Notes

### Architecture Constraints

- **ADR-003 (no cross-package coupling)**: `graph-orchestrator.ts` lives in `packages/sdlc/src/orchestrator/` and may import `Graph` and `GraphNode` types from `@substrate-ai/factory`. This is the permitted exception: the SDLC package may import *types* from factory (for structural compatibility) but not *implementations* that would create a runtime circular dependency. Verify `@substrate-ai/factory` is listed as a `dependency` (not `devDependency`) in `packages/sdlc/package.json` — if not, check whether the import is available via the monorepo workspace path resolution.
- **Immutable contract of `Graph.nodes`**: `Graph.nodes` is a `Map<string, GraphNode>`. The `GraphNode` interface is defined in `packages/factory/src/graph/types.ts`. The `maxRetries` field is a plain `number`. Direct mutation (`node.maxRetries = value`) is the correct approach since the `Graph` object is already a concrete in-memory value — no copy is needed for a single-run pipeline.
- **`maxReviewCycles` semantics**: In the existing `ImplementationOrchestrator`, `maxReviewCycles` is the number of *additional* code-review+fix cycles allowed after the first attempt. This maps directly to `max_retries` in the graph engine (`maxRetries` on `GraphNode`), where `maxRetries` is the number of *additional* retry attempts. A direct 1:1 assignment is correct.
- **Graph instance lifecycle**: The SDLC pipeline graph is parsed once per `GraphOrchestrator.run()` call and shared across all concurrent story executions within that run. `applyConfigToGraph` must be called on the graph *after* `parseGraph()` and *before* story graph instances start executing.
- **DOT graph hardcoded default**: The current `sdlc-pipeline.dot` contains `dev_story [..., max_retries=2]`. After story 43-8, the DOT graph's hardcoded value acts only as a *fallback* (when the graph-based path is used without config injection). At runtime, `applyConfigToGraph` always overwrites it. This is intentional — the DOT file serves as documentation of the default while the config drives behavior.

### File Paths

- **Modify**: `packages/sdlc/src/orchestrator/graph-orchestrator.ts` — add `applyConfigToGraph` function and `ApplyConfigOptions` interface; call it in `GraphOrchestrator.run()` after graph parse
- **New or extend test**: `packages/sdlc/src/orchestrator/__tests__/graph-orchestrator.test.ts` — unit tests for `applyConfigToGraph` + integration test for orchestrator config wiring
- **Modify (if needed)**: `packages/sdlc/src/index.ts` — add re-export of `applyConfigToGraph` and `ApplyConfigOptions`

### Implementation Sketch

```typescript
// packages/sdlc/src/orchestrator/graph-orchestrator.ts

import type { Graph } from '@substrate-ai/factory'

export interface ApplyConfigOptions {
  maxReviewCycles: number
}

/**
 * Patches the loaded SDLC pipeline graph to reflect runtime configuration.
 *
 * Currently maps `maxReviewCycles` → `dev_story.maxRetries` (1:1 mapping).
 * Both values represent the number of *additional* retry attempts (not total).
 *
 * Must be called after parseGraph() and before any story graph instance runs.
 */
export function applyConfigToGraph(graph: Graph, options: ApplyConfigOptions): void {
  const devStoryNode = graph.nodes.get('dev_story')
  if (!devStoryNode) {
    throw new Error("applyConfigToGraph: graph does not contain a 'dev_story' node")
  }
  devStoryNode.maxRetries = options.maxReviewCycles
}

// Inside GraphOrchestrator.run():
// const graph = parseGraph(dotSource)       // from story 43-7
// applyConfigToGraph(graph, { maxReviewCycles: this.config.maxReviewCycles })
// // ... then dispatch story graph instances
```

### Import Pattern

```typescript
// In graph-orchestrator.ts — both factory type import and parseGraph are permitted
import type { Graph } from '@substrate-ai/factory'
import { parseGraph } from '@substrate-ai/factory'
```

The `Graph` type import from `@substrate-ai/factory` is allowed in the SDLC orchestrator because:
1. The graph engine (factory) is a dependency of the SDLC orchestrator — not a circular relationship
2. `graph-orchestrator.ts` is the composition point where SDLC logic *drives* the graph engine
3. The SDLC handlers (`sdlc.phase`, `sdlc.dev-story`, etc.) still do not import from factory — that boundary is preserved

### Testing Requirements

- **Framework**: Vitest (same as all sdlc package tests in `packages/sdlc/src/`)
- **Mock pattern for graph**: Use `parseGraph` from `@substrate-ai/factory` with the real `sdlc-pipeline.dot` DOT source (read via `fs.readFileSync`) — this ensures the test runs against the actual graph definition. Alternative: construct a minimal `Graph`-shaped object with a `nodes` Map containing only `dev_story` for pure unit tests.
- **DOT source path**: `packages/sdlc/graphs/sdlc-pipeline.dot` — load relative to monorepo root or via `path.resolve(__dirname, '../../graphs/sdlc-pipeline.dot')`
- **No vi.mock needed**: `applyConfigToGraph` is a pure function accepting a `Graph` object — inject directly in tests
- **Test file**: `packages/sdlc/src/orchestrator/__tests__/graph-orchestrator.test.ts`
- **Run**: `npm run test:fast` from monorepo root; confirm zero failures

### Context Keys Reference

No context keys are read or written by `applyConfigToGraph`. This function operates on the graph structure only, not on per-story `IGraphContext` values.

### Behavioral Parity Reference

| `maxReviewCycles` (OrchestratorConfig) | `dev_story.maxRetries` (GraphNode) | Total dev-story attempts |
|---|---|---|
| 0 | 0 | 1 (no retries) |
| 1 | 1 | 2 |
| 2 | 2 | 3 (current default) |
| 3 | 3 | 4 |

## Interface Contracts

- **Import**: `Graph` type @ `packages/factory/src/graph/types.ts` (from `@substrate-ai/factory`) — the `Graph.nodes` Map is mutated in place
- **Import**: `parseGraph` @ `packages/factory/src/graph/parser.ts` (from `@substrate-ai/factory`) — used in `GraphOrchestrator.run()` to parse `sdlc-pipeline.dot`
- **Export**: `applyConfigToGraph` @ `packages/sdlc/src/orchestrator/graph-orchestrator.ts` (consumed by story 43-9 — event compatibility, and story 43-10 — `--engine` flag wiring)
- **Export**: `ApplyConfigOptions` @ `packages/sdlc/src/orchestrator/graph-orchestrator.ts` (consumed by story 43-10)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-22: Story created for Epic 43, Phase A — SDLC Pipeline as Graph
