# Story 42.3: Chained Edges, Subgraph Flattening, and Default Blocks

## Story

As a graph engine consumer,
I want the DOT parser to correctly expand chained edges, flatten subgraphs into node class assignments, and apply `node [...]` / `edge [...]` default attribute blocks,
so that pipelines authored with idiomatic DOT syntax parse into a fully populated `Graph` model ready for validation and execution.

## Acceptance Criteria

### AC1: Chained Edge Expansion
**Given** a DOT statement `A -> B -> C [label="x"]`
**When** `parseGraph(dotSource)` is called
**Then** two `GraphEdge` objects are produced — `A→B` and `B→C` — each with `label: "x"` copied to both edges (per GE-P5).

### AC2: Node Default Block Attribute Inheritance
**Given** `node [shape=diamond, max_retries=3]` appears before a node with no explicit shape or max_retries
**When** parsed
**Then** the node resolves `shape` to `"diamond"` and `maxRetries` to `3` from the default block, not the hard-coded defaults (per GE-P6).

### AC3: Subgraph Flattening with Class Derivation
**Given** `subgraph cluster_loop { label="Loop A"; node_x; node_y }` in DOT
**When** parsed
**Then** `node_x` and `node_y` are present as top-level `GraphNode` objects with `class: "loop-a"` derived by lowercasing and hyphenating the subgraph `label` attribute (per GE-P7); subgraphs themselves are NOT preserved as first-class objects in the `Graph` model.

### AC4: Edge Default Block Attribute Inheritance
**Given** `edge [weight=5, fidelity=summary]` appears before edges with no explicit weight or fidelity
**When** parsed
**Then** those edges inherit `weight: 5` and `fidelity: "summary"` from the default block; edges with explicit overrides keep their own values.

### AC5: `outgoingEdges` Graph Helper
**Given** a `Graph` object produced by `parseGraph()`
**When** `graph.outgoingEdges(nodeId)` is called with a valid node ID
**Then** it returns the array of all `GraphEdge` objects where `edge.sourceId === nodeId`; calling with an unknown node ID returns an empty array.

### AC6: Default Block Scoping — Later Block Overrides Earlier
**Given** two sequential `node [shape=box]` and `node [shape=ellipse]` default blocks followed by a node with no explicit shape
**When** parsed
**Then** the node resolves `shape` to `"ellipse"` — the later default block wins for subsequently declared nodes.

### AC7: All Unit Tests Pass
**Given** the parser implementation after this story
**When** `npm run test:fast` is run from the repo root
**Then** the output contains the "Test Files" summary line, all new tests for chained edges / subgraph flattening / default blocks pass, and no previously passing tests regress. [PRD: GE-P5, GE-P6, GE-P7]

## Tasks / Subtasks

- [ ] Task 1: Read ts-graphviz AST structure for edge chains, subgraphs, and attribute statements (AC: #1, #2, #3, #4)
  - [ ] Read `packages/factory/package.json` and confirm `ts-graphviz` version installed (added in story 42-1)
  - [ ] Read `packages/factory/src/graph/parser.ts` in full (built in stories 42-1 and 42-2)
  - [ ] Read `packages/factory/src/graph/types.ts` in full (built in stories 42-1 and 42-2)
  - [ ] Check ts-graphviz type definitions for `EdgeStatement`, `NodeAttributeStatement`, `EdgeAttributeStatement`, and `Subgraph` — run `cat node_modules/ts-graphviz/lib/types/index.d.ts` or equivalent to understand how chained edges and attribute blocks surface in the AST

- [ ] Task 2: Implement chained edge expansion in the parser (AC: #1)
  - [ ] In `packages/factory/src/graph/parser.ts`, find or add the function that converts ts-graphviz `EdgeStatement` nodes into `GraphEdge` objects
  - [ ] When an `EdgeStatement` has more than two targets (e.g., `[A, B, C]`), expand it into `N-1` pairwise `GraphEdge` objects: `A→B`, `B→C`, etc.
  - [ ] Copy the edge-level attributes from the original `EdgeStatement` onto each generated pairwise edge
  - [ ] Write a unit test: parse `digraph { A -> B -> C [label="x"] }` and assert `graph.edges` has exactly two edges with the correct source/target and `label: "x"` on both

- [ ] Task 3: Implement `node [...]` default block application (AC: #2, #6)
  - [ ] In the parser's AST traversal, detect `NodeAttributeStatement` entries (ts-graphviz surfaces these as attribute statements with kind `"node"`)
  - [ ] Maintain a mutable `currentNodeDefaults: Partial<GraphNodeAttributes>` that is updated each time a `node [...]` block is encountered; later blocks overwrite earlier blocks for the same attribute key
  - [ ] When constructing a `GraphNode`, merge `currentNodeDefaults` under the explicit node attributes (explicit wins over default)
  - [ ] Write unit tests for: (a) a default block that sets `shape=diamond` and is inherited by a node, (b) two sequential default blocks where the second wins, (c) an explicit node attribute overriding the default

- [ ] Task 4: Implement `edge [...]` default block application (AC: #4)
  - [ ] Similarly detect `EdgeAttributeStatement` entries in the AST traversal
  - [ ] Maintain a mutable `currentEdgeDefaults: Partial<GraphEdgeAttributes>` updated on each `edge [...]` block
  - [ ] When constructing a `GraphEdge` (including expanded pairwise edges from Task 2), merge `currentEdgeDefaults` under explicit edge attributes
  - [ ] Write unit tests for: (a) `edge [weight=5]` inherited by a subsequent edge, (b) an explicit edge attribute overriding the default, (c) fidelity type-casting via the edge default block

- [ ] Task 5: Implement subgraph flattening with class derivation (AC: #3)
  - [ ] In the AST traversal, detect `Subgraph` nodes in ts-graphviz output (they may appear as nested statement lists)
  - [ ] Extract the subgraph's `label` attribute (if present); derive `className` by: lowercasing the label, replacing spaces with hyphens, stripping non-alphanumeric characters except hyphens (e.g., `"Loop A"` → `"loop-a"`)
  - [ ] For each `NodeStatement` inside the subgraph, assign `class: className` on the resulting `GraphNode` (do not overwrite an explicitly set `class` attribute)
  - [ ] Recursively handle nested subgraphs — inner subgraph label wins over outer for class assignment
  - [ ] Do NOT add `Subgraph` objects to `graph.nodes`; only the flattened `GraphNode` objects belong in the node map
  - [ ] Write unit tests for: (a) `cluster_loop` subgraph with `label="Loop A"` produces class `"loop-a"`, (b) node with explicit `class="custom"` inside a subgraph keeps its explicit class, (c) subgraph without a label produces no class assignment

- [ ] Task 6: Add `outgoingEdges(nodeId)` helper to the `Graph` model (AC: #5)
  - [ ] In `packages/factory/src/graph/types.ts`, add `outgoingEdges(nodeId: string): GraphEdge[]` to the `Graph` type definition
  - [ ] In `packages/factory/src/graph/parser.ts` (where the `Graph` object is constructed), implement `outgoingEdges` by filtering `this.edges` for entries where `edge.sourceId === nodeId`
  - [ ] Write unit tests: (a) `outgoingEdges('A')` returns the two edges from `A→B` and `A→C`, (b) `outgoingEdges('unknown')` returns `[]`

- [ ] Task 7: Build verification and full test run (AC: #7)
  - [ ] Verify no vitest instance is running: `pgrep -f vitest` returns nothing
  - [ ] Run `npm run build` from the repo root (or `npm run build` inside `packages/factory/`) and confirm exit code 0 and zero TypeScript errors
  - [ ] Run `npm run test:fast` from the repo root (timeout: 300000ms, foreground, do NOT pipe output)
  - [ ] Confirm output contains "Test Files" summary line and all new tests pass with zero failures

## Dev Notes

### Architecture Constraints
- **Target file**: `packages/factory/src/graph/parser.ts` — extend the parser built in stories 42-1 and 42-2; do NOT create a new file
- **Target file**: `packages/factory/src/graph/types.ts` — add `outgoingEdges()` to the `Graph` interface/class
- **Test location**: `packages/factory/src/graph/__tests__/parser-chaining.test.ts` (new) — keep this story's tests in a dedicated file; do not mix with earlier story tests
- **ESM `.js` extensions**: all intra-package imports in `packages/factory/src/` must use `.js` extensions (TypeScript resolves to `.ts` at compile time via `moduleResolution: "NodeNext"`)
- **No imports from monolith `src/`** — `packages/factory` must be self-contained; only import from `@substrate-ai/core`, `@substrate-ai/sdlc`, Node built-ins, or local package paths
- **ts-graphviz dependency** — already added in story 42-1 to `packages/factory/package.json`; import from `ts-graphviz`; do NOT import from `@ts-graphviz/core` unless ts-graphviz re-exports it

### ts-graphviz AST Key Types
The following ts-graphviz AST node kinds are relevant to this story. Read the installed type definitions to confirm exact field names before implementing:

```typescript
// Edge statement with chained targets — e.g., A -> B -> C [label="x"]
// ts-graphviz surfaces this as an EdgeStatement whose `targets` array has 3 entries
// The parser must loop over targets[i] -> targets[i+1] to produce pairwise edges

// Attribute defaults — ts-graphviz surfaces node/edge defaults as AttributeStatement
// with `kind: 'node'` or `kind: 'edge'` and an `attributes` map

// Subgraphs — ts-graphviz surfaces these as Subgraph AST nodes nested inside the
// graph's `statements` array; they contain their own `statements` list
```

### Class Derivation Algorithm
```typescript
// Convert subgraph label to CSS-style class name
function deriveClass(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/g, '-')       // spaces → hyphens
    .replace(/[^a-z0-9-]/g, '') // strip non-alphanumeric except hyphen
}
// "Loop A" → "loop-a"
// "Phase 1: Init" → "phase-1-init"
// "cluster_loop" (fallback to subgraph id if no label) → implementation choice, document it
```

### Default Block Scoping
Default blocks in DOT apply to nodes/edges declared **after** the block, not before. The parser must process statements in declaration order. If a node is declared before the default block, it does NOT inherit that default — this is standard DOT semantics.

### `outgoingEdges()` Pattern
```typescript
// Graph interface extension in types.ts
export interface Graph {
  // ... existing fields from stories 42-1/42-2 ...
  outgoingEdges(nodeId: string): GraphEdge[]
}

// Implementation in the Graph object constructed by parseGraph()
outgoingEdges(nodeId: string): GraphEdge[] {
  return this.edges.filter(e => e.sourceId === nodeId)
}
```

### Key Files to Read Before Starting
- `packages/factory/src/graph/parser.ts` — full source built by stories 42-1 and 42-2 (read before writing any code)
- `packages/factory/src/graph/types.ts` — current `Graph`, `GraphNode`, `GraphEdge` type definitions
- `packages/factory/src/graph/__tests__/` — existing test files from 42-1 and 42-2 (understand test patterns and vitest import style in use)
- `packages/factory/package.json` — confirm `ts-graphviz` version and test script configuration
- `node_modules/ts-graphviz/lib/` or `node_modules/ts-graphviz/dist/` — TypeScript type definitions for AST structure (especially `EdgeStatement`, `AttributeStatement`, `Subgraph`)

### Testing Requirements
- Use `vitest` (already configured in the repo)
- Do NOT run tests concurrently — verify `pgrep -f vitest` returns nothing before running
- Run `npm run test:fast` from the **repo root** (not inside `packages/factory/`) — tests are discovered across the monorepo
- Do NOT pipe test output through `head`, `grep`, `tail`, or any command — must see the "Test Files" summary line
- Minimum test coverage for this story:
  - 2 tests for chained edge expansion (happy path + attribute propagation)
  - 3 tests for node default blocks (inherit, override, sequential blocks)
  - 2 tests for edge default blocks (inherit, override)
  - 3 tests for subgraph class derivation (with label, without label, explicit class wins)
  - 2 tests for `outgoingEdges()` (happy path, unknown node)

## Interface Contracts

- **Export**: `Graph.outgoingEdges` @ `packages/factory/src/graph/types.ts` (consumed by edge selector story 42-12)
- **Import**: `GraphNode`, `GraphEdge`, `Graph`, `FidelityMode` @ `packages/factory/src/graph/types.ts` (from story 42-2)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-22: Story created for Epic 42 (Graph Engine Foundation — Parser, Validator, Executor, Handlers)
