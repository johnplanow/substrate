# Epic 24: Pipeline Integrity Gates

## Vision

Eliminate the two most common classes of pipeline false-positives: phantom completions (zero code on disk marked COMPLETE) and cross-file coherence failures (type errors and stale mocks from interface changes). Add lightweight, deterministic verification gates between pipeline phases so failures are caught in the pipeline instead of during manual cleanup.

Sprint 3 extends the epic with cross-project reliability fixes: AC verification in code review, dynamic turn limits, configurable token ceilings, and package manager auto-detection.

Source: Epic 23 retrospective findings, Epics 22-23 cross-file coherence gaps, cross-project code-review-agent Epic 4 run findings (2026-03-06).

## Scope

### In Scope

- Zero-diff detection: orchestrator verifies `git diff` before marking a story COMPLETE
- Build verification gate: configurable `verifyCommand` (default: `npm run build`, ~1.4s) runs post-dev, pre-review
- Interface change detection: warn when stories modify shared `.ts` interfaces (non-blocking)
- Pipeline metrics v2: wall-clock time, token throughput, review cycles (replaces misleading cost_usd)
- Code-review AC verification: structured per-AC checklist in code-review output preventing false COMPLETE
- Dynamic turn limits: scale agent turns based on story complexity (task/file count)
- Configurable token ceilings: per-workflow override in config.yaml for cross-project runs
- Package manager auto-detection: resolve build command from lockfile instead of hardcoding npm

### Out of Scope

- Full test suite as a gate (108s per run — too expensive per story; test failures are a separate concern)
- Automatic mock patching (too heuristic-heavy; warning signal is sufficient for v1)
- TUI enhancements (frozen per architectural decision)
- Dashboard / OTel integration (future epic)

## Story Map

```
Sprint 1 — Verification Gates (P0/P1) [DONE, v0.2.26]:
  Story 24-1: Zero-Diff Detection Gate (P0, S) ✓
  Story 24-2: Build Verification Gate (P1, S) ✓

Sprint 2 — Observability (P2/P3) [DONE, v0.2.27]:
  Story 24-3: Interface Change Detection Warning (P2, S) ✓
  Story 24-4: Pipeline Metrics v2 (P3, M) ✓

Sprint 3 — Cross-Project Reliability (P0/P1):
  Story 24-5: Code-Review AC Verification Checklist (P0, S)
  Story 24-6: Dynamic Turn Limits Based on Story Complexity (P1, S)
  Story 24-7: Configurable Token Ceiling Per Workflow (P1, S)
  Story 24-8: Auto-Detect Package Manager for Build Verification (P2, S)
```

### Dependency Analysis

- 24-1 through 24-4: shipped
- 24-5 is independent — highest priority, fixes false-positive code review
- 24-6 is independent — fixes turn exhaustion on complex stories
- 24-7 is independent — fixes context truncation on large codebases
- 24-8 is independent — fixes build verification on non-npm projects

All Sprint 3 stories can run sequentially with no cross-dependencies. No stories modify `src/cli/index.ts`.

### Sprint Plan

**Sprint 1:** Stories 24-1, 24-2 [DONE]
**Sprint 2:** Stories 24-3, 24-4 [DONE]
**Sprint 3:** Stories 24-5, 24-6, 24-7, 24-8

## Success Metrics

- Zero phantom completions: all stories marked COMPLETE have at least one file changed on disk
- Cross-file type errors caught pre-review: build failures escalated, not passed to code-review
- Interface change warnings emitted for 100% of stories that modify shared exports
- Pipeline metrics include wall-clock time, token counts, and review cycle counts per story
- Code-review produces per-AC checklist; unmet ACs prevent SHIP_IT verdict
- Complex stories (8+ tasks) get enough turns to complete without exhaustion
- Cross-project runs use correct token ceilings without manual override
- Build verification auto-detects pnpm/yarn/bun from lockfile

## Benchmark Data

- `npm run build`: 1.4 seconds (measured 2026-03-06)
- `npm test`: 108 seconds (measured 2026-03-06)
- Build gate adds negligible latency; test gate would add ~2 min per story — not justified as a gate
