# Epic 77: Eval Framework — gate substrate harness changes against a standing regression suite

> **Epic numbering note:** Epic 76 is reserved (semantically, no doc yet) by epic-75's
> deferrals — reconcile-from-disk branch reading, worktree telemetry events
> (`worktree:created/merged/abandoned`), and the cross-story-isolation integration
> test. Do not author Epic 76 content here. Eval framework is Epic 77.

> **Human-facing companion doc:** `docs/2026-05-23-eval-framework-plan.md` (narrative +
> rationale). `docs/2026-05-23-eval-frameworks-for-coding-harnesses.md` (concept
> research). This epic is the machine-facing, dispatch-ready derivation.

## Vision

Substrate **is** the harness that the coding-agent eval literature keeps pointing at:
"the harness matters more than the model" (LangChain moved +13.7 points on Terminal
Bench by changing only the harness). Every substrate ship — recovery engine, routing,
verification gates, prompt changes — is a harness change. **None of them are eval-gated
today.** Fixes ship reactively, validated by hand against the one case that triggered
them; no standing regression suite re-checks all prior failure modes on every ship.

This epic builds that gate, by **assembling from substrate's existing eval-adjacent
subsystems** rather than adopting an external framework. The deliverable that ships
first is a **$0, every-ship CI regression gate** over a curated corpus of substrate's
own historical run outcomes.

## Root cause it addresses

A 2026-05-23 census + bmad-party-mode panel established:

1. **No regression gate on harness changes.** `substrate metrics`, the verification
   pipeline, satisfaction scoring, and telemetry all exist — but nothing *replays a
   curated corpus of known cases and fails the build on regression*. The closest
   artifact, `scripts/eval-probe-author.mjs`, evals exactly one phase (probe-author)
   against a defect-replay corpus. It is the seed crystal; this epic generalizes it.

2. **Decision provenance is a gap.** Trace-replay of harness *decisions* (routing
   model, escalation reason, recovery path) is not buildable on existing logs because
   that provenance is not persisted (see Census Findings). Outcome-class replay IS
   buildable today.

## Why now

1. **We just spent three ships (v0.20.110–112) on stdout-contamination fixes** that
   were each found reactively. A standing regression suite would have caught the class.
2. **The census is done** — corpus sizes and provenance gaps are measured, not assumed.
   The context is loaded now; deferring means re-deriving it.
3. **Operator directive (2026-05-23):** capture the plan as epics/stories where
   substrate discovers them, so the eval framework is itself trackable and (where safe)
   dispatchable. Dogfooding: substrate building its own eval gate.
4. **No external-framework option taken.** Promptfoo/Inspect are for zero-base teams;
   bolting one onto our TS monorepo = two eval substrates + a translation layer = the
   exact tech debt the v0.20.92–112 arc spent weeks eliminating.

## Census Findings (established fact — do NOT re-derive in story dispatch)

Ran 2026-05-23 against substrate + ynab + boardgame + agent-mesh.

| Signal | Availability | Consequence |
|---|---|---|
| `story_metrics.result` (SHIP_IT / LGTM_WITH_NOTES / escalated / failed / verification-failed / NEEDS_MINOR_FIXES) | **219 outcomes, reliably populated** | The Tier 2a outcome-replay corpus. Buildable today. |
| `per_story_state.status` / `phase`, `review_cycles`, `dispatches` | populated | Usable today |
| `escalation_reason` | **0 of 197 manifests populated** | Decision-replay (Tier 2b) blocked → Story 77-4 prerequisite |
| `primary_model` in `story_metrics` | **NULL** — `writeStoryMetrics` call at `orchestrator-impl.ts:902-917` writes `primary_agent_id` but not `primary_model` | Routing-decision replay blocked → Story 77-4 |
| `recovery_history` (manifest top-level) | non-empty in **only 15** manifests; schema-present at `packages/sdlc/src/run-model/run-manifest.ts:122` | Recovery-path replay sparse → Story 77-4 |
| `review_verdicts` / decisions provenance table | does not exist | No verdict-trace store |

**`story_metrics.result` distribution (n=219):** LGTM_WITH_NOTES 61, escalated 52,
failed 46, SHIP_IT 30, verification-failed 20, NEEDS_MINOR_FIXES 10.

**Corpus ceilings:** clean `feat(story-N-M)`↔manifest pairs for commit-reconstruction:
**~9–19** (uniform auto-commit format only since v0.20.86; substrate is mostly
hand-built, not substrate-on-substrate). Reconstruction is therefore the *capability*
layer, not regression breadth.

**`.substrate/runs/` is polluted:** 124 of 197 substrate manifests are incomplete local
dev/test runs (`running`/`dispatched`). **The corpus MUST be curated labeled YAML —
never "point the grader at the directory."**

## Design Principles (binding constraints on all stories)

1. **Extend substrate's own eval substrate.** Reuse: `ScenarioStore` /
   `ScenarioRunner` (`packages/factory/src/scenarios/`), `SatisfactionScorer`
   (`packages/factory/src/scenarios/scorer.ts`), `VerificationCheck` /
   `VerificationPipeline` (`packages/sdlc/src/verification/`), the metrics queries
   (`packages/core/src/persistence/queries/metrics.ts`), and the injectable-LLM
   pattern (`packages/factory/src/graph/llm-evaluator.ts`). **No new external eval
   dependency.**
2. **Graders ARE `VerificationCheck`s.** Any grader added by this epic implements the
   `VerificationCheck` interface (`packages/sdlc/src/verification/types.ts`) so it can
   be promoted to a production gate and back. One sensor library, two consumers.
3. **Grade outcomes, never paths.** Two valid implementations of the same story must
   both pass. Assert outcome class / diff effect, never tool-call sequence.
4. **Eval results land in `_bmad-output/eval-results/`** (existing sink), JSON, with a
   GREEN/YELLOW/RED rubric matching the probe-author validation protocol.
5. **Corpus is curated labeled YAML**, generalized from
   `scripts/eval-probe-author/lib.mjs`.

## Story Map

- 77-1: Outcome-replay grader Tier 2a (P0, Medium)
- 77-2: Curate the labeled outcome corpus (P0, Medium)
- 77-3: Regression gate wiring for ship and CI and passk (P0, Small)
- 77-4: Provenance hardening for decision-replay (P0, Medium)
- 77-5: Decision-replay grader Tier 2b (P1, Medium)
- 77-6: Cross-project reconstruction corpus census (P2, Small)
- 77-7: Capability corpus and hill-climbing loop (P2, Large)
- 77-8: Single-phase reconstruction harness (P2, Medium)
- 77-9: Reconstruction grader two-signal ambiguous-only LLM (P2, Medium)

**Dispatch eligibility** (full detail in per-story sections below):
- **Dispatchable**: 77-1, 77-2, 77-5 (additive code / authoring).
- **Operator-built, NOT dispatched**: 77-3 (touches `/ship` + CI surfaces).
- **Dispatchable but BOOTSTRAP-SENSITIVE**: 77-4 (modifies substrate's own telemetry
  writers — the dispatched run executes the OLD writers while implementing the new;
  validate against a fresh post-merge run, not the dispatching run).
- **Story-map stubs** (flesh out after 77-1..77-5): 77-6, 77-7.

Recommended first dispatch batch: `--stories 77-1,77-2` (additive, low bootstrap risk,
disjoint surfaces). 77-3 and 77-4 follow with operator attention.

---

## Story 77-1: Outcome-replay grader (Tier 2a)

**Priority**: must · **Dispatch eligibility**: dispatchable (additive code, no running-pipeline behavior change)

**Description**: Build a grader that reads substrate's persisted run outcomes
(`story_metrics` + run manifest) and asserts each curated case's expected outcome
class against the recorded result. Zero new agent dispatch — pure read + compare.
This is the every-ship regression engine. Model the CLI + JSON-report shape on
`scripts/eval-probe-author.mjs`; model the corpus reader on
`scripts/eval-probe-author/lib.mjs`.

**Acceptance Criteria:**

1. **Grader implements `VerificationCheck`** (`packages/sdlc/src/verification/types.ts`):
   `name`, `tier`, `run(context) → VerificationResult`. The eval harness invokes it;
   it is promotable to a production gate. (Design Principle 2.)

2. **Reads outcomes via existing queries.** Use `getStoryMetricsForRun(adapter, runId)`
   and the run-manifest reader; do NOT add a parallel persistence path. The grader
   receives a `run_id` (or `story_key`) per case and looks up the recorded
   `story_metrics.result`, `review_cycles`, `dispatches`, and `per_story_state.status`.

3. **Corpus format is labeled YAML**, parsed by a reader generalized from
   `scripts/eval-probe-author/lib.mjs`. Each case carries at minimum:
   `id`, `source` (repo), `story_key`, `run_id`, `expect.result_class`,
   optional `expect.max_review_cycles`, and `label_reason`. (Format finalized with 77-2.)

4. **Outcome-class assertion.** A case passes when the recorded `story_metrics.result`
   matches `expect.result_class` AND (if present) `review_cycles ≤ expect.max_review_cycles`.
   `result_class` matching is exact against the known vocabulary (SHIP_IT,
   LGTM_WITH_NOTES, NEEDS_MINOR_FIXES, escalated, failed, verification-failed).

5. **GREEN/YELLOW/RED rubric**, matching `probe-author-validation-protocol.md`:
   pass-rate ≥ 0.95 GREEN, 0.85–0.95 YELLOW, < 0.85 RED for the regression corpus
   (regression evals target near-100% per the concept doc). Threshold configurable.

6. **JSON report written to `_bmad-output/eval-results/`** with per-case results,
   aggregate pass-rate, and rubric verdict. Filename includes date + corpus version.

7. **CLI entry point** `node scripts/eval-outcomes.mjs [--corpus PATH] [--output PATH]
   [--threshold 0.95] [--dry-run]`, mirroring `scripts/eval-probe-author.mjs` flags.
   `--dry-run` validates corpus + lookups without writing a report.

8. **Pollution guard.** The grader operates ONLY on curated corpus entries; it never
   enumerates `.substrate/runs/`. A case whose `run_id` is missing or whose manifest is
   `running`/`dispatched` (incomplete) is reported as a corpus error (not a pass/fail),
   so corpus rot is visible. (Census: 124/197 manifests are incomplete.)

9. **Unit tests** cover: exact-match pass, cycle-cap fail, missing-run corpus-error,
   rubric boundary cases (0.95, 0.85). No live dispatch in tests.

---

## Story 77-2: Curate the labeled outcome corpus

**Priority**: must · **Dispatch eligibility**: dispatchable (authoring + scripted extraction)

**Description**: Produce the initial labeled corpus the 77-1 grader consumes. Two
sources: (a) the 219 recorded `story_metrics.result` outcomes as
"should-reproduce-this-class" regression cases; (b) the obs_* history as labeled
*false-escalation* cases — runs we KNOW escalated wrongly, labeled `expect.result_class`
= the correct non-escalated class.

**Acceptance Criteria:**

1. **Corpus file** at `_bmad-output/eval-results/corpus/outcomes-corpus.yaml` (new
   `corpus/` subdir), schema matching 77-1 AC3. Versioned with a `corpus_version` header.

2. **Baseline extraction script** `scripts/build-outcomes-corpus.mjs` that reads
   `story_metrics` (via `getStoryMetricsForRun` across known run_ids) and emits candidate
   YAML entries with `expect.result_class` = the recorded result. Human curation then
   prunes pollution and adds `label_reason`. The script is re-runnable (regenerate
   candidates) but never overwrites human-added labels — emit to a `*.candidates.yaml`
   and merge by hand.

3. **At least 30 curated regression cases** spanning all six result classes (the corpus
   need not be all 219 — curate for coverage + signal, per the concept doc's "20–50 real
   cases" guidance).

4. **At least 5 labeled false-escalation cases** drawn from documented obs_* failures
   (e.g., the ~28% interface-extraction false-escalation rate noted in project memory;
   obs_026). Each carries `expect.result_class` = the correct class + `label_reason`
   citing the obs. (These light up fully once 77-4 lands escalation_reason, but the
   outcome-class label is assertable now.)

5. **Each case validated** against the 77-1 grader in `--dry-run`: every `run_id`
   resolves to a complete (non-`running`) manifest. No corpus-errors at commit time.

6. **Corpus provenance note** at the top of the YAML: census date, source repos,
   curation rationale, and the pollution caveat.

---

## Story 77-3: Regression gate wiring (`/ship` + CI + pass^k)

**Priority**: must · **Dispatch eligibility**: **OPERATOR-BUILT — do NOT dispatch.** Touches `.claude/commands/ship.md` and `.github/workflows/*`, which are operator/CI surfaces substrate does not modify via autonomous dispatch.

**Description**: Wire the 77-1 grader into the ship flow and CI so a regression fails the
build, and add `pass^k` reliability aggregation over a stable case subset.

**Acceptance Criteria:**

1. **CI job** runs `node scripts/eval-outcomes.mjs --threshold 0.95` on every push, after
   the existing test job. Non-GREEN verdict fails the build. Job is fast (read-only, no
   dispatch) — target < 30s.

2. **`/ship` Step addition** in `.claude/commands/ship.md`: run the outcomes eval as a
   pre-tag gate (alongside build / typecheck:gate / test), documented with trigger
   criteria (any harness-touching change).

3. **`pass^k` aggregation**: for cases flagged `stable: true` in the corpus, when
   multiple recorded run_ids exist for the same logical case, report `pass^k` (all-k-pass
   probability) in addition to per-case pass/fail. Surfaces reliability, not just
   capability (concept doc: a 90% pass@1 fails 1-in-10 — unacceptable for autonomous runs).

4. **Regression vs capability split** in the report: regression corpus (near-100% target,
   every ship) vs capability corpus (lower target, informational) reported separately.

5. **Gate is advisory-then-enforcing**: ships with a one-release grace window logging the
   verdict without failing, then flips to enforcing — to avoid a flap on first wiring.
   (Document the flip date in ship.md.)

---

## Story 77-4: Provenance hardening (Phase 0.5)

> **STATUS: SHIPPED v0.20.115 (2026-05-25), hand-built.** All three fields wired (primary_model, escalation_reason, recovery_history); 6 new unit tests; 9587 green. AC1's stated premise was falsified — `_storyAgents` never held the model (`recordDispatchAgent` was called without one), so the real fix was echoing the resolved model on `DispatchResult.model` upstream. AC5 (fresh post-merge run validation) PENDING.

**Priority**: must · **Dispatch eligibility**: dispatchable but **BOOTSTRAP-SENSITIVE** — modifies substrate's own telemetry writers. A dispatched run executes the OLD (gappy) writers while implementing the new ones; correctness MUST be validated against a fresh post-merge run, not the dispatching run.

**Description**: Populate the three decision-provenance gaps the census found, so Tier 2b
decision-replay (77-5) becomes feasible. All three fields/columns already exist — they're
simply not written.

**Acceptance Criteria:**

1. **`primary_model` populated.** At the `writeStoryMetrics` call in
   `src/modules/implementation-orchestrator/orchestrator-impl.ts:902-917`, derive the
   primary model from the per-story dispatch agents (`_storyAgents.get(storyKey)` holds
   `{agent, model?, phase}` entries) and pass `primary_model`. Pick the model of the
   primary implementation dispatch (dev-story), falling back to the most frequent model
   across the story's dispatches. Null only when genuinely unknown.

2. **`escalation_reason` persisted to manifest.** On every escalation path that calls
   `writeStoryMetricsBestEffort(storyKey, 'escalated', ...)` (e.g.
   `orchestrator-impl.ts:1485`), also `patchStoryState(storyKey, { escalation_reason })`
   on the run manifest, using the recovery-engine root-cause taxonomy value already
   computed at the escalation site. The field is read at `report.ts:339` today — close
   the write side.

3. **`recovery_history` written on every recovery action**, not just some. Audit the
   recovery engine for paths that take a recovery action without appending a
   `RecoveryEntry` (schema at `packages/sdlc/src/run-model/run-manifest.ts:122`,
   `RecoveryEntrySchema` in `schemas.ts:71`). Every Tier A/B/C recovery decision appends
   an entry with `story_key`, `attempt_number`, action, and outcome.

4. **No behavior change to the pipeline's decisions** — this story only *records* what
   already happens. Routing still picks the same model; escalation still fires the same;
   recovery still ladders the same. Verify by asserting metrics/manifest writes in tests,
   not by changing control flow.

5. **Bootstrap validation gate**: after merge, run one fresh real dispatch (any small
   story, any project) and confirm `primary_model` is non-NULL, `escalation_reason` is
   populated on any escalation, and `recovery_history` has an entry per recovery action.
   Document the validating run_id in the story completion notes. (Do NOT trust the
   dispatching run's own telemetry — it ran the old writers.)

6. **Unit tests** assert each field is written given a mock dispatch/escalation/recovery,
   targeting the core write paths (mock at `packages/core/src/persistence/queries/metrics.ts`
   and the manifest patch).

---

## Story 77-5: Decision-replay grader (Tier 2b)

> **STATUS: SHIPPED v0.20.116 (2026-05-25), hand-built.** Decision-class assertions (primary_model/escalation_reason/recovery_actions) wired into the CLI gate + OutcomeGraderCheck; missing-provenance → corpus-error; folded into the regression rubric; 5 obs_026 cases gained `escalation_reason: null`; 17 new unit tests (50 total). Live gate regression GREEN 100%. The regression POWER activates on fresh post-77-4 cases (currently none — all corpus runs predate 77-4); building the grader doubles as 77-4 AC5's validation harness once a fresh run is recorded.

**Priority**: must · **Dispatch eligibility**: dispatchable · **Depends on**: 77-4 (provenance must be populated first)

**Description**: Extend the eval harness with a grader that asserts harness *decisions*
— which model was routed, why a story escalated, what recovery path ran — now that 77-4
persists them. This unlocks the highest-value substrate-specific eval: the labeled
false-escalation regression corpus.

**Acceptance Criteria:**

1. **Decision-class assertions** added to the corpus schema: optional
   `expect.escalation_reason`, `expect.primary_model`, `expect.recovery_actions[]`.
   A case asserts only the fields it declares (partial assertion is valid).

2. **Grader reads the hardened provenance**: `primary_model` from `story_metrics`,
   `escalation_reason` from manifest `per_story_state`, `recovery_history` from the
   manifest. Implements `VerificationCheck` (Design Principle 2).

3. **False-escalation cases now assert reason**: the obs_* labeled cases from 77-2 gain
   `expect.escalation_reason` = null (should not have escalated) or the correct reason
   when escalation was warranted. A regression that re-introduces a known false escalation
   now fails on BOTH outcome class (77-1) and absent/wrong reason (77-5).

4. **Corpus-error on missing provenance**: a case asserting a decision field whose
   recorded value is null/absent is a corpus-error (not a silent pass), so pre-77-4 runs
   aren't mistaken for passes.

5. **Report integration**: decision-replay results join the 77-1 outcome report under the
   same GREEN/YELLOW/RED rubric and `_bmad-output/eval-results/` sink.

6. **Unit tests** cover partial assertion, null-reason false-escalation pass, wrong-reason
   fail, and missing-provenance corpus-error.

---

## Phase reconstruction (CodeBuff method) — Stories 77-6, 77-8, 77-9

**Design resolved** (bmad-party-mode panel 2026-05-25). Decomposed into three dispatchable
two-part-key stories (substrate keys are `epic-story`; three-part `77-6-1` is unsupported by
the parser — panel decision to renumber): **77-6** (census), **77-8** (harness), **77-9**
(grader). Capability layer — **scheduled, never every-ship**. The CodeBuff method: for a
clean `feat(story-N-M)` commit, check out the parent repo at the pre-commit SHA, re-dispatch
*only the producing phase* against the original inputs, and grade the reconstruction against
the actual commit.

**Census correction (load-bearing).** The substrate-self reconstruction corpus is THINNER
than the Phase 0 ~9–19 estimate: a 2026-05-25 re-census found 12 `feat(story-)` commits / 8
keys, but 77-3/77-4/77-5 are hand-built (no producing-phase dispatch) and 77-1 was Path-A
reconciled — leaving only ~4 genuinely reconstructable substrate-self pairs (54-4, 67-1, 77-2,
998-1). **Therefore the reconstruction corpus MUST be cross-project**: the rich substrate-
dispatched history lives in the consumer repos (ynab, boardgame-sandbox, nextgen-ticketing,
strata). This is a capability-quality measurement, project-agnostic by design.

**Execution model (panel decision A):** bare phase re-dispatch via `dispatcher.dispatch()`
with the original inputs — NOT routed through the orchestrator lifecycle. Keeps the signal
surgical (measures the one phase, not the surrounding pipeline) and the cost bounded. This
also means 77-6 does NOT write substrate's own `story_metrics`/manifest provenance — 77-4 AC5
validation is satisfied separately, by the act of dispatching these sub-stories' *build*.

### Story 77-6: Cross-project reconstruction corpus census

> **STATUS: COMPLETE (2026-05-26, hand-built).** `scripts/build-reconstruction-corpus.mjs` + 14 unit tests. Two dispatch attempts escalated first (run1 c2874c68: runtime-probe YAML defect + wrong manifest schema; run2 770fe858: dev-story checkpoint-retry-timeout) — both validated 77-4 provenance in prod en route. Correlation reads `per_story_state[key].commit_sha` (F-commitsha), not the non-existent `stories[key]` shape run1 assumed. Corpus is forward-thin today (0 pairs; grows as post-v0.20.118 auto-commits accumulate).

**Priority**: could · **Dispatch eligibility**: dispatchable (deterministic, no LLM).

**Description**: Build a curated reconstruction corpus of clean `feat(story-N-M)` triples —
(producing commit SHA, parent SHA, original story-file input, run manifest) — across the
substrate repo AND the consumer repos. A triple is "clean" iff: the commit is a genuine
producing-phase auto-commit (NOT hand-built, NOT Path-A reconciliation), the parent SHA checks
out cleanly, the original story file is recoverable at the parent SHA, and a run manifest
correlates the commit to a phase.

**Acceptance Criteria:**
1. A census script enumerates candidate triples per repo from `git log` + `.substrate/runs/`,
   excluding hand-built/reconciled commits (heuristic: no correlating manifest dispatch, or
   commit author ≠ substrate auto-commit signature).
2. Output is a curated `_bmad-output/eval-results/corpus/reconstruction-corpus.yaml` with the
   producing phase (`create-story|dev-story|code-review`), repo, SHAs, and input paths per case.
3. Cross-project: census runs against a configurable list of repo roots; substrate-self pairs
   are included but NOT assumed sufficient. Records per-repo clean-pair counts.
4. Pollution guard mirrors 77-1: never auto-ingest a directory; the corpus is curated YAML.
5. Reports the corpus ceiling (total clean pairs) so 77-9's coverage is honest.

### Story 77-8: Single-phase reconstruction harness

**Priority**: could · **Dispatch eligibility**: dispatchable · **Depends on**: 77-6 (census).

**Description**: Given a corpus triple, reconstruct the phase: in an isolated worktree/checkout
at the parent SHA, re-dispatch ONLY the producing phase via `dispatcher.dispatch()` with the
original inputs, and capture the reconstructed output (files written / story file produced).

**Acceptance Criteria:**
1. Reconstruction runs in an isolated checkout at the parent SHA (reuse worktree machinery);
   never mutates the corpus repo's working tree.
2. Bare phase re-dispatch (panel decision A) — single `dispatcher.dispatch()` for the producing
   phase, original inputs, no orchestrator lifecycle, no review loop.
3. **Cost ceiling**: one phase dispatch per case, enforced via a per-case budget cap; the
   harness aborts a case that exceeds it and records `budget-exceeded` (never silently spends).
4. Captures the reconstructed artifact set for grading; cleans up the checkout afterward.
5. Failure-tolerant: a dispatch error on one case is recorded and skipped, never aborts the run.

### Story 77-9: Reconstruction grader (two-signal, ambiguous-only LLM)

**Priority**: could · **Dispatch eligibility**: dispatchable · **Depends on**: 77-8 (harness).

**Description**: Grade each reconstruction against the actual commit with a deterministic-first,
LLM-only-when-ambiguous rubric (panel decision). Implements `VerificationCheck` (Design
Principle 2). Capability-tier — informational, never gates a ship.

**Acceptance Criteria:**
1. **Deterministic signal (always):** file-set overlap (Jaccard of changed paths) + test-pass
   overlap via `BuildCheck`/`VerificationCheck` against the actual commit.
2. **LLM pairwise judge (ambiguous only):** invoke the `llm-evaluator.ts` injectable pairwise
   quality judge ONLY when the deterministic overlap lands in a configurable gray band (e.g.
   0.4–0.8 Jaccard). Clear pass/clear fail skip the judge — bounds cost.
3. Per-case verdict combines both signals into a reconstruction-quality score; the report joins
   the eval-results sink under the GREEN/YELLOW/RED rubric, tagged `tier=1 capability`.
4. **Never every-ship**: this grader is excluded from the `/ship` gate (77-3 Step 4.7); it runs
   on-demand / scheduled only. Documented as such.
5. Unit tests: deterministic-overlap scoring, gray-band judge-trigger boundary, judge-skip on
   clear pass/fail, combined-verdict rollup. LLM judge mocked.

---

## Story 77-7: Capability corpus + hill-climbing loop — STUB

**Priority**: could · **Dispatch eligibility**: operator-driven · **Status**: story-map stub.

**Intent**: Promote the hardest cases into a weekly capability run. Implement the
LangChain hill-climbing loop: failure-trace → automated error-analysis → targeted harness
change → re-eval. Track capability pass-rate trend over time. Depends on 77-1…77-5 being
stable and the decision-replay corpus being rich.

**To resolve before authoring full ACs**: capability-case selection criteria, error-analysis
agent design, trend-storage location, weekly cadence trigger.

---

## Out of scope (this epic)

- Full-pipeline (story → merged code) golden runs — Tier 3, deferred per operator scope
  decision 2026-05-23.
- External eval frameworks (Promptfoo, Inspect AI) — rejected per Design Principle 1.
- LLM-augmented AC traceability — already tracked under Epic 75's deferrals.
