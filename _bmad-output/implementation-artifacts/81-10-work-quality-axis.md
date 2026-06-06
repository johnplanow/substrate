# Story 81-10: Add a work-quality axis (detect quality regressions the file-set metric can't see)

## Story

As a substrate eval-framework operator,
I want the pack-upgrade grader to score the *quality* of the dispatched work — not just *which files changed* — so that subtle prompt-quality regressions (e.g. removing the Red-Green-Refactor / TDD discipline from `dev-story.md`) are detected,
so that Epic 81 can gate BMad pack upgrades on the kind of degradation that preserves the file-set but erodes how the work is done.

This is follow-up #2 of three from the Phase 4.2 v4 re-validation (2026-06-06), and it is the substantive one — it addresses the core capability ceiling. See the "Phase 4.2 v4" section of `docs/2026-05-31-epic-81-first-calibration.md`.

## Background — why the current code-quality axis is structurally blind (established fact; do NOT re-derive)

The existing code-quality axis (`gradeCodeQualityAxis` + `scorePackDiffAgainstGroundTruth` in `scripts/eval-pack-upgrade/grader-lib.mjs`) scores **file-set Jaccard between the dispatched pack's diff and the ground-truth commit diff**. It measures *which files change*, not *how well the work is done*.

Empirical proof (Phase 4.2 v4, fixture corpus, 2 gradable pairs): the TDD-removal regression — strip `(Red-Green-Refactor)` and the "write failing tests first / make pass / refactor" bullets from `dev-story.md`, leaving the file otherwise intact — scored **+0.285 (an apparent *improvement*)**, because removing TDD discipline doesn't change which files a competent model touches; the file-set overlap drifted toward ground truth by chance. A file-set metric cannot, even in principle, see a work-quality regression that preserves the file-set.

The gray-band LLM judge (`DEFAULT_GRAY_BAND = { lo: 0.4, hi: 0.8 }`, `grader-lib.mjs:93`) is the only quality-aware mechanism today, but it is double-gated (only fires when the deterministic score lands in the gray band AND `--judge-model` is supplied) — Story 81-11 addresses that gating. This story adds the *quality signal itself*.

## Acceptance Criteria

1. **Define a work-quality signal extractable from the dispatch (no second model call required for the deterministic floor).** Candidate signals — pick one or a small composite, justify the choice in Dev Notes:
   - **Test-presence**: did the dispatched diff add/modify test files (matching the project's test-path patterns) at all?
   - **Test-first / TDD adherence**: from the dispatch transcript or the agent's structured output, is there evidence tests were written before (or alongside) implementation, vs. implementation-only?
   - **Test-to-impl ratio**: ratio of test-file lines to non-test-file lines in the diff, compared between current and candidate packs.
   The signal must be **deterministic and cheap** (derived from the diff and/or transcript already captured by the harness), so it works without `--judge-model`.

2. **Add a new grading axis** (e.g. `gradeWorkQualityAxis`) in `scripts/eval-pack-upgrade/grader-lib.mjs`, following the existing axis contract (per-pair entries with `gradable`/`reason`, a mean Δ, a warn/fail threshold, a 🟢/🟡/🔴 verdict). Additive — does not modify the existing four axes' behavior.

3. **Wire the new axis into `gradeAll` and the report.** The overall verdict aggregation (`scripts/eval-pack-upgrade/grader.mjs` / `cli-lib.mjs` report formatter) includes the new axis in all three formats (markdown/json/plain). Additive column/section.

4. **The TDD-removal regression is detected.** Re-run Phase 4.2 (the same `/tmp/pack-degraded` target: `packs/bmad` with the `(Red-Green-Refactor)` block stripped from `prompts/dev-story.md`) against the fixture corpus and confirm the new axis flips to 🟡 or 🔴 — i.e. the candidate pack's work-quality signal is measurably worse than current. Capture per-pair scores and the mean Δ. This is a live-model run (operator-driven, ~20 min, real $); record the result in the calibration doc.

5. **Thresholds grounded empirically.** Set the new axis's warn/fail thresholds from the Phase 4.2 re-run distribution (AC4), not guessed. Document the empirical basis.

6. **Guard against false positives on legitimate non-test stories.** A story that legitimately touches no tests (docs-only, config-only) must not score as a work-quality *regression* purely for lack of tests when BOTH packs produce no test changes. Mark such pairs ungradable (`reason: 'no-quality-signal'`) rather than penalizing them — mirror the `no-measurable-diff` discipline from 81-7.

7. **Unit tests**: the new axis against synthetic envelopes — (a) candidate with no tests vs current with tests → regression; (b) both with tests → gradable, near-zero Δ; (c) both without tests → ungradable `no-quality-signal`; (d) threshold boundary → correct verdict. No live model calls in the suite.

8. **No behavior change to substrate's production dispatch path.** Grader-only + report-only changes. Forward-only/additive.

9. **Ship gate stays GREEN**: `npm run build`, `npm run test:fast`, `node scripts/eval-outcomes.mjs --threshold 0.95`.

10. **Documentation**: update `docs/2026-05-31-epic-81-first-calibration.md` with the new axis, the Phase 4.2 re-run result (TDD-removal now caught — or, if still not caught, an honest note on the residual gap and next lever).

## Tasks / Subtasks

- [ ] **Task 1 — Choose + spec the work-quality signal** (AC1)
- [ ] **Task 2 — Implement `gradeWorkQualityAxis`** (AC2, AC6)
- [ ] **Task 3 — Wire into `gradeAll` + all three report formats** (AC3)
- [ ] **Task 4 — Phase 4.2 re-run; tune thresholds** (AC4, AC5)
- [ ] **Task 5 — Unit tests** (AC7)
- [ ] **Task 6 — Documentation** (AC10)
- [ ] **Task 7 — Regression validation** (AC9)

## Dev Notes

### Relationship to 81-9 and 81-11

- **81-9** (cost axis / `total_turns`) is independent and may detect TDD-removal via the turns delta on its own; this story is the *direct* quality signal and the more robust detector. Land 81-9 first if sequencing, but they do not conflict (different axes).
- **81-11** un-gates the LLM judge. This story's deterministic work-quality signal is the floor; 81-11's judge can be wired to *refine* it in the gray band. If 81-10 and 81-11 are dispatched together, 81-10 owns `gradeWorkQualityAxis` and 81-11 owns the judge-trigger logic — coordinate on the `gradeAll` wiring (one shared touch-point in `grader.mjs`).

### Canonical paths

| Item | Path |
|---|---|
| Existing axes + thresholds + gray band | `scripts/eval-pack-upgrade/grader-lib.mjs` |
| `gradeAll` aggregation | `scripts/eval-pack-upgrade/grader.mjs` |
| Report formatter (md/json/plain) | `scripts/eval-pack-upgrade/cli-lib.mjs` |
| Per-pair envelope shape (has `diff`, `total_tokens`, transcript fields) | `scripts/eval-pack-upgrade/lib.mjs` (`normalizeDispatchEnvelope`) |
| The regression target | `/tmp/pack-degraded` (cp of `packs/bmad`, TDD block stripped) or `packs/bmad/prompts/dev-story.md:39-43` |
| Fixture corpus (4 grounded pairs) | `_bmad-output/eval-results/corpus/pack-upgrade-fixture-corpus.yaml` |

### Testing Requirements

- Framework: **vitest**; synthetic envelopes only in the suite
- The Phase 4.2 re-run (AC4) is the operator-driven live-model validation, outside `npm run test:fast`

## Interface Contracts

- **New axis result object** mirrors the existing axis contract (`{ verdict, mean_delta, per_pair[], thresholds }`) — additive to `gradeAll`'s return and the report schema.
- **New ungradable reason `'no-quality-signal'`** — additive value in the existing reason vocabulary.
- **No change** to the existing four axes or to substrate's dispatch path.

## Dev Agent Record

### Agent Model Used
<to be filled in by dispatched agent>

### Completion Notes List
<to be filled in by dispatched agent>

### File List
<to be filled in by dispatched agent>

## Change Log
