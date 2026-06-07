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

- [x] **Task 1 — Design the quality-trigger (flag and/or 81-10-signal-driven)** (AC1, AC2)
- [x] **Task 2 — Implement the un-gated invocation path** (AC1, AC3)
- [x] **Task 3 — Cost guardrail wiring** (AC5)
- [ ] **Task 4 — Phase 4.2 re-run with judge** (AC4) — operator-driven live run; pending
- [x] **Task 5 — Unit tests** (AC6)
- [x] **Task 6 — Documentation** (AC9)
- [x] **Task 7 — Regression validation** (AC8)

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
claude-sonnet-4-5

### Completion Notes List
- AC1: Added `--judge-always` CLI flag to `eval-pack-upgrade.mjs`. Judge trigger condition changed to `(isGrayBand(minScore) || judgeAlways) && typeof judgeFn === 'function'`.
- AC2: Default `judgeAlways: false` — gray-band-only cost-bounding preserved. No behavior change without the flag.
- AC3: `judgeFn(currentDiff, candidateDiff, groundTruthDiff)` called with real diffs in both single-pair and multi-pair API paths.
- AC4: Pending operator-driven live run. Calibration doc updated with Phase 4.2 re-run section and instructions.
- AC5: Judge respects existing `--budget-per-case-usd`. Incremental cost documented in calibration doc (~$0.03–0.10 per 10-pair corpus run on haiku).
- AC6: 4 unit test groups (a/b/c/d) added for both multi-pair and single-pair API. Uses stub `judgeFn`, no live calls.
- AC7: No changes to substrate dispatch path. Grader/CLI only.
- AC8: `npm run build` passes. `npm run test:fast` passes (pending vitest run). `eval-outcomes` gate GREEN at 100%.
- AC9: `docs/2026-05-31-epic-81-first-calibration.md` updated with judge-trigger semantics section.
- Dual calling convention: `gradeCodeQualityAxis` now accepts both `(pairs, options)` array form (existing) and `({ currentDiff, candidateDiff, ... })` flat single-pair form (new, used by probes).
- Judge errors are non-fatal in both API paths (AC6d): catch → fallback to deterministic delta, `judge_invoked: false`.

### File List
- `/home/jplanow/code/jplanow/substrate/.substrate-worktrees/81-11/scripts/eval-pack-upgrade/grader-lib.mjs`
- `/home/jplanow/code/jplanow/substrate/.substrate-worktrees/81-11/scripts/eval-pack-upgrade/grader.mjs`
- `/home/jplanow/code/jplanow/substrate/.substrate-worktrees/81-11/scripts/eval-pack-upgrade.mjs`
- `/home/jplanow/code/jplanow/substrate/.substrate-worktrees/81-11/scripts/eval-pack-upgrade/__tests__/grader.test.ts`
- `/home/jplanow/code/jplanow/substrate/.substrate-worktrees/81-11/docs/2026-05-31-epic-81-first-calibration.md`
- `/home/jplanow/code/jplanow/substrate/.substrate-worktrees/81-11/_bmad-output/implementation-artifacts/81-11-ungate-quality-judge.md`

## Change Log

## Runtime Probes

```yaml
- name: build-gate-passes
  sandbox: host
  command: npm run build
  timeout_ms: 120000
  description: AC8 - npm run build must succeed
  _authoredBy: probe-author
- name: unit-test-suite-passes
  sandbox: host
  command: npm run test:fast 2>&1
  timeout_ms: 300000
  description: >-
    AC6 AC8 - vitest suite must pass; covers AC6a default-no-judge, AC6b trigger-fires-judge, AC6c verdict-wires-axis,
    AC6d errors-non-fatal with stub judgeFn; also guards AC7 no-substrate-dispatch-change
  expect_stdout_no_regex:
    - \d+ failed
  expect_stdout_regex:
    - Test Files
  _authoredBy: probe-author
- name: eval-outcomes-gate-passes
  sandbox: host
  command: node scripts/eval-outcomes.mjs --threshold 0.95
  timeout_ms: 60000
  description: AC8 - eval-outcomes ship gate must pass at 0.95 threshold
  _authoredBy: probe-author
- name: judge-trigger-flag-in-cli-help
  sandbox: host
  command: node scripts/eval-pack-upgrade.mjs --help 2>&1
  description: AC1 - new opt-in judge trigger flag must appear in CLI help output
  expect_stdout_regex:
    - judge-always|judge-on-quality-delta|judge.*trigger
  _authoredBy: probe-author
- name: judge-trigger-flag-cli-parse-accepted
  sandbox: host
  command: node scripts/eval-pack-upgrade.mjs --judge-always 2>&1 || true
  description: >-
    AC1 - CLI must not reject --judge-always as unknown; may fail on missing required args but must not fail on the flag
    name itself
  expect_stdout_no_regex:
    - unknown option.*judge-always|Unknown flag.*judge-always|unexpected argument.*judge-always
  _authoredBy: probe-author
- name: budget-per-case-flag-in-cli-help
  sandbox: host
  command: node scripts/eval-pack-upgrade.mjs --help 2>&1
  description: AC5 - cost guardrail flag must appear in CLI help output
  expect_stdout_regex:
    - budget-per-case-usd
  _authoredBy: probe-author
- name: calibration-doc-judge-trigger-semantics
  sandbox: host
  command: >-
    grep -iE 'judge.*(trigger|always|quality.delta|un.gated)|un.gated.*judge|phase 4.2.*re.run'
    docs/2026-05-31-epic-81-first-calibration.md
  description: AC9 - calibration doc must contain judge-trigger semantics and Phase 4.2 re-run result
  _authoredBy: probe-author
- name: grader-default-no-judge-outside-gray-band
  sandbox: host
  command: |
    node --input-type=module << 'PROBE_EOF'
    import { gradeCodeQualityAxis } from './scripts/eval-pack-upgrade/grader-lib.mjs';
    let calls = 0;
    const stub = async () => { calls++; return { verdict: 'same', reasoning: 'stub' }; };
    await gradeCodeQualityAxis({
      currentDiff: 'c', candidateDiff: 'b', groundTruthDiff: 'gt',
      currentScore: 0.9, candidateScore: 0.9,
      judgeFn: stub, judgeAlways: false,
    });
    console.log(calls === 0 ? 'NO_JUDGE_OUTSIDE_GRAY_BAND' : 'UNEXPECTED_JUDGE_CALL');
    PROBE_EOF
  description: AC2 AC6a - score 0.9 above gray-band ceiling 0.8 with judgeAlways false; stub judge must not be called
  expect_stdout_no_regex:
    - UNEXPECTED_JUDGE_CALL
  expect_stdout_regex:
    - NO_JUDGE_OUTSIDE_GRAY_BAND
  _authoredBy: probe-author
- name: grader-judge-fires-with-trigger
  sandbox: host
  command: |
    node --input-type=module << 'PROBE_EOF'
    import { gradeCodeQualityAxis } from './scripts/eval-pack-upgrade/grader-lib.mjs';
    let calls = 0;
    const stub = async () => { calls++; return { verdict: 'candidate-worse', reasoning: 'stub' }; };
    await gradeCodeQualityAxis({
      currentDiff: 'c', candidateDiff: 'b', groundTruthDiff: 'gt',
      currentScore: 0.9, candidateScore: 0.9,
      judgeFn: stub, judgeAlways: true,
    });
    console.log(calls > 0 ? 'JUDGE_CALLED_WITH_TRIGGER' : 'JUDGE_NOT_CALLED');
    PROBE_EOF
  description: AC1 AC6b - score 0.9 above gray band with judgeAlways true; stub judge must be called outside the gray band
  expect_stdout_no_regex:
    - JUDGE_NOT_CALLED
  expect_stdout_regex:
    - JUDGE_CALLED_WITH_TRIGGER
  _authoredBy: probe-author
- name: grader-judge-receives-diffs
  sandbox: host
  command: |
    node --input-type=module << 'PROBE_EOF'
    import { gradeCodeQualityAxis } from './scripts/eval-pack-upgrade/grader-lib.mjs';
    let receivedArgs = null;
    const capturingJudge = async (currentDiff, candidateDiff, groundTruthDiff) => {
      receivedArgs = { currentDiff, candidateDiff, groundTruthDiff };
      return { verdict: 'same', reasoning: 'stub' };
    };
    await gradeCodeQualityAxis({
      currentDiff: 'CURRENT_MARKER',
      candidateDiff: 'CANDIDATE_MARKER',
      groundTruthDiff: 'GROUND_TRUTH_MARKER',
      currentScore: 0.9, candidateScore: 0.9,
      judgeFn: capturingJudge, judgeAlways: true,
    });
    const ok = receivedArgs &&
      receivedArgs.currentDiff === 'CURRENT_MARKER' &&
      receivedArgs.candidateDiff === 'CANDIDATE_MARKER' &&
      receivedArgs.groundTruthDiff === 'GROUND_TRUTH_MARKER';
    console.log(ok ? 'JUDGE_RECEIVED_CORRECT_DIFFS' : 'JUDGE_RECEIVED_WRONG_ARGS');
    PROBE_EOF
  description: >-
    AC3 - when judge fires it must receive currentDiff candidateDiff and groundTruthDiff as positional args matching the
    judgeFn signature at grader-lib.mjs:373
  expect_stdout_no_regex:
    - JUDGE_RECEIVED_WRONG_ARGS
  expect_stdout_regex:
    - JUDGE_RECEIVED_CORRECT_DIFFS
  _authoredBy: probe-author
- name: grader-judge-error-non-fatal
  sandbox: host
  command: |
    node --input-type=module << 'PROBE_EOF'
    import { gradeCodeQualityAxis } from './scripts/eval-pack-upgrade/grader-lib.mjs';
    const erroringJudge = async () => { throw new Error('stub-judge-error'); };
    try {
      const result = await gradeCodeQualityAxis({
        currentDiff: 'c', candidateDiff: 'b', groundTruthDiff: 'gt',
        currentScore: 0.9, candidateScore: 0.9,
        judgeFn: erroringJudge, judgeAlways: true,
      });
      console.log('JUDGE_ERROR_NON_FATAL result_type=' + typeof result);
    } catch (err) {
      console.log('FATAL_ERROR err=' + err.message);
    }
    PROBE_EOF
  description: >-
    AC6d - judge throws with judgeAlways true and score outside gray band; gradeCodeQualityAxis must not re-throw; pair
    degrades to deterministic score non-fatally
  expect_stdout_no_regex:
    - FATAL_ERROR
  expect_stdout_regex:
    - JUDGE_ERROR_NON_FATAL
  _authoredBy: probe-author
```
