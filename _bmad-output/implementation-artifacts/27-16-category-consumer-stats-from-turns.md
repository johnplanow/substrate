# Story 27-16: Category/Consumer Stats from Turn Analysis

Status: ready-for-dev

## Story

As a substrate pipeline operator,
I want category and consumer statistics computed from turn analysis data (not raw spans),
so that the `category_stats` and `consumer_stats` tables are populated even when only OTLP logs are available.

## Context — What Already Exists

**The gap:** The orchestrator's post-SHIP_IT telemetry path at `orchestrator-impl.ts:1629` has a hardcoded empty spans array:

```typescript
// TODO(27-3): Replace empty array with telemetryPersistence.getSpansForStory(storyKey)
const spans: NormalizedSpan[] = []
if (spans.length === 0) {
  logger.debug({ storyKey }, 'No spans for telemetry categorization — skipping')
}
```

This means `category_stats` and `consumer_stats` are ALWAYS empty — the code is dead. The original design assumed raw spans would be available from persistence, but:
1. Claude Code doesn't export trace spans
2. Even if it did, `getSpansForStory()` doesn't exist on `ITelemetryPersistence`

**The fix:** Compute category/consumer stats from `TurnAnalysis[]` data instead of raw spans. Turn analysis data IS available (after stories 27-14/27-15) and contains model, toolName, token counts — enough for meaningful categorization.

**What exists:**
- `src/modules/telemetry/categorizer.ts` — `Categorizer.computeCategoryStats(spans, turns)` — currently requires spans
- `src/modules/telemetry/consumer-analyzer.ts` — `ConsumerAnalyzer.analyze(spans)` — currently requires spans
- `src/modules/telemetry/persistence.ts` — `storeCategoryStats()`, `storeConsumerStats()` — persistence methods exist and work

## Acceptance Criteria

### AC1: Category Stats Computed from Turns
**Given** `TurnAnalysis[]` data exists for a completed story
**When** the post-SHIP_IT telemetry path runs
**Then** `Categorizer` produces `CategoryStats[]` from turn analysis data (without requiring raw spans) and persists them via `storeCategoryStats()`

### AC2: Consumer Stats Computed from Turns
**Given** `TurnAnalysis[]` data exists for a completed story
**When** the post-SHIP_IT telemetry path runs
**Then** `ConsumerAnalyzer` produces `ConsumerStats[]` from turn analysis data (without requiring raw spans) and persists them via `storeConsumerStats()`

### AC3: TODO(27-3) Eliminated
**Given** the orchestrator post-SHIP_IT path at `orchestrator-impl.ts:1621-1653`
**When** this story is implemented
**Then** the hardcoded empty spans array and the TODO comment are removed, replaced with turn-based computation

### AC4: Graceful Degradation
**Given** no turn analysis data exists for a story (e.g., telemetry disabled or no OTLP received)
**When** the post-SHIP_IT telemetry path runs
**Then** category/consumer stats are skipped with a debug log (no error, no crash)

### AC5: Backwards Compatible with Span-Based Pipeline Path
**Given** the TelemetryPipeline (story 27-15) already computes category/consumer stats inline during batch processing when spans ARE available
**When** both paths could run (pipeline inline + orchestrator post-SHIP_IT)
**Then** the orchestrator path uses INSERT OR REPLACE semantics, so duplicate writes are safe

## Tasks / Subtasks

- [ ] Task 1: Add `computeCategoryStatsFromTurns()` method to `Categorizer`
  - [ ] Accept `TurnAnalysis[]` instead of `NormalizedSpan[]`
  - [ ] Map turn fields to category classification: `toolName` → tool_outputs, model → system context, etc.
  - [ ] Produce same `CategoryStats[]` output shape
  - [ ] Reuse trend detection logic (first half vs second half comparison)
- [ ] Task 2: Add `analyzeFromTurns()` method to `ConsumerAnalyzer`
  - [ ] Accept `TurnAnalysis[]` instead of `NormalizedSpan[]`
  - [ ] Group by `model + toolName` combination as consumer key
  - [ ] Compute token percentages, counts, averages
  - [ ] Produce same `ConsumerStats[]` output shape
- [ ] Task 3: Update `orchestrator-impl.ts` post-SHIP_IT path (lines 1621-1653)
  - [ ] Remove `const spans: NormalizedSpan[] = []` and the TODO comment
  - [ ] Replace with: query `telemetryPersistence.getTurnAnalysis(storyKey)`
  - [ ] If turns exist: call `categorizer.computeCategoryStatsFromTurns(turns)` and `consumerAnalyzer.analyzeFromTurns(turns)`
  - [ ] Persist results via existing `storeCategoryStats()` and `storeConsumerStats()`
  - [ ] If no turns: log debug and skip (same graceful degradation)
- [ ] Task 4: Unit tests for new Categorizer method
  - [ ] Turns with toolName → tool_outputs category
  - [ ] Turns without toolName → appropriate fallback category
  - [ ] Trend detection from turns
  - [ ] Empty input → empty output
- [ ] Task 5: Unit tests for new ConsumerAnalyzer method
  - [ ] Group by model+toolName
  - [ ] Token percentage calculation
  - [ ] Empty input → empty output
- [ ] Task 6: Update orchestrator tests
  - [ ] Verify TODO(27-3) path now calls categorizer/consumer analyzer with turns
  - [ ] Verify graceful skip when no turns exist

## Dev Notes

### Architecture Constraints
- New methods are ADDITIVE — existing `computeCategoryStats(spans, turns)` and `analyze(spans)` remain unchanged
- Output types (`CategoryStats[]`, `ConsumerStats[]`) are unchanged
- The orchestrator post-SHIP_IT path is non-blocking — telemetry failures never alter story verdict

### Categorization Mapping from Turns
```typescript
// Map TurnAnalysis fields to semantic categories:
// - toolName present → 'tool_outputs'
// - name contains 'read' or 'file' → 'file_reads'
// - name contains 'bash' or 'exec' → 'tool_outputs'
// - name contains 'system' → 'system_prompts'
// - default → 'other'
```

### File Paths
```
src/modules/telemetry/
  categorizer.ts                 <- MODIFY (add computeCategoryStatsFromTurns)
  consumer-analyzer.ts           <- MODIFY (add analyzeFromTurns)
  __tests__/
    categorizer.test.ts          <- MODIFY
    consumer-analyzer.test.ts    <- MODIFY
src/modules/implementation-orchestrator/
  orchestrator-impl.ts           <- MODIFY (replace TODO 27-3)
```

## Interface Contracts

- **Import**: `TurnAnalysis` from `./types.js`
- **Export**: Updated `Categorizer` and `ConsumerAnalyzer` (same classes, new methods)
- **Consumed by**: Orchestrator post-SHIP_IT path

## Dependencies

- **MUST run after**: 27-15 (dual-track pipeline ensures turns exist)
