# Story 28-5: Model-Routed Agent Dispatch

Status: review

## Story

As a pipeline operator,
I want the AgentDispatcher to automatically select the model for each dispatch based on the routing configuration,
so that exploration tasks use cheaper models and generation/review tasks use high-capability models without requiring every call site to pass an explicit model.

## Acceptance Criteria

### AC1: Optional RoutingResolver Injection
**Given** `CreateDispatcherOptions` is extended with an optional `routingResolver?: RoutingResolver` field
**When** `createDispatcher(options)` is called with or without a `routingResolver`
**Then** the returned `Dispatcher` stores the resolver (or `null`) and all existing call sites that omit `routingResolver` continue to work with no change in observable behaviour

### AC2: Routing-Resolved Model on Dispatch
**Given** a `DispatcherImpl` constructed with a `RoutingResolver` whose config maps `taskType` → model
**When** `dispatch(request)` is called with `request.model` undefined
**Then** `routingResolver.resolveModel(request.taskType)` is invoked and, if it returns a non-null `ModelResolution`, the `ModelResolution.model` string is passed to `adapter.buildCommand()` as the `model` option

### AC3: Explicit Model Overrides Resolver
**Given** a `DispatcherImpl` constructed with a `RoutingResolver`
**When** `dispatch(request)` is called with `request.model` set to a non-empty string
**Then** the request's explicit model is used unchanged; `routingResolver.resolveModel()` is NOT called and no routing event is emitted

### AC4: Null Resolution Falls Back to Adapter Default
**Given** `routingResolver.resolveModel(taskType)` returns `null` (fallback mode or unconfigured phase)
**When** the dispatcher processes the dispatch
**Then** `adapter.buildCommand()` is called without a `model` option, preserving the adapter's own default; a single `debug`-level log line is emitted: `{ id, taskType, routingSource: 'fallback' }`

### AC5: `routing:model-selected` NDJSON Event
**Given** the dispatcher resolves a model via the routing resolver (non-null resolution)
**When** the dispatch is about to spawn the subprocess
**Then** the dispatcher emits a `routing:model-selected` event on the event bus with payload `{ dispatchId, taskType, model, phase, source }` immediately before the `agent:spawned` event; the event type is added to the event-bus payload map so it is type-safe

### AC6: `run.ts` Wires RoutingResolver at Startup
**Given** `substrate.routing.yml` exists at the project root (or is absent)
**When** the `run` command is executed
**Then** `RoutingResolver.createWithFallback(routingConfigPath, logger)` is called once before `createDispatcher()` and the resulting resolver is passed in `CreateDispatcherOptions.routingResolver`; if the config is absent, the resolver operates in fallback mode and the run proceeds unchanged

### AC7: Unit Tests at 80% Coverage
**Given** the new routing-dispatch integration code in `dispatcher-impl.ts` and the updated `run.ts`
**When** `npm run test:fast` is executed
**Then** all new unit tests in `src/modules/agent-dispatch/__tests__/dispatcher-routing.test.ts` pass; the routing resolution code paths (resolved, null, explicit override) are covered; overall dispatcher module coverage remains ≥ 80%

## Tasks / Subtasks

- [x] Task 1: Extend `DispatchConfig` and `CreateDispatcherOptions` with optional resolver (AC: #1)
  - [x] In `src/modules/agent-dispatch/types.ts`, add `routingResolver?: RoutingResolver` to `DispatchConfig`; import `RoutingResolver` from `../../modules/routing/index.js`
  - [x] In `src/modules/agent-dispatch/dispatcher-impl.ts`, add `private readonly _routingResolver: RoutingResolver | null` field to `DispatcherImpl`; update constructor to accept and store it
  - [x] In `createDispatcher()` factory, pass `options.config?.routingResolver ?? null` to `DispatcherImpl`; add `routingResolver?: RoutingResolver` to `CreateDispatcherOptions`

- [x] Task 2: Resolve model in `_startDispatch` (AC: #2, #3, #4)
  - [x] In `_startDispatch`, after destructuring `request`, compute `const effectiveModel: string | undefined`:
    - If `model` (from request) is a non-empty string → use it directly (AC #3)
    - Else if `this._routingResolver !== null` → call `resolveModel(taskType)`; if non-null result, use `resolution.model`; log debug with `routingSource: resolution.source`
    - Else → `undefined` (AC #4); log debug with `routingSource: 'fallback'`
  - [x] Replace the existing `...(model !== undefined ? { model } : {})` spread in `adapter.buildCommand()` with `...(effectiveModel !== undefined ? { model: effectiveModel } : {})`

- [x] Task 3: Emit `routing:model-selected` event (AC: #5)
  - [x] `routing:model-selected` was already defined in `src/core/event-bus.types.ts` with correct payload shape; verified type matches
  - [x] In `_startDispatch`, after resolving a non-null model via the routing resolver, emit the event immediately before the `agent:spawned` emit
  - [x] When model comes from the explicit request field or resolver returns null, do NOT emit `routing:model-selected`

- [x] Task 4: Wire `RoutingResolver` in `run.ts` (AC: #6)
  - [x] In `src/cli/commands/run.ts`, add import: `import { RoutingResolver } from '../../modules/routing/index.js'`
  - [x] Before the `createDispatcher()` call in the main run path (line ~517), add: `const routingConfigPath = join(projectRoot, 'substrate.routing.yml')` and `const routingResolver = RoutingResolver.createWithFallback(routingConfigPath, logger)`
  - [x] Pass `routingResolver` in the `CreateDispatcherOptions` object; added same wiring to the secondary `createDispatcher` call (~line 1235) for the full pipeline code path

- [x] Task 5: Unit tests (AC: #7)
  - [x] Created `src/modules/agent-dispatch/__tests__/dispatcher-routing.test.ts`
  - [x] Test AC2: dispatcher with a resolver configured for `dev-story` → `resolveModel` called, returned model passed to `adapter.buildCommand`
  - [x] Test AC3: dispatcher with resolver, but `request.model = 'override-model'` → `resolveModel` NOT called, `buildCommand` receives `'override-model'`
  - [x] Test AC4: dispatcher with resolver returning `null` → `buildCommand` called without `model` key
  - [x] Test AC5: `routing:model-selected` event emitted when resolver returns non-null; NOT emitted on fallback or explicit override
  - [x] Test AC1 backward compat: `createDispatcher({ eventBus, adapterRegistry })` (no resolver) → dispatches without error, no routing event
  - [x] All mocks via constructor injection (stub `RoutingResolver` as a plain object with `resolveModel: vi.fn()`)

## Dev Notes

### Architecture Constraints
- **ESM imports**: all internal imports must use `.js` extension
- **Import order**: Node built-ins → third-party → internal, blank line between groups
- **No cross-module direct imports**: import `RoutingResolver` and `ModelResolution` only from `../../modules/routing/index.js` — never from `./model-routing-resolver.js` directly
- **Logging**: use the existing `logger` instance in `dispatcher-impl.ts` (module-level `createLogger('agent-dispatch')`); do NOT create a second logger; add a `routingSource` field to existing debug log calls rather than adding new log lines
- **No config reload / no fs.watch**: `RoutingResolver` is constructed once at CLI startup and passed through; the dispatcher itself does not read the config file
- **Event bus typing**: if TypedEventBus uses a type map (check `src/core/event-bus.ts`), add `'routing:model-selected'` to that map; if it uses `as never` casts (current pattern for `agent:spawned`), use the same cast pattern to avoid breaking the TypeScript build

### File Paths
```
src/modules/agent-dispatch/
  dispatcher-impl.ts          ← MODIFY: add resolver field, update _startDispatch, createDispatcher
  types.ts                    ← MODIFY: add routingResolver to DispatchConfig / CreateDispatcherOptions
  __tests__/
    dispatcher-routing.test.ts  ← NEW

src/core/event-bus.ts         ← MODIFY: add routing:model-selected event payload (if typed map exists)

src/cli/commands/run.ts       ← MODIFY: wire RoutingResolver.createWithFallback before createDispatcher
```

### Model Resolution Logic (pseudocode)
```typescript
// In _startDispatch, after destructuring request:
let effectiveModel: string | undefined = model  // from request

if (effectiveModel === undefined && this._routingResolver !== null) {
  const resolution = this._routingResolver.resolveModel(taskType)
  if (resolution !== null) {
    effectiveModel = resolution.model
    // emit routing:model-selected event here
    logger.debug({ id, taskType, model: resolution.model, source: resolution.source }, 'Routing resolved model')
  } else {
    logger.debug({ id, taskType, routingSource: 'fallback' }, 'Routing returned null — using adapter default')
  }
}

// Then in buildCommand call:
const cmd = adapter.buildCommand(prompt, {
  worktreePath,
  billingMode: 'subscription',
  ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
  // ... rest unchanged
})
```

### run.ts Wiring Pattern
```typescript
import { RoutingResolver } from '../../modules/routing/index.js'
import { join } from 'node:path'

// Before createDispatcher call (both call sites around lines 517 and 1235):
const routingConfigPath = join(projectRoot, 'substrate.routing.yml')
const routingResolver = RoutingResolver.createWithFallback(routingConfigPath, logger)

const dispatcher = createDispatcher({
  eventBus,
  adapterRegistry: injectedRegistry,
  config: {
    routingResolver,
  },
})
```

### Testing Requirements
- **Framework**: vitest — `import { describe, it, expect, vi, beforeEach } from 'vitest'`; no jest APIs
- **Stub RoutingResolver**: in tests, create a minimal stub: `const stubResolver = { resolveModel: vi.fn() }` — no need to import the real class; pass it as `routingResolver` in `CreateDispatcherOptions`
- **Mock AdapterRegistry and EventBus**: use `vi.fn()` stubs injected via constructor — no real subprocess spawning in unit tests
- **No file I/O in unit tests**: `run.ts` integration is tested only to the extent of confirming `createDispatcher` receives the resolver; do not spin up a full CLI
- **Coverage gate**: 80% on `src/modules/agent-dispatch/dispatcher-impl.ts` — the routing resolution code paths are all single-branch; three tests cover them

### Backward Compatibility
All existing `createDispatcher` call sites pass no `routingResolver` — they continue to work identically because the field is optional and defaults to `null`. The `DispatchConfig.routingResolver` field is optional (`?`) so no existing `DispatchConfig` construction sites need updating.

## Interface Contracts

- **Import**: `RoutingResolver`, `ModelResolution` @ `src/modules/routing/index.ts` (from story 28-4)
- **Export**: `routing:model-selected` event payload type @ `src/core/event-bus.ts` (consumed by story 28-8 telemetry savings)
- **Export**: Updated `CreateDispatcherOptions` with `routingResolver?` @ `src/modules/agent-dispatch/dispatcher-impl.ts` (consumed by run.ts, amend.ts, resume.ts, retry-escalated.ts)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-6

### Completion Notes List
- `routing:model-selected` event payload was already defined in `src/core/event-bus.types.ts` (lines 266-273) from a prior story; no change needed there.
- The event is emitted before `agent:spawned` as required.
- Both `createDispatcher` call sites in `run.ts` (implementation-only path ~line 517 and full multi-phase path ~line 1235) are wired with `RoutingResolver.createWithFallback`.
- All 7 unit tests pass; full test suite: 5317 tests across 220 files, all passing.

### File List
- `/home/jplanow/code/jplanow/substrate/src/modules/agent-dispatch/types.ts`
- `/home/jplanow/code/jplanow/substrate/src/modules/agent-dispatch/dispatcher-impl.ts`
- `/home/jplanow/code/jplanow/substrate/src/cli/commands/run.ts`
- `/home/jplanow/code/jplanow/substrate/src/modules/agent-dispatch/__tests__/dispatcher-routing.test.ts`

## Change Log
