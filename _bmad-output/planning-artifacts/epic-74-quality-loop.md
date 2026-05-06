# Epic 74: Quality Loop — AC-to-Test Traceability + Verification-to-Learning Feedback

## Vision

Stream A+B sprint plan continuation. Two independent quality-loop
stories from Phase D:

- **Story 74-1 (AC-to-Test Traceability Check, on-demand)**:
  heuristic matching between acceptance criteria text and test
  names/descriptions to produce a coverage matrix. On-demand only
  (`--verify-ac` flag), not part of default verification.
- **Story 74-2 (Verification-to-Learning Feedback Loop)**: every
  verification finding (phantom-review, trivial-output, build-fail)
  becomes a first-class Finding in the Dolt learning store, so future
  dispatches' findings injector can consume verification patterns.
  Closes the feedback circuit: verification → learning → better
  dispatch → better verification.

Independent of Epic 73 (Recovery Engine). Can ship in parallel.

## Root cause it addresses

**Story 74-1**: today operators can't quickly verify AC coverage.
The `acceptance-criteria-evidence` check (existing) verifies every
AC was MENTIONED in dev-story-signals, but doesn't verify there's
TEST coverage for each AC. For high-stakes stories, operators want
explicit "AC1 covered by test foo.test.ts:42, AC2 not found in
tests" matrix.

**Story 74-2**: the existing learning store ingests external Findings
(from cross-project validation, dispatch failures), but verification
results — substrate's most reliable signal source — are NOT fed
back. This means the learning loop can't learn from "phantom-review
fails consistently when stories have <5 tasks" patterns.

Closing the feedback circuit means future dispatches benefit from
prior verification results.

## Why now

Three signals:

1. **Stream A+B sprint plan completion**: 74 closes the autonomy
   capstone. After 74 ships, all Phase D capstone stories are
   complete.

2. **Empirical signal exists**: today's 8 ships generated ~50
   verification findings (phantom-review fails, runtime-probe
   failures, AC-missing-evidence). All of those are unrecorded in
   the learning store. Enabling the feedback loop NOW captures the
   signal going forward.

3. **Independent of 73**: Quality Loop has no dependency on
   Recovery Engine; can dispatch in parallel.

## Story Map

- 74-1: AC-to-Test Traceability Check (on-demand, --verify-ac flag) (P0, Small)
- 74-2: Verification-to-Learning Feedback Loop (Finding injection from verification results) (P0, Small)

Two focused stories.

## Story 74-1: AC-to-Test Traceability Check (on-demand)

**Priority**: must

**Description**: Add a `--verify-ac` flag to `substrate report` and
`substrate run` that runs an on-demand AC-to-Test traceability check
for completed stories. Produces a heuristic coverage matrix mapping
each AC to test names/descriptions that mention it.

The check is **on-demand only** — not part of default verification —
because it requires an LLM call and may produce false positives.
Operators run it when they want extra confidence on critical stories.

**Acceptance Criteria:**

1. New module `packages/sdlc/src/verification/checks/ac-traceability-check.ts`
   exporting `runAcTraceabilityCheck(input)` matching existing check
   shape (consult
   `packages/sdlc/src/verification/checks/runtime-probe-check.ts`
   from existing checks for the contract).

2. **Heuristic matching algorithm**:
   - Read AC list from story spec (parse `**Acceptance Criteria:**`
     section + numbered ACs)
   - Read test files from story's `files_modified` (filter to
     `*.test.ts`, `*.test.js`, `*test*` patterns)
   - For each AC text and each test description, compute fuzzy match
     score (use existing string-distance helper if present; else
     simple word-overlap percentage)
   - Threshold ≥0.4 word-overlap → "matched"; below → "not matched"
   - Acknowledge approximate matching in output: include `confidence:
     'approximate'` in the JSON output

3. **`--verify-ac` flag**: registered on BOTH `substrate report` AND
   `substrate run`:
   - `substrate report --verify-ac` re-runs the check for the latest
     run's stories and re-outputs the report
   - `substrate run --verify-ac` runs the check after the run
     completes (additive verification step)

4. **Output format**: extend Epic 71's `substrate report` output:
   - Human format: new "AC Traceability" section with per-story
     matrix (table: AC | matched | test name)
   - JSON format: top-level `ac_traceability` object keyed by
     storyKey with `{ matrix: [...], confidence: 'approximate' }`

5. **LLM call optionality**: heuristic matching is the default; if
   `--verify-ac-llm` flag is also passed, augment with LLM-based
   matching. LLM call optional, NOT required. Out of scope for
   initial implementation if too complex (feasible: defer to Epic 75
   if LLM integration is non-trivial).

6. **CRITICAL: use canonical helpers** (per Story 69-2 / 71-2 / 72-x
   / 73-x lesson — 5 prior epics where this prevented invented
   manifest formats):
   - Read run state via `RunManifest` class from
     `@substrate-ai/sdlc/run-model/run-manifest.js`
   - Run-id resolution via `manifest-read.ts` helpers
     (`resolveRunManifest`, `readCurrentRunId`)
   - Latest-run fallback via `getLatestRun(adapter)` from
     `packages/core/src/persistence/queries/decisions.ts`
   - **Do NOT introduce new aggregate manifest formats.**

7. **Tests** at
   `packages/sdlc/src/__tests__/verification/ac-traceability-check.test.ts`
   (≥5 cases): (a) matched: AC text and test description share ≥0.4
   word overlap → matched; (b) not matched: ≥0.4 below → not matched;
   (c) edge case: empty AC list → empty matrix; (d) edge case: no
   test files in modified files → all unmatched + warning;
   (e) confidence flag always 'approximate' in output.

8. **Header comment** cites Phase D Story 54-7 (original spec) +
   Epic 71 (substrate report; 74-1 extends).

9. **No package additions**.

**Files involved:**
- `packages/sdlc/src/verification/checks/ac-traceability-check.ts` (NEW)
- `packages/sdlc/src/__tests__/verification/ac-traceability-check.test.ts` (NEW)
- `src/cli/commands/report.ts` (extend with --verify-ac flag and traceability output)
- `src/cli/commands/run.ts` (extend with --verify-ac flag — invokes check post-run)
- `packages/sdlc/src/verification/verification-pipeline.ts` (register optional check)

## Story 74-2: Verification-to-Learning Feedback Loop

**Priority**: must

**Description**: Wire every verification finding from the
verification pipeline into substrate's existing learning store
(Dolt decisions table). Future dispatches' `FindingsInjector` (Story
53-X) can then consume verification-generated findings.

**Acceptance Criteria:**

1. New module
   `packages/sdlc/src/verification/findings-to-learning-store.ts`
   exporting `injectVerificationFindings(verificationSummary,
   storyContext)`. Consumes existing `VerificationSummary` shape
   (from `packages/sdlc/src/verification/types.ts`) and produces
   `Finding[]` matching the existing learning-store Finding shape
   from `packages/sdlc/src/learning/types.ts` (or wherever Finding
   is defined).

2. **Root-cause derivation map** (consume in `injectVerificationFindings`):
   - `phantom-review` failures → root cause `build-failure`
   - `trivial-output` failures → root cause `resource-exhaustion`
   - `build` failures → root cause `build-failure`
   - `acceptance-criteria-evidence` failures → root cause `ac-missing-evidence`
   - `runtime-probes` failures → root cause `runtime-probe-fail`
   - `source-ac-fidelity` failures → root cause `source-ac-drift`
   - `cross-story-consistency` failures → root cause
     `cross-story-concurrent-modification`

3. **Confidence**: every verification-generated Finding has
   `confidence: 'high'` (verified by static analysis, not heuristic).

4. **Affected files**: from the story's `files_modified` (in
   per-story state).

5. **Persistence**: write Finding objects to existing Dolt decisions
   table via existing `DoltClient` helper. Reuse existing
   `appendFinding(adapter, finding)` from
   `packages/core/src/persistence/queries/decisions.ts` (if
   absent, look for similar helper; do NOT create new table).

6. **Trigger**: `injectVerificationFindings` is invoked by
   `runVerificationPipeline` (existing fn at
   `packages/sdlc/src/verification/verification-pipeline.ts`)
   AFTER the verification result is finalized for each story.
   Wire as side-effect at the end of the pipeline (NOT a
   dependency — verification result is independent of learning
   write).

7. **CRITICAL: use canonical helpers** (per Story 69-2 / 71-2 / 72-x
   / 73-x lesson — 5 prior epics):
   - Persistence via existing `DoltClient` from
     `src/modules/state/index.ts`
   - Findings shape per `packages/sdlc/src/learning/types.ts` (do
     NOT introduce new finding format)
   - **Do NOT introduce new aggregate manifest formats.**

8. **`FindingsInjector` consumption**: Story 53-X's
   `FindingsInjector` (consult
   `packages/sdlc/src/learning/findings-injector.ts` if present)
   should automatically pick up verification-generated findings on
   future dispatches via the same query path it uses for external
   Findings. No code changes required to FindingsInjector;
   verification findings just appear in the same Dolt rows.

9. **Tests** at
   `packages/sdlc/src/__tests__/verification/findings-to-learning-store.test.ts`
   (≥5 cases): (a) phantom-review fail → root_cause
   build-failure; (b) trivial-output fail → root_cause
   resource-exhaustion; (c) build fail → root_cause build-failure;
   (d) all warns produce findings (not just fails); (e) findings
   persist via DoltClient mock (assert `appendFinding` invoked with
   correct shape).

10. **Integration test** at
    `__tests__/integration/findings-to-learning-store.test.ts` (≥1
    case): real fixture verification summary; invoke injection;
    assert Dolt decisions table contains expected Finding rows
    queryable via existing FindingsInjector.

11. **Header comment** cites Phase D Story 54-8 (original spec) +
    Story 53-5 (root cause taxonomy this consumes) + that closes
    the feedback circuit (verification → learning → dispatch).

12. **No package additions**.

**Files involved:**
- `packages/sdlc/src/verification/findings-to-learning-store.ts` (NEW)
- `packages/sdlc/src/__tests__/verification/findings-to-learning-store.test.ts` (NEW)
- `__tests__/integration/findings-to-learning-store.test.ts` (NEW)
- `packages/sdlc/src/verification/verification-pipeline.ts` (invoke injection at pipeline end)

## Risks and assumptions

**Assumption 1 (existing Finding shape is stable)**: Story 53-X's
Finding shape is the canonical learning-store record. New Findings
from verification reuse this shape without modification. Mitigation:
unit tests assert shape conformance.

**Assumption 2 (FindingsInjector is unchanged)**: Story 53-X's
injector consumes Findings via Dolt query. Adding verification-
generated rows doesn't require injector changes. Mitigation:
integration test asserts injector reads verification findings.

**Risk: 74-1's heuristic matching has high false-positive rate.**
Word-overlap matching for ACs that share common words ("the system",
"shall", "must") with tests may incorrectly match. Mitigation:
threshold tuning (≥0.4 is conservative); confidence flag is
`approximate`; LLM augmentation deferred.

**Risk: 74-2 floods learning store with low-signal findings.** Every
verification warning (e.g., source-ac-section-not-found) becomes a
Finding. Could noise out the learning loop. Mitigation: only `fail`
and `warn` severity findings get injected, not `info`. Future epic
can add severity threshold tuning.

**Self-applying validation**: Epic 74 itself dispatches under the
existing verification pipeline; if 74-2 ships first, its own
verification findings get injected into the learning store and
become signal for future dispatches.

## Dependencies

- **Phase D Story 54-7** (2026-04-05) — AC traceability spec.
- **Phase D Story 54-8** (2026-04-05) — Verification-to-Learning
  spec.
- **Story 53-5** (v0.19.31) — root cause taxonomy + classifier; 74-2
  consumes.
- **Story 53-X learning store** — existing Findings table; 74-2
  reuses.
- **Epic 71** (v0.20.62) — `substrate report`; 74-1 extends.

## Out of scope

- **LLM-augmented AC matching**: 74-1 ships heuristic-only.
  LLM-based matching could improve accuracy but is feasible to defer.
- **Severity threshold tuning for 74-2**: only `fail`/`warn`
  findings inject; `info` excluded. Refining this is future work.
- **Cross-run pattern detection**: e.g., "phantom-review consistently
  fails on Story X-Y type" — that's analytics, not feedback loop.
  Out of scope.
- **Notification on new traceability gap**: 74-1 reports gaps but
  doesn't alert externally.

## References

- Phase D Plan 2026-04-05 — Stories 54-7 + 54-8 original specs
- Story 53-5 (v0.19.31) — root cause taxonomy
- Epic 71 (v0.20.62) — `substrate report`; 74-1 extends

## Status history

| At | By | Status | Note |
|---|---|---|---|
| 2026-05-06 | post-Epic 73 sprint progress | open | Filed as Stream A+B sprint plan continuation. 2-story epic (extraction of Phase D 54-7 + 54-8). Independent of Epic 73, can ship after 73 OR in parallel. ACs explicitly cite canonical helpers per durable lesson (5 prior epics). Substrate-on-substrate dispatch with `--max-review-cycles 3`. |
