# Story 40.9: SDLC and Factory Event Type Definitions

## Story

As a substrate-sdlc and substrate-factory package consumer,
I want `SdlcEvents` and `FactoryEvents` type maps defined in their respective packages,
so that `TypedEventBus<SdlcEvents>` and `TypedEventBus<FactoryEvents>` instances can be typed with both core infrastructure events and domain-specific pipeline or graph execution events.

## Acceptance Criteria

### AC1: SdlcEvents Defined with Orchestrator Story-Lifecycle Events
**Given** `packages/sdlc/src/events.ts` is created
**When** `SdlcEvents` is imported
**Then** it is a TypeScript type that extends `CoreEvents` (via intersection) and includes all SDLC orchestrator story-lifecycle events: `orchestrator:started`, `orchestrator:story-phase-start`, `orchestrator:story-phase-complete`, `orchestrator:story-complete`, `orchestrator:story-escalated`, `orchestrator:story-warn`, `orchestrator:zero-diff-escalation`, `orchestrator:complete`, `orchestrator:paused`, `orchestrator:resumed`, `orchestrator:heartbeat`, `orchestrator:stall` — with payload shapes copied verbatim from `src/core/event-bus.types.ts`

### AC2: SdlcEvents Includes Plan and Solutioning Events
**Given** `SdlcEvents` is defined
**When** its event keys are inspected
**Then** it includes all `plan:*` events (`plan:generating`, `plan:generated`, `plan:approved`, `plan:rejected`, `plan:refining`, `plan:refined`, `plan:rolled-back`, `plan:refinement-failed`) and all `solutioning:*` events (`solutioning:readiness-check`, `solutioning:readiness-failed`) with payload shapes matching `src/core/event-bus.types.ts`

### AC3: SdlcEvents Includes Story and Pipeline Events
**Given** `SdlcEvents` is defined
**When** its event keys are inspected
**Then** it includes all `story:*` events (`story:checkpoint-saved`, `story:checkpoint-retry`, `story:build-verification-failed`, `story:build-verification-passed`, `story:interface-change-warning`, `story:metrics`) and all `pipeline:*` events (`pipeline:phase-start`, `pipeline:phase-complete`, `pipeline:pre-flight-failure`, `pipeline:contract-mismatch`, `pipeline:contract-verification-summary`, `pipeline:state-conflict`, `pipeline:repo-map-stale`, `pipeline:profile-stale`) with payload shapes matching the monolith source

### AC4: FactoryEvents Defined with Graph Lifecycle and Node Execution Events
**Given** `packages/factory/src/events.ts` is created
**When** `FactoryEvents` is imported
**Then** it is a TypeScript type that extends `CoreEvents` (via intersection) and includes all factory graph-lifecycle events (`graph:started`, `graph:completed`, `graph:failed`) and node execution events (`graph:node-started`, `graph:node-completed`, `graph:node-retried`, `graph:node-failed`), plus edge and checkpoint events (`graph:edge-selected`, `graph:checkpoint-saved`) and goal-gate events (`graph:goal-gate-checked`, `graph:goal-gate-unsatisfied`) with payload shapes from architecture Section 8.2

### AC5: FactoryEvents Includes Scenario and Convergence Events; All Payloads Carry runId
**Given** `FactoryEvents` is defined
**When** its `scenario:*` and `convergence:*` events are inspected
**Then** it includes `scenario:started`, `scenario:completed`, `convergence:iteration`, `convergence:plateau-detected`, and `convergence:budget-exhausted`; and every factory-specific event payload includes `runId: string` as its first field

### AC6: Both Event Maps Barrel-Exported and TypedEventBus-Compatible
**Given** `SdlcEvents` and `FactoryEvents` are defined
**When** `packages/sdlc/src/index.ts` and `packages/factory/src/index.ts` are updated to `export * from './events.js'`
**Then** `SdlcEvents`, `FactoryEvents`, and all their payload helper types (`EscalationDiagnosis`, `ScenarioResult`, `ScenarioRunResult`, `Outcome`, `SolutioningFinding`) are importable from `@substrate-ai/sdlc` and `@substrate-ai/factory` respectively, and each can be used as the type parameter of `TypedEventBus<SdlcEvents>` and `TypedEventBus<FactoryEvents>` from `@substrate-ai/core`

### AC7: TypeScript Compilation Succeeds for Both Packages
**Given** all event type files are created with correct ESM `.js` extension imports
**When** `npx tsc -b packages/sdlc --force` and `npx tsc -b packages/factory --force` are run
**Then** both compile with zero errors and emit `.js`, `.d.ts`, and `.d.ts.map` artifacts to their respective `dist/` directories

## Tasks / Subtasks

- [x] Task 1: Define SDLC helper payload types in `packages/sdlc/src/events.ts` (AC: #1, #2, #3)
  - [x] Read `src/core/event-bus.types.ts` in full; locate all `orchestrator:story-*`, `orchestrator:started`, `orchestrator:complete`, `orchestrator:paused`, `orchestrator:resumed`, `orchestrator:heartbeat`, `orchestrator:stall`, `plan:*`, `solutioning:*`, `story:*`, `pipeline:*` payload type definitions
  - [x] Define helper types inline in `packages/sdlc/src/events.ts`: `EscalationDiagnosis` (the nested diagnosis object from `orchestrator:story-escalated`), `SolutioningFinding` (the array element type from `solutioning:readiness-failed`'s `findings` field), and `StoryPhaseBreakdown` (the `phaseBreakdown` field from `story:metrics`)
  - [x] Add `import type { CoreEvents } from '@substrate-ai/core'` at the top (ESM — no `.js` extension needed for package imports)

- [x] Task 2: Define `SdlcEvents` type with orchestrator story-lifecycle events (AC: #1)
  - [x] Export `type SdlcEvents = CoreEvents & { ... }` in `packages/sdlc/src/events.ts`
  - [x] Add all 12 orchestrator events: `orchestrator:started`, `orchestrator:story-phase-start`, `orchestrator:story-phase-complete`, `orchestrator:story-complete`, `orchestrator:story-escalated`, `orchestrator:story-warn`, `orchestrator:zero-diff-escalation`, `orchestrator:complete`, `orchestrator:paused`, `orchestrator:resumed`, `orchestrator:heartbeat`, `orchestrator:stall` with payload shapes verbatim from source
  - [x] For `orchestrator:story-escalated`, inline the `EscalationDiagnosis` type as the `diagnosis?` field type

- [x] Task 3: Add plan:*, solutioning:*, story:*, and pipeline:* events to SdlcEvents (AC: #2, #3)
  - [x] Add all 8 `plan:*` events (`plan:generating`, `plan:generated`, `plan:approved`, `plan:rejected`, `plan:refining`, `plan:refined`, `plan:rolled-back`, `plan:refinement-failed`) to the `SdlcEvents` intersection
  - [x] Add `solutioning:readiness-check` and `solutioning:readiness-failed` (inlining `SolutioningFinding` for the findings array element)
  - [x] Add all 6 `story:*` events (`story:checkpoint-saved`, `story:checkpoint-retry`, `story:build-verification-failed`, `story:build-verification-passed`, `story:interface-change-warning`, `story:metrics`)
  - [x] Add all 8 `pipeline:*` events (`pipeline:phase-start`, `pipeline:phase-complete`, `pipeline:pre-flight-failure`, `pipeline:contract-mismatch`, `pipeline:contract-verification-summary`, `pipeline:state-conflict`, `pipeline:repo-map-stale`, `pipeline:profile-stale`)

- [x] Task 4: Define Factory helper payload types in `packages/factory/src/events.ts` (AC: #4, #5)
  - [x] Read architecture file at `_bmad-output/planning-artifacts/architecture-software-factory.md` Section 8.2 for factory event payload shapes
  - [x] Define `type Outcome = 'success' | 'failure' | 'timeout' | 'cancelled'` (or match the exact union from architecture if different)
  - [x] Define `interface ScenarioResult { name: string; status: 'pass' | 'fail'; exitCode: number; stdout: string; stderr: string; durationMs: number }`
  - [x] Define `interface ScenarioRunResult { scenarios: ScenarioResult[]; summary: { total: number; passed: number; failed: number }; durationMs: number }`
  - [x] Add `import type { CoreEvents } from '@substrate-ai/core'` at the top

- [x] Task 5: Define `FactoryEvents` type with all graph:*, scenario:*, and convergence:* events (AC: #4, #5)
  - [x] Export `type FactoryEvents = CoreEvents & { ... }` in `packages/factory/src/events.ts`
  - [x] Add graph lifecycle events: `graph:started`, `graph:completed`, `graph:failed`
  - [x] Add graph node execution events: `graph:node-started`, `graph:node-completed`, `graph:node-retried`, `graph:node-failed`
  - [x] Add graph edge and checkpoint events: `graph:edge-selected`, `graph:checkpoint-saved`
  - [x] Add graph goal-gate events: `graph:goal-gate-checked`, `graph:goal-gate-unsatisfied`
  - [x] Add scenario events: `scenario:started`, `scenario:completed` (using `ScenarioRunResult`)
  - [x] Add convergence events: `convergence:iteration`, `convergence:plateau-detected`, `convergence:budget-exhausted`
  - [x] Verify every factory-specific event payload has `runId: string` as the first field

- [x] Task 6: Update barrel exports for sdlc and factory packages (AC: #6)
  - [x] Update `packages/sdlc/src/index.ts`: replace the empty stub comment with `export * from './events.js'`
  - [x] Update `packages/factory/src/index.ts`: replace the empty stub comment with `export * from './events.js'`
  - [x] Verify that `SdlcEvents`, `FactoryEvents`, and all helper types (`EscalationDiagnosis`, `SolutioningFinding`, `Outcome`, `ScenarioResult`, `ScenarioRunResult`) are reachable from each package's public surface

- [x] Task 7: Verify TypeScript compilation for both packages (AC: #7)
  - [x] Run `npx tsc -b packages/sdlc --force` and confirm exit code 0; fix any errors (typically: missing `.js` extensions, wrong import path for `@substrate-ai/core`, missing type references)
  - [x] Run `npx tsc -b packages/factory --force` and confirm exit code 0
  - [x] Confirm `packages/sdlc/dist/` and `packages/factory/dist/` are populated with `events.js`, `events.d.ts`, `events.d.ts.map`, `index.js`, `index.d.ts`

## Dev Notes

### Architecture Constraints
- **INTERFACE DEFINITION ONLY** — do NOT modify `src/core/event-bus.types.ts` or any monolith source files. This story defines new type aliases in `packages/sdlc/` and `packages/factory/`; the monolith event bus implementation is unchanged until Epic 41.
- **ESM imports** — intra-package imports use `.js` extensions (e.g., `import type { Foo } from './types.js'`). Package cross-references (e.g., `import type { CoreEvents } from '@substrate-ai/core'`) do NOT use `.js` extensions.
- **Intersection type pattern** — use `type SdlcEvents = CoreEvents & { ... }` and `type FactoryEvents = CoreEvents & { ... }` (TypeScript intersection, not `extends`). This ensures `TypedEventBus<SdlcEvents>` sees all CoreEvents keys in addition to SDLC-specific keys. The `EventMap` constraint on `TypedEventBus<E extends EventMap>` is satisfied because `CoreEvents` extends `EventMap` and intersections preserve the constraint.
- **No circular dependencies** — `packages/sdlc` and `packages/factory` both import from `@substrate-ai/core` only. They must not import from each other.
- **Payload verbatim copy** — copy payload shapes exactly from `src/core/event-bus.types.ts` (orchestrator, plan, solutioning, story, pipeline events) and from the architecture document (factory graph/scenario/convergence events). Do not simplify or omit optional fields.
- **Factory graph:* vs CoreEvents graph:*** — CoreEvents already includes `graph:loaded`, `graph:complete`, `graph:cancelled`, `graph:paused`, `graph:resumed` (task-graph lifecycle from the dispatcher). FactoryEvents adds DIFFERENT keys (`graph:started`, `graph:completed`, `graph:failed`, `graph:node-*`) which belong to the Factory's graph execution engine. These are distinct event namespaces and do NOT conflict.
- **packages/sdlc and packages/factory tsconfig.json** — both were scaffolded in story 40-1. Each `tsconfig.json` extends `../../tsconfig.base.json`, has `composite: true`, `outDir: dist`, `rootDir: src`, and includes `@substrate-ai/core` as a project reference. Verify this before building. If the project reference for `packages/core` is missing from `packages/sdlc/tsconfig.json` or `packages/factory/tsconfig.json`, add it.

### Key Source Files to Read Before Starting
- `src/core/event-bus.types.ts` — full monolith `OrchestratorEvents` definition with all payload shapes; read for `orchestrator:*`, `plan:*`, `solutioning:*`, `story:*`, and `pipeline:*` event payloads
- `_bmad-output/planning-artifacts/architecture-software-factory.md` — Section 8.2 for `FactoryEvents` graph/scenario/convergence payload shapes
- `packages/core/src/events/core-events.ts` — confirm which `graph:*`, `orchestrator:*` events are already in CoreEvents (to avoid double-defining them)
- `packages/core/src/events/types.ts` — confirm `EventMap` shape (needed to verify intersection compatibility)
- `packages/sdlc/src/index.ts` — current empty stub (replace with barrel export)
- `packages/factory/src/index.ts` — current empty stub (replace with barrel export)
- `packages/sdlc/tsconfig.json` and `packages/factory/tsconfig.json` — verify project references include `packages/core`

### Target File Structure
```
packages/sdlc/src/
├── events.ts    # EscalationDiagnosis, SolutioningFinding, StoryPhaseBreakdown
│               # SdlcEvents = CoreEvents & { orchestrator:*, plan:*, solutioning:*, story:*, pipeline:* }
└── index.ts    # export * from './events.js'

packages/factory/src/
├── events.ts    # Outcome, ScenarioResult, ScenarioRunResult
│               # FactoryEvents = CoreEvents & { graph:started, graph:completed, ..., scenario:*, convergence:* }
└── index.ts    # export * from './events.js'
```

### SdlcEvents Event Inventory (all events to include)
```
orchestrator:started, orchestrator:story-phase-start, orchestrator:story-phase-complete,
orchestrator:story-complete, orchestrator:story-escalated, orchestrator:story-warn,
orchestrator:zero-diff-escalation, orchestrator:complete, orchestrator:paused,
orchestrator:resumed, orchestrator:heartbeat, orchestrator:stall,
plan:generating, plan:generated, plan:approved, plan:rejected,
plan:refining, plan:refined, plan:rolled-back, plan:refinement-failed,
solutioning:readiness-check, solutioning:readiness-failed,
story:checkpoint-saved, story:checkpoint-retry, story:build-verification-failed,
story:build-verification-passed, story:interface-change-warning, story:metrics,
pipeline:phase-start, pipeline:phase-complete, pipeline:pre-flight-failure,
pipeline:contract-mismatch, pipeline:contract-verification-summary,
pipeline:state-conflict, pipeline:repo-map-stale, pipeline:profile-stale
```

### FactoryEvents Event Inventory (all events to include)
```
graph:started, graph:completed, graph:failed,
graph:node-started, graph:node-completed, graph:node-retried, graph:node-failed,
graph:edge-selected, graph:checkpoint-saved,
graph:goal-gate-checked, graph:goal-gate-unsatisfied,
scenario:started, scenario:completed,
convergence:iteration, convergence:plateau-detected, convergence:budget-exhausted
```

### Testing Requirements
- This story produces only TypeScript type definitions — no runtime logic or side effects
- No unit tests to write for pure type/alias declarations
- Verification is solely via TypeScript compilation: `npx tsc -b packages/sdlc --force` and `npx tsc -b packages/factory --force` must each exit 0
- Do NOT run the full monorepo test suite (`npm test`) — only the sdlc and factory package builds need to pass for this story
- Structural compatibility with the monolith's `OrchestratorEvents` will be confirmed when Epic 41 adds re-export shims and TypeScript enforces assignability

## Interface Contracts

- **Export**: `SdlcEvents` @ `packages/sdlc/src/events.ts` (consumed by implementation orchestrator migration in Epic 41)
- **Export**: `EscalationDiagnosis`, `SolutioningFinding` @ `packages/sdlc/src/events.ts` (consumed by SDLC agent callers in Epic 41)
- **Export**: `FactoryEvents` @ `packages/factory/src/events.ts` (consumed by factory graph executor migration in Epic 41)
- **Export**: `Outcome`, `ScenarioResult`, `ScenarioRunResult` @ `packages/factory/src/events.ts` (consumed by factory scenario runner in Epic 41)
- **Import**: `CoreEvents`, `EventMap` @ `packages/core/src/events/core-events.ts` (from story 40-3)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-6

### Completion Notes List
- All 7 tasks completed successfully (rework pass)
- **Rework fix #1 (blocker)**: Added `"workspaces": ["packages/*"]` to root `package.json` and ran `npm install` to create workspace symlinks at `node_modules/@substrate-ai/{core,sdlc,factory}`. This was the root cause of `TS2307: Cannot find module '@substrate-ai/core'` errors in both packages.
- **Rework fix #2 (blocker)**: `EventMap = object` (not `Record<string, unknown>`) was already correct from the previous implementation. The `CoreEvents extends EventMap ? true : false` conditional type resolves to `true` and `TypedEventBus<CoreEvents>`, `TypedEventBus<SdlcEvents>`, `TypedEventBus<FactoryEvents>` all type-check. The previous review could not verify this because of fix #1 (no workspace symlink = no module resolution).
- **Rework fix #3 (minor)**: `__type-checks__.ts` does not exist on disk — no cleanup needed. It was either never committed or already removed.
- `Outcome` is defined as an interface (not a string union) per architecture Section 5.1: `{ status: StageStatus, preferredLabel?, suggestedNextIds?, contextUpdates?, notes?, failureReason? }`
- `StageStatus` type alias is exported from `packages/factory/src/events.ts` as it's used in `Outcome` interface
- `EventTaskResult` and `EventTaskError` in `packages/core/src/events/core-events.ts` are NOT exported to avoid naming conflicts with `packages/core/src/adapters/types.ts` which also exports `TaskResult` (with a different shape)
- `RoutingDecision` is imported from `packages/core/src/routing/routing-decision.js` (already defined in core) — not copied inline
- `SubstrateConfig` is imported from `packages/core/src/config/types.js` (already defined in core) — not copied inline
- Both `npx tsc -b packages/sdlc --force` and `npx tsc -b packages/factory --force` exit 0 with zero errors
- Monolith build (`npm run build`) still succeeds after workspaces addition

### File List
- `package.json` (updated — added workspaces field)
- `packages/sdlc/src/events.ts` (existing — EscalationDiagnosis, SolutioningFinding, StoryPhaseBreakdown, SdlcEvents)
- `packages/sdlc/src/index.ts` (existing — barrel export)
- `packages/factory/src/events.ts` (existing — StageStatus, Outcome, ScenarioResult, ScenarioRunResult, FactoryEvents)
- `packages/factory/src/index.ts` (existing — barrel export)

## Change Log

- 2026-03-22: Story created for Epic 40 (Core Extraction Phase 1)
- 2026-03-22: Story implemented — all 7 tasks complete, both packages compile with exit 0
- 2026-03-22: Rework — fixed root package.json missing workspaces field (blocker), verified EventMap=object is correct (blocker was masking), confirmed __type-checks__.ts already absent (minor)
