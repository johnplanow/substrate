# Goal prompt — Substrate Hardening Program

Paste everything inside the fence into `/goal` in a Claude Code session opened at `~/code/jplanow/substrate`. Safe for a fresh session — the referenced files carry all state. Re-issue each session until the ledger shows H6 done. (3,072 chars — fits a 4,000-char limit.)

```
GOAL: Execute the Substrate Hardening Program to completion. Repo: ~/code/jplanow/substrate.

STATE + SPEC (read in this order, every session):
1. _planning/substrate-hardening/LEDGER.md — the single source of truth for program state (done / in-progress / blocked).
2. _planning/substrate-hardening/execution-plan.md — work breakdown: epics H0–H6, 27 stories with ACs and anchors, ship batches A–M, session protocol.
3. Only as needed per story: _planning/2026-07-05-substrate-remediation-audit.md (file:line anchors + rationale), _planning/2026-07-05-substrate-bleeding-edge-plan.md (strategy), _planning/2026-07-04-income-sources-field-feedback.md (the 19 findings being fixed).

THE LOOP (repeat until session effort is spent):
1. Orient: read LEDGER.md. Check git status + git log --oneline -3; require clean tree on main and no running vitest. Resume any in-progress story from its ledger notes first.
2. Pick the first todo story in ledger order whose dependencies are done. Mark it in-progress (dated) in the ledger before coding.
3. Implement per its ACs. Anchors were verified at d095d14 and DRIFT — re-locate by symbol name before editing. Write tests with the code; iterate with npm run test:changed / test:fast.
4. At each ship-batch boundary, run the full /ship process: full npm test, build, eval gate 100%, bundled-dist e2e smoke for CLI-surface changes, version bump, tag. One ship per batch; never combine unrelated epics.
5. Record: set the story done in the ledger WITH version and concrete evidence (test names, fixture-run output, manifest fields observed). Ledger edits commit with the code they describe. Append to the ledger Session log.
6. Continue to the next story.

HARD RULES:
- Evidence rule: a story is done ONLY with named empirical evidence in the ledger. Anything touching detection, prompts, verification, commit, or merge needs a run against the Python/uv fixture (before H2.1 exists: a throwaway uv scratch project) — never only unit tests on a Node repo.
- Never run bare `substrate` to test local changes — build, then `npm run substrate:dev -- <args>`.
- Testing per CLAUDE.md: one vitest at a time, timeout 300000, never pipe or background test output, confirm "Test Files" in output.
- No substrate-on-substrate dispatch until ships A+B are done and verified in a real run; after that only [dogfood-eligible] stories, one per run, --max-review-cycles 3.
- Blocked story: write the blocker + handoff detail into the ledger Blockers section, move to the next unblocked story. Stop only when everything left needs operator input — then say so with the blocker list.
- Scope discipline: implement the story's ACs. New problems become new ledger rows, not scope creep.

DONE = every ledger row H0.1–H5.3 done (H5.4 may be dropped with reason) AND the H6 final gate has run: a fully unattended ≥10-story batch with zero hand-lands, zero parent-tree leaks, zero false-completes, written up as a dated field-feedback file and the ledger closed. If H6 fails, its findings become new ledger rows and the goal continues.
```
