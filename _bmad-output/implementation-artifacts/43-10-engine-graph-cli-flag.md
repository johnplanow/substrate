# Story 43.10: `--engine=graph` CLI Flag

## Story

As a substrate CLI user,
I want to opt into the graph-based SDLC execution path via `--engine=graph`,
so that I can run the pipeline through the new graph executor while retaining full backward compatibility with the default linear orchestrator.

## Acceptance Criteria

### AC1: `--engine=graph` Routes to Graph Orchestrator
**Given** `substrate run --engine=graph --stories 1-1` is executed
**When** the pipeline starts
**Then** story execution is handled by `GraphOrchestrator` (from story 43-7) with SDLC handlers registered via `buildSdlcHandlerRegistry()` (from story 43-6), not by `createImplementationOrchestrator()`

### AC2: Default (No `--engine` Flag) Uses Linear Orchestrator
**Given** `substrate run --stories 1-1` is run without any `--engine` flag
**When** the pipeline starts
**Then** the existing `createImplementationOrchestrator()` code path is used — behavior is identical to the pre-43-10 baseline

### AC3: `--engine=linear` Explicitly Selects Linear Orchestrator
**Given** `substrate run --engine=linear --stories 1-1` is executed
**When** the pipeline starts
**Then** the existing `createImplementationOrchestrator()` code path is used — equivalent to the default

### AC4: `--engine=graph --events` Emits Compatible NDJSON Event Stream
**Given** `substrate run --engine=graph --events --stories 1-1` is executed
**When** a story transitions through SDLC phases (create-story → dev-story → code-review)
**Then** NDJSON events (`story:phase`, `story:done`, `story:escalation`) are emitted on stdout with the same structure as the linear orchestrator, via the SDLC event bridge wired in `GraphOrchestrator` (story 43-9)

### AC5: Invalid `--engine` Value Produces a Clear Error
**Given** `substrate run --engine=bogus --stories 1-1` is executed
**When** the CLI parses the option
**Then** the process exits with code 1 and prints an error message: `Invalid engine 'bogus'. Valid values: linear, graph`

### AC6: `--engine` Option Appears in `substrate run --help`
**Given** the user runs `substrate run --help`
**When** the help text is displayed
**Then** `--engine <type>` is listed with description `Execution engine: linear (default) or graph`

### AC7: Graph Engine Respects `--concurrency` and `--max-review-cycles`
**Given** `substrate run --engine=graph --stories 1-1,1-2 --concurrency 2 --max-review-cycles 3` is executed
**When** `GraphOrchestrator` is constructed
**Then** its config receives `maxConcurrency: 2` and `maxReviewCycles: 3`, matching how the linear orchestrator receives these values

## Tasks / Subtasks

- [ ] Task 1: Add `engine` to `RunOptions` interface and `runRunAction` signature (AC: #1, #2, #3, #5)
  - [ ] In `src/cli/commands/run.ts`, add `engine?: 'linear' | 'graph'` to the `RunOptions` interface (after `maxReviewCycles`)
  - [ ] In `runRunAction`, destructure `engine` from `options` with default `'linear'`
  - [ ] Add validation: if `engine` is defined and not `'linear'` or `'graph'`, emit error and return 1
  - [ ] Keep the existing `createImplementationOrchestrator` call in an `if (engine === 'linear')` branch (no behavioral change for the default path)

- [ ] Task 2: Add `--engine` option to `registerRunCommand` (AC: #5, #6)
  - [ ] In `registerRunCommand`, add `.option('--engine <type>', 'Execution engine: linear (default) or graph')` before the `.action()` call
  - [ ] In the `.action()` callback's opts type annotation, add `engine?: string`
  - [ ] Pass `engine: opts.engine` through the `runRunAction({...})` call
  - [ ] No default value in the option definition — undefined means linear (validated in `runRunAction`)

- [ ] Task 3: Implement graph engine branch in `runRunAction` (AC: #1, #4, #7)
  - [ ] Import `buildSdlcHandlerRegistry` and `SdlcRegistryDeps` from `./sdlc-graph-setup.js`
  - [ ] Import `createGraphOrchestrator` and `GraphRunSummary` from `@substrate-ai/sdlc`
  - [ ] Inside the `if (engine === 'graph')` branch:
    - [ ] Read the SDLC DOT graph using `readFileSync` from `@substrate-ai/sdlc`'s graph path (or resolve via pack path); use the DOT file path from story 43-1: `packages/sdlc/graphs/sdlc-pipeline.dot`
    - [ ] Call `buildSdlcHandlerRegistry(deps)` with the same handler dependencies as the existing linear orchestrator (dispatcher, pack, contextCompiler, eventBus, projectRoot, maxReviewCycles, pipelineRun.id)
    - [ ] Call `createGraphOrchestrator({ graph, handlerRegistry, eventBus, maxConcurrency: concurrency, maxReviewCycles, pipelineRunId: pipelineRun.id, projectRoot })`
    - [ ] Call `await graphOrchestrator.run(storyKeys)` — returns `GraphRunSummary`
    - [ ] Map `GraphRunSummary` to the same `status` shape as `createImplementationOrchestrator().run()` so post-run logic (metrics, summary, exit code) is reused unchanged

- [ ] Task 4: Normalize post-run status shape from graph engine (AC: #1, #4)
  - [ ] Define a `normalizeGraphSummaryToStatus(summary: GraphRunSummary)` helper in `run.ts`
  - [ ] Map `GraphRunSummary.stories[key].outcome === 'SUCCESS'` → `{ phase: 'COMPLETE' }`
  - [ ] Map `GraphRunSummary.stories[key].outcome === 'ESCALATED'` → `{ phase: 'ESCALATED' }`
  - [ ] Map all other outcomes → `{ phase: 'FAILED' }` (treated as failure for exit code / summary purposes)
  - [ ] Return a `{ stories: Record<string, { phase: string }> }` compatible with the existing post-run loops (lines ~1305–1313 in `run.ts`)

- [ ] Task 5: Write unit tests for `--engine` flag routing (AC: #1, #2, #3, #5, #6, #7)
  - [ ] Create (or extend) `src/cli/commands/__tests__/run-engine-flag.test.ts`
  - [ ] Use Vitest; mock `createImplementationOrchestrator`, `buildSdlcHandlerRegistry`, and `createGraphOrchestrator` as `vi.fn()` stubs
  - [ ] Test AC2/AC3: `runRunAction({ engine: undefined })` and `runRunAction({ engine: 'linear' })` both call `createImplementationOrchestrator`, never `createGraphOrchestrator`
  - [ ] Test AC1: `runRunAction({ engine: 'graph' })` calls `createGraphOrchestrator` and calls `graphOrchestrator.run(storyKeys)`
  - [ ] Test AC5: `runRunAction({ engine: 'bogus' })` returns exit code 1 without calling either orchestrator
  - [ ] Test AC7: `runRunAction({ engine: 'graph', concurrency: 2, maxReviewCycles: 3 })` passes `maxConcurrency: 2` and `maxReviewCycles: 3` to `createGraphOrchestrator`

- [ ] Task 6: Build verification (AC: all)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all new and existing tests pass, no regressions
  - [ ] Manually verify `substrate run --help` shows `--engine <type>` option

## Dev Notes

### Architecture Constraints

- **ADR-003 (CLI as composition root)**: `run.ts` is the only file that may import from both `@substrate-ai/sdlc` (`createGraphOrchestrator`) and `src/cli/commands/sdlc-graph-setup.ts` (`buildSdlcHandlerRegistry`). The `GraphOrchestrator` itself must not import from `src/` monolith modules — all wiring happens here.
- **Backward compatibility**: The default `--engine=linear` path must be byte-for-byte functionally identical to the pre-story state. No refactoring of the linear path is permitted in this story — only additive changes.
- **Post-run logic reuse**: The metrics, summary, and exit-code logic that runs after `orchestrator.run(storyKeys)` (lines ~1280–1500 of `run.ts`) must be reused unchanged for both engines. Achieve this by normalizing `GraphRunSummary` into the same `{ stories: Record<string, { phase: string }> }` shape before reaching that block.
- **Event bus**: The `eventBus` created in `runRunAction` (via `createEventBus()`) is passed into both `GraphOrchestrator` config and the existing `wireNdjsonEmitter()` call. The SDLC event bridge (story 43-9), wired inside `GraphOrchestrator.run()`, emits `orchestrator:story-*` events onto this shared bus — which `wireNdjsonEmitter()` already subscribes to. No new NDJSON subscriptions are needed in `run.ts` for graph mode.

### File Paths

- **Modify**: `src/cli/commands/run.ts` — add `--engine` flag, validation, `RunOptions.engine`, and graph routing branch
- **Read (no modification)**: `src/cli/commands/sdlc-graph-setup.ts` — `buildSdlcHandlerRegistry`, `SdlcRegistryDeps`
- **Read (no modification)**: `packages/sdlc/src/orchestrator/graph-orchestrator.ts` — `createGraphOrchestrator`, `GraphOrchestrator`, `GraphRunSummary`
- **New**: `src/cli/commands/__tests__/run-engine-flag.test.ts` — unit tests for engine routing

### SDLC DOT Graph Path Resolution

The SDLC DOT graph file lives at `packages/sdlc/graphs/sdlc-pipeline.dot` in the repo root. At runtime, resolve it relative to the package's install location. The recommended pattern:

```typescript
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const sdlcPkgDir = path.dirname(require.resolve('@substrate-ai/sdlc/package.json'))
const dotGraphPath = path.join(sdlcPkgDir, 'graphs', 'sdlc-pipeline.dot')
```

Alternatively, export a `resolveGraphPath()` helper from `@substrate-ai/sdlc` if the package already provides one (check `packages/sdlc/src/index.ts`). If a helper already exists from story 43-1, prefer it.

### Graph Engine Branch Sketch

```typescript
// Inside runRunAction, after storyKeys is resolved and pipelineRun is created:

if (engine === 'graph') {
  const { buildSdlcHandlerRegistry } = await import('./sdlc-graph-setup.js')
  const { createGraphOrchestrator, resolveGraphPath } = await import('@substrate-ai/sdlc')
  const { parseGraph } = await import('@substrate-ai/factory')

  const dotSource = readFileSync(resolveGraphPath(), 'utf-8')
  const graph = parseGraph(dotSource)

  const handlerRegistry = buildSdlcHandlerRegistry({
    dispatcher,
    pack,
    contextCompiler,
    eventBus,
    projectRoot,
    maxReviewCycles,
    pipelineRunId: pipelineRun.id,
    // ... other SdlcRegistryDeps fields per story 43-6
  })

  const graphOrchestrator = createGraphOrchestrator({
    graph,
    handlerRegistry,
    eventBus,
    maxConcurrency: concurrency,
    maxReviewCycles,
    pipelineRunId: pipelineRun.id,
    projectRoot,
  })

  const graphSummary = await graphOrchestrator.run(storyKeys)
  status = normalizeGraphSummaryToStatus(graphSummary)
} else {
  // existing linear path — unchanged
  const orchestrator = createImplementationOrchestrator({ ... })
  status = await orchestrator.run(storyKeys)
}
```

> **Note:** Use dynamic `import()` for graph-engine modules if static imports cause circular dependency issues during build. Prefer static imports unless the build fails.

### Engine Validation Pattern

```typescript
const VALID_ENGINES = ['linear', 'graph'] as const
type EngineType = typeof VALID_ENGINES[number]

// In runRunAction after destructuring:
const resolvedEngine: EngineType = (engine ?? 'linear') as EngineType
if (!VALID_ENGINES.includes(resolvedEngine)) {
  const errorMsg = `Invalid engine '${engine}'. Valid values: ${VALID_ENGINES.join(', ')}`
  if (outputFormat === 'json') {
    process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
  } else {
    process.stderr.write(`Error: ${errorMsg}\n`)
  }
  return 1
}
```

### GraphRunSummary Normalization

The `GraphRunSummary` type (from story 43-7) has a `stories` map. Confirm the exact shape from `packages/sdlc/src/orchestrator/graph-orchestrator.ts` before implementing `normalizeGraphSummaryToStatus()`. Anticipated shape:

```typescript
interface GraphRunSummary {
  stories: Record<string, {
    outcome: 'SUCCESS' | 'ESCALATED' | 'FAILED' | string
    reviewCycles?: number
    error?: string
  }>
}
```

Map to the linear orchestrator's status shape:

```typescript
function normalizeGraphSummaryToStatus(summary: GraphRunSummary) {
  const stories: Record<string, { phase: string; error?: string }> = {}
  for (const [key, s] of Object.entries(summary.stories)) {
    if (s.outcome === 'SUCCESS') stories[key] = { phase: 'COMPLETE' }
    else if (s.outcome === 'ESCALATED') stories[key] = { phase: 'ESCALATED' }
    else stories[key] = { phase: 'FAILED', error: s.error }
  }
  return { stories }
}
```

### Testing Requirements

- **Framework**: Vitest (same as all other CLI tests in this project)
- **Mock strategy**: Use `vi.mock()` to mock `../../modules/implementation-orchestrator/index.js` (intercept `createImplementationOrchestrator`) and `./sdlc-graph-setup.js` + `@substrate-ai/sdlc` (intercept graph path). Inject minimal stub return values (e.g., `{ run: vi.fn().mockResolvedValue({ stories: {} }) }`).
- **Test isolation**: Each test creates a minimal `RunOptions` object with only the fields under test; provide stubs for all required infrastructure (db adapter, pack, dispatcher, etc.) or test at the `registerRunCommand` level with a Commander `program` instance.
- **Prefer integration-style tests**: Testing at the `runRunAction` function level (rather than end-to-end subprocess tests) is sufficient for this story — parity tests are story 43-11's responsibility.
- **Run**: `npm run test:fast` from monorepo root. Check output for "Test Files" line confirming results.

### Context Keys Reference

No new `IGraphContext` keys are introduced in this story. The `pipelineRunId`, `projectRoot`, `maxReviewCycles`, and `maxConcurrency` values are injected into `GraphOrchestrator` config at construction time, matching the pattern established in story 43-7.

## Interface Contracts

- **Import**: `buildSdlcHandlerRegistry`, `SdlcRegistryDeps` @ `src/cli/commands/sdlc-graph-setup.ts` (from story 43-6)
- **Import**: `createGraphOrchestrator`, `GraphOrchestrator`, `GraphRunSummary` @ `packages/sdlc/src/orchestrator/graph-orchestrator.ts` (from story 43-7)
- **Import**: `createSdlcEventBridge` @ `packages/sdlc/src/handlers/event-bridge.ts` (wired inside `GraphOrchestrator.run()` from story 43-9 — no direct import needed here)
- **Export (consumed by 43-11)**: `RunOptions.engine` field — the parity test suite (story 43-11) will call `runRunAction` with both `engine: 'linear'` and `engine: 'graph'` to verify identical outcomes

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-22: Story created for Epic 43, Phase A — SDLC Pipeline as Graph
