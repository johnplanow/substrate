# Story 41.4: Routing Engine Migration

## Story

As a substrate-core package consumer,
I want `RoutingEngineImpl`, `createRoutingEngine`, `RoutingResolver`, `ProviderStatusTracker`, `RoutingRecommender`, `RoutingTuner`, `RoutingTokenAccumulator`, `RoutingTelemetry`, and all routing utility functions available from `@substrate-ai/core`,
so that downstream packages (`@substrate-ai/sdlc`, `@substrate-ai/factory`) can perform model routing decisions without importing from the monolith's `src/modules/routing/`.

## Acceptance Criteria

### AC1: Implementation files migrated to packages/core/src/routing/
**Given** `packages/core/src/routing/` contains only interface/schema files after story 40-6
**When** story 41-4 is complete
**Then** the following new implementation files exist in `packages/core/src/routing/`: `routing-engine-impl.ts`, `model-routing-resolver.ts`, `model-tier.ts`, `routing-recommender.ts`, `routing-telemetry.ts`, `routing-token-accumulator.ts`, `routing-tuner.ts`; and the following existing files are extended with implementations: `provider-status.ts` (adds `ProviderStatusTracker`), `routing-decision.ts` (adds `makeRoutingDecision`, `RoutingDecisionBuilder`), `routing-policy.ts` (adds `loadRoutingPolicy`), `model-routing-config.ts` (adds `loadModelRoutingConfig`)

### AC2: Duck-typed interfaces decouple RoutingEngineImpl from monolith modules
**Given** `packages/core/src/routing/types.ts` defines `IConfigSystem`, `IMonitorAgent`, and `ITelemetryPersistence` as structural interfaces
**When** `RoutingEngineImpl` is compiled in `packages/core/`
**Then** it has zero imports from `src/modules/config/`, `src/modules/monitor/`, `src/modules/telemetry/`, `src/adapters/`, or `src/utils/`; `ILogger` is imported from `../dispatch/types.js` within the core package; `IAdapterRegistry` is imported from `../dispatch/types.js`

### AC3: packages/core/src/routing/index.ts exports all implementation symbols
**Given** `packages/core/src/routing/index.ts` is updated after migration
**When** code does `import { RoutingEngineImpl, createRoutingEngine, RoutingResolver, ProviderStatusTracker, loadRoutingPolicy, loadModelRoutingConfig, RoutingRecommender, RoutingTuner, RoutingTokenAccumulator, RoutingTelemetry, getModelTier, makeRoutingDecision } from '@substrate-ai/core'`
**Then** all exports resolve and TypeScript compiles without errors

### AC4: Re-export shims at all 14 original src/modules/routing/ paths
**Given** every file in `src/modules/routing/` (`index.ts`, `types.ts`, `routing-decision.ts`, `provider-status.ts`, `model-routing-config.ts`, `routing-policy.ts`, `routing-engine.ts`, `routing-engine-impl.ts`, `model-routing-resolver.ts`, `model-tier.ts`, `routing-recommender.ts`, `routing-telemetry.ts`, `routing-token-accumulator.ts`, `routing-tuner.ts`) is converted to a re-export shim
**When** any existing monolith file imports from those original paths
**Then** the imports resolve correctly and TypeScript compiles without errors; no implementation code remains in `src/modules/routing/`

### AC5: packages/core builds cleanly
**Given** the migration is complete
**When** `tsc -b` is run in `packages/core/`
**Then** it exits with code 0 and zero type errors; no circular dependencies exist within `packages/core/src/routing/`

### AC6: All existing routing tests pass without modification
**Given** the migration is complete and shims are in place
**When** `npm run test:fast` is executed
**Then** all tests in `src/modules/routing/__tests__/` pass without any test file modifications

### AC7: createRoutingEngine factory works end-to-end
**Given** `createRoutingEngine` is imported from `@substrate-ai/core`
**When** called with a `TypedEventBus<CoreEvents>`, an `IAdapterRegistry`, and a valid policy path
**Then** it returns a `RoutingEngine` instance that can route a `RoutingTask` and return a `RoutingDecision` with a non-empty `rationale` field

## Tasks / Subtasks

- [ ] Task 1: Migrate pure utility modules to `packages/core/src/routing/` (AC: #1, #5)
  - [ ] Copy `src/modules/routing/model-tier.ts` to `packages/core/src/routing/model-tier.ts`; update all imports to use `.js` extensions; verify no external dependencies outside node builtins
  - [ ] Copy `src/modules/routing/routing-token-accumulator.ts` to `packages/core/src/routing/routing-token-accumulator.ts`; update imports; replace any `pino.Logger` usage with `ILogger` imported from `../dispatch/types.js`
  - [ ] Extend `packages/core/src/routing/routing-decision.ts` with `makeRoutingDecision` and `RoutingDecisionBuilder` implementations copied from the monolith; update imports to reference local core types

- [ ] Task 2: Extend existing core files with loader functions and ProviderStatusTracker (AC: #1, #3, #5)
  - [ ] Add `ProviderStatusTracker` class implementation to `packages/core/src/routing/provider-status.ts`; the class has no external monolith dependencies (only `node:perf_hooks` or `Date.now()`)
  - [ ] Add `loadRoutingPolicy(policyPath?: string)` function to `packages/core/src/routing/routing-policy.ts`; it uses `node:fs`, `js-yaml`, and the existing Zod schemas already in that file — no new external deps needed
  - [ ] Add `loadModelRoutingConfig(configPath?: string)` function to `packages/core/src/routing/model-routing-config.ts`; same pattern as loadRoutingPolicy

- [ ] Task 3: Define duck-typed interfaces in `packages/core/src/routing/types.ts` (AC: #2, #5)
  - [ ] Add `IConfigSystem` interface capturing only the methods `RoutingEngineImpl` actually calls (e.g., `get(key: string): unknown`)
  - [ ] Add `IMonitorAgent` interface capturing only the methods `RoutingEngineImpl` actually calls (e.g., `getRecommendation(taskId: string): MonitorRecommendation | null`)
  - [ ] Add `ITelemetryPersistence` interface capturing only the methods `RoutingTelemetry` actually calls (e.g., `recordSpan(name: string, attributes: Record<string, unknown>): void`)
  - [ ] Verify `ILogger` and `IAdapterRegistry` are already exported from `packages/core/src/dispatch/types.ts` (from story 41-2); do NOT redefine them

- [ ] Task 4: Migrate `RoutingResolver` to core (AC: #1, #3, #5)
  - [ ] Copy `src/modules/routing/model-routing-resolver.ts` to `packages/core/src/routing/model-routing-resolver.ts`
  - [ ] Replace `import type pino from 'pino'` and `createLogger` with `ILogger` from `../dispatch/types.js`; update constructor to accept `logger?: ILogger` defaulting to `console`
  - [ ] Update all internal imports to use `.js` extensions and local core paths (`./model-routing-config.js`, `./types.js`, etc.)
  - [ ] Note: `TASK_TYPE_PHASE_MAP` already exists in `packages/core/src/routing/routing-engine.ts` from story 40-6; do NOT duplicate it — import from `./routing-engine.js` within the resolver

- [ ] Task 5: Migrate `RoutingTelemetry`, `RoutingRecommender`, `RoutingTuner` to core (AC: #1, #3, #5)
  - [ ] Copy `src/modules/routing/routing-telemetry.ts` to `packages/core/src/routing/routing-telemetry.ts`; replace `ITelemetryPersistence` import with local `./types.js`; replace pino `Logger` with `ILogger` from `../dispatch/types.js`
  - [ ] Copy `src/modules/routing/routing-recommender.ts` to `packages/core/src/routing/routing-recommender.ts`; replace any pino logger or external deps; update all internal imports
  - [ ] Copy `src/modules/routing/routing-tuner.ts` to `packages/core/src/routing/routing-tuner.ts`; replace any external deps; update imports including `getModelTier` from `./model-tier.js`

- [ ] Task 6: Migrate `RoutingEngineImpl` and factory functions to core (AC: #1, #2, #7)
  - [ ] Copy `src/modules/routing/routing-engine-impl.ts` to `packages/core/src/routing/routing-engine-impl.ts`
  - [ ] Replace `import type { TypedEventBus } from '../../core/event-bus.js'` with `import type { TypedEventBus } from '../events/event-bus.js'` (core-local path)
  - [ ] Replace `import type { ConfigSystem }` with `import type { IConfigSystem } from './types.js'`; update constructor parameter type from `ConfigSystem | null` to `IConfigSystem | null`
  - [ ] Replace `import type { AdapterRegistry }` with `import type { IAdapterRegistry } from '../dispatch/types.js'`
  - [ ] Replace `import type { MonitorAgent }` with `import type { IMonitorAgent } from './types.js'`
  - [ ] Replace `createLogger('routing')` with an injected `ILogger` defaulting to `console`; add `logger?: ILogger` to constructor and `RoutingEngineImplOptions`
  - [ ] Add `createRoutingEngine` factory to `packages/core/src/routing/routing-engine.ts` (where it is currently absent after 40-6); if the monolith's `routing-engine.ts` exports `createRoutingEngine` as a thin wrapper around `createRoutingEngineImpl`, replicate that thin wrapper using the same decoupled types

- [ ] Task 7: Update barrel exports (AC: #3, #5)
  - [ ] Rewrite `packages/core/src/routing/index.ts` to export all symbols matching the monolith's `src/modules/routing/index.ts` barrel (implementation symbols now in core, interface symbols already present)
  - [ ] Update `packages/core/src/index.ts` to re-export all new routing implementation symbols (verify the routing namespace is fully included in the top-level barrel)
  - [ ] Run `tsc -b` in `packages/core/` and fix any type errors before proceeding to shim creation

- [ ] Task 8: Create re-export shims for all 14 `src/modules/routing/` files (AC: #4, #6)
  - [ ] Replace each of the 14 files in `src/modules/routing/` with a shim that re-exports from `@substrate-ai/core`
  - [ ] For files that export both types and values (e.g., `routing-engine-impl.ts`, `provider-status.ts`), use `export type { ... }` and `export { ... }` patterns — do not use `export * from` when it would re-export conflicting names
  - [ ] For `index.ts` in `src/modules/routing/`: replace with a full passthrough shim re-exporting all names from `@substrate-ai/core` that the monolith's original index exported
  - [ ] Run `npm run test:fast` and confirm zero regressions; address any import resolution failures in the test suite before marking complete

## Dev Notes

### Architecture Constraints
- **ESM `.js` imports**: All intra-package imports in `packages/core/src/` must use `.js` extensions (e.g., `import { ILogger } from '../dispatch/types.js'`)
- **No imports from `src/` in `packages/core/`**: The core package must be self-contained; all monolith dependencies must be replaced with local duck-typed interfaces
- **ILogger and IAdapterRegistry**: Already exported from `@substrate-ai/core` via `packages/core/src/dispatch/types.ts` (story 41-2); import within core via `../dispatch/types.js`
- **TASK_TYPE_PHASE_MAP**: Already defined in `packages/core/src/routing/routing-engine.ts` (story 40-6); do NOT duplicate — import from `./routing-engine.js`
- **Zero behavioral change**: All implementation logic must be identical to the monolith's version; the only changes are import path updates and dependency injection refactoring
- **js-yaml is already a dependency of packages/core** (added in story 41-2); no new package.json changes needed for `loadRoutingPolicy` / `loadModelRoutingConfig`
- **Depends on 41-1 (EventBus)** and **40-6 (Routing Interfaces)**: both must be complete before starting this story

### Dependency Injection Pattern for RoutingEngineImpl
The monolith's `RoutingEngineImpl` constructor uses:
```typescript
// BEFORE (monolith)
constructor(
  eventBus: TypedEventBus,           // from src/core/event-bus.ts
  configSystem?: ConfigSystem | null, // from src/modules/config/config-system.ts
  adapterRegistry?: AdapterRegistry | null, // from src/adapters/adapter-registry.ts
)
```

After migration, the core constructor signature becomes:
```typescript
// AFTER (packages/core)
export interface RoutingEngineImplOptions {
  eventBus: TypedEventBus<CoreEvents>
  configSystem?: IConfigSystem | null
  adapterRegistry?: IAdapterRegistry | null
  monitorAgent?: IMonitorAgent | null
  logger?: ILogger
}

export class RoutingEngineImpl implements RoutingEngine {
  constructor(options: RoutingEngineImplOptions) { ... }
  // OR retain positional args matching monolith for shim compatibility:
  constructor(
    eventBus: TypedEventBus<CoreEvents>,
    configSystem?: IConfigSystem | null,
    adapterRegistry?: IAdapterRegistry | null,
    logger?: ILogger,
  ) { ... }
}
```

Check the actual monolith source to determine which constructor style is used by callers; preserve backward compatibility in the shim.

### Re-Export Shim Pattern
```typescript
// src/modules/routing/routing-engine-impl.ts (shim)
export {
  RoutingEngineImpl,
  createRoutingEngineImpl,
} from '@substrate-ai/core'
export type { RoutingEngineImplOptions } from '@substrate-ai/core'
```

```typescript
// src/modules/routing/index.ts (shim — passthrough)
export {
  RoutingEngineImpl,
  createRoutingEngineImpl,
  createRoutingEngine,
  RoutingResolver,
  ProviderStatusTracker,
  loadRoutingPolicy,
  loadModelRoutingConfig,
  RoutingRecommender,
  RoutingTuner,
  RoutingTokenAccumulator,
  RoutingTelemetry,
  getModelTier,
  makeRoutingDecision,
  RoutingDecisionBuilder,
  RoutingPolicySchema,
  RoutingPolicyValidationError,
  ModelRoutingConfigSchema,
  RoutingConfigError,
  TASK_TYPE_PHASE_MAP,
} from '@substrate-ai/core'
export type {
  RoutingEngine,
  RoutingEngineOptions,
  RoutingEngineImplOptions,
  RoutingDecision,
  ProviderStatus,
  RoutingPolicy,
  ProviderPolicy,
  TaskTypePolicy,
  DefaultRoutingPolicy,
  ApiBillingConfig,
  RateLimitConfig,
  ModelRoutingConfig,
  ModelPhaseConfig,
  ModelResolution,
  PhaseTokenEntry,
  PhaseTokenBreakdown,
  RoutingRecommendation,
  RoutingAnalysis,
  TuneLogEntry,
} from '@substrate-ai/core'
```

### Testing Requirements
- Run `npm run test:fast` after Task 7 (before shims) to confirm the core package builds
- Run `npm run test:fast` after Task 8 (shims in place) to confirm zero regressions
- The `__tests__/` directory in `src/modules/routing/` must NOT be modified — tests run against the shims and must pass unmodified
- If pino logger is used in tests (e.g., `createLogger` is imported and tested), the test may need the `ILogger` → pino bridging; resolve by ensuring shims export a `createLogger` adapter or that tests import from the monolith's `src/utils/logger.js` (which is not shimmed in this story)

## Interface Contracts

- **Export**: `RoutingEngineImpl`, `createRoutingEngine`, `createRoutingEngineImpl` @ `packages/core/src/routing/routing-engine-impl.ts` (consumed by stories 43-x, SDLC graph setup)
- **Export**: `RoutingResolver` @ `packages/core/src/routing/model-routing-resolver.ts` (consumed by story 41-5, config system migration)
- **Export**: `ProviderStatusTracker` @ `packages/core/src/routing/provider-status.ts`
- **Export**: `loadRoutingPolicy`, `loadModelRoutingConfig` @ `packages/core/src/routing/` (consumed by story 41-5)
- **Export**: `RoutingRecommender`, `RoutingTuner`, `RoutingTokenAccumulator`, `RoutingTelemetry`, `getModelTier` @ `packages/core/src/routing/`
- **Import**: `TypedEventBus<CoreEvents>` @ `packages/core/src/events/event-bus.ts` (from story 41-1)
- **Import**: `ILogger`, `IAdapterRegistry` @ `packages/core/src/dispatch/types.ts` (from story 41-2)
- **Import**: `RoutingEngine`, `IRoutingResolver`, `RoutingTask`, `ModelResolution`, `TASK_TYPE_PHASE_MAP` @ `packages/core/src/routing/routing-engine.ts` (from story 40-6)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
