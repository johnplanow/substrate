# Story 30-4: Log-Only Path Parity

## Story

As a pipeline operator running substrate in production,
I want the log-only telemetry path to generate consumer stats and recommendations just like the span path,
so that actionable insights are available from every pipeline run (Claude Code exports logs only, not spans).

## Acceptance Criteria

### AC1: Audit documents all persistence gaps between span and log-only paths
**Given** the two analysis paths in `TelemetryPipeline`: `_processStory` (span path) and `_processStoryFromTurns` (log-only path)
**When** a developer reviews the audit comment block added to `telemetry-pipeline.ts`
**Then** all 5 persistence calls are listed for the span path; the 2 gaps (consumer stats, recommendations) are identified; and any remaining span-only Recommender rules are documented with rationale

### AC2: Log-only path generates consumer stats from turns
**Given** a story batch with no spans and at least one log-derived turn
**When** `_processStoryFromTurns` processes the turns
**Then** `consumerAnalyzer.analyzeFromTurns(turns)` is called (the method already exists in `ConsumerAnalyzer`) and `storeConsumerStats` is called with the result when the result is non-empty

### AC3: Log-only path generates recommendations via Recommender
**Given** a story batch processed via the log-only path
**When** `_processStoryFromTurns` processes the turns
**Then** `recommender.analyze(context)` is called with a `RecommenderContext` that includes `turns`, `categories`, `consumers`, `efficiencyScore`, and `allSpans: []` (empty array); `saveRecommendations` is called when the result is non-empty

### AC4: All 5 persistence calls are mirrored across both paths
**Given** a story that produces turns, category stats, consumer stats, an efficiency score, and recommendations
**When** processed via either `_processStory` or `_processStoryFromTurns`
**Then** all five persistence calls are made: `storeTurnAnalysis`, `storeEfficiencyScore`, `storeCategoryStats`, `storeConsumerStats`, `saveRecommendations` — plus any dispatch scores

### AC5: Shared persistence helper eliminates future divergence risk
**Given** the two nearly-identical `Promise.all` persistence blocks in `_processStory` and `_processStoryFromTurns`
**When** the helper is extracted to a private `_persistStoryData(storyKey, data)` method
**Then** both paths call `_persistStoryData` with the same interface, and the Promise.all error-catching logic is defined only once

### AC6: Log output includes recommendation count
**Given** `_processStoryFromTurns` completes processing
**When** the info-level log is emitted
**Then** the log object includes `recommendations: recommendations.length` alongside existing fields (`turns`, `compositeScore`, `categories`, `dispatchScores`)

### AC7: Tests verify all 5 persistence calls in the log-only path
**Given** a mocked pipeline with log-derived turns and non-empty return values from all analyzers
**When** `processBatch` is called with logs only (no spans)
**Then** a test verifies `storeTurnAnalysis`, `storeEfficiencyScore`, `storeCategoryStats`, `storeConsumerStats`, and `saveRecommendations` are all called with the correct story key

## Tasks / Subtasks

- [ ] Task 1: Add audit comment block to `telemetry-pipeline.ts` (AC: #1)
  - [ ] At the top of the file (or in a dedicated doc comment), enumerate the 5 persistence calls for `_processStory`: turns, efficiency, categories, consumers, recommendations
  - [ ] Note the 2 gaps previously present in `_processStoryFromTurns`: consumer stats (AC2), recommendations (AC3)
  - [ ] Document remaining span-only Recommender rules after this story: `large_file_reads`, `expensive_bash`, `cache_efficiency` — each returns early when `allSpans.length === 0`; rationale: these rules require file_read/bash span attributes not available in log-derived turns; accepted limitation

- [ ] Task 2: Wire `consumerAnalyzer.analyzeFromTurns` into `_processStoryFromTurns` (AC: #2, #4)
  - [ ] In `src/modules/telemetry/telemetry-pipeline.ts`, inside `_processStoryFromTurns`, after computing `categoryStats`, call `const consumerStats = this._consumerAnalyzer.analyzeFromTurns(turns)`
  - [ ] The method already exists on `ConsumerAnalyzer` — no changes to `consumer-analyzer.ts` needed
  - [ ] Pass `consumerStats` to the persistence block (Task 4 below)

- [ ] Task 3: Wire `recommender.analyze` into `_processStoryFromTurns` (AC: #3, #4)
  - [ ] In `_processStoryFromTurns`, after computing consumer stats, assemble a `RecommenderContext`:
    ```typescript
    const generatedAt = new Date().toISOString()
    const context: RecommenderContext = {
      storyKey,
      generatedAt,
      turns,
      categories: categoryStats,
      consumers: consumerStats,
      efficiencyScore,
      allSpans: [],   // no spans in log-only path
    }
    const recommendations = this._recommender.analyze(context)
    ```
  - [ ] Import `RecommenderContext` from `./types.js` (already imported in `_processStory`)

- [ ] Task 4: Extract shared `_persistStoryData` helper (AC: #4, #5)
  - [ ] Define a private interface `StoryPersistenceData` (inline or as a local type):
    ```typescript
    interface StoryPersistenceData {
      turns: TurnAnalysis[]
      efficiencyScore: EfficiencyScore
      categoryStats: CategoryStats[]
      consumerStats: ConsumerStats[]
      recommendations: Recommendation[]
      dispatchScores: EfficiencyScore[]
    }
    ```
  - [ ] Add `private async _persistStoryData(storyKey: string, data: StoryPersistenceData): Promise<void>` that contains the full `Promise.all` block (turns, efficiency, categories, consumers, recommendations, dispatch scores) with individual `.catch` guards for each call
  - [ ] Replace the `Promise.all` block in `_processStory` with a call to `this._persistStoryData(storyKey, { ... })`
  - [ ] Replace the `Promise.all` block in `_processStoryFromTurns` with a call to `this._persistStoryData(storyKey, { ... })`
  - [ ] Add the necessary type imports for `CategoryStats`, `ConsumerStats`, `Recommendation` from `./types.js` (add only what's missing)

- [ ] Task 5: Update log output in `_processStoryFromTurns` (AC: #6)
  - [ ] In the `logger.info(...)` call at the end of `_processStoryFromTurns`, add `recommendations: recommendations.length` to the log object
  - [ ] Confirm parity with the log in `_processStory` (which already logs `recommendations: recommendations.length`)

- [ ] Task 6: Update and add tests (AC: #2, #3, #7)
  - [ ] In `src/modules/telemetry/__tests__/telemetry-pipeline.test.ts`, locate the test at "AC3: log-only path calls computeCategoryStatsFromTurns but NOT span-based categorizer or consumer analyzer"
  - [ ] Update that test: add assertions that `consumerAnalyzer.analyzeFromTurns` IS called in the log-only path; update the mock deps setup to give `analyzeFromTurns` a `vi.fn()` return
  - [ ] Add a new test: `'log-only path calls all 5 persistence methods (AC: 30-4)'`:
    - Mock `logTurnAnalyzer.analyze` → returns one turn
    - Mock `categorizer.computeCategoryStatsFromTurns` → returns one category stat
    - Mock `consumerAnalyzer.analyzeFromTurns` → returns one consumer stat
    - Mock `recommender.analyze` → returns one recommendation
    - Call `processBatch` with logs only (no spans)
    - Assert `storeTurnAnalysis`, `storeEfficiencyScore`, `storeCategoryStats`, `storeConsumerStats`, `saveRecommendations` are each called once with the correct story key
  - [ ] Add a test: persistence errors in consumer stats and recommendations do not throw (error caught per-call)

## Dev Notes

### Architecture Constraints

- **File locations** (must match exactly):
  - Pipeline: `src/modules/telemetry/telemetry-pipeline.ts` — only file modified in main implementation
  - Tests: `src/modules/telemetry/__tests__/telemetry-pipeline.test.ts` — update existing + add new tests
  - Do NOT modify `src/modules/telemetry/consumer-analyzer.ts` — `analyzeFromTurns` already exists
  - Do NOT modify `src/modules/telemetry/recommender.ts` — `analyze()` already handles `allSpans: []` gracefully (span-only rules return early when `allSpans.length === 0`)
  - Do NOT modify `src/modules/telemetry/persistence.ts` or `adapter-persistence.ts` — no new persistence methods needed

- **Import style**: All imports use `.js` extensions (ESM). The `RecommenderContext` import is already present in `_processStory`'s imports at the top of `telemetry-pipeline.ts`. Add `CategoryStats`, `ConsumerStats`, `Recommendation` to the existing `types.js` import if not already there.

- **Test framework**: Vitest — use `vi.fn()`, `vi.mock`, `describe`/`it`/`expect`. Do NOT use jest APIs.

- **No new public API**: This story is purely internal wiring — no changes to `ITelemetryPersistence`, exported types, or CLI commands.

### Current State (as of v0.5.0)

Looking at `telemetry-pipeline.ts` `_processStoryFromTurns`:
- ✅ `storeTurnAnalysis` — already called
- ✅ `storeEfficiencyScore` — already called
- ✅ `storeCategoryStats` (via `computeCategoryStatsFromTurns`) — already called (added in v0.4.11)
- ✅ `storeEfficiencyScore` for dispatch scores — already called (added in story 30-3)
- ❌ `storeConsumerStats` — **missing** (this story)
- ❌ `saveRecommendations` — **missing** (this story)

`ConsumerAnalyzer.analyzeFromTurns()` already exists — implemented in prior work. This story just wires it into `_processStoryFromTurns`.

### Recommender Behavior with `allSpans: []`

Rules that still fire on log-only path:
- `biggest_consumers` — uses `context.consumers` (from `analyzeFromTurns`)
- `repeated_tool_calls` — uses `turns` child spans (available in TurnAnalysis)
- `context_growth_spike` — uses `turns` (checks `isContextSpike` flag)
- `growing_categories` — uses `context.categories` (from `computeCategoryStatsFromTurns`)
- `per_model_comparison` — uses `context.turns`

Rules that return `[]` when `allSpans: []`:
- `large_file_reads` — requires span.operationName === 'file_read' (span attribute not in turns)
- `expensive_bash` — requires span attribute `tool.name === 'bash'` (not available from log turns)
- `cache_efficiency` — explicitly checks `if (allSpans.length === 0) return []`

This is acceptable. The rules that require span attributes cannot be ported to turns without restructuring the Recommender (out of scope for this story).

### Mock Pattern for `analyzeFromTurns`

The mock deps helper in `telemetry-pipeline.test.ts` creates a `consumerAnalyzer` mock. The existing test that asserts `analyze` is NOT called in log-only path casts through `unknown`. When updating that test, also add a mock for `analyzeFromTurns`:

```typescript
// In makeMockDeps or inline in the test:
const consumerAnalyzerMock = {
  analyze: vi.fn().mockReturnValue([]),
  analyzeFromTurns: vi.fn().mockReturnValue([]),
}
```

Update the AC3 test to verify `consumerAnalyzerMock.analyzeFromTurns` IS called (not merely that `analyze` is not called).

### Testing Requirements

- **Test framework**: Vitest — test files must use `.test.ts` extension
- **Coverage**: 80% threshold enforced — new branches (non-empty consumers, non-empty recommendations, error recovery) must be exercised
- **Run tests**: `npm run test:fast` — never pipe output; confirm by checking for "Test Files" in output
- **Targeted run during dev**: `npm run test:changed`

### Scope Boundaries

- **In scope**: Wiring `analyzeFromTurns` + `recommender.analyze` into `_processStoryFromTurns`; extracting shared persistence helper; updating tests; updating log output
- **Out of scope**: Modifying Recommender to work without allSpans; CLI command changes; new persistence methods; changing `cache_efficiency` rule to work from turns (future story)

## Interface Contracts

- **Import**: `ConsumerAnalyzer.analyzeFromTurns(turns: TurnAnalysis[]): ConsumerStats[]` @ `src/modules/telemetry/consumer-analyzer.ts` — already implemented, consumed by `_processStoryFromTurns` in this story
- **Import**: `Recommender.analyze(context: RecommenderContext): Recommendation[]` @ `src/modules/telemetry/recommender.ts` — already used in `_processStory`, now also used in `_processStoryFromTurns`

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
