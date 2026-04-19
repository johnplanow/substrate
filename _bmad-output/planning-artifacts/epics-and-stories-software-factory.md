# Epics & Stories: Substrate Software Factory

**Version:** 1.1
**Date:** 2026-03-22
**Status:** Draft
**Informed by:** Architecture v1.1, PRD v1.1, Product Brief, Phase 0 Research, Attractor Spec, Coding Agent Loop Spec, Unified LLM Spec
**Epics:** 40-50 (11 epics)
**Estimated Stories:** ~140

---

## Sequencing Constraints

1. Each epic is independently shippable and testable
2. `substrate run` (existing SDLC pipeline) must remain functional at every stage
3. All 5,944 existing tests must pass at every intermediate commit
4. Early epics produce visible improvements, not just plumbing
5. Each phase boundary (A/B/C) is a validation checkpoint with cross-project verification

## Dependency Graph (Epic Level)

```
Phase A: Foundation
  Epic 40 (Monorepo Setup) ──────────────────┬──> Epic 41 (Core Extraction)
                                              └──> Epic 42 (Graph Engine Foundation)
  Epic 41 + Epic 42 ──────────────────────────────> Epic 43 (SDLC-as-Graph)

Phase B: Factory Loop
  Epic 43 ──────────────────────────────────────> Epic 44 (Scenario Store + Runner)
  Epic 44 ──────────────────────────────────────> Epic 45 (Convergence Loop)
  Epic 45 ──────────────────────────────────────> Epic 46 (Satisfaction Scoring)

Phase C: Scale
  Epic 46 ──────────────────────────────────────> Epic 47 (Digital Twin Foundation)
  Epic 43 ──────────────────────────────────────> Epic 48 (Direct API Backend)
  Epic 46 ──────────────────────────────────────> Epic 49 (Context Engineering)
  Epic 43 ──────────────────────────────────────> Epic 50 (Advanced Graph)
```

---

# Phase A: Foundation

**Goal:** Substrate becomes a monorepo with a working graph engine. The existing SDLC pipeline is expressed as a DOT graph with zero behavioral changes.

**Quality model:** Phase 1 (code review only, unchanged).

**Phase A exit criteria:**
- `substrate run` produces identical results via graph engine (verified by parity test)
- All 13 Attractor lint rules pass
- Checkpoint/resume works
- +500 new tests
- All 5,944 existing tests still pass

---

## Epic 40: Core Extraction Phase 1 — Interface Definition + Monorepo Setup

**Goal:** Establish the monorepo structure with npm workspaces and TypeScript project references. Define all `substrate-core` interfaces without moving any implementations. Existing build and tests remain green.

**Success metric:** `npm run build` and `npm test` pass in monorepo structure. Core package has interface definitions. No circular dependencies.

**Stories: 13**

---

### Story 40-1: Root Workspace and Package Scaffolding

**Description:** Create the npm workspaces monorepo structure with three packages (`core`, `sdlc`, `factory`) and a root `tsconfig.json` with project references.

**Acceptance Criteria:**

1. **Given** the repository root, **When** `npm ls --workspaces` is run, **Then** it lists `@substrate-ai/core`, `@substrate-ai/sdlc`, and `@substrate-ai/factory` as workspace packages.
2. **Given** `packages/core/package.json`, `packages/sdlc/package.json`, and `packages/factory/package.json` exist, **When** each is inspected, **Then** each has a `name`, `version`, `main`, and `types` field pointing to its respective `dist/` output.
3. **Given** a root `tsconfig.json` with `references` to all three packages, **When** `tsc --build` is run, **Then** it completes successfully with zero errors (packages are empty scaffolds at this stage).
4. **Given** a `tsconfig.base.json` with shared compiler options (`strict`, `target`, `module`, `moduleResolution`), **When** each package's `tsconfig.json` extends it, **Then** all packages share consistent compiler settings.
5. **Given** the monorepo structure, **When** `npm test` is run from the root, **Then** all 5,944 existing tests still pass (vitest config updated to include workspace paths). [PRD: CE-7]

**Files likely touched:**
- `package.json` (root — add workspaces)
- `tsconfig.json` (root — add project references)
- `packages/core/package.json`, `packages/sdlc/package.json`, `packages/factory/package.json` (new)

**Dependencies:** None

---

### Story 40-2: Core Package TypeScript Configuration

**Description:** Configure `packages/core/tsconfig.json` with composite mode, outDir, rootDir, and the shared base config. Ensure the core package builds independently.

**Acceptance Criteria:**

1. **Given** `packages/core/tsconfig.json` extends `../../tsconfig.base.json`, **When** `composite: true` is set, **Then** `tsc --build packages/core` succeeds.
2. **Given** `packages/core/src/index.ts` exists as an empty barrel export, **When** `tsc --build packages/core` runs, **Then** `packages/core/dist/index.js` and `packages/core/dist/index.d.ts` are emitted.
3. **Given** `packages/sdlc/tsconfig.json` and `packages/factory/tsconfig.json` reference `packages/core`, **When** `tsc --build` runs from root, **Then** core builds first, then sdlc and factory build successfully.

**Files likely touched:**
- `packages/core/tsconfig.json` (new)
- `packages/core/src/index.ts` (new)
- `packages/sdlc/tsconfig.json`, `packages/factory/tsconfig.json` (new)

**Dependencies:** 40-1

---

### Story 40-3: EventBus Interface Extraction

**Description:** Define the generic `TypedEventBus<E>` interface and `CoreEvents` type map in `packages/core/src/events/`, without moving any implementation code.

**Acceptance Criteria:**

1. **Given** `packages/core/src/events/types.ts`, **When** imported, **Then** it exports `EventMap` (base constraint), `CoreEvents` (with `task:ready`, `task:started`, `task:complete`, `task:failed`, `agent:spawned`, `agent:completed`, `agent:failed`, `budget:warning`, `config:reloaded`), and `TypedEventBus<E extends EventMap>` interface with `emit`, `on`, `off` methods.
2. **Given** the existing `src/core/event-bus.ts`, **When** compared to the new interface, **Then** `TypedEventBusImpl` in the existing code would satisfy `TypedEventBus<CoreEvents>` — the interface is structurally compatible.
3. **Given** `CoreEvents` is imported in a test file, **When** the event type for `task:complete` is inspected, **Then** it contains `taskId: string`, `result: unknown`, and `taskType?: string`.
4. **Given** the existing `OrchestratorEvents` type, **When** compared, **Then** all non-SDLC events (`task:*`, `agent:*`, `budget:*`, `config:*`) are present in `CoreEvents`. [PRD: CE-1]

**Files likely touched:**
- `packages/core/src/events/types.ts` (new)
- `packages/core/src/index.ts` (export events)

**Dependencies:** 40-2

---

### Story 40-4: Dispatcher Interface Extraction

**Description:** Define the `Dispatcher`, `DispatchRequest`, `DispatchResult`, `DispatchHandle`, and `DispatchConfig` interfaces in `packages/core/src/dispatch/`, extracting the type signatures from the existing `src/modules/agent-dispatch/types.ts`.

**Acceptance Criteria:**

1. **Given** `packages/core/src/dispatch/types.ts`, **When** imported, **Then** it exports `Dispatcher` interface with `dispatch(request: DispatchRequest): DispatchHandle` method, plus `DispatchRequest`, `DispatchResult`, `DispatchHandle`, and `DispatchConfig` types.
2. **Given** the existing `src/modules/agent-dispatch/types.ts`, **When** compared, **Then** every field in the existing types is present in the core interface types with identical TypeScript types.
3. **Given** `DispatchRequest` in core, **When** inspected, **Then** it contains `prompt`, `agent`, `taskType`, `timeout`, `model`, `maxTurns`, and `workingDirectory` fields at minimum.
4. **Given** the core `Dispatcher` interface, **When** the existing `DispatcherImpl` class signature is compared, **Then** `DispatcherImpl` would satisfy the interface without modification. [PRD: CE-4]

**Files likely touched:**
- `packages/core/src/dispatch/types.ts` (new)
- `packages/core/src/index.ts` (add dispatch exports)

**Dependencies:** 40-2

---

### Story 40-5: Persistence Interface Extraction

**Description:** Define the `DatabaseAdapter`, `SyncAdapter`, and query function signatures in `packages/core/src/persistence/`, extracted from existing `src/persistence/adapter.ts`.

**Acceptance Criteria:**

1. **Given** `packages/core/src/persistence/types.ts`, **When** imported, **Then** it exports `DatabaseAdapter` interface with `query`, `exec`, `transaction`, and `close` methods, plus `SyncAdapter` with synchronous equivalents.
2. **Given** the existing `src/persistence/adapter.ts`, **When** the `DatabaseAdapter` interface there is compared to the core version, **Then** the method signatures are identical.
3. **Given** `packages/core/src/persistence/types.ts`, **When** the `initSchema` function signature is exported, **Then** it accepts `DatabaseAdapter` and returns `Promise<void>`.
4. **Given** a unit test importing `DatabaseAdapter` from `@substrate-ai/core`, **When** compiled, **Then** it compiles without errors.

**Files likely touched:**
- `packages/core/src/persistence/types.ts` (new)
- `packages/core/src/index.ts` (add persistence exports)

**Dependencies:** 40-2

---

### Story 40-6: Routing Interface Extraction

**Description:** Define `RoutingEngine`, `RoutingDecision`, `ProviderStatus`, `RoutingResolver`, and `ModelRoutingConfig` interfaces in `packages/core/src/routing/`.

**Acceptance Criteria:**

1. **Given** `packages/core/src/routing/types.ts`, **When** imported, **Then** it exports `RoutingEngine` interface with `resolveModel(taskType: string)` method, `RoutingDecision`, `ProviderStatus`, `RoutingResolver`, and `ModelRoutingConfig` types.
2. **Given** the existing 14 routing files in `src/modules/routing/`, **When** the public interface types are compared, **Then** all public types referenced by consumers outside the routing module are present in the core interface.
3. **Given** the `RoutingEngine` interface, **When** the existing `createRoutingEngine()` return type is compared, **Then** the returned object satisfies the interface.

**Files likely touched:**
- `packages/core/src/routing/types.ts` (new)
- `packages/core/src/index.ts` (add routing exports)

**Dependencies:** 40-2

---

### Story 40-7: Config and Telemetry Interface Extraction

**Description:** Define `SubstrateConfig`, `ProviderConfig`, `GlobalSettings`, `BudgetConfig`, `ConfigSystem`, and telemetry pipeline interfaces (`ITelemetryPersistence`, `TelemetryPipeline`) in core.

**Acceptance Criteria:**

1. **Given** `packages/core/src/config/types.ts`, **When** imported, **Then** it exports `SubstrateConfig` (without SDLC-specific `TokenCeilings`), `ProviderConfig`, `GlobalSettings`, `BudgetConfig`, and `ConfigSystem` interface.
2. **Given** `packages/core/src/telemetry/types.ts`, **When** imported, **Then** it exports `ITelemetryPersistence` interface with `writeTurnAnalysis`, `writeEfficiencyScore`, and `writeRecommendation` method signatures.
3. **Given** the existing `src/modules/config/config-schema.ts`, **When** compared, **Then** `SubstrateConfig` in core contains all provider-agnostic fields (`global`, `providers`, `cost_tracker`, `budget`, `telemetry`) but NOT `TokenCeilings` or SDLC workflow keys.
4. **Given** a test file importing `SubstrateConfig` from `@substrate-ai/core`, **When** compiled, **Then** it compiles without errors.

**Files likely touched:**
- `packages/core/src/config/types.ts` (new)
- `packages/core/src/telemetry/types.ts` (new)
- `packages/core/src/index.ts` (add config and telemetry exports)

**Dependencies:** 40-2

---

### Story 40-8: Remaining Core Interface Definitions

**Description:** Define interfaces for the remaining core modules: `ContextCompiler`, `BudgetTracker`, `WorkerAdapter`, `AdapterRegistry`, `GateRegistry`, `GitManager`, `ProjectProfile`, quality gate types, and base error/DI types.

**Acceptance Criteria:**

1. **Given** `packages/core/src/context/types.ts`, **When** imported, **Then** it exports `ContextCompiler` interface with `compile(descriptor)` and `registerTemplate(template)` methods, plus `TaskDescriptor` and `CompileResult` types.
2. **Given** `packages/core/src/adapters/types.ts`, **When** imported, **Then** it exports `WorkerAdapter`, `AdapterOptions`, `SpawnCommand`, and `AdapterRegistry` interface with `register`, `get`, and `list` methods.
3. **Given** `packages/core/src/quality-gates/types.ts`, **When** imported, **Then** it exports `Gate`, `GateResult`, `GateRegistry`, and `GatePipeline` interfaces.
4. **Given** `packages/core/src/types.ts`, **When** imported, **Then** it exports `TaskId`, `WorkerId`, `TaskNode`, `TaskStatus`, `SessionStatus`, `BillingMode` — all matching the existing `src/core/types.ts`.
5. **Given** all interface files are exported from `packages/core/src/index.ts`, **When** `tsc --build packages/core` runs, **Then** it succeeds with zero errors.

**Files likely touched:**
- `packages/core/src/context/types.ts`, `packages/core/src/adapters/types.ts`, `packages/core/src/quality-gates/types.ts`, `packages/core/src/types.ts` (all new)
- `packages/core/src/index.ts` (complete barrel export)

**Dependencies:** 40-3, 40-4, 40-5, 40-6, 40-7

---

### Story 40-9: SDLC and Factory Event Type Definitions

**Description:** Define `SdlcEvents` in `packages/sdlc/src/events.ts` (extending `CoreEvents` with all `orchestrator:story-*` events) and `FactoryEvents` in `packages/factory/src/events.ts` (extending `CoreEvents` with `graph:*`, `scenario:*`, `convergence:*` events).

**Acceptance Criteria:**

1. **Given** `packages/sdlc/src/events.ts`, **When** imported, **Then** it exports `SdlcEvents` interface extending `CoreEvents` with `orchestrator:story-phase-start`, `orchestrator:story-complete`, `orchestrator:story-escalated`, and all other `orchestrator:story-*` and `plan:*` events from the existing `OrchestratorEvents`.
2. **Given** `packages/factory/src/events.ts`, **When** imported, **Then** it exports `FactoryEvents` interface extending `CoreEvents` with `graph:node-started`, `graph:node-completed`, `graph:node-failed`, `graph:node-retrying`, `graph:checkpoint-saved`, `graph:goal-gate-checked`, `graph:edge-selected`, `scenario:run-started`, `scenario:run-completed`, `scenario:score-computed`, `convergence:plateau-detected`, `convergence:budget-exhausted`.
3. **Given** `FactoryEvents`, **When** each event payload is inspected, **Then** every payload includes `runId: string` and event-specific fields per the architecture Section 8.2.
4. **Given** `SdlcEvents` and `FactoryEvents` both extend `CoreEvents`, **When** a `TypedEventBus<SdlcEvents>` or `TypedEventBus<FactoryEvents>` is typed, **Then** it can emit both core and domain-specific events.

**Files likely touched:**
- `packages/sdlc/src/events.ts` (new)
- `packages/factory/src/events.ts` (new)

**Dependencies:** 40-3

---

### Story 40-10: Build Verification and CI Integration

**Description:** Verify the monorepo builds end-to-end, all existing tests pass, and no circular dependencies exist between packages.

**Acceptance Criteria:**

1. **Given** the full monorepo structure, **When** `tsc --build` runs from root, **Then** it completes in under 5 seconds with zero errors.
2. **Given** the monorepo, **When** `npm test` runs, **Then** all 5,944 existing tests pass (vitest configured to find tests in both `src/` and `packages/`).
3. **Given** the package dependency graph, **When** `packages/sdlc/tsconfig.json` is inspected, **Then** it references only `packages/core` — never `packages/factory`.
4. **Given** the package dependency graph, **When** `packages/factory/tsconfig.json` is inspected, **Then** it references only `packages/core` — never `packages/sdlc`.
5. **Given** `packages/core/src/index.ts` barrel export, **When** all exported types are inspected, **Then** every interface defined in stories 40-3 through 40-8 is re-exported. [PRD: CE-1, CE-6, CE-8]

**Files likely touched:**
- `vitest.config.ts` (update to include workspace paths)
- `tsconfig.json` (root — verify references)

**Dependencies:** 40-8, 40-9

---

### Story 40-11: Core Extraction Integration Test Suite

**Description:** Run the full vitest suite in the monorepo structure to verify no import breakage from the interface extraction. This story is a hard gate before any Epic 41 implementation migration begins.

**Acceptance Criteria:**

1. **Given** the monorepo with all interface definitions from stories 40-3 through 40-9, **When** `npm test` runs the full vitest suite, **Then** all 5,944 existing tests pass without modification. [PRD: CE-2]
2. **Given** any test file that imports from `@substrate-ai/core`, **When** the import is resolved, **Then** it resolves to the correct interface definition in `packages/core/dist/`.
3. **Given** the monorepo build, **When** `tsc --build` runs from root, **Then** zero type errors are produced across all packages.
4. **Given** the test suite, **When** any interface type is changed in packages/core, **Then** dependent tests in `src/` detect the type mismatch at compile time.
5. **Given** this story is a gate, **When** any test fails, **Then** Epic 41 stories MUST NOT begin until all failures are resolved.

**Files likely touched:**
- No code changes expected — validation-only story. If failures are found, fixes are applied to interface definitions from 40-3 through 40-9.

**Dependencies:** 40-10

---

### Story 40-12: Re-Export Shim Validation

**Description:** Verify that re-export shims (to be created in Epic 41) can be set up from original import paths without breaking any existing test file. Create shim stubs that re-export from core interface types and run the full test suite. Hard gate before 41-1.

**Acceptance Criteria:**

1. **Given** re-export shim stubs at original paths (e.g., `src/core/event-bus.ts` re-exporting types from `@substrate-ai/core`), **When** `npm test` runs, **Then** all 5,944 existing tests pass.
2. **Given** any test file that imports from an original path (e.g., `src/core/event-bus.js`), **When** the import is traced, **Then** it resolves through the re-export shim to the core package interface.
3. **Given** the shim stubs, **When** `tsc --build` runs, **Then** zero errors — shims are type-compatible with the original exports.
4. **Given** this story is a gate, **When** any import breakage is detected, **Then** 41-1 MUST NOT begin until all breakage is resolved.

**Files likely touched:**
- Re-export shim stubs at original paths (created temporarily for validation)
- `vitest.config.ts` (if path resolution needs adjustment)

**Dependencies:** 40-11

---

### Story 40-13: Schema Version Management Strategy

**Description:** Document and implement the versioning strategy for core and factory database schemas, ensuring schema compatibility across versions and safe migration paths.

**Acceptance Criteria:**

1. **Given** the core schema (`initSchema`) and factory schema (`factorySchema`), **When** each is versioned, **Then** a `schema_version` table (or metadata row) tracks the current schema version for each package independently.
2. **Given** a schema version mismatch (e.g., code expects v2, database has v1), **When** the application starts, **Then** it logs a clear warning and either auto-migrates (if safe) or fails with instructions.
3. **Given** a new schema version, **When** defined, **Then** a migration function transforms the previous version to the new version without data loss.
4. **Given** the versioning strategy, **When** documented in `packages/core/src/persistence/SCHEMA_VERSIONING.md`, **Then** it covers: version numbering convention, migration authoring guide, backward compatibility rules, and rollback procedure.
5. **Given** the factory schema adds new tables in Epic 44, **When** factory schema v1 is defined, **Then** it is tracked independently of core schema version.

**Files likely touched:**
- `packages/core/src/persistence/schema-version.ts` (new)
- `packages/core/src/persistence/SCHEMA_VERSIONING.md` (new — documentation)

**Dependencies:** 40-5

---

## Epic 41: Core Extraction Phase 2 — Implementation Migration

**Goal:** Move implementation code from `src/modules/` into `packages/core/src/` behind the interfaces defined in Epic 40. Create re-export shims from original paths. All existing tests pass at every step.

**Success metric:** 5,944/5,944 tests pass. SDLC and factory packages import only from `@substrate-ai/core`. No circular deps. Build under 5s.

**Stories: 13**

---

### Story 41-1: EventBus Implementation Migration

**Description:** Move `TypedEventBusImpl` from `src/core/event-bus.ts` to `packages/core/src/events/event-bus.ts`. Create re-export shim at the original path.

**Acceptance Criteria:**

1. **Given** `packages/core/src/events/event-bus.ts` contains the `TypedEventBusImpl` class, **When** imported from `@substrate-ai/core`, **Then** it instantiates correctly and `emit`/`on`/`off` work as before.
2. **Given** `src/core/event-bus.ts` is replaced with a re-export shim (`export { TypedEventBusImpl } from '@substrate-ai/core'`), **When** existing code imports from `src/core/event-bus.js`, **Then** it resolves to the core package implementation.
3. **Given** the migration, **When** `npm test` runs, **Then** all existing event-bus tests pass without modification.
4. **Given** the `TypedEventBusImpl` now accepts a generic `<E extends EventMap>`, **When** SDLC creates `TypedEventBus<CoreEvents & SdlcEvents>`, **Then** it type-checks correctly.

**Files likely touched:**
- `packages/core/src/events/event-bus.ts` (new — migrated impl)
- `src/core/event-bus.ts` (modified — becomes re-export shim)

**Dependencies:** 40-3, 40-12

---

### Story 41-2: Dispatcher Implementation Migration

**Description:** Move `DispatcherImpl` and dispatch types from `src/modules/agent-dispatch/` to `packages/core/src/dispatch/`. Create re-export shims.

**Acceptance Criteria:**

1. **Given** `packages/core/src/dispatch/dispatcher-impl.ts` contains the `DispatcherImpl` class, **When** imported from `@substrate-ai/core`, **Then** it instantiates and dispatches correctly.
2. **Given** `src/modules/agent-dispatch/types.ts` and `src/modules/agent-dispatch/dispatcher-impl.ts` are replaced with re-export shims, **When** existing code imports from original paths, **Then** imports resolve correctly.
3. **Given** the SDLC-specific `DEFAULT_TIMEOUTS` and `DEFAULT_MAX_TURNS` mappings (containing `create-story`, `dev-story`, `code-review`), **When** the migration is complete, **Then** these are defined in SDLC-side config and injected at startup, not hardcoded in core.
4. **Given** the migration, **When** `npm test` runs, **Then** all existing dispatch tests pass without modification.

**Files likely touched:**
- `packages/core/src/dispatch/dispatcher-impl.ts` (new — migrated impl)
- `src/modules/agent-dispatch/dispatcher-impl.ts` (modified — becomes shim)
- `src/modules/agent-dispatch/types.ts` (modified — becomes shim)

**Dependencies:** 40-4, 41-1

---

### Story 41-3: Persistence Layer Migration

**Description:** Move `DatabaseAdapter` implementations (`InMemoryDatabaseAdapter`, `DoltDatabaseAdapter`), `initSchema`, and core query modules from `src/persistence/` to `packages/core/src/persistence/`.

**Acceptance Criteria:**

1. **Given** `packages/core/src/persistence/` contains `adapter.ts`, `schema.ts`, `in-memory-adapter.ts`, and core query modules, **When** imported from `@substrate-ai/core`, **Then** `createDatabaseAdapter()` returns a working adapter.
2. **Given** `src/persistence/adapter.ts` and `src/persistence/schema.ts` are re-export shims, **When** existing code imports from original paths, **Then** imports resolve correctly.
3. **Given** `initSchema(adapter)` is called, **When** it completes, **Then** all existing tables (`sessions`, `tasks`, `task_dependencies`, `pipeline_runs`, `decisions`, `run_metrics`, `story_metrics`, etc.) are created.
4. **Given** the migration, **When** `npm test` runs, **Then** all existing persistence tests pass.

**Files likely touched:**
- `packages/core/src/persistence/` (new — migrated implementations)
- `src/persistence/adapter.ts`, `src/persistence/schema.ts` (modified — shims)

**Dependencies:** 40-5, 41-1

---

### Story 41-4: Routing Engine Migration

**Description:** Move the 14 routing files from `src/modules/routing/` to `packages/core/src/routing/`. Create re-export shims.

**Acceptance Criteria:**

1. **Given** `packages/core/src/routing/` contains all routing implementation files, **When** `createRoutingEngine()` is called via core import, **Then** it returns a functioning `RoutingEngine`.
2. **Given** `src/modules/routing/` files are re-export shims, **When** existing code imports from original paths, **Then** imports resolve correctly.
3. **Given** the `ModelRoutingConfig.phases` keys are SDLC-named (`explore`, `generate`, `review`), **When** they are used via `resolveModel(taskType)`, **Then** behavior is unchanged — factory will use `overrides` for per-node routing.
4. **Given** the migration, **When** `npm test` runs, **Then** all existing routing tests pass.

**Files likely touched:**
- `packages/core/src/routing/` (new — migrated from `src/modules/routing/`)
- `src/modules/routing/*.ts` (modified — become shims)

**Dependencies:** 40-6, 41-1

---

### Story 41-5: Config System Migration

**Description:** Move `ConfigSystem` and base config schema from `src/modules/config/` to `packages/core/src/config/`. Extract SDLC-specific `TokenCeilings` to remain in SDLC.

**Acceptance Criteria:**

1. **Given** `packages/core/src/config/` contains `ConfigSystem`, base `SubstrateConfig` schema (without `TokenCeilings`), **When** `ConfigSystem` is instantiated via core, **Then** it loads `config.yaml` and validates against the base schema.
2. **Given** `TokenCeilingsSchema` with SDLC workflow keys (`create-story`, `dev-story`, `code-review`), **When** the migration is complete, **Then** `TokenCeilingsSchema` remains in `src/modules/config/` (future SDLC package) and is not in core.
3. **Given** a `config.yaml` with unknown keys (e.g., `factory:` section), **When** core's `SubstrateConfig` validates, **Then** unknown keys are passed through (`.passthrough()` or equivalent), allowing SDLC and factory to extend.
4. **Given** the migration, **When** `npm test` runs, **Then** all existing config tests pass.

**Files likely touched:**
- `packages/core/src/config/config-system.ts`, `packages/core/src/config/config-schema.ts` (new)
- `src/modules/config/config-schema.ts` (modified — shim for base, retains TokenCeilings)

**Dependencies:** 40-7, 41-1, 41-4 (routing must be migrated before config — config system references routing types)

---

### Story 41-6a: Core Telemetry Migration — EventBus, Cost, and Budget Modules

**Description:** Move the core telemetry modules (`TelemetryPipeline`, `BatchBuffer`, `IngestionServer`, `TelemetryNormalizer`) and their cost/budget integration from `src/modules/telemetry/` to `packages/core/src/telemetry/`. Create re-export shims at original paths.

**Acceptance Criteria:**

1. **Given** `packages/core/src/telemetry/` contains `TelemetryPipeline`, `BatchBuffer`, `IngestionServer`, and `TelemetryNormalizer`, **When** the pipeline is instantiated via core, **Then** it processes telemetry data correctly.
2. **Given** `src/modules/telemetry/pipeline.ts` and related files are re-export shims, **When** existing code imports from original paths, **Then** imports resolve correctly.
3. **Given** the migration, **When** `npm test` runs, **Then** all existing telemetry pipeline tests pass.
4. **Given** unit tests for this story pass, **Then** this story may proceed.

**Files likely touched:**
- `packages/core/src/telemetry/pipeline.ts`, `batch-buffer.ts`, `ingestion-server.ts`, `normalizer.ts` (new — migrated)
- `src/modules/telemetry/pipeline.ts`, `batch-buffer.ts`, `ingestion-server.ts`, `normalizer.ts` (modified — become shims)

**Dependencies:** 40-7, 41-3

---

### Story 41-6b: Telemetry Scoring Migration — EfficiencyScorer, Recommender, Categorizer

**Description:** Move the telemetry scoring modules (`EfficiencyScorer`, `Categorizer`, `ConsumerAnalyzer`, `TurnAnalyzer`, `LogTurnAnalyzer`, `Recommender`) to `packages/core/src/telemetry/`. Extract the category mapping table to a configurable `TaskCategoryMap`.

**Acceptance Criteria:**

1. **Given** `packages/core/src/telemetry/` contains `EfficiencyScorer`, `Categorizer`, `ConsumerAnalyzer`, `TurnAnalyzer`, `LogTurnAnalyzer`, and `Recommender`, **When** imported from core, **Then** all scoring and categorization functions work correctly.
2. **Given** the `Categorizer` uses SDLC task names (`dev-story` -> `generate`) as a mapping table, **When** the migration is complete, **Then** the category mapping is a configurable `TaskCategoryMap` parameter injected at construction — SDLC provides its mappings, factory provides its own.
3. **Given** `src/modules/telemetry/` scoring files are re-export shims, **When** existing code imports from original paths, **Then** imports resolve correctly.
4. **Given** the migration, **When** `npm test` runs, **Then** all existing telemetry scoring tests pass.
5. **Given** unit tests for this story pass, **Then** this story may proceed.

**Files likely touched:**
- `packages/core/src/telemetry/efficiency-scorer.ts`, `categorizer.ts`, `consumer-analyzer.ts`, `turn-analyzer.ts`, `log-turn-analyzer.ts`, `recommender.ts` (new — migrated)
- `src/modules/telemetry/*.ts` (modified — become shims)

**Dependencies:** 41-6a

---

### Story 41-7: Supervisor, Budget, and Monitor Migration

**Description:** Move supervisor analysis (minus SDLC-specific `analyzeReviewCycles`), `BudgetTracker`, `MonitorAgent`, `WorkerManager`, and `CostTracker` to core.

**Acceptance Criteria:**

1. **Given** `packages/core/src/supervisor/` contains `analyzeTokenEfficiency`, `analyzeTimings`, `generateRecommendations`, and `Experimenter`, **When** imported from core, **Then** all functions work correctly.
2. **Given** `analyzeReviewCycles` expects `StoryPhase` semantics (SDLC-specific), **When** the migration is complete, **Then** it remains in `src/modules/supervisor/` (future SDLC package), not in core.
3. **Given** `BudgetTracker` and `CostTracker` are moved to core, **When** imported, **Then** they function identically.
4. **Given** the migration, **When** `npm test` runs, **Then** all existing supervisor, budget, and monitor tests pass.

**Files likely touched:**
- `packages/core/src/supervisor/`, `packages/core/src/budget/`, `packages/core/src/monitor/`, `packages/core/src/cost-tracker/` (new)
- Original paths (modified — become shims)

**Dependencies:** 41-1, 41-3

---

### Story 41-8: Adapters and Git Modules Migration

**Description:** Move `AdapterRegistry`, CLI adapters (`ClaudeCodeAdapter`, `CodexCLIAdapter`, `GeminiCLIAdapter`), `GitManager`, `git-worktree`, and `version-manager` to core.

**Acceptance Criteria:**

1. **Given** `packages/core/src/adapters/` contains `AdapterRegistry` and all CLI adapter implementations, **When** `AdapterRegistry.register()` is called with a `ClaudeCodeAdapter`, **Then** it registers correctly.
2. **Given** `packages/core/src/git/` contains `GitManager` and git-worktree module, **When** imported from core, **Then** git operations work identically.
3. **Given** `src/adapters/` and `src/modules/git/` are re-export shims, **When** existing code imports, **Then** imports resolve correctly.
4. **Given** the migration, **When** `npm test` runs, **Then** all existing adapter and git tests pass.

**Files likely touched:**
- `packages/core/src/adapters/`, `packages/core/src/git/` (new)
- `src/adapters/*.ts`, `src/modules/git/*.ts` (modified — become shims)

**Dependencies:** 41-1

---

### Story 41-9: Context Compiler, Repo Map, Quality Gates, Project Profile Migration

**Description:** Move the remaining core modules: `ContextCompiler`, `repo-map`, `quality-gates`, and `project-profile` to core.

**Acceptance Criteria:**

1. **Given** `packages/core/src/context/` contains `ContextCompiler` implementation and repo-map modules, **When** imported from core, **Then** context compilation and repo-map generation work.
2. **Given** `packages/core/src/quality-gates/` contains `GateRegistry` and `GatePipeline`, **When** imported from core, **Then** gate registration and evaluation work.
3. **Given** `packages/core/src/project-profile/` contains the auto-detection module, **When** imported from core, **Then** project profile detection works.
4. **Given** all re-export shims are in place, **When** `npm test` runs, **Then** all existing tests for these modules pass.

**Files likely touched:**
- `packages/core/src/context/`, `packages/core/src/quality-gates/`, `packages/core/src/project-profile/` (new)
- Original paths (modified — become shims)

**Dependencies:** 41-8

---

### Story 41-10: State Module Split (Core DoltClient vs SDLC StoryStore)

**Description:** Split `src/modules/state/` — move `DoltClient` and `dolt-init.ts` to core (general Dolt operations), keep `dolt-store.ts`, `file-store.ts`, and `work-graph-repository.ts` in SDLC (story-record-shaped).

**Acceptance Criteria:**

1. **Given** `packages/core/src/persistence/dolt-client.ts` contains the general-purpose `DoltClient`, **When** imported from core, **Then** it can initialize a Dolt database and run SQL queries.
2. **Given** `src/modules/state/dolt-store.ts`, `file-store.ts`, and `work-graph-repository.ts` remain in SDLC territory, **When** they import `DoltClient`, **Then** they import it from `@substrate-ai/core`.
3. **Given** the split, **When** `npm test` runs, **Then** all existing state-management tests pass.

**Files likely touched:**
- `packages/core/src/persistence/dolt-client.ts` (new — extracted from state module)
- `src/modules/state/dolt-store.ts` (modified — import from core)

**Dependencies:** 41-3

---

### Story 41-11: Circular Dependency Audit and Shim Verification

**Description:** Run a dependency analysis across all packages, verify no circular dependencies exist, and confirm every re-export shim resolves correctly at runtime.

**Acceptance Criteria:**

1. **Given** the full monorepo, **When** a circular dependency check is run across package boundaries, **Then** zero cycles are found between `@substrate-ai/core`, `@substrate-ai/sdlc`, and `@substrate-ai/factory`.
2. **Given** every re-export shim created in stories 41-1 through 41-10, **When** a test imports from the original path (e.g., `src/core/event-bus.js`), **Then** it resolves to the core package implementation at runtime.
3. **Given** the full monorepo, **When** `npm test` runs, **Then** all 5,944 existing tests pass.
4. **Given** `tsc --build` runs from root, **When** it completes, **Then** build time remains under 5 seconds.

**Files likely touched:**
- Test file for circular dependency detection (new)
- Any remaining shim fixes discovered during audit

**Dependencies:** 41-1 through 41-10

---

### Story 41-12: Core Extraction Cross-Project Validation

**Description:** Run substrate's existing SDLC pipeline on a reference project (ynab or nextgen-ticketing stories) to verify the core extraction has zero behavioral impact.

**Acceptance Criteria:**

1. **Given** the monorepo with all core modules extracted, **When** `substrate run --events --stories 1-1` is run on a reference project, **Then** the pipeline completes with the same story outcome as before extraction.
2. **Given** the NDJSON event stream, **When** compared to a pre-extraction run, **Then** the same event types are emitted in the same order (timing may differ).
3. **Given** the build, **When** `npm run build` completes, **Then** the published CLI binary works identically to pre-extraction.

**Files likely touched:**
- No code changes — validation-only story

**Dependencies:** 41-11

---

## Epic 42: Graph Engine Foundation — Parser, Validator, Executor, Handlers

**Goal:** Build the Attractor-compliant graph engine in `packages/factory/`: DOT parser (ts-graphviz), 13 lint rules, graph executor, 5-step edge selection, node handlers, and checkpointing.

**Success metric:** Parse and execute a 10-node test graph end-to-end. All 13 lint rules implemented. Edge selection matches Attractor spec pseudocode. Checkpoint/resume works.

**Stories: 18**

---

### Story 42-1: ts-graphviz Dependency and DOT Parser Foundation

**Description:** Add `ts-graphviz` as a dependency. Implement the DOT parser that converts DOT source into the typed `Graph` model, extracting graph-level attributes.

**Acceptance Criteria:**

1. **Given** a DOT digraph string with `graph [goal="Build app", label="My Pipeline", default_max_retries=2]`, **When** `parseGraph(dotSource)` is called, **Then** it returns a `Graph` object with `goal`, `label`, and `defaultMaxRetries` populated correctly.
2. **Given** the parser uses `ts-graphviz`'s `fromDOT()` method, **When** a syntactically valid DOT string is parsed, **Then** it produces an AST that the parser transforms into the `Graph` model.
3. **Given** a DOT string with graph-level attributes `model_stylesheet`, `retry_target`, `fallback_retry_target`, `default_fidelity`, **When** parsed, **Then** all attributes are accessible on the `Graph` object.
4. **Given** a malformed DOT string, **When** `parseGraph()` is called, **Then** it throws a descriptive error with the parse failure location.
5. **Given** DOT with `//` line comments and `/* */` block comments, **When** parsed, **Then** comments are stripped and do not affect the parsed graph.
6. **Given** the parser implementation, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding. [PRD: GE-P1, GE-P2, GE-P9]

**Files likely touched:**
- `packages/factory/src/graph/parser.ts` (new)
- `packages/factory/src/graph/types.ts` (new)
- `packages/factory/package.json` (add ts-graphviz dependency)

**Dependencies:** 40-10

---

### Story 42-2: Node and Edge Attribute Extraction

**Description:** Extend the parser to extract all node attributes (`label`, `shape`, `type`, `prompt`, `max_retries`, `goal_gate`, `retry_target`, `fidelity`, `thread_id`, `class`, `timeout`, `llm_model`, `llm_provider`, `reasoning_effort`, `auto_status`, `allow_partial`) and edge attributes (`label`, `condition`, `weight`, `fidelity`, `thread_id`, `loop_restart`).

**Acceptance Criteria:**

1. **Given** a DOT node with all 17 node attributes set, **When** parsed, **Then** the resulting `GraphNode` object has each attribute correctly typed — boolean for `goal_gate`, `auto_status`, `allow_partial`; number for `max_retries`, `timeout`, `weight`; FidelityMode for `fidelity`.
2. **Given** a DOT edge with `label`, `condition`, `weight`, `fidelity`, `thread_id`, `loop_restart`, **When** parsed, **Then** the resulting `GraphEdge` object has each attribute correctly typed.
3. **Given** both quoted (`prompt="Implement the feature"`) and unquoted (`shape=box`) attribute values, **When** parsed, **Then** both resolve correctly (per GE-P8).
4. **Given** a node with no explicit attributes, **When** parsed, **Then** defaults are applied: `shape="box"`, `maxRetries=graph.defaultMaxRetries`, `goalGate=false`, `autoStatus=true`, `allowPartial=false`.
5. **Given** the parser implementation, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding. [PRD: GE-P3, GE-P4, GE-P8]

**Files likely touched:**
- `packages/factory/src/graph/parser.ts` (extend)
- `packages/factory/src/graph/types.ts` (complete GraphNode/GraphEdge types)

**Dependencies:** 42-1

---

### Story 42-3: Chained Edges, Subgraph Flattening, and Default Blocks

**Description:** Handle chained edge expansion (`A -> B -> C`), subgraph flattening with class derivation, and `node [...]` / `edge [...]` default blocks.

**Acceptance Criteria:**

1. **Given** `A -> B -> C [label="x"]` in DOT, **When** parsed, **Then** two edges are produced: `A->B [label="x"]` and `B->C [label="x"]` (per GE-P5).
2. **Given** `node [shape=box]` followed by a node without explicit shape, **When** parsed, **Then** the node resolves to `shape=box` from the default block (per GE-P6).
3. **Given** `subgraph cluster_loop { label="Loop A"; node_x; node_y }`, **When** parsed, **Then** `node_x` and `node_y` have class `loop-a` derived from the subgraph label (per GE-P7).
4. **Given** `edge [weight=5]` as a default block, **When** edges without explicit weight are parsed, **Then** they inherit `weight=5`.
5. **Given** the `Graph` object, **When** `graph.outgoingEdges(nodeId)` is called, **Then** it returns all edges originating from that node.
6. **Given** the parser implementation, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding. [PRD: GE-P5, GE-P6, GE-P7]

**Files likely touched:**
- `packages/factory/src/graph/parser.ts` (extend with chaining, subgraphs, defaults)

**Dependencies:** 42-2

---

### Story 42-4: Graph Validator — Error Rules (8 Rules)

**Description:** Implement the 8 error-severity validation rules from the Attractor spec that block execution: `start_node`, `terminal_node`, `reachability`, `edge_target_exists`, `start_no_incoming`, `exit_no_outgoing`, `condition_syntax`, `stylesheet_syntax`.

**Acceptance Criteria:**

1. **Given** a graph with 0 start nodes (no Mdiamond/start), **When** `validate(graph)` is called, **Then** it returns an error diagnostic with `ruleId='start_node'`.
2. **Given** a graph with 2 start nodes, **When** validated, **Then** error diagnostic for `start_node`.
3. **Given** a graph with an unreachable node (not connected from start via BFS/DFS), **When** validated, **Then** error diagnostic for `reachability` identifying the orphan node.
4. **Given** an edge targeting a non-existent node ID, **When** validated, **Then** error diagnostic for `edge_target_exists`.
5. **Given** an edge into the start node, **When** validated, **Then** error diagnostic for `start_no_incoming`.
6. **Given** an edge from the exit node, **When** validated, **Then** error diagnostic for `exit_no_outgoing`.
7. **Given** `validate_or_raise(graph)` with any error-level diagnostic, **When** called, **Then** it throws an error.
8. **Given** the validator implementation, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding. [PRD: GE-V1]

**Files likely touched:**
- `packages/factory/src/graph/validator.ts` (new)
- `packages/factory/src/graph/rules/` (new — one file per rule or grouped)

**Dependencies:** 42-3

---

### Story 42-5: Graph Validator — Warning Rules (5 Rules) and Custom Rules

**Description:** Implement the 5 warning-severity rules (`type_known`, `fidelity_valid`, `retry_target_exists`, `goal_gate_has_retry`, `prompt_on_llm_nodes`) and the custom rule registration extension point.

**Acceptance Criteria:**

1. **Given** a node with `type="unknown_handler"`, **When** validated, **Then** warning diagnostic for `type_known`.
2. **Given** a node with `fidelity="invalid_value"`, **When** validated, **Then** warning diagnostic for `fidelity_valid`.
3. **Given** a node with `goal_gate=true` but no `retry_target`, **When** validated, **Then** warning diagnostic for `goal_gate_has_retry`.
4. **Given** a codergen node (shape=box) with no `prompt` and no `label`, **When** validated, **Then** warning diagnostic for `prompt_on_llm_nodes`.
5. **Given** a custom `LintRule` registered via `validator.registerRule(rule)`, **When** `validate(graph)` is called, **Then** the custom rule's `check()` method is invoked and its diagnostics are included in the results.
6. **Given** a graph with warnings only (no errors), **When** `validate_or_raise()` is called, **Then** it does NOT throw — warnings allow execution.
7. **Given** the validator implementation, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding. [PRD: GE-V2]

**Files likely touched:**
- `packages/factory/src/graph/validator.ts` (extend with warning rules)
- `packages/factory/src/graph/rules/` (add warning rules)

**Dependencies:** 42-4

---

### Story 42-6: Condition Expression Parser

**Description:** Implement the edge condition expression parser per Attractor spec Section 10: `key=value`, `key!=value`, `&&` conjunction, case-sensitive comparison, missing context keys resolve to empty string.

**Acceptance Criteria:**

1. **Given** condition `outcome=success`, **When** evaluated against context `{outcome: "success"}`, **Then** returns `true`.
2. **Given** condition `outcome!=fail`, **When** evaluated against context `{outcome: "success"}`, **Then** returns `true`.
3. **Given** condition `outcome=success && iteration!=0`, **When** evaluated against context `{outcome: "success", iteration: "1"}`, **Then** returns `true`.
4. **Given** condition `missing_key=value`, **When** evaluated against context without `missing_key`, **Then** `missing_key` resolves to empty string — condition returns `false`.
5. **Given** an invalid condition `outcome==success` (double equals), **When** the condition_syntax validator rule checks it, **Then** error diagnostic is produced.
6. **Given** condition values, **When** compared, **Then** comparison is case-sensitive (`Success` != `success`).
7. **Given** the condition parser implementation, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding. [PRD: GE-E4]

**Files likely touched:**
- `packages/factory/src/graph/condition-parser.ts` (new)

**Dependencies:** 42-2

---

### Story 42-7: Model Stylesheet Parser and Resolver

**Description:** Implement the CSS-like model stylesheet parser and specificity resolver per Attractor spec Section 8.

**Acceptance Criteria:**

1. **Given** stylesheet `* { llm_model: claude-sonnet-4-5; } .code { llm_model: claude-opus-4-6; reasoning_effort: high; } #critical_review { llm_model: gpt-5; }`, **When** parsed, **Then** three rules are extracted with correct selectors and properties.
2. **Given** a node matching `*` (specificity 0), `.code` (specificity 2), and `#critical_review` (specificity 3), **When** resolved, **Then** `#critical_review` rule wins — `llm_model` is `gpt-5`.
3. **Given** two rules with equal specificity, **When** resolved, **Then** the later rule overrides the earlier (per GE-S3).
4. **Given** recognized properties `llm_model`, `llm_provider`, `reasoning_effort`, **When** a stylesheet sets them, **Then** they are applied to matching nodes.
5. **Given** a node with explicit `llm_model="x"` attribute AND a stylesheet rule `.class { llm_model: y; }`, **When** resolved, **Then** the explicit node attribute wins (per GE-S5).
6. **Given** the `model_stylesheet` graph attribute, **When** the transformer pipeline runs, **Then** stylesheet is applied after parsing and before validation.
7. **Given** the stylesheet implementation, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding. [PRD: GE-S1, GE-S2, GE-S3, GE-S4, GE-S5]

**Files likely touched:**
- `packages/factory/src/stylesheet/parser.ts` (new)
- `packages/factory/src/stylesheet/resolver.ts` (new)

**Dependencies:** 42-2

---

### Story 42-8: Graph Context and Outcome Types

**Description:** Implement the `GraphContext` (thread-safe key-value context) and `Outcome` result type per the architecture Section 3.1.

**Acceptance Criteria:**

1. **Given** a new `GraphContext`, **When** `set("key", "value")` then `get("key")`, **Then** returns `"value"`.
2. **Given** a `GraphContext`, **When** `getString("missing", "default")`, **Then** returns `"default"`.
3. **Given** a `GraphContext`, **When** `applyUpdates({a: 1, b: 2})`, **Then** both `a` and `b` are set.
4. **Given** a `GraphContext`, **When** `snapshot()` is called, **Then** it returns a serializable `Record<string, unknown>` of all key-value pairs.
5. **Given** a `GraphContext`, **When** `clone()` is called, **Then** it returns an independent copy — mutations to the clone do not affect the original.
6. **Given** an `Outcome` with `status: 'SUCCESS'`, `preferredLabel`, `suggestedNextIds`, `contextUpdates`, `notes`, **When** serialized to JSON, **Then** all fields are present.
7. **Given** the context and outcome implementations, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding.

**Files likely touched:**
- `packages/factory/src/graph/context.ts` (new)
- `packages/factory/src/graph/types.ts` (complete Outcome type)

**Dependencies:** 42-1

---

### Story 42-9: Handler Registry and start/exit/conditional Handlers

**Description:** Implement the `HandlerRegistry` with shape-to-handler mapping and the three trivial node handlers: `start`, `exit`, and `conditional`.

**Acceptance Criteria:**

1. **Given** a `HandlerRegistry`, **When** `resolve(node)` is called for a node with `type="tool"`, **Then** the explicitly registered `tool` handler is returned (per resolution step 1: explicit type).
2. **Given** a node with `shape=diamond` and no explicit `type`, **When** `resolve(node)` is called, **Then** the `conditional` handler is returned (per resolution step 2: shape mapping).
3. **Given** a bare node with `shape=box` and no explicit `type`, **When** `resolve(node)` is called, **Then** the default codergen handler is returned (per resolution step 3: default).
4. **Given** the `start` handler, **When** `execute()` is called, **Then** it returns `{status: 'SUCCESS'}` with no side effects.
5. **Given** the `exit` handler, **When** `execute()` is called, **Then** it returns `{status: 'SUCCESS'}` — goal gate checking is in the executor, not the handler.
6. **Given** the `conditional` handler, **When** `execute()` is called, **Then** it returns `{status: 'SUCCESS'}` — routing is handled by edge selection.
7. **Given** the handler registry and handlers, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding. [PRD: GE-H1, GE-H2]

**Files likely touched:**
- `packages/factory/src/handlers/registry.ts` (new)
- `packages/factory/src/handlers/start.ts`, `exit.ts`, `conditional.ts` (new)

**Dependencies:** 42-8

---

### Story 42-10: Codergen Handler and CLICodergenBackend

**Description:** Implement the `codergen` node handler and the `CLICodergenBackend` that wraps the existing `Dispatcher.dispatch()`.

**Acceptance Criteria:**

1. **Given** a codergen node with `prompt="Implement feature X"`, **When** the handler executes, **Then** it expands `$goal` in the prompt with `graph.goal`, calls `CodergenBackend.run()`, writes `prompt.md` and `response.md` to `{logsRoot}/{nodeId}/`, and writes `status.json`.
2. **Given** `CLICodergenBackend` wrapping an existing `Dispatcher`, **When** `run(node, prompt, context)` is called, **Then** it constructs a `DispatchRequest` mapping `node.llmModel` to `model`, `node.timeout` to `timeout`, and dispatches via the existing dispatcher.
3. **Given** a dispatch that completes with exit code 0, **When** `CLICodergenBackend.mapResult()` processes it, **Then** it returns `{status: 'SUCCESS'}` with the dispatch output in `contextUpdates`.
4. **Given** a dispatch that fails with non-zero exit code, **When** `CLICodergenBackend.mapResult()` processes it, **Then** it returns `{status: 'FAIL', failureReason: ...}`.
5. **Given** backend selection via node attribute `backend="cli"`, **When** the codergen handler resolves the backend, **Then** it uses `CLICodergenBackend`.
6. **Given** the codergen handler and CLI backend, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding. [PRD: GE-H3, CB-2, CB-3]

**Files likely touched:**
- `packages/factory/src/handlers/codergen.ts` (new)
- `packages/factory/src/backend/cli-backend.ts` (new)
- `packages/factory/src/backend/types.ts` (new — CodergenBackend interface)

**Dependencies:** 42-9, 41-2

---

### Story 42-11: Tool and wait.human Handlers

**Description:** Implement the `tool` handler (shell command execution) and the `wait.human` handler (human gate with accelerator key parsing).

**Acceptance Criteria:**

1. **Given** a tool node with `tool_command="echo hello"`, **When** the handler executes, **Then** it spawns a child process, captures stdout, and returns `{status: 'SUCCESS', contextUpdates: {'tool.output': 'hello'}}`.
2. **Given** a tool node with a failing command (exit code != 0), **When** executed, **Then** it returns `{status: 'FAIL', failureReason: stderr_content}`.
3. **Given** the tool handler, **When** executed, **Then** `tool_command` runs in the working directory from `context.getString('workingDirectory', process.cwd())`.
4. **Given** a wait.human node with outgoing edges labeled `"[Y] Yes"` and `"[N] No"`, **When** the handler derives choices, **Then** it parses accelerator keys and presents `{key: "Y", label: "Yes"}` and `{key: "N", label: "No"}`.
5. **Given** a human selects `"[Y] Yes"`, **When** the handler returns, **Then** the outcome has `preferredLabel: "[Y] Yes"` for edge selection.
6. **Given** the tool and wait.human handlers, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding. [PRD: GE-E5]

**Files likely touched:**
- `packages/factory/src/handlers/tool.ts` (new)
- `packages/factory/src/handlers/wait-human.ts` (new)

**Dependencies:** 42-9

---

### Story 42-12: 5-Step Edge Selection Algorithm

**Description:** Implement the 5-step edge selection algorithm per Attractor spec Section 3.3, verbatim from the spec pseudocode.

**Acceptance Criteria:**

1. **Given** edges with conditions, one matching and one not, **When** `selectEdge()` is called, **Then** the condition-matched edge is selected (Step 1).
2. **Given** no condition match, an outcome with `preferredLabel="[Y] Yes"`, and an unconditional edge with `label="[Y] Yes"`, **When** called, **Then** the label-matched edge is selected after normalization (Step 2, lowercase, trim, strip accelerator).
3. **Given** no label match, an outcome with `suggestedNextIds=["node_b", "node_c"]`, and edges to both, **When** called, **Then** `node_b` is selected (first match wins, Step 3).
4. **Given** two unconditional edges with `weight=5` and `weight=3`, **When** called, **Then** the `weight=5` edge is selected (Step 4).
5. **Given** two unconditional edges with equal weight, targets `"beta"` and `"alpha"`, **When** called, **Then** `"alpha"` is selected (lexical tiebreak, Step 5).
6. **Given** Step 1 and Step 2 both have candidates, **When** called, **Then** Step 1 (condition match) wins over Step 2 (preferred label) — per GE-E1.
7. **Given** no outgoing edges, **When** called, **Then** returns `null` (pipeline terminates).
8. **Given** the edge selection implementation, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding. [PRD: GE-E1, GE-E2, GE-E3]

**Files likely touched:**
- `packages/factory/src/graph/edge-selector.ts` (new)

**Dependencies:** 42-6, 42-8

---

### Story 42-13: Checkpoint Manager

**Description:** Implement checkpoint serialization, writing, loading, and resume logic per Attractor spec.

**Acceptance Criteria:**

1. **Given** a completed node execution, **When** `checkpointManager.save()` is called, **Then** a JSON file is written to `{logsRoot}/checkpoint.json` containing `timestamp`, `currentNode`, `completedNodes`, `nodeRetries`, `contextValues`, and `logs` (per GE-C2).
2. **Given** a checkpoint file exists, **When** `checkpointManager.load(path)` is called, **Then** it returns a valid `Checkpoint` object with all fields deserialized.
3. **Given** a checkpoint at node 2 of a 4-node pipeline, **When** `checkpointManager.resume(graph, checkpoint)` is called, **Then** it returns a `GraphContext` with completed nodes marked for skip and the context restored from checkpoint values (per GE-C3).
4. **Given** the previous node used `full` fidelity, **When** resuming, **Then** the first resumed node's fidelity is degraded to `summary:high`, and subsequent nodes may use `full` again (per GE-C4).
5. **Given** checkpoint write occurs, **When** timing is measured, **Then** it completes in under 50ms for a 10KB context.
6. **Given** the checkpoint manager, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding. [PRD: GE-C1, GE-C2, GE-C3, GE-C4, GE-C5]

**Files likely touched:**
- `packages/factory/src/graph/checkpoint.ts` (new)

**Dependencies:** 42-8

---

### Story 42-14: Graph Executor Core Loop

**Description:** Implement the main graph executor loop that ties together parsing, validation, handler dispatch, edge selection, and checkpointing.

**Acceptance Criteria:**

1. **Given** a valid 3-node graph (`start -> codergen -> exit`) and a mock `CodergenBackend`, **When** `executor.run(graph, config)` is called, **Then** it traverses start, dispatches codergen, writes checkpoint, traverses to exit, and returns the final `Outcome`.
2. **Given** the executor, **When** a node handler throws an exception, **Then** it is caught and converted to a `{status: 'FAIL'}` outcome (per GE-H3).
3. **Given** a node with `max_retries=2`, **When** the handler returns FAIL, **Then** the executor retries with exponential backoff (200ms initial, 2x factor, capped at 60s, +/-50% jitter) up to 2 additional attempts.
4. **Given** the executor, **When** each node completes, **Then** a checkpoint is written before advancing to the next node.
5. **Given** `FactoryEvents` defines the following events with these exact payloads: `graph:node-started { runId: string, nodeId: string, nodeType: string }`, `graph:node-completed { runId: string, nodeId: string, outcome: Outcome }`, `graph:node-failed { runId: string, nodeId: string, failureReason: string }`, `graph:edge-selected { runId: string, fromNode: string, toNode: string, step: number }`, `graph:checkpoint-saved { runId: string, nodeId: string, checkpointPath: string }`, **When** each executor step occurs, **Then** the corresponding event is emitted on the event bus with the specified payload shape.
6. **Given** graph traversal overhead, **When** measured on a 20-node graph, **Then** average per-node transition time is under 100ms (excluding handler execution time).
7. **Given** the executor implementation, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding.

**Files likely touched:**
- `packages/factory/src/graph/executor.ts` (new)

**Dependencies:** 42-9, 42-12, 42-13

---

### Story 42-15: Graph Engine Integration Tests

**Description:** End-to-end integration tests for the full graph engine pipeline: parse DOT, validate, transform (stylesheet), execute, checkpoint, and resume.

**Acceptance Criteria:**

1. **Given** a DOT string defining a 5-node pipeline with conditional edges, **When** parsed, validated, and executed end-to-end, **Then** the pipeline completes with the expected outcome based on mock backend responses.
2. **Given** a 10-node graph with all 8 node types (start, exit, codergen, conditional, wait.human, parallel, fan_in, tool), **When** parsed and validated, **Then** all 13 lint rules pass.
3. **Given** an execution interrupted at node 3, **When** resumed from checkpoint, **Then** nodes 1-2 are skipped, node 3 re-executes, and the final outcome matches uninterrupted execution.
4. **Given** a graph with a model stylesheet, **When** executed, **Then** the codergen nodes receive the stylesheet-resolved model values.
5. **Given** the full test suite for Epic 42, **When** run, **Then** at least 100 new tests pass covering parser, validator, executor, handlers, edge selection, and checkpointing.

**Files likely touched:**
- `packages/factory/src/graph/__tests__/` (new — integration test files)

**Dependencies:** 42-14

---

### Story 42-16: PARTIAL_SUCCESS Semantics and Goal Gate Interaction

**Description:** Define when handlers return `PARTIAL_SUCCESS`, how goal gates evaluate it (always passes per Attractor spec), and how it interacts with the `allow_partial` flag on nodes. This story bridges the gap between handler outcomes and convergence controller evaluation.

**Acceptance Criteria:**

1. **Given** a node handler returning `{status: 'PARTIAL_SUCCESS'}`, **When** a goal gate evaluates this node at the exit, **Then** the gate is satisfied — `PARTIAL_SUCCESS` always passes goal gates per the Attractor spec.
2. **Given** a node with `allow_partial=false` (default) and retries exhausted, **When** the last attempt returned `PARTIAL_SUCCESS`, **Then** the outcome is treated as FAIL — `allow_partial` must be true for `PARTIAL_SUCCESS` to be accepted at retry exhaustion.
3. **Given** a node with `allow_partial=true` and retries exhausted, **When** the last attempt returned `PARTIAL_SUCCESS`, **Then** the outcome is accepted as `PARTIAL_SUCCESS` (not promoted to SUCCESS, not demoted to FAIL). [PRD: CL-10]
4. **Given** multiple goal gate nodes where one is `SUCCESS` and another is `PARTIAL_SUCCESS`, **When** goal gates are evaluated, **Then** the overall result is satisfied (both pass).
5. **Given** the `PARTIAL_SUCCESS` semantics, **When** documented in handler development guidelines, **Then** handlers know when to return `PARTIAL_SUCCESS` vs `SUCCESS` or `FAIL`: use `PARTIAL_SUCCESS` when the primary objective was met but secondary goals (e.g., all tests pass, code coverage target) were missed.
6. **Given** the PARTIAL_SUCCESS implementation, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding.

**Files likely touched:**
- `packages/factory/src/convergence/controller.ts` (extend goal gate evaluation for PARTIAL_SUCCESS)
- `packages/factory/src/graph/executor.ts` (extend retry exhaustion handling for allow_partial)
- `packages/factory/src/graph/types.ts` (document PARTIAL_SUCCESS semantics in JSDoc)

**Dependencies:** 42-9, 42-14

---

### Story 42-17: Attractor Spec Compliance Test Suite

**Description:** Run Attractor spec pseudocode examples through the graph engine and verify outputs match the spec's expected behavior. Reference AttractorBench conformance tests for structural validation.

**Acceptance Criteria:**

1. **Given** the Attractor spec's edge selection pseudocode examples, **When** replayed through `selectEdge()`, **Then** each example produces the same result as the spec describes.
2. **Given** the Attractor spec's goal gate evaluation examples, **When** replayed through `checkGoalGates()`, **Then** each example matches the spec's expected outcome.
3. **Given** the Attractor spec's checkpoint resume examples, **When** replayed through `checkpointManager.resume()`, **Then** the fidelity degradation and node skip behavior matches the spec.
4. **Given** AttractorBench (github.com/strongdm/attractorbench) structural validation tests, **When** run against the graph engine, **Then** all structural conformance tests pass. Behavioral conformance tests are advisory during Phase A, required by Phase B exit.
5. **Given** the compliance suite, **When** `npm test` runs, **Then** all conformance tests pass.

**Files likely touched:**
- `packages/factory/src/graph/__tests__/attractor-compliance.test.ts` (new)

**Dependencies:** 42-15

---

### Story 42-18: CodergenBackend Mock Implementation for Testing

**Description:** Implement a `MockCodergenBackend` with injectable failures, delays, and configurable responses for integration testing of the graph engine without requiring real LLM calls.

**Acceptance Criteria:**

1. **Given** a `MockCodergenBackend` configured with `responses: [{status: 'SUCCESS', contextUpdates: {...}}]`, **When** `run()` is called, **Then** it returns the configured response without making any external calls.
2. **Given** a mock backend configured with `failOnCall: [1, 3]`, **When** calls 1 and 3 are made, **Then** they return `{status: 'FAIL'}`, while call 2 returns SUCCESS.
3. **Given** a mock backend configured with `delay: 500`, **When** `run()` is called, **Then** it waits 500ms before returning — enabling timeout testing.
4. **Given** a mock backend, **When** `run()` is called, **Then** it records the call arguments (node, prompt, context) for assertion in tests.
5. **Given** the mock backend, **When** used in graph engine integration tests, **Then** it enables deterministic testing of retry logic, budget enforcement, and convergence behavior.
6. **Given** the mock implementation, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding.

**Files likely touched:**
- `packages/factory/src/backend/mock-backend.ts` (new)
- `packages/factory/src/backend/__tests__/mock-backend.test.ts` (new)

**Dependencies:** 42-10

---

## Epic 43: SDLC Pipeline as Graph — Express Existing Pipeline as DOT, Prove Parity

**Goal:** Express substrate's existing linear SDLC pipeline as a DOT graph. Wire the graph to the existing orchestrators via custom SDLC handlers. Prove behavioral parity: same stories, same inputs, same results.

**Success metric:** SDLC parity test passes on reference project. `substrate run --engine=graph` produces identical results to `substrate run`.

**Stories: 13**

---

### Story 43-1: SDLC Pipeline DOT Graph Definition

**Description:** Create the `packages/sdlc/graphs/sdlc-pipeline.dot` file expressing the existing linear pipeline (analysis -> planning -> solutioning -> create_story -> dev_story -> code_review) as a DOT graph per architecture Section 4.2.

**Acceptance Criteria:**

1. **Given** `sdlc-pipeline.dot`, **When** parsed by the graph engine, **Then** it produces a valid `Graph` with 7 nodes: `start`, `analysis`, `planning`, `solutioning`, `create_story`, `dev_story`, `code_review`, `exit`.
2. **Given** the DOT file, **When** validated with all 13 lint rules, **Then** zero errors and zero warnings. [PRD: SG-1]
3. **Given** `dev_story` node, **When** inspected, **Then** it has `goal_gate=true`, `retry_target=dev_story`, `max_retries=2`, and `type="sdlc.dev-story"`.
4. **Given** `code_review` node, **When** inspected, **Then** it has `shape=diamond` and `type="sdlc.code-review"` with outgoing edges: `SHIP_IT` (condition `outcome=success`) to exit, `NEEDS_FIXES` (condition `outcome=fail`) to dev_story. [PRD: SG-4]
5. **Given** each phase node, **When** inspected, **Then** it has `type="sdlc.phase"` to invoke the custom SDLC phase handler.

**Files likely touched:**
- `packages/sdlc/graphs/sdlc-pipeline.dot` (new)

**Dependencies:** 42-15

---

### Story 43-2: SDLC Phase Handler

**Description:** Implement `SdlcPhaseHandler` that delegates to the existing `PhaseOrchestrator` logic for entry/exit gates and phase dispatch.

**Acceptance Criteria:**

1. **Given** a node with `type="sdlc.phase"` and `prompt="Analyze project concept"`, **When** the handler executes, **Then** it delegates to the existing phase orchestrator's analysis phase logic (entry gates, dispatch, exit gates).
2. **Given** the phase handler for `planning`, **When** it completes, **Then** it returns `{status: 'SUCCESS'}` with the phase output in `contextUpdates`.
3. **Given** a phase dispatch fails, **When** the handler completes, **Then** it returns `{status: 'FAIL', failureReason: ...}` matching the existing phase failure behavior.
4. **Given** the handler, **When** entry or exit gates fail, **Then** behavior matches the existing `PhaseOrchestrator` behavior exactly (same error messages, same events emitted).

**Files likely touched:**
- `packages/sdlc/src/handlers/sdlc-phase-handler.ts` (new)

**Dependencies:** 43-1, 42-9

---

### Story 43-3: SDLC Create-Story Handler

**Description:** Implement `SdlcCreateStoryHandler` that wraps the existing `runCreateStory()` compiled workflow function.

**Acceptance Criteria:**

1. **Given** a node with `type="sdlc.create-story"`, **When** the handler executes, **Then** it delegates to the existing `runCreateStory()` function with the appropriate context (story key, methodology pack, project profile).
2. **Given** `runCreateStory()` succeeds, **When** the handler returns, **Then** `{status: 'SUCCESS'}` with story file path in `contextUpdates`.
3. **Given** `runCreateStory()` fails or produces an invalid story file, **When** the handler returns, **Then** `{status: 'FAIL'}` with the validation error.
4. **Given** the handler, **When** it executes, **Then** the same telemetry events are emitted as the current `ImplementationOrchestrator` create-story phase.

**Files likely touched:**
- `packages/sdlc/src/handlers/sdlc-create-story-handler.ts` (new)

**Dependencies:** 43-2

---

### Story 43-4: SDLC Dev-Story Handler

**Description:** Implement `SdlcDevStoryHandler` that wraps the existing `runDevStory()` compiled workflow function, mapping its result to an `Outcome`.

**Acceptance Criteria:**

1. **Given** a node with `type="sdlc.dev-story"`, **When** the handler executes, **Then** it delegates to the existing `runDevStory()` function with appropriate context (story content, project profile, remediation context if retry).
2. **Given** `runDevStory()` produces a `DevStoryResult` with exit code 0, **When** the handler maps the result, **Then** it returns `{status: 'SUCCESS'}`.
3. **Given** the node has `goal_gate=true` and the dev story fails, **When** the executor reaches exit, **Then** the goal gate check fires and jumps to `retry_target=dev_story`.
4. **Given** a retry iteration, **When** the handler receives remediation context from the graph context, **Then** it passes the previous failure reason and code review feedback to `runDevStory()` — matching the existing rework cycle behavior.

**Files likely touched:**
- `packages/sdlc/src/handlers/sdlc-dev-story-handler.ts` (new)

**Dependencies:** 43-3

---

### Story 43-5: SDLC Code-Review Handler

**Description:** Implement `SdlcCodeReviewHandler` that wraps the existing `runCodeReview()` function and maps the three-way verdict to Outcome status.

**Acceptance Criteria:**

1. **Given** a node with `type="sdlc.code-review"`, **When** the handler executes, **Then** it delegates to the existing `runCodeReview()` function.
2. **Given** a `SHIP_IT` verdict, **When** the handler returns, **Then** it returns `{status: 'SUCCESS', preferredLabel: 'SHIP_IT'}` — the edge selector picks the `outcome=success` edge.
3. **Given** a `NEEDS_MINOR_FIXES` verdict, **When** the handler returns, **Then** it returns `{status: 'FAIL', preferredLabel: 'NEEDS_FIXES', contextUpdates: {remediation: ...}}` — the edge selector picks the `outcome=fail` edge back to dev_story.
4. **Given** an escalation verdict, **When** the handler returns, **Then** it returns `{status: 'FAIL', failureReason: 'escalation: ...'}` and the escalation diagnosis is generated matching existing behavior.

**Files likely touched:**
- `packages/sdlc/src/handlers/sdlc-code-review-handler.ts` (new)

**Dependencies:** 43-4

---

### Story 43-6: SDLC Handler Registration via Runtime Composition

**Description:** Implement the runtime handler registration pattern where the CLI entrypoint imports both SDLC and factory packages and registers SDLC handlers in the factory's `HandlerRegistry` — per ADR-003.

**Acceptance Criteria:**

1. **Given** a CLI startup with `--engine=graph`, **When** the graph executor is initialized, **Then** SDLC handlers (`sdlc.phase`, `sdlc.create-story`, `sdlc.dev-story`, `sdlc.code-review`) are registered in the factory's `HandlerRegistry`.
2. **Given** neither `@substrate-ai/sdlc` nor `@substrate-ai/factory` import each other directly, **When** TypeScript compilation runs, **Then** no cross-package import violations occur.
3. **Given** the CLI is the composition root, **When** it registers handlers, **Then** it imports `NodeHandler` from `@substrate-ai/factory` and handler implementations from `@substrate-ai/sdlc`.
4. **Given** the handler registry, **When** a node with `type="sdlc.dev-story"` is resolved, **Then** the `SdlcDevStoryHandler` is returned.

**Files likely touched:**
- `src/cli/commands/run.ts` (modify — add handler registration logic)
- `packages/sdlc/src/handlers/index.ts` (new — barrel export)

**Dependencies:** 43-5

---

### Story 43-7: Multi-Story Orchestration via Graph Instances

**Description:** Implement the outer loop that runs one graph instance per concurrent story slot, matching the existing `ImplementationOrchestrator`'s concurrent story execution model.

**Acceptance Criteria:**

1. **Given** 3 stories to implement with `maxConcurrency=2`, **When** the graph-based SDLC mode runs, **Then** 2 story graph instances execute concurrently, and the 3rd starts when a slot opens — matching existing orchestrator behavior.
2. **Given** each story graph instance, **When** it runs, **Then** it receives the story key, project root, and methodology pack as initial context values.
3. **Given** the outer loop, **When** a story graph completes, **Then** it reports the same `StoryPhase` transitions and events as the existing orchestrator.
4. **Given** conflict group detection, **When** stories with shared contracts are identified, **Then** they are serialized within their conflict group — matching existing behavior.

**Files likely touched:**
- `packages/sdlc/src/orchestrator/graph-orchestrator.ts` (new)

**Dependencies:** 43-6

---

### Story 43-8: maxReviewCycles Config-to-Graph Mapping

**Description:** Map the existing `maxReviewCycles` configuration to the `max_retries` attribute on the `dev_story` node in the SDLC DOT graph.

**Acceptance Criteria:**

1. **Given** `maxReviewCycles=2` in config, **When** the SDLC graph is loaded, **Then** the `dev_story` node has `max_retries=2` (meaning 3 total attempts: 1 initial + 2 retries) — per SG-5.
2. **Given** `maxReviewCycles=0` in config, **When** the SDLC graph is loaded, **Then** the `dev_story` node has `max_retries=0` (no retries, one attempt only).
3. **Given** the graph executor with `max_retries=2` on `dev_story`, **When** the first two attempts fail, **Then** the third attempt is the last — matching existing `maxReviewCycles` behavior exactly.

**Files likely touched:**
- `packages/sdlc/src/orchestrator/graph-orchestrator.ts` (extend with config mapping)

**Dependencies:** 43-7

---

### Story 43-9: SDLC-as-Graph NDJSON Event Compatibility

**Description:** Ensure the graph-based SDLC pipeline emits the same NDJSON event types and payload shapes as the existing linear pipeline when `--events` is used.

**Acceptance Criteria:**

1. **Given** `substrate run --engine=graph --events`, **When** a story transitions from create-story to dev-story, **Then** `orchestrator:story-phase-start` events are emitted with the same payload shape as the linear orchestrator.
2. **Given** the graph executor emitting `graph:node-started` and `graph:node-completed` events, **When** the SDLC handler bridge converts them, **Then** the corresponding `orchestrator:story-*` events are also emitted for backward compatibility.
3. **Given** an existing event consumer (supervisor, CLI polling), **When** the graph-based pipeline runs, **Then** the consumer works identically without modification.

**Files likely touched:**
- `packages/sdlc/src/handlers/event-bridge.ts` (new — converts graph events to SDLC events)

**Dependencies:** 43-7

---

### Story 43-10: `--engine=graph` CLI Flag

**Description:** Add the `--engine=graph` (and `--engine=linear`, default) flag to `substrate run` to let users opt into the graph-based SDLC execution path.

**Acceptance Criteria:**

1. **Given** `substrate run --engine=graph --stories 1-1`, **When** run, **Then** the SDLC pipeline executes via the graph executor with SDLC handlers.
2. **Given** `substrate run --stories 1-1` (no `--engine` flag), **When** run, **Then** the linear orchestrator is used (default, backward-compatible).
3. **Given** `substrate run --engine=linear --stories 1-1`, **When** run, **Then** the linear orchestrator is used explicitly.
4. **Given** `--engine=graph` with `--events`, **When** run, **Then** NDJSON events are emitted per story 43-9.

**Files likely touched:**
- `src/cli/commands/run.ts` (modify — add --engine flag and routing)

**Dependencies:** 43-9

---

### Story 43-11: SDLC Parity Test Suite

**Description:** Create automated parity tests that run the same story set through both the linear orchestrator and the graph-based orchestrator and compare results.

**Acceptance Criteria:**

1. **Given** a test story set with known outcomes, **When** run through both `--engine=linear` and `--engine=graph`, **Then** the same story files are created, the same build verification passes, and the same final story status (complete/escalated) is produced.
2. **Given** the parity test, **When** the story requires a rework cycle (NEEDS_FIXES verdict), **Then** both engines produce the same number of review cycles and the same final outcome.
3. **Given** a story that escalates, **When** run through both engines, **Then** both produce the same escalation diagnosis.
4. **Given** the test harness, **When** run in CI, **Then** it catches any behavioral divergence between engines.

**Files likely touched:**
- `packages/sdlc/src/__tests__/parity-test.ts` (new)

**Dependencies:** 43-10

---

### Story 43-12: SDLC-as-Graph Cross-Project Validation

**Description:** Run the graph-based SDLC pipeline on a reference project and verify identical results to the linear pipeline.

**Acceptance Criteria:**

1. **Given** the reference project (ynab or nextgen-ticketing), **When** `substrate run --engine=graph --stories <known-set>` is run, **Then** the pipeline completes with the same story outcomes as the linear engine.
2. **Given** the NDJSON event stream from both engines, **When** compared, **Then** the same event types appear in the same logical order.
3. **Given** the graph executor's performance overhead, **When** measured, **Then** total wall-clock time is within 5% of the linear orchestrator for the same story set.
4. **Given** two stories with overlapping contracts, **When** the graph orchestrator processes them, **Then** it serializes them within their conflict group identically to the linear orchestrator.

**Files likely touched:**
- No code changes — validation-only story

**Dependencies:** 43-11

---

### Story 43-13: SDLC Phase Gate Integration with Graph Node Handlers

**Description:** Map `PhaseOrchestrator` entry/exit gates to graph node handler attributes so that phase gates are evaluated as part of graph node execution, not as a separate mechanism.

**Acceptance Criteria:**

1. **Given** a phase node `analysis [type="sdlc.phase"]`, **When** the `SdlcPhaseHandler` executes, **Then** it evaluates the phase's entry gates before dispatching and exit gates after dispatch — matching `PhaseOrchestrator.advancePhase()` behavior.
2. **Given** an entry gate fails, **When** the handler returns, **Then** it returns `{status: 'FAIL', failureReason: 'entry gate failed: ...'}` — the graph engine's retry mechanism handles retry if `max_retries > 0`.
3. **Given** an exit gate fails, **When** the handler returns, **Then** it returns `{status: 'FAIL', failureReason: 'exit gate failed: ...'}` — the handler does not retry internally.
4. **Given** the phase gate integration, **When** `substrate run --engine=graph` runs through analysis -> planning -> solutioning, **Then** the same entry/exit gate checks fire as in the linear orchestrator.
5. **Given** the phase gate mapping, **When** a new gate is registered via `GateRegistry`, **Then** it is evaluated by the SDLC phase handler without changes to the graph engine.

**Files likely touched:**
- `packages/sdlc/src/handlers/sdlc-phase-handler.ts` (extend with explicit gate integration)

**Dependencies:** 43-2, 43-6

---

# Phase B: Factory Loop

**Goal:** A working convergence loop that iterates until holdout scenarios pass. First "factory" milestone.

**Quality model:** Phase 2 (dual signal) transitioning to Phase 3 (scenario primary).

**Phase B exit criteria:**
- Factory convergence loop works end-to-end (implement -> validate -> score -> pass/exit or fail/retry)
- Convergence rate >80% on reference project
- Self-hosting milestone attempted (holdout scenarios for edge selection algorithm)
- +300 new tests

---

## Epic 44: Scenario Store + Runner — Definition Format, Isolation, Execution

**Goal:** Build the external scenario validation system: scenario discovery, integrity checking, isolation verification, shell-script runner with structured results.

**Success metric:** Scenarios execute in isolation. Agents cannot access scenario source. Checksum verification detects tampering. Structured pass/fail results returned.

**Stories: 10**

---

### Story 44-1: Scenario Store — Discovery and Manifest

**Description:** Implement the `ScenarioStore` that discovers scenario files in `.substrate/scenarios/` and computes a SHA-256 checksum manifest.

**Acceptance Criteria:**

1. **Given** `.substrate/scenarios/` contains `scenario-login-flow.sh`, `scenario-checkout.py`, and `not-a-scenario.txt`, **When** `store.discover(scenarioDir)` is called, **Then** it returns 2 `ScenarioFile` entries (matching `scenario-*.{sh,py,js,ts}`), excluding the `.txt` file.
2. **Given** discovered scenarios, **When** `store.computeChecksums(scenarios)` is called, **Then** it returns a `ScenarioManifest` with SHA-256 checksums for each scenario file.
3. **Given** a manifest, **When** `store.verifyIntegrity(manifest)` is called without file modifications, **Then** it returns `true`.
4. **Given** a scenario file modified after manifest creation, **When** `store.verifyIntegrity(manifest)` is called, **Then** it returns `false`.
5. **Given** the `ScenarioFile` type, **When** a scenario has YAML frontmatter with `weight: 2.0`, **Then** the `weight` field is populated from the frontmatter. [PRD: SV-6, SV-8]

**Files likely touched:**
- `packages/factory/src/scenarios/store.ts` (new)
- `packages/factory/src/scenarios/types.ts` (new)

**Dependencies:** 42-15

---

### Story 44-2: Scenario Runner — Shell-Script Execution

**Description:** Implement the `ScenarioRunner` that executes each scenario as a child process and returns structured `ScenarioRunResult`.

**Acceptance Criteria:**

1. **Given** a scenario script `scenario-login.sh` with exit code 0, **When** `runner.run(manifest, workingDir)` executes it, **Then** the corresponding `ScenarioResult` has `status: 'pass'`, the correct `exitCode`, `stdout`, `stderr`, and `durationMs`.
2. **Given** a scenario script with exit code 1, **When** executed, **Then** `ScenarioResult` has `status: 'fail'`.
3. **Given** stdout containing valid JSON, **When** the result is processed, **Then** the JSON is parsed and attached as structured details.
4. **Given** 3 scenarios (2 pass, 1 fail), **When** all execute, **Then** `ScenarioRunResult.summary` shows `{total: 3, passed: 2, failed: 1}`.
5. **Given** each scenario, **When** executed, **Then** it runs in a separate child process with the project's working directory as CWD — per architecture Section 5.2. [PRD: SV-3, SV-4, SV-7]

**Files likely touched:**
- `packages/factory/src/scenarios/runner.ts` (new)

**Dependencies:** 44-1

---

### Story 44-3: Scenario Isolation — Gitignore and Context Exclusion

**Description:** Ensure scenarios are excluded from agent visibility: `.substrate/scenarios/` is gitignored, excluded from `ContextCompiler`, and not included in any agent dispatch working directory.

**Acceptance Criteria:**

1. **Given** `substrate init` runs in a project, **When** it completes, **Then** `.substrate/scenarios/` is added to `.gitignore`.
2. **Given** the `ContextCompiler` in core, **When** it compiles context for any task, **Then** `.substrate/scenarios/` is in the file exclusion list — no scenario file content appears in any compiled context.
3. **Given** a dispatch to a CLI agent, **When** the agent's working tree is inspected, **Then** `.substrate/scenarios/` content is not accessible (scenario dir is excluded from the dispatch working directory).
4. **Given** a pipeline run, **When** all dispatched prompts are audited, **Then** no prompt contains scenario file content — per security requirement in PRD Section 7.4. [PRD: SV-1, SV-2]
5. **Given** a factory pipeline with scenarios containing the secret string `SCENARIO_SECRET_TOKEN`, **When** the integration test audits all dispatched prompts across every agent dispatch, **Then** the token does NOT appear in any prompt, context, or working directory content.

**Files likely touched:**
- `src/cli/commands/init.ts` (modify — add scenario dir to gitignore)
- `packages/core/src/context/context-compiler.ts` (modify — add exclusion)

**Dependencies:** 44-1, 41-9

---

### Story 44-4: Scenario Integrity Verification During Pipeline Runs

**Description:** Integrate checksum verification into the pipeline execution so that scenario file modification during a run triggers a pipeline error.

**Acceptance Criteria:**

1. **Given** a factory pipeline run starts, **When** scenarios are loaded, **Then** the manifest (with checksums) is computed and stored.
2. **Given** a scenario validation node is about to execute, **When** `store.verifyIntegrity(manifest)` is called, **Then** integrity is checked before any scenario runs.
3. **Given** a scenario file is modified between iterations, **When** integrity check runs, **Then** the pipeline emits an error event and halts — not a false pass, per SV-6.
4. **Given** no modifications, **When** integrity check runs, **Then** validation proceeds normally.

**Files likely touched:**
- `packages/factory/src/scenarios/store.ts` (extend with pipeline integration)
- `packages/factory/src/graph/executor.ts` (integrate integrity check before scenario nodes)

**Dependencies:** 44-2, 44-3

---

### Story 44-5: Scenario Validation as Graph Tool Node

**Description:** Wire scenario validation as a `tool` node type in the graph per architecture Section 5.4 — the `tool_command` invokes the scenario runner and writes results to context.

**Acceptance Criteria:**

1. **Given** a graph node `validate [shape=parallelogram, type="tool", tool_command="substrate scenarios run --format json"]`, **When** the tool handler executes, **Then** it invokes the scenario runner.
2. **Given** the scenario runner returns structured JSON results, **When** the tool handler processes stdout, **Then** it parses the JSON, computes the satisfaction score, and sets `context.satisfaction_score`.
3. **Given** a subsequent conditional node evaluating `satisfaction_score>=0.8`, **When** the score is 0.9, **Then** the condition-matched edge to exit is selected.
4. **Given** a score of 0.6, **When** the condition is evaluated, **Then** the fail edge (back to implement) is selected.

**Files likely touched:**
- `packages/factory/src/scenarios/cli-command.ts` (new — `substrate scenarios run` subcommand)
- `packages/factory/src/handlers/tool.ts` (extend with JSON parsing for scenario results)

**Dependencies:** 44-4, 42-11

---

### Story 44-6: Factory Schema — scenario_results and graph_runs Tables

**Description:** Add the `graph_runs`, `graph_node_results`, and `scenario_results` database tables per architecture Section 9.1.

**Acceptance Criteria:**

1. **Given** `factorySchema(adapter)` is called, **When** it completes, **Then** the `graph_runs` table exists with columns: `id`, `graph_file`, `graph_goal`, `status`, `started_at`, `completed_at`, `total_cost_usd`, `node_count`, `final_outcome`, `checkpoint_path`.
2. **Given** the `graph_node_results` table, **When** inspected, **Then** it has columns: `id`, `run_id`, `node_id`, `attempt`, `status`, `started_at`, `completed_at`, `duration_ms`, `cost_usd`, `failure_reason`, `context_snapshot`.
3. **Given** the `scenario_results` table, **When** inspected, **Then** it has columns per architecture Section 9.1 including `satisfaction_score`, `threshold`, `passes`, `details`.
4. **Given** indexes `idx_scenario_results_run` and `idx_graph_node_results_run`, **When** schema is initialized, **Then** both indexes exist.
5. **Given** `factorySchema(adapter)` is called multiple times, **When** run, **Then** it is idempotent (CREATE TABLE IF NOT EXISTS).

**Files likely touched:**
- `packages/factory/src/persistence/factory-schema.ts` (new)

**Dependencies:** 41-3

---

### Story 44-7: File-Backed Run State Directory Structure

**Description:** Implement the file-backed run state directory structure per architecture Section 9.2: `.substrate/runs/{run_id}/` with checkpoint, graph copy, per-node directories, and scenario result directories.

**Acceptance Criteria:**

1. **Given** a factory run starts with `run_id="r1"`, **When** the run initializes, **Then** `.substrate/runs/r1/` directory is created with `graph.dot` (copy of executed graph).
2. **Given** a node `dev_story` completes, **When** its artifacts are written, **Then** `.substrate/runs/r1/dev_story/prompt.md`, `response.md`, and `status.json` exist.
3. **Given** a scenario validation at iteration 2, **When** results are written, **Then** `.substrate/runs/r1/scenarios/2/manifest.json` and `results.json` exist.
4. **Given** the checkpoint, **When** written, **Then** it is at `.substrate/runs/r1/checkpoint.json`.

**Files likely touched:**
- `packages/factory/src/graph/run-state.ts` (new)

**Dependencies:** 42-13

---

### Story 44-8: `substrate factory scenarios` CLI Commands

**Description:** Implement CLI subcommands for listing and manually running scenarios outside the pipeline.

**Acceptance Criteria:**

1. **Given** `substrate factory scenarios list`, **When** run in a project with 3 scenarios, **Then** it lists each scenario name, file path, and SHA-256 checksum.
2. **Given** `substrate factory scenarios run`, **When** run, **Then** it executes all discovered scenarios and displays structured results (total, passed, failed, per-scenario details).
3. **Given** `substrate factory scenarios run --format json`, **When** run, **Then** it outputs `ScenarioRunResult` as JSON to stdout.

**Files likely touched:**
- `src/cli/commands/factory.ts` (new or extend — scenarios subcommands)

**Dependencies:** 44-2

---

### Story 44-9: Factory Config Schema and `substrate factory run` Command

**Description:** Implement the `FactoryConfigSchema` per architecture Section 10.1 and the `substrate factory run` CLI command that loads a DOT graph and executes it.

**Acceptance Criteria:**

1. **Given** `config.yaml` with a `factory:` section containing `graph`, `scenario_dir`, `satisfaction_threshold`, `budget_cap_usd`, `wall_clock_cap_seconds`, `plateau_window`, `plateau_threshold`, `backend`, **When** loaded, **Then** it validates against `FactoryConfigSchema` and defaults are applied.
2. **Given** `substrate factory run --graph pipeline.dot`, **When** run, **Then** it parses the DOT file, validates, and executes the graph pipeline.
3. **Given** `substrate factory run` without `--graph`, **When** a `factory.graph` key exists in config, **Then** it uses that graph file.
4. **Given** no graph file specified anywhere, **When** `substrate factory run` is called, **Then** it exits with error "No graph file specified".
5. **Given** `--events` flag, **When** the factory run proceeds, **Then** NDJSON events are emitted for graph lifecycle.

**Files likely touched:**
- `packages/factory/src/config.ts` (new — FactoryConfigSchema)
- `src/cli/commands/factory.ts` (new — factory run command)

**Dependencies:** 44-7, 42-14

---

### Story 44-10: Scenario Store Integration Test

**Description:** End-to-end test: factory pipeline with scenario validation node, scenario execution, structured results, and integrity checking.

**Acceptance Criteria:**

1. **Given** a test DOT graph with `implement -> validate -> conditional -> exit/retry`, **When** executed with mock scenarios (2 pass, 1 fail), **Then** the satisfaction score is 0.67, the conditional routes to retry.
2. **Given** a second iteration where all 3 scenarios pass, **When** the score is recomputed, **Then** it is 1.0 and the conditional routes to exit.
3. **Given** scenario integrity tamper, **When** a scenario is modified between iterations, **Then** the pipeline errors with a checksum mismatch.
4. **Given** the full Epic 44 test suite, **When** run, **Then** at least 60 new tests pass.

**Files likely touched:**
- `packages/factory/src/scenarios/__tests__/` (new — integration tests)

**Dependencies:** 44-5, 44-6

---

## Epic 45: Convergence Loop — Goal Gates, Retry Routing, Budget Controls

**Goal:** Implement goal gate enforcement, the 4-level retry target resolution chain, budget controls at three levels, diminishing returns detection, and remediation context injection.

**Success metric:** Goal gates block exit when unsatisfied. Budget caps terminate execution. Plateau detection escalates. Remediation context flows to retried nodes.

**Stories: 10**

---

### Story 45-1: Goal Gate Evaluation at Terminal Node

**Description:** Implement the `ConvergenceController.checkGoalGates()` that evaluates all visited goal gate nodes when traversal reaches the exit node.

**Acceptance Criteria:**

1. **Given** a graph with `dev_story [goal_gate=true]` that completed with `SUCCESS`, **When** the executor reaches exit, **Then** `checkGoalGates()` returns `{satisfied: true}` and the pipeline exits normally.
2. **Given** `dev_story [goal_gate=true]` that completed with `FAIL`, **When** the executor reaches exit, **Then** `checkGoalGates()` returns `{satisfied: false, failedGate: dev_story}`.
3. **Given** multiple goal gate nodes, **When** any one is unsatisfied, **Then** the overall result is unsatisfied.
4. **Given** a goal gate node with `PARTIAL_SUCCESS`, **When** evaluated, **Then** it is considered satisfied (per Attractor spec — PARTIAL_SUCCESS passes goal gates). [PRD: CL-1]
5. **Given** the `graph:goal-gate-checked` event, **When** a gate is evaluated, **Then** the event is emitted with `{nodeId, satisfied, score}`. [PRD: CL-1]

**Files likely touched:**
- `packages/factory/src/convergence/controller.ts` (new)

**Dependencies:** 42-14

---

### Story 45-2: 4-Level Retry Target Resolution Chain

**Description:** Implement the retry target resolution chain: node `retryTarget` -> node `fallbackRetryTarget` -> graph `retryTarget` -> graph `fallbackRetryTarget` -> FAIL.

**Acceptance Criteria:**

1. **Given** a failing goal gate node with `retry_target=dev_story`, **When** `resolveRetryTarget()` is called, **Then** it returns `"dev_story"` (level 1).
2. **Given** a failing node with no `retry_target` but `fallback_retry_target=start_over`, **When** resolved, **Then** returns `"start_over"` (level 2).
3. **Given** a failing node with neither, but the graph has `retry_target=global_retry`, **When** resolved, **Then** returns `"global_retry"` (level 3).
4. **Given** no retry targets at any level, **When** resolved, **Then** returns `null` and the pipeline returns FAIL (level 5).
5. **Given** a retry target that references a non-existent node, **When** resolved, **Then** it falls through to the next level in the chain. [PRD: CL-2, CL-3]

**Files likely touched:**
- `packages/factory/src/convergence/controller.ts` (extend)

**Dependencies:** 45-1

---

### Story 45-3: Per-Node Budget Enforcement (max_retries with Backoff)

**Description:** Implement per-node retry budget with exponential backoff and jitter.

**Acceptance Criteria:**

1. **Given** a node with `max_retries=2`, **When** the handler fails, **Then** up to 2 additional attempts are made (3 total) before the node is considered permanently failed.
2. **Given** the retry backoff, **When** the delays are computed, **Then** they follow exponential backoff: 200ms initial, 2x factor, capped at 60s, with +/-50% jitter (per CL-6).
3. **Given** `max_retries=0`, **When** the handler fails, **Then** no retry — immediate failure.
4. **Given** a node with `allow_partial=true` and retries exhausted, **When** the last attempt returned `PARTIAL_SUCCESS`, **Then** the outcome is accepted as `PARTIAL_SUCCESS` rather than FAIL (per CL-10).
5. **Given** `checkNodeBudget(nodeId, retryCount, maxRetries)`, **When** `retryCount >= maxRetries`, **Then** it returns `{allowed: false, reason: 'max retries exhausted'}`. [PRD: CL-5, CL-6]

**Files likely touched:**
- `packages/factory/src/convergence/budget.ts` (new)
- `packages/factory/src/graph/executor.ts` (integrate budget check in retry loop)

**Dependencies:** 42-14

---

### Story 45-4: Per-Pipeline Budget Enforcement (budget_cap_usd)

**Description:** Implement pipeline-level cost budget that stops execution when estimated cost exceeds the configured cap.

**Acceptance Criteria:**

1. **Given** `budget_cap_usd=5.00` in factory config, **When** accumulated cost reaches $5.01 before a node dispatch, **Then** the pipeline halts with `{allowed: false, reason: 'pipeline budget exhausted: $5.01 > $5.00'}`.
2. **Given** `budget_cap_usd=0` (unlimited), **When** cost accumulates, **Then** no budget check fires.
3. **Given** the budget enforcer, **When** a node dispatch completes, **Then** its cost is added to the running total.
4. **Given** the `convergence:budget-exhausted` event, **When** budget is exceeded, **Then** the event is emitted with `{level: 'pipeline', reason: ...}`. [PRD: CL-7]

**Files likely touched:**
- `packages/factory/src/convergence/budget.ts` (extend)

**Dependencies:** 45-3

---

### Story 45-5: Per-Session Budget Enforcement (wall_clock_cap)

**Description:** Implement session-level wall-clock budget that terminates execution after a configured duration.

**Acceptance Criteria:**

1. **Given** `wall_clock_cap_seconds=3600` in factory config, **When** 3601 seconds have elapsed before a node dispatch, **Then** the pipeline halts with `{allowed: false, reason: 'wall clock budget exhausted'}`.
2. **Given** `wall_clock_cap_seconds=0` (unlimited), **When** time passes, **Then** no wall-clock check fires.
3. **Given** the session timer starts at pipeline launch, **When** `checkSessionBudget(wallClockMs, capMs)` is called, **Then** it compares elapsed time to the cap.
4. **Given** multiple budget limits trigger simultaneously, **When** the budget enforcer evaluates, **Then** enforcement priority is: per-session wall-clock (highest) > per-pipeline cost > per-node retries (lowest). The first limit hit terminates execution.

**Files likely touched:**
- `packages/factory/src/convergence/budget.ts` (extend)

**Dependencies:** 45-4

---

### Story 45-6: Diminishing Returns / Plateau Detection

**Description:** Implement the `PlateauDetector` that tracks satisfaction scores across iterations and escalates when scores plateau.

**Acceptance Criteria:**

1. **Given** a plateau window of 3 and threshold of 0.05, **When** scores `[0.6, 0.61, 0.59]` are recorded, **Then** `isPlateaued()` returns `true` (max-min = 0.02 < 0.05).
2. **Given** scores `[0.6, 0.7, 0.8]`, **When** checked, **Then** `isPlateaued()` returns `false` (max-min = 0.2 > 0.05).
3. **Given** fewer than `plateauWindow` scores recorded, **When** checked, **Then** `isPlateaued()` returns `false` (insufficient data).
4. **Given** plateau detected, **When** the convergence controller acts, **Then** it escalates instead of retrying — emitting `convergence:plateau-detected` event with the score history.
5. **Given** configurable window and threshold from `FactoryConfig`, **When** the detector is constructed, **Then** it uses the configured values.

**Files likely touched:**
- `packages/factory/src/convergence/plateau.ts` (new)

**Dependencies:** 44-10

---

### Story 45-7: Remediation Context Injection on Retry

**Description:** Implement structured remediation context that is injected into the retried node's `GraphContext` when a goal gate triggers a retry.

**Acceptance Criteria:**

1. **Given** a retry triggered by an unsatisfied goal gate, **When** the retried node's context is prepared, **Then** `context.remediation` contains `{previousFailureReason, scenarioDiff, iterationCount, satisfactionScoreHistory, fixScope}` per architecture Section 6.5.
2. **Given** the `scenarioDiff` field, **When** populated, **Then** it contains "Scenarios X and Y failed because Z" — structured information about which scenarios failed and why.
3. **Given** the `fixScope` field, **When** populated, **Then** it provides a focused instruction ("fix the login validation to handle empty passwords") derived from the failing scenario details.
4. **Given** the remediation context, **When** the `CodergenBackend` receives it, **Then** it includes the remediation in the agent's prompt.

**Files likely touched:**
- `packages/factory/src/convergence/controller.ts` (extend with remediation injection)

**Dependencies:** 45-2, 44-5

---

### Story 45-8: Convergence Controller Integration with Executor

**Description:** Wire the `ConvergenceController` into the graph executor so that goal gates, retry routing, budget enforcement, plateau detection, and remediation all work together in the execution loop.

**Acceptance Criteria:**

1. **Given** the executor reaches exit with unsatisfied goal gates, **When** a retry target is resolved, **Then** execution jumps to the retry target node.
2. **Given** the retry loop, **When** per-node budget is exhausted AND per-pipeline budget is not, **Then** the node fails but the pipeline continues (if there are other paths).
3. **Given** plateau detection fires during a retry loop, **When** the convergence controller acts, **Then** it escalates the pipeline with the plateau data rather than retrying again.
4. **Given** a working convergence loop (implement -> validate -> score -> gate check), **When** executed end-to-end, **Then** it iterates correctly until satisfaction threshold is met or budget is exhausted.

**Files likely touched:**
- `packages/factory/src/graph/executor.ts` (integrate convergence controller)

**Dependencies:** 45-3, 45-4, 45-5, 45-6, 45-7

---

### Story 45-9: Convergence Loop End-to-End Test

**Description:** Integration test of the full convergence loop: implement, validate against scenarios, score, check goal gate, retry with remediation, converge or exhaust budget.

**Acceptance Criteria:**

1. **Given** a factory pipeline graph with `implement [goal_gate=true, retry_target=implement, max_retries=3]` -> `validate` -> `conditional` -> `exit/implement`, **When** the mock backend fails scenario validation on attempts 1-2 but passes on attempt 3, **Then** the pipeline converges after 3 iterations.
2. **Given** the same pipeline with all 4 attempts failing, **When** max_retries is exhausted, **Then** the pipeline fails with budget exhaustion.
3. **Given** the pipeline budget set to $2.00 and each iteration costs $1.00, **When** the 3rd iteration starts, **Then** the pipeline halts with pipeline budget exhaustion.
4. **Given** the remediation context, **When** the 2nd attempt runs, **Then** the context contains the failure reason from the 1st attempt.

**Files likely touched:**
- `packages/factory/src/convergence/__tests__/convergence-loop.test.ts` (new)

**Dependencies:** 45-8

---

### Story 45-10: Convergence Loop Cross-Project Validation

**Description:** Run the factory convergence loop on a reference project with real scenarios to validate the end-to-end flow.

**Acceptance Criteria:**

1. **Given** a reference project with 3 holdout scenarios, **When** `substrate factory run --graph trycycle.dot --scenarios .substrate/scenarios/` is run, **Then** the convergence loop executes: implement, validate, score, and either converges or exhausts budget.
2. **Given** the run completes, **When** `substrate metrics` is checked, **Then** the scenario results, satisfaction scores, and iteration count are visible.
3. **Given** a successful convergence, **When** the final implementation is inspected, **Then** all 3 holdout scenarios pass independently.

**Files likely touched:**
- No code changes — validation-only story

**Dependencies:** 45-9

---

## Epic 46: Satisfaction Scoring — Probabilistic Scoring, Threshold Integration

**Goal:** Implement weighted probabilistic satisfaction scoring, integrate with goal gate evaluation, add parallel running with code review, persist scores, and display via CLI.

**Success metric:** Scores between 0.0-1.0 computed from scenario results. Goal gates evaluate against configurable threshold. Scores agree with code review >80% of the time.

**Stories: 8**

---

### Story 46-1: Satisfaction Scorer — Weighted Average Computation

**Description:** Implement the `SatisfactionScorer` that computes a weighted average score from scenario results per architecture Section 5.3.

**Acceptance Criteria:**

1. **Given** 5 scenarios with default weight 1.0 where 3 pass, **When** `scorer.compute(results)` is called, **Then** it returns `{score: 0.6, passes: false}` (assuming threshold 0.8).
2. **Given** scenarios with weights `{login: 3.0, checkout: 1.0, profile: 1.0}` where only login passes, **When** computed, **Then** `score = 3.0 / 5.0 = 0.6`.
3. **Given** all scenarios pass, **When** computed, **Then** `score = 1.0, passes: true`.
4. **Given** no scenarios, **When** computed, **Then** `score = 0.0, passes: false`.
5. **Given** the `SatisfactionScore` result, **When** `breakdown` is inspected, **Then** each scenario's name, passed status, weight, and contribution are listed. [PRD: SS-1, SS-3]

**Files likely touched:**
- `packages/factory/src/scenarios/scorer.ts` (new)

**Dependencies:** 44-2

---

### Story 46-2: Configurable Satisfaction Threshold

**Description:** Wire the satisfaction threshold from factory config into goal gate evaluation so gates pass/fail based on the configured threshold.

**Acceptance Criteria:**

1. **Given** `satisfaction_threshold=0.8` in factory config, **When** the score is 0.79, **Then** goal gate fails.
2. **Given** `satisfaction_threshold=0.8` and score 0.80, **When** evaluated, **Then** goal gate passes (>=).
3. **Given** `satisfaction_threshold=0.5` (relaxed), **When** the score is 0.6, **Then** goal gate passes.
4. **Given** the threshold is changed in config during a run, **When** hot-reload fires, **Then** subsequent gate evaluations use the new threshold. [PRD: SS-2]

**Files likely touched:**
- `packages/factory/src/convergence/controller.ts` (extend with threshold)
- `packages/factory/src/scenarios/scorer.ts` (pass threshold to compute)

**Dependencies:** 46-1, 45-1

---

### Story 46-3: Score Persistence to Database

**Description:** Persist satisfaction scores and per-scenario results to the `scenario_results` database table and add a `satisfaction_score` column to run metrics.

**Acceptance Criteria:**

1. **Given** a scenario run completes with score 0.85, **When** persisted, **Then** a row in `scenario_results` contains the `run_id`, `node_id`, `iteration`, `total_scenarios`, `passed`, `failed`, `satisfaction_score`, `threshold`, `passes`, and `details` (JSON of per-scenario results).
2. **Given** multiple iterations, **When** queried, **Then** the score history for a run shows all iterations in order.
3. **Given** the `graph_runs` table, **When** a factory run completes, **Then** the row is updated with `final_outcome` and `total_cost_usd`.
4. **Given** the `graph_node_results` table, **When** a node completes, **Then** a row is written with `run_id`, `node_id`, `attempt`, `status`, `duration_ms`, `cost_usd`.

**Files likely touched:**
- `packages/factory/src/persistence/factory-queries.ts` (new)
- `packages/factory/src/graph/executor.ts` (integrate persistence calls)

**Dependencies:** 44-6, 46-1

---

### Story 46-4: Score Display via `substrate metrics`

**Description:** Extend the `substrate metrics` CLI command to display factory run scores including satisfaction scores, iteration counts, and convergence status.

**Acceptance Criteria:**

1. **Given** `substrate metrics --output-format json`, **When** factory runs exist, **Then** the output includes `graph_runs` with `satisfaction_score`, `iterations`, `convergence_status` fields.
2. **Given** a specific run, **When** `substrate metrics --run <id>`, **Then** per-iteration score history is displayed.
3. **Given** both SDLC and factory runs in the database, **When** `substrate metrics` displays all runs, **Then** factory runs are clearly identified with a `type: 'factory'` field.

**Files likely touched:**
- `src/cli/commands/metrics.ts` (modify — add factory metrics display)
- `packages/factory/src/persistence/factory-queries.ts` (add query functions)

**Dependencies:** 46-3

---

### Story 46-5: Parallel Running — Dual Signal (Code Review + Scenario)

**Description:** Implement Phase 2 of the quality model transition: both code review and scenario validation run for every story, with code review as the decision-maker and scenario scores logged for comparison.

**Acceptance Criteria:**

1. **Given** a factory pipeline in dual-signal mode, **When** a story completes, **Then** both code review and scenario validation execute.
2. **Given** code review returns `SHIP_IT` and scenario score is 0.6, **When** the dual signal is logged, **Then** the log records disagreement: code review passed, scenario failed at threshold 0.8.
3. **Given** code review returns `NEEDS_FIXES` and scenario score is 0.9, **When** logged, **Then** disagreement: code review failed, scenario passed.
4. **Given** the decision authority is code review (Phase 2), **When** code review says `SHIP_IT`, **Then** the pipeline proceeds to exit regardless of scenario score.
5. **Given** a `scenario:score-computed` event, **When** emitted alongside the code review event, **Then** both are in the NDJSON stream for external analysis.

**Files likely touched:**
- `packages/factory/src/convergence/dual-signal.ts` (new)

**Dependencies:** 46-2, 43-5 (Code-Review Handler required for dual-signal mode)

---

### Story 46-6: Phase 3 Quality Transition — Scenario Primary

**Description:** Implement Phase 3 of the quality model transition: scenario satisfaction score drives goal gate decisions, code review runs as advisory only.

**Acceptance Criteria:**

1. **Given** factory config `quality_mode: 'scenario-primary'`, **When** a story completes, **Then** both code review and scenario validation run, but the goal gate evaluates only the satisfaction score.
2. **Given** scenario score 0.9 (passes) and code review `NEEDS_FIXES`, **When** goal gate evaluates, **Then** it passes — scenario is primary.
3. **Given** scenario score 0.6 (fails) and code review `SHIP_IT`, **When** goal gate evaluates, **Then** it fails — scenario overrides code review.
4. **Given** code review runs as advisory, **When** its result is logged, **Then** it appears as an advisory signal in the NDJSON event stream but does not affect the pipeline decision.

**Files likely touched:**
- `packages/factory/src/convergence/dual-signal.ts` (extend with scenario-primary mode)
- `packages/factory/src/config.ts` (add quality_mode config option)

**Dependencies:** 46-5

---

### Story 46-7: `substrate factory validate` CLI Command

**Description:** Implement the `substrate factory validate <graph.dot>` command that parses and validates a DOT graph against all 13 lint rules and reports diagnostics.

**Acceptance Criteria:**

1. **Given** `substrate factory validate pipeline.dot` with a valid graph, **When** run, **Then** it reports "13/13 rules passed, 0 errors, 0 warnings".
2. **Given** a graph with 2 start nodes, **When** validated, **Then** it reports the `start_node` error with the offending node IDs.
3. **Given** a graph with warnings only, **When** validated, **Then** it reports warnings but exits with code 0 (warnings do not block).
4. **Given** `--output-format json`, **When** run, **Then** diagnostics are output as JSON array of `ValidationDiagnostic` objects.

**Files likely touched:**
- `src/cli/commands/factory.ts` (extend — validate subcommand)

**Dependencies:** 42-5

---

### Story 46-8: Satisfaction Scoring Integration Test and Cross-Project Validation

**Description:** End-to-end test of the full scoring pipeline and validation on a reference project.

**Acceptance Criteria:**

1. **Given** a factory pipeline with weighted scenarios (critical scenario weight=3.0, others weight=1.0), **When** only the critical scenario passes, **Then** the weighted score reflects the higher contribution.
2. **Given** the dual-signal mode, **When** run across 10 mock stories, **Then** scenario scores agree with code review verdicts in the majority of cases.
3. **Given** a reference project with real scenarios, **When** `substrate factory run` completes, **Then** satisfaction scores are persisted and visible via `substrate metrics`.
4. **Given** the full Epic 46 test suite, **When** run, **Then** at least 40 new tests pass.

**Files likely touched:**
- `packages/factory/src/scenarios/__tests__/scoring.test.ts` (new)

**Dependencies:** 46-6

---

# Phase C: Scale

**Goal:** Full factory capabilities including digital twins, per-turn agent control, context engineering, and advanced graph features.

**Quality model:** Phase 4 (scenarios only in factory mode).

**Phase C exit criteria:**
- Factory produces validated implementations using scenario-only quality model
- Direct API backend operational with per-turn visibility
- Convergence rate >90%
- Avg cost per converged story <$10
- +400 new tests

---

## Epic 47: Digital Twin Foundation — Registry, Runtime, Docker Compose

**Goal:** Build the Digital Twin Universe (DTU) foundation: twin registry, Docker Compose orchestration, and integration with the scenario runner for external service dependencies.

**Success metric:** Twins run locally via Docker Compose. Scenarios can use twins for external service dependencies. Registry tracks twin metadata.

**Stories: 8**

---

### Story 47-1: Twin Registry — Definition Schema and Storage

**Description:** Define the twin definition format (YAML) and implement the registry that discovers, validates, and stores twin metadata.

**Acceptance Criteria:**

1. **Given** a twin definition YAML file in `.substrate/twins/stripe.yaml` with `name`, `image`, `ports`, `healthcheck`, `environment` fields, **When** `registry.discover('.substrate/twins/')` is called, **Then** the twin is loaded and validated.
2. **Given** a malformed twin definition, **When** validation runs, **Then** a descriptive error identifies the offending field.
3. **Given** the registry, **When** `registry.list()` is called, **Then** all discovered twins are returned with their metadata.
4. **Given** a twin with `healthcheck.url: "http://localhost:4242/health"`, **When** the twin is started, **Then** the registry polls the health endpoint to confirm readiness.

**Files likely touched:**
- `packages/factory/src/twins/registry.ts` (new)
- `packages/factory/src/twins/types.ts` (new)

**Dependencies:** 46-8

---

### Story 47-2: Docker Compose Orchestration

**Description:** Implement twin lifecycle management via Docker Compose: start, stop, health check, and cleanup.

**Acceptance Criteria:**

1. **Given** a set of twin definitions, **When** `twinManager.start(twins)` is called, **Then** a `docker-compose.yml` is generated and `docker compose up -d` is executed.
2. **Given** running twins, **When** `twinManager.stop()` is called, **Then** `docker compose down` is executed and containers are removed.
3. **Given** a twin with a health check, **When** started, **Then** the manager waits for the health check to pass before reporting ready.
4. **Given** Docker is not installed, **When** `twinManager.start()` is called, **Then** a descriptive error is returned ("Docker not found — twins require Docker").
5. **Given** twin startup, **When** the `twin:started` event is emitted, **Then** it contains the twin name, ports, and health status.

**Files likely touched:**
- `packages/factory/src/twins/docker-compose.ts` (new)

**Dependencies:** 47-1

---

### Story 47-3: Twin Integration with Scenario Runner

**Description:** Extend the scenario runner to start required twins before scenario execution and stop them after.

**Acceptance Criteria:**

1. **Given** a scenario manifest that references twins (via `requires_twins: [stripe, sendgrid]` in frontmatter), **When** the runner executes, **Then** the specified twins are started before scenarios run and stopped after.
2. **Given** twins are running, **When** scenario scripts execute, **Then** they can access twin services at the configured ports (e.g., `http://localhost:4242`).
3. **Given** twin startup fails, **When** the runner detects failure, **Then** the scenario run fails with a descriptive error, not a false pass.

**Files likely touched:**
- `packages/factory/src/scenarios/runner.ts` (extend with twin lifecycle)

**Dependencies:** 47-2, 44-2

---

### Story 47-4: Pre-Built Twin Templates (LocalStack, WireMock, Testcontainers)

**Description:** Ship pre-built twin definition templates for common test doubles: LocalStack (AWS), WireMock (HTTP mocks), and generic testcontainers patterns.

**Acceptance Criteria:**

1. **Given** `substrate factory twins init --template localstack`, **When** run, **Then** `.substrate/twins/localstack.yaml` is created with the correct image, ports, and health check for LocalStack.
2. **Given** the WireMock template, **When** initialized, **Then** a working WireMock twin definition is created with stub mapping support.
3. **Given** a list of available templates, **When** `substrate factory twins templates` is run, **Then** it lists available templates with descriptions.

**Files likely touched:**
- `packages/factory/src/twins/templates/` (new — localstack.yaml, wiremock.yaml)
- `src/cli/commands/factory.ts` (extend — twins subcommands)

**Dependencies:** 47-1

---

### Story 47-5: `substrate factory twins` CLI Commands

**Description:** Implement CLI subcommands for managing twins: start, stop, status, list.

**Acceptance Criteria:**

1. **Given** `substrate factory twins start`, **When** run, **Then** all discovered twins are started via Docker Compose.
2. **Given** `substrate factory twins stop`, **When** run, **Then** all running twins are stopped.
3. **Given** `substrate factory twins status`, **When** run, **Then** each twin's name, status (running/stopped), and port mappings are displayed.
4. **Given** `substrate factory twins list`, **When** run, **Then** all discovered twin definitions are listed.

**Files likely touched:**
- `src/cli/commands/factory.ts` (extend — twins subcommands)

**Dependencies:** 47-2

---

### Story 47-6: Twin Health Monitoring During Factory Runs

**Description:** Monitor twin health during factory pipeline execution and fail scenarios early if a twin becomes unhealthy.

**Acceptance Criteria:**

1. **Given** twins are running during a factory run, **When** a twin's health check fails, **Then** the scenario runner detects unhealthy status before executing scenarios.
2. **Given** an unhealthy twin, **When** detected, **Then** the pipeline emits a warning event and optionally retries twin startup before failing.
3. **Given** twin health, **When** monitored, **Then** health checks run at a configurable interval (default 30s) during the pipeline run.

**Files likely touched:**
- `packages/factory/src/twins/health-monitor.ts` (new)

**Dependencies:** 47-3

---

### Story 47-7: DTU Persistence — Twin Run State

**Description:** Persist twin lifecycle state (started, stopped, health checks) to the database for observability.

**Acceptance Criteria:**

1. **Given** a twin starts during a factory run, **When** persisted, **Then** a record in the database captures `twin_name`, `run_id`, `started_at`, `ports`, `status`.
2. **Given** a twin health check fails, **When** persisted, **Then** the failure timestamp and error message are recorded.
3. **Given** `substrate metrics --run <id>`, **When** twins were used, **Then** twin lifecycle information is displayed.

**Files likely touched:**
- `packages/factory/src/twins/persistence.ts` (new)
- `packages/factory/src/persistence/factory-schema.ts` (extend — add twin_runs table)

**Dependencies:** 47-2, 44-6

---

### Story 47-8: DTU Integration Test and Cross-Project Validation

**Description:** End-to-end test of twin lifecycle management and integration with scenario runner on a reference project.

**Acceptance Criteria:**

1. **Given** a test scenario requiring a LocalStack twin, **When** the factory run executes, **Then** LocalStack starts, scenarios run against it, and LocalStack stops after.
2. **Given** the twin health monitor, **When** a twin crashes mid-run, **Then** the pipeline detects the failure and reports it.
3. **Given** the full Epic 47 test suite, **When** run, **Then** at least 40 new tests pass.

**Files likely touched:**
- `packages/factory/src/twins/__tests__/` (new — integration tests)

**Dependencies:** 47-6

---

## Epic 48: Direct API Backend — CodingAgentLoop + UnifiedLLMClient

**Goal:** Implement the `DirectCodergenBackend` per the Coding Agent Loop spec, giving the factory per-turn agent control with loop detection, steering, and output truncation. Build or wrap a Unified LLM Client for multi-provider API access.

**Success metric:** Direct API backend produces same results as CLI backend. Per-turn events visible. Loop detection works. Steering injection works.

**Stories: 13**

---

### Story 48-1: Unified LLM Client — Provider Adapter Interface

**Description:** Define the `ProviderAdapter` interface per Unified LLM Client spec Layer 1, plus shared types (`LLMRequest`, `LLMResponse`, `ToolCall`, `Message`).

**Acceptance Criteria:**

1. **Given** `packages/factory/src/llm/types.ts`, **When** imported, **Then** it exports `ProviderAdapter` interface with `complete(request: LLMRequest): Promise<LLMResponse>` and `stream(request: LLMRequest): AsyncIterable<StreamEvent>` methods.
2. **Given** `LLMRequest`, **When** inspected, **Then** it contains `model`, `messages`, `tools`, `maxTokens`, `temperature`, `systemPrompt`, and provider-specific `extra` escape hatch.
3. **Given** `LLMResponse`, **When** inspected, **Then** it contains `content`, `toolCalls`, `usage`, `model`, `stopReason`, and `providerMetadata`.
4. **Given** `ToolCall`, **When** inspected, **Then** it contains `id`, `name`, `arguments` (parsed JSON).

**Files likely touched:**
- `packages/factory/src/llm/types.ts` (new)

**Dependencies:** 42-15

---

### Story 48-2: Anthropic Provider Adapter

**Description:** Implement the Anthropic `ProviderAdapter` using the Anthropic Messages API with strict message alternation, required `max_tokens`, and explicit `cache_control` for prompt caching.

**Acceptance Criteria:**

1. **Given** an Anthropic adapter configured with `ANTHROPIC_API_KEY`, **When** `complete(request)` is called, **Then** it sends a valid request to the Messages API and returns a normalized `LLMResponse`.
2. **Given** consecutive same-role messages in the request, **When** the adapter processes them, **Then** it merges them before sending (Anthropic requires strict alternation).
3. **Given** `max_tokens` is not set in the request, **When** the adapter sends, **Then** it defaults to 4096 (Anthropic requires this field).
4. **Given** a rate limit error (429), **When** received, **Then** the adapter retries with exponential backoff respecting the `Retry-After` header.
5. **Given** prompt caching, **When** the system prompt is marked cacheable, **Then** `cache_control: { type: "ephemeral" }` is set on the appropriate message block.

**Files likely touched:**
- `packages/factory/src/llm/providers/anthropic.ts` (new)

**Dependencies:** 48-1

---

### Story 48-3: OpenAI Provider Adapter

**Description:** Implement the OpenAI `ProviderAdapter` using the Responses API (not Chat Completions).

**Acceptance Criteria:**

1. **Given** an OpenAI adapter configured with `OPENAI_API_KEY`, **When** `complete(request)` is called, **Then** it sends a valid request to the Responses API and returns a normalized `LLMResponse`.
2. **Given** a system prompt, **When** the adapter sends, **Then** it uses the `instructions` parameter (Responses API).
3. **Given** tool calls in the response, **When** parsed, **Then** each `ToolCall` has a provider-assigned `id`.
4. **Given** prompt caching is automatic for OpenAI, **When** the adapter sends, **Then** no explicit caching headers are needed.

**Files likely touched:**
- `packages/factory/src/llm/providers/openai.ts` (new)

**Dependencies:** 48-1

---

### Story 48-4: Gemini Provider Adapter

**Description:** Implement the Gemini `ProviderAdapter` using the Gemini API with synthetic tool call ID generation.

**Acceptance Criteria:**

1. **Given** a Gemini adapter configured with `GEMINI_API_KEY`, **When** `complete(request)` is called, **Then** it sends a valid request to the Gemini API and returns a normalized `LLMResponse`.
2. **Given** a system prompt, **When** the adapter sends, **Then** it uses the `systemInstruction` field.
3. **Given** tool calls in the response, **When** Gemini does not provide tool call IDs, **Then** the adapter generates synthetic IDs.
4. **Given** prompt caching is automatic for Gemini, **When** the adapter sends, **Then** no explicit caching headers are needed.

**Files likely touched:**
- `packages/factory/src/llm/providers/gemini.ts` (new)

**Dependencies:** 48-1

---

### Story 48-5a: LLM Client Core — Client Routing and Provider Resolution

**Description:** Implement the core `LLMClient` that routes requests to provider adapters by model string, including model-to-provider mapping, adapter registration, and unknown model handling.

**Acceptance Criteria:**

1. **Given** an `LLMClient` with Anthropic and OpenAI adapters registered, **When** `client.complete({model: 'claude-sonnet-4-5', ...})` is called, **Then** it routes to the Anthropic adapter.
2. **Given** `client.complete({model: 'gpt-4o', ...})`, **When** called, **Then** it routes to the OpenAI adapter.
3. **Given** `client.complete({model: 'unknown-model', ...})`, **When** called, **Then** it throws a descriptive error listing registered providers.
4. **Given** a provider adapter, **When** `client.registerProvider('anthropic', adapter)` is called, **Then** the adapter is registered and routes to all `claude-*` model strings.
5. **Given** the client, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding.

**Files likely touched:**
- `packages/factory/src/llm/client.ts` (new)
- `packages/factory/src/llm/model-registry.ts` (new — model-to-provider mapping)

**Dependencies:** 48-2, 48-3, 48-4

---

### Story 48-5b: LLM Client Middleware Chain — Logging, Cost-Tracking, Retry

**Description:** Implement the middleware chain for the `LLMClient`: logging middleware (structured JSON to `{logsRoot}/llm-calls.ndjson`), cost-tracking middleware (integrates with core `CostTracker`), and retry middleware (exponential backoff for retryable errors).

**Acceptance Criteria:**

1. **Given** a middleware chain, **When** a request passes through, **Then** the logging middleware writes a structured JSON line to `{logsRoot}/llm-calls.ndjson` containing: `timestamp`, `model`, `inputTokens`, `outputTokens`, `cost_usd`, `durationMs`, `status` (success/error).
2. **Given** the cost-tracking middleware, **When** a response is received, **Then** it calls `CostTracker.recordCost()` with the token usage and model-specific rates.
3. **Given** a retryable error (429, 500), **When** the adapter throws, **Then** the retry middleware retries with exponential backoff (max 2 retries, 1s base, 2x factor).
4. **Given** a non-retryable error (401, 400), **When** the adapter throws, **Then** no retry is attempted.
5. **Given** the middleware chain, **When** middleware order is `[logging, cost, retry]`, **Then** logging wraps all other middleware (sees retries), cost tracking wraps the retry layer.
6. **Given** the middleware, **When** `npm test` runs, **Then** all unit tests for this story pass before proceeding.

**Files likely touched:**
- `packages/factory/src/llm/middleware/logging.ts` (new)
- `packages/factory/src/llm/middleware/cost-tracking.ts` (new)
- `packages/factory/src/llm/middleware/retry.ts` (new)
- `packages/factory/src/llm/client.ts` (extend with middleware pipeline)

**Dependencies:** 48-5a

---

### Story 48-6: Provider-Aligned Tool Sets

**Description:** Implement provider-specific tool definitions per Coding Agent Loop spec Section 3: Anthropic tools (`edit_file` with old_string/new_string), OpenAI tools (`apply_patch` v4a format), and shared tools (`read_file`, `write_file`, `shell`, `grep`, `glob`).

**Acceptance Criteria:**

1. **Given** an Anthropic provider profile, **When** tools are registered, **Then** `edit_file` uses old_string/new_string exact match semantics.
2. **Given** an OpenAI provider profile, **When** tools are registered, **Then** `apply_patch` uses v4a patch format.
3. **Given** shared tools, **When** `read_file`, `write_file`, `shell`, `grep`, `glob` are registered, **Then** they work identically across providers.
4. **Given** a provider, **When** tool definitions are requested, **Then** each tool has a JSON schema for its parameters and a description.

**Files likely touched:**
- `packages/factory/src/agent/tools/` (new — tool definitions per provider)

**Dependencies:** 48-5b

---

### Story 48-7: Coding Agent Loop — Core Agentic Loop

**Description:** Implement the core agentic loop per Coding Agent Loop spec Section 2: build request, call LLM (single-shot, not SDK loop), execute tool calls, truncate output, loop until natural completion or limit.

**Acceptance Criteria:**

1. **Given** an input prompt, **When** the agent loop runs, **Then** it calls the LLM, receives tool calls, executes them, truncates output, and loops until the LLM returns text-only (natural completion).
2. **Given** `max_tool_rounds_per_input=25`, **When** tool rounds exceed 25, **Then** the loop terminates with round-limit reason.
3. **Given** `max_turns=10`, **When** session turns exceed 10, **Then** the loop terminates with turn-limit reason.
4. **Given** the LLM is called in single-shot mode (not the SDK's built-in tool loop), **When** tool calls are returned, **Then** the agent loop manages tool execution itself — per spec Section 2.

**Files likely touched:**
- `packages/factory/src/agent/loop.ts` (new)

**Dependencies:** 48-5b, 48-6

---

### Story 48-8: Loop Detection and Steering Injection

**Description:** Implement loop detection (tracking tool call signatures) and steering message injection per Coding Agent Loop spec.

**Acceptance Criteria:**

1. **Given** the last 10 tool calls with signatures tracked, **When** a repeating pattern of length 1 (same call 3 times) is detected, **Then** `LOOP_DETECTION` event is emitted and a steering message "Try a different approach" is injected.
2. **Given** a repeating pattern of length 2 (A-B-A-B), **When** detected, **Then** loop detection fires.
3. **Given** `steer(message)`, **When** called, **Then** the message is queued and injected after the current tool round completes as a user-role message.
4. **Given** `follow_up(message)`, **When** called, **Then** the message triggers a new processing cycle after the current input fully completes.

**Files likely touched:**
- `packages/factory/src/agent/loop-detection.ts` (new)
- `packages/factory/src/agent/loop.ts` (integrate detection and steering)

**Dependencies:** 48-7

---

### Story 48-9: Output Truncation (Two-Phase)

**Description:** Implement two-phase output truncation per Coding Agent Loop spec Section 5: Phase 1 character-based (head_tail/tail), Phase 2 line-based.

**Acceptance Criteria:**

1. **Given** tool output of 100K characters with a 10K character limit, **When** Phase 1 truncation runs in `head_tail` mode, **Then** it keeps the first 5K and last 5K characters with a `[... truncated ...]` marker.
2. **Given** Phase 2 with a 500-line limit, **When** applied after Phase 1, **Then** the output is further trimmed to 500 lines.
3. **Given** per-tool truncation defaults (read_file: 50K chars, shell: 10K chars), **When** a tool produces output, **Then** the correct tool-specific limit is applied.
4. **Given** the full untruncated output, **When** the event stream captures it, **Then** the full output is available in events even though the LLM sees truncated version.

**Files likely touched:**
- `packages/factory/src/agent/truncation.ts` (new)

**Dependencies:** 48-7

---

### Story 48-10: DirectCodergenBackend Implementation

**Description:** Implement the `DirectCodergenBackend` that uses the Coding Agent Loop and LLM Client to execute codergen nodes with full per-turn control.

**Acceptance Criteria:**

1. **Given** `DirectCodergenBackend` configured with an `LLMClient` and `ToolRegistry`, **When** `run(node, prompt, context)` is called, **Then** it starts the agent loop with the node's prompt, model, and tools.
2. **Given** the agent loop completes naturally, **When** the result is mapped, **Then** it returns `{status: 'SUCCESS', contextUpdates: {output: ...}}`.
3. **Given** the agent loop exceeds turn limit, **When** the result is mapped, **Then** it returns `{status: 'FAIL', failureReason: 'turn limit exceeded'}`.
4. **Given** per-turn events (`TOOL_CALL_START`, `TOOL_CALL_END`, `LOOP_DETECTION`), **When** the direct backend runs, **Then** these events are emitted on the event bus — providing visibility unavailable with the CLI backend.
5. **Given** backend selection via `backend="direct"` on a node, **When** the codergen handler resolves, **Then** it uses `DirectCodergenBackend`.

**Files likely touched:**
- `packages/factory/src/backend/direct-backend.ts` (new)

**Dependencies:** 48-7, 48-8, 48-9

---

### Story 48-11: Direct vs CLI Backend Parity Test

**Description:** Verify that `DirectCodergenBackend` and `CLICodergenBackend` produce equivalent results for the same prompts and tasks.

**Acceptance Criteria:**

1. **Given** the same prompt and model, **When** dispatched through both CLI and direct backends, **Then** both produce structurally equivalent outcomes (SUCCESS/FAIL with comparable output quality).
2. **Given** a series of codergen tasks, **When** run through both backends, **Then** cost tracking produces comparable token usage (within 20%).
3. **Given** the direct backend, **When** per-turn events are captured, **Then** they provide additional visibility not available from the CLI backend (tool call details, loop detection events).

**Files likely touched:**
- `packages/factory/src/backend/__tests__/parity.test.ts` (new)

**Dependencies:** 48-10, 42-10

---

### Story 48-12: Direct API Backend Cross-Project Validation

**Description:** Run the factory with `DirectCodergenBackend` on a reference project and validate convergence behavior.

**Acceptance Criteria:**

1. **Given** a reference project with scenarios, **When** `substrate factory run --backend direct` completes, **Then** the convergence loop works end-to-end with per-turn visibility.
2. **Given** the per-turn event stream, **When** inspected, **Then** tool calls, loop detections, and steering injections are visible.
3. **Given** the cost comparison, **When** direct backend costs are compared to CLI backend costs for the same stories, **Then** they are within 2x (direct may be lower due to better loop detection).

**Files likely touched:**
- No code changes — validation-only story

**Dependencies:** 48-11

---

## Epic 49: Context Engineering — Pyramid Summaries

**Goal:** Implement reversible multi-level summarization for long-running convergence sessions, addressing context window pressure that accumulates across many iterations.

**Success metric:** Context can be compressed and expanded without information loss. Long convergence loops (10+ iterations) complete without context overflow. Summary quality measured by round-trip accuracy.

**Stories: 8**

---

### Story 49-1: Summary Level Definition and Context Budget

**Description:** Define the summary levels (full, high, medium, low) with token budgets and the interface for reversible summarization.

**Acceptance Criteria:**

1. **Given** the summary levels, **When** defined, **Then** `full` = original content, `high` = 75% token budget, `medium` = 50%, `low` = 25%.
2. **Given** a `SummaryEngine` interface, **When** defined, **Then** it has `summarize(content, targetLevel): Summary` and `expand(summary, targetLevel): string` methods.
3. **Given** a context with 100K tokens, **When** summarized to `medium`, **Then** the summary is approximately 50K tokens.
4. **Given** the summary, **When** `expand(summary, 'full')` is called, **Then** it returns content that preserves all key decisions, code changes, and error messages from the original.

**Files likely touched:**
- `packages/factory/src/context/summary-types.ts` (new)
- `packages/factory/src/context/summary-engine.ts` (new)

**Dependencies:** 46-8

---

### Story 49-2: LLM-Based Summarization with Structural Preservation

**Description:** Implement the summarization algorithm that uses LLM calls to compress content while preserving structural elements (code blocks, file paths, error messages, decisions).

**Acceptance Criteria:**

1. **Given** content with code blocks, file paths, and error messages, **When** summarized to `medium`, **Then** code blocks are preserved verbatim (not paraphrased), file paths are retained, and error messages are kept.
2. **Given** a summarization prompt, **When** sent to the LLM, **Then** it includes instructions to preserve structural elements and key decisions.
3. **Given** the summarized content, **When** round-tripped (summarize then expand), **Then** all file paths and code blocks from the original are recoverable.
4. **Given** summarization cost, **When** measured, **Then** the cost of summarization is less than 10% of the content's original generation cost.

**Files likely touched:**
- `packages/factory/src/context/summarizer.ts` (new)

**Dependencies:** 49-1, 48-5b, 41-6b (Telemetry scoring needed for summary quality metrics)

---

### Story 49-3: Automatic Summary Triggers in Convergence Loops

**Description:** Integrate automatic summarization into the convergence loop when context approaches the model's context window limit.

**Acceptance Criteria:**

1. **Given** a convergence loop iteration, **When** the accumulated context exceeds 80% of the model's context window, **Then** older iterations are automatically summarized to `medium` level.
2. **Given** the current iteration's context, **When** auto-summarization runs, **Then** it is never summarized — only previous iterations are compressed.
3. **Given** summarization occurs, **When** the next iteration runs, **Then** it has access to both the summary and the ability to expand specific sections if needed.
4. **Given** configurable trigger thresholds, **When** `context_summarize_threshold: 0.7` is set, **Then** summarization triggers at 70% capacity.

**Files likely touched:**
- `packages/factory/src/context/auto-summarizer.ts` (new)
- `packages/factory/src/graph/executor.ts` (integrate auto-summarization)

**Dependencies:** 49-2, 45-8

---

### Story 49-4: Summary Storage and Expansion Cache

**Description:** Store summaries in the file-backed run state with expansion capability, implementing a cache to avoid re-summarizing previously summarized content.

**Acceptance Criteria:**

1. **Given** a summarized iteration, **When** stored, **Then** both the summary and the original content hash are saved in `.substrate/runs/{run_id}/summaries/`.
2. **Given** a cached summary, **When** the same content is requested for summarization, **Then** the cache is used instead of making a new LLM call.
3. **Given** `expand(summary)` is called, **When** the original content is available in the run state, **Then** it is returned directly. When not available, an LLM expansion is performed.

**Files likely touched:**
- `packages/factory/src/context/summary-cache.ts` (new)

**Dependencies:** 49-3

---

### Story 49-5: Fidelity Mode Integration with Summaries

**Description:** Connect the Attractor spec's `fidelity` mode attribute with the summary engine so that graph nodes can control their context level.

**Acceptance Criteria:**

1. **Given** a node with `fidelity="summary:medium"`, **When** the node executes, **Then** the context provided to the handler is summarized to medium level.
2. **Given** a node with `fidelity="full"`, **When** executed, **Then** the full context is provided (no summarization).
3. **Given** checkpoint resume, **When** the first resumed node has fidelity degraded to `summary:high`, **Then** the summary engine provides high-level summaries for that node.

**Files likely touched:**
- `packages/factory/src/graph/executor.ts` (integrate fidelity with summary engine)

**Dependencies:** 49-4, 42-13

---

### Story 49-6: Summary Quality Metrics

**Description:** Implement metrics for measuring summary quality: token compression ratio, round-trip preservation score, and key-fact retention rate.

**Acceptance Criteria:**

1. **Given** a summary, **When** metrics are computed, **Then** `compressionRatio = summaryTokens / originalTokens` is reported.
2. **Given** round-trip testing (summarize then expand), **When** key facts are extracted from original and expanded, **Then** `retentionRate = preservedFacts / totalFacts` is computed.
3. **Given** the metrics, **When** persisted, **Then** they are available via `substrate metrics` for analysis.

**Files likely touched:**
- `packages/factory/src/context/summary-metrics.ts` (new)

**Dependencies:** 49-2

---

### Story 49-7: Pyramid Summary CLI Commands

**Description:** Implement CLI commands for manually summarizing content and inspecting summaries.

**Acceptance Criteria:**

1. **Given** `substrate factory context summarize --run <id> --iteration 3 --level medium`, **When** run, **Then** iteration 3's context is summarized to medium level and stored.
2. **Given** `substrate factory context expand --run <id> --iteration 3`, **When** run, **Then** the summary is expanded back to full detail.
3. **Given** `substrate factory context stats --run <id>`, **When** run, **Then** it shows compression ratios and token usage per iteration.

**Files likely touched:**
- `src/cli/commands/factory.ts` (extend — context subcommands)

**Dependencies:** 49-4

---

### Story 49-8: Pyramid Summary Integration Test

**Description:** End-to-end test of summarization in a long convergence loop (10+ iterations).

**Acceptance Criteria:**

1. **Given** a factory pipeline that runs for 10+ iterations, **When** auto-summarization triggers, **Then** all iterations complete without context overflow.
2. **Given** summarized iterations, **When** expanded, **Then** key decisions and code changes from those iterations are recoverable.
3. **Given** the full Epic 49 test suite, **When** run, **Then** at least 40 new tests pass.

**Files likely touched:**
- `packages/factory/src/context/__tests__/` (new — integration tests)

**Dependencies:** 49-5

---

## Epic 50: Advanced Graph — LLM-Evaluated Edges, Parallel Fan-Out/Fan-In, Subgraphs, Model Stylesheet Enhancements

**Goal:** Implement advanced graph features: LLM-evaluated edge conditions, parallel fan-out/fan-in with isolated contexts and join policies, subgraph composition, and model stylesheet enhancements.

**Success metric:** Each new feature has handler, tests, and documentation. Advanced graph features enable novel pipeline architectures not possible with basic graph primitives.

**Stories: 12**

---

### Story 50-1: Parallel Handler — Fan-Out with Isolated Contexts

**Description:** Implement the `parallel` handler (shape=component) that clones context per branch, executes branches concurrently with bounded parallelism, and stores results.

**Acceptance Criteria:**

1. **Given** a parallel node with 3 outgoing branches, **When** the handler executes, **Then** it clones the context for each branch and executes them concurrently.
2. **Given** `max_parallel=2` on the parallel node, **When** 3 branches exist, **Then** at most 2 execute concurrently (third waits for a slot).
3. **Given** branch contexts are isolated, **When** branch A modifies `context.set("key", "A")`, **Then** branch B's context is unaffected.
4. **Given** all branches complete, **When** results are stored, **Then** `context.set("parallel.results", [...])` contains each branch's outcome.
5. **Given** a branch fails, **When** `join_policy="wait_all"`, **Then** all branches must complete before fan-in regardless of individual failures.

**Files likely touched:**
- `packages/factory/src/handlers/parallel.ts` (new)

**Dependencies:** 42-9

---

### Story 50-2: Fan-In Handler — Merge and Best-Candidate Selection

**Description:** Implement the `parallel.fan_in` handler (shape=tripleoctagon) that reads parallel results and selects the best candidate.

**Acceptance Criteria:**

1. **Given** 3 parallel results with statuses `[SUCCESS, FAIL, SUCCESS]`, **When** the fan-in handler executes with heuristic mode, **Then** it selects the first SUCCESS result.
2. **Given** fan-in with `prompt="Select the best implementation"`, **When** executed, **Then** it uses an LLM call to compare candidates and select the winner.
3. **Given** the winner is selected, **When** the handler returns, **Then** the winner's context updates are applied to the main context and recorded in `context.set("parallel.winner", ...)`.
4. **Given** all candidates failed, **When** fan-in executes, **Then** it returns `{status: 'FAIL'}` with details about all failures.

**Files likely touched:**
- `packages/factory/src/handlers/fan-in.ts` (new)

**Dependencies:** 50-1

---

### Story 50-3: Join Policies (wait_all, first_success, quorum)

**Description:** Implement configurable join policies for parallel execution.

**Acceptance Criteria:**

1. **Given** `join_policy="wait_all"`, **When** parallel branches execute, **Then** all branches must complete before fan-in.
2. **Given** `join_policy="first_success"`, **When** any branch completes with SUCCESS, **Then** remaining branches are cancelled and fan-in proceeds with the successful result.
3. **Given** `join_policy="quorum"` with `quorum_size=2`, **When** 2 of 3 branches succeed, **Then** fan-in proceeds with the 2 successful results.
4. **Given** cancellation of remaining branches (first_success policy), **When** branches are cancelled, **Then** any running agent dispatches are killed.

**Files likely touched:**
- `packages/factory/src/handlers/parallel.ts` (extend with join policies)

**Dependencies:** 50-1

---

### Story 50-4: LLM-Evaluated Edge Conditions

**Description:** Implement edge conditions that are evaluated by an LLM call rather than simple string matching. Enables semantic routing decisions.

**Acceptance Criteria:**

1. **Given** an edge with `condition="llm:Is this implementation production-ready?"`, **When** the edge selector encounters it, **Then** it makes an LLM call with the question and the current context, parsing the response as yes/no.
2. **Given** the LLM responds affirmatively, **When** the edge is evaluated, **Then** it is treated as a matching condition.
3. **Given** the LLM responds negatively, **When** evaluated, **Then** it is treated as non-matching.
4. **Given** the `llm:` prefix in the condition, **When** the condition parser encounters it, **Then** it delegates to the LLM evaluator rather than the string-match evaluator.
5. **Given** LLM evaluation cost, **When** tracked, **Then** the cost is added to the node's cost accounting.

**Files likely touched:**
- `packages/factory/src/graph/edge-selector.ts` (extend with LLM evaluation)
- `packages/factory/src/graph/llm-evaluator.ts` (new)

**Dependencies:** 42-12, 48-5b

---

### Story 50-5: Subgraph Support — Graphs Containing Graphs

**Description:** Implement subgraph composition where a node can reference another DOT graph file, enabling composable pipeline libraries.

**Acceptance Criteria:**

1. **Given** a node with `type="subgraph"` and `graph_file="sub-pipeline.dot"`, **When** the handler executes, **Then** it loads, validates, and executes the referenced graph with the current context.
2. **Given** the subgraph completes, **When** it returns an outcome, **Then** the outcome and context updates from the subgraph are merged into the parent graph's context.
3. **Given** a subgraph contains its own goal gates, **When** evaluated, **Then** the subgraph's gates are evaluated independently from the parent graph's gates.
4. **Given** nested subgraphs (subgraph within subgraph), **When** executed, **Then** they work correctly up to a configurable depth limit (default 5).

**Files likely touched:**
- `packages/factory/src/handlers/subgraph.ts` (new)

**Dependencies:** 42-14

---

### Story 50-6: Model Stylesheet — Shape Selectors and Inheritance

**Description:** Extend the model stylesheet with shape-based selectors and inheritance rules for complex pipeline configurations.

**Acceptance Criteria:**

1. **Given** stylesheet `box { llm_model: claude-sonnet-4-5; }`, **When** a node with `shape=box` is resolved, **Then** it inherits `llm_model: claude-sonnet-4-5` (specificity 1, shape selector).
2. **Given** stylesheet with both `box { llm_model: x; }` and `.critical { llm_model: y; }`, **When** a node with `shape=box` and `class=critical` is resolved, **Then** the class rule wins (specificity 2 > 1).
3. **Given** multiple classes on a node (`class="critical,expensive"`), **When** stylesheet rules exist for both classes, **Then** the last matching rule wins (or highest specificity if different).

**Files likely touched:**
- `packages/factory/src/stylesheet/resolver.ts` (extend with shape selectors)

**Dependencies:** 42-7

---

### Story 50-7: Model Stylesheet — Integration with RoutingEngine

**Description:** Wire the model stylesheet into the existing `RoutingEngine` so that stylesheet provides per-node intent and RoutingEngine applies operational constraints.

**Acceptance Criteria:**

1. **Given** a stylesheet resolves `llm_model: claude-opus-4-6` for a node, **When** the `RoutingEngine` processes the request, **Then** it applies subscription-first routing, rate limit checking, and cost optimization on top of the stylesheet's model selection.
2. **Given** a stylesheet specifies a model that is rate-limited, **When** the routing engine evaluates, **Then** it falls back to the next available model in the provider.
3. **Given** the integration, **When** both stylesheet and RoutingPolicy exist, **Then** stylesheet provides intent, RoutingPolicy applies constraints — they compose, not conflict.

**Files likely touched:**
- `packages/factory/src/graph/executor.ts` (wire stylesheet resolver to routing engine)
- `packages/core/src/routing/routing-engine.ts` (extend with stylesheet-resolved model input)

**Dependencies:** 50-6, 41-4

---

### Story 50-8: Manager Loop Handler (stack.manager_loop)

**Description:** Implement the `stack.manager_loop` handler that maps to substrate's existing supervisor pattern: observe child telemetry, optionally steer, evaluate stop condition, loop.

**Acceptance Criteria:**

1. **Given** a node with `type="stack.manager_loop"`, **When** the handler executes, **Then** it starts a supervisor loop that observes child node telemetry.
2. **Given** `max_cycles=10` on the manager node, **When** 10 observation cycles complete, **Then** the loop terminates.
3. **Given** a `stop_condition` attribute, **When** evaluated, **Then** the loop terminates early if the condition is met.
4. **Given** the handler, **When** it observes concerning patterns (stall, high cost), **Then** it can steer child nodes via context updates.

**Files likely touched:**
- `packages/factory/src/handlers/manager-loop.ts` (new)

**Dependencies:** 42-9, 41-7

---

### Story 50-9: Advanced Graph Features — Event Extensions

**Description:** Extend the NDJSON event protocol with events for parallel execution, subgraphs, and LLM-evaluated edges.

**Acceptance Criteria:**

1. **Given** parallel execution, **When** branches start and complete, **Then** `graph:parallel-started`, `graph:parallel-branch-started`, `graph:parallel-branch-completed`, `graph:parallel-completed` events are emitted.
2. **Given** subgraph execution, **When** a subgraph starts and completes, **Then** `graph:subgraph-started` and `graph:subgraph-completed` events are emitted with the subgraph's graph file.
3. **Given** LLM-evaluated edge, **When** evaluated, **Then** `graph:llm-edge-evaluated` event is emitted with the question, answer, and cost.
4. **Given** existing `--events` consumers, **When** advanced events are emitted, **Then** consumers that ignore unknown event types continue to work.

**Files likely touched:**
- `packages/factory/src/events.ts` (extend with advanced events)

**Dependencies:** 50-1, 50-4, 50-5

---

### Story 50-10: Advanced Graph — Pipeline Templates Library

**Description:** Create a library of reusable DOT graph templates: trycycle, dual-review, parallel-exploration, and staged-validation.

**Acceptance Criteria:**

1. **Given** `substrate factory templates list`, **When** run, **Then** it lists available pipeline templates with descriptions.
2. **Given** `substrate factory templates init --template trycycle`, **When** run, **Then** a `pipeline.dot` file is created implementing the Trycycle pattern (define -> plan -> eval_plan -> implement -> eval_impl).
3. **Given** the `dual-review` template, **When** initialized, **Then** it creates a pipeline with parallel code review branches (two independent reviewers) and a fan-in merge.
4. **Given** the `parallel-exploration` template, **When** initialized, **Then** it creates a pipeline with parallel implementation approaches and a fan-in winner selection.

**Files likely touched:**
- `packages/factory/src/templates/` (new — DOT template files)
- `src/cli/commands/factory.ts` (extend — templates subcommand)

**Dependencies:** 50-2, 50-5

---

### Story 50-11: Advanced Graph Integration Tests

**Description:** End-to-end tests for all advanced graph features: parallel fan-out/fan-in, LLM-evaluated edges, subgraphs, and manager loop.

**Acceptance Criteria:**

1. **Given** a graph with parallel fan-out (3 branches), fan-in (best selection), and conditional exit, **When** executed, **Then** the pipeline completes correctly with the best branch selected.
2. **Given** a graph with an LLM-evaluated edge, **When** executed with a mock LLM, **Then** the semantic routing decision is correct.
3. **Given** a graph with a subgraph node, **When** executed, **Then** the subgraph runs and its outcome flows back to the parent.
4. **Given** the full Epic 50 test suite, **When** run, **Then** at least 80 new tests pass.

**Files likely touched:**
- `packages/factory/src/__tests__/advanced-graph.test.ts` (new)

**Dependencies:** 50-1 through 50-9

---

### Story 50-12: Advanced Graph Cross-Project Validation

**Description:** Run a complex factory pipeline (with parallel exploration, subgraphs, and LLM-evaluated edges) on a reference project.

**Acceptance Criteria:**

1. **Given** a reference project, **When** `substrate factory run --graph parallel-explore.dot` is run with 2 parallel implementation branches and a fan-in, **Then** the best implementation is selected and scenarios pass.
2. **Given** the advanced pipeline, **When** cost is compared to a sequential pipeline, **Then** the parallel approach produces results within 3x cost but with higher quality (more scenarios passed).
3. **Given** the full factory system, **When** exercised on a reference project, **Then** convergence rate exceeds 90% for the advanced pipeline.

**Files likely touched:**
- No code changes — validation-only story

**Dependencies:** 50-11

---

# Story Count Summary

| Phase | Epic | Stories |
|-------|------|---------|
| **A** | 40: Monorepo Setup + Interface Definition | 13 |
| **A** | 41: Core Extraction — Implementation Migration | 13 |
| **A** | 42: Graph Engine Foundation | 18 |
| **A** | 43: SDLC Pipeline as Graph | 13 |
| **B** | 44: Scenario Store + Runner | 10 |
| **B** | 45: Convergence Loop | 10 |
| **B** | 46: Satisfaction Scoring | 8 |
| **C** | 47: Digital Twin Foundation | 8 |
| **C** | 48: Direct API Backend | 13 |
| **C** | 49: Context Engineering — Pyramid Summaries | 8 |
| **C** | 50: Advanced Graph | 12 |
| | **Total** | **126** |

---

# Dependency Quick Reference

Stories with external dependencies (must complete before starting):

| Story | Depends On | Reason |
|-------|-----------|--------|
| 41-* | 40-12 | Monorepo must build + shims validated before migration |
| 41-5 | 41-4 | Config depends on routing (serial) |
| 42-* | 40-10 | Factory package must exist |
| 43-* | 41-12, 42-15 | Core extracted + graph engine built |
| 44-* | 42-15 (some), 43-12 | Graph engine operational |
| 45-* | 44-10 | Scenarios working before convergence |
| 46-* | 45-9 | Convergence loop working before scoring |
| 46-5 | 43-5 | Code-Review Handler required for dual-signal mode |
| 47-* | 46-8 | Scoring working before twins |
| 48-* | 42-15 | Graph engine operational for backend |
| 49-2 | 41-6b | Telemetry scoring needed for summary metrics |
| 49-* | 46-8, 48-5b | LLM client needed for summarization |
| 50-* | 42-15 (some), 48-5b (some) | Various graph features |

---

**End of Epics & Stories Document**
