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

### Run #1 — pending

| Field | Value |
|---|---|
| Run date | _to be filled at first eval_ |
| Substrate version | v0.20.36+ (Sprint 18) |
| Corpus version | v1 (4 applicable entries) |
| Catch rate | _to be computed_ |
| Decision | _GREEN / YELLOW / RED_ |
| Decided by | _author_ |
| Report path | _eval-probe-author-<timestamp>.json_ |
| Rationale | _free-form notes on confidence, edge cases, follow-up_ |

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
