# Story 81-11: Un-gate the quality-aware LLM judge so subtle regressions actually reach it

## Story

As a substrate eval-framework operator,
I want the quality-aware LLM judge to be invokable for any pair where a quality verdict matters — not only when the deterministic score happens to land in the 0.4–0.8 gray band AND `--judge-model` is passed,
so that the one mechanism capable of *reading* work-quality differences isn't structurally bypassed exactly when a subtle regression needs it.

This is follow-up #3 of three from the Phase 4.2 v4 re-validation (2026-06-06). It is the smallest of the three and partly overlaps Story 81-10 — it can be folded into 81-10 if dispatched together. See the "Phase 4.2 v4" section of `docs/2026-05-31-epic-81-first-calibration.md`.

## Background — the double gate (established fact; do NOT re-derive)

The LLM judge in `scripts/eval-pack-upgrade/grader-lib.mjs` is the only quality-aware signal in the grader today, but it fires only when BOTH:
1. `min(currentScore, candidateScore)` lands inside `DEFAULT_GRAY_BAND = { lo: 0.4, hi: 0.8 }` (`grader-lib.mjs:93`, used at `gradeCodeQualityAxis` ~line 315), AND
2. `--judge-model` is supplied (`buildJudgeFn` wired in `scripts/eval-pack-upgrade.mjs:325`; absent → no `judgeFn` → judge never called).

A subtle regression whose deterministic file-set scores fall OUTSIDE the gray band (as in Phase 4.2 v4, where the candidate scored +0.285 — well above the 0.8 ceiling) never triggers the judge. So the quality-aware mechanism is dark precisely for the regressions that need it. The gray band was introduced as a *cost-bounding* device (only pay for an LLM call in the ambiguous middle), which is reasonable for cost but wrong as the *sole* gate on quality detection.

## Acceptance Criteria

1. **Add a quality-trigger path independent of the gray band.** Introduce a way to invoke the judge when a quality verdict matters even if the deterministic score is outside 0.4–0.8 — e.g. when `gradeWorkQualityAxis` (Story 81-10) flags a candidate-vs-current quality delta, or via an explicit `--judge-always` / `--judge-on-quality-delta` flag. The gray-band cost-bounding behavior remains the **default** (no surprise cost); the new path is opt-in or driven by the work-quality signal.

2. **Preserve cost-bounding by default.** With no new flag and no quality-delta trigger, behavior is unchanged: the judge fires only in the gray band when `--judge-model` is set. No dispatch or grading run starts paying for judge calls it didn't before unless explicitly opted in.

3. **The judge receives the information it needs to judge quality.** When invoked, `judgeFn(currentDiff, candidateDiff, groundTruthDiff)` is called with the real diffs (it already has this signature, `grader-lib.mjs:373`). If the work-quality signal from 81-10 is available, pass it through so the judge can corroborate. The judge's verdict feeds the code-quality (or work-quality) axis per-pair entry.

4. **Demonstrate the un-gated judge catches the TDD-removal regression.** With `--judge-model <model>` and the new trigger enabled, re-run Phase 4.2 (the `/tmp/pack-degraded` TDD-removal target) against the fixture corpus and confirm the judge identifies the candidate pack's output as lower-quality (test-first discipline absent), flipping the relevant axis to 🟡/🔴. Live-model run, operator-driven; record the result + the judge's reasoning sample in the calibration doc.

5. **Cost guardrail.** The judge path respects the existing per-case budget (`--budget-per-case-usd`, default 2.00). Document the incremental judge cost per pair in Dev Notes so the operator can reason about a full-corpus run.

6. **Unit tests**: (a) default behavior — judge NOT called outside the gray band when no trigger flag/signal is present; (b) with the trigger, judge IS called outside the gray band; (c) judge verdict correctly drives the per-pair axis entry; (d) judge errors are non-fatal (pair degrades to the deterministic score, not a crash). Use a stub `judgeFn` — no live model calls in the suite.

7. **No behavior change to substrate's production dispatch path.** Grader/CLI-only changes. Forward-only/additive.

8. **Ship gate stays GREEN**: `npm run build`, `npm run test:fast`, `node scripts/eval-outcomes.mjs --threshold 0.95`.

9. **Documentation**: update `docs/2026-05-31-epic-81-first-calibration.md` with the new judge-trigger semantics and the Phase 4.2 re-run result.

## Tasks / Subtasks

- [ ] **Task 1 — Design the quality-trigger (flag and/or 81-10-signal-driven)** (AC1, AC2)
- [ ] **Task 2 — Implement the un-gated invocation path** (AC1, AC3)
- [ ] **Task 3 — Cost guardrail wiring** (AC5)
- [ ] **Task 4 — Phase 4.2 re-run with judge** (AC4)
- [ ] **Task 5 — Unit tests** (AC6)
- [ ] **Task 6 — Documentation** (AC9)
- [ ] **Task 7 — Regression validation** (AC8)

## Dev Notes

### Relationship to 81-10 (strong overlap — consider folding)

81-10 adds a *deterministic* work-quality axis; this story makes the *LLM judge* reachable beyond the gray band. They are complementary: 81-10 is the cheap always-on floor; 81-11 is the precise-but-paid refiner. If dispatched together, the natural split is: **81-10 owns `gradeWorkQualityAxis` and the deterministic signal; 81-11 owns the judge-trigger condition and `buildJudgeFn` wiring.** Shared touch-point: the per-pair grading loop in `gradeCodeQualityAxis`/`gradeAll`. If only one is built, 81-10 is higher priority (it works without an API/judge model and without extra cost). Filing 81-11 separately keeps the cost-bearing change isolated and individually reviewable.

### Canonical paths

| Item | Path |
|---|---|
| Gray band constant | `scripts/eval-pack-upgrade/grader-lib.mjs:93` (`DEFAULT_GRAY_BAND`) |
| Judge trigger site | `scripts/eval-pack-upgrade/grader-lib.mjs:~315`, call at `~373` |
| `buildJudgeFn` + `--judge-model` wiring | `scripts/eval-pack-upgrade.mjs:325` |
| Per-case budget flag | `scripts/eval-pack-upgrade.mjs` (`--budget-per-case-usd`, default 2.00) |
| Report formatter | `scripts/eval-pack-upgrade/cli-lib.mjs` |

### Testing Requirements

- Framework: **vitest**; stub `judgeFn`, no live model calls in the suite
- The Phase 4.2 re-run (AC4) is the operator-driven live-model validation, outside `npm run test:fast`

## Interface Contracts

- **New opt-in trigger** (flag and/or 81-10 quality-delta signal) — additive; default behavior (gray-band-only, cost-bounded) is preserved.
- **`judgeFn(currentDiff, candidateDiff, groundTruthDiff)`** signature unchanged (`grader-lib.mjs:373`); this story changes *when* it is called, not its contract.
- **No change** to substrate's dispatch path or the envelope schema.

## Dev Agent Record

### Agent Model Used
<to be filled in by dispatched agent>

### Completion Notes List
<to be filled in by dispatched agent>

### File List
<to be filled in by dispatched agent>

## Change Log
