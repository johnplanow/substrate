# Acceptance Gate Program — Ledger

**This file is the cross-session state machine.** Read it at session start; update it with every status change; ship ledger updates in the same commit as the code they describe. Statuses: `todo` | `in-progress (YYYY-MM-DD)` | `done (vX.Y.Z)` | `blocked` | `dropped (reason)`.

Program start: 2026-07-07. Plan: `execution-plan.md` (same dir). Design: `_planning/2026-07-07-acceptance-gate-design-brief.md` (rev 2). Ground truth: `_planning/2026-07-04-income-sources-field-feedback.md` + the income-sources acceptance review (pinned by A3.1).

## Status board

| ID | Story | Ship | Status | Version | Evidence / notes |
|----|-------|------|--------|---------|------------------|
| A0.1 | Registry schema + trusted-tree loader | 1 | todo | | |
| A0.2 | Create-story journey tags | 1 | todo | | |
| A0.3 | Epic-close coverage audit + escalations | 2 | todo | | Matrix cell `journey-unclaimed` = the UJ-2 class caught structurally |
| A1.1 | `acceptance:` profile contract (injection-safe placeholders) | 3 | todo | | |
| A1.2 | Render executor (external artifacts dir, forensics, determinism probe) | 3 | todo | | |
| A1.3 | Spec-tamper + fixture-mutation tripwires | 4 | todo | | |
| A2.1 | Judge dispatch (separate lineage, UNREACHABLE first-class, evidence mandatory) | 5 | todo | | |
| A2.2 | Verdict artifact + report + notifications + events | 5 | todo | | |
| A2.3 | Acceptance matrix cells (5 new; 12 hardening cells must stay green) | 6 | todo | | [dogfood-eligible from here] |
| A3.1 | income-sources retro-fit corpus pin (pre/post-fix SHAs + 5 misses) | 6 | todo | | Repo exists at ~/code/jplanow/income-sources (verified 2026-07-07) |
| A3.2 | Retro-fit gate run: 5/5 pre-fix detections, 0 post-fix false FAILs | 7 | todo | | GATE'S OWN DoD — blocking default is pinned advisory until this is done |
| A3.3 | Eval-framework regression entry for the retro-fit | 7 | todo | | |
| A4.1 | Pre-merge gate slot (verdict×tier paths) | 8 | todo | | |
| A4.2 | Tier → finalization override (BOTH orchestrator config sites) | 8 | todo | | H3.1's live-caught threading gap is the named regression risk |
| A4.3 | Gate cost telemetry | 8 | todo | | [dogfood-eligible] Answers per-story affordability with data |
| A5.1 | Red-team review (12-item evasion catalog minimum) | — | todo | | Output: dated review doc; CONFIRMED evasions → new rows or accepted-risk |
| A5.2 | Evader-agent e2e cells (6 behaviors, all caught, CI-green) | 9 | todo | | |
| A5.3 | Independent `/code-review ultra` (OPERATOR-TRIGGERED — session must request it) | — | todo | | v0.21.0 precedent: ultra found what the red-team missed |
| A6.1 | Canary engine (real-regression revert, auto-demote on miss) | 10 | todo | | |
| A6.2 | Precision instrumentation + demotion state machine | 10 | todo | | |
| A7 | FINAL GATE: live unattended real-agent run, planted never-wired journey caught, 0 false FAILs | — | todo | | Then operator decision: advisory→blocking flip |

## Dependency notes
- Ship order 1→10 is the default. A3.1 (corpus pin) may start any time after Ship 2 — it is research, not code.
- A5.1 red-team runs between Ships 8 and 9; A5.3 ultra review after Ship 9. Neither is skippable; both gate A6/A7.
- `[dogfood-eligible]` stories may be dispatched via `substrate run --stories` after Ship 5 is verified — one per run, `--max-review-cycles 3`.

## Blockers
(none)

## Next session start here
Program created 2026-07-07; no stories started. Begin with A0.1 (registry schema + trusted-tree loader). Read the design brief (rev 2) before Ship 1 — the schema in "Layer 1" is the contract A0.1 implements.

## Decisions log
- 2026-07-07: Program created (design brief rev 2 + execution plan + this ledger). Executor = Claude session direct implementation; dogfood-eligible only after Ship 5 (the gate wires into the just-certified finalization/verification paths — no substrate-on-substrate there until the gate's own matrix cells exist).
- 2026-07-07: **ADVISORY-UNTIL-PROVEN pinned by test** — `acceptance.mode` defaults to `advisory`; the blocking default requires A3.2 retro-fit (5/5 + 0 false FAILs) + one live real-agent run + A5 adversarial phases. v0.21.1 lesson (stub-green ≠ release confidence) written into program structure.
- 2026-07-07: Placement — core in `packages/sdlc/src/acceptance/` mirroring `verification/`; artifacts external at `~/.substrate/acceptance/<name>-<hash8>/<run-id>/` (H4.2 symmetry). Trusted-tree reads for ALL judge/gate inputs (H7 posture) — a story adding an input without this is not done.
- 2026-07-07: Web-walkthrough driver (Midscene/Playwright) explicitly OUT of program scope — deferred pending A4.3 cost data + a real web-surface consumer.

## Session log
- 2026-07-07: Program created. No stories started.
