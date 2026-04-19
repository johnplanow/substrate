# Story 28-8: Feedback Loop — Telemetry-Driven Routing Tuning

Status: review

## Story

As a pipeline operator,
I want the system to analyze historical per-phase token data and recommend or automatically apply conservative model routing adjustments,
so that routing configuration improves over time based on real usage patterns without requiring manual analysis.

## Acceptance Criteria

### AC1: RoutingRecommender Generates Phase-Level Recommendations
**Given** one or more `PhaseTokenBreakdown` records (from story 28-6) are passed to `RoutingRecommender.analyze(breakdowns, config)`
**When** `analyze()` is called
**Then** for each `phase` appearing in the breakdowns it computes `outputRatio = totalOutputTokens / (totalInputTokens + totalOutputTokens)` averaged across all breakdowns; phases with `outputRatio < 0.15` where the current model is not already the cheapest tier emit a `RoutingRecommendation` with `direction: 'downgrade'`; phases with `outputRatio > 0.40` where the current model is not already the most capable tier emit a recommendation with `direction: 'upgrade'`; every recommendation includes `{ phase, currentModel, suggestedModel, estimatedSavingsPct, confidence, dataPoints, direction }`

### AC2: Minimum Data Threshold Enforced
**Given** fewer than 3 `PhaseTokenBreakdown` records are available for analysis
**When** `RoutingRecommender.analyze(breakdowns, config)` is called
**Then** it returns a `RoutingAnalysis` with `recommendations: []` and `insufficientData: true`; no exception is thrown; a `debug`-level log is emitted with `{ dataPoints: breakdowns.length, threshold: 3, reason: 'insufficient_data' }`

### AC3: `substrate metrics --routing-recommendations` CLI Flag
**Given** a user or agent runs `substrate metrics --routing-recommendations [--output-format json]`
**When** the command executes
**Then** in text mode it prints `Routing Recommendations:` followed by one row per recommendation (`  <phase> | <currentModel> → <suggestedModel> | est. savings: <N>%`) or `No recommendations yet — need at least 3 pipeline runs` when `insufficientData` is true; in JSON mode it writes a single object `{ recommendations, analysisRuns, insufficientData }` to stdout; the command exits 0 in all cases and writes errors to stderr

### AC4: RoutingTuner Applies a Conservative One-Step Model Downgrade
**Given** `model_routing.auto_tune: true` in `substrate.routing.yml` and ≥ 5 `PhaseTokenBreakdown` records are available
**When** `RoutingTuner.maybeAutoTune(runId, config)` is called after a pipeline run completes
**Then** it calls `RoutingRecommender.analyze()`, selects the highest-confidence `direction: 'downgrade'` recommendation whose `suggestedModel` is exactly one tier below `currentModel` (opus→sonnet or sonnet→haiku only — never opus→haiku), writes the updated config back to `substrate.routing.yml` via `js-yaml.dump`, and emits a `routing:auto-tuned` event on the event bus with payload `{ runId, phase, oldModel, newModel, estimatedSavingsPct }`; at most one phase is changed per `maybeAutoTune` invocation

### AC5: Auto-Tune Is a No-Op When Conditions Are Not Met
**Given** any of: `model_routing.auto_tune` absent or false, fewer than 5 historical breakdowns available, or no recommendation qualifies as a safe one-step downgrade
**When** `RoutingTuner.maybeAutoTune()` is called
**Then** it returns without modifying `substrate.routing.yml` and without emitting `routing:auto-tuned`; a `debug`-level log is emitted with the reason code (`'auto_tune_disabled'`, `'insufficient_data'`, or `'no_safe_recommendation'`)

### AC6: Auto-Tune Decision Appended to StateStore Tune Log
**Given** `RoutingTuner.maybeAutoTune()` successfully applies a config change (AC4)
**When** the config write completes
**Then** the tuner reads the existing tune log via `stateStore.getMetric('global', 'routing_tune_log')`, appends a `TuneLogEntry { id: uuid(), runId, phase, oldModel, newModel, estimatedSavingsPct, appliedAt: new Date().toISOString() }` to the array, and writes it back via `stateStore.setMetric('global', 'routing_tune_log', JSON.stringify(updatedLog))`; the log accumulates across runs and is queryable by story 28-9's `substrate routing --history` command

### AC7: Unit Tests at ≥80% Coverage
**Given** the new `RoutingRecommender` and `RoutingTuner` source files
**When** `npm run test:fast` is executed
**Then** all tests in `src/modules/routing/__tests__/routing-recommender.test.ts` and `src/modules/routing/__tests__/routing-tuner.test.ts` pass; line coverage on each new source file is ≥80%; no previously-passing tests regress

## Tasks / Subtasks

- [ ] Task 1: Define new shared types in `src/modules/routing/types.ts` (AC: #1, #3, #6)
  - [ ] Add `RoutingRecommendation` interface: `{ phase: string; currentModel: string; suggestedModel: string; estimatedSavingsPct: number; confidence: number; dataPoints: number; direction: 'upgrade' | 'downgrade' }`
  - [ ] Add `RoutingAnalysis` interface: `{ recommendations: RoutingRecommendation[]; analysisRuns: number; insufficientData: boolean; phaseOutputRatios: Record<string, number> }`
  - [ ] Add `TuneLogEntry` interface: `{ id: string; runId: string; phase: string; oldModel: string; newModel: string; estimatedSavingsPct: number; appliedAt: string }`
  - [ ] Export all three interfaces from `src/modules/routing/index.ts`

- [ ] Task 2: Implement `RoutingRecommender` class (AC: #1, #2)
  - [ ] Create `src/modules/routing/routing-recommender.ts` with class `RoutingRecommender`
  - [ ] Add constructor `(logger: Logger)` — no I/O dependencies; purely functional analysis
  - [ ] Define `MODEL_TIERS` constant mapping model name substring to tier number: `{ opus: 3, sonnet: 2, haiku: 1 }`; implement `private _getTier(model: string): number` that checks for substring match and returns tier (defaulting to 2 when unrecognized)
  - [ ] Implement `private _computeOutputRatio(entries: PhaseTokenEntry[]): number` — returns `sum(outputTokens) / (sum(inputTokens) + sum(outputTokens))`, guarding for zero denominator (returns 0.5 as neutral)
  - [ ] Implement `analyze(breakdowns: PhaseTokenBreakdown[], config: ModelRoutingConfig): RoutingAnalysis`:
    - [ ] Return `{ recommendations: [], analysisRuns: 0, insufficientData: true, phaseOutputRatios: {} }` when `breakdowns.length < 3`
    - [ ] Group all `PhaseTokenEntry` values by `phase` across all breakdowns
    - [ ] Compute `outputRatio` per phase via `_computeOutputRatio`
    - [ ] For each phase, look up `currentModel` from `config.phases[phase]?.model ?? config.baseline_model`; compute `suggestedModel` (one tier down/up); compute `estimatedSavingsPct` as `((currentTier - suggestedTier) / currentTier) * 50` (heuristic: each tier step saves ~50% of that tier's cost fraction); set `confidence = Math.min(breakdowns.length / 10, 1)` (saturates at 10 runs)
    - [ ] Emit only recommendations where the threshold conditions apply (outputRatio < 0.15 for downgrade, > 0.40 for upgrade); skip if already at boundary tier
  - [ ] Export `RoutingRecommender` from `src/modules/routing/index.ts`

- [ ] Task 3: Extend `ModelRoutingConfig` Zod schema with `auto_tune` field (AC: #4, #5)
  - [ ] In `src/modules/routing/schemas.ts`, add `auto_tune: z.boolean().optional()` to the `ModelRoutingConfigSchema` object (after existing `baseline_model` field)
  - [ ] Verify `z.infer<typeof ModelRoutingConfigSchema>` now includes `auto_tune?: boolean`; no change to existing required fields

- [ ] Task 4: Implement `RoutingTuner` class (AC: #4, #5, #6)
  - [ ] Create `src/modules/routing/routing-tuner.ts` with class `RoutingTuner`
  - [ ] Constructor: `(stateStore: IStateStore, recommender: RoutingRecommender, eventEmitter: EventEmitter, configPath: string, logger: Logger)` — store all as readonly fields
  - [ ] Implement `private async _loadRecentBreakdowns(lookback: number): Promise<PhaseTokenBreakdown[]>`:
    - [ ] Call `stateStore.listRuns?.()` or equivalent to get recent run IDs (check actual `IStateStore` interface — may be `listRecentRuns`, `getRuns`, or similar); adapt to the actual method name found
    - [ ] For each run ID in the `lookback` most recent runs, call `stateStore.getMetric(runId, 'phase_token_breakdown')` and parse JSON; filter out nulls
    - [ ] Return the array of parsed `PhaseTokenBreakdown` records
  - [ ] Implement `async maybeAutoTune(runId: string, config: ModelRoutingConfig): Promise<void>`:
    - [ ] Return immediately (log `'auto_tune_disabled'`) when `config.auto_tune !== true`
    - [ ] Load the last 10 breakdowns via `_loadRecentBreakdowns(10)`
    - [ ] Return (log `'insufficient_data'`) when fewer than 5 breakdowns loaded
    - [ ] Call `this._recommender.analyze(breakdowns, config)` and filter recommendations to `direction: 'downgrade'` only
    - [ ] Further filter to only one-step transitions: `Math.abs(this._getTier(r.currentModel) - this._getTier(r.suggestedModel)) === 1`; if no qualifying recommendation, log `'no_safe_recommendation'` and return
    - [ ] Sort by `confidence` descending; pick the top recommendation
    - [ ] Load current YAML from `this._configPath` via `fs.readFileSync`; parse with `js-yaml.load`; update the phase's `model` field; write back via `js-yaml.dump` + `fs.writeFileSync`
    - [ ] Append `TuneLogEntry` to StateStore log via AC6 logic (read → append → write)
    - [ ] Emit `routing:auto-tuned` event on `this._eventEmitter` with `{ runId, phase, oldModel, newModel, estimatedSavingsPct }`
    - [ ] Add private `_getTier` helper (same logic as `RoutingRecommender._getTier`) — or consider exporting a standalone `getModelTier(model: string): number` utility from `src/modules/routing/model-tier.ts` and importing it in both classes to avoid duplication
  - [ ] Export `RoutingTuner` from `src/modules/routing/index.ts`

- [ ] Task 5: Extend `substrate metrics` command with `--routing-recommendations` flag (AC: #3)
  - [ ] In `src/cli/commands/metrics.ts`, add a `.option('--routing-recommendations', 'show model routing recommendations based on historical phase data')` flag
  - [ ] When the flag is active, load recent runs with `phase_token_breakdown` metrics from the state store (same loading pattern as Task 4), construct a `RoutingRecommender` instance (no async deps needed), call `analyze()`, format output:
    - [ ] Text mode: print `Routing Recommendations:\n` then one line per recommendation or the "need at least 3 runs" message; use `console.log` to stdout
    - [ ] JSON mode: write `JSON.stringify({ recommendations, analysisRuns, insufficientData })` to stdout
  - [ ] Import `RoutingRecommender`, `RoutingAnalysis` from `../../modules/routing/index.js`
  - [ ] Load current `ModelRoutingConfig` via the existing config loader (check `src/modules/routing/index.ts` for the loader function introduced in story 28-4); pass to `analyze()`

- [ ] Task 6: Wire `RoutingTuner` into `run.ts` at pipeline completion (AC: #4, #5)
  - [ ] In `src/cli/commands/run.ts`, after existing `RoutingResolver` construction (wired in story 28-5), construct `RoutingTuner` only when `routingConfig?.auto_tune === true`: `const tuner = routingConfig?.auto_tune ? new RoutingTuner(stateStore, new RoutingRecommender(logger), eventBus, routingConfigPath, logger) : null`
  - [ ] At pipeline run completion (after existing `accumulator?.flush(runId)` call from story 28-6), add `await tuner?.maybeAutoTune(runId, routingConfig!)`
  - [ ] Import `RoutingTuner` and `RoutingRecommender` from `../../modules/routing/index.js`
  - [ ] Note: `run.ts` is sequentially modified across stories 28-5, 28-6, and this story — implement in order

- [ ] Task 7: Unit tests for `RoutingRecommender` (AC: #1, #2, #7)
  - [ ] Create `src/modules/routing/__tests__/routing-recommender.test.ts`
  - [ ] Import `{ describe, it, expect, beforeEach }` from `'vitest'`; no jest APIs; no file I/O
  - [ ] Fixture: create helper `makeBreakdown(phase, model, inputTokens, outputTokens): PhaseTokenBreakdown`
  - [ ] Test AC1 downgrade path: 5 breakdowns where `generate` phase has `outputRatio ≈ 0.10` (mostly input tokens) and `currentModel = 'claude-3-5-sonnet-20241022'` → `recommendations` includes one entry with `direction: 'downgrade'`, `suggestedModel` containing `'haiku'`, `estimatedSavingsPct > 0`
  - [ ] Test AC1 upgrade path: 5 breakdowns where `explore` phase has `outputRatio ≈ 0.50` and `currentModel` is haiku-tier → recommendation with `direction: 'upgrade'`
  - [ ] Test AC1 no recommendation: `outputRatio = 0.25` (neutral zone) → `recommendations: []`
  - [ ] Test AC2: 2 breakdowns → `insufficientData: true`, `recommendations: []`
  - [ ] Test zero-denominator guard: all tokens are 0 → `_computeOutputRatio` returns 0.5 (neutral), no recommendation emitted

- [ ] Task 8: Unit tests for `RoutingTuner` (AC: #4, #5, #6, #7)
  - [ ] Create `src/modules/routing/__tests__/routing-tuner.test.ts`
  - [ ] Import `{ describe, it, expect, vi, beforeEach }` from `'vitest'`
  - [ ] Stub `IStateStore`: `{ getMetric: vi.fn(), setMetric: vi.fn().mockResolvedValue(undefined), listRuns: vi.fn() }` — adapt field names to actual `IStateStore` interface
  - [ ] Stub `EventEmitter`: `{ emit: vi.fn() }`
  - [ ] Mock `fs` via `vi.mock('node:fs')` for `readFileSync` / `writeFileSync`; stub `js-yaml` import via `vi.mock('js-yaml')` returning canned parse/dump results
  - [ ] Test AC5 no-op (auto_tune false): call `maybeAutoTune()` with `config.auto_tune = false` → `stateStore.setMetric` never called, `eventEmitter.emit` never called
  - [ ] Test AC5 no-op (insufficient data): `listRuns` returns 3 run IDs, `getMetric` returns breakdowns for each → `maybeAutoTune` returns without writing config (fewer than 5 breakdowns)
  - [ ] Test AC4 happy path: 6 breakdowns loaded, recommender returns a qualifying downgrade → `fs.writeFileSync` called once, `emit('routing:auto-tuned', ...)` called once, `stateStore.setMetric` called once with updated log
  - [ ] Test AC6 log growth: first call creates log with 1 entry; second call (mock `getMetric` returns 1-entry log) creates log with 2 entries
  - [ ] Test AC4 one-step-only guard: recommender returns `currentModel = 'claude-opus-4'`, `suggestedModel = 'claude-3-haiku'` (two-step skip) → tuner filters it out; no config write

## Dev Notes

### Architecture Constraints
- **ESM imports**: all internal imports must use `.js` extension (e.g. `from '../../modules/routing/index.js'`)
- **Import order**: Node built-ins → third-party → internal, blank line between groups
- **No cross-module direct imports**: `RoutingTuner` imports `IStateStore` from `../../modules/state/index.js` only; never imports deep paths across module boundaries
- **No fs.watch / config hot-reload**: `RoutingTuner` reads `substrate.routing.yml` synchronously at tune time, not via a watcher — avoids the fs.watch regression pattern documented in project memory
- **Logging**: `createLogger('routing:recommender')` and `createLogger('routing:tuner')`; never `console.log`
- **run.ts sequential modification**: stories 28-5 and 28-6 already modify `run.ts`; this story adds further lines — implement in strict story order

### File Paths
```
src/modules/routing/
  types.ts                                    ← MODIFY (from story 28-6): add RoutingRecommendation, RoutingAnalysis, TuneLogEntry
  routing-recommender.ts                      ← NEW: RoutingRecommender class
  routing-tuner.ts                            ← NEW: RoutingTuner class
  model-tier.ts                               ← NEW (optional): shared getModelTier() utility
  index.ts                                    ← MODIFY: export new classes and types
  __tests__/
    routing-recommender.test.ts               ← NEW: unit tests
    routing-tuner.test.ts                     ← NEW: unit tests

src/modules/routing/schemas.ts                ← MODIFY (from story 28-4): add auto_tune field

src/cli/commands/
  metrics.ts                                  ← MODIFY (from story 28-6): add --routing-recommendations flag
  run.ts                                      ← MODIFY (from stories 28-5, 28-6): wire RoutingTuner
```

### Model Tier Resolution

The `MODEL_TIERS` lookup checks whether the model string contains a tier keyword (case-insensitive):

```typescript
const TIER_KEYWORDS: { keyword: string; tier: number }[] = [
  { keyword: 'opus',   tier: 3 },
  { keyword: 'sonnet', tier: 2 },
  { keyword: 'haiku',  tier: 1 },
]

function getModelTier(model: string): number {
  const lower = model.toLowerCase()
  for (const { keyword, tier } of TIER_KEYWORDS) {
    if (lower.includes(keyword)) return tier
  }
  return 2 // default to sonnet-tier when unrecognized
}
```

One-step downgrade: `currentTier - 1 === suggestedTier`. One-step upgrade: `currentTier + 1 === suggestedTier`. This prevents opus→haiku jumps even when recommended.

### IStateStore.listRuns — Implementation Caution

The actual method name for listing runs may differ from `listRuns`. **Before implementing Task 4**, check `src/modules/state/index.ts` for the `IStateStore` interface. Look for methods like `getRuns()`, `listRuns()`, `getRecentRuns()`, or `findRuns()`. Adapt `_loadRecentBreakdowns` to the real interface. If no such method exists, load breakdowns by iterating a known run-ID list from another StateStore method (e.g., `getRunIds()` or similar).

### YAML Config Round-Trip

When writing updated config via `js-yaml.dump`, preserve the original file's structure:

```typescript
import * as fs from 'node:fs'
import * as yaml from 'js-yaml'

const raw = fs.readFileSync(this._configPath, 'utf8')
const parsed = yaml.load(raw) as Record<string, unknown>
// mutate the phase's model field in parsed
const updated = yaml.dump(parsed, { lineWidth: 120 })
fs.writeFileSync(this._configPath, updated, 'utf8')
```

Do not use `JSON.stringify` + `JSON.parse` for the YAML file — round-trip through `js-yaml` to preserve comments and formatting where possible.

### TuneLogEntry UUID

Use Node.js built-in `crypto.randomUUID()` (available in Node 15.6+, no import needed in modern Node): `id: crypto.randomUUID()`. Do not add a `uuid` npm dependency.

### EventEmitter Type

Check what event bus type is used in `run.ts` from story 28-5 (likely `EventEmitter` from Node.js `'node:events'` or a typed wrapper from `src/core/event-bus.ts`). Use the same type. The `routing:auto-tuned` event payload should match the event bus typing established in `src/core/event-bus.ts`.

### Confidence Score Design

`confidence = Math.min(breakdowns.length / 10, 1.0)` saturates at 1.0 after 10 runs. For auto-tune, only the `direction: 'downgrade'` recommendations with `dataPoints >= 5` qualify (enforced by the 5-run threshold in `maybeAutoTune`). The recommender itself does not enforce the 5-run threshold — that guard lives in `RoutingTuner.maybeAutoTune`.

### Testing Requirements
- **Framework**: vitest — `import { describe, it, expect, vi, beforeEach } from 'vitest'`; no jest APIs
- **No real StateStore, no real fs, no real EventEmitter** in unit tests — all injected as stubs via constructor
- **`vi.mock('node:fs')`** for `RoutingTuner` tests — mock `readFileSync` and `writeFileSync` at the module level
- **`vi.mock('js-yaml')`** for `RoutingTuner` tests — `load: vi.fn(() => ({ version: 1, phases: {}, baseline_model: 'claude-3-5-sonnet' }))`, `dump: vi.fn(() => 'mocked yaml')`
- **Coverage gate**: ≥80% line coverage on all new source files (enforced by `npm test`)

## Interface Contracts

- **Import**: `PhaseTokenBreakdown`, `PhaseTokenEntry` @ `src/modules/routing/types.ts` (from story 28-6)
- **Import**: `ModelRoutingConfig` @ `src/modules/routing/schemas.ts` (from story 28-4)
- **Import**: `IStateStore` @ `src/modules/state/index.ts` (from Epic 26)
- **Import**: `routing:model-selected` event bus shape @ `src/core/event-bus.ts` (from story 28-5)
- **Export**: `RoutingRecommender`, `RoutingAnalysis`, `RoutingRecommendation`, `TuneLogEntry`, `RoutingTuner` @ `src/modules/routing/index.ts` (consumed by `run.ts` wiring and story 28-9's `substrate routing --history` command)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
