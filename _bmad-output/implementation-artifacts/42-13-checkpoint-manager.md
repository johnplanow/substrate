# Story 42-13: Checkpoint Manager

## Story

As a graph executor,
I want a checkpoint manager that serializes execution state to disk after each node and can restore that state for resume,
so that graph runs can survive process crashes and resume from the last completed node without re-executing already-finished work.

## Acceptance Criteria

### AC1: save() Writes a Spec-Compliant JSON File
**Given** a `CheckpointManager` and a completed node execution with `currentNode="plan"`, `completedNodes=["start","plan"]`, `nodeRetries={}`, a populated `IGraphContext`, and optional log lines
**When** `checkpointManager.save(logsRoot, params)` is awaited
**Then** a JSON file is written to `{logsRoot}/checkpoint.json` containing all six fields: `timestamp` (Unix ms integer), `currentNode`, `completedNodes`, `nodeRetries`, `contextValues` (a flat `Record<string, unknown>` from `context.snapshot()`), and `logs`; the file is valid JSON that can be parsed back without error

### AC2: save() Creates logsRoot Directory if Absent
**Given** `logsRoot` points to a directory that does not yet exist
**When** `checkpointManager.save(logsRoot, params)` is called
**Then** the directory (and any missing parent directories) is created automatically before writing, and the write succeeds without throwing

### AC3: load() Returns a Valid Deserialized Checkpoint
**Given** a checkpoint JSON file previously written by `save()`
**When** `checkpointManager.load(checkpointPath)` is awaited
**Then** it returns a `Checkpoint` object whose `timestamp`, `currentNode`, `completedNodes`, `nodeRetries`, `contextValues`, and `logs` fields exactly match the values that were saved; no fields are missing or coerced to wrong types

### AC4: resume() Restores Context and Returns Completed-Node Skip List
**Given** a checkpoint at `currentNode="node2"` with `completedNodes=["start","node1","node2"]`, `nodeRetries={"node1":1}`, and `contextValues={"x":"42","y":"hello"}`
**When** `checkpointManager.resume(graph, checkpoint)` is called
**Then** it returns a `ResumeState` whose `context` is a `GraphContext` seeded with `{"x":"42","y":"hello"}` (verifiable via `context.getString("x")==="42"`), `completedNodes` is a `Set<string>` containing all three node IDs, and `nodeRetries` is `{"node1":1}`

### AC5: resume() Degrades Fidelity When Last Node Used 'full'
**Given** a checkpoint where `currentNode="node2"` and `graph.nodes.get("node2").fidelity === "full"`
**When** `checkpointManager.resume(graph, checkpoint)` is called
**Then** `ResumeState.firstResumedNodeFidelity` is `"summary:high"`, indicating the first resumed node must use a degraded fidelity mode because in-memory LLM sessions cannot be serialized; if the last node's fidelity is NOT `"full"`, `firstResumedNodeFidelity` is `""` (empty string — no degradation needed)

### AC6: save() Completes in Under 50ms for a 10KB Context
**Given** a `GraphContext` seeded with enough string values to produce a `snapshot()` of approximately 10 KB
**When** `checkpointManager.save(logsRoot, params)` is timed using `Date.now()` before and after the awaited call
**Then** the elapsed time is less than 50 milliseconds; this validates that JSON serialization and disk I/O do not introduce unacceptable latency for the hot-path executor loop

## Tasks / Subtasks

- [ ] Task 1: Update `Checkpoint` interface in `packages/factory/src/graph/types.ts` and add `ResumeState` (AC: #1, #3, #4, #5)
  - [ ] Replace the existing `Checkpoint` stub (currently has `runId`, `nodeId`, `checkpointPath`, `timestamp`, `context`) with the spec-compliant shape:
    ```ts
    export interface Checkpoint {
      /** Unix timestamp (ms) when this checkpoint was created */
      timestamp: number
      /** ID of the last completed node */
      currentNode: string
      /** IDs of all completed nodes in traversal order */
      completedNodes: string[]
      /** Retry counters keyed by node ID */
      nodeRetries: Record<string, number>
      /** Serialized snapshot of GraphContext at save time */
      contextValues: Record<string, unknown>
      /** Execution log lines accumulated since run start */
      logs: string[]
    }
    ```
  - [ ] Add `ResumeState` interface immediately after `Checkpoint`:
    ```ts
    export interface ResumeState {
      /** GraphContext seeded from checkpoint.contextValues */
      context: IGraphContext
      /** Set of node IDs that were already completed — executor skips these */
      completedNodes: Set<string>
      /** Retry counters restored from checkpoint */
      nodeRetries: Record<string, number>
      /**
       * Fidelity override for the first resumed node.
       * Set to 'summary:high' when the last-executed node used 'full' fidelity
       * (in-memory LLM sessions cannot be serialized).
       * Empty string means no degradation is needed.
       */
      firstResumedNodeFidelity: string
    }
    ```
  - [ ] Do NOT remove or change any other type in `types.ts`

- [ ] Task 2: Scaffold `packages/factory/src/graph/checkpoint.ts` with imports and class skeleton (AC: #1–#6)
  - [ ] Create `packages/factory/src/graph/checkpoint.ts`
  - [ ] Import `mkdir`, `writeFile`, `readFile` from `'node:fs/promises'`
  - [ ] Import `path` from `'node:path'`
  - [ ] Import `Checkpoint`, `ResumeState`, `Graph`, `IGraphContext` from `'./types.js'`
  - [ ] Import `GraphContext` from `'./context.js'`
  - [ ] Declare and export `CheckpointManager` class with three method signatures (bodies filled in subsequent tasks)
  - [ ] Define `CheckpointSaveParams` interface:
    ```ts
    export interface CheckpointSaveParams {
      currentNode: string
      completedNodes: string[]
      nodeRetries: Record<string, number>
      context: IGraphContext
      logs?: string[]
    }
    ```

- [ ] Task 3: Implement `CheckpointManager.save()` (AC: #1, #2)
  - [ ] Signature: `async save(logsRoot: string, params: CheckpointSaveParams): Promise<void>`
  - [ ] Call `mkdir(logsRoot, { recursive: true })` to create directory (and parents) if absent — `recursive: true` makes this a no-op if the directory already exists
  - [ ] Build the `Checkpoint` object:
    ```ts
    const checkpoint: Checkpoint = {
      timestamp: Date.now(),
      currentNode: params.currentNode,
      completedNodes: params.completedNodes,
      nodeRetries: params.nodeRetries,
      contextValues: params.context.snapshot(),
      logs: params.logs ?? [],
    }
    ```
  - [ ] Serialize with `JSON.stringify(checkpoint, null, 2)` — pretty-print for human readability
  - [ ] Write to `path.join(logsRoot, 'checkpoint.json')` using `writeFile(filePath, json, 'utf-8')`
  - [ ] Export `CheckpointManager` as a named export; no default export

- [ ] Task 4: Implement `CheckpointManager.load()` (AC: #3)
  - [ ] Signature: `async load(checkpointPath: string): Promise<Checkpoint>`
  - [ ] Read file contents with `readFile(checkpointPath, 'utf-8')`
  - [ ] Parse with `JSON.parse(raw)` — do not add a Zod schema; trust the file written by `save()`
  - [ ] Cast to `Checkpoint` and return; no field transformation needed (JSON types match TypeScript types directly)
  - [ ] Let `readFile` or `JSON.parse` errors propagate naturally — caller handles missing/corrupt files

- [ ] Task 5: Implement `CheckpointManager.resume()` (AC: #4, #5)
  - [ ] Signature: `resume(graph: Graph, checkpoint: Checkpoint): ResumeState`
  - [ ] Build context: `const context = new GraphContext(checkpoint.contextValues)`
  - [ ] Build completedNodes set: `const completedNodes = new Set(checkpoint.completedNodes)`
  - [ ] Copy nodeRetries: `const nodeRetries = { ...checkpoint.nodeRetries }`
  - [ ] Determine fidelity degradation:
    - Look up `graph.nodes.get(checkpoint.currentNode)` to get the last-executed node
    - If the node exists and `node.fidelity === 'full'`, set `firstResumedNodeFidelity = 'summary:high'`
    - Otherwise set `firstResumedNodeFidelity = ''`
  - [ ] Return `{ context, completedNodes, nodeRetries, firstResumedNodeFidelity }`
  - [ ] `resume()` is synchronous — no async needed (all inputs are in-memory)

- [ ] Task 6: Update barrel exports (AC: #1–#6)
  - [ ] Update `packages/factory/src/graph/index.ts` to add:
    ```ts
    export { CheckpointManager } from './checkpoint.js'
    export type { CheckpointSaveParams } from './checkpoint.js'
    export type { Checkpoint, ResumeState } from './types.js'
    ```
  - [ ] Verify the existing `selectEdge`, `normalizeLabel`, `bestByWeightThenLexical` re-exports remain intact
  - [ ] Run `npm run build` from the repo root; confirm zero TypeScript errors before writing tests

- [ ] Task 7: Write unit tests (AC: #1–#5)
  - [ ] Create `packages/factory/src/graph/__tests__/checkpoint.test.ts`
  - [ ] Use `import { describe, it, expect, beforeEach, afterEach } from 'vitest'`
  - [ ] Use Node `os.tmpdir()` + a unique suffix (e.g., `crypto.randomUUID()`) as the `logsRoot` for each test; clean up with `rm -rf` in `afterEach` using `import { rm } from 'node:fs/promises'`
  - [ ] **AC1 tests:**
    - Save with a context containing `{ greeting: "hello" }` and `logs: ["step 1"]`
    - Read the file manually with `readFile` and `JSON.parse`
    - Assert all six keys are present with correct values; `timestamp` is a positive integer; `contextValues.greeting === "hello"`
  - [ ] **AC2 tests:**
    - Use a `logsRoot` two levels deep that does not exist
    - Call `save()` and verify it resolves without error
    - Verify the file exists at the expected path
  - [ ] **AC3 tests:**
    - Round-trip: `save()` then `load()` with the same path
    - Assert `loaded.currentNode`, `loaded.completedNodes`, `loaded.nodeRetries`, `loaded.contextValues`, `loaded.logs`, `loaded.timestamp` all match what was saved
  - [ ] **AC4 tests:**
    - Build a minimal `Graph` with `nodes: new Map()` and `edges: []`; add helper methods via an object that satisfies `Graph`
    - Create a checkpoint with `completedNodes: ["start","node1","node2"]`, `nodeRetries: { node1: 1 }`, `contextValues: { x: "42", y: "hello" }`
    - Call `resume(graph, checkpoint)` and assert:
      - `state.context.getString("x") === "42"`
      - `state.completedNodes.has("start")` and `state.completedNodes.has("node2")`
      - `state.nodeRetries.node1 === 1`
  - [ ] **AC5 tests:**
    - Test with last node `fidelity="full"`: assert `state.firstResumedNodeFidelity === "summary:high"`
    - Test with last node `fidelity="compact"`: assert `state.firstResumedNodeFidelity === ""`
    - Test with `checkpoint.currentNode` not found in graph: assert `state.firstResumedNodeFidelity === ""` (graceful fallback)
  - [ ] Run `pgrep -f vitest` first; then run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" in output

- [ ] Task 8: Performance validation for AC6
  - [ ] Add a dedicated test in `checkpoint.test.ts` named `"save() completes < 50ms for 10KB context"`
  - [ ] Build a `GraphContext` with ~200 string entries of ~50 chars each (≈ 10 KB when serialized)
  - [ ] Measure elapsed time with `Date.now()` before/after the `save()` call
  - [ ] `expect(elapsed).toBeLessThan(50)` — this validates CI performance is acceptable
  - [ ] Note: this is a soft performance gate; if CI is unusually slow, the test may be marked `.skip` and validated manually — document this in a comment

## Dev Notes

### Architecture Constraints
- **New file:** `packages/factory/src/graph/checkpoint.ts`
- **Modified files:**
  - `packages/factory/src/graph/types.ts` — replace `Checkpoint` stub, add `ResumeState`
  - `packages/factory/src/graph/index.ts` — add barrel exports
- All relative imports within `packages/factory/src/` use ESM `.js` extensions (e.g., `import { GraphContext } from './context.js'`)
- Node built-ins must use the `node:` prefix (e.g., `import { writeFile } from 'node:fs/promises'`)
- No third-party dependencies — only Node built-ins and types already in `packages/factory`
- TypeScript strict mode is enabled; all types must be explicit; no `any` except where required for `JSON.parse` output

### Checkpoint Interface Shape (Attractor Spec §5.3)
The spec defines the canonical checkpoint fields (camelCase in TypeScript, snake_case in the JSON spec pseudocode):

| TS Field | JSON Key | Type | Description |
|---|---|---|---|
| `timestamp` | `timestamp` | `number` (ms) | Unix timestamp at save time |
| `currentNode` | `current_node` | `string` | Last completed node ID |
| `completedNodes` | `completed_nodes` | `string[]` | All completed node IDs in traversal order |
| `nodeRetries` | `node_retries` | `Record<string, number>` | Per-node retry counters |
| `contextValues` | `context_values` | `Record<string, unknown>` | Serialized `GraphContext.snapshot()` |
| `logs` | `logs` | `string[]` | Accumulated execution log lines |

**IMPORTANT:** The JSON file uses the camelCase TypeScript field names (because `JSON.stringify` serializes TS field names as-is). The spec pseudocode uses snake_case for illustration only. Do not add a custom `toJSON` transform.

### Existing Checkpoint Stub — Must Be Replaced
The current `Checkpoint` interface in `types.ts` is:
```ts
export interface Checkpoint {
  runId: string
  nodeId: string
  checkpointPath: string
  timestamp: number
  context: IGraphContext
}
```
This stub is incompatible with the spec and was written as a placeholder. **Replace it entirely** with the spec-compliant shape defined in Task 1. No other code currently imports `Checkpoint` except through the barrel — verify with `grep -r "Checkpoint" packages/factory/src/` before replacing to identify any existing usages that need updating.

### resume() — Fidelity Degradation Logic
The fidelity check in `resume()`:
```ts
const lastNode = graph.nodes.get(checkpoint.currentNode)
const firstResumedNodeFidelity = lastNode?.fidelity === 'full' ? 'summary:high' : ''
```
This is the complete logic. If `checkpoint.currentNode` is absent from the graph (e.g., graph was modified between runs), default to `''` (no degradation) — do not throw.

The `firstResumedNodeFidelity` returned by `resume()` is consumed by the executor (story 42-14) which overrides the first non-skipped node's fidelity with this value before dispatching.

### Testing — Graph Stub Pattern
Story 42-13 tests do not need a real parsed `Graph`. Build a minimal conforming object:
```ts
const fakeGraph: Graph = {
  id: '',
  goal: '',
  label: '',
  modelStylesheet: '',
  defaultMaxRetries: 0,
  retryTarget: '',
  fallbackRetryTarget: '',
  defaultFidelity: '',
  nodes: new Map([['node2', { ...minimalNode, id: 'node2', fidelity: 'full' }]]),
  edges: [],
  outgoingEdges: () => [],
  startNode: () => { throw new Error('not used') },
  exitNode: () => { throw new Error('not used') },
}
```
Where `minimalNode` fills all required `GraphNode` fields with defaults. Read `types.ts` to confirm all required fields before constructing.

### Testing Requirements
- Test framework: Vitest (`import { describe, it, expect, beforeEach, afterEach } from 'vitest'`)
- Run: `npm run test:fast` — never pipe output; confirm "Test Files" summary line appears
- Never run tests concurrently (`pgrep -f vitest` must return nothing before starting)
- Use real `node:fs/promises` for file I/O in tests — do not mock fs (the save/load contract requires real file system behavior)
- Clean up `logsRoot` in `afterEach` to prevent test pollution across runs
- Use `os.tmpdir()` + `crypto.randomUUID()` as the test output directory

## Interface Contracts

- **Import**: `IGraphContext`, `Graph`, `GraphNode` @ `packages/factory/src/graph/types.ts` (from stories 42-1, 42-2, 42-8)
- **Import**: `GraphContext` @ `packages/factory/src/graph/context.ts` (from story 42-8)
- **Export**: `Checkpoint` @ `packages/factory/src/graph/types.ts` — replaces stub; consumed by story 42-14 (Graph Executor Core Loop) for post-node checkpoint save and pre-run resume
- **Export**: `ResumeState` @ `packages/factory/src/graph/types.ts` — consumed by story 42-14 for resume flow
- **Export**: `CheckpointManager`, `CheckpointSaveParams` @ `packages/factory/src/graph/checkpoint.ts` — consumed by story 42-14 (executor wiring) and story 44-7 (file-backed run state directory structure)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
