# Retro-fit Phase A results — snapshot-judged misses (A3.2, 2026-07-08)

*Real claude judge (`substrate acceptance judge`, bundled dist v0.21.8-pre), judging the
income-sources review's own golden render artifacts extracted at the pinned SHAs
(`git show` from `~/code/jplanow/income-sources`, read-only). End-states authored from
PRD §2.3 verbatim citations (`retrofit/journeys.yaml`) — ZERO judge-prompt iterations
were needed; the shipped `acceptance-judge.md` prompt produced the correct matrix on the
first attempt of every run.*

## Verdict matrix

| End-state (PRD citation) | pre-fix `a6ff1ca` | post-fix `82f4fe7` (v2) | Detects |
|---|---|---|---|
| UJ-2.a — dossier opener: thesis + fit score + act-by + default | **FAIL** (fit score absent from `packet-weekly.html`) | PASS | **Miss 2** (7-of-13 conviction fields) ✓ |
| UJ-2.b — Yes/No/Defer taps per Dossier | PASS (taps present — D3 was fixed pre-review at `689b83e`) | PASS | correctly NOT flagged — no false positive on the already-fixed miss |
| UJ-2.c — Grade 1–5 affordance for decided Dossiers | **FAIL** | PASS | **Miss 3** (grade loop unreachable) ✓ |
| UJ-3.a — Pre-Claim: one-paragraph summary + fit score | **FAIL** (286-byte stub) | PASS | **Miss 4** (Pre-Claim inert) ✓ |
| UJ-3.b — Hold-for-Sunday / Release taps | **FAIL** | PASS | **Miss 4** ✓ |

**Score: 3/3 snapshot-detectable misses DETECTED at the pre-fix pin; 5/5 end-states PASS
at the post-fix pin — ZERO false FAILs.** Raw verdict JSON (with evidence citations) in
the session scratchpad (`retrofit/uj{2,3}-{pre,post}.json`); every verdict carried an
artifact + excerpt citation as the schema mandates.

## What Phase A proves

- The rendered-artifact judge detects the never-wired class on REAL artifacts from a REAL
  production project with PRD-derived end-states — no bug-aware tuning (integrity rule held:
  every end-state cites its PRD sentence).
- The judge correctly does NOT flag the miss that was already fixed at the pin (UJ-2.b) —
  precision evidence, not just recall.
- The shipped judge prompt needed no iteration.

## Phase B — the two live-render misses (REMAINING before A3.2 is DONE)

- **Miss 1 (UJ-2 taps)**: pre-fix pin is `ef1c0c8` (before D3), which PREDATES the review's
  snapshots — needs a live `machine packet compose` render in a scratch clone with a seeded
  ledger. Expected: UJ-2.b UNREACHABLE at `ef1c0c8`.
- **Miss 5 (UJ-4 absence, both halves)**: no snapshot at either pin covers absence/return-summary
  — needs a seeded declared-absence scenario composed at `a6ff1ca` (Packet sends during absence →
  UJ-4.a FAIL) vs `82f4fe7` (suppressed + return summary → PASS).
- Both need: scratch clone at pin, `uv sync`, migrated scratch ledger, seeded signals/absence
  rows, compose invoked with mail transport stubbed/dry. The review produced its artifacts the
  same way — check the review commit for its render harness before building one.

**A3.2 remains in-progress until Phase B lands 5/5. The blocking default stays advisory.**
