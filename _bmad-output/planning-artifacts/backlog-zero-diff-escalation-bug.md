# ~~Backlog: Zero-Diff Escalation on Completed Work~~ — FIXED

**Status:** FIXED — Baseline HEAD SHA captured before dispatch; zero-diff gate now checks for new commits before escalating.
**Fixed in:** orchestrator-impl.ts (baseline SHA capture + HEAD comparison in zero-diff gate)
**Date fixed:** 2026-03-21

**Priority:** P2 — Wastes pipeline cycles but doesn't cause data loss
**Category:** Pipeline reliability
**Date identified:** 2026-03-13

## Problem

When a dev-story dispatch commits its changes and completes, the orchestrator may run a second dispatch. The second dispatch finds a clean working tree (all changes already committed), reports zero-diff, and escalates the story — even though the first dispatch successfully completed the work.

The zero-diff check (`git diff` against HEAD) only looks at uncommitted changes at dispatch end. It doesn't check whether new commits were made during the dispatch window.

## Incidents

- **Story 29-9 (run 2)**: First dispatch modified 57 files and created 2 commits. Second dispatch found clean tree → zero-diff → escalated. All work was actually done. Pipeline reported failure despite success.
- **Story 29-9 (run 1)**: 3 dispatches, all zero-diff — but this was a genuine failure (agent couldn't see enough context due to 20K token ceiling). The bug is that the same escalation signal means both "nothing happened" and "everything already happened."

## Proposed Fix

Track a `baseline_commit_sha` when each story dispatch starts. After dispatch completes:

1. Compare `HEAD` against `baseline_commit_sha`
2. If new commits exist → real work happened, skip zero-diff escalation
3. If no new commits AND no uncommitted changes → genuine zero-diff, escalate

### Scope estimate

~15 lines in `orchestrator-impl.ts`: capture `git rev-parse HEAD` before dispatch, compare after.

## Related

- Epic 31 (Dolt Work Graph) addresses the broader dispatch and status tracking architecture but does not specifically fix this bug
