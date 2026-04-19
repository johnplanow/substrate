# Story 30-7: Cache Delta Regression Detection

## Story

As a pipeline operator running multi-dispatch stories,
I want the recommender to detect when consecutive dispatches show a significant cache hit rate drop,
so that prompt restructuring that silently breaks cache prefixes is surfaced as an actionable warning before it compounds across more stories.

## Acceptance Criteria

### AC1: `cache_delta_regression` added to RuleIdSchema
**Given** the `RuleIdSchema` Zod enum in `src/modules/telemetry/types.ts`
**When** the schema is read
**Then** it includes `'cache_delta_regression'` as a valid enum value alongside the existing 8 rules

### AC2: RecommenderContext accepts optional dispatchScores
**Given** the `RecommenderContext` interface in `src/modules/telemetry/types.ts`
**When** the interface is read
**Then** it has an optional `dispatchScores?: EfficiencyScore[]` field — callers that omit it receive no cache_delta_regression recommendations (graceful degradation)

### AC3: Warning fires for >30pp cache hit rate drop between consecutive dispatches
**Given** a story with two dispatch efficiency scores where dispatch 1 has `avgCacheHitRate: 0.80` (timestamp 1000) and dispatch 2 has `avgCacheHitRate: 0.45` (timestamp 2000), a 35pp drop
**When** `Recommender.analyze()` is called with those dispatch scores in `context.dispatchScores`
**Then** exactly one `cache_delta_regression` recommendation is returned with `severity: 'warning'`, containing both dispatch IDs, the delta value (~35pp), and a suggestion to investigate prompt prefix alignment

### AC4: Critical fires for >50pp cache hit rate drop between consecutive dispatches
**Given** a story with two dispatch efficiency scores where dispatch 1 has `avgCacheHitRate: 0.90` (timestamp 1000) and dispatch 2 has `avgCacheHitRate: 0.30` (timestamp 2000), a 60pp drop
**When** `Recommender.analyze()` is called with those dispatch scores
**Then** exactly one `cache_delta_regression` recommendation is returned with `severity: 'critical'`

### AC5: Rule produces no recommendations when drop is below threshold
**Given** a story with two dispatch efficiency scores where the cache hit rate drop is exactly 30pp or less (e.g., 0.70 → 0.45, a 25pp drop)
**When** `Recommender.analyze()` is called
**Then** zero `cache_delta_regression` recommendations are returned

### AC6: Rule gracefully skips when dispatchScores is absent or has fewer than 2 entries
**Given** a `RecommenderContext` where `dispatchScores` is `undefined`, or is an array of length 0 or 1
**When** `Recommender.analyze()` is called
**Then** no `cache_delta_regression` recommendations are emitted and no error is thrown

### AC7: TelemetryPipeline passes dispatchScores into RecommenderContext in both analysis paths
**Given** the pipeline has computed `dispatchScores` in either `_processStory` (span path) or `_processStoryFromTurns` (log-only path)
**When** it assembles the `RecommenderContext` to pass to `this._recommender.analyze(context)`
**Then** `context.dispatchScores` is set to the computed `dispatchScores` array in both paths

## Tasks / Subtasks

- [ ] Task 1: Extend types — add rule ID and RecommenderContext field (AC: #1, #2)
  - [ ] In `src/modules/telemetry/types.ts`, add `'cache_delta_regression'` to `RuleIdSchema` enum (insert after `'per_model_comparison'` to preserve alphabetic-ish order)
  - [ ] In the `RecommenderContext` interface (line ~362), add `/** Per-dispatch efficiency scores from Story 30-3. When present, enables cache_delta_regression rule. */ dispatchScores?: EfficiencyScore[]`
  - [ ] Verify TypeScript compiles without errors: `npm run build`

- [ ] Task 2: Implement `_runCacheDeltaRegression` rule in Recommender (AC: #3, #4, #5, #6)
  - [ ] In `src/modules/telemetry/recommender.ts`, add the private method `_runCacheDeltaRegression(ctx: RecommenderContext): Recommendation[]`
  - [ ] Implementation:
    - Guard: return `[]` if `ctx.dispatchScores === undefined || ctx.dispatchScores.length < 2`
    - Sort dispatch scores chronologically by `timestamp` (ascending)
    - Iterate consecutive pairs `[i, i+1]`; compute `deltaPP = (scores[i].avgCacheHitRate - scores[i+1].avgCacheHitRate) * 100`
    - Skip pair if `deltaPP <= 30` (no regression)
    - Severity: `deltaPP > 50 ? 'critical' : 'warning'`
    - Build recommendation with `ruleId: 'cache_delta_regression'`, both `dispatchId` values from the pair, `deltaPP` in the description, and suggestion to inspect prompt prefix alignment
    - Use `_makeId('cache_delta_regression', storyKey, pairKey, pairIndex)` where `pairKey = \`${prev.dispatchId ?? 'dispatch-N'}→${curr.dispatchId ?? 'dispatch-M'}\``
  - [ ] Add call to `this._runCacheDeltaRegression(context)` in `analyze()` spread (after `_runModelComparison`)

- [ ] Task 3: Wire dispatchScores into RecommenderContext in TelemetryPipeline (AC: #7)
  - [ ] In `src/modules/telemetry/telemetry-pipeline.ts`, locate the span-path `RecommenderContext` construction (around line 350)
  - [ ] Add `dispatchScores` to the context object: `dispatchScores,`
  - [ ] Locate the log-only path `RecommenderContext` construction in `_processStoryFromTurns` (around line 419)
  - [ ] Add `dispatchScores` to that context object: `dispatchScores,`
  - [ ] Verify TypeScript compiles: `npm run build`

- [ ] Task 4: Unit tests for `cache_delta_regression` rule (AC: #3, #4, #5, #6)
  - [ ] In `src/modules/telemetry/__tests__/recommender.test.ts`, add a new `describe('cache_delta_regression rule', ...)` block
  - [ ] Test: warning for >30pp drop — two dispatch scores: `avgCacheHitRate: 0.80` → `0.45`; expect 1 rec with `severity: 'warning'` and `ruleId: 'cache_delta_regression'`
  - [ ] Test: critical for >50pp drop — two dispatch scores: `avgCacheHitRate: 0.90` → `0.30`; expect 1 rec with `severity: 'critical'`
  - [ ] Test: no recommendation when drop ≤ 30pp — `0.70` → `0.45` (25pp); expect 0 recs of this ruleId
  - [ ] Test: no recommendation when `dispatchScores` is `undefined` — expect 0 cache_delta_regression recs
  - [ ] Test: no recommendation when `dispatchScores` has exactly 1 entry — expect 0 recs (insufficient data)
  - [ ] Test: multiple consecutive pairs — three dispatch scores with two regressions; expect 2 recs
  - [ ] Test: non-regression between early pair and regression in later pair — only the regressing pair fires
  - [ ] Use `makeEfficiencyScore({ dispatchId: 'dispatch-1', avgCacheHitRate: 0.8, timestamp: 1000 })` pattern (add `dispatchId` to existing fixture builder overrides)

- [ ] Task 5: Run tests and confirm no regressions (AC: all)
  - [ ] `npm run test:fast` — confirm "Test Files" summary shows all passing
  - [ ] No new TypeScript errors: `npm run build`

## Dev Notes

### Architecture Constraints

- **File locations** (must match exactly):
  - `src/modules/telemetry/types.ts` — `RuleIdSchema` enum extension + `RecommenderContext` interface extension
  - `src/modules/telemetry/recommender.ts` — new private method + call in `analyze()`
  - `src/modules/telemetry/telemetry-pipeline.ts` — two `RecommenderContext` object literals updated
  - `src/modules/telemetry/__tests__/recommender.test.ts` — new describe block

- **Import style**: ESM `.js` extensions. No new external dependencies.
- **Test framework**: Vitest — use `vi.fn()`, `describe`/`it`/`expect`. Never jest APIs.
- **No new files needed** — all changes are additive edits to existing files.

### RuleIdSchema extension

Add the new value to the `RuleIdSchema` enum in `types.ts`. The enum is at line ~322:

```typescript
export const RuleIdSchema = z.enum([
  'biggest_consumers',
  'large_file_reads',
  'expensive_bash',
  'repeated_tool_calls',
  'context_growth_spike',
  'growing_categories',
  'cache_efficiency',
  'per_model_comparison',
  'cache_delta_regression',   // ← add this
])
```

### RecommenderContext extension

The interface is at line ~362 of `types.ts`. Add one optional field after `allSpans`:

```typescript
export interface RecommenderContext {
  storyKey: string
  sprintId?: string
  generatedAt: string
  turns: TurnAnalysis[]
  categories: CategoryStats[]
  consumers: ConsumerStats[]
  efficiencyScore: EfficiencyScore
  allSpans: NormalizedSpan[]
  /** Per-dispatch efficiency scores (Story 30-3). When present, enables cache_delta_regression rule. */
  dispatchScores?: EfficiencyScore[]
}
```

### `_runCacheDeltaRegression` implementation sketch

```typescript
private _runCacheDeltaRegression(ctx: RecommenderContext): Recommendation[] {
  const { dispatchScores, storyKey, sprintId, generatedAt } = ctx
  if (dispatchScores === undefined || dispatchScores.length < 2) return []

  // Sort chronologically — dispatch timestamps are set sequentially in pipeline
  const sorted = [...dispatchScores].sort((a, b) => a.timestamp - b.timestamp)

  const recs: Recommendation[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const prev = sorted[i]!
    const curr = sorted[i + 1]!
    const deltaPP = (prev.avgCacheHitRate - curr.avgCacheHitRate) * 100
    if (deltaPP <= 30) continue

    const severity: RecommendationSeverity = deltaPP > 50 ? 'critical' : 'warning'
    const prevId = prev.dispatchId ?? `dispatch-${i}`
    const currId = curr.dispatchId ?? `dispatch-${i + 1}`
    const pairKey = `${prevId}→${currId}`
    const id = this._makeId('cache_delta_regression', storyKey, pairKey, i)

    recs.push({
      id,
      storyKey,
      sprintId,
      ruleId: 'cache_delta_regression' as RuleId,
      severity,
      title: `Cache regression between dispatches: ${pairKey}`,
      description: `Cache hit rate dropped ${deltaPP.toFixed(1)} percentage points between dispatch "${prevId}" (${(prev.avgCacheHitRate * 100).toFixed(1)}%) and "${currId}" (${(curr.avgCacheHitRate * 100).toFixed(1)}%). This likely indicates a prompt prefix change broke cache alignment. Investigate whether the system prompt or context prefix was restructured between these dispatches.`,
      actionTarget: pairKey,
      generatedAt,
    })
  }
  return recs
}
```

### TelemetryPipeline wiring

In both the span path (`_processStory`) and log-only path (`_processStoryFromTurns`), the `RecommenderContext` is currently assembled without `dispatchScores`. The `dispatchScores` array is already computed just above each context construction — simply add it:

**Span path** (around line 350):
```typescript
const context: RecommenderContext = {
  storyKey,
  generatedAt,
  turns,
  categories,
  consumers,
  efficiencyScore,
  allSpans: spans,
  dispatchScores,   // ← add
}
```

**Log-only path** (around line 419):
```typescript
const context: RecommenderContext = {
  storyKey,
  generatedAt,
  turns,
  categories: categoryStats,
  consumers: consumerStats,
  efficiencyScore,
  allSpans: [],
  dispatchScores,   // ← add
}
```

### Dependency on Story 30-3

Story 30-3 implemented per-dispatch efficiency scoring — the `dispatchScores` array computed in `TelemetryPipeline` and the `dispatchId`, `taskType`, `phase` fields on `EfficiencyScore`. This story consumes that infrastructure. If `dispatchScores` is empty (e.g., all turns lack `dispatchId` because 30-1 isn't in use for a given run), the rule gracefully returns `[]` — no regression fired, no error.

### Testing Requirements

- **Test framework**: Vitest — test files use `.test.ts` extension
- **Coverage**: 80% threshold enforced — all branches of `_runCacheDeltaRegression` must be covered: the early-return guards (undefined, length < 2), the skip path (deltaPP ≤ 30), the warning path (30 < deltaPP ≤ 50), and the critical path (deltaPP > 50)
- **Run tests**: `npm run test:fast` — never pipe output; confirm by checking for "Test Files" in output
- **Targeted run during dev**: `npm run test:changed`

### Scope Boundaries

- **In scope**: `types.ts` enum + interface extension, `recommender.ts` new rule + analyze() wiring, `telemetry-pipeline.ts` context wiring (two locations), unit tests
- **Out of scope**: persistence schema changes (no new DB columns needed), CLI changes (recommendations already display via existing `metrics --recommendations` path), `TelemetryAdvisor` (story 30-6), retry gating (story 30-8)

## Interface Contracts

- **Import**: `EfficiencyScore` @ `src/modules/telemetry/types.ts` (from story 30-3) — consumed by the new `dispatchScores` field on `RecommenderContext` and the `_runCacheDeltaRegression` rule

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
