# A7 Final Gate — field feedback (2026-07-08)

*The Acceptance Gate program's capstone: a fully unattended, REAL-agent run
(`--halt-on none --non-interactive`, blocking mode) on a journeys-bearing
fixture with a planted never-wired critical journey and a clean critical
journey. Dogfood at v0.21.11.*

## Setup

Fixture: `consumer-python-uv` greeter, `substrate init`ed, with a committed
journey registry + acceptance contract + a 6-story epic, `acceptance.mode:
blocking`, `critical_pass_finalization: branch`.

- **UJ-GREET** (clean critical, `cli` surface, render `render_greet.py` → the
  existing `greet("world")` = "Hello, world!").
- **UJ-DECIDE** (planted never-wired critical, `file` surface, render
  `render_decide.py` → the farewell message only). Its end-state needs a
  yes/no/defer decision affordance. Story 1-1's ACs build the `farewell`
  *message* and claim UJ-DECIDE — but no story is ever asked to wire the
  decision affordance. This is the income-sources UJ-2 shape reproduced
  deliberately: a story advances a journey's content while its operator-facing
  affordance stays unwired.
- Stories 1-3…1-6: ordinary untagged library additions (filler to reach ≥6).

Run: `substrate run --stories 1-1..1-6 --non-interactive --halt-on none`,
real claude agent, unattended, ~16 min wall-clock.

## Result — PASS (all A7 conditions met)

| A7 requirement | Outcome |
|---|---|
| Never-wired journey caught: **UNREACHABLE → blocked/branch-preserved** | ✅ 1-1 (UJ-DECIDE) verdict **UNREACHABLE** (judge grounded on `file/decide.txt` = "Goodbye, world!", no decision affordance); story ESCALATED `acceptance-fail`; branch `substrate/story-1-1` durable, NOT merged. |
| Clean critical: **walked-pass → deliverable branch awaiting human merge**, <1-min artifact | ✅ UJ-GREET walked-pass (claimed by 1-2 + 1-5); both finalized `mode:branch` (not merged); verdict HTML renders both journeys + the "never wired" flag, read in seconds. |
| **Zero false FAILs** | ✅ UJ-GREET PASS; filler stories 1-3/1-4/1-6 merged normally (`mode:merge`); the ONLY block was the genuinely-never-wired UJ-DECIDE. |
| **Coverage ledger exact** | ✅ final sweep: `walked-pass:1, walked-fail:1, deferred:0, unclaimed:0, unwalked:0`. |
| Correctly attributed in report + notifications | ✅ `substrate report`: "Acceptance — journey coverage" shows ✓UJ-GREET walked-pass, ✗UJ-DECIDE walked-fail (UJ-DECIDE.a UNREACHABLE — file/decide.txt), + verdict artifact path. |
| suite + eval + matrix + docs-match-behavior green | ✅ at this HEAD (v0.21.11): full suite 583 files / 11,434; matrix 23/23; eval 100%; docs-match-behavior in-suite. |
| A3.2 retro-fit green at current HEAD | ✅ re-run at HEAD: detection 5/5, post-fix 0 false FAILs, precision 1/1 (see `retrofit-a7` run). |

**Story finalization map:** 1-1 → escalated (acceptance-fail, branch);
1-2 → branch (UJ-GREET walked-pass, human-held); 1-3 → merge; 1-4 → merge;
1-5 → branch (UJ-GREET walked-pass); 1-6 → merge.

## What this proves

The full loop — registry → create-story tags → contract render (real product
path) → separate-lineage judge → per-end-state verdict → verdict×tier
finalization → coverage ledger — works end-to-end, unattended, with a REAL
agent, and does the one thing the program exists to do: **it caught a journey
the build was supposed to deliver but never wired, at the merge choke point,
and let everything genuinely-correct through untouched.** The never-wired
journey produced the UNREACHABLE verdict the design invented for exactly this
case. Zero false positives on five other stories.

Emergent detail worth noting: create-story tagged UJ-GREET onto BOTH 1-2 and
1-5 (both touch `greet`), and the coverage ledger correctly recorded joint
ownership — the tag-recall-need-not-be-perfect design (A0) held: over-claiming
is harmless, and the invariant is exact regardless.

## Operator decision (the A7 exit)

Per ADVISORY-UNTIL-PROVEN, the two release-confidence conditions are now met:
the A3.2 retro-fit passes (5/5, 0 false FAILs) AND live real-agent runs are
green (Ship 6 full-cycle + this A7 gate). The remaining program obligation is
**A5.3** (operator `/code-review ultra`, PR #9). The default `acceptance.mode`
stays `advisory` (pinned by test); flipping the default to `blocking` for the
critical tier is the operator's call and is **gated on the A6 canary program
running against a real project** (red-team F1's structural close) — recommend
holding the default at advisory until a consumer project has canaries wired,
then flipping per-project via config, not globally.

## Follow-ups (filed, not blocking DONE)
- A5.3 ultra review (PR #9, operator).
- A5.4 no-worktree snapshot compare (red-team F3 full close).
- GC.1 grounding-contract check class (operator brief addendum).
