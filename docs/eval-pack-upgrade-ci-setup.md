# Pack-Upgrade Evaluation CI — Setup & Operations Guide

> **Status (2026-05-31): WORKFLOW SHIPPED, CAPABILITY DEFERRED.**
> The workflow yaml at `.github/workflows/eval-pack-upgrade.yml` is wired and
> ready, but it currently posts **vacuous GREEN** reports on every pack-touching
> PR because both substrate eval harnesses (Epic 77 reconstruction + Epic 81
> pack-upgrade) ship with `deps.dispatch` STUBBED. Story 81-6 (production
> dispatcher wiring) unblocks both tiers in a single ship.
>
> Read `docs/2026-05-31-epic-81-first-calibration.md` for the full
> architectural finding + 81-6 scope before configuring this workflow.

## What this workflow does

Trigger: PRs that modify any file under `packs/bmad/**`.

Job:
1. Checks out the PR head (candidate pack) and the base branch's pack (current)
2. Installs deps, builds
3. Runs `scripts/eval-pack-upgrade.mjs` with both packs and the full Epic 77
   regression corpus
4. Posts the four-axis markdown report as a PR comment (update-in-place via
   a `<!-- pack-upgrade-report -->` marker)
5. Uploads the markdown + JSON reports as workflow artifacts (90-day retention)

The workflow is **report-only** — it always exits 0 regardless of the CLI's
verdict-driven exit code. The CLI's exit code is surfaced in a `<sub>` line
at the top of the PR comment so reviewers can see GREEN/YELLOW/RED at a glance.

## Required GitHub secret

```
ANTHROPIC_API_KEY  — required for substrate dispatch in CI
```

Add this at **Settings → Secrets and variables → Actions → New repository secret**.

OAuth session-based auth (substrate's local default per
`[[feedback_substrate_dispatch_disciplines]]`) is NOT available in GHA;
API-key auth is the CI path.

## Required corpus state

`_bmad-output/eval-results/corpus/outcomes-corpus.yaml` is the default corpus.
For the harness to actually dispatch (vs return vacuous GREEN), each corpus
entry must have `parent_sha`, `commit_sha`, and `story_file_input_path`
populated. The Epic 77 35-pair corpus does NOT have these fields today — it
predates F-commitsha (v0.20.118) and obs_027 (v0.20.124).

Override the corpus via `--corpus <path>` in the workflow step if a curated
fixture is desired. A 4-pair fixture for substrate-self is at
`_bmad-output/eval-results/corpus/pack-upgrade-fixture-corpus.yaml`.

## Cost ceiling

- Full corpus: 35 pairs × 2 packs × ~5–40 min/dispatch = ~6–47 compute-hours
- Per-dispatch budget cap: $2.00 (configurable via `--budget-per-case-usd`)
- Worst-case per pack-upgrade PR: **~$140** (rare; typical $30–$70)
- Workflow timeout: 24 hours

This is acceptable spend on a pack-upgrade-PR frequency of ~1–5 per quarter.
On heavier frequencies, reconsider the corpus size or trigger criteria.

## Reading the report

The markdown report (also the PR comment body) has this structure:

```
# Pack-upgrade evaluation report
**Current pack**: <path> @ <version-or-sha>
**Candidate pack**: <path> @ <version-or-sha>
**Corpus**: <file>, <N> pairs, <M> completed both, <K> ungradable
**Overall verdict**: 🟢 GREEN | 🟡 YELLOW | 🔴 RED

## Axis verdicts
| Axis | Verdict | Headline |
| --- | --- | --- |
| Code quality | … | mean Δ = … |
| Cost | … | mean Δ turns = … |
| Verdict distribution | … | TV = … |
| Recovery taxonomy | … | TV = … |

## Per-axis detail
… top regressions per axis …
```

**A vacuous-GREEN report** (every axis "ungradable_count" == N) means the
harness ran but produced no measurements — the dispatcher stub is the
likely cause until 81-6 ships.

## Promotion-to-gate criteria

The workflow ships in **report-only mode**. To promote to a **blocking gate**
(workflow fails on RED/YELLOW), the operator must verify:

1. **Story 81-6 merged** — production dispatcher is actually wired, so the
   harness produces real measurements
2. **≥ 3 pack-upgrade PRs observed** with real (non-vacuous) signal — gives
   the operator a sense of the natural distribution
3. **Thresholds tuned** against the operator's quality bar — the defaults
   (`code-quality:0.05, cost-turns:0.10, verdict-tv:0.10, recovery-tv:0.10`)
   are starting points, not validated against substrate's actual signal
4. **One intentional regression tested end-to-end** — confirms the workflow
   surfaces RED correctly when given a deliberately-degraded pack

To promote, edit `.github/workflows/eval-pack-upgrade.yml`:
- Remove the `exit 0` in the "Run pack-upgrade evaluation" step
- Or replace the final `exit 0` with `exit $VERDICT_EXIT`
- Add a header-comment block documenting the flip date and the calibration
  observations that justified it

## Troubleshooting

**"vacuous GREEN" on every PR** — Expected today. Until Story 81-6 wires the
production dispatcher, the harness cannot actually dispatch. See
`docs/2026-05-31-epic-81-first-calibration.md`.

**"corpus pollution — 40 corpus-errors"** — The default Epic 77 corpus lacks
`parent_sha`. Use `--corpus _bmad-output/eval-results/corpus/pack-upgrade-fixture-corpus.yaml`
for the 4-pair substrate-self fixture instead, or wait for a corpus-extension
story to populate parent_sha for the Epic 77 entries.

**Workflow times out at 24 hours** — Increase `timeout-minutes` (note: GHA
caps at 360 for free tier, higher tiers can go further). Or reduce the corpus
size via `--corpus <smaller-fixture>`.

**Auth failure during dispatch** — Confirm `ANTHROPIC_API_KEY` is set at the
repo level (Settings → Secrets) and that the substrate dispatcher actually
respects it in CI. Story 81-6 should verify this end-to-end.

**Comment posting fails with 403** — Confirm the workflow has
`permissions: pull-requests: write`. Also note that the safety boundary
`if: github.event.pull_request.head.repo.full_name == github.repository`
skips fork PRs intentionally — secret-scoped behavior on forks is undefined
and a separate design discussion.

## Related docs

- `docs/2026-05-31-epic-81-first-calibration.md` — architectural finding +
  Story 81-6 scope (READ THIS FIRST)
- `_bmad-output/planning-artifacts/epic-81-pack-upgrade-ab-validation.md` —
  full Epic 81 plan
- `_bmad-output/implementation-artifacts/81-5-pack-upgrade-ci-integration.md` —
  this story's full AC spec
