# Story 27-1: OTLP Ingestion Endpoint

Status: ready-for-dev

## Story

As a substrate pipeline operator,
I want substrate to expose an OTLP/HTTP JSON ingestion server,
so that child agents can emit OpenTelemetry telemetry that substrate captures and buffers for downstream analysis.

## Acceptance Criteria

### AC1: OTLP HTTP Endpoints Exposed
**Given** the ingestion server is started on a configurable port (default 4318)
**When** a client sends a POST to `/v1/traces`, `/v1/logs`, or `/v1/metrics`
**Then** the server accepts the OTLP/HTTP JSON payload, returns HTTP 200 with `{"partialSuccess": {}}`, and enqueues the raw payload in the in-memory buffer

### AC2: Standard OTLP JSON Payload Accepted
**Given** a standard OTLP protobuf-as-JSON payload (ResourceSpans / ResourceLogs / ResourceMetrics envelope)
**When** the server receives the request body
**Then** it parses it as JSON without transformation, preserves the full structure in the buffer, and rejects non-JSON bodies with HTTP 400

### AC3: Pipeline Lifecycle Integration
**Given** a pipeline run is starting
**When** the orchestrator calls `IngestionServer.start()`
**Then** the HTTP server binds to the configured port and begins accepting connections; when `IngestionServer.stop()` is called, the server drains the buffer with one final flush and closes the socket

### AC4: Source Detection from OTLP Resource Attributes
**Given** an incoming OTLP payload with resource attributes
**When** the server parses the payload
**Then** it extracts `service.name` and `telemetry.sdk.name` attributes and classifies the source as `claude-code`, `codex`, `local-llm`, or `unknown` according to the detection table, attaching `detectedSource` to each buffered item

### AC5: Batch Flushing (100 Events or 5 Seconds)
**Given** raw payloads accumulating in the in-memory buffer
**When** the buffer reaches 100 items OR 5 seconds have elapsed since the last flush
**Then** the server emits a `batch` event with the collected items and resets the buffer and timer; flush is also triggered on `stop()`

### AC6: Health Endpoint
**Given** the ingestion server is running
**When** a client sends `GET /health`
**Then** the server returns HTTP 200 with `{"status":"ok","port":<port>,"buffered":<count>,"uptime":<seconds>}`

### AC7: Port Conflict Error Handling
**Given** the configured port is already in use
**When** `IngestionServer.start()` is called
**Then** the server throws an `AppError` with code `ERR_TELEMETRY_PORT_CONFLICT` and exit code 2, with a message indicating the port number

## Tasks / Subtasks

- [ ] Task 1: Define raw OTLP types and source detection in `src/modules/telemetry/types.ts` (AC: #1, #4)
  - [ ] Define `OtlpSource` union type: `'claude-code' | 'codex' | 'local-llm' | 'unknown'`
  - [ ] Define `RawOtlpPayload` interface: `{ kind: 'traces' | 'logs' | 'metrics'; body: unknown; detectedSource: OtlpSource; receivedAt: number }`
  - [ ] Define `BatchFlushEvent` type: `{ items: RawOtlpPayload[]; flushedAt: number }`
  - [ ] Define `IngestionServerConfig` interface: `{ port?: number; batchSize?: number; flushIntervalMs?: number }`
  - [ ] Export `SOURCE_DETECTION_TABLE` mapping `service.name` / `telemetry.sdk.name` patterns to `OtlpSource`

- [ ] Task 2: Implement source detection helper (AC: #4)
  - [ ] Create `detectSource(resourceAttributes: Record<string, unknown>): OtlpSource` in `src/modules/telemetry/source-detector.ts`
  - [ ] Check `service.name` and `telemetry.sdk.name` attribute values (case-insensitive)
  - [ ] Map: `claude-code` → `claude-code`, `codex` → `codex`, `ollama|llama|local` → `local-llm`, else → `unknown`
  - [ ] Extract attributes from nested OTLP resource structure: `resource.attributes[]` array of `{key, value: {stringValue}}` pairs
  - [ ] Unit tests: all four source classifications + missing attributes returns `unknown`

- [ ] Task 3: Implement in-memory batch buffer (AC: #5)
  - [ ] Create `BatchBuffer` class in `src/modules/telemetry/batch-buffer.ts`
  - [ ] Constructor accepts `batchSize: number`, `flushIntervalMs: number`, `onFlush: (event: BatchFlushEvent) => void`
  - [ ] `push(item: RawOtlpPayload): void` — adds item, flushes immediately if buffer reaches `batchSize`
  - [ ] `start(): void` — starts interval timer for time-based flushing
  - [ ] `stop(): void` — flushes remaining items then clears interval
  - [ ] `size(): number` — returns current buffer count
  - [ ] Unit tests: size-triggered flush, time-triggered flush (use fake timers), drain on stop, empty stop is no-op

- [ ] Task 4: Implement `IngestionServer` class in `src/modules/telemetry/ingestion-server.ts` (AC: #1, #2, #3, #6, #7)
  - [ ] Use Node built-in `node:http` — no external HTTP framework dependency
  - [ ] Constructor: `new IngestionServer(config: IngestionServerConfig, logger: ILogger)`
  - [ ] `start(): Promise<void>` — binds HTTP server, starts `BatchBuffer`, rejects with `AppError(ERR_TELEMETRY_PORT_CONFLICT, 2)` on EADDRINUSE
  - [ ] `stop(): Promise<void>` — calls `batchBuffer.stop()` (final flush), then closes HTTP server
  - [ ] `on('batch', handler: (event: BatchFlushEvent) => void)` — EventEmitter pattern for batch consumers
  - [ ] Route handler for `POST /v1/traces|logs|metrics`: parse JSON body, call `detectSource`, push to buffer, return 200
  - [ ] Route handler for `GET /health`: return 200 JSON with status/port/buffered/uptime
  - [ ] Return 400 for unparseable JSON bodies; 404 for unknown routes; 405 for wrong method on OTLP endpoints

- [ ] Task 5: Add telemetry error codes to `src/errors/` (AC: #7)
  - [ ] Add `ERR_TELEMETRY_PORT_CONFLICT` to the existing error codes catalogue (wherever other `ERR_*` codes are defined)
  - [ ] Ensure `AppError` subclass or factory pattern is followed consistently with existing error patterns in the codebase

- [ ] Task 6: Unit tests for `IngestionServer` in `src/modules/telemetry/__tests__/ingestion-server.test.ts` (AC: #1, #2, #3, #6, #7)
  - [ ] Mock `node:http` to avoid real port binding in unit tests
  - [ ] Test: `POST /v1/traces` returns 200 and pushes to buffer
  - [ ] Test: `POST /v1/logs` and `POST /v1/metrics` accepted
  - [ ] Test: invalid JSON body returns 400
  - [ ] Test: `GET /health` returns correct shape
  - [ ] Test: EADDRINUSE on start throws `AppError` with `ERR_TELEMETRY_PORT_CONFLICT`
  - [ ] Test: `stop()` triggers final buffer flush before closing server

- [ ] Task 7: Integration test for full ingestion lifecycle in `src/modules/telemetry/__tests__/ingestion-server.integration.test.ts` (AC: #1, #2, #3, #4, #5, #6)
  - [ ] Bind server to OS-assigned port (`port: 0`) to avoid conflicts
  - [ ] Send real HTTP requests using `node:http` client
  - [ ] Test: POST Claude Code OTLP trace payload → source detected as `claude-code`
  - [ ] Test: POST payload with unknown `service.name` → source detected as `unknown`
  - [ ] Test: 100 POSTs trigger immediate batch flush event
  - [ ] Test: `stop()` after partial batch emits final flush with remaining items
  - [ ] Test: `GET /health` reflects correct buffered count and uptime

- [ ] Task 8: Export public API from `src/modules/telemetry/index.ts` (AC: #3)
  - [ ] Export `IngestionServer`, `IngestionServerConfig`, `BatchFlushEvent`, `RawOtlpPayload`, `OtlpSource`
  - [ ] Do NOT export internal implementation classes (`BatchBuffer`, `detectSource`) — keep them package-private
  - [ ] Verify `npm run build` passes with zero type errors after all files are added

## Dev Notes

### Architecture Constraints
- Use **`node:http`** (built-in) — do not add Express, Fastify, or any HTTP framework. The OTLP server is internal infrastructure with a tiny route table.
- Follow **constructor injection**: `IngestionServer` accepts an `ILogger` interface, not a concrete logger instance. This enables unit testing without real logging side-effects.
- Follow **EventEmitter pattern** for batch notification: `IngestionServer extends EventEmitter` and emits `'batch'` events. Downstream stories (27-2 normalization, 27-3 persistence) will attach listeners.
- **No Dolt writes in this story** — buffering and event emission only. Persistence is story 27-3's concern.
- **File naming**: `ingestion-server.ts`, `batch-buffer.ts`, `source-detector.ts`, `types.ts` (all kebab-case). Classes: `IngestionServer`, `BatchBuffer`. No `I`-prefix for non-injected interfaces.
- **Import order**: `node:http`, `node:events` (built-ins first), then third-party, then internal modules — blank line between groups.
- **Error codes**: Look at existing `src/errors/` to find where `ERR_*` codes are defined; follow the exact same pattern.

### File Paths
```
src/modules/telemetry/
  types.ts                    ← RawOtlpPayload, OtlpSource, BatchFlushEvent, IngestionServerConfig
  source-detector.ts          ← detectSource() function + SOURCE_DETECTION_TABLE
  batch-buffer.ts             ← BatchBuffer class
  ingestion-server.ts         ← IngestionServer class (extends EventEmitter)
  index.ts                    ← public exports
  __tests__/
    ingestion-server.test.ts          ← unit tests (mocked http)
    ingestion-server.integration.test.ts  ← integration tests (real port)
    batch-buffer.test.ts              ← unit tests (fake timers)
    source-detector.test.ts           ← unit tests
```

### Source Detection Table
```typescript
// Priority order: check service.name first, then telemetry.sdk.name
const SOURCE_DETECTION_TABLE: Array<{ pattern: RegExp; source: OtlpSource }> = [
  { pattern: /claude[\s-]?code/i,   source: 'claude-code' },
  { pattern: /codex/i,              source: 'codex' },
  { pattern: /ollama|llama|local/i, source: 'local-llm' },
]
```

### OTLP Resource Attribute Extraction
OTLP protobuf-as-JSON wraps attribute values in a typed union. For string values:
```json
{
  "resourceSpans": [{
    "resource": {
      "attributes": [
        { "key": "service.name", "value": { "stringValue": "claude-code" } }
      ]
    }
  }]
}
```
The `detectSource` function should traverse `body.resourceSpans[0]?.resource?.attributes` (or `resourceLogs`/`resourceMetrics` equivalents) to find relevant keys.

### Batch Buffer Behavior
- Timer resets on every flush (size-triggered or time-triggered)
- `stop()` cancels the interval timer THEN flushes remaining items — prevents double-flush race
- If buffer is empty at flush time, do NOT emit the `batch` event (avoid noise)

### Testing Requirements
- **Unit tests** (`ingestion-server.test.ts`): mock `node:http` using `vi.mock('node:http', ...)` — never bind real ports
- **Integration tests** (`ingestion-server.integration.test.ts`): use `port: 0` for OS-assigned ephemeral port; retrieve the actual port from `server.address().port` after `listen`
- **Fake timers**: `batch-buffer.test.ts` must use `vi.useFakeTimers()` / `vi.runAllTimersAsync()` to test time-based flushing without real waits
- **Coverage**: target ≥80% for all new files; integration test counts toward this
- **Test naming convention**: `src/modules/telemetry/__tests__/*.test.ts` — co-located with implementation

### Logger Interface
Use the existing `ILogger` / `createLogger` pattern already present in the codebase (see other modules for the import path). Pass `createLogger('telemetry:ingestion')` as the default.

## Interface Contracts

- **Export**: `RawOtlpPayload` @ `src/modules/telemetry/types.ts` (consumed by story 27-2 normalization engine)
- **Export**: `OtlpSource` @ `src/modules/telemetry/types.ts` (consumed by story 27-2)
- **Export**: `BatchFlushEvent` @ `src/modules/telemetry/types.ts` (consumed by story 27-2 and 27-3)
- **Export**: `IngestionServer` @ `src/modules/telemetry/ingestion-server.ts` (consumed by story 27-9 pipeline integration)
- **Export**: `IngestionServerConfig` @ `src/modules/telemetry/types.ts` (consumed by story 27-9 config schema)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
