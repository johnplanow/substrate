# Story 27-11: Turn Analyzer Module

Status: review

## Story

As a substrate pipeline operator,
I want per-turn token breakdowns computed from normalized spans,
so that the efficiency scorer and recommender can analyze context growth, cache hit rates, and identify costly turns.

## Context — What Already Exists

This story builds the `turn-analyzer.ts` module that was originally part of 27-4 but never implemented. The following already exist and MUST NOT be recreated:

- `src/modules/telemetry/types.ts` — already has `TurnAnalysis` type, `TurnAnalysisSchema` Zod schema, `ChildSpanSummary`, `ChildSpanSummarySchema`
- `src/modules/telemetry/persistence.ts` — already has `storeTurnAnalysis()` and `getTurnAnalysis()` methods working with SQLite
- `src/modules/state/schema.sql` — already has `turn_analysis` table definition
- `src/modules/telemetry/efficiency-scorer.ts` — already consumes `TurnAnalysis[]` (this story produces what it needs)

**The ONLY missing piece is `turn-analyzer.ts`** — the module that takes `NormalizedSpan[]` and produces `TurnAnalysis[]`.

## Acceptance Criteria

### AC1: Chronological Turn Ordering and Metrics
**Given** a list of `NormalizedSpan` records for a story
**When** `TurnAnalyzer.analyze(spans)` is called
**Then** spans are ordered chronologically by `startTime`, assigned sequential `turnNumber` starting at 1, with correctly computed `freshTokens`, `cacheHitRate`, `contextSize` (running cumulative), and `contextDelta`

### AC2: Child Span Drill-Down
**Given** spans with parent-child relationships via `parentSpanId`
**When** the analyzer processes root-level spans
**Then** each `TurnAnalysis` includes a `childSpans` array of tool calls within that turn

### AC3: Context Spike Detection
**Given** a completed turn sequence
**When** average `inputTokens` is computed
**Then** turns with `inputTokens > 2x average` have `isContextSpike: true`; zero average = no spikes

### AC4: Unit Tests
**Given** the turn analyzer implementation
**When** tests run
**Then** coverage includes: chronological ordering, freshTokens/cacheHitRate calculation, contextSize accumulation, spike detection, child span grouping, empty input, single-span edge case

## Tasks / Subtasks

- [ ] Task 1: Implement `src/modules/telemetry/turn-analyzer.ts`
  - Constructor: `new TurnAnalyzer(logger: ILogger)`
  - `analyze(spans: NormalizedSpan[]): TurnAnalysis[]`
  - Filter to root-level spans (parentSpanId absent or not matching any spanId in input set)
  - Sort by startTime ascending, assign turnNumber 1-N
  - Compute: `freshTokens = inputTokens - cacheReadTokens`
  - Compute: `cacheHitRate = inputTokens > 0 ? cacheReadTokens / inputTokens : 0`
  - Running contextSize accumulation, contextDelta
  - Group child spans by parentSpanId → ChildSpanSummary[]
  - Apply spike detection: `isContextSpike = avg > 0 && inputTokens > 2 * avg`
- [ ] Task 2: Unit tests in `src/modules/telemetry/__tests__/turn-analyzer.test.ts`
  - Empty spans → empty array
  - Single span → turnNumber 1, contextDelta = inputTokens
  - Three spans sorted regardless of input order
  - freshTokens and cacheHitRate correctness
  - cacheHitRate = 0 when inputTokens = 0
  - contextSize accumulates correctly
  - Spike detection with >2x threshold
  - Child spans grouped into correct parent
- [ ] Task 3: Export `TurnAnalyzer` from `src/modules/telemetry/index.ts`

## Dev Notes

### Architecture Constraints
- Constructor injection: accepts `ILogger`, never instantiates concrete logger
- No external dependencies
- Import `NormalizedSpan`, `TurnAnalysis`, `ChildSpanSummary` from `./types.ts`

### Root Span Identification
```typescript
const allSpanIds = new Set(spans.map(s => s.spanId))
const rootSpans = spans.filter(s => !s.parentSpanId || !allSpanIds.has(s.parentSpanId))
```

### Context Accumulation
```typescript
let runningContext = 0
for (const turn of orderedTurns) {
  const prevContext = runningContext
  runningContext += turn.inputTokens
  turn.contextSize = runningContext
  turn.contextDelta = runningContext - prevContext
}
```

### Spike Detection Edge Cases
- Single turn: cannot be >2x itself → never spike
- All equal: none exceeds 2x average → no spikes
- Zero-token turns: treat cacheHitRate as 0 and freshTokens as 0

### File Paths
```
src/modules/telemetry/
  turn-analyzer.ts           <- NEW
  __tests__/
    turn-analyzer.test.ts    <- NEW
```

## Interface Contracts

- **Import**: `NormalizedSpan`, `TurnAnalysis`, `ChildSpanSummary` from `./types.ts`
- **Export**: `TurnAnalyzer` class via `index.ts`
- **Consumed by**: Story 27-12 (ingestion wiring), efficiency-scorer (already exists)
