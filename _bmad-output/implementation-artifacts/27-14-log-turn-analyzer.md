# Story 27-14: Log-Based Turn Analyzer

Status: ready-for-dev

## Story

As a substrate pipeline operator,
I want the telemetry pipeline to synthesize turn analysis from OTLP log records (not just trace spans),
so that telemetry data is captured and analyzed even when the agent runtime (Claude Code) exports logs and metrics but not traces.

## Context — What Already Exists

**The gap:** The current `TelemetryPipeline.processBatch()` normalizes both spans and logs from OTLP payloads, but the analysis pipeline only processes spans. If `allSpans.length === 0`, the pipeline returns early at `telemetry-pipeline.ts:133` — discarding all normalized logs. Claude Code currently exports OTLP logs and metrics but NOT trace spans, so the entire analysis pipeline is dead code in practice.

**What exists:**
- `src/modules/telemetry/normalizer.ts` — `TelemetryNormalizer.normalizeLog()` already extracts `NormalizedLog[]` from OTLP payloads. Each log has: `logId`, `traceId`, `spanId`, `timestamp`, `severity`, `body`, `eventName`, `sessionId`, `toolName`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `costUsd`, `model`
- `src/modules/telemetry/turn-analyzer.ts` — `TurnAnalyzer.analyze(spans: NormalizedSpan[])` produces `TurnAnalysis[]` from spans
- `src/modules/telemetry/types.ts` — `TurnAnalysis` type with all fields downstream consumers expect

**What this story adds:** A `LogTurnAnalyzer` class that produces the same `TurnAnalysis[]` output from `NormalizedLog[]` input, enabling the full analysis pipeline to work with log data.

## Acceptance Criteria

### AC1: LogTurnAnalyzer Produces TurnAnalysis from Logs
**Given** an array of `NormalizedLog` records from a single story
**When** `LogTurnAnalyzer.analyze(logs)` is called
**Then** it returns `TurnAnalysis[]` with the same shape as `TurnAnalyzer.analyze(spans)`, ordered chronologically by timestamp

### AC2: Token Fields Mapped from Log Records
**Given** a `NormalizedLog` with `inputTokens`, `outputTokens`, `cacheReadTokens`, `costUsd`, and `model` fields
**When** the log is converted to a `TurnAnalysis` entry
**Then** the corresponding `TurnAnalysis` fields are populated: `inputTokens`, `outputTokens`, `cacheReadTokens`, `freshTokens` (inputTokens - cacheReadTokens), `cacheHitRate` (cacheReadTokens / inputTokens), `costUsd`, `model`

### AC3: Context Growth Tracking from Logs
**Given** a sequence of logs ordered by timestamp
**When** turn analysis is computed
**Then** `contextSize` is the running cumulative of `inputTokens`, `contextDelta` is the difference from the previous turn, and turns with `contextDelta > 2x` the running average are flagged (consistent with span-based TurnAnalyzer behavior)

### AC4: Story Key Extraction
**Given** a `NormalizedLog` with resource attributes containing `substrate.story_key`
**When** the log is processed
**Then** the `storyKey` is extracted and used for grouping (falls back to `__unknown__` if absent)

### AC5: Deduplication and Grouping
**Given** multiple logs that represent the same LLM turn (same `traceId` + `spanId` combination)
**When** logs are analyzed
**Then** they are merged into a single `TurnAnalysis` entry with summed token counts

### AC6: Never Throws
**Given** malformed or empty log data
**When** `LogTurnAnalyzer.analyze()` is called
**Then** it returns an empty array and logs a warning (never throws)

## Tasks / Subtasks

- [ ] Task 1: Create `src/modules/telemetry/log-turn-analyzer.ts`
  - [ ] `LogTurnAnalyzer` class with constructor injection of `ILogger`
  - [ ] `analyze(logs: NormalizedLog[]): TurnAnalysis[]` public method
  - [ ] Sort logs by timestamp chronologically
  - [ ] Group by `traceId + spanId` for deduplication (merge token counts)
  - [ ] Assign sequential `turnNumber` starting at 1
  - [ ] Compute `freshTokens`, `cacheHitRate`, `contextSize`, `contextDelta`
  - [ ] Extract `storyKey` from log attributes or `sessionId`
  - [ ] Wrap in try/catch, return `[]` on error
- [ ] Task 2: Export from `src/modules/telemetry/index.ts`
  - [ ] Add `LogTurnAnalyzer` to barrel export
- [ ] Task 3: Unit tests in `src/modules/telemetry/__tests__/log-turn-analyzer.test.ts`
  - [ ] Single log → single turn analysis
  - [ ] Multiple logs → chronologically ordered turns
  - [ ] Token field mapping (input, output, cache, fresh, cost)
  - [ ] Context growth tracking (cumulative, delta, spike detection)
  - [ ] Deduplication: same traceId+spanId merged
  - [ ] Empty input → empty output
  - [ ] Malformed logs → empty output + warning logged
  - [ ] Missing token fields → zero defaults

## Dev Notes

### Architecture Constraints
- Output type MUST be `TurnAnalysis[]` — the exact same type `TurnAnalyzer` produces from spans
- Constructor injection of `ILogger` (pino-compatible)
- Never throw from public methods
- No new dependencies

### Key Type Reference
```typescript
// From types.ts — the output shape (DO NOT modify)
interface TurnAnalysis {
  spanId: string
  turnNumber: number
  name: string
  timestamp: number
  source: string
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  freshTokens: number
  cacheHitRate: number
  costUsd: number
  durationMs: number
  contextSize: number
  contextDelta: number
  toolName?: string
}
```

### File Paths
```
src/modules/telemetry/
  log-turn-analyzer.ts           <- NEW
  index.ts                       <- MODIFY (add export)
  __tests__/
    log-turn-analyzer.test.ts    <- NEW
```

## Interface Contracts

- **Import**: `NormalizedLog`, `TurnAnalysis` from `./types.js`
- **Export**: `LogTurnAnalyzer` class
- **Consumed by**: Story 27-15 (TelemetryPipeline dual-track)

## Dependencies

- None — uses only existing types
