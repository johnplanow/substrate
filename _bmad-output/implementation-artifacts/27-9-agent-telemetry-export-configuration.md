# Story 27-9: Agent Telemetry Export Configuration

Status: review

## Story

As a pipeline operator,
I want substrate's child Claude Code agents to automatically export OpenTelemetry data to substrate's ingestion endpoint when telemetry is opt-in enabled,
so that the OTLP ingestion pipeline (stories 27-1 through 27-7) receives real telemetry from actual pipeline runs with zero overhead when the feature is disabled.

## Acceptance Criteria

### AC1: Telemetry Config Section in Schema
**Given** a `substrate.config.json` with `"telemetry": {"enabled": true, "port": 4318}`
**When** the config is loaded and Zod-validated
**Then** `TelemetryConfigSchema` parses successfully, `SubstrateConfig.telemetry` is typed as `TelemetryConfig | undefined`, and the derived TypeScript type is available to all callers via `z.infer<>`

### AC2: Config Defaults
**Given** a config file with `"telemetry": {}` (empty object) or with the `telemetry` section absent entirely
**When** the config is parsed and merged with defaults
**Then** `enabled` defaults to `false` and `port` defaults to `4318`; no validation error is thrown

### AC3: OTLP Env Var Generation from IngestionServer
**Given** an `IngestionServer` that has been started and is bound to a port
**When** `ingestionServer.getOtlpEnvVars()` is called
**Then** it returns a `Record<string, string>` containing exactly: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, and `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:<actualPort>`; calling it before `start()` throws `AppError` with code `ERR_TELEMETRY_NOT_STARTED`

### AC4: ClaudeCodeAdapter Injects OTLP Env Vars When Enabled
**Given** `AdapterOptions` with `otlpEndpoint` set to `"http://localhost:4318"`
**When** `ClaudeCodeAdapter.buildCommand()` is called
**Then** the returned `SpawnCommand.env` contains all five OTLP env vars derived from the endpoint URL: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=<otlpEndpoint>`

### AC5: Zero Overhead When Disabled
**Given** `AdapterOptions` with `otlpEndpoint` absent (undefined)
**When** `ClaudeCodeAdapter.buildCommand()` is called
**Then** the returned `SpawnCommand.env` contains none of the OTLP env vars; no ingestion server is started and the child process runs without telemetry overhead

### AC6: Dispatcher Forwards OTLP Endpoint
**Given** a `DispatchRequest` with `otlpEndpoint: "http://localhost:4318"` set
**When** the dispatcher builds `AdapterOptions` and calls `adapter.buildCommand()`
**Then** `AdapterOptions.otlpEndpoint` is set to the value from the request, causing the adapter to include OTLP env vars in the spawned process

### AC7: Orchestrator Lifecycle Wiring
**Given** `telemetry.enabled: true` in project config and an `IngestionServer` injected into orchestrator deps
**When** the orchestrator starts a pipeline run
**Then** it calls `ingestionServer.start()` before the first dispatch, passes `otlpEndpoint` (from `ingestionServer.getOtlpEnvVars()['OTEL_EXPORTER_OTLP_ENDPOINT']`) on every `DispatchRequest`, and calls `ingestionServer.stop()` after the final story completes or on error

## Tasks / Subtasks

- [ ] Task 1: Add `TelemetryConfigSchema` to `src/modules/config/config-schema.ts` (AC: #1, #2)
  - [ ] Define `TelemetryConfigSchema` using Zod: `enabled: z.boolean().default(false)`, `port: z.number().int().min(1).max(65535).default(4318)`
  - [ ] Add `telemetry: TelemetryConfigSchema.optional()` to `SubstrateConfigSchema` (before `.strict()`)
  - [ ] Export `TelemetryConfig = z.infer<typeof TelemetryConfigSchema>`
  - [ ] Add `telemetry: TelemetryConfigSchema.partial().optional()` to `PartialSubstrateConfigSchema`
  - [ ] Add unit test cases to `src/modules/config/__tests__/config-schema.test.ts` covering: full telemetry block, empty telemetry block (defaults), missing telemetry section (undefined), out-of-range port rejection

- [ ] Task 2: Add `getOtlpEnvVars()` to `IngestionServer` (AC: #3)
  - [ ] Add `getOtlpEnvVars(): Record<string, string>` method to `src/modules/telemetry/ingestion-server.ts`
  - [ ] Method reads the bound port from the running HTTP server (`this._server?.address()`) — throws `AppError(ERR_TELEMETRY_NOT_STARTED, 2)` if server is not yet started
  - [ ] Returns the five OTLP env vars: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:<port>`
  - [ ] Add `ERR_TELEMETRY_NOT_STARTED` to the errors catalogue in `src/errors/` following the existing `ERR_*` code pattern
  - [ ] Add unit tests in `src/modules/telemetry/__tests__/ingestion-server.test.ts`: verify all 5 env vars present, verify correct port substitution, verify throws when server not started

- [ ] Task 3: Add `otlpEndpoint` to `AdapterOptions` and update `ClaudeCodeAdapter` (AC: #4, #5)
  - [ ] Add `otlpEndpoint?: string` field to `AdapterOptions` interface in `src/adapters/types.ts` with JSDoc comment: `/** OTLP endpoint URL for telemetry export; when set, injects OTEL env vars into the child process */`
  - [ ] In `ClaudeCodeAdapter.buildCommand()` in `src/adapters/claude-adapter.ts`: after the existing billingMode env block, add a guarded block — if `options.otlpEndpoint` is set, assign the five OTLP env vars into `envEntries`
  - [ ] The five env vars: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=<options.otlpEndpoint>`
  - [ ] Add unit tests in `src/adapters/__tests__/claude-adapter.test.ts`: case with `otlpEndpoint` set verifies all 5 vars in `cmd.env`, case without `otlpEndpoint` verifies none of the 5 vars appear

- [ ] Task 4: Add `otlpEndpoint` to `DispatchRequest` and update dispatcher forwarding (AC: #6)
  - [ ] Add `otlpEndpoint?: string` field to `DispatchRequest<T>` interface in `src/modules/agent-dispatch/types.ts` with JSDoc
  - [ ] In `dispatcher-impl.ts`, in `_startDispatch()`, destructure `otlpEndpoint` from `request` and spread it into the `AdapterOptions` object passed to `adapter.buildCommand()` (alongside existing `worktreePath`, `billingMode`, `model`, `maxTurns`)
  - [ ] Add unit test: dispatch request with `otlpEndpoint` set causes `buildCommand` to receive it in `AdapterOptions`

- [ ] Task 5: Wire orchestrator lifecycle (start/stop ingestion server, populate dispatch requests) (AC: #7)
  - [ ] Add optional `ingestionServer?: IngestionServer` field to the orchestrator deps type in `src/modules/implementation-orchestrator/types.ts` (or wherever `OrchestratorDeps` is defined)
  - [ ] In `orchestrator-impl.ts`, at pipeline start (before the first story dispatch): if `deps.ingestionServer` is defined, call `await deps.ingestionServer.start()` and capture the `otlpEndpoint` by calling `deps.ingestionServer.getOtlpEnvVars()['OTEL_EXPORTER_OTLP_ENDPOINT']`
  - [ ] In `orchestrator-impl.ts`, in each story `DispatchRequest`, spread `...(otlpEndpoint !== undefined ? { otlpEndpoint } : {})` into the request object
  - [ ] In `orchestrator-impl.ts`, in the finally block at pipeline teardown: if `deps.ingestionServer` is defined, call `await deps.ingestionServer.stop()`
  - [ ] Add unit tests: pipeline run with `ingestionServer` mock verifies `start()` called before first dispatch, `stop()` called on completion, and `otlpEndpoint` propagated to all dispatch requests

- [ ] Task 6: Wire CLI `run` command to create IngestionServer when telemetry enabled (AC: #7)
  - [ ] In `src/cli/commands/run.ts` (or wherever the orchestrator is instantiated for `substrate run`), after config is loaded: if `config.telemetry?.enabled === true`, construct `new IngestionServer({ port: config.telemetry.port ?? 4318 }, createLogger('telemetry:ingestion'))` and pass it as `ingestionServer` in orchestrator deps
  - [ ] Ensure the IngestionServer import path follows the project import-order convention (third-party → internal)
  - [ ] No-op path: if `config.telemetry?.enabled !== true`, `ingestionServer` is `undefined` — no import side-effects

- [ ] Task 7: Integration test for full opt-in / opt-out path (AC: #4, #5, #7)
  - [ ] In `src/modules/telemetry/__tests__/ingestion-server.integration.test.ts` (extending existing file from story 27-1): add test that starts server on port 0, calls `getOtlpEnvVars()`, verifies `OTEL_EXPORTER_OTLP_ENDPOINT` contains the OS-assigned port number
  - [ ] In `src/adapters/__tests__/claude-adapter.integration.test.ts` (or co-located unit test): full round-trip test — create `IngestionServer`, start it, call `getOtlpEnvVars()`, pass endpoint to `buildCommand()`, verify the five env vars appear in `SpawnCommand.env`, then stop server
  - [ ] Verify disabled path produces a `SpawnCommand` with none of the 5 OTLP env keys

## Dev Notes

### Architecture Constraints
- **Zod-first for config**: define `TelemetryConfigSchema` before the TypeScript type; use `.default()` on fields to ensure the parsed object always has concrete values — but keep the outer schema `.optional()` in `SubstrateConfigSchema` so missing-section configs pass validation
- **Constructor injection**: `IngestionServer` already accepts `ILogger`; pass `createLogger('telemetry:ingestion')` at the composition root (CLI `run` command) — do not construct it inside the orchestrator
- **EventEmitter pattern preserved**: `getOtlpEnvVars()` is a synchronous method on the running server — it does NOT attach event listeners or change server state
- **Import order**: in `run.ts`, import `IngestionServer` after Node built-ins and third-party packages, before other internal imports; follow the existing blank-line group separator convention
- **No Dolt writes in this story**: this story is purely about configuring child agents to emit telemetry. Ingestion, normalization, and persistence are handled by stories 27-1 through 27-3.
- **IngestionServer dependency**: this story depends on 27-1 having implemented `IngestionServer` with `start()` / `stop()` / EventEmitter; `getOtlpEnvVars()` is the only new method added to that class in this story

### File Paths
```
src/modules/config/config-schema.ts          ← add TelemetryConfigSchema + wire in
src/modules/telemetry/ingestion-server.ts    ← add getOtlpEnvVars() method
src/adapters/types.ts                        ← add otlpEndpoint to AdapterOptions
src/adapters/claude-adapter.ts               ← inject OTLP env vars in buildCommand()
src/modules/agent-dispatch/types.ts          ← add otlpEndpoint to DispatchRequest
src/modules/agent-dispatch/dispatcher-impl.ts← forward otlpEndpoint to AdapterOptions
src/modules/implementation-orchestrator/
  types.ts (or orchestrator-deps.ts)         ← add optional ingestionServer to deps
  orchestrator-impl.ts                       ← lifecycle: start, propagate, stop
src/cli/commands/run.ts                      ← create IngestionServer when enabled
src/errors/                                  ← add ERR_TELEMETRY_NOT_STARTED
```

### OTLP Env Vars
The exact five env vars to inject (order does not matter; all must be present):
```typescript
{
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,  // e.g. "http://localhost:4318"
}
```
These must be merged into `SpawnCommand.env` (not `unsetEnvKeys`) so they are available in the child `claude` process environment.

### Config Schema Pattern
Follow the existing pattern in `config-schema.ts` for optional subsections:
```typescript
export const TelemetryConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1).max(65535).default(4318),
  })
  .strict()

export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>

// In SubstrateConfigSchema:
telemetry: TelemetryConfigSchema.optional(),

// In PartialSubstrateConfigSchema:
telemetry: TelemetryConfigSchema.partial().optional(),
```

### IngestionServer.getOtlpEnvVars() Guard
The method must guard against pre-start calls:
```typescript
getOtlpEnvVars(): Record<string, string> {
  const addr = this._server?.address()
  if (addr === null || addr === undefined || typeof addr === 'string') {
    throw new AppError('ERR_TELEMETRY_NOT_STARTED', 2, 'IngestionServer is not started')
  }
  const endpoint = `http://localhost:${addr.port}`
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  }
}
```

### Testing Requirements
- **Unit tests** for `ClaudeCodeAdapter`: mock nothing extra — the adapter is pure (builds a command object), so just call `buildCommand()` with and without `otlpEndpoint` and assert on `cmd.env` keys
- **Unit tests** for config schema: call `TelemetryConfigSchema.parse({})` and verify defaults; call `SubstrateConfigSchema.parse({...noTelemetrySection})` and verify `telemetry === undefined`
- **Integration test** for `IngestionServer.getOtlpEnvVars()`: use real port binding (port 0) — existing integration test file from story 27-1 should be extended
- **Orchestrator tests**: mock `ingestionServer` as `{ start: vi.fn(), stop: vi.fn(), getOtlpEnvVars: vi.fn(() => ({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:9999', ... })) }` — verify call order and dispatch request population
- **Coverage target**: ≥80% for all new/modified files

### Error Code Registration
Find where other `ERR_*` codes are registered (e.g. `ERR_TELEMETRY_PORT_CONFLICT` from story 27-1) and add `ERR_TELEMETRY_NOT_STARTED` using the exact same pattern.

## Interface Contracts

- **Import**: `IngestionServer` @ `src/modules/telemetry/ingestion-server.ts` (from story 27-1 — adds `getOtlpEnvVars()` method in this story)
- **Import**: `TelemetryConfig` @ `src/modules/config/config-schema.ts` (exported by this story, consumed by orchestrator and CLI run command)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
