# Story 27-12: Ingestion Pipeline Wiring

Status: ready-for-dev

## Story

As a substrate pipeline operator,
I want the OTLP ingestion server to parse, normalize, analyze, and persist telemetry data end-to-end,
so that when child agents emit OTLP, the data flows through the full pipeline: ingestion → normalization → turn analysis → categorization → efficiency scoring → recommendations → persistence.

## Context — What Already Exists

This story wires together all the pieces that already exist but aren't connected:

**Ingestion (exists but stubs processing):**
- `src/modules/telemetry/ingestion-server.ts` — HTTP server accepts OTLP payloads, responds 200, but does NOT parse/normalize/persist them. Line ~149: "Accept all OTLP payloads — future stories will parse and persist them."

**Analysis pipeline (exists, fully functional):**
- `src/modules/telemetry/categorizer.ts` — semantic categorization
- `src/modules/telemetry/consumer-analyzer.ts` — consumer grouping
- `src/modules/telemetry/efficiency-scorer.ts` — composite scoring
- `src/modules/telemetry/recommender.ts` — 8 heuristic rules

**Persistence (exists, SQLite):**
- `src/modules/telemetry/persistence.ts` — storeTurnAnalysis, storeEfficiencyScore, saveRecommendations, storeCategoryStats, storeConsumerStats

**New from Sprint 4 (stories 27-10, 27-11):**
- `normalizer.ts` — TelemetryNormalizer (OTLP → NormalizedSpan/Log)
- `turn-analyzer.ts` — TurnAnalyzer (spans → TurnAnalysis[])

**Orchestrator integration (exists):**
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` lines 2139-2149 — starts ingestion server, captures OTLP endpoint
- `src/adapters/claude-adapter.ts` lines 159-168 — injects OTLP env vars

## Acceptance Criteria

### AC1: Batch Buffer with Source Detection
**Given** OTLP payloads arriving at the ingestion server
**When** the buffer reaches 100 items OR 5 seconds have elapsed
**Then** the server emits a batch event with collected items, each tagged with detected source (claude-code, codex, local-llm, unknown)

### AC2: Batch Processing Pipeline
**Given** a batch flush event is emitted
**When** the batch handler processes it
**Then** it calls TelemetryNormalizer to produce NormalizedSpan[] and NormalizedLog[], runs TurnAnalyzer on the spans, runs Categorizer and ConsumerAnalyzer, computes EfficiencyScore, generates Recommendations, and persists all results via TelemetryPersistence

### AC3: Source Detection from OTLP Resource Attributes
**Given** an incoming OTLP payload with resource attributes
**When** the server parses the payload
**Then** it extracts `service.name` and `telemetry.sdk.name` attributes and classifies the source as `claude-code`, `codex`, `local-llm`, or `unknown`

### AC4: Graceful Error Handling
**Given** a malformed OTLP payload or normalizer error
**When** the batch handler encounters it
**Then** it logs a warning and continues processing remaining items in the batch (no crash, no data loss for valid items)

### AC5: Pipeline Lifecycle
**Given** the ingestion server is running during a pipeline execution
**When** `stop()` is called
**Then** any remaining buffered items are flushed and processed before the server closes

## Tasks / Subtasks

- [ ] Task 1: Implement `src/modules/telemetry/source-detector.ts`
  - `detectSource(body: unknown): OtlpSource` — check resource.attributes for service.name/telemetry.sdk.name
  - Source detection table: claude-code, codex, ollama|llama|local → local-llm, else unknown
  - Handle both resourceSpans and resourceLogs envelope formats
- [ ] Task 2: Implement `src/modules/telemetry/batch-buffer.ts`
  - `BatchBuffer` class with configurable batchSize (default 100) and flushIntervalMs (default 5000)
  - `push(item)` — adds item, triggers flush if size reached
  - `start()` / `stop()` — interval management
  - EventEmitter pattern: emits 'flush' event with items array
  - `stop()` flushes remaining items before clearing interval
- [ ] Task 3: Implement batch processing handler in `src/modules/telemetry/telemetry-pipeline.ts`
  - `TelemetryPipeline` class that wires: normalizer → turnAnalyzer → categorizer → consumerAnalyzer → efficiencyScorer → recommender → persistence
  - `processBatch(items: RawOtlpPayload[])` method
  - Accepts all dependencies via constructor injection
  - Groups normalized spans by storyKey for per-story analysis
  - Error handling: try/catch per item, log warnings, continue
- [ ] Task 4: Update `src/modules/telemetry/ingestion-server.ts`
  - Replace the stub payload handler with real processing:
    - Parse JSON body → detect source → push to BatchBuffer
    - On batch flush → call TelemetryPipeline.processBatch()
  - Add BatchBuffer lifecycle to start()/stop()
  - Keep getOtlpEnvVars() and health endpoint unchanged
- [ ] Task 5: Update orchestrator wiring in `src/modules/implementation-orchestrator/orchestrator-impl.ts`
  - When creating IngestionServer, also create TelemetryPipeline with all dependencies
  - Pass TelemetryPipeline to IngestionServer (or wire via event listener)
  - Ensure TelemetryPersistence is available (create from existing state store)
- [ ] Task 6: Unit tests for source-detector, batch-buffer, and telemetry-pipeline
  - Source detector: all 4 classifications + missing attributes
  - Batch buffer: size-triggered flush, time-triggered flush (fake timers), drain on stop
  - Pipeline: mock all dependencies, verify correct call sequence
- [ ] Task 7: Integration test: POST OTLP payload → verify data flows through to persistence

## Dev Notes

### Architecture Constraints
- Use `node:http` (built-in) — no external HTTP framework
- Constructor injection for all classes
- EventEmitter pattern for batch notification
- No Dolt writes — use existing SQLite TelemetryPersistence
- Never crash on bad data — log and skip

### Source Detection Table
```typescript
const SOURCE_DETECTION_TABLE = [
  { pattern: /claude[\s-]?code/i, source: 'claude-code' },
  { pattern: /codex/i, source: 'codex' },
  { pattern: /ollama|llama|local/i, source: 'local-llm' },
]
```

### OTLP Resource Attribute Extraction
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

### File Paths
```
src/modules/telemetry/
  source-detector.ts         <- NEW
  batch-buffer.ts            <- NEW
  telemetry-pipeline.ts      <- NEW
  ingestion-server.ts        <- MODIFY (replace stub with real processing)
  __tests__/
    source-detector.test.ts  <- NEW
    batch-buffer.test.ts     <- NEW
    telemetry-pipeline.test.ts <- NEW
src/modules/implementation-orchestrator/
  orchestrator-impl.ts       <- MODIFY (wire TelemetryPipeline)
```

### Key Constraint: Existing Tests Must Pass
The existing ingestion-server tests (89 + 109 lines) must continue to pass. The modifications to ingestion-server.ts must be backwards-compatible with the existing test expectations.

## Interface Contracts

- **Import**: `TelemetryNormalizer` from story 27-10
- **Import**: `TurnAnalyzer` from story 27-11
- **Import**: `Categorizer`, `ConsumerAnalyzer`, `EfficiencyScorer`, `Recommender` (all exist)
- **Import**: `TelemetryPersistence` (exists)
- **Export**: `TelemetryPipeline`, `BatchBuffer`, `detectSource`

## Dependencies

- **MUST run after**: 27-10 (normalizer) and 27-11 (turn analyzer)
