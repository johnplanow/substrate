# Story 40.6: Routing Interface Extraction

## Story

As a substrate-core package consumer,
I want `RoutingEngine`, `RoutingDecision`, `ProviderStatus`, `IRoutingResolver`, `ModelRoutingConfig`, and `RoutingPolicy` defined in `packages/core/src/routing/`,
so that downstream packages can depend on a stable, type-safe routing contract without importing from the monolith `src/modules/routing/`.

## Acceptance Criteria

### AC1: Routing Token Analysis Types File Created with All Required Exports
**Given** the `packages/core/src/routing/` directory is created
**When** `packages/core/src/routing/types.ts` is imported
**Then** it exports `PhaseTokenEntry`, `PhaseTokenBreakdown`, `RoutingRecommendation`, `RoutingAnalysis`, and `TuneLogEntry` as pure TypeScript interfaces with no external package dependencies

### AC2: RoutingDecision Interface Exported with Correct Field Shape
**Given** `packages/core/src/routing/routing-decision.ts`
**When** the `RoutingDecision` interface is compared field-by-field to the monolith `src/modules/routing/routing-decision.ts`
**Then** it contains `taskId: string`, `agent: string`, `billingMode: 'subscription' | 'api' | 'unavailable'`, `model?: string`, `rationale: string`, `fallbackChain?: string[]`, `estimatedCostUsd?: number`, `rateLimit?: { tokensUsedInWindow: number; limit: number }`, `monitorRecommendation?: MonitorRecommendation`, and `monitorInfluenced: boolean`; and `MonitorRecommendation` is defined locally as a minimal interface (no monitor module import)

### AC3: ProviderStatus Interface Exported with Correct Field Shape
**Given** `packages/core/src/routing/provider-status.ts`
**When** the `ProviderStatus` interface is compared field-by-field to the monolith `src/modules/routing/provider-status.ts`
**Then** it contains `provider: string`, `subscriptionRoutingEnabled: boolean`, `apiBillingEnabled: boolean`, `tokensUsedInWindow: number`, `windowResetAtMs: number`, and `rateLimit: { tokensPerWindow: number; windowSeconds: number }` — fully self-contained with no external dependencies

### AC4: ModelRoutingConfig Zod Schema and TypeScript Type Exported
**Given** `packages/core/src/routing/model-routing-config.ts`
**When** `ModelRoutingConfigSchema` and `ModelRoutingConfig` are imported
**Then** the schema enforces `version: 1` (literal), `phases` with optional `explore`/`generate`/`review` sub-objects each containing `model` (regex-validated string) and optional `max_tokens`, `baseline_model` (regex-validated string), optional `overrides` record, and optional `auto_tune` boolean; and `RoutingConfigError` is exported as an `Error` subclass with a `code` field typed as `'CONFIG_NOT_FOUND' | 'INVALID_YAML' | 'SCHEMA_INVALID'`

### AC5: RoutingPolicy Zod Schema and TypeScript Type Exported
**Given** `packages/core/src/routing/routing-policy.ts`
**When** `RoutingPolicySchema` and `RoutingPolicy` are imported
**Then** the schema enforces a `default` block (preferred_agents, billing_preference enum, use_monitor_recommendations), optional `task_types` record (per-type preferred_agents and model_preferences), a `providers` record requiring at least one entry (each with enabled, cli_path, subscription_routing, max_concurrent, optional rate_limit and api_billing sub-objects), and optional `global` block (max_concurrent_workers, fallback_enabled); and `RoutingPolicyValidationError` is exported as an `Error` subclass

### AC6: IRoutingResolver Interface, ModelResolution Interface, and RoutingEngine Interface Exported
**Given** `packages/core/src/routing/routing-engine.ts`
**When** `IRoutingResolver`, `ModelResolution`, `RoutingTask`, and `RoutingEngine` are imported
**Then** `RoutingTask` has `id: string` and `type: string`; `ModelResolution` has `model: string`, `maxTokens?: number`, `phase: string`, and `source: 'phase' | 'override'`; `IRoutingResolver` has `resolveModel(taskType: string): ModelResolution | null`; `RoutingEngine` has `routeTask(task: RoutingTask): RoutingDecision`, `getProviderStatus(provider: string): ProviderStatus | null`, `updateRateLimit(provider: string, tokensUsed: number): void`, and `reloadPolicy(): Promise<void>`; and `TASK_TYPE_PHASE_MAP` is exported as a `Record<string, 'explore' | 'generate' | 'review'>` constant

### AC7: Barrel Exports from `routing/index.ts` and Core Root; TypeScript Compilation Succeeds
**Given** all routing type files are created
**When** `packages/core/src/routing/index.ts` and `packages/core/src/index.ts` are updated
**Then** all routing symbols are importable from `@substrate-ai/core`; and `npm run build` inside `packages/core/` exits with code 0 and emits artifacts to `packages/core/dist/routing/`

## Tasks / Subtasks

- [x] Task 1: Create `packages/core/src/routing/types.ts` with token analysis types (AC: #1)
  - [x] Read `src/modules/routing/types.ts` to copy `PhaseTokenEntry`, `PhaseTokenBreakdown`, `RoutingRecommendation`, `RoutingAnalysis`, and `TuneLogEntry` verbatim; preserve all JSDoc comments
  - [x] Confirm no external package dependencies — these are pure TypeScript interface and object-literal types only
  - [x] Add file-level JSDoc: "Routing token analysis and telemetry types — interface definitions only, no implementations"

- [x] Task 2: Create `packages/core/src/routing/routing-decision.ts` with RoutingDecision interface (AC: #2)
  - [x] Read `src/modules/routing/routing-decision.ts` and copy the `RoutingDecision` interface field-by-field; preserve JSDoc
  - [x] Define `MonitorRecommendation` as a minimal local interface (`model?: string; rationale?: string; confidence?: number`) so that `monitorRecommendation?: MonitorRecommendation` avoids importing the monitor module into core
  - [x] Confirm no external package imports are required

- [x] Task 3: Create `packages/core/src/routing/provider-status.ts` with ProviderStatus interface (AC: #3)
  - [x] Read `src/modules/routing/provider-status.ts` and copy the `ProviderStatus` interface field-by-field; preserve JSDoc
  - [x] Confirm the file is fully self-contained with no external dependencies

- [x] Task 4: Create `packages/core/src/routing/model-routing-config.ts` with Zod schema and type (AC: #4)
  - [x] Verify `zod` is listed as a real dependency (not devDependency) in `packages/core/package.json`; add it if missing (was added in story 40-4 — verify before adding)
  - [x] Read `src/modules/routing/model-routing-config.ts` and copy `ModelPhaseConfigSchema`, `ModelRoutingConfigSchema`, their inferred types, and `RoutingConfigError` verbatim
  - [x] Replace `extends SubstrateError` with `extends Error` and add `readonly code: 'CONFIG_NOT_FOUND' | 'INVALID_YAML' | 'SCHEMA_INVALID'` field — core package must not import monolith error classes
  - [x] Use `import { z } from 'zod'` (no `.js` extension needed for node_modules)

- [x] Task 5: Create `packages/core/src/routing/routing-policy.ts` with RoutingPolicy Zod schemas (AC: #5)
  - [x] Read `src/modules/routing/routing-policy.ts` and copy all Zod schemas (`ApiBillingConfigSchema`, `RateLimitConfigSchema`, `ProviderPolicySchema`, `TaskTypePolicySchema`, `DefaultRoutingPolicySchema`, `GlobalRoutingSettingsSchema`, `RoutingPolicySchema`) and their inferred types verbatim; preserve JSDoc
  - [x] Copy `RoutingPolicyValidationError` class, replacing any monolith base class with `extends Error`
  - [x] Do NOT copy `loadRoutingPolicy()` factory function — that is a concrete implementation belonging in Epic 41

- [x] Task 6: Create `packages/core/src/routing/routing-engine.ts` with resolver and engine interfaces (AC: #6)
  - [x] Read `src/modules/routing/routing-engine.ts` and `src/modules/routing/model-routing-resolver.ts` to extract interface shapes
  - [x] Define `RoutingTask { id: string; type: string }` as the minimal task shape needed for routing decisions (structural subtype of the monolith `TaskNode`)
  - [x] Define `ModelResolution { model: string; maxTokens?: number; phase: string; source: 'phase' | 'override' }` verbatim from `model-routing-resolver.ts`
  - [x] Define `IRoutingResolver { resolveModel(taskType: string): ModelResolution | null }` as a local interface (do NOT import the concrete `RoutingResolver` class from the monolith)
  - [x] Define `RoutingEngine` interface with `routeTask`, `getProviderStatus`, `updateRateLimit`, and `reloadPolicy` — import `RoutingDecision` from `'./routing-decision.js'` and `ProviderStatus` from `'./provider-status.js'` using ESM `.js` extensions
  - [x] Copy `TASK_TYPE_PHASE_MAP` constant from `src/modules/routing/model-routing-resolver.ts` verbatim
  - [x] Do NOT import `BaseService`, `ConfigSystem`, `AdapterRegistry`, or any other monolith concrete types; do NOT import from `packages/core/src/events/` (RoutingEngine interface has no EventBus in its method signatures)

- [x] Task 7: Create `packages/core/src/routing/index.ts` barrel export (AC: #7)
  - [x] Create barrel re-exporting all symbols from each file: `export * from './types.js'`, `export * from './routing-decision.js'`, `export * from './provider-status.js'`, `export * from './model-routing-config.js'`, `export * from './routing-policy.js'`, `export * from './routing-engine.js'`
  - [x] Confirm no naming conflicts between the six source files before creating the barrel

- [x] Task 8: Update `packages/core/src/index.ts` and verify compilation (AC: #7)
  - [x] Add `export * from './routing/index.js'` to `packages/core/src/index.ts`; verify no naming conflicts with existing `events`, `dispatch`, and `persistence` barrel exports
  - [x] Run `npx tsc -b packages/core --force` and confirm exit code 0
  - [x] Confirm `packages/core/dist/routing/` directory is populated with `.js` and `.d.ts` files
  - [x] Fix any compilation errors (e.g., missing `.js` extension on intra-package imports) before marking done

## Dev Notes

### Architecture Constraints
- **INTERFACE DEFINITION ONLY** — do NOT modify any files under `src/modules/routing/` or any other monolith source. This story defines new interfaces in `packages/core/`; implementations are migrated in Epic 41.
- **ESM imports** — all intra-package imports must use `.js` extensions (e.g., `import { RoutingDecision } from './routing-decision.js'`). Node_modules imports like `zod` do not need `.js` extensions.
- **No monolith imports** — `packages/core/` must never import from `../../src/` or any relative path outside `packages/`. Define local minimal interfaces (`MonitorRecommendation`, `RoutingTask`) where the monolith type is too complex or would create a dependency.
- **No circular dependencies** — `packages/core/src/routing/` files may import from each other (e.g., `routing-engine.ts` imports `RoutingDecision` and `ProviderStatus`), but must not import from `packages/core/src/events/` or `packages/core/src/persistence/`. Routing is self-contained within its subdirectory.
- **Zod is a real dependency** — `zod` must be listed in `dependencies` (not `devDependencies`) in `packages/core/package.json`. Story 40-4 was expected to add it; verify with `cat packages/core/package.json` before adding to avoid duplicate entries.
- **Copy verbatim** — copy all Zod schemas and interface shapes exactly from the monolith source files rather than summarizing or paraphrasing. Structural identity is the goal so Epic 41's shim layer works without type mismatches.
- **RoutingConfigError and RoutingPolicyValidationError** — in the monolith these extend `SubstrateError`. In core they must extend plain `Error` and add the typed `code` field manually. Do NOT import `SubstrateError` from the monolith.
- **Do not copy factory functions** — `loadRoutingPolicy()`, `loadModelRoutingConfig()`, `createRoutingEngine()`, and `RoutingResolver.createWithFallback()` are concrete implementations with filesystem/YAML dependencies. They belong in Epic 41's implementation migration, not here.
- **Do not copy implementation classes** — `RoutingEngineImpl`, `ProviderStatusTracker`, `RoutingDecisionBuilder`, `RoutingTelemetry`, `RoutingTokenAccumulator`, `RoutingRecommender`, and `RoutingTuner` are concrete classes. Define only the interfaces and static data they expose to consumers.

### Key Files to Read Before Starting
- `src/modules/routing/types.ts` — `PhaseTokenEntry`, `PhaseTokenBreakdown`, `RoutingRecommendation`, `RoutingAnalysis`, `TuneLogEntry`
- `src/modules/routing/routing-decision.ts` — `RoutingDecision` interface and `Recommendation` import to understand what `monitorRecommendation` needs
- `src/modules/routing/provider-status.ts` — `ProviderStatus` interface
- `src/modules/routing/model-routing-config.ts` — `ModelPhaseConfigSchema`, `ModelRoutingConfigSchema`, `RoutingConfigError`
- `src/modules/routing/routing-policy.ts` — all policy Zod schemas and `RoutingPolicyValidationError`
- `src/modules/routing/routing-engine.ts` — `RoutingEngine` interface
- `src/modules/routing/model-routing-resolver.ts` — `ModelResolution`, `RoutingResolver`, `TASK_TYPE_PHASE_MAP`
- `packages/core/package.json` — verify `zod` dependency before adding
- `packages/core/src/index.ts` — barrel to update (confirm existing exports from events, dispatch, persistence)

### Target File Structure
```
packages/core/src/routing/
├── types.ts                 # PhaseTokenEntry, PhaseTokenBreakdown, RoutingRecommendation, RoutingAnalysis, TuneLogEntry
├── routing-decision.ts      # MonitorRecommendation (local minimal), RoutingDecision
├── provider-status.ts       # ProviderStatus
├── model-routing-config.ts  # ModelPhaseConfig, ModelRoutingConfig (Zod), RoutingConfigError
├── routing-policy.ts        # ApiBillingConfig, RateLimitConfig, ProviderPolicy, TaskTypePolicy,
│                            # DefaultRoutingPolicy, GlobalRoutingSettings, RoutingPolicy (Zod),
│                            # RoutingPolicyValidationError
├── routing-engine.ts        # RoutingTask, ModelResolution, IRoutingResolver, RoutingEngine,
│                            # TASK_TYPE_PHASE_MAP
└── index.ts                 # Barrel: export * from each file above
```

### Interface Shapes Reference

```typescript
// routing/types.ts — pure types, no imports required
export interface PhaseTokenEntry {
  phase: 'explore' | 'generate' | 'review' | 'default'
  model: string
  inputTokens: number
  outputTokens: number
  dispatchCount: number
}

export interface PhaseTokenBreakdown {
  entries: PhaseTokenEntry[]
  baselineModel: string
  runId: string
}

export interface RoutingRecommendation {
  phase: string
  currentModel: string
  suggestedModel: string
  estimatedSavingsPct: number
  confidence: number
  dataPoints: number
  direction: 'upgrade' | 'downgrade'
}

export interface RoutingAnalysis {
  recommendations: RoutingRecommendation[]
  analysisRuns: number
  insufficientData: boolean
  phaseOutputRatios: Record<string, number>
}

export interface TuneLogEntry {
  id: string
  runId: string
  phase: string
  oldModel: string
  newModel: string
  estimatedSavingsPct: number
  appliedAt: string
}

// routing/routing-decision.ts — no imports required
export interface MonitorRecommendation {
  model?: string
  rationale?: string
  confidence?: number
}

export interface RoutingDecision {
  taskId: string
  agent: string
  billingMode: 'subscription' | 'api' | 'unavailable'
  model?: string
  rationale: string
  fallbackChain?: string[]
  estimatedCostUsd?: number
  rateLimit?: { tokensUsedInWindow: number; limit: number }
  monitorRecommendation?: MonitorRecommendation
  monitorInfluenced: boolean
}

// routing/provider-status.ts — no imports required
export interface ProviderStatus {
  provider: string
  subscriptionRoutingEnabled: boolean
  apiBillingEnabled: boolean
  tokensUsedInWindow: number
  windowResetAtMs: number
  rateLimit: { tokensPerWindow: number; windowSeconds: number }
}

// routing/routing-engine.ts
import type { RoutingDecision } from './routing-decision.js'
import type { ProviderStatus } from './provider-status.js'

export interface RoutingTask {
  id: string
  type: string
}

export interface ModelResolution {
  model: string
  maxTokens?: number
  phase: string
  source: 'phase' | 'override'
}

export interface IRoutingResolver {
  resolveModel(taskType: string): ModelResolution | null
}

export interface RoutingEngine {
  routeTask(task: RoutingTask): RoutingDecision
  getProviderStatus(provider: string): ProviderStatus | null
  updateRateLimit(provider: string, tokensUsed: number): void
  reloadPolicy(): Promise<void>
}

export const TASK_TYPE_PHASE_MAP: Record<string, 'explore' | 'generate' | 'review'>
```

### Testing Requirements
- This story produces only TypeScript type definitions, Zod schemas, and one small constant — no complex runtime behavior
- No unit tests are needed for pure interface/type/schema declarations
- Verification is done by TypeScript compilation: `npx tsc -b packages/core --force` must exit 0
- Do NOT run the full monorepo test suite (`npm test`) — only the core package build needs to pass for this story
- AC2 and AC3 (adapter interfaces satisfy monolith shapes) are verified structurally — TypeScript will enforce this when Epic 41 adds re-export shims
- Zod schema correctness is verified by the schema's own compile-time inference (the `z.infer<>` types validate schema structure at compile time)

## Interface Contracts

- **Export**: `RoutingDecision` @ `packages/core/src/routing/routing-decision.ts` (consumed by story 40-6 routing-engine.ts, and by dispatcher stories in Epic 41)
- **Export**: `ProviderStatus` @ `packages/core/src/routing/provider-status.ts` (consumed by story 40-6 routing-engine.ts and monitor integration stories)
- **Export**: `ModelRoutingConfig` @ `packages/core/src/routing/model-routing-config.ts` (consumed by stories 40-8, 40-9, and routing migration stories in Epic 41)
- **Export**: `RoutingPolicy` @ `packages/core/src/routing/routing-policy.ts` (consumed by Epic 41's routing engine implementation migration)
- **Export**: `RoutingEngine` @ `packages/core/src/routing/routing-engine.ts` (consumed by Epic 41's `createRoutingEngine()` factory migration)
- **Export**: `IRoutingResolver` @ `packages/core/src/routing/routing-engine.ts` (consumed by Epic 41's `RoutingResolver` class migration; replaces direct class import)
- **Export**: `PhaseTokenBreakdown`, `TuneLogEntry` @ `packages/core/src/routing/types.ts` (consumed by story 40-8 telemetry interfaces and Epic 41 routing telemetry migration)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All 6 routing type files created under `packages/core/src/routing/` with pure interface/schema definitions and no monolith imports
- `RoutingConfigError` and `RoutingPolicyValidationError` extend plain `Error` (not `SubstrateError`) with typed `code` fields
- `MonitorRecommendation` and `RoutingTask` defined as minimal local interfaces to avoid importing monitor/task-node types
- `zod` confirmed as real dependency in `packages/core/package.json` (added in story 40-4)
- `packages/core/package.json` updated to add `"scripts": { "build": "tsc -b" }` so `npm run build` works
- `RoutingRateLimitConfig` alias export added to `packages/core/src/index.ts` so routing's RateLimitConfig is discoverable by name from the public API
- `npx tsc -b packages/core --force` exits 0; `packages/core/dist/routing/` populated with all `.js` and `.d.ts` files

### File List
- `packages/core/src/routing/types.ts` (created)
- `packages/core/src/routing/routing-decision.ts` (created)
- `packages/core/src/routing/provider-status.ts` (created)
- `packages/core/src/routing/model-routing-config.ts` (created)
- `packages/core/src/routing/routing-policy.ts` (created)
- `packages/core/src/routing/routing-engine.ts` (created)
- `packages/core/src/routing/index.ts` (created)
- `packages/core/src/index.ts` (updated — added routing barrel + RoutingRateLimitConfig alias)
- `packages/core/package.json` (updated — added scripts.build)

## Change Log

- 2026-03-22: Story created for Epic 40 (Core Extraction Phase 1)
