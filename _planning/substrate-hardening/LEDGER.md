# Substrate Hardening Program — Ledger

**This file is the cross-session state machine.** Read it at session start; update it with every status change; ship ledger updates in the same commit as the code they describe. Statuses: `todo` | `in-progress (YYYY-MM-DD)` | `done (vX.Y.Z)` | `blocked` | `dropped (reason)`.

Program start: 2026-07-05. Plan: `execution-plan.md` (same dir). Strategy: `_planning/2026-07-05-substrate-bleeding-edge-plan.md`. Audit anchors: `_planning/2026-07-05-substrate-remediation-audit.md`.

## Status board

| ID | Story | Ship | Status | Version | Evidence / notes |
|----|-------|------|--------|---------|------------------|
| H0.1 | Commit-first + wip checkpoints + revision bracket | A | todo | — | — |
| H0.2 | Finalization unified across verdict paths | A | todo | — | — |
| H0.3 | Worktree removal dirty-guard | B | todo | — | — |
| H0.4 | Dispatch forensics + auth classifier + halt | B | todo | — | — |
| H1.1 | One project model + uv + profile-in-worktrees | C | todo | — | — |
| H1.2 | Real-suite gate + kill Node prompt fallback | C | todo | — | — |
| H1.3 | Probe env fidelity | D | todo | — | — |
| H1.4 | Net-new-implementation gate | D | todo | — | — |
| H1.5 | Contamination gate + commit denylist | E | todo | — | — |
| H1.6 | Self-report demotion + Gherkin + BuildCheck order | E | todo | — | — |
| H1.7 | Reward-hack tripwire | E | todo | — | — |
| H2.1 | Fixture consumer repos (py-uv / node-ts / go) | F | todo | — | — |
| H2.2 | Stub-agent pipeline e2e in CI | F | todo | — | — |
| H2.3 | Nightly live smoke | G | todo | — | decide GH-runner vs workstation cron (CLI auth) |
| H2.4 | Eval-corpus regression cases (field findings) | G | todo | — | — |
| H3.1 | finalization.mode: merge\|branch\|pr | H | todo | — | — |
| H3.2 | Lifecycle events + report rendering | H | todo | — | — |
| H3.3 | Merge preconditions (parent-clean, ff-only, fatal start-branch) | I | todo | — | — |
| H3.4 | Epic gate hook | I | todo | — | — |
| H4.1 | Git-state scoping at spawn (env scrub + ceiling) | J | todo | — | — |
| H4.2 | External worktree base + baseDirectory hardcode fix | J | todo | — | — |
| H4.3 | Permission-scoped dispatch experiment + decision | K | todo | — | decision must be evidence-backed |
| H4.4 | Container-ready seam (types + doc + rule) | K | todo | — | — |
| H5.1 | Finding #7 root cause + fix | L | todo | — | needs H0.4 forensics first |
| H5.2 | Field residue #2/#3/#4/#5/#9 | L | todo | — | — |
| H5.3 | Docs-match-behavior gate | M | todo | — | — |
| H5.4 | (stretch) Architecture-conformance check | — | todo | — | may slip past H6 |
| H6 | FINAL GATE: unattended ≥10-story batch, zero hand-lands | — | todo | — | pass criteria in execution-plan.md |

## Dependency notes
- Ship order A→M is the default; H2 (F/G) may interleave from Ship B onward and SHOULD land before Ship E completes (later ACs cite fixture evidence).
- H3+ stories marked `[dogfood-eligible]` in the plan may be dispatched via substrate itself once Ships A+B are verified in a real run.

## Blockers
(none)

## Decisions log
- 2026-07-05: Executor = Claude session direct implementation; substrate-on-substrate only for dogfood-eligible stories after H0. Default `finalization.mode` stays `merge` for backward compat until H3.1's init heuristic ships.

## Session log
- 2026-07-05: Program created (audit + strategy + execution plan + this ledger). No stories started.
