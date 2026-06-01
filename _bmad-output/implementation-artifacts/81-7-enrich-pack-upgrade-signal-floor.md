# Story 81-7: Enrich the pack-upgrade signal floor

## Story

As a substrate eval-framework operator,
I want the pack-upgrade harness to actually detect prompt-quality regressions when they exist (not silently return GREEN due to degenerate scoring against near-empty diffs),
so that Epic 81's deliberate-regression test (Phase 4.2) becomes a meaningful capability validation rather than a vacuous PASS.

This story fixes a CAPABILITY DEFECT identified during the 2026-05-31 → 2026-06-01 autonomous /goal session. The dispatcher wiring (Story 81-6) is solid and real model dispatches succeed end-to-end, but the **signal floor** is too thin — most dispatches produce near-empty diffs and the deterministic Jaccard scoring degenerates to 1.000 = 1.000 → Δ = 0 → "no regression" regardless of pack quality.

See `docs/2026-05-31-epic-81-first-calibration.md` for the full empirical findings.

## Acceptance Criteria

1. **Fix `total_turns` capture** in `defaultCaptureEnvelope` at `scripts/eval-pack-upgrade/harness.mjs:defaultCaptureEnvelope`. Audit substrate's `DispatchResult` interface at `packages/core/src/dispatch/types.ts` to identify the actual field name carrying turn count (it may be `turnCount`, `metadata.turns`, or genuinely missing — if missing, this needs a separate forward-only addition to `DispatchResult`). When the field is found / added, wire it through to `total_turns` on the envelope. Cost axis becomes gradable as a direct consequence.

2. **Fix the degenerate-empty Jaccard** in the code-quality axis. Currently `deterministicSignal(emptyDiff, anyDiff)` returns 1.000 because Jaccard of two empty sets is conventionally 1. For pack-upgrade A/B, this is the wrong signal — empty-empty pairs should be EXCLUDED from the denominator (mark `gradable: false, reason: 'no-measurable-diff'`) rather than score as a perfect match. Update `scripts/eval-pack-upgrade/grader-lib.mjs:gradeCodeQualityAxis` (and `deterministicSignal` if cleanly factorable) to handle this case explicitly.

3. **Investigate why dev-story dispatches produce near-empty diffs** against the fixture corpus. Empirical observation: harness durations were 76s–1483s per dispatch but resulting diffs were 30–494 characters. Likely causes:
   - Pack template `{{test_patterns}}`, `{{prior_files}}`, `{{project_context}}`, `{{repo_context}}` placeholders are silently cleared by the harness's inline assembler (production substrate populates these via DB context-compiler queries)
   - The model exits early without making meaningful changes because context is sparse
   - The story files in the corpus are test-only or otherwise narrow-scope
   
   Document findings in Dev Notes. Either (a) populate the placeholders with minimal stub content so dispatches have something to chew on, OR (b) document that the corpus needs richer stories and file a corpus-extension followup.

4. **Add a stronger Phase 4.2 regression target** if the TDD-removal degradation continues to produce sub-detectable signal even after AC1-3 are addressed. Options to test:
   - Remove the `## CRITICAL: Output Contract Emission` section — would cause the model to emit no YAML, escalating with `verdict: failed`
   - Remove the build-verify reminder — model less likely to verify before declaring done
   - Replace the entire dev-story.md with an empty file — extreme regression that MUST be detected
   
   The intent is to confirm the framework CAN detect SOME regression class, even if the specific TDD-removal target isn't sensitive enough today.

5. **Re-run Phase 4.2 against the same TDD-removal target** after AC1-4 are addressed. Capture:
   - Per-pair scores (expected: at least some pairs show `current_score != candidate_score`)
   - Mean Δ across the corpus
   - Whether ANY axis flips to YELLOW or RED (the regression is detectable somewhere)
   
   Update `docs/2026-05-31-epic-81-first-calibration.md` with the re-run results.

6. **Update threshold defaults** in `scripts/eval-pack-upgrade/grader-lib.mjs` if the empirical distribution from the re-run reveals the current defaults (warn: 0.05 / fail: 0.15 for code-quality) are wildly mismatched. Document the empirical basis for whatever the new defaults are.

7. **Unit tests** for the new edge cases:
   - `deterministicSignal` empty-vs-empty: tests that the empty-empty pair is marked ungradable, NOT 1.000
   - `defaultCaptureEnvelope` total_turns extraction: tests against a synthetic `DispatchResult` shape
   - Per-pair grading with `no-measurable-diff` ungradable reason

8. **No behavior change to substrate's production dispatch path.** Same constraint as Story 81-6. The Dispatcher and DispatchResult schemas are touched only additively (forward-only). The orchestrator continues to work unchanged.

9. **Ship gate stays GREEN.** Full `npm run build`, `npm run test:fast`, and `node scripts/eval-outcomes.mjs --threshold 0.95` must all stay GREEN throughout.

10. **Documentation updates.** Update `docs/2026-05-31-epic-81-first-calibration.md` "What's BLOCKED on Story 81-7" section to reflect 81-7 having landed; document the new capability ceiling empirically.

## Tasks / Subtasks

- [ ] **Task 1 — Audit DispatchResult for turn count** (AC1)
- [ ] **Task 2 — Add total_turns field if needed** (AC1, additive forward-only)
- [ ] **Task 3 — Wire total_turns into defaultCaptureEnvelope** (AC1)
- [ ] **Task 4 — Fix empty-empty Jaccard handling** (AC2)
- [ ] **Task 5 — Investigate near-empty diff root cause** (AC3)
- [ ] **Task 6 — Populate placeholder stubs in harness pack-template assembly** (AC3, if applicable)
- [ ] **Task 7 — Choose + apply a stronger regression target** (AC4)
- [ ] **Task 8 — Re-run Phase 4.2** (AC5)
- [ ] **Task 9 — Update threshold defaults if empirically warranted** (AC6)
- [ ] **Task 10 — Unit tests** (AC7)
- [ ] **Task 11 — Documentation updates** (AC10)
- [ ] **Task 12 — Regression validation** (AC9)

## Dev Notes

### Context

This story exists because the 2026-05-31 autonomous /goal session's Phase 4.2 deliberate-regression test produced vacuous GREEN despite a real pack content change (TDD discipline removed from dev-story prompt). The framework's plumbing works — real dispatches fire, real diffs are captured — but the deterministic scoring degenerates when diffs are near-empty.

Full empirical data is in `docs/2026-05-31-epic-81-first-calibration.md`. Read it before starting.

### Why this is filed as a separate story

The original Story 81-2 (harness) and Story 81-3 (grader) were both written to a "pure helpers + injectable I/O" discipline. Their tests pass synthetic envelopes that are well-shaped — the degeneracy only appears against real-world envelope shapes that the test suite couldn't anticipate. This is exactly the kind of finding that calibration runs are supposed to surface.

The fixes themselves are forward-only-additive: a new ungradable reason, a fixed empty-empty case, a new envelope field (if needed). No breaking changes to existing tests.

### Canonical Import Paths

| Helper | Import path |
|---|---|
| `DispatchResult` shape | `packages/core/src/dispatch/types.ts:87` |
| `defaultCaptureEnvelope` | `scripts/eval-pack-upgrade/harness.mjs` |
| `deterministicSignal` | `scripts/eval-reconstruction/grader.mjs` (or its lib) |
| `gradeCodeQualityAxis` | `scripts/eval-pack-upgrade/grader-lib.mjs` |

### Reference Files

| File | Purpose |
|---|---|
| `docs/2026-05-31-epic-81-first-calibration.md` | Empirical findings driving this story |
| `_bmad-output/eval-results/corpus/pack-upgrade-fixture-corpus.yaml` | 4-pair fixture corpus |
| `/tmp/harness-direct-2.json` | Phase 4.1 raw harness envelopes |
| `/tmp/regression-report.json` | Phase 4.2 JSON report with degenerate scores |
| `packs/bmad/prompts/dev-story.md` | Current pack's dev-story prompt |

### Testing Requirements

- Framework: **vitest**
- Unit tests use synthetic envelopes; no live model calls in test suite
- The Phase 4.2 re-run (AC5) IS a live-model test, run by the operator after the story merges; not part of `npm run test:fast`

## Interface Contracts

- **`DispatchResult.totalTurns?`** (if added per AC1): additive forward-only schema field on the existing `DispatchResult` type. Adapter implementations populate it; absence is acceptable on pre-81-7 dispatches.
- **`code_quality.per_pair[].reason: 'no-measurable-diff'`** (new ungradable reason): additive value in the existing reason vocabulary.

## Runtime Probes

Not applicable — this story is pure-function + grader logic changes with extensive unit-test coverage. Real-world validation is via the Phase 4.2 re-run (AC5), which is the operator-driven calibration step.

## Dev Agent Record

### Agent Model Used
<to be filled in by dispatched agent>

### Completion Notes List
<to be filled in by dispatched agent>

### File List
<to be filled in by dispatched agent>

## Change Log
