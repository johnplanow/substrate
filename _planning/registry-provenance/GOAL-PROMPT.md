# Goal prompt — Registry Provenance Program

Paste everything inside the fence into `/goal` in a Claude Code session opened at `~/code/jplanow/substrate`. Safe for a fresh session — the referenced files carry all state. Re-issue each session until the ledger shows RP6 done.

```
GOAL: Execute the Registry Provenance Program (closing the acceptance gate's upstream blind spot) to completion. Repo: ~/code/jplanow/substrate.

STATE + SPEC (read in this order, every session):
1. _planning/registry-provenance/LEDGER.md — single source of truth for program state.
2. _planning/registry-provenance/execution-plan.md — work breakdown: epics RP0–RP6, ships 1–7, adversarial protocol, verified seams.
3. _planning/2026-07-09-registry-provenance-design-brief.md — the design.
4. Only as needed: _planning/acceptance-gate/retrofit/CORPUS.md (income-sources PRD + reference registry); _planning/acceptance-gate/LEDGER.md (parent-program patterns).

THE LOOP (repeat until session effort is spent):
1. Orient: read LEDGER.md. Require clean tree on main (git status, log -3) and no running vitest (ps aux | grep vitest | grep -v grep). Resume any in-progress story from its ledger notes first.
2. Pick the first todo story in ledger order whose deps are done. Mark it in-progress (dated) in the ledger before coding.
3. Implement per its ACs. Seams named by symbol (verified @ c8cd644) — re-locate before editing. Tests ship with code; iterate with npm run test:changed / test:fast.
4. At each ship boundary run the full /ship process: full npm test, build, eval gate 100%, fixture matrix green (23 existing + new cells), bundled-dist smoke for CLI-surface changes, version bump all 4 package.json + version:sync + lockfile, tag. One ship per batch.
5. Record: story done in the ledger WITH version + concrete evidence (test names, matrix cells, live command output observed, artifact paths). Ledger edits commit with the code. Append to the Session log.
6. Continue.

HARD RULES:
- NEVER AUTO-RATIFY (cardinal rule): no code path writes journeys.yaml from a candidate without an explicit operator ratify action. RP4.2 emits candidates ONLY. A story violating this is not done regardless of tests.
- PRD IS UNTRUSTED INPUT: derive + completeness prompts use the judge's data-not-instructions posture; candidate output schema-forced; injection matrix cells (derive-prd-injection, candidate-ignored-by-gate) are mandatory, not optional.
- ALL new escalations stay ADVISORY the entire program (provenance-absent, registry-stale, journey-undispositioned, candidate-unratified). This arc adds zero blocking behavior.
- Evidence rule: done ONLY with named empirical evidence in the ledger. Derive, ratify, checker, and staleness stories need a matrix cell or live corpus run — unit tests alone are insufficient.
- Retro-fit integrity: iterating derive/checker prompts to hit targets is legal; editing the PRD or registry corpus to dodge findings is training-on-the-test and is not.
- Gate ignores candidates: journeys.candidate.yaml must produce zero acceptance behavior on every loader/audit/stage path — pinned by test from Ship 2 onward.
- ADVERSARIAL PHASES ARE NOT SKIPPABLE: RP5.1 red-team (attempt the plan's 10-item evasion catalog + invent more; CONFIRMED → new ledger rows or dated accepted-risk entries) and RP5.2 evader-agent (goal: get a vision-dropping registry past the machinery) gate everything after Ship 6. RP5.3: ASK the operator to run /code-review ultra on the arc — you cannot launch it and must never fabricate its artifact; record findings.
- Never run bare `substrate` for local changes — build, then npm run substrate:dev. Testing per CLAUDE.md: one vitest, timeout 300000, never pipe/background test output, confirm "Test Files".
- No substrate-on-substrate dispatch until Ship 3 is verified; after that only [dogfood-eligible] stories, one per run, --max-review-cycles 3.
- Blocked story: write blocker + handoff into the ledger, move on. Stop only when everything left needs operator input — say so with the list.
- Scope discipline: implement the story's ACs. New problems become new ledger rows, not scope creep.

DONE = every row RP0.1–RP5.2 done (drops need reasons) AND the RP5.1/RP5.3 review artifacts exist with findings resolved-or-filed AND the RP6 gate has PASSED, all five legs live at HEAD: (1) derive @ income-sources PRD surfaces all 5 founding journeys unhinted vs the reference registry; (2) planted UJ-2 omission → journey-undispositioned citing the PRD span; (3) planted PRD mutation → registry-stale + diff view isolating the change; (4) 0-noise floor on the post-fix corpus; (5) one live fixture pipeline run producing a candidate end-to-end — plus suite + eval + matrix + docs-match-behavior green, written up as a dated results doc, ledger closed. If RP6 fails, findings become new rows and the goal continues.
```
