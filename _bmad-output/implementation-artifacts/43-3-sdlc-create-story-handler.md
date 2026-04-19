# Story 43-3: SDLC Create-Story Handler

## Story

As a graph engine consumer,
I want an `SdlcCreateStoryHandler` that wraps the existing `runCreateStory()` compiled workflow,
so that `sdlc.create-story` nodes execute the proven story-file generation logic and return a typed `Outcome` with the same telemetry events as the existing `ImplementationOrchestrator`.

## Acceptance Criteria

### AC1: Handler Delegates to runCreateStory
**Given** a node with `type="sdlc.create-story"` and a `GraphContext` containing `storyKey` and `epicId`
**When** the handler executes
**Then** it calls `runCreateStory(deps, { epicId, storyKey, pipelineRunId? })` with values extracted from context

### AC2: Success Outcome with Story File Path
**Given** `runCreateStory()` returns `{ result: 'success', story_file: '/some/path.md', ... }`
**When** the handler maps the result
**Then** it returns `{ status: 'SUCCESS', contextUpdates: { storyFilePath: '/some/path.md', storyKey: ..., storyTitle: ... } }`

### AC3: Failure Outcome on runCreateStory Error
**Given** `runCreateStory()` returns `{ result: 'failed', error: 'some reason' }`
**When** the handler maps the result
**Then** it returns `{ status: 'FAILURE', failureReason: 'some reason' }`

### AC4: Telemetry Events Emitted
**Given** the handler executes
**When** `runCreateStory()` starts and completes (regardless of success/failure)
**Then** `orchestrator:story-phase-start` with `{ storyKey, phase: 'create-story' }` is emitted before the call, and `orchestrator:story-phase-complete` with `{ storyKey, phase: 'create-story', result }` is emitted after

### AC5: Missing Required Context Fails Gracefully
**Given** a `GraphContext` missing `storyKey` or `epicId`
**When** the handler executes
**Then** it returns `{ status: 'FAILURE', failureReason: '<field> is required in GraphContext' }` without calling `runCreateStory()`

### AC6: Handler Exported from SDLC Package
**Given** the `packages/sdlc/src/handlers/` directory
**When** `createSdlcCreateStoryHandler` factory is called with `WorkflowDeps` and an event bus
**Then** it returns a `NodeHandler` function ready for registration under the `"sdlc.create-story"` key

### AC7: Unit Tests Pass with Mocked Dependencies
**Given** vitest unit tests with a mocked `runCreateStory` and a mock event bus
**When** the test suite runs via `npm run test:fast`
**Then** all handler tests pass: success path, failure path, missing context, and telemetry emission

## Tasks / Subtasks

- [ ] Task 1: Create `packages/sdlc/src/handlers/sdlc-create-story-handler.ts` with factory function (AC: #1, #5, #6)
  - [ ] Import `NodeHandler` from `@substrate-ai/factory` (runtime composition — no compile-time cross-package dep from factory to sdlc per ADR-003)
  - [ ] Import `GraphNode`, `IGraphContext`, `Graph`, `Outcome` from `@substrate-ai/factory`
  - [ ] Import `runCreateStory` from existing compiled workflow at monolith path or core-extracted path (use `../../modules/compiled-workflows/create-story.js` relative import if still in monolith; adjust if extracted)
  - [ ] Import `WorkflowDeps` from compiled workflow types
  - [ ] Import `TypedEventBus`, `SdlcEvents` from `@substrate-ai/sdlc` (or `../events.js`)
  - [ ] Define `SdlcCreateStoryHandlerOptions` interface: `{ deps: WorkflowDeps; eventBus: TypedEventBus<SdlcEvents> }`
  - [ ] Export `createSdlcCreateStoryHandler(options: SdlcCreateStoryHandlerOptions): NodeHandler` factory
  - [ ] Inside factory: validate `storyKey` and `epicId` from context (return `FAILURE` if missing) — AC5
  - [ ] Extract optional `pipelineRunId` via `context.getString('pipelineRunId', undefined)`

- [ ] Task 2: Implement the handler's core logic — telemetry + delegation (AC: #1, #4)
  - [ ] Emit `orchestrator:story-phase-start` with `{ storyKey, phase: 'create-story' }` before calling `runCreateStory()`
  - [ ] Call `options.deps` and `{ epicId, storyKey, pipelineRunId }` into `runCreateStory()`
  - [ ] Wrap call in try/catch: unexpected throws map to `{ status: 'FAILURE', failureReason: err.message }`
  - [ ] Emit `orchestrator:story-phase-complete` with `{ storyKey, phase: 'create-story', result: workflowResult }` in both success and failure paths (use `finally` block or emit before each return)

- [ ] Task 3: Map `CreateStoryResult` to `Outcome` (AC: #2, #3)
  - [ ] On `result.result === 'success'`: return `{ status: 'SUCCESS', contextUpdates: { storyFilePath: result.story_file, storyKey: result.story_key, storyTitle: result.story_title } }`
  - [ ] On `result.result === 'failed'`: return `{ status: 'FAILURE', failureReason: result.error ?? result.details ?? 'create-story workflow failed' }`
  - [ ] Do NOT use `'FAIL'` — the `OutcomeStatus` union uses `'FAILURE'`

- [ ] Task 4: Export from `packages/sdlc/src/handlers/index.ts` (create if not yet created by 43-2) (AC: #6)
  - [ ] Re-export `createSdlcCreateStoryHandler` and `SdlcCreateStoryHandlerOptions` from `index.ts`
  - [ ] Ensure `packages/sdlc/src/index.ts` re-exports from `./handlers/index.js` (add if not already present)

- [ ] Task 5: Write unit tests in `packages/sdlc/src/handlers/__tests__/sdlc-create-story-handler.test.ts` (AC: #1–#7)
  - [ ] Use `vi.fn()` to mock `runCreateStory`; inject via `vi.mock` or parameter override in factory
  - [ ] Mock event bus: create minimal object `{ emit: vi.fn() }` typed as `TypedEventBus<SdlcEvents>`
  - [ ] Test case: success path — verifies `FAILURE` not returned, `contextUpdates.storyFilePath` set, phase events emitted
  - [ ] Test case: failure path — verifies `FAILURE` outcome with `failureReason` from error
  - [ ] Test case: missing `storyKey` — verifies `FAILURE` before `runCreateStory` is called
  - [ ] Test case: missing `epicId` — verifies `FAILURE` before `runCreateStory` is called
  - [ ] Test case: thrown error in `runCreateStory` — verifies `FAILURE` with caught message
  - [ ] Test case: telemetry — verifies `orchestrator:story-phase-start` called before and `orchestrator:story-phase-complete` called after (check call order)

## Dev Notes

### Architecture Constraints

- **NodeHandler signature**: `(node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>` (from `packages/factory/src/handlers/types.ts`). The architecture shows an `execute` method but the actual implemented type is a plain function — use the function form.
- **Factory pattern**: Use a factory function `createSdlcCreateStoryHandler(options)` that closes over `WorkflowDeps` and `eventBus` — matches the `createCodergenHandler(options?)` pattern from story 42-10 in `packages/factory/src/handlers/codergen-handler.ts`.
- **No compile-time sdlc→factory or factory→sdlc imports** (ADR-003). The SDLC package imports `NodeHandler` type from `@substrate-ai/factory`. The CLI (`src/cli/commands/run.ts`) is the composition root that imports both and wires them at runtime.
- **OutcomeStatus values**: `'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE' | 'NEEDS_RETRY' | 'ESCALATE'` (defined in `packages/factory/src/graph/types.ts`). The epics doc says `'FAIL'` but the actual type uses `'FAILURE'` — always use `'FAILURE'`.
- **SdlcEvents is in `packages/sdlc/src/events.ts`** and re-exported from `packages/sdlc/src/index.ts`. Import event bus type as `TypedEventBus<SdlcEvents>` from `@substrate-ai/core`/`@substrate-ai/sdlc`.
- **runCreateStory location**: `src/modules/compiled-workflows/create-story.ts` (monolith). The import path depends on whether it has been extracted to `@substrate-ai/core` or `@substrate-ai/sdlc` by the time this story is implemented. Check the actual export at implementation time.
- **WorkflowDeps** is defined in `src/modules/compiled-workflows/types.ts`. It requires `db`, `pack`, `contextCompiler`, `dispatcher`, and optional fields. The handler factory accepts it wholesale — the caller (CLI) constructs and injects the full `WorkflowDeps` instance.

### Context Keys

The handler extracts these keys from `IGraphContext` using `context.getString(key, default)`:

| Key | Required | Default | Source |
|-----|----------|---------|--------|
| `storyKey` | Yes | — | Set by multi-story orchestrator (43-7) before dispatching story node |
| `epicId` | Yes | — | Set by pipeline runner at graph init |
| `pipelineRunId` | No | `''` | Set by pipeline runner at graph init |

Return `FAILURE` immediately (before calling `runCreateStory`) if `storyKey` or `epicId` is empty/missing.

### Testing Requirements

- **Test framework**: vitest with `vi.mock` and `vi.fn()`. Run via `npm run test:fast`.
- **Mocking strategy**: The factory pattern means `runCreateStory` is imported at the module level. Use `vi.mock('../../modules/compiled-workflows/create-story.js', ...)` (or equivalent path) to intercept calls. Alternatively, refactor the factory to accept `runCreateStory` as an injected dep via `options` — this is simpler to test and preferred.
- **Event bus mock**: `const mockEventBus = { emit: vi.fn() } as unknown as TypedEventBus<SdlcEvents>`
- **GraphContext mock**: Use `{ getString: vi.fn().mockImplementation((key, def) => ctx[key] ?? def), get: vi.fn() }` pattern matching prior handler tests.
- **No integration tests needed** at this story — 43-11 (parity test suite) handles end-to-end validation.

### File Paths

- **New file**: `packages/sdlc/src/handlers/sdlc-create-story-handler.ts`
- **New test file**: `packages/sdlc/src/handlers/__tests__/sdlc-create-story-handler.test.ts`
- **Existing file (may extend)**: `packages/sdlc/src/handlers/index.ts` (created by 43-2)
- **Existing file (may extend)**: `packages/sdlc/src/index.ts`
- **Reference handler**: `packages/factory/src/handlers/codergen-handler.ts` (pattern to follow)
- **Reference types**: `packages/factory/src/handlers/types.ts`, `packages/factory/src/graph/types.ts`
- **Workflow function**: `src/modules/compiled-workflows/create-story.ts`
- **Workflow types**: `src/modules/compiled-workflows/types.ts`

## Interface Contracts

- **Import**: `NodeHandler`, `GraphNode`, `IGraphContext`, `Graph`, `Outcome` @ `packages/factory/src/handlers/types.ts` and `packages/factory/src/graph/types.ts` (from story 42-9 / 42-8)
- **Import**: `SdlcEvents` @ `packages/sdlc/src/events.ts` (from story 40-x)
- **Import**: `TypedEventBus` @ `@substrate-ai/core` (from story 40-x)
- **Export**: `createSdlcCreateStoryHandler` @ `packages/sdlc/src/handlers/sdlc-create-story-handler.ts` (consumed by story 43-6: SDLC Handler Registration)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
