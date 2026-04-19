# Story 28-4: Model Routing Configuration Schema

Status: review

## Story

As a pipeline orchestrator,
I want to load a per-phase model routing configuration from `substrate.routing.yml` and resolve the appropriate model for each task type,
so that exploration tasks use cheap models and generation/review tasks use expensive models — maximising quality where it matters while reducing pipeline cost.

## Acceptance Criteria

### AC1: ModelRoutingConfig Zod Schema
**Given** a `substrate.routing.yml` file with `version: 1`, a `phases` map (keys `explore | generate | review`, each with a required `model` string and optional `max_tokens`), and a required `baseline_model` string
**When** `loadModelRoutingConfig(filePath)` is called
**Then** the parsed object matches the `ModelRoutingConfigSchema` exactly and is returned as a typed `ModelRoutingConfig`; the schema rejects any document whose `version` field is not the literal `1` with a `RoutingConfigError`

### AC2: Loader Error Handling
**Given** a path to a missing file, a file containing invalid YAML, or a file that is valid YAML but fails schema validation
**When** `loadModelRoutingConfig(filePath)` is called
**Then** a `RoutingConfigError` is thrown with a descriptive `message` and a `code` of `CONFIG_NOT_FOUND`, `INVALID_YAML`, or `SCHEMA_INVALID` respectively; the error is an instance of both `RoutingConfigError` and `SubstrateError`

### AC3: Task-Type to Phase Mapping
**Given** a `ModelRoutingConfig` loaded successfully
**When** `RoutingResolver.resolveModel(taskType)` is called with known task types
**Then** `create-story` maps to `generate` phase, `dev-story` maps to `generate` phase, `code-review` maps to `review` phase, `explore` maps to `explore` phase, and any unrecognised task type maps to `generate` as the safe default

### AC4: Per-Task-Type Override
**Given** a `substrate.routing.yml` that includes an `overrides` map (e.g. `overrides.dev-story.model: "claude-opus-4-6"`)
**When** `RoutingResolver.resolveModel('dev-story')` is called
**Then** the override entry takes precedence over the phase-level configuration; the returned `ModelResolution` carries `{ model: 'claude-opus-4-6', phase: 'generate', source: 'override' }` rather than the phase model

### AC5: Graceful Absent Config
**Given** `loadModelRoutingConfig` throws `CONFIG_NOT_FOUND` (file does not exist)
**When** `RoutingResolver.createWithFallback(filePath, logger)` is called (the static factory)
**Then** no error is thrown; the resolver is constructed in fallback mode; all subsequent `resolveModel()` calls return `null`, signalling callers to use their own default model; a `warn`-level log line is emitted once at construction time

### AC6: Model Name Allowlist Validation
**Given** a `substrate.routing.yml` whose `phases.generate.model` contains a value that does not match the pattern `/^[a-zA-Z0-9._-]+$/`
**When** `loadModelRoutingConfig(filePath)` is called
**Then** validation fails with `RoutingConfigError` code `SCHEMA_INVALID` and the error message identifies the offending field path

### AC7: Barrel Export and Index Registration
**Given** the new files `model-routing-config.ts` and `model-routing-resolver.ts` exist in `src/modules/routing/`
**When** consumer code imports from `src/modules/routing/index.ts`
**Then** `ModelRoutingConfigSchema`, `ModelRoutingConfig`, `RoutingConfigError`, `RoutingResolver`, `ModelResolution`, and `loadModelRoutingConfig` are all available as named exports with no import-path changes needed for existing exports (`RoutingEngine`, `RoutingDecision`, `RoutingPolicy`, etc.)

## Tasks / Subtasks

- [x] Task 1: Create `src/modules/routing/model-routing-config.ts` — Zod schema, types, loader (AC: #1, #2, #6)
  - [x] Define `ModelPhaseConfigSchema = z.object({ model: z.string().regex(/^[a-zA-Z0-9._-]+$/), max_tokens: z.number().int().positive().optional() })`
  - [x] Define `ModelRoutingConfigSchema = z.object({ version: z.literal(1), phases: z.object({ explore/generate/review all optional }), baseline_model: z.string().regex(...), overrides: z.record(z.string(), ModelPhaseConfigSchema).optional() })` — all phase keys optional
  - [x] Export `type ModelRoutingConfig = z.infer<typeof ModelRoutingConfigSchema>` and `type ModelPhaseConfig = z.infer<typeof ModelPhaseConfigSchema>`
  - [x] Define `RoutingConfigError extends SubstrateError` with `code: 'CONFIG_NOT_FOUND' | 'INVALID_YAML' | 'SCHEMA_INVALID'`; created `src/errors/substrate-error.ts`
  - [x] Implement `loadModelRoutingConfig(filePath: string): ModelRoutingConfig` — read file, parse YAML, validate with Zod; maps each failure mode to the correct `RoutingConfigError` code

- [x] Task 2: Create `src/modules/routing/model-routing-resolver.ts` — `RoutingResolver` class (AC: #3, #4, #5)
  - [x] Define `ModelResolution = { model: string; maxTokens?: number; phase: string; source: 'phase' | 'override' }` interface; export from this file
  - [x] Define `TASK_TYPE_PHASE_MAP` constant
  - [x] Implement `RoutingResolver` class with constructor `(config: ModelRoutingConfig, logger: pino.Logger)`
  - [x] Implement `resolveModel(taskType: string): ModelResolution | null`
  - [x] Implement static `createWithFallback(filePath: string, logger: pino.Logger): RoutingResolver`
  - [x] Log each resolved model at `debug` level

- [x] Task 3: Update `src/modules/routing/index.ts` barrel exports (AC: #7)
  - [x] Add named exports for all new types/values from both new files
  - [x] Existing exports unchanged

- [x] Task 4: Unit tests for `model-routing-config.ts` (AC: #1, #2, #6)
  - [x] Create `src/modules/routing/__tests__/model-routing-config.test.ts`
  - [x] Mock `node:fs` via `vi.mock('node:fs')`; 16 tests covering all ACs

- [x] Task 5: Unit tests for `model-routing-resolver.ts` (AC: #3, #4, #5)
  - [x] Create `src/modules/routing/__tests__/model-routing-resolver.test.ts`
  - [x] 19 tests covering AC3, AC4, AC5 with inline fixtures and mock logger

## Dev Notes

### Architecture Constraints
- **ESM imports**: all internal imports must use `.js` extension (e.g. `import { SubstrateError } from '../../errors/substrate-error.js'`).
- **Import order**: Node built-ins first (`node:fs`), then third-party (`js-yaml`, `zod`), then internal — blank line between groups.
- **No cross-module direct imports**: imports from outside `src/modules/routing/` only from `../../errors/substrate-error.js` and `../../utils/logger.js`.
- **Logging**: `createLogger('routing:model-resolver')` per the architecture; never `console.log`.
- **Config loading pattern**: load once at construction time (or via the static factory); readonly field; no fs.watch / inotify — per the `config-loading` architecture decision avoiding the fs.watch regression class documented in project memory.
- **Zod schema-first**: define `ModelRoutingConfigSchema` first, derive `ModelRoutingConfig` via `z.infer`; never write a manual TypeScript interface that duplicates the schema.
- **Existing module**: `src/modules/routing/` already contains `routing-engine.ts`, `routing-policy.ts`, `routing-decision.ts`, `provider-status.ts`, `index.ts`. The new files are *additive* — do not modify existing files except `index.ts` to add exports.
- **`SubstrateError` location**: check `src/errors/substrate-error.ts` for the base class; match its constructor signature `(message: string, code: string, context?: Record<string, unknown>)`.
- **js-yaml**: already in project dependencies — `import { load as yamlLoad } from 'js-yaml'`.

### File Paths
```
src/modules/routing/
  model-routing-config.ts    ← NEW: Zod schema + RoutingConfigError + loadModelRoutingConfig
  model-routing-resolver.ts  ← NEW: RoutingResolver class + ModelResolution + TASK_TYPE_PHASE_MAP
  index.ts                   ← MODIFY: add exports for new files; existing exports unchanged
  __tests__/
    model-routing-config.test.ts    ← NEW
    model-routing-resolver.test.ts  ← NEW
```

### ModelRoutingConfig YAML Shape (reference)
```yaml
version: 1
baseline_model: claude-sonnet-4-5   # used for savings calculation in story 28-6
phases:
  explore:
    model: claude-haiku-4-5
  generate:
    model: claude-sonnet-4-5
    max_tokens: 8192
  review:
    model: claude-sonnet-4-5
overrides:
  dev-story:
    model: claude-opus-4-6   # high-stakes generation override
```

### RoutingConfigError Design
The error should extend `SubstrateError` with the three codes as a TypeScript string-union literal type. The `context` field should carry `{ filePath }` so upstream callers can include it in log output without string manipulation. Example:
```typescript
throw new RoutingConfigError(
  `Cannot read routing config file at "${filePath}": ${err.message}`,
  'CONFIG_NOT_FOUND',
  { filePath },
)
```

### RoutingResolver Fallback Mode Detail
When `createWithFallback` catches `CONFIG_NOT_FOUND`, it constructs the resolver with a synthetic config:
```typescript
const fallbackConfig: ModelRoutingConfig = {
  version: 1,
  phases: {},
  baseline_model: '',
}
```
With an empty `phases` map, `resolveModel()` will always find no phase config and return `null`. Story 28-5 (model-routed dispatch) will treat `null` as "use the existing default model from ProviderPolicy", ensuring zero regression.

### Testing Requirements
- **Framework**: vitest — `import { describe, it, expect, vi, beforeEach } from 'vitest'`; no jest APIs.
- **Mock strategy**: mock `node:fs` via `vi.mock('node:fs', () => ({ readFileSync: vi.fn() }))` in `model-routing-config.test.ts` — eliminates real file I/O.
- **No Dolt / no subprocess in tests**: these units are pure in-memory.
- **Coverage gate**: ≥80% line coverage on both new source files (enforced by `npm test` coverage check).

## Interface Contracts

- **Export**: `ModelRoutingConfig`, `ModelRoutingConfigSchema`, `RoutingConfigError`, `loadModelRoutingConfig` @ `src/modules/routing/model-routing-config.ts` (consumed by story 28-5 dispatcher integration and story 28-6 telemetry savings)
- **Export**: `RoutingResolver`, `ModelResolution`, `TASK_TYPE_PHASE_MAP` @ `src/modules/routing/model-routing-resolver.ts` (consumed by story 28-5 `DispatcherImpl` constructor injection)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Created `src/errors/substrate-error.ts` as the base error class (did not exist in codebase; story spec requires `RoutingConfigError extends SubstrateError`)
- Used `z.object({ explore: optional, generate: optional, review: optional })` for phases instead of `z.record(z.enum(...))` because Zod v4 requires all enum keys in z.record — optional object approach satisfies "all phase keys optional" requirement
- Fallback config uses `baseline_model: ''` (valid at TypeScript level since Zod regex infers as `string`)
- 5193 total tests pass (35 new tests added)

### File List
- `src/errors/substrate-error.ts` — NEW: SubstrateError base class
- `src/modules/routing/model-routing-config.ts` — NEW: Zod schema, RoutingConfigError, loadModelRoutingConfig
- `src/modules/routing/model-routing-resolver.ts` — NEW: RoutingResolver, ModelResolution, TASK_TYPE_PHASE_MAP
- `src/modules/routing/index.ts` — MODIFIED: added exports for new files
- `src/modules/routing/__tests__/model-routing-config.test.ts` — NEW: 16 tests
- `src/modules/routing/__tests__/model-routing-resolver.test.ts` — NEW: 19 tests

## Change Log
