# Epic 70: Pipeline-Verdict Accuracy — Cross-Story-Race Auto-Recovery

## Vision

When substrate-on-substrate dispatch produces transient verification
failures from cross-story-interaction races (Epic 66 + 67 + 67-1
budget-bump pattern), the orchestrator should retry the failing
verification with **fresh fix-context** that includes subsequent
auto-committed stories' changes. Today the orchestrator marks the
race-affected story `failed` and the operator must run Path A
reconciliation manually (3 times this week) — Epic 70 closes the gap
so the pipeline verdict matches on-disk reality.

This is the **architectural counterpart** to Epic 69 (Path A primitive)
and Epic 68 (cross-story-consistency check): Epic 68 detects collisions
during dispatch, Epic 69 codifies the manual recovery, and Epic 70
short-circuits the manual step entirely by retrying with fresh context.
After Epic 70 ships, cross-story-interaction races no longer require
operator intervention.

## Root cause it addresses

When two concurrent stories modify the same shared file (typically
test fixtures with budget assertions or methodology pack registrations):

1. Story A's dev-story phase writes the file at time T1
2. Story A's verification runs at time T2 against tree state at T1
3. Story B's dev-story phase writes the same file at time T3 (after T2)
4. Story B's verification runs at time T4 against tree state at T3
5. **By T4, story A's verification result is stale** — Story A's
   on-disk file matches Story B's expectations, but the recorded
   verification is from before B's changes landed

The orchestrator records the stale verification verdict and reports
Story A as `failed`, even though the actual on-disk state is coherent
once both stories are committed. Operator runs Path A reconciliation
manually (~5 min per incident).

Epic 70 detects the cross-story-interaction race signal (already
emitted by Epic 68's `dispatch:cross-story-file-collision` event) and
re-runs verification for the race-victim story AFTER all concurrent
stories have completed their dev-story phase, with fresh tree state.

## Why now

Three signals:

1. **Hit 3 times in 4 days** (Epic 66 + 67 + 67-1 budget-bump).
   Per-incident operator cost is 5-10 min Path A reconciliation. With
   Stream A+B (Epic 70-74) about to dispatch sequentially, expected
   recurrence is high.

2. **Foundation primitives ready**: Epic 68 detects collisions, Epic
   69 reconciles, Epic 71 reports. Epic 70 closes the verdict gap.

3. **Recovery Engine (Epic 73) needs accurate verdicts to make
   tier-A auto-recovery decisions.** If the pipeline verdict is
   inaccurate (false-fail), Epic 73 would auto-retry stories that
   are actually correct. Epic 70 must ship before Epic 73.

## Story Map

- 70-1: Cross-story-race auto-retry of stale verifications (P0, Medium)

Single story focused on the orchestrator-side retry logic. Detection
already lives in Epic 68's check; this story consumes that signal and
acts on it.

## Story 70-1: Cross-story-race auto-retry of stale verifications

**Priority**: must

**Description**: Add an orchestrator-side fix-up step that detects
cross-story-interaction races AFTER all concurrent dispatches in a
batch complete, then re-runs verification for the affected story
against fresh tree state.

The flow:

**Phase 1 — Race detection (consume Epic 68 signal):**
- Subscribe to `dispatch:cross-story-file-collision` events emitted
  by Epic 68's cross-story-consistency check (already implemented at
  `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts`)
- Track per-batch `concurrentModifications: Map<filePath, storyKey[]>`
  during dispatch
- After ALL stories in a concurrent batch complete dev-story phase,
  check whether any verification results were recorded BEFORE later
  stories' commits landed

**Phase 2 — Stale-verification identification:**
- For each story `s` whose verification ran at time `s.verifiedAt`:
  - Find all stories `t` in the same batch where:
    - `t.storyKey != s.storyKey`
    - `t` modified at least one file in `s.modifiedFiles ∪ s.testFiles`
    - `t.committedAt > s.verifiedAt`
  - If such `t` exists, `s` has a stale verification. Mark for re-run.
- Stale verifications are NOT marked `failed`; they're marked
  `verification-stale` (new lifecycle status from Story 70-1) and
  scheduled for re-run.

**Phase 3 — Verification re-run:**
- For each stale-verification story, re-invoke the verification
  pipeline against the current tree state (post all concurrent commits)
- If re-run passes: story status transitions to `complete`
- If re-run still fails: story status transitions to `failed` with
  `verification_re_run: true` attribute (so operators can see this
  was a genuine failure, not a race victim)
- Emit `pipeline:cross-story-race-recovered` event with `runId`,
  `storyKey`, `originalFindings`, `freshFindings`, `recoveryDurationMs`

**Acceptance Criteria:**

1. New module
   `packages/sdlc/src/verification/cross-story-race-recovery.ts`
   exporting `detectStaleVerifications(batch, manifest)` (pure
   function returning array of stale story keys) and
   `runStaleVerificationRecovery(input)` (action handler matching
   existing verification check shape — consult
   `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts`
   from Epic 68 for the contract).

2. Orchestrator integration: after concurrent batch completion,
   invoke `runStaleVerificationRecovery` IF Epic 68's
   `dispatch:cross-story-file-collision` event fired during the
   batch. Wire into
   `src/modules/implementation-orchestrator/orchestrator-impl.ts`.

3. **Critical: use canonical helpers for state access.** Per Story
   69-2 / 71-2 pattern (3 prior incidents from invented formats):
   - Read run state via `RunManifest` class from
     `@substrate-ai/sdlc/run-model/run-manifest.js` (NOT custom
     manifest reader)
   - Persistence via existing `DoltClient` from
     `src/modules/state/index.ts`
   - Run-id resolution via `manifest-read.ts` helpers
     (`resolveRunManifest`, `readCurrentRunId`)
   - Latest-run fallback via `getLatestRun(adapter)` from
     `packages/core/src/persistence/queries/decisions.ts`
   - **Do NOT introduce a new aggregate manifest format.**

4. New status `verification-stale` declared in
   `packages/sdlc/src/run-model/per-story-state.ts` PerStoryStatusSchema
   (extensible union pattern — add as additional literal). Documented
   in JSDoc as transient state during cross-story-race recovery.

5. New event types declared in
   `packages/core/src/events/core-events.ts` AND mirrored in
   `src/core/event-bus.types.ts` `OrchestratorEvents` per Story 66-4
   typecheck:gate discipline:
   - `pipeline:cross-story-race-recovered` — `{ runId, storyKey,
     originalFindings, freshFindings, recoveryDurationMs }`
   - `pipeline:cross-story-race-still-failed` — `{ runId, storyKey,
     freshFindings, recoveryDurationMs }`

6. **Re-run verification reuses existing pipeline**: invoke the same
   `runVerificationPipeline` function used by the primary
   verification flow. Do NOT duplicate verification logic — race
   recovery is "just verification, again, against fresh tree".

7. **Detection heuristic**: stale-verification detection compares
   `s.verifiedAt` (recorded in PerStoryState's verification_result
   metadata) against `t.committedAt` (from git log of the auto-commit
   matching `feat(story-<t.storyKey>):` pattern). Boundary: if
   `t.committedAt > s.verifiedAt` AND `t` modified a file in
   `s.modifiedFiles ∪ s.testFiles`, mark stale.

8. **Idempotency**: re-running recovery on a run with no stale
   verifications is a no-op — exit 0 with empty arrays.

9. **Tests** at
   `packages/sdlc/src/__tests__/verification/cross-story-race-recovery.test.ts`
   (≥6 cases): (a) detection — no race → empty; (b) detection — race
   detected → correct story marked stale; (c) recovery — fresh
   verification passes → status complete; (d) recovery — fresh
   verification fails → status failed with `verification_re_run: true`;
   (e) idempotency on no-stale runs; (f) edge case — story with no
   modifiedFiles attribute, fall back to verification-result file
   list.

10. **Integration test** at
    `__tests__/integration/cross-story-race-recovery.test.ts` (≥1
    case): real fixture with 2-story batch where story B's commit
    lands AFTER story A's verification ran, both modify the same
    test file. Recovery re-runs story A's verification, passes, marks
    complete.

11. **Header comment** in implementation file cites Epic 66 (run
    a832487a), Epic 67 (run a59e4c96), and the budget-bump pattern
    (`packages/sdlc/src/__tests__/methodology-pack.test.ts`) as
    motivating incidents.

12. **Commit message** references cross-story-interaction race class
    + Epic 66/67 motivating incidents + that this primitive
    eliminates manual Path A on the race class going forward.

13. **No package additions**: implementation must use existing deps.

**Files involved:**
- `packages/sdlc/src/verification/cross-story-race-recovery.ts` (NEW)
- `packages/sdlc/src/run-model/per-story-state.ts` (add `verification-stale` literal to PerStoryStatusSchema)
- `packages/core/src/events/core-events.ts` (new event types)
- `src/core/event-bus.types.ts` (mirror event types)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (wire batch-completion hook)
- `packages/sdlc/src/__tests__/verification/cross-story-race-recovery.test.ts` (NEW)
- `__tests__/integration/cross-story-race-recovery.test.ts` (NEW)

**Tasks / Subtasks:**

- [ ] AC1: implement `detectStaleVerifications` + `runStaleVerificationRecovery`
- [ ] AC2: orchestrator integration at batch-completion hook
- [ ] AC3: use canonical helpers (RunManifest, DoltClient, getLatestRun)
- [ ] AC4: new `verification-stale` literal in PerStoryStatusSchema
- [ ] AC5: new event types declared + mirrored both interfaces;
      typecheck:gate validates mirror coherence
- [ ] AC6: re-run reuses `runVerificationPipeline` (no duplication)
- [ ] AC7: stale-detection heuristic via verifiedAt vs committedAt
- [ ] AC8: idempotency on no-stale runs
- [ ] AC9: unit tests (≥6 cases)
- [ ] AC10: integration test with real 2-story batch fixture
- [ ] AC11: header comment cites Epic 66/67 + budget-bump pattern
- [ ] AC12: commit message follows convention
- [ ] AC13: zero new package dependencies

## Risks and assumptions

**Assumption 1 (Epic 68 collision detection fires on race-class
patterns)**: Epic 68 Story 68-1's
`dispatch:cross-story-file-collision` event must reliably fire when
two concurrent stories modify the same file. Mitigation: integration
test asserts the event fires for the canonical Epic 66/67 pattern;
recovery code is a no-op when the event is absent (graceful
degradation).

**Assumption 2 (verifiedAt timestamp recorded)**: PerStoryState's
verification_result metadata must include `verified_at` ISO timestamp.
Schema already has `completed_at` per Story 52-4; if `verified_at` is
absent, fall back to `completed_at`. Mitigation: implementation
checks both fields; missing-data path returns "no race detected" (safe
default).

**Risk: detection over-fires.** Two stories adding DIFFERENT functions
to the same module would trigger stale-verification check, but
re-running the verification would correctly find no errors. Net
effect: extra ~30-60s wall-clock per false-positive batch. Mitigation:
acceptable cost; emit `pipeline:cross-story-race-checked-clean` info
event so operators can audit false-positive rate.

**Risk: re-running verification uses stale fix-context.** If the
re-run uses cached state from the original run, it might miss the
fresh tree state. Mitigation: re-run flow MUST clear any cached
verification state and re-read tree state from disk via the canonical
chain.

**Self-applying validation**: Epic 70 itself is single-story; if 70-1
hits a cross-story-interaction race during its own dispatch,
substrate's existing Path A primitive (Epic 69) recovers, AND Epic 70
ships the very mechanism that would have prevented the manual
recovery on its OWN dispatch. Closes the loop.

## Dependencies

- **Epic 68 Story 68-1** (v0.20.59) — cross-story-consistency check
  emits `dispatch:cross-story-file-collision` event. Epic 70 consumes
  this signal.
- **Story 52-4** (v0.19.30+) — PerStoryState schema with
  verification_result metadata. Epic 70 reads `verified_at` from this.
- **Story 60-15** (v0.20.41) — `story:interface-change-warning`
  events with `modifiedInterfaces` arrays. Epic 70 may consume this
  signal as additional race hint.
- **Story 66-4** (v0.20.57) — `dispatch:spawnsync-timeout` event
  pattern (CoreEvents + OrchestratorEvents mirror). Epic 70 follows
  the same pattern for new event types.
- **Epic 69 Story 69-1** (v0.20.60) — `substrate reconcile-from-disk`
  CLI. Operators can still use this primitive when Epic 70's auto-
  recovery doesn't fire (e.g., crash during recovery).

## Out of scope

- **Re-running dev-story or code-review phases**: Epic 70 only
  re-runs verification (the cheap, idempotent phase). Re-running
  dev-story would require dispatching a fresh agent and is out of
  scope; Recovery Engine (Epic 73) handles that case.
- **Predictive race avoidance**: Epic 68 already does this via
  pre-dispatch collision detection. Epic 70 is the post-dispatch
  recovery layer.
- **Automatic git revert of races**: out of scope; if recovery
  fails, story is marked `failed` and operator decides next step.
- **Cost-ceiling impact tracking**: Epic 70's recovery may add
  ~$0.05 per re-run. Out of scope to enforce a separate ceiling for
  recovery costs; counted in run total.

## References

- Epic 66 (v0.20.57) — first cross-story-interaction race in
  substrate-on-substrate dispatch (run a832487a)
- Epic 67 (v0.20.58) — second race; Story 67-1's methodology-pack
  budget-bump landed AFTER 67-2's verification (run a59e4c96)
- Epic 68 (v0.20.59) — cross-story-consistency check; emits the
  detection signal Epic 70 consumes
- Epic 69 (v0.20.60) — `substrate reconcile-from-disk` primitive;
  the manual recovery Epic 70 short-circuits
- Phase D Plan 2026-04-05 — Story 54-1 Recovery Engine; Epic 70 is
  the verdict-accuracy precondition for Recovery Engine

## Status history

| At | By | Status | Note |
|---|---|---|---|
| 2026-05-05 | post-Epic 71 sprint progress | open | Filed as Stream A+B sprint plan continuation. Single-story scope; orchestrator-side cross-story-race recovery. ACs explicitly cite canonical helpers (RunManifest / DoltClient / getLatestRun / manifest-read) per Story 69-2 / 71-2 lesson (3 prior incidents from invented manifest formats). Substrate-on-substrate dispatch with `--max-review-cycles 3`. |
