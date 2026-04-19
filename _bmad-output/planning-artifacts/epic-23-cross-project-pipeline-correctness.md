# Epic 23: Cross-Project Pipeline Correctness

## Vision

Fix the systemic bugs that make substrate produce wrong results when run against projects other than itself. The v0.2.19 cross-project run against code-review-agent (Epic 4) exposed 11 findings — 33% of stories implemented wrong functionality and 100% of code reviews were phantom. This epic addresses correctness first, then throughput, then observability.

Source: `docs/findings-cross-project-epic4-2026-03-05.md`

## Scope

### In Scope

- Epic shard seeding: content-hash re-seed, per-story extraction, relaxed heading regex
- Code-review dispatch error vs. schema failure separation
- Git-helpers resilience for stale file paths
- Story file validation on create-story reuse
- Conflict detector generalization for cross-project runs
- Major-rework re-dev routing (full re-dev, not patch)
- Process detection cross-project fix
- Activity heartbeat for stall detection
- Memory backoff-retry on dispatch-hold
- Status endpoint consistency

### Out of Scope

- Concurrency auto-tuning based on project size (future)
- Automatic epic shard format detection / migration (manual heading fix is acceptable)
- TUI enhancements (frozen per architectural decision)

## Story Map

```
Sprint 1 — Cross-Project Correctness (P0/P1):
  Story 23-1: Epic Shard Overhaul (P0, M)         [Findings 1, 2, 3]
  Story 23-2: Code-Review Dispatch Error Separation (P1, S)  [Finding 4]
  Story 23-3: Story File Validation on Reuse (P1, XS)        [Finding 10]

Sprint 2 — Cross-Project Throughput (P2/P3):
  Story 23-4: Conflict Detector Generalization (P3→P2, S)    [Finding 9]
  Story 23-5: Major-Rework Re-Dev Routing (P1, S)            [Finding 8]

Sprint 3 — Observability & Resilience:
  Story 23-6: Process Detection Cross-Project (P2, S)        [Finding 6]
  Story 23-7: Activity Heartbeat Stall Detection (P2, S)     [Finding 5]
  Story 23-8: Memory Backoff-Retry (P2, S)                   [Finding 7]
  Story 23-9: Status Endpoint Consistency (P3, XS)           [Finding 11]
```

### Dependency Analysis

- 23-1 is independent — highest priority, fixes 33% wrong-output rate
- 23-2 is independent — fixes 100% phantom review rate
- 23-3 is independent — prevents 0-byte reuse on re-runs
- 23-4 is independent — 65% runtime reduction for cross-project
- 23-5 is independent — better fix routing
- 23-7 depends on 23-6 (needs working process detection for liveness override)
- 23-8 is independent
- 23-9 is independent

### Sprint Plan

**Sprint 1 (active):** Stories 23-1, 23-2, 23-3
**Sprint 2 (deferred):** Stories 23-4, 23-5
**Sprint 3 (deferred):** Stories 23-6, 23-7, 23-8, 23-9

## Success Metrics

- Cross-project run produces correct story content for 100% of stories (was 67%)
- Code reviews produce real verdicts based on actual diffs (was 0%)
- Cross-project run with 6 stories completes in <60 min (was 2h25m)
- No phantom review cycles (was 12)
- No false stall events during active dev-story runs (was 2)
