# Phase D Concept: Autonomous Operations

> Synthesized from: findings-epic30-run, findings-cross-project-epic4, workflow-gap-analysis, codex-improvement-backlog, boardgame-improvement-suggestions, codex-validation-run, cross-project validation data (ynab, NextGen Ticketing, Board Game Sandbox)

## Thesis

Make substrate capable of completing multi-story pipeline runs without human intervention. Close the gap between "can run" and "can run unattended" — the system should run overnight and report results in the morning.

## Current State (v0.19.25)

- **Phases A-C complete**: 50 epics shipped, 8,088 tests green, 3-package monorepo (core, sdlc, factory)
- **Cross-project validated**: ynab (7/7 stories), NextGen Ticketing (17/17 stories), Board Game Sandbox (15/15 stories)
- **Cross-backend validated**: Codex CLI dispatches work end-to-end (4-8x slower, 4 substrate fixes required)
- **Key capability**: Full SDLC pipeline (analysis -> planning -> solutioning -> implementation) with graph engine, convergence loop, satisfaction scoring, context engineering, parallel fan-out

## Problem Categories

### Category 1: Session State Is Not First-Class

The concept of a "run" is spread across four sources of truth: JSON run manifest, Dolt pipeline_runs table, supervisor in-memory state, and the NDJSON event stream. This causes:

- **P0: Supervisor restart drops --stories scope** — no persisted CLI flags, restart uses bare `substrate run`, discovers ALL ready stories across ALL epics (Epic 30 findings)
- **P2: Cross-session supervisor interference** — supervisor attached from different session kills healthy dispatch, no session ownership concept
- **P3: Status endpoint inconsistencies** — `substrate status` and `substrate health` report different completion counts
- **Resume fragility** — `substrate resume` depends on inferring state from multiple sources

### Category 2: Stall Detection Is Unreliable

The supervisor cannot distinguish "agent is working" from "agent is stuck":

- **P1: Stall threshold too aggressive for code review** — 618s staleness kills healthy review agents that routinely run 10-30 min (Epic 30 findings)
- **P1: False stall detection during dev-story** — `last_activity` only updates on phase transitions, not during active dispatch work (Epic 4 findings)
- **P2: Process detection always returns null** — `orchestrator_pid: null, child_pids: []` reported while pipeline is actively processing (Epic 4 findings)

### Category 3: No Closed Learning Loop

Findings are captured (decision store, supervisor reports, experiment verdicts) but never consumed by future runs:

- **Priority 1 workflow gap**: Findings captured but not fed back into analysis/planning/implementation prompts
- **Priority 3 workflow gap**: ESCALATED stories are dead ends with no recovery mechanism
- Stories that fail due to namespace collisions, dependency ordering, or spec staleness keep failing the same way

### Category 4: Quality Signals Are Incomplete

The pipeline can't verify its own output:

- **P1: Silent code review fallback verdicts** — schema-validation failures produce NEEDS_MINOR_FIXES instead of surfacing the error (Epic 4 findings)
- **P2: NEEDS_MAJOR_REWORK treated same as NEEDS_MINOR_FIXES** — no distinction in fix strategy (Epic 4 findings)
- **Priority 2 workflow gap**: No AC-to-test traceability matrix after implementation
- **Pending**: Flag stories with <100 output tokens as unverified (boardgame suggestions)
- **Pending**: Post-run AC spot-check via git diff analysis (partially done with diffStats in v0.19.16)

### Category 5: Adapter Brittleness

Non-Claude backends require manual fixes to work:

- Codex needed 4 substrate fixes (v0.19.11-v0.19.14) just to dispatch successfully
- Token usage is heuristic-only for non-Claude backends (no OTLP)
- Routing resolver returns null for Codex
- Test-plan output parsing fails (format compliance varies by backend)
- YAML format compliance varies — schema-aware suffix helps but doesn't solve

## Evidence: Why "Operator Required" Today

| Validation Run | Stories | Runs Required | Human Interventions | Root Cause |
|---|---|---|---|---|
| Board Game Sandbox | 15/15 | 3 (10+1+4) | Manual restart after bugs | Token budget, SQL reserved word, maxTurns too low |
| NextGen Ticketing Epic 1 | 17/17 | 4 sprints | Sprint-by-sprint operator oversight | Custom harness work required (H1-H3) |
| Codex on Ticketing | 1/1 | Multiple | 4 substrate code fixes mid-run | Adapter gaps, timeout tuning |
| Epic 30 (self-hosting) | 7/8 | 6 runs | Supervisor scope loss, manual story fix | Session state, dependency ordering |
| Epic 4 (cross-project) | 5/6 | 2 runs | Epic shard cleanup, heading fix | Data integrity, OOM |

Every validation run required human intervention. The bugs were different each time, but the pattern is consistent: the system lacks the self-awareness and recovery mechanisms to handle the unexpected.

## Success Criteria

1. **Unattended completion**: A multi-story pipeline run (10+ stories) completes without human intervention on a validated project type
2. **Self-recovery**: When a story fails, the system diagnoses the failure category and applies the appropriate recovery strategy (retry, re-scope, split, skip-and-continue)
3. **Learning persistence**: Findings from run N are injected into run N+1's prompts, reducing repeat failures
4. **Backend resilience**: Non-Claude backends work without substrate code changes (adapter self-healing or graceful degradation)
5. **Operator confidence**: Post-run report provides verifiable evidence of story completion (AC traceability, diff analysis, quality scores)

## Constraints

- No shortcuts, no tech debt — full planning cycle (product brief -> PRD -> architecture -> epics -> stories)
- Substrate must remain language-agnostic — no language-specific logic outside detection/config layers
- Existing 8,088 tests must pass at every commit
- File-backed storage for run manifest (no SQLite per feedback constraint)
- Build time must stay under 5s
