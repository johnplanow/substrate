# Story 81-9: Populate `total_turns` to un-blind the pack-upgrade cost axis

## Story

As a substrate eval-framework operator,
I want every dispatch to carry a real agentic turn count on `DispatchResult.totalTurns` (not `null`),
so that the pack-upgrade cost axis stops marking every pair `missing-telemetry` and can finally detect cost-shaped regressions (e.g. a degraded prompt that makes the model skip test-first and finish in fewer turns).

This is follow-up #1 of three from the Phase 4.2 v4 re-validation (2026-06-06). See the "Phase 4.2 v4" section of `docs/2026-05-31-epic-81-first-calibration.md` for the empirical finding: across both the census and fixture corpora, the cost axis reported `Ungradable: 2` / `Ungradable: 4` because `total_turns` is `null` on every envelope.

## Background — the gap 81-7 left open (established fact; do NOT re-derive)

Story 81-7 added the field and the read-side wire but **no producer**:

- `DispatchResult.totalTurns?: number` exists at `packages/core/src/dispatch/types.ts:147` (added by 81-7, additive forward-only).
- `normalizeDispatchEnvelope` already maps it: `total_turns: rawResult?.totalTurns ?? rawResult?.total_turns ?? null` (`scripts/eval-pack-upgrade/lib.mjs`).
- The cost axis gates on `hasCostTelemetry(current) && hasCostTelemetry(candidate)` (`scripts/eval-pack-upgrade/grader-lib.mjs:~449`); a `null` `total_turns` fails that gate → `reason: 'missing-telemetry'` → ungradable.

**The missing piece is the write-side**: `dispatcher-impl.ts` constructs the `DispatchResult` (with `durationMs`, `tokenEstimate`, `exitCode`, …) but never sets `totalTurns`. 81-7 AC1 was completed *structurally* (field + read wire) but not *functionally* (no value source). This story closes that.

**Known constraint — telemetry is async.** Turn counts are computed by `TurnAnalyzer` / `EfficiencyScorer` (`packages/core/src/telemetry/efficiency-scorer.ts`; `totalTurns` concept from Story 35-3) from OTEL telemetry that is *ingested asynchronously* after the dispatch process exits. So the turn count may NOT be available at the synchronous moment `dispatcher-impl.ts` resolves the `DispatchResult`. The story must pick a source that is actually populated at result-resolution time. Candidate sources, in rough order of preference — the dispatched agent investigates which is reliable:
  1. **Agent structured output** — if the agent's emitted YAML/JSON result carries a turn count, parse it in the adapter (`parsed`) and surface it.
  2. **Adapter-side turn tally** — the Claude Code adapter (`packages/core/src/adapters/claude-adapter.ts`) may be able to count assistant turns from the CLI's streamed messages / result payload it already consumes.
  3. **Post-hoc telemetry join** — if (1)/(2) are infeasible, document that `total_turns` requires the OTEL turn-analysis to have landed, and provide a best-effort late-binding read (acceptable to leave `null` when telemetry hasn't arrived; the goal is "non-null when the data exists," not "always non-null").

## Acceptance Criteria

1. **Identify a reliable turn-count source available at `DispatchResult` resolution time.** Investigate the three candidate sources above against a real claude-code dispatch. Document in Dev Notes which source is used and why the others were rejected.

2. **Populate `DispatchResult.totalTurns` on the production dispatch path** (`packages/core/src/dispatch/dispatcher-impl.ts` and/or `packages/core/src/adapters/claude-adapter.ts`). Forward-only, additive — when the count is genuinely unavailable, leave the field absent (the envelope continues to normalize to `null`), never fabricate a value.

3. **The pack-upgrade cost axis becomes gradable** for dispatches that carry a turn count. Verify by re-running the existing pack-upgrade harness against the fixture corpus (or a unit-level envelope) and confirming `gradeCostAxis` produces `gradable: true` pairs with real `delta_turns` instead of `missing-telemetry`.

4. **No behavior change to substrate's production dispatch or orchestrator path** beyond setting the new field. Same forward-only constraint as 81-6/81-7. The orchestrator, recovery engine, and merge/commit paths are untouched.

5. **Unit tests**: (a) the adapter/dispatcher populates `totalTurns` from the chosen source given a synthetic dispatch result/transcript; (b) the field is absent (not `0`, not fabricated) when the source is missing; (c) a `gradeCostAxis` test with two envelopes that now carry `total_turns` produces a real `delta_turns` and is `gradable: true`. Synthetic fixtures only — no live model calls in the suite.

6. **Ship gate stays GREEN**: `npm run build`, `npm run test:fast`, `node scripts/eval-outcomes.mjs --threshold 0.95` all GREEN.

7. **Documentation**: add a short "81-9 landing" note to `docs/2026-05-31-epic-81-first-calibration.md` recording the chosen turn-count source and whether re-running Phase 4.2 against a cost-shaped target now moves the cost axis. (Running that live Phase 4.2 re-run is optional/operator-driven, not required for merge — but if cheap, capture the result.)

## Tasks / Subtasks

- [ ] **Task 1 — Investigate turn-count sources** against a real claude-code dispatch (AC1)
- [ ] **Task 2 — Populate `totalTurns` on the dispatch/adapter path** (AC2, AC4)
- [ ] **Task 3 — Verify cost axis becomes gradable** (AC3)
- [ ] **Task 4 — Unit tests** (AC5)
- [ ] **Task 5 — Documentation note** (AC7)
- [ ] **Task 6 — Regression validation** (AC6)

## Dev Notes

### Why this is the highest-leverage, most-contained follow-up

It un-blinds an entire grading axis with a localized, well-anchored change (one field, one producer). It is also the natural detector for the very regression class that defeated Phase 4.2 v4 — "model skipped test-first → fewer turns" — so it may close part of the subtle-regression ceiling on its own.

### Canonical paths

| Item | Path |
|---|---|
| `DispatchResult.totalTurns` (field, added by 81-7) | `packages/core/src/dispatch/types.ts:147` |
| Dispatch result construction (write site) | `packages/core/src/dispatch/dispatcher-impl.ts` |
| Claude Code adapter | `packages/core/src/adapters/claude-adapter.ts` |
| Turn analysis / efficiency scoring (existing turn source) | `packages/core/src/telemetry/efficiency-scorer.ts` (Story 35-3 `totalTurns`) |
| Read-side wire (already done) | `scripts/eval-pack-upgrade/lib.mjs` (`normalizeDispatchEnvelope`) |
| Cost axis grader + `hasCostTelemetry` gate | `scripts/eval-pack-upgrade/grader-lib.mjs` (`gradeCostAxis`, ~line 449) |

### Testing Requirements

- Framework: **vitest**
- Synthetic dispatch results / transcripts; no live model calls in the suite
- The optional cost-axis Phase 4.2 re-run (AC7) is operator-driven, outside `npm run test:fast`

## Interface Contracts

- **`DispatchResult.totalTurns?: number`** — already declared (81-7); this story only adds a *producer*. Absence remains valid and normalizes to `total_turns: null`. Additive, forward-only.
- **No change** to the envelope schema, the cost-axis thresholds, or the report format.

## Dev Agent Record

### Agent Model Used
<to be filled in by dispatched agent>

### Completion Notes List
<to be filled in by dispatched agent>

### File List
<to be filled in by dispatched agent>

## Change Log
