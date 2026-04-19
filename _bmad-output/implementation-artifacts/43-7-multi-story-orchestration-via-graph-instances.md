# Story 43.7: Multi-Story Orchestration via Graph Instances

## Story

As an SDLC orchestration layer,
I want a `GraphOrchestrator` that runs one graph instance per concurrent story slot,
so that the graph-based SDLC pipeline processes multiple stories in parallel with the same bounded concurrency and conflict-group serialization as the existing `ImplementationOrchestrator`.

## Acceptance Criteria

### AC1: Bounded Concurrency — Slots Fill and Drain Correctly
**Given** 3 pending story keys and `maxConcurrency=2` in `GraphOrchestratorConfig`
**When** `GraphOrchestrator.run(storyKeys)` is called
**Then** at most 2 graph executor instances run concurrently at any moment, the 3rd story starts as soon as one slot opens, and the promise resolves only after all 3 stories have completed

### AC2: Per-Story Context Initialization
**Given** a story graph instance about to execute
**When** `config.executor.run(graph, executorConfig)` is invoked for that story
**Then** the `initialContext` passed to the executor contains `{ storyKey, projectRoot, methodologyPack }` sourced from the orchestrator config and the current story key

### AC3: Run Summary Reflects Final Story Outcomes
**Given** a run of N stories where some executor calls return `SUCCESS` and some return `FAIL`
**When** `GraphOrchestrator.run(storyKeys)` resolves
**Then** the returned `GraphRunSummary` accurately counts `successCount`, `failureCount`, and `totalStories` matching the executor outcomes for each story

### AC4: Conflict Group Serialization
**Given** two story keys that the injected `conflictGrouper` places in the same conflict group
**When** `GraphOrchestrator.run([storyA, storyB])` is called with `maxConcurrency=2`
**Then** storyA and storyB execute sequentially (storyB's executor call starts only after storyA's resolves), even though a concurrency slot is technically available

### AC5: Batch Ordering Respects Topological Contract Dependencies
**Given** the injected `conflictGrouper` returns two ordered batches — batch 0 contains storyA, batch 1 contains storyB
**When** `GraphOrchestrator.run([storyA, storyB])` is called
**Then** the executor is invoked for storyA, storyA's executor resolves, and only then is the executor invoked for storyB — batch 1 waits for batch 0 to fully complete

### AC6: Graph Structural Validation at Construction
**Given** a `GraphOrchestratorConfig` where `config.graph` is missing its `nodes` or `edges` array (structurally invalid)
**When** `createGraphOrchestrator(config)` is called
**Then** it throws a `GraphOrchestratorInitError` with a descriptive message before any story execution begins

### AC7: ADR-003 — No Direct @substrate-ai/factory Import in packages/sdlc
**Given** the `packages/sdlc` package TypeScript source
**When** `npm run build` is executed from the monorepo root
**Then** zero TypeScript errors occur and no non-test `.ts` file in `packages/sdlc/src/` contains a direct `import … from '@substrate-ai/factory'` statement — all factory-side types (`Graph`, `GraphExecutor`, `HandlerRegistry`) are accepted via locally-defined duck-typed interfaces injected through `GraphOrchestratorConfig`

## Tasks / Subtasks

- [ ] Task 1: Define local duck-typed interfaces and exported config/result types (AC: #2, #6, #7)
  - [ ] Create `packages/sdlc/src/orchestrator/graph-orchestrator.ts`
  - [ ] Define minimal structural `GraphShape` interface: `{ nodes: Array<{ id: string; type: string; label: string; prompt: string }>; edges: Array<{ from: string; to: string; label?: string }> }` — structurally compatible with `@substrate-ai/factory`'s `Graph` without importing it
  - [ ] Define `GraphRunConfig` interface: `{ runId: string; logsRoot: string; handlerRegistry: unknown; initialContext?: Record<string, unknown>; eventBus?: unknown }` — compatible with `GraphExecutorConfig`
  - [ ] Define `GraphRunResult` interface: `{ status: 'SUCCESS' | 'FAIL' | 'PARTIAL_SUCCESS' | string }` — compatible with the executor's `Outcome` return
  - [ ] Define `IGraphExecutorLocal` interface: `{ run(graph: GraphShape, config: GraphRunConfig): Promise<GraphRunResult> }` — duck-typed executor contract
  - [ ] Define `ConflictGroupBatches` type alias: `string[][][]` (outer = batches, middle = groups, inner = story keys)
  - [ ] Define `ConflictGrouperFn` type: `(storyKeys: string[]) => ConflictGroupBatches`
  - [ ] Define `GraphOrchestratorConfig` interface with fields: `graph: GraphShape`, `executor: IGraphExecutorLocal`, `handlerRegistry: unknown`, `projectRoot: string`, `methodologyPack: string`, `maxConcurrency: number`, `logsRoot: string`, `runId: string`, `conflictGrouper?: ConflictGrouperFn`, `gcPauseMs?: number`
  - [ ] Define `GraphRunSummary` interface: `{ successCount: number; failureCount: number; totalStories: number }`
  - [ ] Define `GraphOrchestrator` interface: `{ run(storyKeys: string[]): Promise<GraphRunSummary> }`
  - [ ] Define and export `GraphOrchestratorInitError` class extending `Error`

- [ ] Task 2: Implement `createGraphOrchestrator` with startup validation (AC: #6)
  - [ ] Implement `createGraphOrchestrator(config: GraphOrchestratorConfig): GraphOrchestrator`
  - [ ] At construction: assert `config.graph` is non-null and has `nodes` and `edges` arrays; if not, throw `new GraphOrchestratorInitError('Invalid graph: missing nodes or edges arrays')`
  - [ ] Return an object with a `run(storyKeys: string[]): Promise<GraphRunSummary>` method

- [ ] Task 3: Implement conflict group detection and batch ordering in `run()` (AC: #4, #5)
  - [ ] In `run()`, if `config.conflictGrouper` is provided, call it with `storyKeys` to get `batches: ConflictGroupBatches`; otherwise fall back to a default grouper that puts each story in its own group in a single batch: `[ storyKeys.map(k => [k]) ]`
  - [ ] Process batches **sequentially** with `for (const batchGroups of batches) { await runBatch(batchGroups) }` — no batch starts until the previous one fully completes
  - [ ] Implement `runBatch(groups: string[][]): Promise<void>` using a Promise pool capped at `config.maxConcurrency`; each group runs as a unit (its stories execute sequentially within the group)
  - [ ] Implement `runGroup(group: string[]): Promise<void>` that iterates stories sequentially: `for (const storyKey of group) { await runStoryGraph(storyKey); if (gcPauseMs > 0) await sleep(gcPauseMs) }`
  - [ ] Default `gcPauseMs` to `2000` if not provided in config

- [ ] Task 4: Implement per-story graph execution and outcome accumulation (AC: #1, #2, #3)
  - [ ] Implement private `runStoryGraph(storyKey: string): Promise<void>` method
  - [ ] Build initial context: `const initialContext = { storyKey, projectRoot: config.projectRoot, methodologyPack: config.methodologyPack }`
  - [ ] Invoke executor: `const result = await config.executor.run(config.graph, { runId: \`${config.runId}:${storyKey}\`, logsRoot: config.logsRoot, handlerRegistry: config.handlerRegistry, initialContext })`
  - [ ] Map result: `result.status === 'SUCCESS'` → increment `successCount`; any other status → increment `failureCount`; always increment `totalStories`
  - [ ] After all batches, build and return `GraphRunSummary` from accumulated counts

- [ ] Task 5: Export `GraphOrchestrator` types from `@substrate-ai/sdlc` public API (AC: #7)
  - [ ] Add `export * from './orchestrator/graph-orchestrator.js'` to `packages/sdlc/src/index.ts`
  - [ ] Confirm `npm run build` shows zero TypeScript errors and no new circular dependency warnings

- [ ] Task 6: Write unit tests for `GraphOrchestrator` (AC: #1, #2, #3, #4, #5, #6)
  - [ ] Create `packages/sdlc/src/orchestrator/__tests__/graph-orchestrator.test.ts`
  - [ ] Test AC1 — concurrency limit: use a shared counter `let running = 0` in a mock executor that increments on entry and decrements on exit; assert `running` never exceeds `maxConcurrency` across 3 stories with `maxConcurrency=2`
  - [ ] Test AC2 — per-story context: spy on `executor.run` and assert `initialContext` contains `{ storyKey: '<expected>', projectRoot: '<config.projectRoot>', methodologyPack: '<config.methodologyPack>' }`
  - [ ] Test AC3 — summary counts: mock executor returning `SUCCESS` for 2 stories and `FAIL` for 1; assert `GraphRunSummary` has `successCount: 2`, `failureCount: 1`, `totalStories: 3`
  - [ ] Test AC4 — conflict group serialization: use a `conflictGrouper` that puts storyA and storyB in the same group; inject a latch-based executor that records call order; assert storyB is called only after storyA resolves
  - [ ] Test AC5 — batch ordering: use a `conflictGrouper` returning 2 batches (`[[storyA]]`, `[[storyB]]`); record executor invocation timestamps; assert storyA finishes before storyB starts
  - [ ] Test AC6 — init error: call `createGraphOrchestrator` with `graph: { nodes: null, edges: [] }`; assert `GraphOrchestratorInitError` is thrown before any `run()` call

- [ ] Task 7: Build and test verification (AC: #7)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all 6+ new tests pass, zero regressions in sdlc, factory, or core tests
  - [ ] Manually verify no `@substrate-ai/factory` import in `packages/sdlc/src/orchestrator/graph-orchestrator.ts`

## Dev Notes

### Architecture Constraints

- **ADR-003 (no cross-package coupling)**: `packages/sdlc/src/orchestrator/graph-orchestrator.ts` must NOT contain any `import … from '@substrate-ai/factory'` statement. All factory-side types (`Graph`, `GraphExecutor`, `HandlerRegistry`, `Outcome`) are used only via locally-defined duck-typed structural interfaces. The actual `GraphExecutor` instance, the real `HandlerRegistry`, and the parsed `Graph` object are all injected through `GraphOrchestratorConfig` by the CLI composition root (story 43-10).
- **packages/sdlc tsconfig references only packages/core**: Do not modify `packages/sdlc/tsconfig.json` to add a reference to `packages/factory`. The duck-typed approach makes this unnecessary.
- **Conflict detection not yet in @substrate-ai/core**: `detectConflictGroupsWithContracts` lives in the monolith (`src/modules/implementation-orchestrator/conflict-detector.ts`) and is not yet exported from `@substrate-ai/core`. Rather than importing it directly (which would violate package boundaries), accept it as an optional `conflictGrouper?: ConflictGrouperFn` in the config. The CLI composition root (story 43-10) will close the injection gap by passing the real detector. Story 43-7 only needs to consume the injected function, not locate it.
- **OrchestratorStatus is complex**: The existing `OrchestratorStatus` interface in the monolith contains `state`, per-story `StoryState` maps, timestamps, and decomposition metrics. For story 43-7, define a simpler `GraphRunSummary` type (`successCount`, `failureCount`, `totalStories`). Story 43-10 (CLI wiring) will adapt `GraphRunSummary` into whatever the CLI needs.
- **Graph is pre-parsed**: `GraphOrchestratorConfig.graph` is a pre-parsed `GraphShape` object — NOT a file path. The CLI composition root calls `parseGraph()` from `@substrate-ai/factory` before constructing the orchestrator. The orchestrator only validates structural completeness (nodes/edges arrays present), it never parses DOT syntax.
- **Executor Outcome uses StageStatus, not OutcomeStatus**: The factory's `GraphExecutor.run()` returns `events.ts:Outcome` whose `status` field is `StageStatus` (`'SUCCESS' | 'FAIL' | 'PARTIAL_SUCCESS' | 'RETRY' | 'SKIPPED'`). This is distinct from `types.ts:OutcomeStatus` used by `NodeHandler`. In `GraphRunResult`, accept `status: string` (or enumerate explicitly: `'SUCCESS' | 'FAIL' | 'PARTIAL_SUCCESS' | 'RETRY' | 'SKIPPED'`) and map `SUCCESS` → success, everything else → failure.
- **GC pause between sequential stories**: Mirror the existing orchestrator's 2-second pause between stories in the same conflict group (`gcPauseMs` defaults to 2000). This reduces memory pressure during long runs.
- **No TypedEventBus wiring in this story**: Event bridging (translating `graph:node-started/completed` to `orchestrator:story-phase-*` events) is scoped to story 43-9. Story 43-7 only needs to pass an optional `eventBus` through to the executor config without subscribing to any events itself.

### File Paths

- **New file**: `packages/sdlc/src/orchestrator/graph-orchestrator.ts`
- **New test**: `packages/sdlc/src/orchestrator/__tests__/graph-orchestrator.test.ts`
- **Modify**: `packages/sdlc/src/index.ts` — append `export * from './orchestrator/graph-orchestrator.js'`

### Implementation Sketch (`graph-orchestrator.ts`)

```typescript
// packages/sdlc/src/orchestrator/graph-orchestrator.ts
// ADR-003: NO imports from @substrate-ai/factory

// ── Duck-typed factory shapes ─────────────────────────────────────────────────
export interface GraphShape {
  nodes: Array<{ id: string; type: string; label: string; prompt: string }>
  edges: Array<{ from: string; to: string; label?: string }>
}

export interface GraphRunConfig {
  runId: string
  logsRoot: string
  handlerRegistry: unknown
  initialContext?: Record<string, unknown>
  eventBus?: unknown
}

export interface GraphRunResult {
  status: 'SUCCESS' | 'FAIL' | 'PARTIAL_SUCCESS' | 'RETRY' | 'SKIPPED' | string
}

export interface IGraphExecutorLocal {
  run(graph: GraphShape, config: GraphRunConfig): Promise<GraphRunResult>
}

// ── Conflict grouper ──────────────────────────────────────────────────────────
export type ConflictGroupBatches = string[][][]
export type ConflictGrouperFn = (storyKeys: string[]) => ConflictGroupBatches

// ── Public config / result types ─────────────────────────────────────────────
export interface GraphOrchestratorConfig {
  graph: GraphShape
  executor: IGraphExecutorLocal
  handlerRegistry: unknown
  projectRoot: string
  methodologyPack: string
  maxConcurrency: number
  logsRoot: string
  runId: string
  conflictGrouper?: ConflictGrouperFn
  gcPauseMs?: number
}

export interface GraphRunSummary {
  successCount: number
  failureCount: number
  totalStories: number
}

export interface GraphOrchestrator {
  run(storyKeys: string[]): Promise<GraphRunSummary>
}

export class GraphOrchestratorInitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphOrchestratorInitError'
  }
}

// ── Factory function ──────────────────────────────────────────────────────────
export function createGraphOrchestrator(config: GraphOrchestratorConfig): GraphOrchestrator {
  if (!config.graph?.nodes || !config.graph?.edges) {
    throw new GraphOrchestratorInitError('Invalid graph: missing nodes or edges arrays')
  }

  const gcPauseMs = config.gcPauseMs ?? 2000

  async function runStoryGraph(storyKey: string, summary: { s: number; f: number }): Promise<void> {
    const initialContext = {
      storyKey,
      projectRoot: config.projectRoot,
      methodologyPack: config.methodologyPack,
    }
    const result = await config.executor.run(config.graph, {
      runId: `${config.runId}:${storyKey}`,
      logsRoot: config.logsRoot,
      handlerRegistry: config.handlerRegistry,
      initialContext,
    })
    if (result.status === 'SUCCESS') { summary.s++ } else { summary.f++ }
  }

  async function runGroup(group: string[], summary: { s: number; f: number }): Promise<void> {
    for (const storyKey of group) {
      await runStoryGraph(storyKey, summary)
      if (gcPauseMs > 0) await new Promise((r) => setTimeout(r, gcPauseMs))
    }
  }

  async function runBatch(groups: string[][], summary: { s: number; f: number }): Promise<void> {
    const queue = [...groups]
    const active: Promise<void>[] = []
    while (queue.length > 0 || active.length > 0) {
      while (active.length < config.maxConcurrency && queue.length > 0) {
        const group = queue.shift()!
        const p: Promise<void> = runGroup(group, summary).finally(() => {
          active.splice(active.indexOf(p), 1)
        })
        active.push(p)
      }
      if (active.length > 0) await Promise.race(active)
    }
  }

  return {
    async run(storyKeys: string[]): Promise<GraphRunSummary> {
      const grouper = config.conflictGrouper ?? ((keys) => [keys.map((k) => [k])])
      const batches = grouper(storyKeys)
      const summary = { s: 0, f: 0 }
      for (const batchGroups of batches) {
        await runBatch(batchGroups, summary)
      }
      return { successCount: summary.s, failureCount: summary.f, totalStories: storyKeys.length }
    },
  }
}
```

### Import Pattern (`graph-orchestrator.ts`)

```typescript
// No package-level imports needed — all types are defined locally.
// If @substrate-ai/core exports shared primitives used here in the future,
// they may be imported from '@substrate-ai/core' only (not '@substrate-ai/factory').
```

### Testing Requirements

- **Framework**: Vitest (`vi.fn()`, `vi.useFakeTimers` or real timers with manual Promise resolution)
- **Concurrency test pattern**: Track peak concurrency with a shared mutable counter. Each mock executor call increments a counter on entry and decrements on exit via `.finally()`; assert the counter never exceeds `maxConcurrency`.
- **Conflict group serialization test**: Use a `conflictGrouper` returning `[ [ ['storyA', 'storyB'] ] ]` (one batch, one group with two stories). Record the timestamps or order of executor invocations using an array `callLog: string[]`. Assert storyA is resolved before storyB's executor is called.
- **Batch ordering test**: Use a `conflictGrouper` returning `[ [['storyA']], [['storyB']] ]`. Assert storyA's executor call finishes before storyB's executor call begins (check call index or timestamp).
- **No real `setTimeout` in tests**: Pass `gcPauseMs: 0` in test configs to skip GC pauses and keep tests fast.
- **Test file path**: `packages/sdlc/src/orchestrator/__tests__/graph-orchestrator.test.ts`
- **Run command**: `npm run test:fast` from monorepo root

## Interface Contracts

- **Import**: `IGraphExecutorLocal`, `GraphShape` interfaces defined locally — duck-typed from `@substrate-ai/factory`'s `GraphExecutor` and `Graph` (no direct import)
- **Import**: `ConflictGrouperFn` (injected by CLI; the real implementation lives at `src/modules/implementation-orchestrator/conflict-detector.ts::detectConflictGroupsWithContracts`)
- **Import**: `buildSdlcHandlerRegistry`, `SdlcRegistryDeps` @ `src/cli/commands/sdlc-graph-setup.ts` (from story 43-6; the registry built here is passed as `config.handlerRegistry`)
- **Export**: `GraphOrchestrator`, `GraphOrchestratorConfig`, `GraphRunSummary`, `createGraphOrchestrator`, `IGraphExecutorLocal`, `GraphShape`, `GraphOrchestratorInitError`, `ConflictGrouperFn` @ `packages/sdlc/src/orchestrator/graph-orchestrator.ts` (consumed by story 43-10 — `--engine` flag CLI wiring)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-22: Story created for Epic 43 — SDLC Pipeline as Graph
