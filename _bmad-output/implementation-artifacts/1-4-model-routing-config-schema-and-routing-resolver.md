# Story 1-4: Model Routing Config Schema and RoutingResolver

Status: ready-for-dev

## Story

As a pipeline developer,
I want a validated `substrate.routing.yml` configuration file that maps pipeline phases to model identifiers, plus a `RoutingResolver` class that reads this config and resolves the correct model per phase,
so that expensive frontier models are reserved for code generation while cheap models handle exploration and review, reducing pipeline cost without changing execution logic.

## Acceptance Criteria

### AC1: Error Codes Added to Errors Catalogue
**Given** the errors catalogue at `src/errors/index.ts`
**When** the implementation is complete
**Then** three new `as const` string literal exports appear in a `routing error codes` section: `ERR_ROUTING_CONFIG_NOT_FOUND`, `ERR_ROUTING_INVALID_PHASE`, and `ERR_ROUTING_UNKNOWN_MODEL`; each constant's value matches its name; each has a JSDoc comment describing when it is thrown

### AC2: RoutingConfig Zod Schema and Type
**Given** a `substrate.routing.yml` file in the project root
**When** its contents are parsed with the `RoutingConfigSchema` Zod schema
**Then** a file with `{ version: 1, phases: { explore: { model: "claude-haiku-3-5" }, generate: { model: "claude-sonnet-4-5", max_tokens: 8192 }, review: { model: "claude-haiku-3-5" } }, baseline_model: "claude-sonnet-4-5" }` passes validation; a file with `version: 2` fails with a `ZodError`; a file with an unknown phase key (e.g. `deploy`) also fails; `max_tokens` is optional per phase; unknown top-level fields are rejected via `z.strictObject`

### AC3: loadRoutingConfig() Reads and Validates YAML
**Given** a `configPath` argument pointing to a YAML file on disk
**When** `loadRoutingConfig(configPath)` is called
**Then** it reads the file with `fs.readFileSync`, parses it with `js-yaml`, validates against `RoutingConfigSchema`, and returns a typed `RoutingConfig` object; when the file does not exist it throws an `AppError` with code `ERR_ROUTING_CONFIG_NOT_FOUND` and exit code 1; when the file is invalid YAML or fails Zod validation it throws an `AppError` with code `ERR_ROUTING_INVALID_PHASE` and a message that includes the filename and Zod/parse error details

### AC4: RoutingResolver Resolves Model Per Phase
**Given** a `RoutingResolver` constructed with a valid `RoutingConfig`
**When** `resolver.resolveModel('explore')` is called
**Then** it returns the `model` string from `config.phases.explore`; when called for a phase present in config but without `max_tokens`, it returns the model string alone; when called for a phase key not in `config.phases` it falls back to `config.baseline_model` and logs a `debug`-level message via the injected logger; the resolver never throws for a missing phase

### AC5: RoutingResolver Graceful Degradation on Missing Config File
**Given** a `RoutingResolver` created via `createRoutingResolver({ configPath, defaultModel, logger })`
**When** the YAML file at `configPath` does not exist
**Then** the factory function catches the `ERR_ROUTING_CONFIG_NOT_FOUND` error, logs a `warn`-level structured message via the injected logger with `{ component: 'routing', reason: 'config not found', configPath }`, constructs a synthetic `RoutingConfig` with an empty `phases` map and `baseline_model` set to `defaultModel`, and returns a functioning `RoutingResolver` that resolves all phases to `defaultModel`

### AC6: RoutingResolver.resolveAll() Returns Phase-to-Model Map
**Given** a `RoutingResolver` with `phases: { explore: { model: 'A' }, generate: { model: 'B' } }` and `baseline_model: 'C'`
**When** `resolver.resolveAll()` is called
**Then** it returns a plain object `{ explore: 'A', generate: 'B', review: 'C', baseline: 'C' }`; the `review` key is always present (falling back to baseline if not configured); the `baseline` key is always present; this method is suitable for dry-run output without triggering any dispatch

### AC7: Barrel Exports and Unit Test Coverage
**Given** the implementation is complete
**When** other modules import from `src/modules/routing/index.ts`
**Then** they can access: `RoutingConfigSchema`, `RoutingConfig`, `RoutingPhaseConfig`, `RoutingResolver`, `createRoutingResolver`, `loadRoutingConfig`; unit test files cover `loadRoutingConfig` (happy path, file not found, invalid YAML, Zod failure) and `RoutingResolver` (`resolveModel` for known phase, unknown phase fallback, `resolveAll`, graceful degradation factory) achieving ≥80% branch coverage for both modules

## Interface Contracts

- **Export**: `RoutingConfig` @ `src/modules/routing/routing-config.ts` (consumed by story 1-5: Model-Routed Agent Dispatch)
- **Export**: `RoutingResolver`, `createRoutingResolver` @ `src/modules/routing/routing-resolver.ts` (consumed by story 1-5)
- **Export**: `loadRoutingConfig` @ `src/modules/routing/routing-config.ts` (consumed by story 1-5)

## Tasks / Subtasks

- [ ] Task 1: Add routing error codes to `src/errors/index.ts` (AC: #1)
  - [ ] Append a `// routing error codes` section with `ERR_ROUTING_CONFIG_NOT_FOUND`, `ERR_ROUTING_INVALID_PHASE`, `ERR_ROUTING_UNKNOWN_MODEL` as `as const` string literals, each with a JSDoc comment; follow the existing pattern used for repo-map error codes
  - [ ] Confirm the file compiles: `tsc --noEmit`

- [ ] Task 2: Create `src/modules/routing/routing-config.ts` — Zod schema and loader (AC: #2, #3)
  - [ ] Define `RoutingPhaseConfigSchema = z.object({ model: z.string().min(1), max_tokens: z.number().int().positive().optional() })`
  - [ ] Define `RoutingConfigSchema = z.strictObject({ version: z.literal(1), phases: z.record(z.enum(['explore','generate','review']), RoutingPhaseConfigSchema), baseline_model: z.string().min(1) })`
  - [ ] Export inferred types: `type RoutingPhaseConfig = z.infer<typeof RoutingPhaseConfigSchema>` and `type RoutingConfig = z.infer<typeof RoutingConfigSchema>`
  - [ ] Implement `loadRoutingConfig(configPath: string): RoutingConfig`: read with `fs.readFileSync(configPath, 'utf8')`; parse with `js-yaml`; validate with `RoutingConfigSchema.parse()`; on `ENOENT` throw `new AppError('Routing config not found: ' + configPath, ERR_ROUTING_CONFIG_NOT_FOUND, 1)`; on `ZodError` throw `new AppError('Invalid routing config at ' + configPath + ': ' + err.message, ERR_ROUTING_INVALID_PHASE, 1)`
  - [ ] Import order: Node built-ins (`fs`), third-party (`js-yaml`, `zod`), internal (`../../errors/index.js`, `../../errors/app-error.js`)

- [ ] Task 3: Create `src/modules/routing/routing-resolver.ts` — RoutingResolver class and factory (AC: #4, #5, #6)
  - [ ] Define `type PipelinePhase = 'explore' | 'generate' | 'review'`
  - [ ] Implement `class RoutingResolver` with `constructor(private readonly config: RoutingConfig, private readonly logger: pino.Logger)` (store as `private readonly`)
  - [ ] Implement `resolveModel(phase: PipelinePhase): string`: return `this.config.phases[phase]?.model ?? this.config.baseline_model`; when phase is not in config, call `this.logger.debug({ component: 'routing', phase }, 'Phase not in config, falling back to baseline')`
  - [ ] Implement `resolveAll(): Record<PipelinePhase | 'baseline', string>`: return `{ explore: ..., generate: ..., review: ..., baseline: this.config.baseline_model }` where each phase calls `this.resolveModel(phase)`
  - [ ] Implement `createRoutingResolver({ configPath, defaultModel, logger }: { configPath: string; defaultModel: string; logger: pino.Logger }): RoutingResolver`: call `loadRoutingConfig(configPath)` in a try-catch; on `AppError` with code `ERR_ROUTING_CONFIG_NOT_FOUND`, log `warn` with `{ component: 'routing', reason: 'config not found', configPath }`, build synthetic config `{ version: 1, phases: {}, baseline_model: defaultModel }` (cast as `RoutingConfig`), and return `new RoutingResolver(syntheticConfig, logger)`; re-throw any other error

- [ ] Task 4: Update `src/modules/routing/index.ts` barrel exports (AC: #7)
  - [ ] Append to the existing barrel: `export type { RoutingConfig, RoutingPhaseConfig } from './routing-config.js'` and `export { RoutingConfigSchema, loadRoutingConfig } from './routing-config.js'`
  - [ ] Append: `export type { PipelinePhase } from './routing-resolver.js'` and `export { RoutingResolver, createRoutingResolver } from './routing-resolver.js'`
  - [ ] Confirm no circular imports by running `tsc --noEmit`

- [ ] Task 5: Unit tests for `loadRoutingConfig` (AC: #2, #3)
  - [ ] Create `src/modules/routing/__tests__/routing-config.test.ts`
  - [ ] Mock `fs.readFileSync` via `vi.mock('node:fs')` (or `vi.spyOn`) — no real file I/O in unit tests
  - [ ] Test happy path: valid YAML returns typed `RoutingConfig` with correct field values
  - [ ] Test `ENOENT`: mock throws `{ code: 'ENOENT' }`; expect `AppError` with code `ERR_ROUTING_CONFIG_NOT_FOUND` and exit code 1
  - [ ] Test invalid YAML: mock returns `':::not yaml'`; expect `AppError` (exit code 1) with message containing the filename
  - [ ] Test Zod failure: valid YAML with `version: 2`; expect `AppError` with code `ERR_ROUTING_INVALID_PHASE`
  - [ ] Test unknown top-level field rejected (e.g., `extra_field: true`)

- [ ] Task 6: Unit tests for `RoutingResolver` and `createRoutingResolver` (AC: #4, #5, #6)
  - [ ] Create `src/modules/routing/__tests__/routing-resolver.test.ts`
  - [ ] Build a test config fixture: `{ version: 1, phases: { explore: { model: 'haiku' }, generate: { model: 'opus', max_tokens: 8192 } }, baseline_model: 'sonnet' }`
  - [ ] Test `resolveModel('explore')` returns `'haiku'`
  - [ ] Test `resolveModel('review')` (not in phases) returns `'sonnet'` (baseline) and calls `logger.debug`
  - [ ] Test `resolveAll()` returns `{ explore: 'haiku', generate: 'opus', review: 'sonnet', baseline: 'sonnet' }`
  - [ ] Test `createRoutingResolver` with missing config: mock `loadRoutingConfig` to throw `AppError(ERR_ROUTING_CONFIG_NOT_FOUND)`; verify it returns a resolver that resolves all phases to `defaultModel`; verify `logger.warn` was called with `{ component: 'routing', reason: 'config not found' }`
  - [ ] Test `createRoutingResolver` re-throws non-config errors (e.g., `ERR_ROUTING_INVALID_PHASE`)
  - [ ] Use `vi.fn()` for logger (mock `debug` and `warn` methods); no real pino instance required

- [ ] Task 7: Sample config documentation in Dev Notes (AC: #2)
  - [ ] Add a `### Sample substrate.routing.yml` section to the Dev Notes below; include a valid YAML example with all three phases configured

## Dev Notes

### File Paths
- `src/errors/index.ts` — append routing error codes (modify existing)
- `src/modules/routing/routing-config.ts` — Zod schema + loader (new file in existing module)
- `src/modules/routing/routing-resolver.ts` — RoutingResolver class + factory (new file in existing module)
- `src/modules/routing/index.ts` — update barrel exports (append only, do NOT remove existing exports)
- `src/modules/routing/__tests__/routing-config.test.ts` — unit tests (new)
- `src/modules/routing/__tests__/routing-resolver.test.ts` — unit tests (new)

### Architecture Constraints
- **Do NOT modify** the existing `RoutingEngine`, `RoutingPolicy`, or `ProviderStatus` classes — this story introduces an orthogonal concern (model-per-phase selection) that coexists with the existing provider/agent routing
- `RoutingResolver` has no dependency on `RoutingEngine`; it is a self-contained value class with no event bus subscription
- `RoutingConfigSchema` uses `z.strictObject` at the top level and `z.enum(['explore','generate','review'])` as the key validator for `phases` to reject unknown phases at parse time
- `loadRoutingConfig()` uses synchronous `fs.readFileSync` — config is loaded once at startup, not re-read on every dispatch; this matches the `loadRoutingPolicy` pattern already in `routing-policy.ts`
- Logger injected via constructor (not imported as a module-level singleton) — enables test isolation via `vi.fn()`; use pino `Logger` type from `import type pino from 'pino'`
- Import order in all new files: Node built-ins → third-party → internal (relative paths with `.js` suffix for ESM); blank line between groups; no `console.log`

### Dependency on Existing Code
- `AppError` class: import from `'../../errors/app-error.js'` — has constructor `(message: string, code: string, exitCode: number)`
- Error code constants: import from `'../../errors/index.js'` (after Task 1 adds them)
- `js-yaml` is already a project dependency — do not add to `package.json`
- `zod` is already a project dependency

### Sample substrate.routing.yml

```yaml
version: 1
baseline_model: claude-sonnet-4-5

phases:
  explore:
    model: claude-haiku-3-5
  generate:
    model: claude-sonnet-4-5
    max_tokens: 8192
  review:
    model: claude-haiku-3-5
```

### Relationship to Story 1-5
- Story 1-5 (Model-Routed Agent Dispatch) will inject `RoutingResolver` into `AgentDispatcher`/`ClaudeCodeAdapter` and call `resolver.resolveModel(phase)` before each dispatch
- This story (1-4) only creates the config schema and resolver — it does NOT wire them into the dispatcher
- The `RoutingResolver` interface must be stable before story 1-5 begins; exports from `src/modules/routing/index.ts` are the contract

### Testing Requirements
- Vitest (NOT Jest); use `vi.mock`, `vi.fn()`, `vi.spyOn` — never `jest.*`
- All unit tests must mock `fs.readFileSync` — no real file I/O
- Logger mock: `const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger`
- Coverage target: 80% branch coverage enforced by existing vitest config
- Test files co-located in `src/modules/routing/__tests__/` — the `__tests__` directory already exists (check with `ls` before creating)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
