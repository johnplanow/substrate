# Goal prompt — Acceptance Gate Program

Paste everything inside the fence into `/goal` in a Claude Code session opened at `~/code/jplanow/substrate`. Safe for a fresh session — the referenced files carry all state. Re-issue each session until the ledger shows A7 done. (3,998 chars — fits a 4,000-char limit.)

```
GOAL: Execute the Acceptance Gate Program (the missing sprint demo) to completion. Repo: ~/code/jplanow/substrate.

STATE + SPEC (read in this order, every session):
1. _planning/acceptance-gate/LEDGER.md — single source of truth for program state.
2. _planning/acceptance-gate/execution-plan.md — work breakdown: epics A0–A7, 21 stories with ACs and seams, ships 1–10, adversarial protocol.
3. _planning/2026-07-07-acceptance-gate-design-brief.md — the design (rev 2).
4. Only as needed: _planning/2026-07-04-income-sources-field-feedback.md; _planning/substrate-hardening/LEDGER.md (prior-art patterns).

THE LOOP (repeat until session effort is spent):
1. Orient: read LEDGER.md. Require clean tree on main (git status, log -3) and no running vitest (ps aux | grep vitest | grep -v grep). Resume any in-progress story from its ledger notes first.
2. Pick the first todo story in ledger order whose deps are done. Mark it in-progress (dated) in the ledger before coding.
3. Implement per its ACs. Seams named by symbol (verified @ b776555) — re-locate before editing. Tests ship with code; iterate with npm run test:changed / test:fast.
4. At each ship boundary run the full /ship process: full npm test, build, eval gate 100%, fixture matrix green (old + new cells), bundled-dist smoke for CLI-surface changes, version bump, tag. One ship per batch.
5. Record: story done in the ledger WITH version + concrete evidence (test names, matrix cells, artifact paths, verdict output observed). Ledger edits commit with the code. Append to the Session log.
6. Continue.

HARD RULES:
- Evidence rule: done ONLY with named empirical evidence in the ledger. Anything touching render, judge, coverage, or finalization needs a matrix cell or live fixture run — unit tests alone are insufficient.
- ADVISORY-UNTIL-PROVEN: acceptance.mode defaults to advisory (pinned by test) until A3.2 retro-fit passes (5/5 pre-fix detections on income-sources, 0 post-fix false FAILs) AND one live real-agent run is green. Stub-green is not release confidence (v0.21.1).
- Trusted-tree rule (H7): registry, contract, end-states are read from the main tree at dispatch snapshot, never the worktree copy. Every new judge/gate input must obey this; the judge NEVER sees the story diff or implementer framing.
- ADVERSARIAL PHASES ARE NOT SKIPPABLE: A5.1 red-team (attempt the plan's 12-item evasion catalog + invent more; CONFIRMED → new ledger rows or dated accepted-risk entries) and A5.2 evader-agent cells gate everything after Ship 8. A5.3: ASK the operator to run /code-review ultra on the arc — you cannot launch it; record findings.
- Retro-fit integrity: iterating the judge prompt to reach 5/5 is legal; editing end-states to target known bugs is training-on-the-test and is not.
- Never run bare `substrate` for local changes — build, then npm run substrate:dev. Testing per CLAUDE.md: one vitest, timeout 300000, never pipe/background test output, confirm "Test Files".
- No substrate-on-substrate dispatch until Ship 5 is verified; after that only [dogfood-eligible] stories, one per run, --max-review-cycles 3.
- Blocked story: write blocker + handoff into the ledger, move on. Stop only when everything left needs operator input — say so with the list.
- Scope discipline: implement the story's ACs. New problems become new ledger rows, not scope creep.

DONE = every row A0.1–A6.2 done (drops need reasons) AND the A5.1/A5.3 review artifacts exist with findings resolved-or-filed AND the A7 gate has PASSED: a live unattended REAL-agent run on a journeys-bearing fixture where the planted never-wired critical journey is caught (UNREACHABLE, blocked, branch durable), the clean critical journey lands walked-pass on a review branch with a <1-minute-verifiable artifact, zero false FAILs, coverage ledger exact, suite + eval + matrix + docs-match-behavior green — written up as a dated field-feedback file, ledger closed. If A7 fails, findings become new rows and the goal continues.
```
