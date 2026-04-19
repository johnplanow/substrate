# Story 42-1: ts-graphviz Dependency and DOT Parser Foundation

## Story

As a graph engine consumer,
I want a `parseGraph(dotSource)` function that converts DOT source into a typed `Graph` model,
so that subsequent engine stories (validator, executor, handlers) have a well-typed graph object to work with.

## Acceptance Criteria

### AC1: Graph-Level Attribute Extraction
**Given** a DOT digraph string with `graph [goal="Build app", label="My Pipeline", default_max_retries=2]`
**When** `parseGraph(dotSource)` is called
**Then** it returns a `Graph` object with `goal`, `label`, and `defaultMaxRetries` populated correctly

### AC2: ts-graphviz Used for Parsing
**Given** the parser uses `ts-graphviz`'s `fromDOT()` method
**When** a syntactically valid DOT string is parsed
**Then** it produces an AST that the parser transforms into the `Graph` model (no custom DOT tokenizer)

### AC3: All Graph-Level Attributes Are Accessible
**Given** a DOT string with graph-level attributes `model_stylesheet`, `retry_target`, `fallback_retry_target`, `default_fidelity`
**When** `parseGraph(dotSource)` is called
**Then** all attributes are accessible on the returned `Graph` object with correct camelCase field names (`modelStylesheet`, `retryTarget`, `fallbackRetryTarget`, `defaultFidelity`)

### AC4: Malformed DOT Throws Descriptive Error
**Given** a malformed DOT string (e.g., unterminated attribute block, missing `{`)
**When** `parseGraph()` is called
**Then** it throws an error with a descriptive message indicating the parse failure (wrapping the underlying ts-graphviz error)

### AC5: Comments Are Stripped
**Given** DOT source containing `//` line comments and `/* */` block comments
**When** `parseGraph()` is called
**Then** comments are stripped and do not affect the parsed graph (ts-graphviz handles this natively)

### AC6: Unit Tests Pass
**Given** the parser implementation
**When** `npm run test:fast` runs
**Then** all unit tests for the parser and types pass with no failures

## Tasks / Subtasks

- [ ] Task 1: Add ts-graphviz dependency (AC: #2)
  - [ ] Add `"ts-graphviz": "^2.1.0"` (or latest stable) to `packages/factory/package.json` under `dependencies`
  - [ ] Run `npm install` from the monorepo root to update lockfile
  - [ ] Verify TypeScript can import `{ fromDOT }` from `ts-graphviz` without type errors

- [ ] Task 2: Create `src/graph/types.ts` with all core type definitions (AC: #1, #3)
  - [ ] Define `StageStatus`, `FidelityMode` union types (re-export `StageStatus` and `Outcome` from `events.ts` for consistency — or define locally and re-export from `events.ts`)
  - [ ] Define `GraphNode` interface with all 17 attributes (camelCase): `id`, `label`, `shape`, `type`, `prompt`, `maxRetries`, `goalGate`, `retryTarget`, `fallbackRetryTarget`, `fidelity`, `threadId`, `class`, `timeout`, `llmModel`, `llmProvider`, `reasoningEffort`, `autoStatus`, `allowPartial`, `attributes`
  - [ ] Define `GraphEdge` interface: `fromNode`, `toNode`, `label`, `condition`, `weight`, `fidelity`, `threadId`, `loopRestart`
  - [ ] Define `Graph` interface: `id`, `goal`, `label`, `modelStylesheet`, `defaultMaxRetries`, `retryTarget`, `fallbackRetryTarget`, `defaultFidelity`, `nodes: Map<string, GraphNode>`, `edges: GraphEdge[]`, `outgoingEdges(nodeId: string): GraphEdge[]`, `startNode(): GraphNode`, `exitNode(): GraphNode`
  - [ ] Define `GraphContext`, `Checkpoint`, `CodergenBackend`, `NodeHandler`, `ValidationDiagnostic`, `GraphValidator`, `LintRule` interfaces (stubs for now — to be filled by later stories)
  - [ ] Export all types from `types.ts`

- [ ] Task 3: Implement `src/graph/parser.ts` with `parseGraph()` (AC: #1, #2, #3, #4, #5)
  - [ ] Import `fromDOT` from `ts-graphviz` using ESM import with `.js` extension: `import { fromDOT } from 'ts-graphviz'`
  - [ ] Implement `parseGraph(dotSource: string): Graph` that calls `fromDOT(dotSource)` in a try/catch and rethrows parse errors with prefix `"DOT parse error: "`
  - [ ] Implement `extractGraphAttributes(ast)` to read `graph [...]` attributes into `Graph` fields, mapping snake_case DOT attributes to camelCase TypeScript fields: `goal`, `label`, `model_stylesheet→modelStylesheet`, `default_max_retries→defaultMaxRetries`, `retry_target→retryTarget`, `fallback_retry_target→fallbackRetryTarget`, `default_fidelity→defaultFidelity`
  - [ ] Implement `startNode()` method: find node with `shape=Mdiamond` or `type=start`
  - [ ] Implement `exitNode()` method: find node with `shape=Msquare` or `type=exit`
  - [ ] Implement `outgoingEdges(nodeId)` method: filter `graph.edges` by `fromNode === nodeId`
  - [ ] In this story, `nodes` can be an empty `Map` and `edges` can be `[]` (node/edge extraction is 42-2); only graph-level attributes are extracted here
  - [ ] Export `parseGraph` as named export

- [ ] Task 4: Write unit tests in `src/graph/__tests__/parser.test.ts` (AC: #1, #2, #3, #4, #5, #6)
  - [ ] Test AC1: Parse digraph with `goal`, `label`, `default_max_retries` → verify `graph.goal`, `graph.label`, `graph.defaultMaxRetries`
  - [ ] Test AC2: Verify `fromDOT` is called (structural test — ensure no custom tokenizer is used by inspecting that valid DOT with various syntaxes parses without error)
  - [ ] Test AC3: Parse digraph with all 5 optional graph-level attributes (`model_stylesheet`, `retry_target`, `fallback_retry_target`, `default_fidelity`) → verify all fields present on returned Graph
  - [ ] Test AC4: Pass malformed DOT (e.g., `"digraph { [missing_node"`) → verify thrown error message starts with `"DOT parse error:"`
  - [ ] Test AC5: Parse DOT with `// line comment` and `/* block comment */` → verify graph parses cleanly
  - [ ] Test defaults: Parse a bare `digraph {}` → verify `defaultMaxRetries === 0`, `goal === ""`, `modelStylesheet === ""`, `defaultFidelity === ""`
  - [ ] Use `describe`/`it`/`expect` from `vitest`; no `beforeEach` needed if tests are self-contained

- [ ] Task 5: Export from package public API (AC: #6)
  - [ ] Add `export * from './graph/types.js'` and `export { parseGraph } from './graph/parser.js'` to `packages/factory/src/index.ts`
  - [ ] Run `npm run build` from monorepo root; confirm TypeScript compiles with zero errors
  - [ ] Run `npm run test:fast` and confirm all new tests pass

## Dev Notes

### Architecture Constraints
- **File paths**: `packages/factory/src/graph/parser.ts`, `packages/factory/src/graph/types.ts`, `packages/factory/src/graph/__tests__/parser.test.ts`
- **Import style**: ESM with `.js` extensions in all relative imports (e.g., `import type { Graph } from './types.js'`)
- **ts-graphviz**: Use `fromDOT()` from `ts-graphviz` — do NOT implement a custom DOT parser (ADR-001)
- **No circular deps**: `packages/factory` references only `packages/core` in tsconfig; never import from `packages/sdlc`
- **Type alignment**: `StageStatus` and `Outcome` are already defined in `src/events.ts` — re-use those types in `types.ts` by importing them from `'./events.js'` rather than redefining them to avoid divergence
- **`Graph` as class or object literal**: Implement `outgoingEdges`, `startNode`, `exitNode` as methods on a plain class (not interface-only) to satisfy the interface contract while allowing the parser to return concrete instances

### DOT Attribute Mapping
```
DOT attribute          → TypeScript field        → Type
---------------------------------------------------------
goal                   → goal                    → string (default "")
label                  → label                   → string (default "")
model_stylesheet       → modelStylesheet         → string (default "")
default_max_retries    → defaultMaxRetries        → number (default 0)
retry_target           → retryTarget             → string (default "")
fallback_retry_target  → fallbackRetryTarget      → string (default "")
default_fidelity       → defaultFidelity          → FidelityMode | "" (default "")
```

### ts-graphviz API Usage
```typescript
import { fromDOT } from 'ts-graphviz'

const ast = fromDOT(dotSource)  // throws SyntaxError on invalid DOT
// ast.attributes.get('goal') → returns AttributeValue | undefined
// ast.id → graph id (or undefined)
```

### Testing Requirements
- **Framework**: Vitest (`describe`, `it`, `expect` from `'vitest'`)
- **Test file location**: `packages/factory/src/graph/__tests__/parser.test.ts`
- **Test runner**: `npm run test:fast` from monorepo root (excludes e2e tests)
- **Coverage**: All 6 ACs must have at least one test case
- **No mocking needed**: `fromDOT` is a pure function; test against real DOT strings

### Scope Boundary
This story covers **graph-level attribute extraction only**. Node and edge attribute extraction is deferred to story 42-2. The `nodes` map will be empty and `edges` will be `[]` after `parseGraph()` returns in this story — that is intentional and not a bug.

## Interface Contracts

- **Export**: `Graph` @ `packages/factory/src/graph/types.ts` (consumed by stories 42-2 through 42-16)
- **Export**: `GraphNode` @ `packages/factory/src/graph/types.ts` (consumed by stories 42-2, 42-4, 42-9–42-14)
- **Export**: `GraphEdge` @ `packages/factory/src/graph/types.ts` (consumed by stories 42-2, 42-6, 42-12)
- **Export**: `FidelityMode` @ `packages/factory/src/graph/types.ts` (consumed by stories 42-2, 42-13)
- **Export**: `parseGraph` @ `packages/factory/src/graph/parser.ts` (consumed by stories 42-4, 42-14, 42-15)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
