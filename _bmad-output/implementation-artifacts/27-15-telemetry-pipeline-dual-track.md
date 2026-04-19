# Story 27-15: TelemetryPipeline Dual-Track (Spans + Logs)

Status: review

## Story

As a substrate pipeline operator,
I want the telemetry pipeline to process OTLP logs alongside spans for turn analysis,
so that telemetry data is captured regardless of whether the agent runtime exports traces, logs, or both.

## Context — What Already Exists

**The gap:** `TelemetryPipeline.processBatch()` at `telemetry-pipeline.ts:133` early-returns when `allSpans.length === 0`. This discards all normalized logs even though they contain rich token/model/timing data. Claude Code exports logs and metrics, not traces — so the pipeline never reaches analysis or persistence.

**What exists:**
- `src/modules/telemetry/telemetry-pipeline.ts` — `processBatch()` normalizes both spans and logs but only processes spans
- `src/modules/telemetry/turn-analyzer.ts` — `TurnAnalyzer.analyze(spans)` → `TurnAnalysis[]`
- Story 27-14 adds: `LogTurnAnalyzer.analyze(logs)` → `TurnAnalysis[]` (same output type)

**What this story changes:** Remove the early return, add a log-based analysis track, merge results from both tracks before feeding downstream analysis (categorizer, efficiency scorer, recommender, persistence).

## Acceptance Criteria

### AC1: No Early Return on Zero Spans
**Given** an OTLP batch containing only log records (no trace spans)
**When** `processBatch()` is called
**Then** the pipeline does NOT return early — it continues to process logs through the LogTurnAnalyzer

### AC2: Dual-Track Turn Analysis
**Given** an OTLP batch containing both spans and logs
**When** `processBatch()` is called
**Then** `TurnAnalyzer` processes spans AND `LogTurnAnalyzer` processes logs, producing two `TurnAnalysis[]` arrays that are merged (deduplicated by spanId) before downstream analysis

### AC3: Log-Only Path Produces Complete Analysis
**Given** an OTLP batch containing only log records
**When** the pipeline processes the batch
**Then** `LogTurnAnalyzer` produces `TurnAnalysis[]`, which feeds into efficiency scoring and persistence — resulting in non-empty `turn_analysis` and `efficiency_scores` tables

### AC4: Span-Only Path Unchanged
**Given** an OTLP batch containing only trace spans (no logs)
**When** the pipeline processes the batch
**Then** behavior is identical to the current implementation — `TurnAnalyzer` processes spans, downstream analysis runs as before (backwards compatible)

### AC5: Log Story Key Grouping
**Given** logs from multiple stories in one batch
**When** the pipeline groups by storyKey
**Then** logs are grouped using the same storyKey extraction logic as spans (resource attribute `substrate.story_key`), and each story's logs are analyzed independently

### AC6: Persistence Called for Log-Derived Turns
**Given** turn analysis produced from logs
**When** the analysis completes
**Then** `persistence.storeTurnAnalysis()` is called with the log-derived turns, and `persistence.storeEfficiencyScore()` is called with the computed efficiency score

## Tasks / Subtasks

- [x] Task 1: Add `LogTurnAnalyzer` dependency to `TelemetryPipeline` constructor
  - [x] Add `logTurnAnalyzer: LogTurnAnalyzer` to constructor options interface
  - [x] Store as `this._logTurnAnalyzer`
- [x] Task 2: Modify `processBatch()` in `telemetry-pipeline.ts`
  - [x] Remove the early return at line 133 (`if (allSpans.length === 0) return`)
  - [x] After normalizing spans and logs, check: if both are empty, return early
  - [x] Add log-based turn analysis: `const logTurns = this._logTurnAnalyzer.analyze(allLogs)`
  - [x] Group logs by storyKey (extract from log attributes, same logic as spans)
  - [x] For each story: merge span-derived turns + log-derived turns (dedupe by spanId)
  - [x] Feed merged turns into `_processStory()` or a new `_processStoryFromTurns()` method
- [x] Task 3: Add/modify `_processStoryFromTurns()` private method
  - [x] Accept `TurnAnalysis[]` directly (instead of computing from spans)
  - [x] Run efficiency scorer on turns
  - [x] Persist turn analysis and efficiency scores
  - [x] Categorizer and consumer analyzer remain span-only for now (story 27-16 addresses this)
- [x] Task 4: Update orchestrator wiring in `orchestrator-impl.ts`
  - [x] When creating `TelemetryPipeline`, pass `LogTurnAnalyzer` instance alongside existing dependencies
- [x] Task 5: Update existing tests in `telemetry-pipeline.test.ts`
  - [x] Add `logTurnAnalyzer` mock to pipeline constructor in all tests
  - [x] Verify existing span-based tests still pass (AC4)
- [x] Task 6: New tests for dual-track behavior
  - [x] Test: log-only batch → turns produced → persistence called
  - [x] Test: span-only batch → unchanged behavior
  - [x] Test: mixed batch → both analyzers called, results merged
  - [x] Test: empty batch → early return (no calls)
  - [x] Test: logs from multiple stories → grouped and analyzed independently
- [x] Task 7: Integration test update in `ingestion-pipeline.integration.test.ts`
  - [x] Add test: send log-only OTLP payload → verify persistence receives turn analysis

## Dev Notes

### Architecture Constraints
- `TurnAnalyzer` and `LogTurnAnalyzer` both produce `TurnAnalysis[]` — downstream consumers don't know or care which source produced the data
- Deduplication: if a span and a log have the same `spanId`, prefer the span-derived turn (richer data)
- Constructor injection — `LogTurnAnalyzer` is a required dependency (not optional)
- All existing tests must continue to pass

### Merge Strategy
```typescript
// Merge span-derived and log-derived turns, deduplicating by spanId
const spanTurnIds = new Set(spanTurns.map(t => t.spanId))
const uniqueLogTurns = logTurns.filter(t => !spanTurnIds.has(t.spanId))
const mergedTurns = [...spanTurns, ...uniqueLogTurns]
  .sort((a, b) => a.timestamp - b.timestamp)
  // Renumber turns sequentially
  .map((t, i) => ({ ...t, turnNumber: i + 1 }))
```

### File Paths
```
src/modules/telemetry/
  telemetry-pipeline.ts                    <- MODIFY
  __tests__/
    telemetry-pipeline.test.ts             <- MODIFY
    ingestion-pipeline.integration.test.ts <- MODIFY
src/modules/implementation-orchestrator/
  orchestrator-impl.ts                     <- MODIFY (wire LogTurnAnalyzer)
```

## Interface Contracts

- **Import**: `LogTurnAnalyzer` from story 27-14
- **Import**: `TurnAnalyzer`, `TelemetryNormalizer`, `Categorizer`, `ConsumerAnalyzer`, `EfficiencyScorer`, `Recommender` (all exist)
- **Export**: Updated `TelemetryPipeline` (same class, expanded behavior)

## Dependencies

- **MUST run after**: 27-14 (LogTurnAnalyzer)
