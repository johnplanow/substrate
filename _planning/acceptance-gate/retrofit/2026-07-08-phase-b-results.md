# Retro-fit Phase B results — A3.2 COMPLETE: 5/5 (2026-07-08)

*Live seeded renders via `phase-b-render.py` (run in-clone at each pin: `LEDGER_PATH`
scratch DB, auto-migrations, schema-valid seeded dossier surviving `parse_dossier_row`,
`machine.mailer.stub` capture — the REAL compose path, no mocks on the render side).
Judged with the REAL claude judge (`substrate acceptance judge`, dist). The review's own
harness was never committed (confirmed) — this driver reconstructs its method statement.*

## Final A3.2 scoreboard (Phases A+B)

| Miss | Pin | End-state | Verdict | Source |
|---|---|---|---|---|
| 1 — UJ-2 taps never minted | `ef1c0c8` | UJ-2.b | **UNREACHABLE** ✓ (the never-wired verdict, exactly as designed) | live render |
| 2 — conviction fields withheld | `a6ff1ca` | UJ-2.a | **FAIL** ✓ | snapshot |
| 3 — grade loop unreachable | `a6ff1ca` | UJ-2.c | **FAIL** ✓ | snapshot |
| 4 — Pre-Claim inert | `a6ff1ca` | UJ-3.a + UJ-3.b | **FAIL + FAIL** ✓ | snapshot |
| 5 — absence half-wired (both halves) | `a6ff1ca` | UJ-4.a + UJ-4.b | **FAIL + FAIL** ✓ | live seeded renders |
| post-fix false-FAIL check | `82f4fe7` | ALL NINE end-states (UJ-2 ×3, UJ-3 ×2, UJ-4 ×2 + snapshots) | **PASS** — zero false FAILs ✓ | both |
| precision check | `a6ff1ca` | UJ-2.b (taps ALREADY fixed at this pin) | **PASS** — correctly not flagged ✓ | snapshot |

**DETECTION 5/5 · FALSE FAILS 0 · PROMPT ITERATIONS 0** (the shipped `acceptance-judge.md`
produced every verdict above on its first attempt).

## Phase B live-render evidence details

- **Miss 1**: at `ef1c0c8` the seeded compose produced a real Packet email (thesis, act-by,
  default action, P&L) with NO decision affordances and NO fit score — judge: UJ-2.a FAIL,
  UJ-2.b UNREACHABLE, UJ-2.c UNREACHABLE.
- **Miss 5a**: with a declared absence covering the compose date, `a6ff1ca` compose
  **produced and "sent" an email anyway** (1 captured); `82f4fe7` produced **zero** (packets
  row `suppressed-absence`). Judge: UJ-4.a FAIL pre / PASS post.
- **Miss 5b**: with an ENDED absence + undispatched `auto_release_log` rows, the `a6ff1ca`
  post-absence Packet contained **no return section** (0 released/return mentions);
  `82f4fe7`'s opened with it. Judge: UJ-4.b FAIL pre / PASS post.
- Driver notes for reuse: `auto_release_log` is lazily created by
  `machine.flags.auto_release._ensure_log_table` (not a migration); `--stub` mail capture
  is in-process (`stub.sent`); `conservative_pl.comparables` must be strings;
  `ACTION_LINK_SIGNING_KEY`/`ACTION_BASE_URL` set for post-fix link minting.

## What A3.2 establishes

The acceptance gate detects **all five** founding misses of its design brief on the real
project that motivated it, with end-states authored from PRD language alone, and produces
zero false positives on the fixed product. Per ADVISORY-UNTIL-PROVEN, the retro-fit
condition for the blocking default is now met (the live real-agent pipeline run condition
was met at Ship 6); the remaining condition is **the A5 adversarial phases**.

A3.3 next: encode these runs as eval-framework regression entries so any future judge-prompt
change must re-prove 5/5 + 0-false-FAILs.
