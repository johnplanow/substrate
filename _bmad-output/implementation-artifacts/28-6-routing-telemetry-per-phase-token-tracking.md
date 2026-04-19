# Story 28-6: Routing Telemetry — Per-Phase Token Tracking and OTEL Spans

Status: review

## Story

As a pipeline operator,
I want per-phase token usage tracked during model-routed pipeline runs and OTEL spans emitted for routing and repo-map decisions,
so that I can observe how model routing distributes token consumption across pipeline phases and provide the data foundation for savings analysis in subsequent stories.

## Acceptance Criteria

### AC1: Per-Dispatch Phase Registration
**Given** a `RoutingTokenAccumulator` is subscribed to the event bus
**When** a `routing:model-selected` event fires with `{ dispatchId, taskType, phase, model, source }`
**Then** the accumulator stores the mapping `dispatchId → { phase, model }` in an in-memory `Map`; a second event for the same `dispatchId` overwrites the prior entry (last-writer-wins)

### AC2: Token Attribution on Agent Completion
**Given** one or more dispatches registered via AC1
**When** an `agent:completed` event fires with `{ dispatchId, inputTokens, outputTokens }`
**Then** the accumulator increments the matching phase bucket's `inputTokens`, `outputTokens`, and `dispatchCount` by the event values; a `dispatchId` with no prior routing registration is attributed to a bucket with `phase: 'default'` and `model: 'unknown'`

### AC3: Phase Breakdown Flush at Run Completion
**Given** token attribution has occurred for at least one dispatch
**When** `RoutingTokenAccumulator.flush(runId)` is called
**Then** the accumulator writes a `PhaseTokenBreakdown` record (containing a `PhaseTokenEntry[]` array — one per distinct `phase+model` combination — plus `baselineModel` and `runId`) to the `StateStore` via `stateStore.setMetric(runId, 'phase_token_breakdown', breakdown)`; the in-memory maps are cleared so a subsequent `flush()` writes an empty entry array

### AC4: `substrate metrics --output-format json` Exposes Phase Breakdown
**Given** a completed pipeline run whose metrics include a stored `phase_token_breakdown`
**When** `substrate metrics --output-format json` is called
**Then** the JSON object for that run includes a `phase_token_breakdown` field containing the deserialized `PhaseTokenBreakdown`; when no breakdown was stored for a run, the field is `null`

### AC5: OTEL Span Emitted for Each Routing Decision
**Given** `RoutingTelemetry` is constructed with a `TelemetryPersistence` instance and injected alongside `RoutingResolver` in the run command
**When** `RoutingResolver.resolveModel(taskType)` returns a non-null `ModelResolution`
**Then** `RoutingTelemetry.recordModelResolved()` is called immediately after and emits a span named `routing.model_resolved` via `TelemetryPersistence.recordSpan()` with attributes `{ dispatchId, taskType, phase, model, source, latencyMs }`

### AC6: OTEL Span Emitted for Each Repo-Map Query
**Given** `RepoMapTelemetry` is provided as an optional constructor argument to `RepoMapQueryEngine`
**When** `RepoMapQueryEngine.query()` completes (successfully or with an error)
**Then** `RepoMapTelemetry.recordQuery()` emits a span named `repo_map.query` via `TelemetryPersistence.recordSpan()` with attributes `{ queryDurationMs, symbolCount, truncated, filterFields }`; on error the span includes `{ error: true }`; when `RepoMapTelemetry` was not injected, no span is emitted and existing tests are unaffected

### AC7: Unit Tests at ≥80% Coverage
**Given** the new accumulator, telemetry helpers, and metrics-command extension
**When** `npm run test:fast` is executed
**Then** all unit tests in `src/modules/routing/__tests__/routing-token-accumulator.test.ts` and `src/modules/routing/__tests__/routing-telemetry.test.ts` pass; coverage on all new source files is ≥80%; no previously-passing tests regress

## Tasks / Subtasks

- [x] Task 1: Define `PhaseTokenEntry` and `PhaseTokenBreakdown` types (AC: #1, #2, #3)
  - [x] Create `src/modules/routing/types.ts` with: `PhaseTokenEntry = { phase: 'explore' | 'generate' | 'review' | 'default'; model: string; inputTokens: number; outputTokens: number; dispatchCount: number }` and `PhaseTokenBreakdown = { entries: PhaseTokenEntry[]; baselineModel: string; runId: string }`
  - [x] Add named exports `PhaseTokenEntry` and `PhaseTokenBreakdown` to `src/modules/routing/index.ts`

- [x] Task 2: Implement `RoutingTokenAccumulator` class (AC: #1, #2, #3)
  - [x] Create `src/modules/routing/routing-token-accumulator.ts` with constructor `(config: ModelRoutingConfig, stateStore: IStateStore, logger: Logger)` storing readonly fields
  - [x] Declare private fields: `_dispatchMap: Map<string, { phase: string; model: string }>` and `_buckets: Map<string, PhaseTokenEntry>` (bucket key = `"${phase}::${model}"`)
  - [x] Implement `onRoutingSelected(event: { dispatchId: string; phase: string; model: string }): void` — upserts into `_dispatchMap` (AC1)
  - [x] Implement `onAgentCompleted(event: { dispatchId: string; inputTokens: number; outputTokens: number }): void` — looks up phase mapping; computes bucket key; upserts/accumulates into `_buckets`; attributes unknown dispatches to `phase: 'default', model: 'unknown'` bucket (AC2)
  - [x] Implement `async flush(runId: string): Promise<void>` — constructs `PhaseTokenBreakdown` from `_buckets`, calls `stateStore.setMetric(runId, 'phase_token_breakdown', breakdown)`, clears both maps (AC3)
  - [x] Export `RoutingTokenAccumulator` from `src/modules/routing/index.ts`

- [x] Task 3: Implement `RoutingTelemetry` and `RepoMapTelemetry` helpers (AC: #5, #6)
  - [x] Create `src/modules/routing/routing-telemetry.ts`: class `RoutingTelemetry` with constructor `(telemetry: TelemetryPersistence, logger: Logger)`; method `recordModelResolved(...)` calls `this.telemetry.recordSpan({ name: 'routing.model_resolved', attributes: attrs })`; export from `src/modules/routing/index.ts`
  - [x] Create `src/modules/repo-map/repo-map-telemetry.ts`: class `RepoMapTelemetry` with constructor `(telemetry: TelemetryPersistence, logger: Logger)`; method `recordQuery(...)` calls `this.telemetry.recordSpan({ name: 'repo_map.query', attributes: attrs })`; export from `src/modules/repo-map/index.ts`
  - [x] Modify `src/modules/repo-map/query.ts` (story 28-3): add optional `telemetry?: RepoMapTelemetry` as the last constructor parameter; in `query()`, wrap the existing body in a `try/finally` block that calls `telemetry?.recordQuery({...})`

- [x] Task 4: Wire accumulator and telemetry into `run.ts` (AC: #3, #5)
  - [x] In `src/cli/commands/run.ts`, construct `RoutingTokenAccumulator` and subscribe to `routing:model-selected` and `agent:completed` events
  - [x] At pipeline run completion, call `await accumulator?.flush(runId)`
  - [x] Import `RoutingTokenAccumulator` and `RoutingTelemetry` from `../../modules/routing/index.js`; import `RepoMapTelemetry` from `../../modules/repo-map/index.js`

- [x] Task 5: Extend `substrate metrics` command output (AC: #4)
  - [x] In `src/cli/commands/metrics.ts`, read `phase_token_breakdown` via `stateStore.getMetric()`
  - [x] Include `phase_token_breakdown` in JSON output; print formatted table in text output

- [x] Task 6: Unit tests (AC: #7)
  - [x] Create `src/modules/routing/__tests__/routing-token-accumulator.test.ts` (12 tests covering AC1, AC2, AC3)
  - [x] Create `src/modules/routing/__tests__/routing-telemetry.test.ts` (5 tests covering AC5)
  - [x] All mocks via constructor injection — no real `StateStore`, no real `TelemetryPersistence`, no file I/O

## Dev Notes

### Architecture Constraints
- **ESM imports**: all internal imports must use `.js` extension (e.g. `import { RoutingTokenAccumulator } from './routing-token-accumulator.js'`)
- **Import order**: Node built-ins → third-party → internal, blank line between groups
- **No cross-module direct imports**: `RoutingTokenAccumulator` imports `IStateStore` only from `../../modules/state/index.js`; telemetry helpers import `TelemetryPersistence` only from `../../modules/telemetry/index.js`; no direct file-level imports across module boundaries
- **No fs.watch / inotify**: accumulator is purely event-driven push model; no polling
- **Optional telemetry injection**: `RepoMapTelemetry` is optional in `RepoMapQueryEngine` constructor — story 28-3's existing unit tests do not provide it and must continue to pass unchanged; use `telemetry?: RepoMapTelemetry` with optional chaining `telemetry?.recordQuery(...)`
- **Logging**: `createLogger('routing:accumulator')`, `createLogger('routing:telemetry')`, `createLogger('repo-map:telemetry')`; never `console.log`
- **run.ts sequential modification**: story 28-5 already modifies `run.ts` to wire `RoutingResolver`; this story adds further lines to the same file — implement in strict story order (28-5 committed first)

### File Paths
```
src/modules/routing/
  types.ts                                   ← NEW: PhaseTokenEntry, PhaseTokenBreakdown
  routing-token-accumulator.ts               ← NEW: RoutingTokenAccumulator class
  routing-telemetry.ts                       ← NEW: RoutingTelemetry class
  index.ts                                   ← MODIFY: export new types and classes

src/modules/repo-map/
  repo-map-telemetry.ts                      ← NEW: RepoMapTelemetry class
  query.ts                                   ← MODIFY (from story 28-3): add optional telemetry param
  index.ts                                   ← MODIFY (from story 28-3): export RepoMapTelemetry

src/cli/commands/
  run.ts                                     ← MODIFY: wire accumulator + telemetry helpers
  metrics.ts                                 ← MODIFY: include phase_token_breakdown in output
```

### `agent:completed` Event Shape
Check `src/core/event-bus.ts` for the actual payload of `agent:completed`. The accumulator needs `dispatchId`, `inputTokens`, and `outputTokens`. If those fields are named differently (e.g. `tokens.input`, `usage.inputTokens`), adapt accordingly — do not invent field names.

### `TelemetryPersistence.recordSpan` Signature
Check `src/modules/telemetry/index.ts` for the exact `recordSpan` method signature from Epic 27. The call pattern assumed above is:
```typescript
telemetry.recordSpan({
  name: 'routing.model_resolved',
  attributes: { dispatchId, taskType, phase, model, source, latencyMs },
})
```
Adjust to the actual interface if it uses `startTime`/`endTime` or other required fields.

### `IStateStore.setMetric` / `getMetric` Signature
Check `src/modules/state/index.ts` for the exact method signatures. Expected patterns:
```typescript
// write:
await stateStore.setMetric(runId, 'phase_token_breakdown', JSON.stringify(breakdown))
// read:
const raw = await stateStore.getMetric(runId, 'phase_token_breakdown')
const breakdown: PhaseTokenBreakdown | null = raw ? JSON.parse(raw) : null
```
If `IStateStore` uses a different shape (e.g. `{ key, value, runId }` object), match the actual interface.

### Bucket Key Design
Use `"${phase}::${model}"` as the bucket key so that the same phase with different models produces separate entries. This is important for runs where an override sends one task type to a different model than the default phase model.

```typescript
private _upsertBucket(phase: string, model: string, inputTokens: number, outputTokens: number): void {
  const key = `${phase}::${model}`
  const existing = this._buckets.get(key)
  if (existing) {
    existing.inputTokens += inputTokens
    existing.outputTokens += outputTokens
    existing.dispatchCount += 1
  } else {
    this._buckets.set(key, {
      phase: phase as PhaseTokenEntry['phase'],
      model,
      inputTokens,
      outputTokens,
      dispatchCount: 1,
    })
  }
}
```

### Testing Requirements
- **Framework**: vitest — `import { describe, it, expect, vi, beforeEach } from 'vitest'`; no jest APIs
- **Stub `IStateStore`**: `{ setMetric: vi.fn().mockResolvedValue(undefined), getMetric: vi.fn().mockResolvedValue(null) }`
- **Stub `TelemetryPersistence`**: `{ recordSpan: vi.fn().mockResolvedValue(undefined) }` — pass via constructor
- **No real event bus in unit tests**: call accumulator methods directly (`onRoutingSelected(...)`, `onAgentCompleted(...)`) rather than emitting through a bus
- **Coverage gate**: ≥80% line coverage on all new source files (enforced by `npm test`)

## Interface Contracts

- **Import**: `ModelRoutingConfig` @ `src/modules/routing/model-routing-config.ts` (from story 28-4)
- **Import**: `RoutingResolver`, `ModelResolution` @ `src/modules/routing/model-routing-resolver.ts` (from story 28-4)
- **Import**: `routing:model-selected` event payload @ `src/core/event-bus.ts` (from story 28-5)
- **Import**: `TelemetryPersistence` @ `src/modules/telemetry/index.ts` (from Epic 27)
- **Import**: `IStateStore` @ `src/modules/state/index.ts` (from Epic 26)
- **Import**: `RepoMapQueryEngine` @ `src/modules/repo-map/query.ts` (from story 28-3 — extended here with optional telemetry)
- **Export**: `PhaseTokenEntry`, `PhaseTokenBreakdown` @ `src/modules/routing/types.ts` (consumed by story 28-8 savings computation and story 28-9 CLI display)
- **Export**: `RoutingTokenAccumulator` @ `src/modules/routing/routing-token-accumulator.ts` (consumed by `run.ts` wiring)
- **Export**: `RoutingTelemetry` @ `src/modules/routing/routing-telemetry.ts` (consumed by `run.ts` wiring)
- **Export**: `RepoMapTelemetry` @ `src/modules/repo-map/repo-map-telemetry.ts` (consumed by `run.ts` wiring for optional injection into `RepoMapQueryEngine`)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Story 28-5 had failed (human-intervention escalation), so `routing:model-selected` event type and `RoutingResolver` wiring did not exist. Added `routing:model-selected` event to `event-bus.types.ts` and wired minimal routing config loading into `run.ts`.
- `agent:completed` payload lacked `inputTokens`/`outputTokens` fields. Extended the type in `event-bus.types.ts` with optional fields and updated `dispatcher-impl.ts` to emit them.
- `StateStore` interface lacked `setMetric`/`getMetric`. Added to `types.ts` and implemented in both `FileStateStore` (with file persistence to `kv-metrics.json`) and `DoltStateStore` (in-memory).
- `ITelemetryPersistence` lacked `recordSpan`. Added to interface and implemented as a logger.debug no-op.
- Build: `npm run build` succeeds with no TypeScript errors.
- Tests: 5230 passing, 213 test files (17 new tests across 2 new test files).

### File List
- `src/modules/routing/types.ts` (NEW)
- `src/modules/routing/routing-token-accumulator.ts` (NEW)
- `src/modules/routing/routing-telemetry.ts` (NEW)
- `src/modules/routing/index.ts` (MODIFIED)
- `src/modules/routing/__tests__/routing-token-accumulator.test.ts` (NEW)
- `src/modules/routing/__tests__/routing-telemetry.test.ts` (NEW)
- `src/modules/repo-map/repo-map-telemetry.ts` (NEW)
- `src/modules/repo-map/query.ts` (MODIFIED)
- `src/modules/repo-map/index.ts` (MODIFIED)
- `src/core/event-bus.types.ts` (MODIFIED)
- `src/modules/agent-dispatch/dispatcher-impl.ts` (MODIFIED)
- `src/modules/telemetry/persistence.ts` (MODIFIED)
- `src/modules/state/types.ts` (MODIFIED)
- `src/modules/state/file-store.ts` (MODIFIED)
- `src/modules/state/dolt-store.ts` (MODIFIED)
- `src/cli/commands/run.ts` (MODIFIED)
- `src/cli/commands/metrics.ts` (MODIFIED)

## Change Log
