# Registry Provenance Program — LEDGER

Single source of truth for program state. Read first every session; update with every ship (ledger edits commit with the code).

**Design brief:** `_planning/2026-07-09-registry-provenance-design-brief.md`
**Work breakdown:** `_planning/registry-provenance/execution-plan.md`
**Parent program (machinery this extends):** `_planning/acceptance-gate/` (DONE, v0.21.2–v0.21.12)
**Baseline:** HEAD `c8cd644`, v0.21.12, suite 583 files / 11,436 tests, matrix 23/23, eval 100%.

## Story board

| Row | Story | Ship | Status | Version | Evidence / notes |
|---|---|---|---|---|---|
| RP0.1 | Provenance block on registry schema (additive; compat-pinned) | 1 | todo | | |
| RP0.2 | `validate` provenance surfacing + `provenance-absent` advisory | 1 | todo | | |
| RP1.1 | `substrate acceptance derive` (agent workflow + prompt + candidate; gate ignores candidates) | 2 | todo | | |
| RP1.2 | `substrate acceptance ratify` (human-only; provenance written; candidate deleted; version bump) | 3 | todo | | |
| RP1.3 | Diff-view re-derivation (`diffRegistries` + delta output) | 3 | todo | | |
| RP2.1 | Staleness detection (`registry-stale` / `registry-source-missing`; path containment; matrix cell) | 4 | todo | | |
| RP3.1 | Deterministic completeness pre-pass (set arithmetic, no agent) | 5 | todo | | |
| RP3.2 | Completeness checker agent + `validate --against-prd` (span-cited, advisory) | 5 | todo | | |
| RP3.3 | Corpus precision: 0-noise floor + planted-omission counterexample + regression harness | 5 | todo | | |
| RP4.1 | Structured `user_journeys` emission (ux-step-3 schema upgrade, prose fallback) | 6 | todo | | |
| RP4.2 | Solutioning-close derive hook (candidate only — NEVER auto-ratify) + pre-pass wiring | 6 | todo | | |
| RP5.1 | Red-team (10-item evasion catalog minimum, separate lineage) | 7 | todo | | |
| RP5.2 | Adversarial e2e evader agent + injection matrix cells | 7 | todo | | |
| RP5.3 | Operator-run `/code-review ultra` on the arc; findings triaged | — | todo | | Operator action — ASK, never launch or fabricate |
| RP6 | FINAL GATE: 5-leg counterexample-first DoD (derive retro-fit unhinted 5/5, planted omission, planted staleness, 0-noise floor, live pipeline run) | — | todo | | |

## Cardinal rules (program-level; violations = story not done)
1. **NEVER AUTO-RATIFY** — no code path writes `journeys.yaml` from a candidate without explicit operator action.
2. **PRD is untrusted input** — data-not-instructions posture in derive/checker prompts; injection cells mandatory.
3. **All new escalations advisory** for the entire program (`provenance-absent`, `registry-stale`, `journey-undispositioned`, `candidate-unratified`).
4. **Evidence rule** — derive/ratify/checker/staleness stories need a matrix cell or live corpus run, not just unit tests.
5. **Retro-fit integrity** — iterating derive/checker prompts to hit targets is legal; editing the PRD/registry corpus to dodge findings is training-on-the-test and is not.

## Dependency notes
- Ship order 1→7 default. RP4 may land any time after Ship 3 (RP1); RP6 needs RP4.2's live run.
- RP5.1/RP5.2 run after Ship 6; RP5.3 after RP5 remediation lands. None skippable; all gate RP6.
- `[dogfood-eligible]`: none until Ship 3 verified; then single-story dispatch only, `--max-review-cycles 3`.

## Blockers
(none)

## Next session start here
Program created 2026-07-09 (brief + plan + this ledger). Nothing implemented. Start at RP0.1 (Ship 1).

## Decisions log
- 2026-07-09: Program created. Operator-ratified sequencing RP → GC.1 → A5.4 (recorded in acceptance-gate LEDGER). `acceptance.mode` default stays advisory (operator, 2026-07-09). Executor = Claude session direct implementation, same rationale as the gate program.

## Session log
(append per session)
