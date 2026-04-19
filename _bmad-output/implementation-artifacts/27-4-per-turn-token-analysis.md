# Story 27-4: Per-Turn Token Analysis

Status: ready-for-dev

## Story

As a substrate pipeline operator,
I want per-turn token breakdowns for every story execution,
so that I can identify which LLM turns consumed disproportionate tokens and where context growth accelerated costs.

## Acceptance Criteria

### AC1: TurnAnalysis Type Definition
**Given** the telemetry module is imported
**When** a consumer references `TurnAnalysis`
**Then** the type contains all required fields: `spanId`, `turnNumber`, `name`, `timestamp`, `source`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `freshTokens`, `cacheHitRate`, `costUsd`, `durationMs`, `contextSize`, `contextDelta`, `toolName`, `isContextSpike`, and `childSpans: ChildSpanSummary[]`

### AC2: Chronological Turn Ordering and Metrics Calculation
**Given** a list of `NormalizedSpan` records for a story (from 27-3's `getSpansForStory`)
**When** `TurnAnalyzer.analyze(spans)` is called
**Then** spans are ordered chronologically by `startTime`, assigned sequential `turnNumber` values starting at 1, and each turn has correctly computed `freshTokens = inputTokens - cacheReadTokens`, `cacheHitRate = cacheReadTokens / inputTokens` (0 if inputTokens is 0), `contextSize` (running cumulative inputTokens), and `contextDelta` (difference from previous turn's contextSize)

### AC3: Child Span Drill-Down Per Turn
**Given** spans with parent-child relationships (via `parentSpanId`)
**When** the analyzer processes a root-level LLM turn span
**Then** each `TurnAnalysis` entry includes a `childSpans` array listing tool calls and operations that occurred within that turn, each with `spanId`, `name`, `toolName`, `inputTokens`, `outputTokens`, `durationMs`

### AC4: Context Spike Detection
**Given** a completed sequence of turn analyses
**When** the average `inputTokens` across all turns is computed
**Then** any turn with `inputTokens > 2 × average` has `isContextSpike: true`; all other turns have `isContextSpike: false`; turns with zero average are never flagged

### AC5: turn_analysis Dolt Schema and Batch Storage
**Given** a completed `TurnAnalysis[]` result for a story
**When** `telemetryPersistence.storeTurnAnalysis(storyKey, turns)` is called
**Then** all turns are batch-inserted into the `turn_analysis` Dolt table (one commit per call, not per row), with `story_key` linking them to the pipeline run, and `child_spans_json` serializing the `childSpans` array as JSON

### AC6: getTurnAnalysis Query Method
**Given** turn analysis rows exist in Dolt for a given `storyKey`
**When** `telemetryPersistence.getTurnAnalysis(storyKey)` is called
**Then** it returns a `TurnAnalysis[]` in ascending `turn_number` order, with `child_spans_json` deserialized back into `ChildSpanSummary[]`, and an empty array if no rows exist

### AC7: Unit Tests Cover All Analysis Logic
**Given** unit tests in `src/modules/telemetry/__tests__/turn-analyzer.test.ts`
**When** the test suite runs via `npm run test:fast`
**Then** tests cover: chronological ordering, freshTokens and cacheHitRate calculation, contextSize accumulation, contextDelta per turn, context spike detection with >2x average threshold, child span grouping by parentSpanId, empty span list returns empty array, and single-span edge case

## Tasks / Subtasks

- [ ] Task 1: Extend type definitions in `src/modules/telemetry/types.ts` (AC: #1, #3)
  - [ ] Define `ChildSpanSummary` interface: `{ spanId: string; name: string; toolName?: string; inputTokens: number; outputTokens: number; durationMs: number }`
  - [ ] Define `TurnAnalysisSchema` Zod schema with all fields from AC1 (use `z.infer<>` to derive `TurnAnalysis` type)
  - [ ] Add `childSpans: z.array(ChildSpanSummarySchema)` to `TurnAnalysisSchema`
  - [ ] Export both types from `src/modules/telemetry/index.ts`

- [ ] Task 2: Implement `TurnAnalyzer` class in `src/modules/telemetry/turn-analyzer.ts` (AC: #2, #3)
  - [ ] Constructor: `new TurnAnalyzer(logger: ILogger)` — follow constructor injection pattern
  - [ ] `analyze(spans: NormalizedSpan[]): TurnAnalysis[]` — filter to root-level LLM spans (no parentSpanId or parentSpanId not in input set), sort by `startTime` ascending, assign `turnNumber` 1-N
  - [ ] Compute per-turn metrics: `freshTokens`, `cacheHitRate` (guard divide-by-zero), running `contextSize`, `contextDelta`
  - [ ] Build parent-child span map: group remaining spans by `parentSpanId`, assign to `childSpans` of each root turn
  - [ ] Map child spans to `ChildSpanSummary` (extract `toolName` from span attributes if present)
  - [ ] Return `isContextSpike: false` on first pass; spike detection runs in a separate step

- [ ] Task 3: Implement context spike detection in `TurnAnalyzer` (AC: #4)
  - [ ] Private method `markContextSpikes(turns: TurnAnalysis[]): TurnAnalysis[]`
  - [ ] Compute `avgInputTokens = sum(inputTokens) / count` across all turns
  - [ ] Flag each turn: `isContextSpike = avgInputTokens > 0 && inputTokens > 2 * avgInputTokens`
  - [ ] Call `markContextSpikes` at the end of `analyze()` before returning
  - [ ] Log a `debug` message listing spike turn numbers if any are found

- [ ] Task 4: Extend Dolt schema with `turn_analysis` table (AC: #5)
  - [ ] Add `CREATE TABLE IF NOT EXISTS turn_analysis` to `src/modules/state/schema.sql`
  - [ ] Columns: `story_key VARCHAR(64)`, `span_id VARCHAR(128)`, `turn_number INTEGER`, `name VARCHAR(255)`, `timestamp BIGINT`, `source VARCHAR(32)`, `model VARCHAR(64)`, `input_tokens INTEGER`, `output_tokens INTEGER`, `cache_read_tokens INTEGER`, `fresh_tokens INTEGER`, `cache_hit_rate DOUBLE`, `cost_usd DOUBLE`, `duration_ms INTEGER`, `context_size INTEGER`, `context_delta INTEGER`, `tool_name VARCHAR(128)`, `is_context_spike BOOLEAN`, `child_spans_json TEXT`, `PRIMARY KEY (story_key, span_id)`
  - [ ] Add index: `CREATE INDEX IF NOT EXISTS idx_turn_analysis_story ON turn_analysis (story_key, turn_number)`

- [ ] Task 5: Add storeTurnAnalysis and getTurnAnalysis to TelemetryPersistence (AC: #5, #6)
  - [ ] Extend `ITelemetryPersistence` interface in `src/modules/telemetry/persistence.ts` with two new methods
  - [ ] `storeTurnAnalysis(storyKey: string, turns: TurnAnalysis[]): Promise<void>` — prepare INSERT statement once at construction, batch-insert all turns in a transaction, serialize `childSpans` to JSON
  - [ ] `getTurnAnalysis(storyKey: string): Promise<TurnAnalysis[]>` — SELECT WHERE story_key = ?, ORDER BY turn_number ASC, deserialize `child_spans_json` back to `ChildSpanSummary[]` via `JSON.parse`, validate with Zod schema
  - [ ] Expose both methods from `src/modules/telemetry/index.ts`

- [ ] Task 6: Wire TurnAnalyzer into post-story telemetry pipeline (AC: #2, #5)
  - [ ] Identify the location in the orchestrator or metrics service where post-story processing occurs (after dev-story phase completes)
  - [ ] After story completion, call `telemetryPersistence.getSpansForStory(storyKey)` (from 27-3), pass result to `turnAnalyzer.analyze(spans)`, then call `telemetryPersistence.storeTurnAnalysis(storyKey, turns)`
  - [ ] Guard: skip if no spans returned (story ran without telemetry enabled)
  - [ ] Log info-level summary: turn count, total context spikes found, max context size

- [ ] Task 7: Unit tests for TurnAnalyzer (AC: #1, #2, #3, #4, #7)
  - [ ] File: `src/modules/telemetry/__tests__/turn-analyzer.test.ts`
  - [ ] Test: empty span array returns `[]`
  - [ ] Test: single span assigned `turnNumber: 1`, `contextSize = inputTokens`, `contextDelta = 0`
  - [ ] Test: three spans sorted chronologically regardless of input order
  - [ ] Test: `freshTokens = inputTokens - cacheReadTokens` is correct
  - [ ] Test: `cacheHitRate = 0` when `inputTokens === 0`
  - [ ] Test: contextSize accumulates correctly across turns
  - [ ] Test: context spike flagged when `inputTokens > 2 × average`; not flagged otherwise
  - [ ] Test: child spans grouped by parentSpanId into correct parent turn's `childSpans`

- [ ] Task 8: Integration tests for TelemetryPersistence turn_analysis (AC: #5, #6)
  - [ ] File: `src/modules/telemetry/__tests__/turn-analysis.integration.test.ts`
  - [ ] Use real in-memory or temp-file SQLite/Dolt for integration; skip if Dolt not available
  - [ ] Test: `storeTurnAnalysis` then `getTurnAnalysis` round-trips all fields correctly
  - [ ] Test: `getTurnAnalysis` returns empty array for unknown storyKey
  - [ ] Test: `childSpans` JSON serialization/deserialization preserves all ChildSpanSummary fields
  - [ ] Test: results returned in ascending turn_number order regardless of insertion order

## Dev Notes

### Architecture Constraints
- **Constructor injection**: `TurnAnalyzer` accepts `ILogger` — never instantiate concrete logger inside the class
- **Zod-first types**: define `TurnAnalysisSchema` and `ChildSpanSummarySchema` as Zod schemas; derive TypeScript types via `z.infer<>`; validate on DB read boundary (`getTurnAnalysis`) using `schema.parse()`
- **Repository pattern**: `storeTurnAnalysis` and `getTurnAnalysis` are added to the existing `TelemetryPersistence` concrete class and `ITelemetryPersistence` interface (from 27-3). Do NOT create a separate repository class.
- **Parameterized queries only**: all Dolt/SQLite writes use prepared statements via better-sqlite3; no string interpolation in SQL
- **No external dependencies**: `TurnAnalyzer` depends only on types from `src/modules/telemetry/types.ts` and the logger — zero new npm packages
- **Import order**: Node built-ins first, third-party second, internal modules (relative paths) third — blank line between each group

### File Paths
```
src/modules/telemetry/
  types.ts                          ← extend with TurnAnalysisSchema, ChildSpanSummarySchema
  turn-analyzer.ts                  ← TurnAnalyzer class (NEW)
  persistence.ts                    ← extend ITelemetryPersistence + TelemetryPersistence
  index.ts                          ← export TurnAnalysis, ChildSpanSummary, TurnAnalyzer
  __tests__/
    turn-analyzer.test.ts           ← unit tests (NEW)
    turn-analysis.integration.test.ts ← integration tests (NEW)
src/modules/state/
  schema.sql                        ← add turn_analysis table + index
```

### Root Span Identification
LLM turn spans are identified as spans where `parentSpanId` is either absent or does not match any other span's `spanId` in the input set. Build a Set of all spanIds, then filter spans where `!allSpanIds.has(span.parentSpanId)`. The remaining spans are root turns; all others are children.

### Spike Detection Edge Cases
- Single turn: average equals its own inputTokens → `2 × average = 2 × inputTokens` → never spike (a turn cannot be >2x itself)
- All turns equal: average = each turn's value → none exceeds 2x average → no spikes
- Zero-token turns: do NOT divide; treat cacheHitRate as 0 and freshTokens as 0

### contextSize Accumulation
`contextSize` is a running sum — it represents the total input tokens consumed from turn 1 up to and including the current turn:
```typescript
let runningContext = 0;
for (const turn of orderedTurns) {
  const prevContext = runningContext;
  runningContext += turn.inputTokens;
  turn.contextSize = runningContext;
  turn.contextDelta = runningContext - prevContext; // equals inputTokens for first turn
}
```

### Testing Requirements
- **Mocking**: unit tests must NOT touch SQLite or Dolt; inject mock `ILogger` via `vi.fn()` stubs
- **Integration tests**: create a temp SQLite file using `better-sqlite3` in-memory mode (`:memory:`); apply the schema migration before running tests; tear down after
- **Coverage**: ≥80% branch and line coverage for `turn-analyzer.ts` and the new methods in `persistence.ts`
- **Test naming**: `describe('TurnAnalyzer')` → `describe('analyze()')` → `it('should ...')`

## Interface Contracts

- **Import**: `NormalizedSpan` @ `src/modules/telemetry/types.ts` (from story 27-2)
- **Import**: `ITelemetryPersistence`, `getSpansForStory` @ `src/modules/telemetry/persistence.ts` (from story 27-3)
- **Export**: `TurnAnalysis` @ `src/modules/telemetry/types.ts` (consumed by stories 27-5 categorization, 27-6 efficiency scoring, 27-7 recommendation engine)
- **Export**: `ChildSpanSummary` @ `src/modules/telemetry/types.ts` (consumed by story 27-7)
- **Export**: `TurnAnalyzer` @ `src/modules/telemetry/turn-analyzer.ts` (consumed by story 27-8 CLI metrics commands)
- **Export**: `getTurnAnalysis` on `ITelemetryPersistence` @ `src/modules/telemetry/persistence.ts` (consumed by stories 27-5, 27-7, 27-8)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
