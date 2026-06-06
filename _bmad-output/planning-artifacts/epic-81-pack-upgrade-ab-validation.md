# Epic 81: Pack-Upgrade A/B Validation — gate BMad pack upgrades against quality drift

> **Sibling-epic context:** Epic 77 ships the every-ship eval substrate (outcome-replay
> Tier 2a, decision-replay Tier 2b, reconstruction Tier 1). Epic 81 is its pack-upgrade
> companion: a separate harness keyed on `packs/bmad/**` changes that emits a per-PR
> quality-delta report, not an every-ship gate.
>
> **Related design context:**
> - The 2026-05-31 pack-abstraction audit (party-mode panel) confirmed substrate's
>   methodology coupling is concentrated at the data model + init scaffolding + verdict
>   vocabulary layers — but pack content (prompts/templates/constraints/manifest) flows
>   into dispatches via a methodology-neutral pack-loader/prompt-assembler chain. That
>   makes *content upgrades* of `packs/bmad/` tractable to A/B-validate without first
>   touching the deeper coupling layers.
> - The four signal axes (code quality, cost, verdict, recovery) and the full-corpus
>   (35-pair) decision were operator-confirmed in the same 2026-05-31 session.

## Vision

The BMad methodology pack drives every substrate dispatch — `packs/bmad/prompts/` is
read once per phase, assembled into the prompt the spawned CLI agent receives, and
the resulting code quality is shaped by that content. A version upgrade — new prompt
phrasing, refined constraints, new template structure — can silently degrade dispatch
quality without changing any per-story outcome class. **Today nothing in substrate's
eval framework catches that.**

Epic 77's regression tier (77-1 outcome-replay) is the wrong instrument for this job:
it keys on orchestrator decisions and result class, not on prompt-derived code
quality. Epic 77's reconstruction tier (77-9) is the right instrument but is
forward-thin (~0 production pairs today) and explicitly off-gate.

Epic 81 ships a **purpose-built pack-upgrade A/B harness** that re-dispatches a
curated subset of the regression corpus pairs under both the currently-shipped pack
and a candidate pack rev, captures full dispatch envelopes, and grades on four signal
axes. Initially report-only as a PR comment; promotable to a blocking gate once the
threshold distributions are calibrated by 2–3 live pack-upgrade evaluations.

## Root cause it addresses

Five regression classes a BMad pack content change can introduce, mapped against the
existing eval framework's coverage:

| # | Regression class | 77-1 outcome | 77-5 decision | 77-9 reconstruction | 77-7 cost (stub) |
|---|---|---|---|---|---|
| 1 | Prompt-quality silent drift (worse code, same outcome class) | ❌ | ❌ | ✅ (off-gate, corpus-thin) | ❌ |
| 2 | Phase-failure escalation | ✅ | ✅ | partial | ❌ |
| 3 | Cost regression (more turns/tokens for same outcome) | ❌ | ❌ | partial | ✅ (stub) |
| 4 | Verdict distribution drift (code-review becomes lenient/strict) | ⚠️ extremes only | ✅ if encoded | ❌ | ❌ |
| 5 | Recovery class drift (different Tier A causes) | ⚠️ partial | ✅ | ❌ | ❌ |

**Gaps:** classes 1, 3, 4 have no gated detection today. The reconstruction tier
handles class 1 in principle but its corpus is forward-thin and the check is off-gate.
Cost regression has no detector at all. Verdict drift has no detector at all.

Epic 81 closes all five gaps via a **single A/B harness** that captures the signal
envelope shape needed for every class, then surfaces the four-axis delta in one report.

## Why now

1. **The audit landed (2026-05-31).** Pack content remains methodology-neutral at the
   loader/assembler layer — validating pack *content upgrades* is achievable now, even
   though the deeper methodology-swap question (data model, init scaffolding, verdict
   vocabulary) is correctly back-burnered as an epic-scale lift.
2. **The pack DOES upgrade.** `bmad-method@^6.2.2` is npm-versioned; pack content
   evolves under us. Every pack rev is a silent harness change today; we've shipped
   eight months of substrate without a single regression check on this surface.
3. **Eval framework foundation exists.** Epic 77's reconstruction harness
   (`scripts/eval-reconstruction/harness.mjs`) is already designed for isolated-worktree
   dispatch at a parent SHA — exactly the primitive a pack-A/B harness needs. Reuse,
   don't fork.
4. **Operator capacity confirmed (2026-05-31):** cost budget = full 35-pair A/B
   (~10–20 compute-hours per pack upgrade); report-only mode for the first 2–3
   evaluations; all four signal axes; forward-only schema additions accepted as part
   of the v0.20.115/118/124/130 additive pattern.

## Design Principles (binding constraints on all stories)

1. **Forward-only / additive everywhere.** No schema field deletions, no orchestrator
   behavior changes, no breaking changes to existing eval signals. `PerStoryStateSchema`
   additions follow the v0.20.115 (`primary_model`, `escalation_reason`,
   `recovery_history`) / v0.20.118 (`commit_sha`) / v0.20.124 (`story_file`*) /
   v0.20.130 (`escalation_detail`) pattern.
2. **Reuse the reconstruction harness — do not fork it.** The pack-A/B harness is
   conceptually `scripts/eval-reconstruction/harness.mjs` plus a `--pack-override`
   parameter and a wrapper that pairs two dispatches at the same parent SHA. Any
   primitive that already exists in the reconstruction harness (worktree-detach,
   bare-phase dispatch via `dispatcher.dispatch()`, per-case budget cap, artifact
   capture, always-cleanup-via-finally) MUST be reused.
3. **Pure helpers + injectable I/O.** Grader logic stays in pure functions for unit-test
   coverage. Dispatch primitives (`runHarness`, `gradeAll`, `formatReport`) take
   `{ dispatch, captureArtifacts, cleanup, … }` so the harness tests use synthetic
   envelopes and do not require live model calls.
4. **Report-only first, gate-later.** The first 2–3 pack-upgrade evaluations run in
   report-only mode (PR comment, no merge block). After observing real signal
   distributions, the operator decides per-axis whether and how to promote to a
   blocking gate. Document the flip date in 81-5.
5. **No external eval dependency.** Same Design Principle 1 as Epic 77 — assemble from
   substrate's existing eval substrate. No Promptfoo / Inspect / external service.
6. **Distinct from the every-ship regression gate.** Epic 81 is a *pack-touching-PR
   gate*, not an every-ship gate. Trigger criteria: presence of changes under
   `packs/bmad/**` in the PR diff. Computing cost is real (~10–20 hours per A/B run);
   running on every ship would be wasteful and would dilute the signal-to-noise ratio
   of the regression tier.
7. **Distinct from the methodology-swap question.** Epic 81 covers BMad-pack-content
   upgrades, NOT methodology substitution. Methodology substitution (e.g., a hypothetical
   GSD adapter) is parked as a separately-scoped epic that depends on the data-model +
   init-scaffolding + verdict-vocabulary abstraction work the 2026-05-31 audit surfaced.

## Story Map

- 81-1: PerStoryStateSchema forward-only additions for pack-upgrade signals (P0, Small) — ✅ SHIPPED
- 81-2: Pack-upgrade A/B harness (P0, Medium) — ✅ SHIPPED
- 81-3: Pack-upgrade four-axis grader (P0, Medium) — ✅ SHIPPED
- 81-4: Pack-upgrade CLI + report formatter (P0, Small) — ✅ SHIPPED
- 81-5: CI integration + PR-comment poster (P1, Small) — **OPERATOR-BUILT** · ⏸ DEFERRED (operator decision 2026-06-04: run the harness locally, no CI yet; PR #6 closed, branch `epic-81-ci` preserved)
- 81-6: Production dispatcher wiring for eval harnesses (P0, Medium) — ✅ SHIPPED (+2 followup fixes: AdapterRegistry.register signature, default deps.dispatch)
- 81-7: Enrich the pack-upgrade signal floor (P0, Medium) — 📋 FILED (AC2 partly done by commit 9cb802a)
- 81-8: Mint the shared eval corpus from accumulated dispatch history (P0, Medium) — 📋 FILED

**The 81-7 ⊕ 81-8 pair** is the open work: 81-7 fixes the signal *scoring* (cost-axis
`total_turns`, near-empty-diff handling, unit tests, stronger regression target); 81-8
fixes the signal *source* (census-derived shared corpus replacing the hand-built
4-pair fixture, which also feeds Epic 77's forward-thin reconstruction tier). They touch
disjoint surfaces and can run in parallel. Both close the capability defect found in the
2026-06-01 Phase 4.2 calibration (vacuous GREEN despite a real pack change).

**Dispatch eligibility:**
- **Dispatchable**: 81-1, 81-2, 81-3, 81-4, 81-6, 81-7, 81-8 (additive code only; no orchestrator
  behavior changes; no `/ship` or CI surface touches)
- **Operator-built, NOT dispatched**: 81-5 (touches `.github/workflows/*` — operator/CI
  surface substrate does not modify via autonomous dispatch, per the Epic 77 / 77-3
  convention) — currently deferred per operator decision

**Dependency chain:**
- 81-1 must land first — schema additions block 81-3's verdict/cost capture; harness
  envelopes contracted in 81-2 depend on the additive field shape
- 81-2 + 81-3 can run in parallel after 81-1 (envelope shape is contracted by 81-1's
  schema; the harness produces it, the grader consumes it — no circular dependency)
- 81-4 depends on 81-2 + 81-3 (drives both)
- 81-5 depends on 81-4 (consumes its report format)

**Recommended first dispatch:** `--stories 81-1` — foundation, low bootstrap risk,
unblocks parallel 81-2 + 81-3. Once 81-1 ships, dispatch `--stories 81-2,81-3`
concurrently, then 81-4 solo, then operator builds 81-5.

---

## Story 81-1: PerStoryStateSchema forward-only additions for pack-upgrade signals

**Priority**: must · **Dispatch eligibility**: dispatchable (additive schema + capture sites)

**Description**: Add three forward-only optional fields to `PerStoryStateSchema` to
record the signal axes the pack-upgrade A/B harness needs. All three are additive
(no breaking changes), follow the existing pattern (v0.20.115/118/124/130), and have
clear capture sites already in the orchestrator. This story is intentionally small
and low-risk — it is the foundation that unblocks everything else.

**Acceptance Criteria** (full detail in the story file):
1. Add `verdict?: VerdictEnum` capturing the final code-review verdict per story
2. Add `total_turns?: number` summing turn-count across all phase dispatches for the story
3. Add `total_tokens?: { input: number; output: number }` summing tokens across phases
4. Capture sites wired in the orchestrator (next to existing `commit_sha` / `escalation_reason` writes)
5. Schema round-trip tests + capture-site unit tests
6. No behavior change to dispatch, no behavior change to existing eval signals

---

## Story 81-2: Pack-upgrade A/B harness

**Priority**: must · **Dispatch eligibility**: dispatchable · **Depends on**: 81-1 (envelope contract)

**Description**: Build `scripts/eval-pack-upgrade/harness.mjs` — the A/B dispatch
primitive. For a given corpus pair (parent SHA + story-file input), spawn two
isolated worktrees at the parent SHA, dispatch the same story under
`--pack-current` and `--pack-candidate` packs, capture the full dispatch envelope
(diff + total_turns + total_tokens + verdict + recovery_history) from each.

Reuses the reconstruction harness's `git worktree --detach` + bare-phase-dispatch +
per-case budget cap + always-cleanup-via-finally primitives. Adds the pack-override
parameter and the second-dispatch wrapper.

**Acceptance Criteria** (full detail in the story file):
1. New CLI: `node scripts/eval-pack-upgrade/harness.mjs --pack-current <path> --pack-candidate <path> --corpus <path>`
2. Reuses reconstruction harness primitives (worktree isolation, dispatch wrapper, cleanup)
3. Per-pair envelope capture: `{ pack: 'current'|'candidate', diff, total_turns, total_tokens, verdict, recovery_history, ... }`
4. Per-case budget cap (default $2 USD, configurable) — case aborted and recorded as `budget-exceeded`
5. Failure-tolerant: a dispatch error on one case is recorded and skipped, never aborts the run
6. Injectable I/O (`dispatch`, `captureArtifacts`, `cleanup`, `costFn`) for unit testing
7. Unit tests with synthetic dispatch envelopes (no live model calls)

---

## Story 81-3: Pack-upgrade four-axis grader

**Priority**: must · **Dispatch eligibility**: dispatchable · **Depends on**: 81-1 (envelope contract)

**Description**: Build `scripts/eval-pack-upgrade/grader.mjs` — pure scoring across
four signal axes against a pair of captured envelopes. Three of the four axes have
existing scoring primitives that get reused:
- **Code quality**: reuse `deterministicSignal` + gray-band judge from
  `scripts/eval-reconstruction/grader.mjs` against ground truth, output per-pack score + Δ
- **Cost**: pure delta computation (Δ turns, Δ input tokens, Δ output tokens)
- **Verdict**: categorical comparison + corpus-aggregate distribution shift
- **Recovery**: taxonomy-bucketed distribution shift across the corpus

**Acceptance Criteria** (full detail in the story file):
1. Pure `gradePair(envelopeA, envelopeB, groundTruth)` function — no I/O
2. Code-quality axis reuses Epic 77 reconstruction grader's deterministic + gray-band judge
3. Cost axis: per-pair Δ + corpus aggregate (mean, p95)
4. Verdict axis: per-pair comparison + corpus distribution shift
5. Recovery axis: taxonomy distribution shift across corpus
6. Output shape: `PackUpgradeGradeResult` with per-axis verdicts + per-pair detail
7. Unit tests for all four axes with synthetic envelopes

---

## Story 81-4: Pack-upgrade CLI + report formatter

**Priority**: must · **Dispatch eligibility**: dispatchable · **Depends on**: 81-2, 81-3

**Description**: Build `scripts/eval-pack-upgrade.mjs` — the top-level CLI entry point
that drives 81-2's harness over the corpus, feeds envelopes into 81-3's grader,
aggregates the four-axis report, and emits one of three output formats (markdown for
PR comment, JSON for CI consumption, plain for local invocation). Threshold-driven
warnings per axis; the gate-or-no-gate decision lives in 81-5.

**Acceptance Criteria** (full detail in the story file):
1. CLI: `node scripts/eval-pack-upgrade.mjs --pack-current PATH --pack-candidate PATH [--corpus PATH] [--threshold <axis:value,...>] [--format markdown|json|plain] [--output PATH]`
2. Default corpus = `_bmad-output/eval-results/corpus/outcomes-corpus.yaml` (the full 35-pair regression corpus from 77-2)
3. Report formats: markdown (PR comment), JSON (CI), plain (terminal)
4. Per-axis thresholds (warn vs fail) configurable on the CLI; defaults documented
5. Exit codes: 0 GREEN, 1 YELLOW (warnings emitted), 2 RED (threshold exceeded)
6. Reuses Epic 77 result sink: writes JSON report to `_bmad-output/eval-results/`
7. Pollution guard inherited from 81-2 (corpus-only — never enumerates `.substrate/runs/`)
8. Unit tests for the threshold logic + report formatters

---

## Story 81-5: CI integration + PR-comment poster — OPERATOR-BUILT

**Priority**: should · **Dispatch eligibility**: **OPERATOR-BUILT — do NOT dispatch.**
Touches `.github/workflows/*` and PR-comment authentication, which are operator/CI
surfaces substrate does not modify via autonomous dispatch (same convention as 77-3).

**Description**: Wire 81-4's CLI into a GitHub Actions workflow that triggers on PRs
touching `packs/bmad/**`, runs the full A/B evaluation, and posts the markdown
report as a PR comment. Report-only initially; promote to blocking gate after 2–3
calibration runs.

**Acceptance Criteria** (full detail in the story file):
1. `.github/workflows/eval-pack-upgrade.yml` triggers on PRs touching `packs/bmad/**`
2. Workflow checks out both the base branch's pack and the PR's pack as separate paths, invokes `scripts/eval-pack-upgrade.mjs --pack-current <base> --pack-candidate <pr>`
3. Markdown report posted as PR comment (with updates-in-place via comment-id discovery)
4. Workflow timeout >= 24 hours (full 35-pair A/B can take 10–20 compute-hours)
5. Report-only initially (workflow always exits 0 regardless of YELLOW/RED rubric)
6. Promotion-to-gate flip date documented in this story's completion notes once calibration runs are observed
7. Documentation in `docs/` explaining the workflow + how operators read the report

---

## Out of scope (this epic)

- **Methodology substitution** (e.g., a hypothetical GSD adapter) — separately scoped;
  blocked on the methodology-abstraction arc the 2026-05-31 audit identified.
- **Per-prompt unit tests** — not the right shape; prompt quality is downstream-of-prompt
  behavior, not a property assertable against the prompt itself. The A/B harness IS the
  test.
- **Static analysis of pack content** (linting prompts, validating template structure
  against a schema) — useful but a different kind of check; can be added later as a
  separate gate, not part of this epic.
- **Automated threshold tuning** — the first 2–3 calibration runs are operator-driven
  threshold tuning. Automating that requires more data than we'll have for at least a
  quarter.
