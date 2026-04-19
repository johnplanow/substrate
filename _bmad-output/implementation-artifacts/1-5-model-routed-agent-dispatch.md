# Story 1-5: Model-Routed Agent Dispatch

Status: ready-for-dev

## Story

As a pipeline developer,
I want the agent dispatcher to automatically select a model based on the task type's routing phase (explore/generate/review) using the `RoutingResolver` from story 1-4,
so that expensive frontier models are reserved for code generation while cheaper models handle exploration and review tasks, reducing pipeline cost without requiring callers to explicitly specify a model on every dispatch request.

## Acceptance Criteria

### AC1: DispatchConfig Extended with Optional routingResolver
**Given** the `DispatchConfig` interface in `src/modules/agent-dispatch/types.ts`
**When** the story implementation is complete
**Then** `DispatchConfig` has an optional `routingResolver?: RoutingResolver` field with a JSDoc comment; `DispatcherImpl` stores it as `private readonly _routingResolver: RoutingResolver | undefined`; when `routingResolver` is absent from config, `DispatcherImpl` behaves identically to its pre-routing behavior — no errors thrown, no warnings logged, model resolution falls through to the adapter's built-in default

### AC2: Task-Type-to-Phase Mapping
**Given** the `_resolvePhase(taskType: string): PipelinePhase` private method on `DispatcherImpl`
**When** called with a task type string
**Then** `'dev-story'`, `'major-rework'`, `'minor-fixes'`, `'create-story'`, and `'story-generation'` map to `'generate'`; `'code-review'` maps to `'review'`; all other task types — including `'analysis'`, `'planning'`, `'architecture'`, `'readiness-check'`, `'elicitation'`, multi-step phase variants (`'analysis-vision'`, `'planning-frs'`, etc.), and unknown/unrecognised types — map to `'explore'`

### AC3: Automatic Model Resolution Pre-Dispatch (Resolver Wins Over Default, Explicit Wins Over Resolver)
**Given** `DispatcherImpl` constructed with a `routingResolver`
**When** `dispatch(request)` is called
**Then** if `request.model` is explicitly set, it is used as-is and `_resolvePhase` is NOT called; if `request.model` is absent and a `routingResolver` is configured, `resolver.resolveModel(_resolvePhase(taskType))` is called to get the model string and the result is passed to `adapter.buildCommand()` via `AdapterOptions.model`; if neither `request.model` nor a `routingResolver` is present, `AdapterOptions.model` is left undefined (adapter uses its own `DEFAULT_MODEL`)

### AC4: dispatch:model-selected Event Emitted When Routing Resolver Is Active
**Given** `OrchestratorEvents` in `src/core/event-bus.types.ts` and a `DispatcherImpl` with a configured `routingResolver`
**When** `_startDispatch` resolves a model via the routing resolver
**Then** a new `'dispatch:model-selected'` event is defined in `OrchestratorEvents` with payload `{ dispatchId: string; taskType: string; phase: 'explore' | 'generate' | 'review'; model: string; storyKey?: string }`; the event is emitted via `this._eventBus.emit('dispatch:model-selected', ...)` after model resolution and before the subprocess is spawned; when no `routingResolver` is configured (resolver absent), the event is NOT emitted — existing behaviour is preserved unchanged

### AC5: resolvedModel Field Included in DispatchResult
**Given** a dispatch that completes (any outcome: completed, failed, timeout, or no-adapter)
**When** the `DispatchResult` is returned to the caller
**Then** `DispatchResult<T>` has an optional `resolvedModel?: string` field; in `_startDispatch`, after `_resolveModel` is called, `resolvedModel` is set on every `DispatchResult` construction site within that method (no-adapter branch, timeout branch, process-completed branch); for dispatch results constructed before model resolution occurs (queued-then-cancelled path in `dispatch()`), `resolvedModel` is omitted (undefined) — the field is optional throughout

### AC6: Barrel and Module Structure Updated; Existing Tests Remain Green
**Given** the implementation is complete
**When** `npm run build` and `npm run test:fast` are executed
**Then** TypeScript compiles with zero errors; all pre-existing `dispatcher.test.ts` tests pass without modification — the optional `routingResolver` field means no existing `DispatchConfig` literals need to change; `DispatchResult.resolvedModel` being optional means no existing `DispatchResult` consumers require changes; import order in all modified files follows Node built-ins → third-party → internal (relative `.js` suffix for ESM)

### AC7: Unit Test Coverage for Routing Logic ≥ 80%
**Given** the implementation is complete
**When** `npm run test:fast` executes the new test file
**Then** a new file `src/modules/agent-dispatch/__tests__/dispatcher-routing.test.ts` covers: (a) `_resolvePhase` for all mapped task types (generate set, review set, explore fallback); (b) `_resolveModel` — explicit `request.model` bypasses resolver; resolver called when no explicit model; no resolver leaves model undefined; (c) `dispatch:model-selected` event emitted with correct `{ dispatchId, taskType, phase, model }` payload when resolver is active; (d) `DispatchResult.resolvedModel` populated in completed path; (e) no event emitted and no error thrown when resolver is absent; all tests use `vi.fn()` mocks for `RoutingResolver` methods and `vi.spyOn` on `child_process.spawn` to avoid real subprocess execution

## Interface Contracts

- **Import**: `RoutingResolver`, `PipelinePhase` @ `src/modules/routing/index.ts` (from story 1-4)

## Tasks / Subtasks

- [ ] Task 1: Add `'dispatch:model-selected'` event to `OrchestratorEvents` in `src/core/event-bus.types.ts` (AC: #4)
  - [ ] In the "Agent dispatch events" section, add `'dispatch:model-selected': { dispatchId: string; taskType: string; phase: 'explore' | 'generate' | 'review'; model: string; storyKey?: string }` with a JSDoc comment: "Model resolved via RoutingResolver before spawning a sub-agent subprocess"
  - [ ] Use the inline union type `'explore' | 'generate' | 'review'` rather than importing `PipelinePhase` to avoid circular dependency between `core/` and `modules/routing/`
  - [ ] Run `tsc --noEmit` to confirm no type errors after adding the event

- [ ] Task 2: Extend `DispatchConfig` and `DispatchResult` in `src/modules/agent-dispatch/types.ts` (AC: #1, #5)
  - [ ] Add `import type { RoutingResolver } from '../routing/index.js'` at the top of the file, under the existing `import type { ZodSchema } from 'zod'` line, in a new third-party/internal group separated by a blank line
  - [ ] Add optional field to `DispatchConfig`: `/** RoutingResolver instance for per-phase model selection (Story 28-5). When absent, adapters use their built-in default model. */ routingResolver?: RoutingResolver`
  - [ ] Add optional field to `DispatchResult<T>`: `/** Model identifier used for this dispatch, as resolved by RoutingResolver or passed explicitly. Absent for queued-then-cancelled dispatches. */ resolvedModel?: string`
  - [ ] Run `tsc --noEmit` to confirm no breaks in downstream consumers

- [ ] Task 3: Implement `_resolvePhase`, `_resolveModel`, and routing wiring in `dispatcher-impl.ts` (AC: #2, #3)
  - [ ] Add `import type { RoutingResolver, PipelinePhase } from '../../modules/routing/index.js'` in the internal imports section (after node built-ins and third-party, following the existing import order)
  - [ ] Add `private static readonly PHASE_MAP: Record<string, PipelinePhase> = { 'dev-story': 'generate', 'major-rework': 'generate', 'minor-fixes': 'generate', 'create-story': 'generate', 'story-generation': 'generate', 'code-review': 'review' }` as a static class field
  - [ ] Add `private readonly _routingResolver: RoutingResolver | undefined` field declaration after the existing `private readonly _config: DispatchConfig` line
  - [ ] In `constructor`, add: `this._routingResolver = config.routingResolver`
  - [ ] Add private method `_resolvePhase(taskType: string): PipelinePhase`: return `DispatcherImpl.PHASE_MAP[taskType] ?? 'explore'`
  - [ ] Add private method `_resolveModel(taskType: string, explicitModel: string | undefined): { model: string | undefined; phase: PipelinePhase }`: if `explicitModel !== undefined` return `{ model: explicitModel, phase: this._resolvePhase(taskType) }`; else if `this._routingResolver !== undefined` compute `phase = this._resolvePhase(taskType)` and return `{ model: this._routingResolver.resolveModel(phase), phase }`; else return `{ model: undefined, phase: this._resolvePhase(taskType) }`

- [ ] Task 4: Update `_startDispatch` to use resolved model and emit event (AC: #3, #4, #5)
  - [ ] At the start of `_startDispatch`, after destructuring `request`, call `const { model: resolvedModel, phase } = this._resolveModel(taskType, model)` (where `model` is the destructured `request.model`)
  - [ ] Replace the existing adapter `buildCommand` options spread `...(model !== undefined ? { model } : {})` with `...(resolvedModel !== undefined ? { model: resolvedModel } : {})`
  - [ ] After the adapter lookup succeeds and `resolvedModel` is known, emit the event only when `this._routingResolver !== undefined`: `if (this._routingResolver !== undefined && resolvedModel !== undefined) { this._eventBus.emit('dispatch:model-selected' as never, { dispatchId: id, taskType, phase, model: resolvedModel, ...(storyKey !== undefined ? { storyKey } : {}) } as never) }`
  - [ ] Add `resolvedModel` to the no-adapter failure branch `DispatchResult`: `resolvedModel: resolvedModel`
  - [ ] Add `resolvedModel` to the timeout `DispatchResult`: `resolvedModel: resolvedModel`
  - [ ] Add `resolvedModel` to the successful completion and process-failed `DispatchResult` objects in `_handleCompletion` (or the `close` event handler) — wherever `DispatchResult` is finally constructed from collected stdout/stderr

- [ ] Task 5: Propagate `resolvedModel` through the `_handleCompletion` / `close` event path (AC: #5)
  - [ ] Locate the `proc.on('close', ...)` handler (or equivalent completion handler) in `_startDispatch` — this is where the final `DispatchResult` is assembled from `stdoutChunks` and `stderrChunks`
  - [ ] The `resolvedModel` variable is in scope from Task 4's call to `_resolveModel` — add `resolvedModel` to both the success and non-zero-exit `DispatchResult` construction sites within this handler
  - [ ] Confirm all five `DispatchResult` construction sites in `_startDispatch` include the field (no-adapter, timeout, close-success, close-failed, and any early-return paths); compile with `tsc --noEmit`

- [ ] Task 6: Unit tests for routing logic in `src/modules/agent-dispatch/__tests__/dispatcher-routing.test.ts` (AC: #7)
  - [ ] Create the test file; import `DispatcherImpl` and `DispatcherShuttingDownError`; do NOT import from `dispatcher-impl.ts` internals — test via the public `dispatch()` interface
  - [ ] Build `mockRoutingResolver`: `{ resolveModel: vi.fn((phase: string) => phase === 'generate' ? 'claude-opus-4-6' : phase === 'review' ? 'claude-haiku-3-5' : 'claude-haiku-3-5'), resolveAll: vi.fn() } as unknown as RoutingResolver`
  - [ ] Stub `child_process.spawn` using `vi.spyOn(childProcess, 'spawn')` to return a mock `ChildProcess` that emits `close` with code 0 and produces a minimal stdout — prevents real subprocess execution
  - [ ] Test `_resolvePhase` via dispatch events: dispatch with `taskType: 'dev-story'` and assert `dispatch:model-selected` event has `phase: 'generate'`; repeat for `'code-review'` → `'review'`; repeat for `'analysis'` → `'explore'`; repeat for `'unknown-task-type'` → `'explore'`
  - [ ] Test explicit `request.model` bypasses resolver: set `request.model = 'claude-sonnet-4-6'` and assert `resolveModel` is NOT called (check `mockRoutingResolver.resolveModel` call count is 0)
  - [ ] Test `DispatchResult.resolvedModel`: after dispatch completes, assert `result.resolvedModel === 'claude-opus-4-6'` for a `dev-story` dispatch
  - [ ] Test no-resolver fallback: construct `DispatcherImpl` without `routingResolver`; dispatch; assert no `dispatch:model-selected` event is emitted; assert no error is thrown
  - [ ] Mock the event bus: use `{ emit: vi.fn() }` as `TypedEventBus`; assert `emit` was called with `'dispatch:model-selected'` only when resolver is present

- [ ] Task 7: Compile and fast-test gate (AC: #6)
  - [ ] Run `npm run build` — must exit 0 with zero TypeScript errors
  - [ ] Run `npm run test:fast` — must exit 0 with all existing `dispatcher.test.ts` tests passing and all new `dispatcher-routing.test.ts` tests passing
  - [ ] If any pre-existing test fails because `DispatchResult` shape changed (resolvedModel field added), update only the test assertion — not the implementation

## Dev Notes

### File Paths (all modifications or new files)
- `src/core/event-bus.types.ts` — add `'dispatch:model-selected'` event (modify existing)
- `src/modules/agent-dispatch/types.ts` — extend `DispatchConfig` and `DispatchResult` (modify existing)
- `src/modules/agent-dispatch/dispatcher-impl.ts` — add phase map, resolver field, `_resolvePhase`, `_resolveModel`, wire into `_startDispatch` (modify existing)
- `src/modules/agent-dispatch/__tests__/dispatcher-routing.test.ts` — new unit test file

### Architecture Constraints
- **Do NOT modify** `ClaudeCodeAdapter` — `buildCommand()` already accepts `options.model` and passes it as `--model <model>` to the CLI; this story only changes what value the dispatcher provides
- **Do NOT modify** the existing `RoutingEngine`, `RoutingPolicy`, or provider-routing machinery — `RoutingResolver` is an orthogonal, phase-based selection layer that coexists with existing agent routing
- `RoutingResolver` is treated as an opaque interface dependency — `DispatcherImpl` calls only `resolver.resolveModel(phase)` and stores the result; it does not inspect the resolver's config
- The `'explore' | 'generate' | 'review'` type in `OrchestratorEvents` must be kept as an inline union (NOT imported from `routing/`) to prevent circular dependency: `core/` must not import from `modules/`
- `PHASE_MAP` is a `static readonly` class property (not a module-level `const`) so it is accessible in unit tests via `DispatcherImpl` without instantiation, and co-located with the class that uses it
- Import order in `dispatcher-impl.ts` after modification: Node built-ins (`child_process`, `fs`, `path`, `os`, `crypto`) → third-party (none new) → internal modules; new routing import goes in internal group: `import type { RoutingResolver, PipelinePhase } from '../../modules/routing/index.js'`

### Dependency on Existing Code
- `RoutingResolver.resolveModel(phase: PipelinePhase): string` — defined in `src/modules/routing/routing-resolver.ts` and exported from `src/modules/routing/index.ts`; confirmed present from story 1-4
- `PipelinePhase = 'explore' | 'generate' | 'review'` — exported from `src/modules/routing/index.ts`
- `TypedEventBus.emit()` — accepts event name and payload; uses `as never` casts for events not yet in the strict type map; follow existing pattern in `dispatcher-impl.ts` (e.g., `this._eventBus.emit('agent:spawned' as never, { ... } as never)`)
- `DEFAULT_MAX_TURNS` and `DEFAULT_TIMEOUTS` — used in `_startDispatch` before Task 4 changes; do not disturb

### Testing Requirements
- Vitest (NOT Jest); use `vi.mock`, `vi.fn()`, `vi.spyOn` — never `jest.*`
- `child_process.spawn` must be stubbed: return an object with `stdin` (writable mock), `stdout` (readable mock that emits no data), `stderr` (readable mock), `on` (captures `close` listener), `kill` (vi.fn()); trigger `close` with code 0 to complete the dispatch synchronously in tests
- `TypedEventBus` mock: `const mockEventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as TypedEventBus`
- `AdapterRegistry` mock: return a mock `ClaudeCodeAdapter` with `buildCommand: vi.fn(() => ({ binary: 'claude', args: [], env: {}, cwd: '/tmp' }))` and `estimateTokens: vi.fn(() => ({ input: 0, output: 0, total: 0 }))`
- Run the full fast suite to catch any regressions in `dispatcher.test.ts` before closing the story

### Relationship to Story 1-4
- Story 1-4 created `RoutingConfig`, `RoutingResolver`, and `createRoutingResolver` — all exports from `src/modules/routing/index.ts`
- This story (1-5) is the consumer: it injects `RoutingResolver` into `DispatcherImpl` and calls `resolveModel()` at dispatch time
- The caller that constructs `DispatcherImpl` (the orchestrator or CLI) is responsible for creating the `RoutingResolver` via `createRoutingResolver(...)` and passing it in `DispatchConfig.routingResolver`; this story does NOT modify the orchestrator construction site — that is a follow-on integration step

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
