# Story 44-7: File-Backed Run State Directory Structure

## Story

As a factory pipeline operator,
I want each graph execution run to persist artifacts to a structured directory under `.substrate/runs/{run_id}/`,
so that I can inspect node outputs, scenario validation results, and the executed graph — and resume interrupted runs from a known checkpoint.

## Acceptance Criteria

### AC1: Run Directory and graph.dot Initialization
**Given** a `RunStateManager` is created with `runId="r1"` and `initRun(dotSource)` is called with a DOT source string
**When** `initRun()` completes
**Then** the directory `.substrate/runs/r1/` exists and `.substrate/runs/r1/graph.dot` contains the DOT source string

### AC2: Per-Node status.json for All Node Types
**Given** any node (`dev_story`, `validate`, `start`, etc.) completes with execution metadata
**When** `writeNodeArtifacts()` is called with the node's id, status, startedAt, completedAt, and durationMs
**Then** `.substrate/runs/r1/{nodeId}/status.json` contains a JSON object with those exact fields

### AC3: Per-Node prompt.md and response.md for Codergen Nodes
**Given** a codergen node `dev_story` completes with a prompt string and a response string
**When** `writeNodeArtifacts()` is called with `prompt` and `response` fields populated
**Then** `.substrate/runs/r1/dev_story/prompt.md` and `.substrate/runs/r1/dev_story/response.md` each contain the respective string content

### AC4: Per-Iteration Scenario Manifest Writing
**Given** a scenario validation executes at iteration 2 with a captured `ScenarioManifest`
**When** `writeScenarioIteration()` is called with `{ iteration: 2, manifest: ScenarioManifest }`
**Then** `.substrate/runs/r1/scenarios/2/manifest.json` contains the serialized `ScenarioManifest`

### AC5: Per-Iteration Scenario Results Writing
**Given** the scenario runner returns a `ScenarioRunResult` for iteration 2
**When** `writeScenarioIteration()` is called with `{ iteration: 2, manifest, results: ScenarioRunResult }`
**Then** `.substrate/runs/r1/scenarios/2/results.json` contains the serialized `ScenarioRunResult`

### AC6: GraphExecutor Integration — graph.dot and Node Artifacts
**Given** `GraphExecutorConfig` includes a `dotSource` string
**When** `executor.run(graph, config)` executes a graph with nodes `dev_story` and `validate`
**Then** a `RunStateManager` is instantiated using `config.logsRoot` as the run directory, `initRun(config.dotSource)` is called before the main loop, and `writeNodeArtifacts()` is called for each completed node with measured `startedAt`/`completedAt`/`durationMs` timing

## Tasks / Subtasks

- [ ] Task 1: Define `RunStateManager` types and interface (AC: #1, #2, #3, #4, #5)
  - [ ] Create `packages/factory/src/graph/run-state.ts`
  - [ ] Define and export `NodeArtifacts` interface: `{ nodeId: string; nodeType: string; status: string; startedAt: number; completedAt: number; durationMs: number; prompt?: string; response?: string }`
  - [ ] Define and export `ScenarioIterationArtifacts` interface: `{ iteration: number; manifest: ScenarioManifest; results?: ScenarioRunResult }`
  - [ ] Define and export `RunStateManagerOptions` interface: `{ runDir: string }`
  - [ ] Declare and export `RunStateManager` class with constructor accepting `RunStateManagerOptions`; expose `readonly runDir: string`

- [ ] Task 2: Implement `RunStateManager.initRun()` (AC: #1)
  - [ ] Accept `dotSource: string` parameter
  - [ ] Call `await mkdir(this.runDir, { recursive: true })` using `node:fs/promises`
  - [ ] Write `dotSource` to `path.join(this.runDir, 'graph.dot')` via `writeFile`

- [ ] Task 3: Implement `RunStateManager.writeNodeArtifacts()` (AC: #2, #3)
  - [ ] Accept `artifacts: NodeArtifacts` parameter
  - [ ] Create `path.join(this.runDir, artifacts.nodeId)` with `mkdir({ recursive: true })`
  - [ ] Always write `status.json`: serialize `{ nodeId, nodeType, status, startedAt, completedAt, durationMs }` as pretty-printed JSON
  - [ ] If `artifacts.prompt` is provided (truthy), write `prompt.md` to the node subdir
  - [ ] If `artifacts.response` is provided (truthy), write `response.md` to the node subdir

- [ ] Task 4: Implement `RunStateManager.writeScenarioIteration()` (AC: #4, #5)
  - [ ] Accept `artifacts: ScenarioIterationArtifacts` parameter
  - [ ] Create `path.join(this.runDir, 'scenarios', String(artifacts.iteration))` with `mkdir({ recursive: true })`
  - [ ] Write `manifest.json` with `JSON.stringify(artifacts.manifest, null, 2)`
  - [ ] If `artifacts.results` is provided (truthy), write `results.json` with `JSON.stringify(artifacts.results, null, 2)`

- [ ] Task 5: Add exports and extend `GraphExecutorConfig` (AC: #6)
  - [ ] Add `export { RunStateManager } from './run-state.js'` and re-export types from `packages/factory/src/graph/index.ts`
  - [ ] Add optional `dotSource?: string` field to `GraphExecutorConfig` in `packages/factory/src/graph/executor.ts`, with JSDoc: "Raw DOT source string of the executed graph. When provided, written to `graph.dot` in the run directory at execution start."

- [ ] Task 6: Wire `RunStateManager` into `GraphExecutor.run()` (AC: #6)
  - [ ] At the top of `run()`, instantiate `RunStateManager` with `{ runDir: config.logsRoot }` if `config.dotSource` is provided; otherwise set to `null` (opt-in, backward-compatible)
  - [ ] If `runStateManager` is non-null, call `await runStateManager.initRun(config.dotSource)` before the main loop (after checkpoint loading)
  - [ ] Before dispatching each node, record `startedAt = Date.now()`
  - [ ] After `dispatchWithRetry` returns and the `allowPartial` demotion check completes (i.e., after the final `outcome` is determined), compute `completedAt = Date.now()` and call `await runStateManager.writeNodeArtifacts({ nodeId: nodeToDispatch.id, nodeType: nodeToDispatch.type, status: outcome.status, startedAt, completedAt, durationMs: completedAt - startedAt, response: outcome.notes ?? undefined })`
  - [ ] For codergen nodes, populate `prompt` from `nodeToDispatch.prompt || nodeToDispatch.label` (the raw template, not interpolated — interpolated prompt is not available in the executor scope)

- [ ] Task 7: Write unit tests for `RunStateManager` (AC: #1–#5)
  - [ ] Create `packages/factory/src/graph/__tests__/run-state.test.ts`
  - [ ] Import `{ describe, it, expect, beforeEach, afterEach }` from `'vitest'`
  - [ ] Import `{ mkdtemp, rm }` from `'node:fs/promises'` and `os` from `'node:os'` for temp directory management
  - [ ] Use `beforeEach` to create a unique temp dir via `mkdtemp(path.join(os.tmpdir(), 'run-state-test-'))` and `afterEach` to clean up with `rm(tmpDir, { recursive: true, force: true })`
  - [ ] Test AC1: `initRun('digraph G {}')` → `graph.dot` exists and contains the source
  - [ ] Test AC2: `writeNodeArtifacts({ nodeId: 'n1', nodeType: 'codergen', status: 'SUCCESS', startedAt: 1000, completedAt: 2000, durationMs: 1000 })` → `n1/status.json` parses to object with all 6 fields; `n1/prompt.md` does NOT exist
  - [ ] Test AC3: `writeNodeArtifacts({ ..., prompt: 'Do X', response: 'Done' })` → `n1/prompt.md` === `'Do X'`, `n1/response.md` === `'Done'`
  - [ ] Test AC4: `writeScenarioIteration({ iteration: 2, manifest: { scenarios: [], capturedAt: 0 } })` → `scenarios/2/manifest.json` round-trips via JSON.parse
  - [ ] Test AC5: `writeScenarioIteration({ iteration: 2, manifest: { scenarios: [], capturedAt: 0 }, results: { scenarios: [], summary: { total: 0, passed: 0, failed: 0 }, durationMs: 0 } })` → `scenarios/2/results.json` round-trips via JSON.parse
  - [ ] Test that `writeScenarioIteration` without `results` does NOT create `results.json`
  - [ ] Test that `initRun` is idempotent (calling twice does not throw)

## Dev Notes

### Architecture Constraints

- **New file:** `packages/factory/src/graph/run-state.ts`
- **New test file:** `packages/factory/src/graph/__tests__/run-state.test.ts`
- **Modified file:** `packages/factory/src/graph/executor.ts` — add `dotSource?` to `GraphExecutorConfig` and wire `RunStateManager`
- **Modified file:** `packages/factory/src/graph/index.ts` — re-export `RunStateManager` and its types
- Use `node:fs/promises` (`mkdir`, `writeFile`) — no external filesystem libraries
- All relative `.js` extension imports within the factory package
- The run directory IS `config.logsRoot` — the `CheckpointManager` already writes `checkpoint.json` there (AC4 from the epic plan is therefore satisfied by the existing checkpoint manager, provided callers set `logsRoot` to `.substrate/runs/{runId}/`)
- `RunStateManager` must NOT replace or conflict with `CheckpointManager` — it handles only `graph.dot`, per-node dirs, and scenario dirs

### Type Reference

```typescript
// packages/factory/src/graph/run-state.ts

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ScenarioManifest } from '../scenarios/index.js'
import type { ScenarioRunResult } from '../events.js'

export interface RunStateManagerOptions {
  /** Absolute or relative path to the run directory (e.g. `.substrate/runs/r1`). */
  runDir: string
}

export interface NodeArtifacts {
  nodeId: string
  nodeType: string
  status: string          // StageStatus string value
  startedAt: number       // Date.now() before dispatch
  completedAt: number     // Date.now() after dispatch
  durationMs: number
  prompt?: string         // Raw prompt template (codergen nodes)
  response?: string       // outcome.notes (codergen nodes)
}

export interface ScenarioIterationArtifacts {
  iteration: number
  manifest: ScenarioManifest
  results?: ScenarioRunResult
}
```

### Executor Integration Pattern

```typescript
// In GraphExecutorConfig (add optional field):
dotSource?: string   // Raw DOT graph source; enables graph.dot write

// In executor.run() — after checkpoint loading, before main loop:
const runStateManager = config.dotSource
  ? new RunStateManager({ runDir: config.logsRoot })
  : null
if (runStateManager && config.dotSource) {
  await runStateManager.initRun(config.dotSource)
}

// In main loop — before dispatchWithRetry:
const startedAt = Date.now()

// After allowPartial demotion check, before emitting node:completed/failed:
const completedAt = Date.now()
if (runStateManager) {
  await runStateManager.writeNodeArtifacts({
    nodeId: nodeToDispatch.id,
    nodeType: nodeToDispatch.type,
    status: outcome.status,
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    ...(nodeToDispatch.type === 'codergen' && {
      prompt: nodeToDispatch.prompt || nodeToDispatch.label || undefined,
      response: typeof outcome.notes === 'string' ? outcome.notes : undefined,
    }),
  })
}
```

### Checkpoint Integration Note

`CheckpointManager.save(config.logsRoot, ...)` already creates `logsRoot` with `mkdir({ recursive: true })`. The `RunStateManager.initRun()` also calls `mkdir({ recursive: true })` — these are idempotent and safe to call in any order. No coordination is needed between the two.

### Scenario Iteration Tracking Note

The executor currently does not emit `scenario:completed` events or track scenario iteration counts. Story 44-7 scope is limited to providing the `RunStateManager` API and wiring `initRun()` + `writeNodeArtifacts()` into the executor. The `writeScenarioIteration()` method is implemented and tested in isolation; the caller (a future story or updated tool handler) is responsible for invoking it with the correct iteration count and parsed `ScenarioRunResult`. Do NOT add iteration tracking or scenario result parsing to the executor in this story.

### Testing Requirements

- **Framework:** Vitest — `import { describe, it, expect, beforeEach, afterEach } from 'vitest'`
- **Temp dirs:** Use `os.tmpdir()` + `mkdtemp()` — never write to the project root during tests
- **Cleanup:** Always `rm(tmpDir, { recursive: true, force: true })` in `afterEach`
- **Executor tests:** The existing `packages/factory/src/graph/__tests__/executor.test.ts` must not regress — verify that omitting `dotSource` still works (backward-compatible)
- **Build:** `npm run build` — zero TypeScript errors
- **Test run:** `npm run test:fast` with `timeout: 300000` — check for "Test Files" summary line

## Interface Contracts

- **Export**: `RunStateManager` @ `packages/factory/src/graph/run-state.ts`
- **Export**: `RunStateManagerOptions`, `NodeArtifacts`, `ScenarioIterationArtifacts` @ `packages/factory/src/graph/run-state.ts`
- **Import**: `ScenarioManifest` @ `packages/factory/src/scenarios/index.ts` (from story 44-1)
- **Import**: `ScenarioRunResult` @ `packages/factory/src/events.ts` (from story 44-2)
- **Modifies**: `GraphExecutorConfig` @ `packages/factory/src/graph/executor.ts` — adds `dotSource?: string` (from story 42-14)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-23: Story created for Epic 44, Phase B — Scenario Store + Runner
