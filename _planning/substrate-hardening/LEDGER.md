# Substrate Hardening Program — Ledger

**This file is the cross-session state machine.** Read it at session start; update it with every status change; ship ledger updates in the same commit as the code they describe. Statuses: `todo` | `in-progress (YYYY-MM-DD)` | `done (vX.Y.Z)` | `blocked` | `dropped (reason)`.

Program start: 2026-07-05. Plan: `execution-plan.md` (same dir). Strategy: `_planning/2026-07-05-substrate-bleeding-edge-plan.md`. Audit anchors: `_planning/2026-07-05-substrate-remediation-audit.md`.

## Status board

| ID | Story | Ship | Status | Version | Evidence / notes |
|----|-------|------|--------|---------|------------------|
| H0.1 | Commit-first + wip checkpoints + revision bracket | A | done (v0.20.139) | v0.20.139 | Tests: git-helpers 30/30 (+5), worktree-merge-integration 21/21 (+6), reconcile 27/27 (+2), test:fast 10220. LIVE (uv fixture run a9125656): full bracket `baseline_sha fb02fea`+`commit_sha 48812c8` in manifest; commit at dev-story-complete second, 33s before review complete; `uv run pytest` 2/2 on merged main. CI+Publish green 2026-07-05 |
| H0.2 | Finalization unified across verdict paths | A | done (v0.20.139) | v0.20.139 | finalizeStory() shared by SHIP_IT + both auto-approve sites; finding-#1 regression test green. LIVE: full SHIP_IT cycle on uv fixture (merge, cleanup, completed). CI+Publish green 2026-07-05 |
| H0.3 | Worktree removal dirty-guard | B | done (v0.20.140) | v0.20.140 | decideWorktreeRemoval (pure) + inspectWorktreeRemovalSafety; guards dirty trees AND unmerged branch commits; CLI --force; orphan sweep preserves unsafe. LIVE (bundled dist on uv fixture): cleanup of dirty worktree REFUSED naming precious.py, work preserved; --force discarded worktree+branch. 11 new tests |
| H0.4 | Dispatch forensics + auth classifier + halt | B | done (v0.20.140) | v0.20.140 | detectClaudeAuthFailure (8 field-verified signatures, core) + CLAUDE_AUTH_FAILURE_HINT; source classification at create-story schema-fail (exit-0 refusals); auth-failure = FATAL decision type (halts under every --halt-on); triggerAuthFailureHalt sweeps PENDING→auth-failure-halt; buildPlanningCommand env-scrub parity. 10 new tests (7 classifier + 3 halt-wiring incl. no-false-halt). Live auth repro deliberately deferred to H2.2 stub adapter (cannot safely break real CLI auth on the operator workstation) |
| H0.5 | Escalation parent-leak capture on every escalation | B | done (v0.20.140) | v0.20.140 | From field finding #20 (income-sources 6-1: escalation abandoned a COMPLETE implementation uncommitted in the PARENT tree). emitEscalation now runs detectWorkOutsideWorktree; dirty parent → PARENT-TREE LEAK message (files named) in escalation issues/escalation_detail + orchestrator:story-warn event. Regression test green. Root fix = H4; this is the tourniquet |
| H1.1 | One project model + uv + profile-in-worktrees | C | todo | — | — |
| H1.2 | Real-suite gate + kill Node prompt fallback | C | todo | — | — |
| H1.3 | Probe env fidelity | D | todo | — | — |
| H1.4 | Net-new-implementation gate | D | todo | — | — |
| H1.5 | Contamination gate + commit denylist | E | todo | — | — |
| H1.6 | Self-report demotion + Gherkin + BuildCheck order | E | todo | — | — |
| H1.7 | Reward-hack tripwire | E | todo | — | — |
| H1.8 | Story-artifact path containment: reject create-story `story_file` outside the project root (worktree) | E | todo | — | NEW 2026-07-05, live capture: create-story agent wrote artifact to `$HOME/_bmad-output/implementation-artifacts/1-1-…md` (outside fixture+worktree); pipeline accepted the path and proceeded via prompt-embedded content. #15 leak-class cousin; also strengthens H4.3 case (env scrub can't stop $HOME writes — scoped permissions can) |
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
| H5.2 | Field residue #2/#3/#4/#5/#9 | L | todo | — | #3 root cause captured 2026-07-05: `DoltQueryError: Unknown column 'token_density_sub_score' in 'efficiency_scores'` — schema drift between initSchema DDL and EfficiencyScorer writer. #2 repro note: fresh-init scaffolds .claude/commands fine; suspect pre-existing .claude/ state |
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
- 2026-07-05 (session 1): H0.1 + H0.2 implemented with tests (Ship A pending live evidence). Incidental observation: `substrate init --yes` on a fresh uv fixture DID scaffold `.claude/commands/` correctly — field finding #2 may be conditional on pre-existing `.claude/` state (repro note for H5.2, AC1).
