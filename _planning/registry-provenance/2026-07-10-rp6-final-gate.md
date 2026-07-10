# RP6 — FINAL GATE (2026-07-10): Registry Provenance program close

*Terminal quality gate for the registry-provenance arc (v0.21.13→v0.21.19).
Counterexample-first, per the design brief DoD. Closed with RP5.3 (the
independent `/code-review ultra` pass) **waived by operator decision** — see
the residual-risk note below.*

## The five DoD legs — all GREEN at HEAD (code SHA v0.21.19)

| Leg | Requirement | Evidence | Verdict |
|---|---|---|---|
| 1 | `derive` @ income-sources PRD surfaces the founding journeys UNHINTED vs the reference registry | Live derive (no registry present) → 7 journeys; **3/3 reference founding journeys recovered (UJ-2 correctly critical) + the 4 journeys the hand-authored registry had dropped**. `retrofit/2026-07-10-rp6-prep-derive-recall.md` | ✅ |
| 2 | planted UJ-2 omission → `journey-undispositioned` citing the PRD span | RP3.3 harness leg 2, real dispatch — deleted UJ-2 → Sunday-Packet journey flagged, §2.3 span cited. `retrofit/2026-07-09-rp3-corpus-results.md` + `scripts/registry-provenance-retrofit/run.mjs` | ✅ |
| 3 | planted PRD mutation → `registry-stale` + diff isolating the change | Ship 3/4 live smokes — PRD mutated post-ratify → `registry-stale` advisory with both hashes; re-derive diff showed `+ UJ-3` / `~ UJ-1,UJ-2` | ✅ |
| 4 | 0-noise floor on the post-fix corpus | RP3.3 harness leg 1, real dispatch — 3/3 registered mapped, undispositioned findings none-overlapping the registered set | ✅ |
| 5 | live fixture pipeline run producing a candidate end-to-end | Ship 6 DoD — wordbank fixture, analysis→planning→ux→solutioning (real dispatches) → 4-journey candidate at solutioning close; `journeys.yaml` absent (NEVER-AUTO-RATIFY) | ✅ |

## Gate suite (at the terminal code SHA; only version-bump + docs commits followed)

- Full `npm test`: **588 files / 11,501 tests** green
- Fixture matrix: **25/25** (incl. `candidate-ignored-by-gate`, `registry-stale`)
- Eval regression: **100% (35/35)**, threshold 95%
- RP3.3 completeness corpus harness: **GREEN** (floor + planted omission)
- `check:circular` + `typecheck:gate` + `docs-match-behavior`: green

## Cardinal invariants (held under the RP5.1 red-team's direct tracing)

NEVER-AUTO-RATIFY · gate-ignores-candidates · PRD-is-untrusted-input ·
all-new-escalations-advisory · staleness-containment · spec-tamper-covers-
provenance · diff-cannot-be-blinded. All 7 traced and held; the 4 exploitable
gaps the red-team found (F1 arbitrary read, F2 disposition-launder, F3 diff
set-subset, F4 loose grounding) were remediated in Ship 7 (v0.21.19).

## RP5.3 — WAIVED by operator (2026-07-10)

The independent `/code-review ultra` second pass was **explicitly waived by
the operator** ("we're going to nix the ultra review"). A draft review-only
PR (#10, scoped to the 22 RP commits) was prepared and then closed+deleted at
operator request.

**Residual risk, recorded honestly:** the program's own precedent (v0.21.0;
the acceptance-gate program) is that an independent ultra pass finds real
defects the red-team and gate both miss — and this arc's own red-team proved
it in the other direction (RP5.1 found F1, an arbitrary-file-read at ratify,
that no test or gate caught). Waiving ultra therefore leaves *that class* of
finding — a defect visible only to a fresh independent reviewer — uncaught for
this arc. The adversarial coverage that DID run: a separate-lineage red-team
(10-item catalog + invent-more, 5 findings, 4 remediated + 1 accepted-risk), a
live hostile-PRD evader smoke (injection fully ignored), and the
`candidate-ignored-by-gate` matrix cell. This is the operator's accepted risk;
the ultra pass can be run later against the same scope (`v0.21.12..HEAD`)
without disturbing shipped code.

## Verdict

**RP6 PASSED.** All five counterexample-first legs green, gate suite green,
cardinal invariants held, red-team findings resolved-or-filed. With RP5.3
waived by operator decision, the **Registry Provenance program is COMPLETE**
(v0.21.13→v0.21.19, 7 ships).
