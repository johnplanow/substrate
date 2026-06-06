# Story 81-8: Mint the shared eval corpus from accumulated dispatch history

## Story

As a substrate eval-framework operator,
I want a single census-derived corpus of real `(parent_sha, commit_sha, story_file_input_path, run_id)` triples — harvested from substrate's own AND the consumer repos' accumulated post-v0.20.118 auto-commits — consumed by BOTH the reconstruction harness (Epic 77, Tier 1) and the pack-upgrade harness (Epic 81),
so that Epic 81's deliberate-regression test runs against real, reproducible dispatch pairs instead of the hand-built 4-pair fixture, and Epic 77's reconstruction tier finally has a non-empty corpus.

This story is the corpus half of the 81-7 ⊕ 81-8 pair. **81-7 fixes the signal scoring; 81-8 fixes the signal source.** They share the goal of making Phase 4.2 a meaningful capability test rather than a vacuous PASS, and they touch disjoint surfaces (81-7: grader/harness internals; 81-8: corpus census scripts + the shared corpus file), so they can run in parallel.

See `docs/2026-05-31-epic-81-first-calibration.md` for the empirical findings that motivated both.

## Background — the honest ceiling (established fact; do NOT re-derive)

A 2026-06-06 census across the local repos found:

| Repo | `.substrate/runs` manifests | `feat(story-)` commits | Reconstructable? |
|---|---|---|---|
| substrate (self) | 300 | 22 | ~5–8 (only post-v0.20.118 commits carry `per_story_state[key].commit_sha`) |
| ynab | 9 | 2 | ~2 |
| strata | 0 | 7 | **0** — commits exist but manifests were excluded/cleaned, so no SHA↔manifest correlation |
| boardgame-sandbox | 1 | 0 | 0 |
| agent-mesh | 0 | 0 | 0 |

**Realistic clean-pair ceiling today: ~7–10 pairs.** This is a STRUCTURAL limit, not a "we haven't run the census" gap: F-commitsha (v0.20.118) only persists the auto-commit SHA going forward, and `per_story_state[key].commit_sha` is the only reliable correlation key (the `stories[key].commit_sha` shape never existed — the first 77-6 dispatch assumed it and found 0 pairs). The corpus grows organically as new substrate auto-commits accumulate.

The existing census script `scripts/build-reconstruction-corpus.mjs` (Story 77-6) already implements the correct cleanliness criteria. This story REUSES it — it does not reinvent the census.

## Acceptance Criteria

1. **Run the existing reconstruction census across substrate-self + ynab** via `scripts/build-reconstruction-corpus.mjs --repos <substrate>,<ynab>`. Capture the actual clean-pair count and per-repo breakdown. If the census surfaces fewer than ~5 substrate-self pairs, investigate whether recent post-v0.20.118 auto-commits (80-1, 81-1, 81-3, 81-4, 81-6) are being correctly detected, and fix any census gaps found (e.g. a commit-subject regex that misses a valid `feat(story-N-M):` form). Document the final count in Dev Notes.

2. **Unify the pack-upgrade corpus with the reconstruction corpus.** Today the pack-upgrade harness reads a SEPARATE hand-built `_bmad-output/eval-results/corpus/pack-upgrade-fixture-corpus.yaml`. Both corpora need the same triple shape (`parent_sha`, `commit_sha`, `story_file_input_path`, `run_id`, `story_key`). Make the pack-upgrade harness/CLI able to consume the census-derived `reconstruction-corpus.yaml` directly (the canonical census output), OR have the census emit a shared-schema corpus both harnesses read. Preferred: ONE corpus file, two consumers. The hand-built fixture remains as a committed fallback but is no longer the default once the census produces ≥ the fixture's pair count.

3. **Verify the census-derived corpus passes the pack-upgrade dry-run.** `node scripts/eval-pack-upgrade.mjs --pack-current packs/bmad --pack-candidate packs/bmad --corpus <census-corpus> --dry-run` must report all pairs `ready`, 0 corpus-errors. Any pair missing `story_file_input_path` (the obs_027 sidecar) or with an unresolvable `parent_sha` is a corpus-error and must be excluded by the census, not silently passed.

4. **Feed Epic 77's reconstruction tier.** The same census output is the corpus the reconstruction harness (`scripts/eval-reconstruction/harness.mjs`, Story 77-8/77-9) has been waiting on (it has been forward-thin / 0 pairs since it was built). Confirm `scripts/eval-reconstruction/harness.mjs --corpus <census-corpus> --dry-run` (or its equivalent) recognizes the pairs. No need to RUN reconstruction grading in this story — just confirm the corpus is shape-compatible so 77-9 is unblocked.

5. **`story_file_input_path` resolution.** The census must populate a usable `story_file_input_path` for each pair. Two sources, in priority order: (a) the obs_027 manifest sidecar `inputs/<run-id>/<story-key>.md` when present; (b) the in-repo story file at `_bmad-output/implementation-artifacts/<story-key>-*.md` recoverable at the parent SHA. The hand-built fixture used path (b) for the 81-x stories — confirm the census does likewise when the sidecar is absent. A pair with NO recoverable story input is excluded (corpus-error), not passed.

6. **Honest provenance + ceiling documentation in the corpus header.** The census-derived corpus YAML carries a provenance block: census date, source repos, per-repo clean-pair counts, the structural-ceiling caveat (F-commitsha forward-only), and the strata-has-commits-but-no-manifests note. Mirror the style of the existing `outcomes-corpus.yaml` provenance header.

7. **A "what grew" re-runnability note.** The census is re-runnable as new auto-commits accumulate. Document (in Dev Notes + the script's `--help`) the cadence: re-run after a batch of substrate-on-substrate dispatches to harvest new pairs. Without `--force` the census writes to a `.candidates.yaml` sibling so a curated corpus is never clobbered (this behavior already exists in 77-6 — confirm it still holds).

8. **No new dispatch, no LLM calls.** This story is pure census + corpus authoring (deterministic git + manifest reads). It does NOT run the pack-upgrade or reconstruction graders against a model. The dry-run validations (AC3, AC4) are read-only.

9. **Unit tests** for any census changes made under AC1 (e.g. a widened commit-subject regex, a story-input-path resolver). Synthetic git-log + manifest fixtures; no real repo reads in the test suite. Existing `scripts/build-reconstruction-corpus.mjs` tests (14 per the 77-6 record) must continue passing.

10. **Ship gate stays GREEN.** `npm run build`, `npm run test:fast`, and `node scripts/eval-outcomes.mjs --threshold 0.95` all GREEN.

11. **Documentation updates.** Update `docs/2026-05-31-epic-81-first-calibration.md` to record that the hand-built fixture is superseded by the census-derived corpus, with the actual harvested pair count, and to note Epic 77's reconstruction tier is now corpus-fed.

## Tasks / Subtasks

- [ ] **Task 1 — Run + audit the existing census** across substrate + ynab; record the real count (AC1)
- [ ] **Task 2 — Fix any census detection gaps** for post-v0.20.118 commits (AC1, AC9)
- [ ] **Task 3 — Resolve story_file_input_path** per pair (sidecar → in-repo fallback) (AC5)
- [ ] **Task 4 — Unify the corpus schema** so pack-upgrade + reconstruction read one file (AC2, AC4)
- [ ] **Task 5 — Dry-run validate** against both harnesses (AC3, AC4)
- [ ] **Task 6 — Provenance + ceiling header** (AC6, AC7)
- [ ] **Task 7 — Unit tests** for census changes (AC9)
- [ ] **Task 8 — Documentation updates** (AC11)
- [ ] **Task 9 — Regression validation** (AC10)

## Dev Notes

### Coordination with Story 81-7 (the paired story)

- **81-7 owns** `scripts/eval-pack-upgrade/grader-lib.mjs` and the diff-scoring / `total_turns` / near-empty-diff work inside `scripts/eval-pack-upgrade/harness.mjs`'s `defaultCaptureEnvelope`.
- **81-8 owns** `scripts/build-reconstruction-corpus.mjs` and the corpus YAML files, plus the `--corpus` plumbing in the CLIs (read path only).
- **Shared file caution**: both stories may touch `scripts/eval-pack-upgrade/harness.mjs`. 81-7 touches `defaultCaptureEnvelope` (capture internals); 81-8 touches only the corpus-loading / `--corpus` default-path logic in `main()`. If dispatched in parallel worktrees, expect a possible merge touch-point in that one file — keep 81-8's change to the corpus-path resolution minimal and localized.
- **Already-landed partial fix**: commit `9cb802a` (`fix(story-81-7)`) already added `extractFilesFromDiff` + `scorePackDiffAgainstGroundTruth` + the `no-measurable-diff` ungradable reason to `grader-lib.mjs`. 81-7's AC2 is therefore partly done; 81-8 does NOT touch that code.

### Why reuse, not reinvent

`scripts/build-reconstruction-corpus.mjs` already encodes the three cleanliness criteria (feat-commit subject, manifest SHA correlation via `per_story_state[key].commit_sha`, parent-SHA resolution) and the pollution guard (`--repos` required, `.candidates.yaml` on no-`--force`). The temptation to write a fresh pack-upgrade-specific census is a trap — it would duplicate the F-commitsha correlation logic that 77-6 already got right (after two failed dispatches). Extend 77-6; don't fork it.

### The fixture corpus to supersede

`_bmad-output/eval-results/corpus/pack-upgrade-fixture-corpus.yaml` (4 pairs: 80-1, 81-1, 81-3, 81-4) was hand-built during the 2026-06-01 calibration. It used the in-repo story-file path (resolution path (b) in AC5) because those stories' obs_027 sidecars weren't all present. It is correct but manual. Once the census produces ≥4 pairs the fixture becomes a committed fallback, not the default. (81-2 was omitted from the fixture — the census should pick it up if its commit carries the SHA.)

### Canonical paths

| Item | Path |
|---|---|
| Census script (reuse/extend) | `scripts/build-reconstruction-corpus.mjs` |
| Canonical census output | `_bmad-output/eval-results/corpus/reconstruction-corpus.yaml` |
| Hand-built fixture (fallback) | `_bmad-output/eval-results/corpus/pack-upgrade-fixture-corpus.yaml` |
| Pack-upgrade CLI (`--corpus` plumbing) | `scripts/eval-pack-upgrade.mjs` |
| Pack-upgrade harness (corpus load in `main()`) | `scripts/eval-pack-upgrade/harness.mjs` |
| Reconstruction harness | `scripts/eval-reconstruction/harness.mjs` |
| F-commitsha field | `per_story_state[key].commit_sha` in `.substrate/runs/<run-id>.json` |
| Consumer repos | `/home/jplanow/code/jplanow/{ynab,boardgame-sandbox,strata}` |

### Testing Requirements

- Framework: **vitest**
- Census changes tested against synthetic git-log + manifest fixtures; no real-repo reads in the suite
- The AC3/AC4 dry-run validations are run manually by the dispatched agent (real repo reads, read-only, no model calls) and the results recorded in completion notes

## Interface Contracts

- **Shared corpus schema**: the census output must carry `id`, `source`/`repo`, `run_id`, `story_key`, `commit_sha`, `parent_sha`, `story_file_input_path`, and `expect.result_class` — the superset both harnesses read. Additive only.
- **No change to substrate's production dispatch or auto-commit path.** This story reads accumulated history; it does not alter how history is written.

## Runtime Probes

Not applicable — deterministic census + corpus authoring with unit-test coverage and manual read-only dry-run validation. No spawned model subprocesses, no external state mutation.

## Dev Agent Record

### Agent Model Used
<to be filled in by dispatched agent>

### Completion Notes List
<to be filled in by dispatched agent>

### File List
<to be filled in by dispatched agent>

## Change Log
