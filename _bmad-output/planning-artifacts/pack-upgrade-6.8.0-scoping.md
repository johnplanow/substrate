# Scoping: "upgrade the BMad pack to 6.8.0" — corrected model + decomposition

**Date:** 2026-06-07
**Status:** SCOPING — investigation complete; the original "port the candidate pack" framing rested on a false premise. Two separate, smaller tasks identified.

## The premise we started with (and why it's wrong)

The party-mode readiness discussion assumed: *substrate's `packs/bmad@1.0.0` is an adapted/vendored copy of `bmad-method`; upgrading to 6.8.0 means porting substrate's adaptations onto the 6.8.0 base, then evaluating the result.*

**Investigation (2026-06-07) shows there is no base→overlay relationship to port.** Evidence:

1. **`bmad-method` is not a pipeline-runtime dependency.** Zero `import/from 'bmad-method'` in `src/`/`packages/`. The only references are in `src/cli/commands/init.ts` (lines 474, 523) and `pipeline-shared.ts` (69, 83), all `_require.resolve('bmad-method/package.json')` — they read the package *version* and use its scaffolding *generators* at `substrate init` time only.

2. **The pipeline loads `packs/bmad/` exclusively.** `src/modules/methodology-pack/pack-loader.ts` reads `packs/bmad/manifest.yaml` and the prompt files it references. No `bmad-method` involvement at dispatch time.

3. **`packs/bmad/` is substrate's own hand-authored artifact, not vendored content.** It's 36 compiled prompts in substrate's `{{placeholder}}` template format, a substrate-specific `manifest.yaml` (phase/step/gate orchestration schema with substrate's own epic-numbering `conflictGroups` and internal story references — "Story 20.1", "Epic 60 Phase 2 — Story 60-12"), constraints, and a story template. Upstream `bmad-method@6.2.2` ships **240 skill `.md` files** in a completely different structure (`src/bmm-skills/<phase>/<skill>/{SKILL,workflow,checklist}.md`). The two share methodology DNA but **zero textual lineage** — e.g. substrate's single `prompts/dev-story.md` vs upstream's `bmm-skills/4-implementation/bmad-dev-story/{SKILL,workflow,checklist}.md`.

**Consequence:** substrate's pack does **not drift when bmad-method releases.** It changes only when someone edits `packs/bmad/`. The "6 versions behind (6.2.2 → 6.8.0)" framing is a near-non-issue for the *pipeline*; it matters only for init scaffolding and as an optional *source of ideas*.

## The corrected decomposition — two independent tasks

### Task 1 — Bump the `bmad-method` dependency 6.2.2 → 6.8.0 (ordinary, NOT an eval target)

- **What it touches:** `package.json` dep, and at runtime ONLY `substrate init` (version read + skill/agent/workflow generators at `init.ts:474/523`, `pipeline-shared.ts:69/83`).
- **What it does NOT touch:** any dispatch prompt. So it produces **no pack-content delta** and is **not a candidate for the Epic 81 harness** at all.
- **Scope:** bump version, `npm i`, run the init-scaffolding tests (`auto-claude-settings-scaffold`, `auto-claude-commands-scaffold`, etc.), smoke `substrate init` against a scratch dir, confirm the 6.8.0 generators still produce the `.claude` skill set substrate expects. If 6.8.0 changed the generator API or skill layout, adapt the init glue.
- **Risk:** low–medium (a generator-API change is the only real surprise surface). Ordinary dependency-upgrade discipline applies; the eval harness is irrelevant here.
- **Dispatchability:** touches `package.json` + init glue — operator-supervised, not a clean autonomous dispatch.

### Task 2 — Reflect 6.8.0 methodology improvements into substrate's compiled prompts (the REAL Epic 81 eval target)

This is the only task the pack-upgrade harness is built to evaluate, and it's a **semantic adaptation task, not a file merge.**

- **Discovery sub-task (do first):**
  1. Fetch `bmad-method@6.8.0` source (`npm pack bmad-method@6.8.0` or a tagged checkout) alongside the installed 6.2.2.
  2. Methodology-diff the skills that correspond to substrate's compiled prompts — primarily `bmad-dev-story`, `bmad-code-review`, `bmad-create-story`, the analysis/planning/solutioning workflows. Identify *substantive methodology changes* (new DoD criteria, refined guidance, new constraints), filtering out structural/tooling churn that doesn't apply to substrate's compiled-prompt format.
  3. Produce a short "harvest list": which upstream changes are worth reflecting into `packs/bmad/prompts/*`, and which are N/A (substrate already covers it / doesn't apply to the compiled-prompt model / is CLI-tooling-only).
- **Adaptation sub-task:** author the harvested changes into a candidate pack (`/tmp/pack-6.8.0-candidate` = copy of `packs/bmad` + the reflected edits). This is hand-authoring in substrate's prompt idiom, informed by upstream — NOT copying upstream files.
- **Eval sub-task:** run the candidate through the Epic 81 harness **report-only** on the now-7-pair fixture (`scripts/eval-pack-upgrade.mjs --pack-current packs/bmad --pack-candidate /tmp/pack-6.8.0-candidate --corpus _bmad-output/eval-results/corpus/pack-upgrade-fixture-corpus.yaml --format markdown`). Read the 5-axis delta as ONE input, with the documented caveats (7 archetype-monotone grounded pairs; thresholds calibrated on ~3 runs; verdict is dev-tool-shaped). Investigate any YELLOW/RED by hand. Bank the run as calibration.
- **Risk:** the discovery sub-task may conclude *little or nothing* in 6.8.0's methodology is worth reflecting — in which case Task 2 closes with "no beneficial delta found," which is itself a valid, valuable outcome. The harness then never runs because there's no candidate change to evaluate.
- **Dispatchability:** the discovery + adaptation is judgment-heavy authoring; best operator-driven or a carefully-scoped dispatch with a human reviewing the harvest list before adaptation.

## Recommended sequencing

1. **Task 1 first, standalone** — it's an ordinary dep bump, unblocks any init-scaffolding benefits of 6.8.0, and is cleanly separable. Do it whenever; it does not gate Task 2.
2. **Task 2 discovery sub-task next** — cheap, deterministic, and *decides whether Task 2 even has a body.* If the methodology diff surfaces nothing worth taking, stop — the pack is current-enough and the harness has nothing to grade.
3. **Task 2 adaptation + eval** only if discovery finds worthwhile improvements — and that eval is exactly the report-only, human-in-the-loop run the readiness assessment green-lit.

## What this means for the readiness verdict

The eval harness readiness verdict (see `docs/2026-05-31-epic-81-first-calibration.md`, "Eval-readiness assessment") is unchanged: **ready for report-only decision-support.** What changed is the *prerequisite*: it is NOT a big multi-version porting lift. It is (1) an ordinary dep bump and (2) a methodology-diff that may or may not yield a candidate change worth evaluating. The "candidate pack doesn't exist yet" blocker is real but small — and may resolve to "there's nothing substantive to port," in which case the honest answer is that substrate's pack is already current in every way that affects dispatch quality.
