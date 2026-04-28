# Probe-Author Validation Protocol

**Version**: v1 (2026-04-27)
**Substrate version**: v0.20.36 (Sprint 18 / Story 60-14)
**Status**: methodology defined; first eval run pending

## Purpose

This doc defines the procedure for running the probe-author A/B
validation harness and interpreting its output. The output is the
empirical Phase 2 go/no-go decision: should substrate continue investing
in probe-author phase decoupling (60-15 telemetry, 60-16 missing-trigger
heuristic flip), iterate on the prompt, or abort Phase 2?

## Methodology

### Inputs

1. **Defect-replay corpus** (`probe-author-defect-corpus.md`): N
   historically-shipped defects with `expected_probe_signature` predicates
2. **probe-author prompt** (`packs/bmad/prompts/probe-author.md`): the
   prompt under test
3. **Substrate version**: must include the probe-author phase wiring
   (v0.20.34+) and the feature flag (v0.20.36+ / Story 60-14a)

### Procedure

1. **Pre-flight**: ensure `substrate --version` ≥ v0.20.36 and
   `SUBSTRATE_PROBE_AUTHOR_ENABLED=true` (or default).
2. **Run eval**: `node scripts/eval-probe-author.mjs --corpus
   _bmad-output/planning-artifacts/probe-author-defect-corpus.md
   --output report.json`
3. **Wait**: real LLM dispatches; ~5 min × N corpus entries (~30 min
   for current 4-entry corpus). Cost: $0.10-0.30 per entry.
4. **Inspect report.json**: structured output with per-entry
   `caught: bool`, `authoredProbes: [...]`, and overall `catchRate`.
5. **Make decision** per the rubric below. Append decision to the
   "Decision history" section of this doc, signed off with date +
   author + substrate version + report path.

### Rubric

| Catch rate | Decision | Action |
|---|---|---|
| ≥ 50% | **GREEN** | Phase 2 continues. Ship 60-15 (telemetry events) and 60-16 (flip 60-11 missing-trigger heuristic warn → error per 60-15's calibration). |
| 30-50% | **YELLOW** | Phase 2 paused for prompt iteration. Update probe-author.md prompt; re-run eval. If two consecutive runs stay in YELLOW band, treat as RED. |
| < 30% | **RED** | Phase 2 ABORTED. 60-15 and 60-16 NOT built. Substrate considers Phase 3 alternatives in a follow-up epic (adversarial probe-reviewer agent, AC-derived deterministic probe stubs, etc.). |

### Edge cases

- **Probe-author dispatch fails for an entry**: counted as "missed" for
  that entry. Reduces denominator only when ALL entries fail (then
  abort and investigate substrate before re-running).
- **Probe-author returns empty probe set**: counted as "missed" (the
  authored set has no probes that could match the signature).
- **Multiple probes match the signature**: counted as "caught" (one
  match suffices).
- **Corpus is < 3 entries**: catch rate has too much variance — re-run
  3x and average.

## Decision history

### Run #1 — 2026-04-28 — Sprint 20 close-out

| Field | Value |
|---|---|
| Run date | 2026-04-28 |
| Substrate version | v0.20.38 (Sprint 20) |
| Corpus version | v1 (4 applicable entries, 1 excluded) |
| Catch rate | **100% (4/4)** |
| Decision | **GREEN — Phase 2 continues** |
| Decided by | substrate session (Sprint 20 close-out) |
| Report path | `eval-probe-author-final-2026-04-28.json` (saved to `_bmad-output/planning-artifacts/eval-runs/`) |
| Aggregate cost | 12,986 input + 3,568 output tokens (~$0.06 at Claude Sonnet 4.6 rates) |
| Aggregate wall-clock | 8 min |

**Per-entry outcomes (all caught):**

| Entry | Story | Matching probe |
|---|---|---|
| entry-1-obs_011-tool-count | `1-10` | `tools-list-all-four-named-tools` |
| entry-2-obs_012-error-envelope | `1-10b` | `semantic-search-returns-required-fields` |
| entry-3-obs_014-production-trigger | `1-12` | `hook-fires-on-git-merge-and-resolves-conflicts` |
| entry-4-synthetic-systemd-trigger | `synthetic-1` | `timer-fires-service-via-production-trigger` |

**Rationale:** First eval run produced unanimous catch (100%). Probe-author (re-enabled in v0.20.38 after Sprint 20's stack-of-bug-fixes — see decision footnote) authored probes that exercise production triggers and check success-shape across all four defect classes in the corpus. Phase 2 is sanctioned to proceed with Stories 60-15 (telemetry events) and 60-16 (heuristic flip). The corpus is small (n=4) so these results have wide confidence intervals — recommend re-running at corpus expansion (entries from each post-Sprint-17 strata observation that surfaces a probe-author-relevant bug).

**Decision footnote — Sprint 20 stack-of-bugs:**

The first attempt at this eval surfaced FOUR latent bugs that had been silently breaking probe-author since Sprint 13 (v0.20.31, 2026-04-27):

1. **Manifest registration missing** — `packs/bmad/manifest.yaml` never registered `probe-author` as a task type, so `pack.getPrompt('probe-author')` threw, runProbeAuthor returned `template_load_failed`, and the orchestrator silently fell through to dev-authored probes. EVERY substrate run since Sprint 13 has had probe-author silently disabled.
2. **Prompt-schema mismatch** — `probe-author.md` taught a bare-list YAML output shape (`- name: ...`) but `ProbeAuthorResultSchema` required an envelope (`{result, probes: [...]}`). Even with the manifest fix, every dispatch would have failed YAML schema validation through all 4 normalizer strategies.
3. **Dispatcher logger defaults to console-stdout** — `DispatcherImpl(logger = console)` writes "Agent dispatched" / "Agent completed" debug lines to stdout, polluting any CLI subcommand whose stdout is reserved for structured output.
4. **Corpus regex over-escaped** — YAML single-quoted strings preserve backslashes literally, so `'\\s+'` becomes the regex `/\\s+/` (literal backslash-s) not `/\s+/` (whitespace). All four corpus signatures had this bug.

All four were repaired in Sprint 20 (commits TBD). The eval result above is from a re-run after all repairs landed. The eval harness PAID OFF by surfacing the bugs it was designed to test against — even before producing the catch-rate measurement, it produced the critical finding that probe-author had been silently disabled in production for ~3 weeks.

**Implications for Sprint 13-18 retrospective:**

- Strata Run 13's Story 1-12 ship-as-VERIFICATION_FAILED (obs_014) was caught by **Sprint 12C's create-story prompt guidance (60-10)**, NOT by probe-author. Probe-author wasn't actually running.
- Strata Run 12's MCP error-envelope catch (obs_012, REOPENED) was caught by **Sprint 16's executor enforcement (63-2)**, NOT by probe-author's prompt guidance (60-12). Probe-author wasn't actually running.
- The Sprint 19 architecture doc's "Layer 1: pre-emit prompt guidance" cataloging probe-author.md (Story 60-12) was technically accurate but its INSTANCES were latent — not exercised in production until Sprint 20.

(Append additional runs below as they happen.)

## Out-of-scope follow-ups

If the first eval run lands GREEN and Phase 2 ships 60-15/60-16, the
following are candidate next-sprint items but NOT gated on this
protocol:

1. **Corpus expansion**: add new defects from each post-Sprint-17 strata
   dispatch where probe-author misses something the smoke pass catches.
2. **Per-entry signature refinement**: tighten predicates that allow
   too-easy "matches" (false positives in the catch metric).
3. **Cross-project corpus entries**: when substrate validates against
   ynab, board-game-sandbox, NextGen ticketing, add their defects too.

## Versioning

- `v1` (2026-04-27): initial protocol drafted alongside Story 60-14.
  Pending first eval run.
