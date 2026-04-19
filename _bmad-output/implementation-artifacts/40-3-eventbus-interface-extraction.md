# Story 40.3: EventBus Interface Extraction

## Story

As a substrate-core package consumer,
I want a generic `TypedEventBus<E extends EventMap>` interface and a `CoreEvents` type map defined in `packages/core/src/events/`,
so that other packages can depend on a stable, type-safe event bus contract without importing the monolith `src/core/event-bus.ts`.

## Acceptance Criteria

### AC1: Base EventMap and EventHandler Types Defined
**Given** the `packages/core/src/events/` directory exists (created in story 40-2)
**When** `packages/core/src/events/types.ts` is created
**Then** it exports `EventMap` as `type EventMap = Record<string, unknown>` and `EventHandler<T>` as `type EventHandler<T> = (payload: T) => void`

### AC2: Generic TypedEventBus Interface Defined
**Given** `EventMap` and `EventHandler` types exist
**When** `packages/core/src/events/event-bus.ts` is created
**Then** it exports `TypedEventBus<E extends EventMap>` interface with three methods:
- `emit<K extends keyof E>(event: K, payload: E[K]): void`
- `on<K extends keyof E>(event: K, handler: EventHandler<E[K]>): void`
- `off<K extends keyof E>(event: K, handler: EventHandler<E[K]>): void`

### AC3: CoreEvents Type Map Defined with Required Events
**Given** the generic `TypedEventBus<E>` interface is defined
**When** `packages/core/src/events/core-events.ts` is created
**Then** it exports `CoreEvents` as a TypeScript interface containing at minimum these event keys with typed payloads:
`task:ready`, `task:started`, `task:complete`, `task:failed`, `agent:spawned`, `agent:completed`, `agent:failed`, `budget:warning`, `config:reloaded`

### AC4: CoreEvents Covers All Non-SDLC Events from OrchestratorEvents
**Given** the existing `src/core/event-bus.types.ts` has 60+ events spanning core and SDLC concerns
**When** `CoreEvents` is defined
**Then** it includes all infrastructure events (task:*, worker:*, budget:*, graph:*, worktree:*, cost:*, monitor:*, config:*, routing:*, provider:*, version:*, agent:*) **and** excludes all SDLC-specific events (`orchestrator:*`, `plan:*`, `solutioning:*`, `story:*`, `pipeline:phase-*`) which are reserved for `SdlcEvents` in story 40-9

### AC5: Barrel Export from `packages/core/src/events/index.ts`
**Given** all event type files are created
**When** `packages/core/src/events/index.ts` is created
**Then** it re-exports `TypedEventBus`, `EventMap`, `EventHandler`, `CoreEvents`, and all event payload types needed by consumers

### AC6: Root Core Barrel Includes Events Exports
**Given** the events barrel exists
**When** `packages/core/src/index.ts` is checked or updated
**Then** it contains `export * from './events/index.js'`

### AC7: TypeScript Compilation Succeeds in Core Package
**Given** all files are created with correct ESM `.js` extension imports
**When** `npm run build` is run inside `packages/core/`
**Then** TypeScript compiles with zero errors and composite build artifacts are emitted to `packages/core/dist/`

## Tasks / Subtasks

- [x] Task 1: Create base event types file (AC: #1)
  - [x] Create `packages/core/src/events/types.ts`
  - [x] Export `type EventMap = Record<string, unknown>`
  - [x] Export `type EventHandler<T> = (payload: T) => void`

- [x] Task 2: Create generic TypedEventBus interface (AC: #2)
  - [x] Create `packages/core/src/events/event-bus.ts`
  - [x] Import `EventMap` and `EventHandler` from `./types.js` (ESM `.js` extension required)
  - [x] Export `TypedEventBus<E extends EventMap>` interface with `emit`, `on`, `off` typed against `E`

- [x] Task 3: Extract CoreEvents type map (AC: #3, #4)
  - [x] Read `src/core/event-bus.types.ts` to inventory all 60+ OrchestratorEvents entries
  - [x] Categorize each event as "core" (task:*, worker:*, budget:*, graph:*, worktree:*, cost:*, monitor:*, config:*, routing:*, provider:*, version:*, agent:*) vs "SDLC" (orchestrator:*, plan:*, solutioning:*, story:*, pipeline:phase-*)
  - [x] Create `packages/core/src/events/core-events.ts`
  - [x] Export `CoreEvents` interface containing exactly the core-categorized events with their original payload shapes copied verbatim (no behavioral changes)
  - [x] Copy all referenced payload types (e.g., `TaskResult`, `TaskError`, `RoutingDecision`, `AgentOutputPayload`, etc.) into `packages/core/src/events/core-events.ts` or a companion `packages/core/src/events/payloads.ts`

- [x] Task 4: Wire barrel exports (AC: #5, #6)
  - [x] Create `packages/core/src/events/index.ts` re-exporting all symbols from `./types.js`, `./event-bus.js`, `./core-events.js`
  - [x] Ensure `packages/core/src/index.ts` includes `export * from './events/index.js'`

- [x] Task 5: Verify build and zero TypeScript errors (AC: #7)
  - [x] Run `npm run build` inside `packages/core/` and confirm exit code 0
  - [x] Confirm `packages/core/dist/events/` directory is populated with `.js` and `.d.ts` files
  - [x] If compilation errors exist, fix import paths or missing type references before marking done

## Dev Notes

### Architecture Constraints
- **INTERFACE DEFINITION ONLY** — do NOT modify or move `src/core/event-bus.ts`, `src/core/event-bus.types.ts`, or any existing source files. This story defines new interfaces in `packages/core/`; implementations are migrated in later epics.
- **ESM imports** — all intra-package imports must use `.js` extensions: `import { EventMap } from './types.js'` (TypeScript resolves these to `.ts` at compile time via `moduleResolution: "Bundler"` or `"Node16"`).
- **No circular dependencies** — `packages/core/src/events/` must import nothing else from `packages/core/`. It is a leaf module.
- **Payload types** — copy payload type shapes verbatim from `src/core/event-bus.types.ts` rather than importing from the monolith `src/`. The goal is a standalone, self-contained interface package.
- **Generic constraint** — `TypedEventBus<E extends EventMap>` replaces the non-generic `TypedEventBus` used in the monolith. The monolith's `TypedEventBus` (hardcoded to `OrchestratorEvents`) is NOT modified here.
- **SDLC event boundary** — events with prefixes `orchestrator:`, `plan:`, `solutioning:`, `story:`, `pipeline:phase-` are explicitly excluded from `CoreEvents`. They belong in `SdlcEvents` (story 40-9).

### Key Files to Read Before Starting
- `src/core/event-bus.ts` — existing non-generic interface and implementation (reference only)
- `src/core/event-bus.types.ts` — full `OrchestratorEvents` definition to copy payload types from
- `packages/core/tsconfig.json` — verify `composite: true`, `outDir`, `rootDir` from story 40-2
- `packages/core/src/index.ts` — barrel to update with events re-export

### Target File Structure
```
packages/core/src/events/
├── types.ts          # EventMap, EventHandler base types
├── event-bus.ts      # TypedEventBus<E extends EventMap> interface
├── core-events.ts    # CoreEvents interface + payload types
└── index.ts          # barrel export
```

### Event Categorization Reference
**Include in CoreEvents** (core infrastructure):
- `task:*` — task:ready, task:started, task:progress, task:complete, task:failed, task:cancelled, task:retrying, task:routed, task:budget-set
- `worker:*` — worker:spawned, worker:terminated
- `budget:*` — budget:warning, budget:exceeded, budget:warning:task, budget:exceeded:task, budget:warning:session, session:budget:exceeded, session:budget-set
- `graph:*` — graph:loaded, graph:complete, graph:cancelled, graph:paused, graph:resumed
- `worktree:*` — worktree:created, worktree:merged, worktree:conflict, worktree:removed
- `cost:*` — cost:recorded
- `monitor:*` — monitor:metrics_recorded, monitor:recommendation_generated
- `config:*` — config:reloaded
- `routing:*` — routing:model-selected, routing:auto-tuned
- `provider:*` — provider:unavailable, provider:available
- `version:*` — version:update_available
- `agent:*` — agent:spawned, agent:output, agent:completed, agent:failed, agent:timeout
- `orchestrator:ready`, `orchestrator:shutdown` — system lifecycle (not SDLC workflow events)

**Exclude from CoreEvents** (SDLC-specific, for SdlcEvents in story 40-9):
- `orchestrator:started`, `orchestrator:story-phase-start`, `orchestrator:story-phase-complete`, `orchestrator:story-complete`, `orchestrator:story-escalated`, `orchestrator:story-warn`, `orchestrator:zero-diff-escalation`, `orchestrator:complete`, `orchestrator:paused`, `orchestrator:resumed`, `orchestrator:heartbeat`, `orchestrator:stall`
- `plan:*` — all plan events
- `solutioning:*` — all solutioning events
- `story:*` — all story events
- `pipeline:phase-start`, `pipeline:phase-complete`, `pipeline:pre-flight-failure`, `pipeline:contract-mismatch`, `pipeline:contract-verification-summary`, `pipeline:state-conflict`, `pipeline:repo-map-stale`, `pipeline:profile-stale`

### Testing Requirements
- This story produces only TypeScript type definitions — no runtime behavior is added or changed
- There are no unit tests to write for pure interface/type declarations
- Verification is done by TypeScript compilation: `npm run build` in `packages/core/` must exit 0
- Do NOT run the full monorepo test suite (`npm test`) — only the core package build needs to pass for this story

## Interface Contracts

- **Export**: `TypedEventBus<E extends EventMap>` @ `packages/core/src/events/event-bus.ts` (consumed by stories 40-4, 40-8, 40-9)
- **Export**: `CoreEvents` @ `packages/core/src/events/core-events.ts` (consumed by story 40-8, 40-9)
- **Export**: `EventMap`, `EventHandler` @ `packages/core/src/events/types.ts` (consumed by stories 40-4 through 40-9)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All 5 tasks completed successfully
- `packages/core/package.json` is auto-normalized by project tooling (scripts section may be stripped); build verified via `../../node_modules/.bin/tsc -p tsconfig.json` (also works as `npm run build` when scripts are present)
- `SubstrateConfig` type is defined as a plain TypeScript interface (no zod dependency) to keep `packages/core` self-contained
- `CoreProviderConfig` is a helper interface used inside `SubstrateConfig` to avoid repetition
- `orchestrator:ready` and `orchestrator:shutdown` are included in CoreEvents as system lifecycle events per spec; all other `orchestrator:*` events are excluded as SDLC-specific
- `tsconfig.base.json` at root provides shared compiler options; `packages/core/tsconfig.json` extends it with `composite: true`, `outDir: dist`, `rootDir: src`

### File List
- `packages/core/package.json` (created/updated)
- `packages/core/tsconfig.json` (created by story 40-2, verified)
- `packages/core/src/index.ts` (updated — added `export * from './events/index.js'`)
- `packages/core/src/events/types.ts` (created)
- `packages/core/src/events/event-bus.ts` (created)
- `packages/core/src/events/core-events.ts` (created)
- `packages/core/src/events/index.ts` (created)

## Change Log

- 2026-03-22: Story created for Epic 40 (Core Extraction Phase 1)
