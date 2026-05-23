# Substrate Eval Framework — Implementation Plan

**Date:** 2026-05-23
**Status:** Planned (Phase 0 census complete); captured as dispatch-ready epic
**Concept doc:** [2026-05-23-eval-frameworks-for-coding-harnesses.md](./2026-05-23-eval-frameworks-for-coding-harnesses.md)
**Dispatch-ready epic:** `_bmad-output/planning-artifacts/epic-77-eval-framework.md` (full specs 77-1..77-5, stubs 77-6/77-7)
**Origin:** bmad-party-mode panel, 2026-05-23

---

## TL;DR

Substrate **is** the harness the concept doc keeps referring to. Every substrate
ship is a harness change, and we have no eval gate on harness changes today.
This plan builds one — but by **assembling from substrate's ~15 existing
eval-adjacent subsystems**, not adopting an external framework (Promptfoo/Inspect
are for zero-base teams; bolting one on = two eval substrates + a translation
layer = exactly the tech debt we just spent three ships eliminating).

**Scope decisions (user, 2026-05-23):**
1. Target **Tier 1 (phase-level) + Tier 2 (trace-replay)** first. Defer
   full-pipeline (Tier 3).
2. First corpus from **git-commit reconstruction** (CodeBuff method).

**Phase 0 census changed the shape of the plan** — see "Census Findings" below.
The headline: trace-replay on *existing* logs only supports coarse outcome-class
assertions; the richer harness-decision assertions need a provenance-hardening
prerequisite. Commit-reconstruction corpus is thin (~9–19 clean pairs), so it's
the capability layer, not regression breadth.

---

## Design Principles

1. **Extend substrate's own eval substrate.** Reuse `ScenarioStore`,
   `SatisfactionScorer`, `VerificationCheck`/`VerificationPipeline`, the
   telemetry/metrics tables, and the `llm-evaluator.ts` injectable-LLM pattern.
   The seed crystal is `scripts/eval-probe-author.mjs` — a *working* eval harness
   (corpus format, A/B testing, catch-rate oracle, GREEN/YELLOW/RED rubric). The
   framework generalizes it from one phase to the pipeline.

2. **Graders ARE `VerificationCheck`s.** A grader written for eval can be promoted
   to a production gate and vice versa. This resolves the concept doc's open
   question ("the harness/eval boundary blurs") as a deliberate design feature:
   one sensor library, two consumers (live pipeline + eval harness).

3. **Grade outcomes, never paths.** Per the doc's anti-pattern: two valid
   implementations of the same story must both pass. Our `VerificationPipeline`
   already grades outcomes (build passes, ACs met) rather than tool-call
   sequences — keep it that way.

4. **`pass^k`, not `pass@k`, for production claims.** Substrate's headline is
   reliable autonomous runs; a 90% `pass@1` agent fails 1 in 10. Report
   reliability across repeated trials of a stable subset.

5. **Cost-bounded.** Full-pipeline trials are 5–40 min and real $. The free
   tier (trace-replay) gates every ship; paid tiers run on a schedule.

---

## Census Findings (Phase 0, complete)

Ran 2026-05-23 against substrate + ynab + boardgame + agent-mesh.

### Corpus sizes

| Source | `feat(story-N-M)` commits | Run manifests | Notes |
|---|---|---|---|
| substrate | 7 (1 reverted) | 197 | Mostly local dev/test runs — polluted |
| ynab | 2 | 9 | Real cross-project dispatches |
| boardgame | 0 | 1 | Pre-`feat(story-)` commit convention |
| agent-mesh | 0 | 0 | — |

The uniform `feat(story-N-M):` auto-commit format only started at **v0.20.86**;
earlier dispatches produced real commits with non-uniform messages, so the grep
undercounts. Clean commit↔manifest pairs usable for reconstruction: **~9–19**.

### What the logs actually capture (manifest completeness audit)

| Signal | Availability | Verdict |
|---|---|---|
| `story_metrics.result` (SHIP_IT / LGTM_WITH_NOTES / escalated / failed / verification-failed / NEEDS_MINOR_FIXES) | **219 outcomes, reliably populated** | ✅ Usable today |
| `per_story_state.status` / `phase` | populated (complete / escalated / verification-failed / dispatched) | ✅ Usable today |
| `review_cycles`, `dispatches` per story | populated | ✅ Usable today |
| `escalation_reason` | **0 of 197 manifests populated** | ❌ Provenance gap |
| `primary_model` (routing decision) | **NULL in story_metrics** | ❌ Provenance gap |
| `recovery_history` (recovery-ladder path) | non-empty in **only 15** manifests | ⚠️ Sparse |
| `review_verdicts` / decisions table | **does not exist** | ❌ No verdict provenance store |

**`story_metrics.result` outcome distribution (n=219):** LGTM_WITH_NOTES 61,
escalated 52, failed 46, SHIP_IT 30, verification-failed 20, NEEDS_MINOR_FIXES 10.

### Consequence for the plan

The assumption that rich trace-replay is buildable on existing logs is
**falsified**. Trace-replay splits:

- **Tier 2a (outcome-class) — buildable today.** Assert against
  `story_metrics.result` + status/phase + dispatch/cycle counts. 219-case corpus.
- **Tier 2b (decision-class) — needs provenance hardening first.** Assertions on
  routing model, escalation reason, recovery path require populating
  `primary_model`, `escalation_reason`, `recovery_history` reliably. This is a
  prerequisite sub-phase, not assumed-present data.

The escalation corpus is especially valuable: we *know* which historical
escalations were false (the ~28% interface-extraction false-escalation rate,
obs_026, etc.), so those become labeled "should NOT escalate" / "should escalate
for reason X" regression cases — once 2b provenance lands.

---

## Phased Plan

| Phase | What | Cost | Cadence | Builds on |
|---|---|---|---|---|
| **0. Corpus census** ✅ DONE | Enumerate commits + manifests; audit log completeness. | free | one-time | eval-probe-author/lib.mjs |
| **1. Tier 2a outcome-replay grader** | Read `story_metrics` + manifest; assert outcome class, dispatch/cycle counts against labeled expectations. Zero new dispatch. Corpus format generalized from probe-author YAML. | $0, seconds | **every ship** (CI gate) | story_metrics, per_story_state |
| **2. Regression gate wiring** | Wire Tier 2a into `/ship` Step + CI. Fail build on regression. `pass^k` aggregation over the stable subset. | $0 | every ship | ship.md, GH Actions |
| **0.5 (prereq for 2b). Provenance hardening** | Populate `escalation_reason`, `primary_model`, `recovery_history` reliably at write time. Small, surgical — columns/fields already exist, they're just not written. | free | one-time | metrics writers, orchestrator |
| **3. Tier 2b decision-replay grader** | Assert harness decisions (routing model, escalation reason, recovery path). Unlocks the labeled false-escalation regression corpus. | $0, seconds | every ship (after 0.5) | hardened provenance |
| **4. Tier 1 phase reconstruction** | Re-dispatch the producing phase against parent repo state; grade diff via `VerificationCheck` + pairwise LLM quality judge. Corpus-constrained (~9–19 cases). | bounded $/min | scheduled / pre-merge for phase-touching changes | ScenarioRunner, llm-evaluator, VerificationPipeline |
| **5. Capability corpus + hill-climbing loop** | Promote hardest cases to a weekly capability run; failure-trace → diagnosis → harness change → re-eval (the LangChain loop). | $$ | weekly | all of the above |

### What ships first

**Phases 1 + 2** — a **$0, every-ship CI regression gate** over the 219-case
`story_metrics.result` corpus. This alone closes the actual gap the census's Five
Whys surfaced: *substrate fixes have been validated by hand against the one case
that triggered them, with no standing regression suite re-checking all prior
failure modes on every ship.*

Then **0.5 + 3** to unlock the labeled false-escalation regression corpus (the
highest-value substrate-specific eval).

**4 + 5** (commit reconstruction + capability) are corpus-constrained and
expensive — last, and scheduled rather than ship-gating.

---

## Corpus Format (to be finalized in Phase 1)

Generalize `scripts/eval-probe-author/lib.mjs` corpus parsing. One entry =
one labeled case:

```yaml
# Tier 2a outcome-class case
- id: obs_026-interface-extraction-false-escalation
  source: substrate            # repo
  story_key: 41-3
  run_id: <uuid>               # source manifest
  expect:
    result_class: SHIP_IT      # NOT escalated (this was a known false escalation)
    max_review_cycles: 3
  label_reason: "obs_026 — interface extraction misclassified as needing major revision"
```

Tier 1 reconstruction cases additionally carry `parent_commit`, `phase`
(create-story | dev-story | code-review), and `actual_commit` for diff grading.

---

## Top Risks

1. **Corpus ceiling (confirmed thin for reconstruction).** ~9–19 clean
   commit↔manifest pairs. Mitigation: Tier 2a's 219-outcome corpus carries the
   regression load; reconstruction is the capability layer, not the breadth layer.
2. **Provenance gap (confirmed).** Decision-class trace-replay (2b) is blocked
   until Phase 0.5 hardening. Mitigation: sequenced explicitly; 2a delivers value
   without it.
3. **Tier 1 cost creep.** Phase reconstruction is bounded but not free. Mitigation:
   kept off the every-ship path (Phase 4 is scheduled, not CI-gating).
4. **`.substrate/runs/` pollution.** 124 of 197 substrate manifests are
   incomplete local dev/test runs (`running`/`dispatched`). The corpus must be
   *curated* (labeled YAML), never "point the grader at the directory."

---

## Open Questions (carried from concept doc, substrate-specific)

- **First-pass vs self-correction weighting.** An agent that escalates-then-recovers
  may be more production-ready than one that ships first-pass but can't recover.
  Substrate's recovery engine makes this measurable — should `pass^k` credit
  recovered runs differently from first-pass successes?
- **Difficulty scaling.** Should eval difficulty scale with target-codebase
  complexity? Substrate runs cross-project (TS, Python, Go) — a per-language
  difficulty baseline may be needed before cross-project `pass^k` is comparable.
