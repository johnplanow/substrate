# Story 81-3: Pack-upgrade four-axis grader

## Story

As a substrate eval-framework operator,
I want a pure grader (`scripts/eval-pack-upgrade/grader.mjs`) that consumes the envelope pairs produced by 81-2's harness and produces a four-axis quality delta report,
so that Epic 81's CLI (81-4) can surface code-quality drift, cost regressions, verdict distribution shifts, and recovery taxonomy shifts in one report.

This story is the scoring layer. It is pure — no I/O, no dispatch, no model calls (except the Epic 77 gray-band judge for the code-quality axis, which is itself injectable). Per-axis logic is decomposed into testable helpers; the top-level `gradeAll(pairs)` rolls up per-axis verdicts and corpus-aggregate distributions.

## Acceptance Criteria

1. **Pure top-level grader.** Export `gradeAll(pairs, options)` from `scripts/eval-pack-upgrade/grader.mjs`. Pure: no I/O, no async file reads, no live model calls. `pairs` is the JSON array produced by 81-2 (per-case envelope pairs); `options` is a config object documented in AC9.

2. **Axis 1 — Code quality (reconstruction Δ).** For each pair where BOTH `current.dispatch_outcome` and `candidate.dispatch_outcome` are `'completed'`:
   - Reuse the Epic 77 reconstruction grader's `deterministicSignal(diff, groundTruthDiff)` helper from `scripts/eval-reconstruction/grader.mjs` (signature: `0.5·file_jaccard + 0.5·test_overlap`)
   - Compute `currentScore = deterministicSignal(current.diff, groundTruth)` and `candidateScore = deterministicSignal(candidate.diff, groundTruth)`
   - Per-pair Δ = `candidateScore - currentScore` (positive = candidate is better)
   - If `min(currentScore, candidateScore)` lands in the gray band (default 0.4–0.8), invoke the injectable LLM pairwise judge (`options.judgeFn`) to confirm the relative ranking; clear pass/fail (both above 0.8 or both below 0.4) skip the judge — bounds cost (Epic 77 77-9 AC2 pattern)
   - Corpus-aggregate: mean Δ, median Δ, count of regressions (Δ < 0), count of improvements (Δ > 0)
   - Pairs where one or both sides did NOT complete are EXCLUDED from the code-quality denominator (per 77-9 AC3's "ungradable excluded" pattern)

3. **Axis 2 — Cost (turn count + tokens).** For each pair where BOTH sides have `total_turns` and `total_tokens` populated (post-81-1):
   - Per-pair Δ turns = `candidate.total_turns - current.total_turns`
   - Per-pair Δ input tokens = `candidate.total_tokens.input - current.total_tokens.input`
   - Per-pair Δ output tokens = `candidate.total_tokens.output - current.total_tokens.output`
   - Corpus-aggregate: mean Δ turns, mean Δ input tokens, mean Δ output tokens, p95 of each
   - Pairs missing telemetry are EXCLUDED from the cost denominator (DO NOT zero-fill; absence ≠ zero)

4. **Axis 3 — Verdict distribution.** For each pair where BOTH sides have `verdict` populated:
   - Per-pair categorical comparison: `same | shifted-up | shifted-down | other` (where "up" = toward SHIP_IT, "down" = toward NEEDS_MAJOR_REWORK along the conventional ladder SHIP_IT > LGTM_WITH_NOTES > NEEDS_MINOR_FIXES > NEEDS_MAJOR_REWORK)
   - Corpus-aggregate: per-verdict count for current pack vs candidate pack; total-variation distance between the two distributions (TV distance: 0.5 × sum of absolute differences in normalized probability mass per category)
   - Pairs missing verdict on either side are EXCLUDED from the verdict denominator
   - The ladder ordering is HARDCODED in this story (not pack-configurable) — document it as a known coupling to the BMad verdict vocabulary; methodology-swap work is out of scope per Epic 81 design principle 7

5. **Axis 4 — Recovery taxonomy distribution.** For each pair:
   - Extract the set of recovery class names from `current.recovery_history` and `candidate.recovery_history` (e.g., `build-failure`, `ac-missing-evidence`, etc.)
   - Per-pair: bucket each side's recovery actions by class; count `{ classA: 2, classB: 1, … }` per side
   - Corpus-aggregate: total counts per class for each pack; TV distance between the two distributions
   - Pairs with empty recovery_history on both sides are EXCLUDED from the recovery denominator (no signal to compare)

6. **Per-axis verdict (GREEN/YELLOW/RED) computed against configurable thresholds.** Each axis has its own threshold config:
   - `options.thresholds.codeQuality = { warn: 0.05, fail: 0.15 }` (mean Δ; negative = regression)
   - `options.thresholds.cost = { warnTurns: 0.10, failTurns: 0.25, warnTokens: 0.15, failTokens: 0.30 }` (relative — Δ / current_mean)
   - `options.thresholds.verdict = { warnTV: 0.10, failTV: 0.20 }` (total-variation distance)
   - `options.thresholds.recovery = { warnTV: 0.10, failTV: 0.20 }`
   - Per axis: GREEN if all thresholds clear; YELLOW if warn-threshold crossed; RED if fail-threshold crossed
   - Overall verdict = worst per-axis verdict (RED > YELLOW > GREEN)

7. **Output shape (`PackUpgradeGradeResult`).** `gradeAll` returns:
   ```javascript
   {
     overall_verdict: 'GREEN' | 'YELLOW' | 'RED',
     axes: {
       code_quality: { verdict, mean_delta, median_delta, regression_count, improvement_count, ungradable_count, per_pair: [...] },
       cost: { verdict, mean_delta_turns, mean_delta_input_tokens, mean_delta_output_tokens, p95s: {...}, ungradable_count, per_pair: [...] },
       verdict: { verdict, current_distribution, candidate_distribution, tv_distance, ungradable_count, per_pair: [...] },
       recovery: { verdict, current_distribution, candidate_distribution, tv_distance, ungradable_count, per_pair: [...] }
     },
     thresholds_used: <the options.thresholds object>,
     pair_count: <total pairs in input>,
     pair_outcomes: { 'both-completed': N, 'one-completed': N, ... }
   }
   ```

8. **Code-quality axis ground-truth resolution.** For each pair, the ground-truth diff comes from the corpus entry's `commit_sha` (resolved from the parent SHA via `git diff <parent_sha> <commit_sha>`). Since the grader is pure, ground-truth resolution is the CALLER's responsibility — the caller (81-4) reads ground truths before invoking `gradeAll`. Pass ground truths in `pairs[i].ground_truth_diff` (added to the pair shape by 81-4 before invoking the grader).

9. **Configurable options.** `options` accepts:
   - `thresholds`: per-axis thresholds (AC6)
   - `grayBand`: `{ lo: 0.4, hi: 0.8 }` for the code-quality judge trigger (AC2)
   - `judgeFn`: injectable LLM pairwise judge (signature: `judgeFn(currentDiff, candidateDiff, groundTruthDiff) → { winner: 'current'|'candidate'|'tie', confidence: number }`); when absent, gray-band pairs use the deterministic score directly (no judge)
   - `verdictLadder`: array of verdict literals in conventional order (defaults to `['SHIP_IT', 'LGTM_WITH_NOTES', 'NEEDS_MINOR_FIXES', 'NEEDS_MAJOR_REWORK']`)

10. **Pure helpers extracted.** Decompose into testable units in `scripts/eval-pack-upgrade/grader-lib.mjs`:
    - `gradeCodeQualityAxis(pairs, options) → axis_result`
    - `gradeCostAxis(pairs, options) → axis_result`
    - `gradeVerdictAxis(pairs, options) → axis_result`
    - `gradeRecoveryAxis(pairs, options) → axis_result`
    - `computeAxisVerdict(metrics, thresholds) → 'GREEN'|'YELLOW'|'RED'` (per-axis threshold logic)
    - `aggregateOverallVerdict(axisVerdicts) → 'GREEN'|'YELLOW'|'RED'`
    - `totalVariationDistance(distributionA, distributionB) → number`
    - `verdictLadderPosition(verdict, ladder) → number` (returns the index; unknown verdicts → -1 / 'other')

11. **Unit tests.** Co-located at `scripts/eval-pack-upgrade/__tests__/grader.test.ts`. Cover:
    - Code-quality axis: pair where candidate clearly better; pair where current clearly better; gray-band pair triggers judge; ungradable pair excluded; both-incomplete pair excluded
    - Cost axis: per-pair Δ computation; missing telemetry excludes pair; aggregate mean correct; p95 correct
    - Verdict axis: same-verdict pair contributes to "same"; shifted-up; shifted-down; unknown verdict goes to "other"; TV distance correct against known fixtures
    - Recovery axis: empty-both excluded; class distribution counted correctly; TV distance correct
    - Per-axis verdict thresholds: GREEN at zero delta; YELLOW at warn threshold; RED at fail threshold
    - Overall verdict aggregation: worst-axis-wins (RED > YELLOW > GREEN)
    - `gradeAll` integration: synthetic 3-pair input produces correct per-axis + overall verdicts
    - LLM judge mocked

12. **No live model calls in tests.** The injectable `judgeFn` is mocked in every test. Live judge integration is the operator's job (via 81-4's CLI configuration).

13. **No behavior change to substrate.** This story adds a new pure-function module + tests. No orchestrator, schema, or dispatch changes. Full eval-outcomes gate and existing reconstruction grader tests (`scripts/eval-reconstruction/__tests__/grader.test.ts`) must remain GREEN.

## Tasks / Subtasks

- [ ] **Task 1 — Identify reusable Epic 77 reconstruction grader helpers**
  - [ ] Read `scripts/eval-reconstruction/grader.mjs` end-to-end
  - [ ] Identify the exports: `deterministicSignal`, `isGrayBand`, `combineScore`, `computeRubric`, etc.
  - [ ] Confirm signatures and dependencies; document any helper that needs additive generalization for 81-3's use case

- [ ] **Task 2 — Create `scripts/eval-pack-upgrade/grader-lib.mjs`** (AC10)
  - [ ] Implement and export each pure helper from AC10
  - [ ] `gradeCodeQualityAxis` imports `deterministicSignal` from Epic 77 reconstruction grader
  - [ ] `totalVariationDistance`: `0.5 × Σ|p_a(class) - p_b(class)|` over the union of classes; verify on known fixtures
  - [ ] `verdictLadderPosition`: lookup in the configured ladder; -1 (or null) for unknown verdicts (AC4 "other" bucket)
  - [ ] `computeAxisVerdict` per-axis threshold logic — split into `computeCodeQualityVerdict`, `computeCostVerdict`, etc. since each axis has differently-shaped metrics

- [ ] **Task 3 — Create `scripts/eval-pack-upgrade/grader.mjs`** (AC1, AC7, AC9)
  - [ ] Export `gradeAll(pairs, options)` per AC1
  - [ ] Default `options` per AC9 — code-quality grayBand, default thresholds, default verdictLadder
  - [ ] Compose the four per-axis graders + aggregate verdict via `aggregateOverallVerdict`
  - [ ] Return the shape from AC7

- [ ] **Task 4 — Unit tests** (AC11, AC12)
  - [ ] Create `scripts/eval-pack-upgrade/__tests__/grader.test.ts`
  - [ ] Cover all AC11 scenarios with synthetic envelope fixtures
  - [ ] All judge calls go through a mocked `judgeFn`
  - [ ] All tests run in `npm run test:fast`

- [ ] **Task 5 — Regression validation** (AC13)
  - [ ] `npm run build`
  - [ ] `npm run test:fast` (gates: new grader tests + existing reconstruction grader tests + Epic 77 outcome-grader tests all pass)
  - [ ] `node scripts/eval-outcomes.mjs --threshold 0.95` (gates: 77-1 regression GREEN)

## Dev Notes

### Pure-function design — the testability dividend

Per Epic 81's Design Principle 3, the grader is fully pure. Benefits:
- Tests need no `git`, no dispatch, no LLM
- The grader is composable in other contexts (e.g., a future hill-climbing loop per 77-7 could reuse `gradeCodeQualityAxis` against a different pair source)
- The boundary between "harness produces envelopes" and "grader scores envelopes" is the integration point — 81-4 (CLI) glues them with file I/O and ground-truth resolution

The single point where 81-3 has a soft dep on something non-pure is the `judgeFn` — and that's injectable. The default fallback when no judge is provided is the pure deterministic score, so tests run without invoking it.

### Reusing 77-9's deterministic signal

77-9's `deterministicSignal(reconstructedDiff, actualCommitDiff)` is defined as `0.5·fileSetJaccard + 0.5·testPassOverlap`. For 81-3:
- For pack A: `deterministicSignal(current.diff, groundTruth.diff)`
- For pack B: `deterministicSignal(candidate.diff, groundTruth.diff)`
- The per-pair Δ is `signalB - signalA`

This means a pair where the candidate pack's dispatch produced a closer match to the historical merge commit gets a positive Δ; a pair where the candidate diverged further gets a negative Δ. Corpus-aggregate Δ shows the average direction of drift.

A subtle case: if BOTH packs produce identical diffs (perhaps both ship the right answer), Δ = 0 and the pair contributes to "no change" — fine, that's the truth. If neither pack matches ground truth at all (both signals very low), Δ may still be near zero — that's a corpus-quality signal worth surfacing in the report (81-4's job) but not a grader bug.

### Verdict ladder coupling

The verdict ladder `[SHIP_IT, LGTM_WITH_NOTES, NEEDS_MINOR_FIXES, NEEDS_MAJOR_REWORK]` is BMad-specific. The 2026-05-31 pack-abstraction audit identified verdict vocabulary as a high-coupling layer; Epic 81's design principle 7 explicitly defers methodology substitution to a separate epic. So:
- Hardcode the BMad ladder as the default
- Expose it as a configurable option (`options.verdictLadder`) for forward-compat
- Document in the JSDoc that changing the ladder is a methodology-substitution concern, not a pack-upgrade concern
- Unknown verdicts go to an "other" bucket and contribute to the distribution but not the up/down classification

### Total-variation distance — why this metric

TV distance between two discrete distributions is `0.5 × Σ|p(x) - q(x)|`. It bounds the maximum probability one distribution can put on any single event differently from the other. It's:
- Bounded in [0, 1] — comparable across axes
- Symmetric — pack-A→pack-B and pack-B→pack-A give the same distance
- Interpretable — 0.10 TV = at most 10pp shift in any single category
- Cheap to compute — pure arithmetic

Alternatives considered and rejected: KL divergence (asymmetric, undefined when one distribution has a zero), JS divergence (more complex, similar info to TV), chi-squared (sensitive to small denominators in our small-sample regime).

### Canonical Import Paths

| Helper | Import path |
|---|---|
| `deterministicSignal` / `isGrayBand` / `combineScore` | `scripts/eval-reconstruction/grader.mjs` (or its lib) |
| Pair envelope JSON shape | Output of `scripts/eval-pack-upgrade/harness.mjs` (Story 81-2) |
| `computeRubric` | `scripts/eval-outcomes/lib.mjs` (if useful for per-axis thresholding; otherwise reimplement the simple warn/fail logic) |

### Reference Files (do NOT modify)

| File | Purpose |
|---|---|
| `scripts/eval-reconstruction/grader.mjs` | Source of `deterministicSignal` + gray-band judge pattern |
| `scripts/eval-pack-upgrade/harness.mjs` | Pair envelope producer (Story 81-2) |
| `scripts/eval-outcomes/lib.mjs` | Reference for rubric pattern |

### Testing Requirements

- Framework: **vitest**
- No live model calls, no I/O, no git ops in tests
- `judgeFn` is mocked in every test using `vi.fn()` returning canned results
- Synthetic envelope fixtures cover each AC11 scenario
- All tests run in `npm run test:fast` (target < 0.5s contribution)
- Existing Epic 77 grader tests must continue passing

### Key Files

| File | Purpose |
|---|---|
| `scripts/eval-pack-upgrade/grader.mjs` | Top-level `gradeAll` (Task 3) |
| `scripts/eval-pack-upgrade/grader-lib.mjs` | Pure helpers (Task 2) |
| `scripts/eval-pack-upgrade/__tests__/grader.test.ts` | Unit tests (Task 4) |
| `scripts/eval-reconstruction/grader.mjs` | Imported for `deterministicSignal` etc. |

## Interface Contracts

- **Input**: per-pair envelope JSON shape from Story 81-2 (with `ground_truth_diff` added by Story 81-4 caller).
- **Output**: `PackUpgradeGradeResult` shape (AC7), contracted with Story 81-4. Coordinate any change.
- **Reuses**: `deterministicSignal` + `isGrayBand` + gray-band judge pattern from Story 77-9.
- **Verdict ladder**: hardcoded BMad default; methodology-substitution work is OUT OF SCOPE.

## Runtime Probes

Not applicable — this story is pure-function logic with extensive unit-test coverage. No runtime side effects, no spawned subprocesses, no external state.

## Dev Agent Record

### Agent Model Used
<to be filled in by dispatched agent>

### Completion Notes List
<to be filled in by dispatched agent>

### File List
<to be filled in by dispatched agent>

## Change Log
