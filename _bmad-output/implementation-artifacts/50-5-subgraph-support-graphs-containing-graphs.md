# Story 50-5: Subgraph Support — Graphs Containing Graphs

## Story

As a pipeline graph author,
I want to define a `subgraph` node that references another `.dot` graph file,
so that I can compose reusable sub-pipelines without duplicating nodes across graphs.

## Acceptance Criteria

### AC1: Subgraph Node Loads, Validates, and Executes Referenced Graph
**Given** a node with `type="subgraph"` and `node.attrs["graph_file"]="sub-pipeline.dot"` (resolved relative to `options.baseDir`)
**When** the subgraph handler executes
**Then** it reads the file via `graphFileLoader`, parses it with `parseGraph`, validates it with `createValidator().validateOrRaise`, executes it via `createGraphExecutor().run`, and returns the sub-executor's outcome status translated back to `OutcomeStatus` (`FAIL` → `FAILURE`, `SUCCESS` → `SUCCESS`, `PARTIAL_SUCCESS` → `PARTIAL_SUCCESS`)

### AC2: Parent Context Snapshot Seeded into Subgraph Execution
**Given** the parent context has keys set by prior nodes (e.g. `storyKey`, `projectRoot`, `factory.lastNodeCostUsd`)
**When** the subgraph handler builds the sub-executor's `GraphExecutorConfig`
**Then** `config.initialContext` equals `{ ...context.snapshot(), 'subgraph._depth': currentDepth + 1 }`, giving the subgraph read access to all parent state and the incremented depth counter

### AC3: Subgraph `contextUpdates` Merged into Parent Context
**Given** the subgraph's final node (typically the exit handler) returns `outcome.contextUpdates: { "subgraph.result": "done", "artifact.path": "/tmp/foo" }`
**When** the subgraph handler receives the sub-executor's `Outcome`
**Then** it calls `context.applyUpdates(outcome.contextUpdates)` on the **parent** context so that those keys are accessible to nodes downstream of the subgraph node in the parent graph

### AC4: Subgraph Goal Gates Evaluated Independently
**Given** the subgraph has nodes with `goalGate=true`
**When** the sub-executor runs the subgraph
**Then** those goal gates are evaluated by the sub-executor's own convergence controller using the subgraph's internal context state, with no interference from the parent executor's goal gate evaluation or convergence state

### AC5: Nested Subgraph Depth Limit Enforced
**Given** `context.getNumber("subgraph._depth", 0)` equals or exceeds `options.maxDepth` (default `5`)
**When** the subgraph handler is invoked
**Then** it returns `{ status: "FAILURE", failureReason: "Subgraph depth limit exceeded (max <N>): node <nodeId>" }` without loading or executing the referenced graph

### AC6: Missing or Unresolvable `graph_file` Attribute Produces FAILURE
**Given** `node.attrs?.["graph_file"]` is absent, an empty string, or the resolved file path cannot be read by `graphFileLoader` (file not found, permission error, etc.)
**When** the subgraph handler attempts to load the file
**Then** it returns `{ status: "FAILURE", failureReason: <descriptive message> }` — it never throws; all errors are caught and converted to a FAILURE outcome

### AC7: Unit Tests Cover All Subgraph Handler Behaviours
**Given** `packages/factory/src/handlers/__tests__/subgraph.test.ts`
**When** `npm run test:fast` runs
**Then** at least 12 `it(...)` cases pass covering: successful execution with context seeding and update merging, depth limit at limit (returns FAILURE), depth below limit (continues), missing `graph_file` attribute, `graphFileLoader` throws (file not found), invalid DOT (parse throws), validator throws, subgraph FAILURE propagated to parent, absolute `graph_file` path used as-is, relative path joined with `baseDir`, `createDefaultRegistry` registers the `subgraph` type

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/handlers/subgraph.ts` — core subgraph handler (AC: #1, #2, #3, #5, #6)
  - [ ] Add imports: `path` from `'node:path'`, `readFile` from `'node:fs/promises'`, `tmpdir` from `'node:os'`, `randomUUID` from `'node:crypto'`
  - [ ] Add imports: `parseGraph` from `'../graph/parser.js'`, `createGraphExecutor` from `'../graph/executor.js'`, `createValidator` from `'../graph/validator.js'`
  - [ ] Add imports: types `GraphNode`, `Graph`, `IGraphContext`, `Outcome` from `'../graph/types.js'`; `NodeHandler` from `'./types.js'`
  - [ ] Export `interface SubgraphHandlerOptions { handlerRegistry: IHandlerRegistry; baseDir: string; maxDepth?: number; graphFileLoader?: (filePath: string) => Promise<string>; logsRoot?: string }`
  - [ ] Export `function createSubgraphHandler(options: SubgraphHandlerOptions): NodeHandler` returning an async handler
  - [ ] Inside the handler: read `const graphFile = node.attrs?.['graph_file']`; if falsy → return `{ status: 'FAILURE', failureReason: \`Subgraph node "${node.id}" is missing required attribute graph_file\` }`
  - [ ] Resolve path: `const filePath = path.isAbsolute(graphFile) ? graphFile : path.join(options.baseDir, graphFile)`
  - [ ] Load file: `const loader = options.graphFileLoader ?? ((fp) => readFile(fp, 'utf-8'))`; wrap in try/catch → return `{ status: 'FAILURE', failureReason: \`Subgraph node "${node.id}": failed to load "${filePath}": ${err.message}\` }` on error
  - [ ] Parse: `let subgraph: Graph; try { subgraph = parseGraph(dotSource) } catch (err) { return { status: 'FAILURE', failureReason: ... } }`
  - [ ] Validate: `try { createValidator().validateOrRaise(subgraph) } catch (err) { return { status: 'FAILURE', failureReason: ... } }`
  - [ ] Depth check: `const currentDepth = context.getNumber('subgraph._depth', 0); const maxDepth = options.maxDepth ?? 5; if (currentDepth >= maxDepth) return { status: 'FAILURE', failureReason: \`Subgraph depth limit exceeded (max ${maxDepth}): node "${node.id}"\` }`
  - [ ] Build sub-executor config: `{ runId: randomUUID(), logsRoot: options.logsRoot ?? tmpdir(), handlerRegistry: options.handlerRegistry, initialContext: { ...context.snapshot(), 'subgraph._depth': currentDepth + 1 } }`
  - [ ] Execute: `const subOutcome = await createGraphExecutor().run(subgraph, subConfig)`
  - [ ] Merge updates: `if (subOutcome.contextUpdates) context.applyUpdates(subOutcome.contextUpdates)`
  - [ ] Convert and return: `{ status: denormalizeStatus(subOutcome.status), contextUpdates: subOutcome.contextUpdates, notes: subOutcome.notes, failureReason: subOutcome.failureReason }` where `denormalizeStatus('FAIL') === 'FAILURE'`, `'SUCCESS'/'PARTIAL_SUCCESS'` pass through, all others → `'FAILURE'`

- [ ] Task 2: Update `packages/factory/src/handlers/types.ts` — add `SubgraphHandlerOptions` (AC: #1)
  - [ ] Add `export interface SubgraphHandlerOptions` with `handlerRegistry: IHandlerRegistry`, `baseDir: string`, `maxDepth?: number`, `graphFileLoader?: (filePath: string) => Promise<string>`, `logsRoot?: string`
  - [ ] Note: `IHandlerRegistry` is already imported at the top of this file; no new imports needed

- [ ] Task 3: Wire `subgraph` type into `packages/factory/src/handlers/registry.ts` (AC: #1, #7)
  - [ ] Import `createSubgraphHandler` from `'./subgraph.js'`
  - [ ] Add `export interface DefaultRegistryOptions extends CodergenHandlerOptions { baseDir?: string }` and change `createDefaultRegistry` signature to `createDefaultRegistry(options?: DefaultRegistryOptions): HandlerRegistry` — this is backward-compatible since `DefaultRegistryOptions extends CodergenHandlerOptions` and the field is optional
  - [ ] Inside `createDefaultRegistry`, add: `registry.register('subgraph', createSubgraphHandler({ handlerRegistry: registry, baseDir: options?.baseDir ?? process.cwd() }))`
  - [ ] Grep registry.ts for any `CodergenHandlerOptions` references in the return type or JSDoc and update accordingly

- [ ] Task 4: Update barrel exports (AC: #7)
  - [ ] In `packages/factory/src/handlers/index.ts`: add `export { createSubgraphHandler } from './subgraph.js'` and `export type { SubgraphHandlerOptions } from './subgraph.js'`
  - [ ] In `packages/factory/src/handlers/index.ts`: export the new `DefaultRegistryOptions` type from `'./registry.js'`
  - [ ] In `packages/factory/src/index.ts`: verify the barrel chain propagates new exports (no changes expected if handlers/index.ts is updated)

- [ ] Task 5: Write unit tests in `packages/factory/src/handlers/__tests__/subgraph.test.ts` (AC: #1–#7)
  - [ ] Import `createSubgraphHandler`, `SubgraphHandlerOptions` from the handler file; import `GraphContext` for building test contexts; import `createDefaultRegistry` from `'../registry.js'`
  - [ ] Helper: `makeCtx(snapshot?: Record<string, unknown>): IGraphContext` — creates a `GraphContext` from a snapshot for easy test setup
  - [ ] Helper: `makeNode(attrs?: Record<string, string>): GraphNode` — creates a minimal node with `type='subgraph'` and the provided attrs
  - [ ] Test: successful execution — `graphFileLoader` returns valid DOT, executor mock returns `{ status: 'SUCCESS', contextUpdates: { 'foo': 'bar' } }` → handler returns `{ status: 'SUCCESS' }` and `context.get('foo')` equals `'bar'`
  - [ ] Test: context seeding — verify `initialContext` passed to executor mock contains all parent context keys plus `subgraph._depth: 1`
  - [ ] Test: depth limit at max (currentDepth = 5, maxDepth = 5) → FAILURE with depth error message
  - [ ] Test: depth below max (currentDepth = 4, maxDepth = 5) → executes normally
  - [ ] Test: custom maxDepth (maxDepth = 2, depth = 2) → FAILURE
  - [ ] Test: missing `graph_file` attr → FAILURE with "missing required attribute graph_file" in failureReason
  - [ ] Test: empty string `graph_file` → FAILURE with same message
  - [ ] Test: `graphFileLoader` throws `Error('ENOENT')` → FAILURE with "failed to load" in failureReason
  - [ ] Test: `parseGraph` is mocked to throw → FAILURE with parse error detail in failureReason (note: mock `parseGraph` module, or use an invalid DOT string if parseGraph is not injectable; use vi.mock if needed)
  - [ ] Test: subgraph executor returns `{ status: 'FAIL' }` → handler returns `{ status: 'FAILURE' }`
  - [ ] Test: absolute `graph_file` path — `graphFileLoader` is called with the absolute path unchanged (not joined with baseDir)
  - [ ] Test: relative `graph_file` path — `graphFileLoader` is called with `path.join(baseDir, graphFile)`
  - [ ] Test: `createDefaultRegistry()` resolves the `subgraph` type without throwing
  - [ ] Run `npm run build` before running tests; then `npm run test:fast` with `timeout: 300000`; NEVER pipe output; confirm "Test Files" summary line

- [ ] Task 6: Run build and full test suite to confirm zero regressions (AC: all)
  - [ ] Run `npm run build` — zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` — confirm "Test Files" summary line with zero failures
  - [ ] Grep for all `createDefaultRegistry` call sites (`grep -rn "createDefaultRegistry" packages/ src/`) and verify none of them break due to the `DefaultRegistryOptions` type change (all existing callers pass `CodergenHandlerOptions`-compatible objects; since `DefaultRegistryOptions extends CodergenHandlerOptions`, no changes are needed at call sites)

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import { parseGraph } from '../graph/parser.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- `subgraph.ts` may import Node.js built-ins (`node:fs/promises`, `node:path`, `node:os`, `node:crypto`) — these are available in Node.js 18+ (the project's minimum target)
- The sub-executor is invoked with **no** `checkpointPath` — subgraphs always execute fresh; resuming a subgraph from checkpoint is out of scope for this story
- Use `vitest` (`describe`, `it`, `expect`, `vi`) — no Jest globals
- Test files belong in `__tests__/` subdirectory co-located with source, using `*.test.ts` naming
- `SubgraphHandlerOptions` may be defined in either `subgraph.ts` or `types.ts` — prefer defining it in `subgraph.ts` alongside the handler (consistent with `FanInHandlerOptions` in `fan-in.ts`)

### New File Paths
```
packages/factory/src/handlers/subgraph.ts                          — SubgraphHandlerOptions, createSubgraphHandler
packages/factory/src/handlers/__tests__/subgraph.test.ts           — unit tests (≥12 test cases)
```

### Modified File Paths
```
packages/factory/src/handlers/registry.ts   — add DefaultRegistryOptions, register 'subgraph' type
packages/factory/src/handlers/index.ts      — add barrel exports for subgraph + DefaultRegistryOptions
packages/factory/src/index.ts               — verify barrel chain (no changes expected)
```

### Key Type Definitions

```typescript
// packages/factory/src/handlers/subgraph.ts

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { parseGraph } from '../graph/parser.js'
import { createGraphExecutor } from '../graph/executor.js'
import { createValidator } from '../graph/validator.js'
import type { GraphNode, Graph, IGraphContext, Outcome } from '../graph/types.js'
import type { NodeHandler, IHandlerRegistry } from './types.js'

export interface SubgraphHandlerOptions {
  /** Registry used to resolve node handlers inside the subgraph. */
  handlerRegistry: IHandlerRegistry
  /** Base directory for resolving relative graph_file paths. */
  baseDir: string
  /** Maximum nested subgraph depth (inclusive). Default: 5. */
  maxDepth?: number
  /**
   * Injectable file loader for testability.
   * Defaults to `(fp) => readFile(fp, 'utf-8')`.
   */
  graphFileLoader?: (filePath: string) => Promise<string>
  /**
   * Root directory for sub-executor checkpoint files.
   * Defaults to `os.tmpdir()`.
   */
  logsRoot?: string
}

/** Converts events.ts StageStatus back to types.ts OutcomeStatus. */
function denormalizeStatus(status: string): Outcome['status'] {
  if (status === 'SUCCESS') return 'SUCCESS'
  if (status === 'PARTIAL_SUCCESS') return 'PARTIAL_SUCCESS'
  return 'FAILURE'
}

export function createSubgraphHandler(options: SubgraphHandlerOptions): NodeHandler {
  return async (node: GraphNode, context: IGraphContext, _graph: Graph): Promise<Outcome> => {
    // Step 1: Validate graph_file attribute
    const graphFile = node.attrs?.['graph_file']
    if (!graphFile) {
      return {
        status: 'FAILURE',
        failureReason: `Subgraph node "${node.id}" is missing required attribute graph_file`,
      }
    }

    // Step 2: Depth guard
    const currentDepth = context.getNumber('subgraph._depth', 0)
    const maxDepth = options.maxDepth ?? 5
    if (currentDepth >= maxDepth) {
      return {
        status: 'FAILURE',
        failureReason: `Subgraph depth limit exceeded (max ${maxDepth}): node "${node.id}"`,
      }
    }

    // Step 3: Resolve file path
    const filePath = path.isAbsolute(graphFile)
      ? graphFile
      : path.join(options.baseDir, graphFile)

    // Step 4: Load file
    const loader = options.graphFileLoader ?? ((fp) => readFile(fp, 'utf-8'))
    let dotSource: string
    try {
      dotSource = await loader(filePath)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        status: 'FAILURE',
        failureReason: `Subgraph node "${node.id}": failed to load "${filePath}": ${msg}`,
      }
    }

    // Step 5: Parse
    let subgraph: Graph
    try {
      subgraph = parseGraph(dotSource)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        status: 'FAILURE',
        failureReason: `Subgraph node "${node.id}": failed to parse "${filePath}": ${msg}`,
      }
    }

    // Step 6: Validate
    try {
      createValidator().validateOrRaise(subgraph)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        status: 'FAILURE',
        failureReason: `Subgraph node "${node.id}": validation failed for "${filePath}": ${msg}`,
      }
    }

    // Step 7: Execute
    const subConfig = {
      runId: randomUUID(),
      logsRoot: options.logsRoot ?? tmpdir(),
      handlerRegistry: options.handlerRegistry,
      initialContext: { ...context.snapshot(), 'subgraph._depth': currentDepth + 1 },
    }
    const subOutcome = await createGraphExecutor().run(subgraph, subConfig)

    // Step 8: Merge context updates back to parent
    if (subOutcome.contextUpdates) {
      context.applyUpdates(subOutcome.contextUpdates)
    }

    // Step 9: Return translated outcome
    return {
      status: denormalizeStatus(subOutcome.status),
      contextUpdates: subOutcome.contextUpdates,
      notes: subOutcome.notes,
      failureReason: subOutcome.failureReason,
    }
  }
}
```

### Registry Extension Pattern

```typescript
// packages/factory/src/handlers/registry.ts — additions

import type { CodergenHandlerOptions } from './codergen-handler.js'
import { createSubgraphHandler } from './subgraph.js'

/** Extended options for createDefaultRegistry — backward-compatible with CodergenHandlerOptions. */
export interface DefaultRegistryOptions extends CodergenHandlerOptions {
  /** Base directory for resolving relative graph_file paths in subgraph nodes. Default: process.cwd() */
  baseDir?: string
}

export function createDefaultRegistry(options?: DefaultRegistryOptions): HandlerRegistry {
  // ... existing registrations ...
  registry.register('subgraph', createSubgraphHandler({
    handlerRegistry: registry,
    baseDir: options?.baseDir ?? process.cwd(),
  }))
  // ...
}
```

### Context Propagation Contract
- **Into subgraph**: `config.initialContext = { ...context.snapshot(), 'subgraph._depth': currentDepth + 1 }` — the subgraph executor seeds its own `GraphContext` from this snapshot, giving the subgraph read access to all parent keys
- **Out of subgraph**: only `outcome.contextUpdates` from the subgraph's final node is merged back; context changes made by intermediate subgraph nodes that are not explicitly propagated in `contextUpdates` do not flow back to the parent
- This is the intended interface contract: the subgraph must explicitly declare its outputs through the exit handler's `contextUpdates`

### StageStatus → OutcomeStatus Conversion
The sub-executor returns `events.ts:Outcome` (with `StageStatus`: `'SUCCESS' | 'FAIL' | 'PARTIAL_SUCCESS' | 'RETRY' | 'SKIPPED'`). The `NodeHandler` return type uses `types.ts:Outcome` (`OutcomeStatus`: `'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE' | 'NEEDS_RETRY' | 'ESCALATE'`). The `denormalizeStatus` helper converts: `'SUCCESS'` → `'SUCCESS'`, `'PARTIAL_SUCCESS'` → `'PARTIAL_SUCCESS'`, all others (`'FAIL'`, `'RETRY'`, `'SKIPPED'`) → `'FAILURE'`.

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect`, `vi`
- Use `vi.mock('../../../factory/src/graph/executor.js')` or the injectable approach: pass a mock `graphFileLoader` and stub `parseGraph` / `createGraphExecutor` via `vi.mock` at the test file level
- Prefer injecting `graphFileLoader` via `SubgraphHandlerOptions` (no module mock needed for file loading tests)
- For `parseGraph` and `createGraphExecutor`, use `vi.mock('../graph/parser.js')` and `vi.mock('../graph/executor.js')` at the top of the test file — these are the primary seams
- Build first: `npm run build` — confirm zero TypeScript errors before running tests
- Run tests: `npm run test:fast` with `timeout: 300000` (5 min); NEVER pipe output; confirm "Test Files" summary line

### Important: `DefaultRegistryOptions` backward compatibility
Before modifying `registry.ts`, run:
```bash
grep -rn "createDefaultRegistry" packages/ src/
```
All existing call sites pass either no argument or a `CodergenHandlerOptions`-compatible object. Since `DefaultRegistryOptions extends CodergenHandlerOptions` and `baseDir` is optional, no call site changes are needed.

## Interface Contracts

- **Export**: `createSubgraphHandler` @ `packages/factory/src/handlers/subgraph.ts` (consumed by story 50-11)
- **Export**: `SubgraphHandlerOptions` @ `packages/factory/src/handlers/subgraph.ts` (consumed by story 50-11)
- **Export**: `DefaultRegistryOptions` @ `packages/factory/src/handlers/registry.ts` (consumed by story 50-10, 50-11)
- **Import**: `parseGraph` @ `packages/factory/src/graph/parser.ts` (established by story 42-1)
- **Import**: `createGraphExecutor`, `GraphExecutorConfig` @ `packages/factory/src/graph/executor.ts` (established by story 42-14)
- **Import**: `createValidator` @ `packages/factory/src/graph/validator.ts` (established by stories 42-4, 42-5)
- **Import**: `IHandlerRegistry`, `NodeHandler` @ `packages/factory/src/handlers/types.ts` (established by story 42-9)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
