# Story 42-2: Node and Edge Attribute Extraction

## Story

As a graph engine consumer,
I want `parseGraph()` to populate the `nodes` map and `edges` array with fully-typed `GraphNode` and `GraphEdge` objects,
so that validator, executor, and handler stories can traverse the graph with correctly-typed, defaulted attribute values.

## Acceptance Criteria

### AC1: All 17 Node Attributes Extracted with Correct Types
**Given** a DOT node declaration with all 17 attributes set (`label`, `shape`, `type`, `prompt`, `max_retries`, `goal_gate`, `retry_target`, `fallback_retry_target`, `fidelity`, `thread_id`, `class`, `timeout`, `llm_model`, `llm_provider`, `reasoning_effort`, `auto_status`, `allow_partial`)
**When** `parseGraph(dotSource)` is called
**Then** the resulting `GraphNode` object has each attribute correctly typed — `string` for label/shape/type/prompt/retryTarget/fallbackRetryTarget/fidelity/threadId/class/llmModel/llmProvider/reasoningEffort; `boolean` for goalGate/autoStatus/allowPartial; `number` for maxRetries/timeout

### AC2: All 6 Edge Attributes Extracted with Correct Types
**Given** a DOT edge declaration with `label`, `condition`, `weight`, `fidelity`, `thread_id`, and `loop_restart` attributes
**When** `parseGraph(dotSource)` is called
**Then** the resulting `GraphEdge` object has each attribute correctly typed — `string` for label/condition/fidelity/threadId; `number` for weight; `boolean` for loopRestart

### AC3: Both Quoted and Unquoted Attribute Values Resolve Correctly
**Given** a DOT node with `shape=box` (unquoted) and `prompt="Implement the feature"` (quoted)
**When** `parseGraph(dotSource)` is called
**Then** both `node.shape === "box"` and `node.prompt === "Implement the feature"` hold true (per PRD GE-P8)

### AC4: Node Default Values Applied When Attributes Are Absent
**Given** a DOT node declaration with no explicit attributes (e.g., `my_node []`)
**When** `parseGraph(dotSource)` is called
**Then** the returned `GraphNode` applies these defaults: `shape="box"`, `maxRetries=graph.defaultMaxRetries`, `goalGate=false`, `autoStatus=true`, `allowPartial=false`, and all unset string fields default to `""`

### AC5: Edge Default Values Applied When Attributes Are Absent
**Given** a DOT edge declaration with no attributes (e.g., `A -> B`)
**When** `parseGraph(dotSource)` is called
**Then** the returned `GraphEdge` applies these defaults: `label=""`, `condition=""`, `weight=0`, `fidelity=""`, `threadId=""`, `loopRestart=false`

### AC6: `parseGraph()` Returns Populated `nodes` Map and `edges` Array
**Given** a DOT graph with 3 nodes and 2 edges
**When** `parseGraph(dotSource)` is called
**Then** `graph.nodes` has exactly 3 entries keyed by node ID and `graph.edges` has exactly 2 entries with correct `fromNode` and `toNode` string values

### AC7: All Unit Tests Pass
**Given** the parser implementation
**When** `npm run test:fast` runs from the monorepo root
**Then** all new unit tests for node/edge attribute extraction pass with no failures, and the "Test Files" summary line confirms success

## Tasks / Subtasks

- [ ] Task 1: Verify and complete GraphNode/GraphEdge type definitions in types.ts (AC: #1, #2)
  - [ ] Read `packages/factory/src/graph/types.ts` to check which of the 17 node attributes were stubbed by story 42-1 — add any missing fields
  - [ ] Confirm `GraphNode` interface has all 17 fields with correct TypeScript types per the DOT Attribute Mapping table in Dev Notes
  - [ ] Confirm `GraphEdge` interface has all 8 fields: `id: string` (optional), `fromNode: string`, `toNode: string`, `label: string`, `condition: string`, `weight: number`, `fidelity: string`, `threadId: string`, `loopRestart: boolean`
  - [ ] Export any newly added/modified types from `packages/factory/src/graph/types.ts`

- [ ] Task 2: Implement node attribute extraction helper in parser.ts (AC: #1, #3, #4)
  - [ ] Read `packages/factory/src/graph/parser.ts` to understand the current `parseGraph()` implementation from 42-1 and how it accesses the ts-graphviz AST
  - [ ] Inspect the ts-graphviz AST structure to confirm the correct API for iterating `ast.nodes` and reading `node.attributes.get(key)` (check `node_modules/ts-graphviz/` types if needed)
  - [ ] Implement `extractNodeAttributes(astNode: unknown, graphDefaultMaxRetries: number): GraphNode` helper function in `parser.ts`
  - [ ] Apply type coercion using the helpers defined in Dev Notes: `coerceBool`, `coerceNumber`, `coerceString`
  - [ ] Map all 17 DOT snake_case attributes to camelCase TypeScript fields per the mapping table, applying defaults when attribute is absent

- [ ] Task 3: Implement edge attribute extraction helper in parser.ts (AC: #2, #3, #5)
  - [ ] Implement `extractEdgeAttributes(fromNodeId: string, toNodeId: string, astEdgeAttributes: unknown): GraphEdge` helper function in `parser.ts`
  - [ ] Map all 6 DOT edge attributes with type coercion per the mapping table in Dev Notes
  - [ ] Apply defaults when attribute is absent: `label=""`, `condition=""`, `weight=0`, `fidelity=""`, `threadId=""`, `loopRestart=false`
  - [ ] Note: Chained edge label propagation (`A -> B -> C [label="x"]` applying the same label to both edges) is deferred to story 42-3 — for this story, each consecutive pair gets a plain `GraphEdge` with the edge-level attributes applied once

- [ ] Task 4: Wire node and edge extraction into parseGraph() (AC: #6)
  - [ ] In `parseGraph()`, after extracting graph-level attributes, iterate over `ast.nodes` (or the equivalent ts-graphviz property) and call `extractNodeAttributes()` for each, inserting results into `graph.nodes` Map keyed by `node.id`
  - [ ] Iterate over `ast.edges` and for each edge, enumerate consecutive target pairs to create `GraphEdge` objects via `extractEdgeAttributes()`, appending to `graph.edges`
  - [ ] Verify `graph.startNode()` and `graph.exitNode()` (implemented in 42-1) now resolve correctly against the populated `nodes` map
  - [ ] Verify `graph.outgoingEdges(nodeId)` returns the correct subset of edges from the populated array

- [ ] Task 5: Write unit tests for node attribute extraction (AC: #1, #3, #4, #6)
  - [ ] Extend `packages/factory/src/graph/__tests__/parser.test.ts` with a `describe('node attribute extraction')` block (do not replace existing tests from 42-1)
  - [ ] Test AC1: DOT node with all 17 attributes set → verify each TypeScript field has the correct type and value (use `typeof` checks alongside value assertions)
  - [ ] Test AC3: DOT node with `shape=box` (unquoted) and `prompt="quoted value"` → verify both resolve correctly
  - [ ] Test AC4 defaults: DOT node with no attributes → verify `shape==="box"`, `goalGate===false`, `autoStatus===true`, `allowPartial===false`, string fields are `""`
  - [ ] Test AC4 maxRetries default: DOT `graph [default_max_retries=3]` with a node that has no `max_retries` → verify `node.maxRetries === 3`
  - [ ] Test AC6: Parse a 3-node, 2-edge graph → `graph.nodes.size === 3` and `graph.edges.length === 2`

- [ ] Task 6: Write unit tests for edge attribute extraction (AC: #2, #3, #5, #6)
  - [ ] Add a `describe('edge attribute extraction')` block in the same test file
  - [ ] Test AC2: DOT edge with all 6 attributes → verify each TypeScript field has the correct type and value
  - [ ] Test AC3: DOT edge with `weight=3` (unquoted number) and `condition="status=pass"` (quoted string) → verify `edge.weight === 3` and `edge.condition === "status=pass"`
  - [ ] Test AC5 defaults: DOT edge `A -> B` with no attributes → verify `label=""`, `condition=""`, `weight===0`, `loopRestart===false`
  - [ ] Test AC6 fromNode/toNode: DOT `A -> B` → verify `edge.fromNode === "A"` and `edge.toNode === "B"`

- [ ] Task 7: Run tests and verify build (AC: #7)
  - [ ] Confirm no vitest instance is currently running: `pgrep -f vitest` must return nothing before proceeding
  - [ ] Run `npm run test:fast` from the monorepo root (do not pipe output through `head`, `tail`, `grep`, or any command)
  - [ ] Verify output contains the "Test Files" summary line and all tests pass with zero failures
  - [ ] If tests fail, diagnose the root cause and fix before marking this task done

## Dev Notes

### Architecture Constraints
- **File paths**: Extend `packages/factory/src/graph/parser.ts` and `packages/factory/src/graph/types.ts` (both established in story 42-1; do not create new files for these)
- **Test file**: `packages/factory/src/graph/__tests__/parser.test.ts` — extend in-place; do not create a new file or replace existing tests
- **Import style**: All relative intra-package imports must use ESM `.js` extensions: `import type { GraphNode } from './types.js'`
- **No circular deps**: `packages/factory` may import from `packages/core`; never import from `packages/sdlc`
- **ts-graphviz API**: Use the AST returned by `fromDOT()` — access attributes via the `.attributes.get(key)` API, not direct property access. Before implementing, inspect the ts-graphviz type definitions under `node_modules/ts-graphviz/` to confirm the exact property names for iterating nodes and edges on the root AST graph
- **Scope boundary**: Simple consecutive-pair edge expansion only; cross-pair attribute propagation and subgraph flattening are handled in story 42-3
- **Test execution rules**: Never run tests concurrently; never pipe vitest output; always look for "Test Files" line to confirm results

### DOT Attribute Mapping: Nodes
```
DOT attribute (snake_case)    → TypeScript field (camelCase)   → Type      → Default
label                          → label                           → string    → ""
shape                          → shape                           → string    → "box"
type                           → type                            → string    → ""
prompt                         → prompt                          → string    → ""
max_retries                    → maxRetries                      → number    → graph.defaultMaxRetries
goal_gate                      → goalGate                        → boolean   → false
retry_target                   → retryTarget                     → string    → ""
fallback_retry_target          → fallbackRetryTarget             → string    → ""
fidelity                       → fidelity                        → string    → ""
thread_id                      → threadId                        → string    → ""
class                          → class                           → string    → ""
timeout                        → timeout                         → number    → 0
llm_model                      → llmModel                        → string    → ""
llm_provider                   → llmProvider                     → string    → ""
reasoning_effort               → reasoningEffort                 → string    → ""
auto_status                    → autoStatus                      → boolean   → true
allow_partial                  → allowPartial                    → boolean   → false
```

### DOT Attribute Mapping: Edges
```
DOT attribute (snake_case)    → TypeScript field (camelCase)   → Type      → Default
label                          → label                           → string    → ""
condition                      → condition                       → string    → ""
weight                         → weight                          → number    → 0
fidelity                       → fidelity                        → string    → ""
thread_id                      → threadId                        → string    → ""
loop_restart                   → loopRestart                     → boolean   → false
```

### Type Coercion Helpers
Implement these private helpers inside `parser.ts`:

```typescript
function coerceBool(value: string | boolean | undefined, defaultVal: boolean): boolean {
  if (value === undefined) return defaultVal
  if (typeof value === 'boolean') return value
  return value === 'true'
}

function coerceNumber(value: string | number | undefined, defaultVal: number): number {
  if (value === undefined) return defaultVal
  if (typeof value === 'number') return value
  const n = Number(value)
  return isNaN(n) ? defaultVal : n
}

function coerceString(value: string | undefined, defaultVal: string): string {
  return value ?? defaultVal
}
```

### Key Files to Read Before Starting
- `packages/factory/src/graph/types.ts` — check which `GraphNode`/`GraphEdge` fields exist vs which need to be added from 42-1's stubs
- `packages/factory/src/graph/parser.ts` — understand current `parseGraph()` and how ts-graphviz AST is traversed
- `packages/factory/src/graph/__tests__/parser.test.ts` — existing 42-1 tests (extend, do not replace)
- `packages/factory/package.json` — verify `ts-graphviz` dependency is present from 42-1
- `node_modules/ts-graphviz/` (types or README) — confirm the API for iterating nodes/edges on the AST returned by `fromDOT()`

### Testing Requirements
- **Framework**: Vitest (`describe`, `it`, `expect` from `'vitest'`)
- **Test file**: `packages/factory/src/graph/__tests__/parser.test.ts` (extend existing file)
- **Test runner**: `npm run test:fast` from monorepo root
- **NEVER pipe test output** — pipes discard the vitest summary line and make results unverifiable
- **NEVER run tests concurrently** — verify `pgrep -f vitest` returns nothing before running
- **Confirm results** by checking for "Test Files" in output — exit code 0 alone is insufficient

## Interface Contracts

- **Import**: `Graph`, `GraphNode`, `GraphEdge`, `FidelityMode` @ `packages/factory/src/graph/types.ts` (from story 42-1)
- **Export** (extended): `GraphNode` @ `packages/factory/src/graph/types.ts` — all 17 node attributes fully typed (consumed by stories 42-3 through 42-16)
- **Export** (extended): `GraphEdge` @ `packages/factory/src/graph/types.ts` — all 6 edge attributes fully typed (consumed by stories 42-3, 42-6, 42-12)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-22: Story created for Epic 42 (Graph Engine Foundation)
