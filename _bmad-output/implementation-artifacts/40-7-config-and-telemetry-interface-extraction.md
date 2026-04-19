# Story 40.7: Config and Telemetry Interface Extraction

## Story

As a substrate-core package consumer,
I want `SubstrateConfig`, `ConfigSystem`, `ITelemetryPersistence`, `ITelemetryPipeline`, and all supporting config and telemetry data types defined in `@substrate-ai/core`,
so that other packages can depend on stable, package-agnostic config and telemetry contracts without importing from the monolith.

## Acceptance Criteria

### AC1: Config Zod Schemas and TypeScript Types Defined
**Given** the config source is at `src/modules/config/config-schema.ts`
**When** `packages/core/src/config/types.ts` is created
**Then** it defines Zod schemas and inferred TypeScript types for `SubstrateConfig` (without the `token_ceilings` field), `GlobalSettings`, `ProviderConfig`, `ProvidersConfig`, `BudgetConfig`, `CostTrackerConfig`, `TelemetryConfig`, and `RateLimitConfig` — matching all field names, types, validation constraints, and JSDoc comments from the source

### AC2: ConfigSystem and ConfigSystemOptions Interfaces Defined
**Given** the interface is in `src/modules/config/config-system.ts`
**When** `ConfigSystem` and `ConfigSystemOptions` are added to `packages/core/src/config/types.ts`
**Then** `ConfigSystem` exposes all 8 members with identical signatures: `load(): Promise<void>`, `getConfig(): SubstrateConfig`, `get(key: string): unknown`, `set(key: string, value: unknown): Promise<void>`, `getMasked(): SubstrateConfig`, `isLoaded: boolean`, `getConfigFormatVersion(): string`, `isCompatible(version: string): boolean`

### AC3: Telemetry Data Types and Zod Schemas Defined
**Given** telemetry types are in `src/modules/telemetry/types.ts`
**When** `packages/core/src/telemetry/types.ts` is created
**Then** it defines all telemetry data types: `NormalizedSpan`, `NormalizedLog`, `TokenCounts`, `TurnAnalysis` (with Zod schema), `EfficiencyScore` (with Zod schema), `Recommendation` (with Zod schema), `CategoryStats`, `ConsumerStats`, `EfficiencyProfile` and all supporting types (`SemanticCategory`, `RuleId`, `RecommendationSeverity`, `ChildSpanSummary`, `TopInvocation`, `ModelEfficiency`, `SourceEfficiency`)

### AC4: ITelemetryPersistence Interface Defined
**Given** the concrete persistence class is `TelemetryPersistence` in `src/modules/telemetry/`
**When** `ITelemetryPersistence` is added to `packages/core/src/telemetry/types.ts`
**Then** it declares all 5 persistence write methods with signatures matching the existing `TelemetryPersistence` class: `storeTurnAnalysis()`, `storeEfficiencyScore()`, `storeCategoryStats()`, `storeConsumerStats()`, `saveRecommendations()`

### AC5: ITelemetryPipeline Interface and RawOtlpPayload Type Defined
**Given** the pipeline class is in `src/modules/telemetry/telemetry-pipeline.ts`
**When** `ITelemetryPipeline` and `RawOtlpPayload` are added to `packages/core/src/telemetry/types.ts`
**Then** `ITelemetryPipeline` exposes `processBatch(items: RawOtlpPayload[]): Promise<void>` and `RawOtlpPayload` matches the source type definition (including optional `dispatchContext` and `storyKey` fields)

### AC6: Barrel Exports and Root Integration
**Given** both new module directories are created
**When** `packages/core/src/config/index.ts` and `packages/core/src/telemetry/index.ts` are created and `packages/core/src/index.ts` is updated
**Then** all types, interfaces, and Zod schemas from both modules are importable from `@substrate-ai/core` with no name collisions against existing event, dispatch, or persistence exports

### AC7: TypeScript Compilation Succeeds with Zero Errors
**Given** all new files are created with correct ESM `.js` extension imports
**When** `tsc --build packages/core` is run from the repository root
**Then** it exits 0 with zero TypeScript errors and emits declaration files to `packages/core/dist/config/` and `packages/core/dist/telemetry/`

## Tasks / Subtasks

- [ ] Task 1: Create `packages/core/src/config/types.ts` with Zod schemas and config interfaces (AC: #1, #2)
  - [ ] Read `src/modules/config/config-schema.ts` — copy all Zod schema definitions verbatim; preserve JSDoc comments
  - [ ] Read `src/modules/config/config-system.ts` — copy `ConfigSystem` and `ConfigSystemOptions` interface definitions verbatim
  - [ ] Define `SubstrateConfig` schema omitting the `token_ceilings` field (SDLC-specific; excluded from core)
  - [ ] Add a file-level JSDoc comment noting that `TokenCeilings` / `token_ceilings` is intentionally excluded — the SDLC package extends this in a future story
  - [ ] Use `zod` for schemas (already a dependency of `packages/core`); use ESM `.js` extension on all relative imports

- [ ] Task 2: Create `packages/core/src/config/index.ts` barrel export (AC: #6)
  - [ ] Export all symbols from `./types.js` (Zod schemas, inferred types, `ConfigSystem`, `ConfigSystemOptions`)
  - [ ] Verify exported symbol names do not conflict with events, dispatch, or persistence exports

- [ ] Task 3: Create `packages/core/src/telemetry/types.ts` — core data types and schemas (AC: #3)
  - [ ] Read `src/modules/telemetry/types.ts` — copy all type definitions and Zod schemas verbatim; preserve JSDoc comments
  - [ ] Define primitive unions: `SemanticCategory`, `RuleId`, `RecommendationSeverity`
  - [ ] Define supporting record types: `ChildSpanSummary`, `TopInvocation`, `ModelEfficiency`, `SourceEfficiency`, `TokenCounts`
  - [ ] Define top-level data interfaces: `NormalizedSpan`, `NormalizedLog`
  - [ ] Define Zod schemas and inferred types for: `TurnAnalysis`, `CategoryStats`, `ConsumerStats`, `EfficiencyScore`, `Recommendation`, `EfficiencyProfile`

- [ ] Task 4: Add `ITelemetryPersistence`, `ITelemetryPipeline`, and `RawOtlpPayload` to telemetry types (AC: #4, #5)
  - [ ] Read `src/modules/telemetry/telemetry-pipeline.ts` — extract `RawOtlpPayload` type definition and `processBatch` method signature
  - [ ] Find the `TelemetryPersistence` class (likely `src/modules/telemetry/telemetry-persistence.ts` or similar) — extract all public method signatures
  - [ ] Define `ITelemetryPersistence` interface with all 5 write methods; parameter types must reference types defined in the same file
  - [ ] Define `ITelemetryPipeline` interface with `processBatch(items: RawOtlpPayload[]): Promise<void>`
  - [ ] Define `RawOtlpPayload` type; if it references a `DispatchContext`-like type from the dispatch module, import it from `../dispatch/index.js` (no circular dependency — telemetry does not feed back into dispatch)

- [ ] Task 5: Create `packages/core/src/telemetry/index.ts` barrel export (AC: #6)
  - [ ] Export all symbols from `./types.js`
  - [ ] Verify exported symbol names do not conflict with existing core package exports

- [ ] Task 6: Update root barrel and verify build (AC: #6, #7)
  - [ ] Add `export * from './config/index.js'` to `packages/core/src/index.ts`
  - [ ] Add `export * from './telemetry/index.js'` to `packages/core/src/index.ts`
  - [ ] Run `tsc --build packages/core` (or `npx tsc -b packages/core --force`) and confirm exit code 0
  - [ ] Confirm `packages/core/dist/config/` and `packages/core/dist/telemetry/` are populated with `.js` and `.d.ts` files

## Dev Notes

### Architecture Constraints
- **Interface definition only** — do NOT modify any files under `src/`. This story defines new type files in `packages/core/`; implementations remain in the monolith until Epic 41.
- **ESM imports** — all intra-package relative imports must use `.js` extensions (e.g., `import { X } from './types.js'`). TypeScript resolves `.js` → `.ts` at compile time under `moduleResolution: "NodeNext"`.
- **Zod dependency** — `zod` is already declared in `packages/core/package.json` (added in story 40-4). Use it for Zod schemas present in the source config and telemetry modules. Do NOT add new package dependencies.
- **TokenCeilings exclusion** — `TokenCeilings` type and the `token_ceilings` optional field on `SubstrateConfig` are SDLC-specific. Do NOT include them in `packages/core/src/config/types.ts`. The SDLC package will define `SdlcConfig extends SubstrateConfig` with this field in a future story.
- **No circular dependencies** — the telemetry module may import dispatch types from `../dispatch/index.js` (one-way dependency), but must not create a cycle. Config must not import from telemetry or dispatch.
- **Copy verbatim** — copy type shapes exactly from the monolith source rather than paraphrasing. Structural identity is required so Epic 41 re-export shims satisfy both the old and new type contracts.

### Key Files to Read Before Implementing
- `src/modules/config/config-schema.ts` — all Zod schemas and types (source of truth for AC1)
- `src/modules/config/config-system.ts` — `ConfigSystem` and `ConfigSystemOptions` interfaces (source of truth for AC2)
- `src/modules/telemetry/types.ts` — all telemetry type definitions and Zod schemas (source of truth for AC3)
- `src/modules/telemetry/telemetry-pipeline.ts` — `RawOtlpPayload` definition and `processBatch` signature (source of truth for AC5)
- The `TelemetryPersistence` class source file — find by searching for `class TelemetryPersistence` in `src/modules/telemetry/` (source of truth for AC4)
- `packages/core/src/index.ts` — current barrel contents; check for naming conflicts before adding new exports

### Target File Structure
```
packages/core/src/config/
├── types.ts     # SubstrateConfig (no TokenCeilings), GlobalSettings, ProviderConfig,
│                # ProvidersConfig, BudgetConfig, CostTrackerConfig, TelemetryConfig,
│                # RateLimitConfig, ConfigSystem, ConfigSystemOptions
└── index.ts     # Barrel export: export * from './types.js'

packages/core/src/telemetry/
├── types.ts     # NormalizedSpan, NormalizedLog, TokenCounts, TurnAnalysis, CategoryStats,
│                # ConsumerStats, EfficiencyScore, Recommendation, EfficiencyProfile,
│                # SemanticCategory, RuleId, RecommendationSeverity, ChildSpanSummary,
│                # TopInvocation, ModelEfficiency, SourceEfficiency,
│                # ITelemetryPersistence, ITelemetryPipeline, RawOtlpPayload
└── index.ts     # Barrel export: export * from './types.js'

packages/core/src/index.ts  (UPDATE — add 2 export lines)
```

### Approximate Interface Shapes (verify against source before implementing)
```typescript
// packages/core/src/config/types.ts (excerpts)

export const SubstrateConfigSchema = z.object({
  config_format_version: z.literal('1'),
  task_graph_version: z.literal('1').optional(),
  global: GlobalSettingsSchema,
  providers: ProvidersConfigSchema,
  cost_tracker: CostTrackerConfigSchema.optional(),
  budget: BudgetConfigSchema.optional(),
  // token_ceilings intentionally excluded — SDLC-specific
  telemetry: TelemetryConfigSchema.optional(),
})
export type SubstrateConfig = z.infer<typeof SubstrateConfigSchema>

export interface ConfigSystem {
  load(): Promise<void>
  getConfig(): SubstrateConfig
  get(key: string): unknown
  set(key: string, value: unknown): Promise<void>
  getMasked(): SubstrateConfig
  readonly isLoaded: boolean
  getConfigFormatVersion(): string
  isCompatible(version: string): boolean
}

// packages/core/src/telemetry/types.ts (excerpts)

export interface ITelemetryPersistence {
  storeTurnAnalysis(storyKey: string, turns: TurnAnalysis[], dispatchId?: string, phase?: string, taskType?: string): Promise<void>
  storeEfficiencyScore(score: EfficiencyScore): Promise<void>
  storeCategoryStats(storyKey: string, categories: CategoryStats[]): Promise<void>
  storeConsumerStats(storyKey: string, consumers: ConsumerStats[]): Promise<void>
  saveRecommendations(recs: Recommendation[]): Promise<void>
}

export interface ITelemetryPipeline {
  processBatch(items: RawOtlpPayload[]): Promise<void>
}
```
> ⚠️ These are approximate — read the source files to confirm exact signatures before implementing.

### Testing Requirements
- This story produces TypeScript type definitions, Zod schemas, and one interface with no runtime logic
- No new unit test files are required
- Verification is TypeScript compilation only: `tsc --build packages/core` must exit 0
- Do NOT run `npm test` for this story — only the core package build needs to pass
- Structural correctness of `ITelemetryPersistence` will be enforced by TypeScript when Epic 41 adds the re-export shim pointing to the concrete `TelemetryPersistence` class

## Interface Contracts

- **Export**: `SubstrateConfig`, `GlobalSettings`, `ProviderConfig`, `ProvidersConfig`, `BudgetConfig`, `CostTrackerConfig`, `TelemetryConfig`, `RateLimitConfig`, `ConfigSystem`, `ConfigSystemOptions` (and their Zod schemas) @ `packages/core/src/config/types.ts`
- **Export**: `NormalizedSpan`, `NormalizedLog`, `TokenCounts`, `TurnAnalysis`, `EfficiencyScore`, `Recommendation`, `CategoryStats`, `ConsumerStats`, `EfficiencyProfile`, `ITelemetryPersistence`, `ITelemetryPipeline`, `RawOtlpPayload`, and all supporting telemetry types @ `packages/core/src/telemetry/types.ts`
- **Import**: Possibly `DispatchContext` or related dispatch type @ `packages/core/src/dispatch/index.ts` (from story 40-4, if `RawOtlpPayload.dispatchContext` requires a named type from the dispatch module)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-22: Story created for Epic 40 (Core Extraction Phase 1)
