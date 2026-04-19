# Epic 22: Pipeline Intelligence & Resilience

## Vision

Close the remaining architectural gaps in the substrate pipeline: make it learn from past runs, recover from escalations gracefully, verify test coverage against requirements, and clean up internal technical debt. Transform substrate from a stateless pipeline into one that gets smarter with each execution.

## Scope

### In Scope

- Learning loop: inject prior run findings into implementation-phase prompts (dev-story, code-review)
- AC-to-test traceability: enhance code-review to verify each AC has test evidence
- Escalation recovery: structured diagnosis on ESCALATED stories for parent agent action
- Analysis-phase finding injection: feed findings into greenfield project analysis prompts
- Mid-run sprint summary: queryable progress during long pipeline runs
- Pre-implementation test planning: epic-level test strategy before dev-story
- Post-implementation test expansion: E2E/UI coverage gap identification
- AdapterRegistry dependency injection cleanup
- `--retry-escalated` CLI flag for re-queuing escalated stories

### Out of Scope

- Pack config externalization (YAGNI — single BMAD pack)
- Dedicated traceability phase with separate compiled workflow (overkill — prompt enhancement covers this)
- NFR assessment (post-release concern, not pipeline concern)

## Story Map

```
Story 22-1: Learning Loop — Implementation-Phase Injection (P1, M)
    |
Story 22-2: AC-to-Test Traceability via Code-Review Enhancement (P2, XS)
    |
Story 22-3: Structured Escalation Diagnosis (P3, S)
    |
    +-- Story 22-4: Analysis-Phase Finding Injection (deferred, S)
    +-- Story 22-5: --retry-escalated CLI Flag (deferred, S)
    +-- Story 22-6: AdapterRegistry DI Cleanup (deferred, XS)
    +-- Story 22-7: Pre-Implementation Test Planning (deferred, M)
    +-- Story 22-8: Mid-Run Sprint Summary (deferred, S)
    +-- Story 22-9: Post-Implementation Test Expansion (deferred, M)
```

### Dependency Analysis

- 22-1 is independent — highest priority, do first
- 22-2 is independent — zero code changes, prompt-only
- 22-3 is independent — small orchestrator change
- 22-4 depends on 22-1 (same pattern, different injection point)
- 22-5 depends on 22-3 (needs diagnosis data to retry meaningfully)
- 22-6 through 22-9 are independent, lower priority

### Sprint Plan

**Sprint 1 (active):** Stories 22-1, 22-2, 22-3
**Deferred:** Stories 22-4 through 22-9

## Success Metrics

- Pipeline run N+1 on the same project references findings from run N
- Code-review flags ACs without test evidence as major issues
- ESCALATED stories include actionable diagnosis in NDJSON events
- Measurable reduction in review cycles across repeat runs on same project
