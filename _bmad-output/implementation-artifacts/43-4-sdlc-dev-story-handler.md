# Story 43.4: SDLC Dev-Story Handler

## Story

As a graph engine consumer,
I want a `sdlc.dev-story` node handler that wraps the existing `runDevStory()` compiled workflow,
so that the graph-based SDLC pipeline can execute story implementation with full retry and remediation support.

## Acceptance Criteria

### AC1: Handler Delegates to runDevStory
**Given** the graph engine executes a node with type `sdlc.dev-story`
**When** the handler is invoked with a context containing `storyKey` and `storyFilePath`
**Then** the handler calls `runDevStory(deps, { storyKey, storyFilePath, pipelineRunId?, priorFiles? })` and returns an `SdlcOutcome`

### AC2: Success Outcome Includes Implementation Artifacts
**Given** `runDevStory()` returns `{ result: 'success', ac_met: [...], files_modified: [...], tests: 'pass' }`
**When** the handler maps the result
**Then** it returns `{ status: 'SUCCESS', contextUpdates: { filesModified: string[], acMet: string[] } }`

### AC3: Failure Outcome Includes Remediation Context
**Given** `runDevStory()` returns `{ result: 'failed', ac_failures: [...], files_modified: [...], tests: 'fail', error?: string }`
**When** the handler maps the result
**Then** it returns `{ status: 'FAILURE', failureReason: string, contextUpdates: { acFailures: string[], filesModified: string[] } }` so the graph engine can pass remediation context to the next retry iteration

### AC4: Retry Iteration Receives Prior Remediation Context
**Given** the graph engine retries the `dev_story` node (goal_gate retry loop)
**When** the context contains `devStoryAcFailures` and `devStoryFilesModified` from the prior iteration
**Then** the handler reads those values and passes them to `runDevStory()` as `priorFiles` (accumulated modified files) and includes the prior failure context in the `taskScope` or notes passed to the workflow

### AC5: Telemetry Events Emitted Before and After Execution
**Given** the handler is invoked
**When** execution begins and after `runDevStory()` resolves (success or failure)
**Then** the handler emits `orchestrator:story-phase-start` before calling `runDevStory()` and `orchestrator:story-phase-complete` after, with `{ storyKey, phase: 'dev-story', status }` in the payload

### AC6: Missing Required Context Fields Return FAILURE Without Calling runDevStory
**Given** the context is missing `storyKey` or `storyFilePath`
**When** the handler validates required fields
**Then** it returns `{ status: 'FAILURE', failureReason: 'Missing required context: storyKey, storyFilePath' }` without invoking `runDevStory()`

### AC7: Handler Exported from Package
**Given** the implementation is complete
**When** consumers import from `@substrate-ai/sdlc`
**Then** `createSdlcDevStoryHandler` is exported from `packages/sdlc/src/handlers/sdlc-dev-story-handler.ts` and re-exported from `packages/sdlc/src/handlers/index.ts`

## Tasks / Subtasks

- [ ] Task 1: Define local structural types (AC: #1, #4)
  - [ ] Define minimal local interfaces for `GraphNode`, `IGraphContext`, `Graph`, `Outcome`, `OutcomeStatus` — no cross-package imports (ADR-003)
  - [ ] Define injectable `DevStoryParams` interface matching monolith signature: `{ storyKey, storyFilePath, pipelineRunId?, priorFiles?, taskScope? }`
  - [ ] Define injectable `DevStoryResult` interface: `{ result: 'success' | 'failed', ac_met, ac_failures, files_modified, tests, notes?, error? }`
  - [ ] Define `RunDevStoryFn` injectable type: `(deps: unknown, params: DevStoryParams) => Promise<DevStoryResult>`
  - [ ] Define `SdlcDevStoryHandlerOptions` interface: `{ deps: unknown, eventBus: TypedEventBus<SdlcEvents>, runDevStory: RunDevStoryFn }`

- [ ] Task 2: Implement `createSdlcDevStoryHandler()` factory function (AC: #1, #2, #3, #6)
  - [ ] Extract `storyKey` and `storyFilePath` from context; return FAILURE immediately if either is missing (AC6)
  - [ ] Extract optional context values: `pipelineRunId`, `devStoryFilesModified` (as `priorFiles`), `devStoryAcFailures` (for prior remediation context)
  - [ ] Build `DevStoryParams` with required + optional fields
  - [ ] Emit `orchestrator:story-phase-start` event before calling workflow (AC5)
  - [ ] Call `runDevStory(deps, params)` inside try/catch
  - [ ] Map `result === 'success'` → `{ status: 'SUCCESS', contextUpdates: { filesModified, acMet } }` (AC2)
  - [ ] Map `result === 'failed'` → `{ status: 'FAILURE', failureReason, contextUpdates: { acFailures, filesModified } }` (AC3)
  - [ ] Handle unexpected throws → `{ status: 'FAILURE', failureReason: error.message }`
  - [ ] Emit `orchestrator:story-phase-complete` in finally block with `storyKey`, `phase: 'dev-story'`, and `status` (AC5)

- [ ] Task 3: Implement retry remediation context pass-through (AC: #4)
  - [ ] Read `devStoryAcFailures: string[]` from context (populated by prior iteration's FAILURE contextUpdates)
  - [ ] Read `devStoryFilesModified: string[]` from context (accumulated modified files from prior iterations)
  - [ ] Pass accumulated `devStoryFilesModified` as `priorFiles` in `DevStoryParams` so the workflow agent can see what has already been changed
  - [ ] Construct `taskScope` note describing prior failures if `devStoryAcFailures` is present (e.g., `"Prior attempt failed ACs: ${acFailures.join(', ')}"`)

- [ ] Task 4: Write unit tests (AC: #1, #2, #3, #4, #5, #6, #7)
  - [ ] Test: success path — `runDevStory` returns `{ result: 'success' }` → handler returns SUCCESS outcome with correct contextUpdates
  - [ ] Test: failure path — `runDevStory` returns `{ result: 'failed' }` → handler returns FAILURE outcome with acFailures and filesModified in contextUpdates
  - [ ] Test: retry path — context contains `devStoryAcFailures` + `devStoryFilesModified` → `runDevStory` called with `priorFiles` populated
  - [ ] Test: missing storyKey → handler returns FAILURE without calling `runDevStory`
  - [ ] Test: missing storyFilePath → handler returns FAILURE without calling `runDevStory`
  - [ ] Test: unexpected throw from `runDevStory` → handler returns FAILURE with error message
  - [ ] Test: telemetry events emitted in correct order (start before, complete after)
  - [ ] Test: `orchestrator:story-phase-complete` emitted even when `runDevStory` throws

- [ ] Task 5: Export handler from package barrel (AC: #7)
  - [ ] Export `createSdlcDevStoryHandler` and `SdlcDevStoryHandlerOptions` from `packages/sdlc/src/handlers/index.ts`
  - [ ] Verify the sdlc package top-level barrel (`packages/sdlc/src/index.ts`) re-exports from handlers/index.ts
  - [ ] Run `npm run build` in the monorepo root to confirm zero TypeScript errors

## Dev Notes

### Architecture Constraints

- **ADR-003 (no cross-package coupling)**: All factory/graph engine types must be defined locally as minimal structural interfaces. Do NOT import from `@substrate-ai/factory` at runtime. The `SdlcOutcome` type from `packages/sdlc/src/handlers/types.ts` is already compatible with factory's `Outcome` via duck typing.
- **Import `runDevStory` as injectable**: The factory function receives `RunDevStoryFn` as a dependency so it can be mocked in tests. The CLI composition root (`src/cli/commands/run.ts`) will inject the real implementation from the monolith.
- **Import real `runDevStory`** only from the monolith path: `import { runDevStory } from '../../../src/modules/compiled-workflows/dev-story'` — this is the composition root concern, not the handler's.
- **Use `SdlcOutcome` from `packages/sdlc/src/handlers/types.ts`** — do not define a new outcome type; extend contextUpdates appropriately.
- **TypedEventBus** — import from `@substrate-ai/core` (same as create-story handler).

### File Paths

- **New file**: `packages/sdlc/src/handlers/sdlc-dev-story-handler.ts`
- **New test**: `packages/sdlc/src/handlers/__tests__/sdlc-dev-story-handler.test.ts`
- **Modify**: `packages/sdlc/src/handlers/index.ts` — add exports for `createSdlcDevStoryHandler` and `SdlcDevStoryHandlerOptions`

### Implementation Pattern

Mirror the structure of `sdlc-create-story-handler.ts` (Story 43-3):

```typescript
// Local structural interfaces (no @substrate-ai/factory imports)
interface GraphNode { id: string; label: string; prompt: string }
interface IGraphContext {
  getString(key: string, defaultValue?: string): string
  getList?(key: string): string[]
}
interface Graph {}
type OutcomeStatus = 'SUCCESS' | 'FAILURE' | 'PARTIAL_SUCCESS' | 'NEEDS_RETRY' | 'ESCALATE'
interface Outcome {
  status: OutcomeStatus
  failureReason?: string
  contextUpdates?: Record<string, unknown>
  notes?: string
}
type NodeHandler = (node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>

interface DevStoryParams {
  storyKey: string
  storyFilePath: string
  pipelineRunId?: string
  priorFiles?: string[]
  taskScope?: string
}
interface DevStoryResult {
  result: 'success' | 'failed'
  ac_met: string[]
  ac_failures: string[]
  files_modified: string[]
  tests: 'pass' | 'fail'
  notes?: string
  error?: string
}
type RunDevStoryFn = (deps: unknown, params: DevStoryParams) => Promise<DevStoryResult>

export interface SdlcDevStoryHandlerOptions {
  deps: unknown
  eventBus: TypedEventBus<SdlcEvents>
  runDevStory: RunDevStoryFn
}

export function createSdlcDevStoryHandler(options: SdlcDevStoryHandlerOptions): NodeHandler {
  // ...
}
```

### Context Keys Reference

| Key (read from context) | Type | Description |
|---|---|---|
| `storyKey` | string | Required. Story identifier (e.g., `43-4`) |
| `storyFilePath` | string | Required. Absolute path to story file on disk |
| `pipelineRunId` | string | Optional. Run ID for telemetry correlation |
| `devStoryFilesModified` | string[] | Optional. Files modified in prior failed iteration (for `priorFiles`) |
| `devStoryAcFailures` | string[] | Optional. AC failures from prior iteration |

| Key (written to contextUpdates) | Type | Description |
|---|---|---|
| `filesModified` | string[] | Files modified in this iteration |
| `acMet` | string[] | ACs satisfied (on success) |
| `acFailures` | string[] | ACs not met (on failure) |
| `devStoryFilesModified` | string[] | Same as filesModified — persisted for retry pass-through |
| `devStoryAcFailures` | string[] | Same as acFailures — persisted for retry pass-through |

### Telemetry Events

```typescript
// Before runDevStory():
eventBus.emit('orchestrator:story-phase-start', { storyKey, phase: 'dev-story', pipelineRunId })

// After runDevStory() (in finally):
eventBus.emit('orchestrator:story-phase-complete', {
  storyKey,
  phase: 'dev-story',
  status: outcome.status,
  pipelineRunId,
})
```

### Testing Requirements

- **Framework**: Vitest (same as all sdlc package tests)
- **Mock pattern**: inject `runDevStory` via `SdlcDevStoryHandlerOptions.runDevStory` — use `vi.fn()` in tests
- **Event bus mock**: use `vi.fn()` for `eventBus.emit`, verify call order (start before complete)
- **Context mock**: implement minimal `IGraphContext` with a `getString()` that returns test values; add `getList()` returning string arrays for prior-iteration fields
- **Test file**: `packages/sdlc/src/handlers/__tests__/sdlc-dev-story-handler.test.ts`
- **Run**: `npm run test:fast` from monorepo root; confirm zero failures

## Interface Contracts

- **Import**: `SdlcOutcome` @ `packages/sdlc/src/handlers/types.ts` (from story 43-2)
- **Import**: `SdlcEvents`, `TypedEventBus` @ `@substrate-ai/core` (event bus infrastructure)
- **Export**: `createSdlcDevStoryHandler` @ `packages/sdlc/src/handlers/sdlc-dev-story-handler.ts` (consumed by story 43-6 — handler registration)
- **Export**: `SdlcDevStoryHandlerOptions` @ `packages/sdlc/src/handlers/sdlc-dev-story-handler.ts` (consumed by story 43-6)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-22: Story created for Epic 43, Phase A — SDLC Pipeline as Graph
