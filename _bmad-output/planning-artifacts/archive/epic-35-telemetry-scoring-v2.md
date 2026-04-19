# Epic 35: Telemetry Scoring v2 — Gradient-Aware Efficiency Metrics

## Problem Statement

The current composite efficiency score (0-100) is saturated at 100 for virtually all non-cold-start turns. This renders the TelemetryAdvisor's feedback loop ineffective — when every dispatch scores 100, optimization directives have no gradient to work with.

**Root causes:**

1. **io_ratio sub-score is binary.** `outputTokens / freshInputTokens` is almost always >> 1 for agentic turns (output 500 tokens, fresh input 1-2 tokens = ratio 250). The formula returns 100 for any ratio >= 1, collapsing the observed range of 1–1600 into a single value.

2. **Cache hit sub-score provides no spread.** Post-cold-start, cache hit rates are consistently 99.97%+, all mapping to score 100.

3. **Context management only triggers on anomalies.** The sub-score only decreases when context spikes occur, which is rare. Normal operation = 100.

4. **Cold-start turns penalize unfairly.** The first turn of each dispatch has ~50% cache hit rate (inherent to Claude's prompt caching for new conversations), dragging down the per-dispatch average despite being uncontrollable.

**Evidence from v0.5.8 ynab validation run (story 5-9):**
- 87 of 90 per-dispatch efficiency scores = 100
- 3 scores at 80-85 (all cold-start turns)
- io_ratio values ranged from 0.38 to 1609 — all mapped to score 100
- TelemetryAdvisor had zero gradient signal for optimization directives

## Goals

1. Composite scores should span a meaningful range (e.g., 60-100) across real pipeline dispatches, enabling the feedback loop to distinguish "good" from "excellent"
2. Per-task-type baselines so create-story, dev-story, and code-review are scored against their own peers
3. Cold-start turns excluded from composite scoring (first turn of each dispatch)
4. New sub-score dimensions that actually vary in practice

## Non-Goals

- Changing the TelemetryAdvisor's directive format (that's working fine)
- Adding new telemetry collection (OTLP pipeline is complete)
- Real-time scoring during dispatches (scoring is post-hoc)

## Proposed Approach

### Story 35-1: Recalibrate io_ratio Sub-Score Curve

Replace the binary threshold (>=1 → 100) with a logarithmic curve across the observed range:
- `score = clamp(log10(ratio) / log10(TARGET_RATIO) * 100, 0, 100)`
- TARGET_RATIO calibrated from historical data (likely ~100-200)
- Provides gradient across the full 1-1600 observed range
- Sub-1 ratios still get low scores (that part works)

**File:** `src/modules/telemetry/efficiency-scorer.ts` `_computeIoRatioSubScore()`

### Story 35-2: Per-Task-Type Baseline Profiles

Define expected performance profiles per task type:
- `create-story`: lower turn count, moderate output density
- `dev-story`: high turn count, high output density, long-running
- `code-review`: low turn count, high output per turn
- `minor-fixes`: very low turns, moderate output

Score each dispatch against its task type's baseline rather than a universal formula. Requires the task_type field on turns (now populated via v0.5.8 dispatch metadata).

**Files:** New `src/modules/telemetry/task-baselines.ts`, update `efficiency-scorer.ts`

### Story 35-3: Cold-Start Turn Exclusion

Exclude the first turn of each dispatch from composite scoring:
- Identify cold-start turns: first turn per `dispatch_id` in `turn_analysis`
- Mark them with a flag (`is_cold_start`) during `LogTurnAnalyzer.analyze()`
- Exclude from `EfficiencyScorer.score()` computation
- Still persist them for observability (don't delete, just exclude from scoring)

**Files:** `log-turn-analyzer.ts`, `efficiency-scorer.ts`

### Story 35-4: Token Density Sub-Score

New sub-score dimension: output tokens per turn, normalized by task type.
- `token_density = avg(outputTokens per turn) / baseline_per_task_type`
- Measures whether the agent is producing useful output vs spinning
- Varies meaningfully: create-story ~1500/turn, dev-story ~400/turn, code-review ~3800/turn

Replaces or supplements the io_ratio sub-score.

**Files:** `efficiency-scorer.ts`, new weight allocation

### Story 35-5: Revalidate TelemetryAdvisor with New Scores

After scoring recalibration:
- Verify optimization directives still generate useful, differentiated recommendations
- Update any threshold-based logic in TelemetryAdvisor that assumed old score ranges
- Run validation against ynab pipeline data to confirm gradient signal

**Files:** `telemetry-advisor.ts`, integration tests

## Dependencies

- Dispatch metadata flowing (v0.5.8) — **DONE**
- Stale data cleanup (v0.5.9) — **DONE**
- Historical telemetry data from ynab runs for baseline calibration

## Effort Estimate

5 stories, ~1 sprint. Medium complexity — the scoring logic is isolated in `efficiency-scorer.ts` but the downstream effects (advisor, recommendations) need validation.

## Open Questions

1. Should composite weights change? Current: cache 40%, io_ratio 30%, context 30%. With cold-start exclusion and better io_ratio curve, cache sub-score may become less important.
2. Should we add a "turns-to-completion" efficiency metric at the story level (not per-turn)?
3. Is the 0-100 scale still the right output range, or should we use percentiles relative to historical data?
