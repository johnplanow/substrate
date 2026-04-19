# Story 27-6: Efficiency Scoring

Status: ready-for-dev

## Story

As a substrate pipeline operator,
I want a composite 0-100 efficiency score computed for each story execution,
so that I can compare token efficiency across stories, models, and prompt templates and track improvement over time.

## Acceptance Criteria

### AC1: EfficiencyScore Type Definition
**Given** the telemetry module is imported
**When** a consumer references `EfficiencyScore`
**Then** the type contains: `storyKey`, `timestamp`, `compositeScore` (0–100), `cacheHitSubScore` (0–100), `ioRatioSubScore` (0–100), `contextManagementSubScore` (0–100), `avgCacheHitRate`, `avgIoRatio`, `contextSpikeCount`, `totalTurns`, and `perModelBreakdown: ModelEfficiency[]` where `ModelEfficiency` has `model`, `cacheHitRate`, `avgIoRatio`, `costPer1KOutputTokens`; and optionally `perSourceBreakdown: SourceEfficiency[]` where `SourceEfficiency` has `source`, `compositeScore`, `turnCount`

### AC2: Composite Score Computation
**Given** a `TurnAnalysis[]` array for a story (from 27-4)
**When** `EfficiencyScorer.score(storyKey, turns)` is called
**Then** the composite score is computed as:
- `cacheHitSubScore = clamp(avgCacheHitRate × 100, 0, 100)` — weighted 40%
- `ioRatioSubScore = clamp(100 - (avgIoRatio - 1) × 20, 0, 100)` where `avgIoRatio = avg(inputTokens / max(outputTokens, 1))` — weighted 30% (lower ratio = better = higher sub-score)
- `contextManagementSubScore = clamp(100 - (contextSpikeCount / max(totalTurns, 1)) × 100, 0, 100)` — weighted 30%
- `compositeScore = round(cacheHitSubScore × 0.4 + ioRatioSubScore × 0.3 + contextManagementSubScore × 0.3)`
- An empty `turns` array returns a zeroed `EfficiencyScore` with all scores set to 0

### AC3: Per-Model Efficiency Breakdown
**Given** turns from multiple models within a single story
**When** `EfficiencyScorer.score(storyKey, turns)` is called
**Then** `perModelBreakdown` groups turns by `model`, computes per-group `cacheHitRate` (avg), `avgIoRatio`, and `costPer1KOutputTokens` (sum costUsd / max(total outputTokens, 1) × 1000), returning one `ModelEfficiency` entry per distinct model value; turns with a null/empty `model` are grouped under the key `"unknown"`

### AC4: Per-Source Efficiency Breakdown
**Given** turns from multiple sources (e.g., `claude-code` and `unknown`)
**When** `EfficiencyScorer.score(storyKey, turns)` is called
**Then** `perSourceBreakdown` groups turns by `source`, computes a per-group `compositeScore` using the same formula as AC2, and includes `turnCount`; sources with zero turns are excluded; the top-level `compositeScore` always reflects all turns combined regardless of source grouping

### AC5: efficiency_scores Dolt Schema and Batch Storage
**Given** a computed `EfficiencyScore` for a story
**When** `telemetryPersistence.storeEfficiencyScore(score)` is called
**Then** the record is inserted into the `efficiency_scores` Dolt table with columns: `story_key`, `timestamp`, `composite_score`, `cache_hit_sub_score`, `io_ratio_sub_score`, `context_management_sub_score`, `avg_cache_hit_rate`, `avg_io_ratio`, `context_spike_count`, `total_turns`, `per_model_json` (JSON), `per_source_json` (JSON); primary key is `(story_key, timestamp)`; any existing row for the same key is replaced (upsert semantics)

### AC6: getEfficiencyScore Query Method
**Given** an efficiency score row exists in Dolt for a given `storyKey`
**When** `telemetryPersistence.getEfficiencyScore(storyKey)` is called
**Then** it returns the most recent `EfficiencyScore` for that key with `perModelBreakdown` and `perSourceBreakdown` deserialized from JSON, validated via Zod schema; returns `null` if no row exists

### AC7: Unit Tests Cover All Scoring Logic
**Given** unit tests in `src/modules/telemetry/__tests__/efficiency-scorer.test.ts`
**When** the test suite runs via `npm run test:fast`
**Then** tests cover: empty turns returns zeroed score, cacheHitSubScore clamped to [0,100], ioRatioSubScore clamped to [0,100], contextManagementSubScore with spike count = 0 vs. spikes present, composite score weighted sum rounds correctly, per-model grouping with multiple models, per-model `"unknown"` bucket for null/empty model, per-source grouping with multi-source turns, and single-turn edge case

## Tasks / Subtasks

- [ ] Task 1: Extend type definitions in `src/modules/telemetry/types.ts` (AC: #1)
  - [ ] Define `ModelEfficiencySchema` Zod schema: `{ model: z.string(), cacheHitRate: z.number(), avgIoRatio: z.number(), costPer1KOutputTokens: z.number() }`
  - [ ] Define `SourceEfficiencySchema` Zod schema: `{ source: z.string(), compositeScore: z.number(), turnCount: z.number() }`
  - [ ] Define `EfficiencyScoreSchema` Zod schema with all fields from AC1; use `z.infer<>` to derive `EfficiencyScore`, `ModelEfficiency`, `SourceEfficiency` types
  - [ ] Export all three types and schemas from `src/modules/telemetry/index.ts`

- [ ] Task 2: Implement scoring sub-functions in `src/modules/telemetry/efficiency-scorer.ts` (AC: #2)
  - [ ] Create `EfficiencyScorer` class with constructor `new EfficiencyScorer(logger: ILogger)` following constructor injection pattern
  - [ ] Implement private `computeCacheHitSubScore(turns: TurnAnalysis[]): number` — average `cacheHitRate`, multiply by 100, clamp [0,100]
  - [ ] Implement private `computeIoRatioSubScore(turns: TurnAnalysis[]): number` — for each turn compute `inputTokens / max(outputTokens, 1)`, average, apply formula from AC2, clamp [0,100]
  - [ ] Implement private `computeContextManagementSubScore(turns: TurnAnalysis[]): number` — count turns where `isContextSpike === true`, apply formula from AC2, clamp [0,100]
  - [ ] Implement private `clamp(value: number, min: number, max: number): number` helper

- [ ] Task 3: Implement `score()` method and breakdowns in `EfficiencyScorer` (AC: #2, #3, #4)
  - [ ] `score(storyKey: string, turns: TurnAnalysis[]): EfficiencyScore` — returns zeroed score if `turns` is empty
  - [ ] Call all three sub-score methods, compute weighted composite, round to integer
  - [ ] Implement private `buildPerModelBreakdown(turns: TurnAnalysis[]): ModelEfficiency[]` — group by `turn.model ?? 'unknown'`, compute per-group metrics
  - [ ] Implement private `buildPerSourceBreakdown(turns: TurnAnalysis[]): SourceEfficiency[]` — group by `turn.source`, compute per-group composite score using same formula
  - [ ] Assign `timestamp: Date.now()` to the returned score
  - [ ] Log an `info` message with storyKey, compositeScore, and contextSpikeCount after scoring

- [ ] Task 4: Extend Dolt schema with `efficiency_scores` table (AC: #5)
  - [ ] Add `CREATE TABLE IF NOT EXISTS efficiency_scores` to `src/modules/state/schema.sql`
  - [ ] Columns: `story_key VARCHAR(64)`, `timestamp BIGINT`, `composite_score INTEGER`, `cache_hit_sub_score DOUBLE`, `io_ratio_sub_score DOUBLE`, `context_management_sub_score DOUBLE`, `avg_cache_hit_rate DOUBLE`, `avg_io_ratio DOUBLE`, `context_spike_count INTEGER`, `total_turns INTEGER`, `per_model_json TEXT`, `per_source_json TEXT`
  - [ ] `PRIMARY KEY (story_key, timestamp)`
  - [ ] Add index: `CREATE INDEX IF NOT EXISTS idx_efficiency_story ON efficiency_scores (story_key, timestamp DESC)`

- [ ] Task 5: Add persistence methods to `TelemetryPersistence` (AC: #5, #6)
  - [ ] Extend `ITelemetryPersistence` interface in `src/modules/telemetry/persistence.ts` with `storeEfficiencyScore(score: EfficiencyScore): Promise<void>` and `getEfficiencyScore(storyKey: string): Promise<EfficiencyScore | null>`
  - [ ] `storeEfficiencyScore`: prepare INSERT OR REPLACE statement at construction time; serialize `perModelBreakdown` and `perSourceBreakdown` to JSON; execute as a single prepared statement
  - [ ] `getEfficiencyScore`: SELECT WHERE story_key = ? ORDER BY timestamp DESC LIMIT 1; parse JSON fields; validate with `EfficiencyScoreSchema.parse()`; return `null` if no row
  - [ ] Expose both methods from `src/modules/telemetry/index.ts`

- [ ] Task 6: Wire `EfficiencyScorer` into post-story telemetry pipeline (AC: #2, #5)
  - [ ] Identify the location where `TurnAnalyzer` is invoked after story completion (from story 27-4 wiring)
  - [ ] After `storeTurnAnalysis`, instantiate `EfficiencyScorer`, call `scorer.score(storyKey, turns)`, then call `telemetryPersistence.storeEfficiencyScore(score)`
  - [ ] Guard: skip if `turns` is empty (telemetry disabled or no spans)
  - [ ] Log info-level summary: storyKey, compositeScore, model count in breakdown

- [ ] Task 7: Unit tests for `EfficiencyScorer` (AC: #1, #2, #3, #4, #7)
  - [ ] File: `src/modules/telemetry/__tests__/efficiency-scorer.test.ts`
  - [ ] Test: empty turns array returns `{ compositeScore: 0, cacheHitSubScore: 0, ioRatioSubScore: 0, contextManagementSubScore: 0, totalTurns: 0, perModelBreakdown: [], perSourceBreakdown: [] }`
  - [ ] Test: cacheHitSubScore = 100 when all turns have cacheHitRate = 1.0
  - [ ] Test: ioRatioSubScore clamped to 0 when avgIoRatio is very high (e.g., 100x input/output)
  - [ ] Test: contextManagementSubScore = 100 when no spikes; = 50 when half of turns are spikes
  - [ ] Test: composite score weighted sum matches formula (verify with known inputs)
  - [ ] Test: per-model breakdown groups correctly with 2 distinct models + null model → 3 entries including `"unknown"`
  - [ ] Test: per-source breakdown computes correct composite score per group
  - [ ] Test: single-turn edge case produces valid (non-NaN) score

- [ ] Task 8: Integration tests for `TelemetryPersistence` efficiency_scores (AC: #5, #6)
  - [ ] File: `src/modules/telemetry/__tests__/efficiency-scores.integration.test.ts`
  - [ ] Use real temp-file SQLite (`:memory:`) with schema applied before tests
  - [ ] Test: `storeEfficiencyScore` then `getEfficiencyScore` round-trips all scalar fields and JSON arrays correctly
  - [ ] Test: `getEfficiencyScore` returns `null` for unknown storyKey
  - [ ] Test: second `storeEfficiencyScore` for same story_key replaces the previous row (upsert)
  - [ ] Test: `perModelBreakdown` and `perSourceBreakdown` JSON serialization preserves all fields

## Dev Notes

### Architecture Constraints
- **Constructor injection**: `EfficiencyScorer` accepts `ILogger` — never instantiate a concrete logger inside the class
- **Zod-first types**: define all schemas first; derive TypeScript types via `z.infer<>`; validate on DB read boundary in `getEfficiencyScore` using `EfficiencyScoreSchema.parse()`
- **Repository pattern**: `storeEfficiencyScore` and `getEfficiencyScore` are added to the existing `TelemetryPersistence` concrete class and `ITelemetryPersistence` interface (from 27-3). Do NOT create a separate repository class.
- **Parameterized queries only**: all writes use better-sqlite3 prepared statements prepared once at construction; no string interpolation in SQL
- **No external dependencies**: `EfficiencyScorer` depends only on types from `src/modules/telemetry/types.ts` and the logger — zero new npm packages
- **Import order**: Node built-ins first, third-party second, internal modules (relative paths) third — blank line between each group

### File Paths
```
src/modules/telemetry/
  types.ts                                        ← extend with EfficiencyScoreSchema, ModelEfficiencySchema, SourceEfficiencySchema
  efficiency-scorer.ts                            ← EfficiencyScorer class (NEW)
  persistence.ts                                  ← extend ITelemetryPersistence + TelemetryPersistence
  index.ts                                        ← export EfficiencyScore, ModelEfficiency, SourceEfficiency, EfficiencyScorer
  __tests__/
    efficiency-scorer.test.ts                     ← unit tests (NEW)
    efficiency-scores.integration.test.ts         ← integration tests (NEW)
src/modules/state/
  schema.sql                                      ← add efficiency_scores table + index
```

### Score Formula Detail
All three sub-scores are clamped to [0, 100] before weighting:

```typescript
const cacheHitSubScore = clamp(avgCacheHitRate * 100, 0, 100);
// avgIoRatio = avg(inputTokens / max(outputTokens, 1)) across turns
const ioRatioSubScore = clamp(100 - (avgIoRatio - 1) * 20, 0, 100);
// spikeRatio = contextSpikeCount / max(totalTurns, 1)
const contextManagementSubScore = clamp(100 - spikeRatio * 100, 0, 100);
const compositeScore = Math.round(
  cacheHitSubScore * 0.4 + ioRatioSubScore * 0.3 + contextManagementSubScore * 0.3
);
```

The I/O ratio formula: an `avgIoRatio` of 1.0 (equal input/output) maps to 80; ratio of 5.0 maps to 20; ratio ≤ 0 or extremely high is clamped. The intent is that agents producing more output relative to input score higher.

### Edge Cases
- **Zero outputTokens in a turn**: use `max(outputTokens, 1)` to avoid division by zero in I/O ratio
- **Zero totalTurns**: return a zeroed `EfficiencyScore` immediately before any division
- **All turns same model**: `perModelBreakdown` has exactly one entry
- **No source field on turns**: falls back to grouping under the value of `turn.source` which is typed as string (never null per `NormalizedSpan`)

### Testing Requirements
- **Mocking**: unit tests must NOT touch SQLite or Dolt; inject mock `ILogger` via `vi.fn()` stubs; construct fixture `TurnAnalysis` objects directly
- **Integration tests**: use `better-sqlite3` in-memory (`:memory:`) database; apply schema migration before each test; no real Dolt binary required
- **Coverage**: ≥80% branch and line coverage for `efficiency-scorer.ts` and the new persistence methods
- **Test naming**: `describe('EfficiencyScorer')` → `describe('score()')` → `it('should ...')`
- **Determinism**: given identical `TurnAnalysis[]` input, `score()` must always return an identical `compositeScore` — verified in unit tests

## Interface Contracts

- **Import**: `TurnAnalysis` @ `src/modules/telemetry/types.ts` (from story 27-4)
- **Import**: `ITelemetryPersistence` @ `src/modules/telemetry/persistence.ts` (from story 27-3)
- **Export**: `EfficiencyScore` @ `src/modules/telemetry/types.ts` (consumed by story 27-7 recommendation engine, 27-8 CLI metrics commands)
- **Export**: `ModelEfficiency` @ `src/modules/telemetry/types.ts` (consumed by story 27-8 CLI metrics commands)
- **Export**: `SourceEfficiency` @ `src/modules/telemetry/types.ts` (consumed by story 27-8 CLI metrics commands)
- **Export**: `EfficiencyScorer` @ `src/modules/telemetry/efficiency-scorer.ts` (consumed by story 27-8)
- **Export**: `storeEfficiencyScore`, `getEfficiencyScore` on `ITelemetryPersistence` @ `src/modules/telemetry/persistence.ts` (consumed by stories 27-7, 27-8)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
