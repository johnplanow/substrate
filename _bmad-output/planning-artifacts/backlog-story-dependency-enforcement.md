# ~~Backlog: Story-Level Dependency Enforcement~~ — SUPERSEDED by Epic 31

**Status:** SUPERSEDED — Fully addressed by Epic 31 (Dolt Work Graph), which implements Dolt-backed `stories` + `story_dependencies` tables with `ready_stories` SQL view, cycle detection, and authoritative status tracking.

**See:** `_bmad-output/planning-artifacts/epic-31-dolt-work-graph.md`

**Priority:** P1 — Has caused real operational issues (29-8 dispatched before 29-6)
**Category:** Pipeline reliability
**Date identified:** 2026-03-13

## Problem

The orchestrator dispatches stories without checking prerequisites. Epic docs document dependency chains (e.g., `29-6 → 29-8`) but nothing in the pipeline enforces them. Stories get dispatched based on discovery order and file-conflict serialization only.

### History

The old task-graph system (deleted in commit `c939a6b`, 2026-03-01) had full dependency enforcement at the task level:
- `task_dependencies` table with `task_id` / `depends_on` columns
- `ready_tasks` SQL view filtering for tasks with satisfied dependencies
- `dependency-resolver.ts` with cycle detection and topological sorting

When the implementation-orchestrator replaced it, dependency enforcement was not carried forward. Contract-aware ordering (Story 25-5) provides semantic ordering via interface contracts, but is not explicit dependency enforcement.

## Proposed Fix

1. Add `Depends-On:` field to story spec frontmatter (comma-separated story keys)
2. Orchestrator's story dispatch loop checks: are all `Depends-On` stories in `COMPLETE` status?
   - Yes → eligible for dispatch
   - No → skip, log "deferred: waiting on {missing_deps}"
3. Re-check deferred stories each dispatch cycle
4. Detect circular dependencies at discovery time (reuse pattern from old `dependency-resolver.ts`)

### Scope estimate

~50 lines in `orchestrator-impl.ts` (dispatch gating) + ~20 lines in story discovery (parse field). The `task_dependencies` table still exists in `schema.ts` and could potentially be reused for story-level tracking.

## Incidents

- **Epic 29 Sprint 2**: Story 29-8 (remove better-sqlite3) was partially executed before 29-6 (migrate telemetry+monitor) was done. Result: 29-8 couldn't fully complete its ACs, required a cleanup story (29-9), and better-sqlite3 remains in devDeps.

## Related

- Zero-diff escalation bug: orchestrator escalates when first dispatch commits but second dispatch finds nothing — separate issue but same dispatch-loop area of code
- Status write-back: orchestrator doesn't update epic doc status when stories complete — contributes to stale dependency context
