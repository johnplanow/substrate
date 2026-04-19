# Story 30-1: Dispatch Context Injection into OTLP Turns

## Story

As a pipeline operator reviewing telemetry data,
I want OTLP turns tagged with the task type and phase that produced them,
so that per-phase analysis (create-story vs dev-story vs code-review) becomes possible instead of every turn appearing as an identical "api_request".

## Acceptance Criteria

### AC1: IngestionServer exposes dispatch context API
**Given** the IngestionServer is running
**When** the orchestrator calls `setActiveDispatch(storyKey, { taskType, phase, dispatchId })`
**Then** the server stores the context keyed by storyKey, and `clearActiveDispatch(storyKey)` removes it cleanly with no error if the key is already absent

### AC2: Orchestrator wires set/clear around every dispatch call site
**Given** the orchestrator prepares any dispatch (create-story, dev-story, code-review, minor-fixes, etc.)
**When** it calls the adapter to dispatch a sub-agent
**Then** `ingestionServer.setActiveDispatch` is called before dispatch begins and `ingestionServer.clearActiveDispatch` is called after completion in a `finally` block (covers success, failure, and timeout paths)

### AC3: IngestionServer stamps buffered payloads with active dispatch context
**Given** an active dispatch context is set for storyKey "5-1" with taskType "dev-story"
**When** an OTLP payload arrives whose resource attributes include `substrate.story_key = "5-1"`
**Then** the payload is stamped with the active context (`taskType`, `phase`, `dispatchId`) before being added to the BatchBuffer

### AC4: TelemetryNormalizer propagates dispatch context to NormalizedLog
**Given** an OTLP log payload stamped with dispatch context by the ingestion handler
**When** `normalizeLog()` processes it
**Then** the resulting `NormalizedLog` includes optional `taskType`, `phase`, and `dispatchId` fields copied from the stamped context

### AC5: LogTurnAnalyzer copies dispatch context fields to TurnAnalysis output
**Given** NormalizedLog records with taskType, phase, and dispatchId populated
**When** `LogTurnAnalyzer.analyze()` processes them
**Then** each resulting `TurnAnalysis` record includes `taskType`, `phase`, and `dispatchId` copied from the representative log for that turn group

### AC6: turn_analysis table schema extended with dispatch context columns
**Given** the existing `turn_analysis` table
**When** the schema migration runs
**Then** the table has three new nullable columns: `task_type TEXT`, `phase TEXT`, and `dispatch_id TEXT` — existing rows retain NULL values (backward compatible)

### AC7: CLI metrics --turns displays task_type and phase per turn
**Given** a story with telemetry data that includes dispatch context
**When** `substrate metrics --turns <storyKey>` is run
**Then** the output table includes a `task_type` and `phase` column per turn row, showing the value or "-" when null

### AC8: Concurrent dispatches for different storyKeys are correctly isolated
**Given** two simultaneous active dispatch contexts set for storyKeys "5-1" (dev-story) and "5-2" (code-review)
**When** OTLP payloads arrive for both stories interleaved
**Then** each payload is stamped with only its own storyKey's dispatch context — no cross-contamination between stories

### AC9: Payloads with no matching active dispatch context retain null fields
**Given** no active dispatch context is set for a storyKey (or the payload has no extractable storyKey)
**When** the OTLP payload arrives and is processed through normalizer → LogTurnAnalyzer
**Then** the resulting TurnAnalysis records have undefined/null taskType, phase, and dispatchId (graceful degradation, no errors thrown)

## Tasks / Subtasks

- [ ] Task 1: Extend IngestionServer with dispatch context API and payload stamping (AC: #1, #3, #8)
  - [ ] Define `DispatchContext` interface: `{ taskType: string; phase: string; dispatchId: string }` in `ingestion-server.ts`
  - [ ] Add `private activeDispatches: Map<string, DispatchContext> = new Map()` field
  - [ ] Implement `setActiveDispatch(storyKey: string, context: DispatchContext): void`
  - [ ] Implement `clearActiveDispatch(storyKey: string): void` (no-op if key absent)
  - [ ] In the HTTP handler, after parsing the request body, extract `storyKey` from resource attributes, look up context in `activeDispatches`, and attach `dispatchContext` to the payload object before calling `batchBuffer.add()`

- [ ] Task 2: Extend type definitions for dispatch context propagation (AC: #4, #5)
  - [ ] Add optional `taskType?: string`, `phase?: string`, `dispatchId?: string` to the `NormalizedLog` interface in `src/modules/telemetry/normalizer.ts`
  - [ ] Extend `TurnAnalysisSchema` in `src/modules/telemetry/types.ts` with `.optional()` fields: `taskType`, `phase`, `dispatchId` (all `z.string().optional()`)
  - [ ] Update `RawOtlpPayload` (or the internal payload type) in `ingestion-server.ts` to include optional `dispatchContext?: DispatchContext`

- [ ] Task 3: Update TelemetryNormalizer to propagate dispatch context to NormalizedLog (AC: #4, #9)
  - [ ] In `normalizeLog()` in `src/modules/telemetry/normalizer.ts`, accept the stamped payload's `dispatchContext` (pass it through from the caller or access via the payload object)
  - [ ] Copy `taskType`, `phase`, `dispatchId` from `dispatchContext` to the constructed `NormalizedLog` (null-safe: skip if dispatchContext is absent)

- [ ] Task 4: Update LogTurnAnalyzer to copy dispatch context to TurnAnalysis output (AC: #5, #9)
  - [ ] In `src/modules/telemetry/log-turn-analyzer.ts`, after grouping and deduplicating logs into turn groups, extract `taskType`, `phase`, `dispatchId` from the representative (first/earliest) log in each group
  - [ ] Include these fields in the constructed `TurnAnalysis` object (omit the key entirely if undefined)

- [ ] Task 5: Schema migration and persistence updates (AC: #6)
  - [ ] In `src/modules/state/schema.sql`, add `task_type TEXT`, `phase TEXT`, `dispatch_id TEXT` nullable columns to the `turn_analysis` CREATE TABLE statement (and an ALTER TABLE block for existing Dolt repos)
  - [ ] Update the turn_analysis INSERT/UPSERT in TelemetryPipeline or TelemetryPersistence to write the three new columns when present (use NULL when absent)
  - [ ] Update any SELECT queries on turn_analysis to include the new columns so reads return them

- [ ] Task 6: Wire orchestrator to call set/clear around all dispatch call sites (AC: #2)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, identify every `dispatcher.dispatch()` call site (dev-story, code-review, create-story, minor-fixes, major-rework)
  - [ ] Before each dispatch call, invoke `deps.ingestionServer?.setActiveDispatch(storyKey, { taskType, phase: 'dispatch', dispatchId: crypto.randomUUID() })` — use the same `taskType` string already passed to `DispatchRequest`
  - [ ] Wrap each dispatch in a try/finally, calling `deps.ingestionServer?.clearActiveDispatch(storyKey)` in the `finally` block

- [ ] Task 7: Update CLI metrics --turns display (AC: #7)
  - [ ] In the metrics `--turns` CLI handler (likely `src/cli/commands/metrics.ts`), add `task_type` and `phase` columns to the output table
  - [ ] Render the column value or "-" when null/undefined
  - [ ] Position columns after `name` or `turn_number` for readability

- [ ] Task 8: Tests — unit and integration (AC: #1, #2, #3, #8, #9)
  - [ ] Add unit tests for `setActiveDispatch` / `clearActiveDispatch` lifecycle (set, clear, double-clear no-op)
  - [ ] Add unit test for payload stamping: payload with matching storyKey gets context; payload with non-matching storyKey gets null context
  - [ ] Add integration test: dispatch context flows end-to-end from `setActiveDispatch` → NormalizedLog.taskType → TurnAnalysis.taskType
  - [ ] Add concurrent isolation test: two storyKeys with different contexts produce correctly isolated TurnAnalysis records
  - [ ] Add graceful degradation test: payload with no storyKey produces TurnAnalysis with no taskType (no error thrown)

## Dev Notes

### Architecture Constraints

- **File locations** (must match exactly):
  - IngestionServer: `src/modules/telemetry/ingestion-server.ts` — add Map, two public methods, stamp in HTTP handler
  - Normalizer types: `src/modules/telemetry/normalizer.ts` — extend `NormalizedLog` interface (3 optional fields)
  - Telemetry types: `src/modules/telemetry/types.ts` — extend `TurnAnalysisSchema` (3 optional z.string fields)
  - LogTurnAnalyzer: `src/modules/telemetry/log-turn-analyzer.ts` — copy context fields in analyze()
  - Schema: `src/modules/state/schema.sql` — add nullable columns to turn_analysis
  - Orchestrator: `src/modules/implementation-orchestrator/orchestrator-impl.ts` — wrap all dispatch call sites
  - CLI: `src/cli/commands/metrics.ts` — add columns to --turns table output

- **Import style**: All imports use `.js` extensions (ESM). Use `crypto.randomUUID()` from Node built-ins (Node 18+, no import required).
- **Test framework**: Vitest — use `vi.mock`, `vi.fn()`, `vi.hoisted`, `describe`/`it`/`expect`. Do NOT use jest APIs.
- **Concurrency model**: The `activeDispatches` Map is keyed by storyKey. Node.js is single-threaded so Map operations are atomic. Each story dispatches phases sequentially (create-story → dev-story → code-review), so at most one dispatch context per storyKey is active at a time. Multiple storyKeys can be active simultaneously (parallel story execution) — the Map correctly isolates them.

### Stamping Pattern

The HTTP handler in IngestionServer buffers raw payloads. Stamping happens before `batchBuffer.add()`:

```typescript
// In HTTP handler, after parsing body:
const storyKey = extractStoryKeyFromPayload(parsedBody)
const dispatchContext = storyKey ? this.activeDispatches.get(storyKey) : undefined
this.batchBuffer.add({ body: parsedBody, source, receivedAt: Date.now(), dispatchContext })
```

`TelemetryNormalizer.normalizeLog()` then receives the payload object with an optional `dispatchContext` property and copies its fields to the `NormalizedLog`.

### Schema Migration Pattern

Check how Epic 27/28 stories added columns to the turn_analysis schema. For Dolt compatibility, standard `ALTER TABLE turn_analysis ADD COLUMN task_type TEXT` is valid SQL. Add the column declarations both in the `CREATE TABLE IF NOT EXISTS` block (for fresh inits) and as conditional `ALTER TABLE` statements guarded by existence checks (for existing repos). The new columns must be nullable with no DEFAULT to avoid Dolt schema conflicts.

### Testing Requirements

- **New test file**: `src/modules/telemetry/__tests__/ingestion-server-dispatch-context.test.ts` for IngestionServer context API and stamping
- **Update existing**: `src/modules/telemetry/__tests__/log-turn-analyzer.test.ts` — add tests for context propagation and graceful degradation
- **Update existing** (if applicable): persistence/pipeline tests to verify new columns are written
- **Coverage**: Must stay above 80% threshold. All new branches (context present, context absent, storyKey match, storyKey mismatch) must be exercised.
- **Test run**: Use `npm run test:fast` — never pipe output. Confirm results by looking for "Test Files" in output.

## Interface Contracts

- **Export**: `DispatchContext` interface @ `src/modules/telemetry/ingestion-server.ts` — consumed by `orchestrator-impl.ts` to call `setActiveDispatch`
- **Export**: Extended `NormalizedLog` (with optional `taskType`, `phase`, `dispatchId`) @ `src/modules/telemetry/normalizer.ts` — consumed by `LogTurnAnalyzer` (this story) and story 30-2 which reads `taskType` for task-aware categorization
- **Export**: Extended `TurnAnalysis` / `TurnAnalysisSchema` (with optional `taskType`, `phase`, `dispatchId`) @ `src/modules/telemetry/types.ts` — consumed by story 30-2 (categorization), story 30-3 (per-dispatch efficiency grouping), and story 30-6 (recommendation injection)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
