# Goal prompt — Substrate Hardening Program

Paste everything inside the fence into `/goal` in a Claude Code session opened at `~/code/jplanow/substrate`. It is safe to run in a fresh session with no other context: the referenced files carry all state. Re-issue the same prompt in each new session until the ledger shows H6 done.

```
GOAL: Execute the Substrate Hardening Program to completion. Resolve ~ to the home dir; repo is ~/code/jplanow/substrate.

STATE + SPEC (read in this order, always):
1. ~/code/jplanow/substrate/_planning/substrate-hardening/LEDGER.md — current program state. The ledger is the single source of truth for what is done, in progress, and blocked.
2. ~/code/jplanow/substrate/_planning/substrate-hardening/execution-plan.md — the work breakdown: epics H0–H6, story ACs, ship batches, session protocol. Follow it.
3. Only as needed for a story you're implementing: _planning/2026-07-05-substrate-remediation-audit.md (file:line anchors + rationale), _planning/2026-07-05-substrate-bleeding-edge-plan.md (strategy), _planning/2026-07-04-income-sources-field-feedback.md (the 19 findings being fixed).

THE LOOP (repeat until session effort is spent):
1. Orient: read LEDGER.md. git status / git log --oneline -3. Require clean tree on main and pgrep -f vitest empty before starting; if a prior session left an in-progress story, resume it from its ledger notes.
2. Pick the first story in ledger order with status todo whose dependencies (execution-plan dependency graph + ship ordering) are done. Mark it in-progress (dated) in the ledger.
3. Implement per its ACs. Anchors were verified at d095d14 and DRIFT — re-locate by symbol name before editing. Write tests with the code. Iterate with npm run test:changed / test:fast.
4. At each ship-batch boundary (ships A..M group the stories — see plan): run the full /ship process (full npm test, build, eval gate 100%, bundled-dist e2e smoke for CLI-surface changes, version bump, tag push). One ship per batch; never combine unrelated epics into one ship.
5. Record: set the story done in the ledger WITH version and concrete evidence (test names, fixture-run output, manifest fields observed). Ledger edits commit together with the code they describe. Append a line to the ledger Session log.
6. Continue to the next story.

HARD RULES (non-negotiable):
- Evidence rule: a story is done ONLY with named empirical evidence in the ledger. For anything touching detection, prompts, verification, commit, or merge: evidence must include a run against the Python/uv fixture (or, before H2.1 exists, a throwaway uv scratch project) — never only unit tests on a Node repo.
- Never run bare `substrate` to test local changes — build then `npm run substrate:dev -- <args>`.
- Testing per CLAUDE.md: one vitest at a time, timeout 300000, never pipe test output, never background tests, confirm "Test Files" in output.
- Do NOT dispatch substrate-on-substrate until ships A+B are done and verified in a real run; after that, only stories the plan marks [dogfood-eligible], one story per run, --max-review-cycles 3.
- If blocked on a story: write the blocker + everything the next session needs into the ledger Blockers section, then move to the next unblocked story. Only stop entirely when every remaining story is blocked on input only the operator can provide — say so explicitly with the list of blockers.
- Scope discipline: implement what the story's ACs say. New problems discovered along the way become new ledger rows (with a note), not scope creep in the current story.

DEFINITION OF DONE for this goal: every ledger row H0.1–H5.3 is done (H5.4 may be dropped with reason), AND H6's final gate has been run — a fully unattended ≥10-story batch with zero hand-lands / zero parent-tree leaks / zero false-completes — with its outcome written up as a dated field-feedback file and the ledger closed out. If H6 fails, its findings become new ledger rows and the goal continues.
```
