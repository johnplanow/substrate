# Story 81-1: PerStoryStateSchema forward-only additions for pack-upgrade signals

## Story

As a substrate eval-framework operator,
I want three forward-only optional fields on `PerStoryStateSchema` (`verdict`, `total_turns`, `total_tokens`) populated by the orchestrator,
so that Epic 81's pack-upgrade A/B harness (stories 81-2..81-4) has the per-story signal envelope it needs to detect prompt-quality drift, cost regressions, and verdict distribution shifts.

This story is intentionally small and foundational: it adds the schema fields, wires the capture sites in the orchestrator, and adds tests. No behavior change to dispatch, no behavior change to existing eval signals (77-1 outcome-replay, 77-5 decision-replay).

## Acceptance Criteria

1. **`verdict` field added to `PerStoryStateSchema`** at `packages/sdlc/src/run-model/per-story-state.ts`. Type: `z.union([z.literal('SHIP_IT'), z.literal('LGTM_WITH_NOTES'), z.literal('NEEDS_MINOR_FIXES'), z.literal('NEEDS_MAJOR_REWORK'), z.string()]).optional()` — follows the `probe_author_triggered_by` extensible-union pattern (literal known values + `z.string()` fallback for forward compatibility). Comment cites Story 81-1 and the v0.20.115 forward-only-additive pattern.

2. **`total_turns` field added to `PerStoryStateSchema`.** Type: `z.number().int().nonnegative().optional()`. Comment documents that the value sums turn-counts across ALL phase dispatches for the story (create-story + test-plan + dev-story + code-review + any fix/rework cycles). Absent on pre-81-1 manifests; consumers MUST treat absence as "unknown" (NOT zero) — use `?? null` at call sites.

3. **`total_tokens` field added to `PerStoryStateSchema`.** Type: `z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).optional()`. Same absence semantics as `total_turns`. The shape matches the existing `TokenEstimate` type at `src/adapters/types.ts:157-163` (sans the `total` field; consumers compute that as input+output when needed).

4. **`verdict` capture site wired in the orchestrator.** The final code-review verdict per story is written via `manifestStore.patchStoryState(storyKey, { verdict })` at the code-review terminal site — same pattern as the existing `escalation_reason` and `commit_sha` writes (see `orchestrator-impl.ts:4025` and `:4707`). Captured for ALL verdict outcomes (`SHIP_IT`, `LGTM_WITH_NOTES`, `NEEDS_MINOR_FIXES`, `NEEDS_MAJOR_REWORK`) — including ones that subsequently trigger rework or escalation. The persisted value is the AGENT'S original verdict from `CodeReviewResultSchema.transform` (the schema preserves it as `agentVerdict` separately from the deterministically-recomputed `verdict`, per `compiled-workflows/schemas.ts:226-229`); when the agent verdict is absent, fall back to the recomputed `verdict`. Write failure → `logger.warn` per the existing convention.

5. **`total_turns` + `total_tokens` capture sites wired in the orchestrator.** Aggregated and written at the same finalize point that writes `commit_sha` (the auto-commit lifecycle hook, post-merge, per the v0.20.86+ pattern at `orchestrator-impl.ts:4707`). Aggregation source: the `_storyAgents.get(storyKey)` map already tracks per-dispatch agent metadata. If turn-count/token data isn't currently aggregated per-story, add an aggregation helper (`aggregateStoryDispatchTelemetry(storyKey)` returning `{ total_turns, total_tokens }`) extracted to a pure function for unit-testability. Write failure → `logger.warn` per the existing convention. NOT a blocker for the auto-commit itself.

6. **Pure aggregation helper extracted + unit-tested.** Whatever aggregation logic is needed to derive `total_turns` and `total_tokens` from the per-story dispatch records lives in an exported pure function (probably `aggregateStoryDispatchTelemetry(dispatchRecords[])` or similar), NOT inline in the orchestrator. Vitest unit tests cover: (a) empty dispatch list returns null (not zero); (b) single-dispatch single-phase sums correctly; (c) multi-phase multi-dispatch sums correctly across create-story + dev-story + code-review; (d) missing token data on one dispatch doesn't break aggregation (other dispatches still count); (e) missing turn data on one dispatch doesn't break aggregation.

7. **Schema round-trip tests.** Vitest tests in `packages/sdlc/src/run-model/__tests__/per-story-state.test.ts` (or extend the existing file) cover: (a) parsing a manifest WITHOUT the three new fields succeeds (backward-compat); (b) parsing a manifest WITH each new field individually succeeds; (c) parsing a manifest with an unknown verdict string succeeds (extensible-union fallback works); (d) invalid types (e.g., `total_turns: 'three'`) fail validation cleanly.

8. **Capture-site integration tests.** Mocked-orchestrator integration tests under `src/modules/implementation-orchestrator/__tests__/` cover: (a) a successful code-review dispatch writes `verdict` via `patchStoryState`; (b) a successful auto-commit writes `total_turns` + `total_tokens` via `patchStoryState`; (c) a `patchStoryState` failure on any of the three writes is logged but does NOT block the pipeline. Use the existing test utilities for orchestrator mocking — do NOT add a new mocking framework.

9. **No behavior change to dispatch.** Routing decisions, recovery decisions, verdict-to-action mapping (Sonnet vs Opus), and all existing eval signals (77-1 outcome-replay corpus, 77-5 decision-replay corpus) continue to pass without modification. The full eval-outcomes regression gate (`node scripts/eval-outcomes.mjs --threshold 0.95`) must remain GREEN.

10. **No breaking changes to the manifest format.** Existing tooling that reads `PerStoryState` must continue to work with manifests written by this story. Existing manifests on disk (which lack all three new fields) must continue to be readable.

## Tasks / Subtasks

- [ ] **Task 1 — Add the three schema fields** (AC1, AC2, AC3)
  - [ ] Edit `packages/sdlc/src/run-model/per-story-state.ts` adding `verdict`, `total_turns`, `total_tokens` after the existing forward-only-additive block (after `story_file_sha256` at line 168, matching the v0.20.115/118/124/130 pattern)
  - [ ] `verdict`: extensible union (4 literals + `z.string()` fallback) per the `probe_author_triggered_by` pattern
  - [ ] `total_turns`: `z.number().int().nonnegative().optional()`
  - [ ] `total_tokens`: `z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).optional()`
  - [ ] Each field's JSDoc comment cites Story 81-1, names the consumer (Epic 81 pack-upgrade A/B harness), states the absence semantics, and follows the existing comment style verbatim

- [ ] **Task 2 — Extract pure aggregation helper** (AC6)
  - [ ] Create `src/modules/implementation-orchestrator/dispatch-telemetry-aggregation.ts` (or co-locate in an existing helper file if one already exists for `_storyAgents` access)
  - [ ] Export `aggregateStoryDispatchTelemetry(dispatchRecords: DispatchRecord[]): { total_turns?: number; total_tokens?: { input: number; output: number } }` — pure, no I/O
  - [ ] Returns `{}` (both fields absent) when input is empty; returns partial object when some dispatches lack telemetry
  - [ ] Co-locate vitest tests at `src/modules/implementation-orchestrator/__tests__/dispatch-telemetry-aggregation.test.ts` covering the AC6 scenarios

- [ ] **Task 3 — Wire `verdict` capture site** (AC4)
  - [ ] Identify the code-review terminal site in `src/modules/implementation-orchestrator/orchestrator-impl.ts` (search for `CodeReviewResultSchema` consumers + the verdict-to-action routing at `:4823`/`:4979`)
  - [ ] Add `manifestStore.patchStoryState(storyKey, { verdict })` at the terminal site, using the AGENT verdict when present (from `agentVerdict` field preserved by `schemas.ts:226-229`), else the recomputed `verdict`
  - [ ] Wrap in try/catch with `logger.warn({ err, storyKey }, 'patchStoryState(verdict) failed — pipeline continues')` per the existing convention

- [ ] **Task 4 — Wire `total_turns` + `total_tokens` capture site** (AC5)
  - [ ] At the auto-commit lifecycle hook in `orchestrator-impl.ts` (the same site that writes `commit_sha` per F-commitsha at `:4707`), call `aggregateStoryDispatchTelemetry(_storyAgents.get(storyKey) ?? [])` and persist the result via a single `patchStoryState` call alongside `commit_sha`
  - [ ] Wrap in try/catch with `logger.warn({ err, storyKey }, 'patchStoryState(total_turns/total_tokens) failed — pipeline continues')`
  - [ ] If the dispatch records don't currently carry turn-count or token data, surface that as a finding in the Dev Agent Record — DO NOT silently swallow. Acceptable resolution: pipe the data through (forward-only-additive on the dispatch record type) or document the gap and persist only what's available

- [ ] **Task 5 — Schema round-trip tests** (AC7)
  - [ ] Extend `packages/sdlc/src/run-model/__tests__/per-story-state.test.ts` with the four AC7 cases
  - [ ] Run `npm run test:fast -- packages/sdlc/src/run-model/__tests__/per-story-state.test.ts` to confirm

- [ ] **Task 6 — Capture-site integration tests** (AC8)
  - [ ] Add tests under `src/modules/implementation-orchestrator/__tests__/` (extend an existing file if appropriate; otherwise create `__tests__/per-story-state-capture.test.ts`)
  - [ ] Mock `manifestStore.patchStoryState` and assert it's invoked with the right keys after each capture site
  - [ ] Cover the failure-tolerant path (patchStoryState throws → pipeline continues + log emitted)

- [ ] **Task 7 — Regression validation** (AC9, AC10)
  - [ ] `npm run build` (gates: build green)
  - [ ] `npm run test:fast` (gates: unit suite green; expect new tests added by this story to also pass)
  - [ ] `node scripts/eval-outcomes.mjs --threshold 0.95` (gates: 77-1 regression GREEN — no drift introduced)
  - [ ] Manually read an existing manifest (e.g. `.substrate/runs/<recent-run>.json`) through the updated parser to confirm backward compatibility

## Dev Notes

### Why this story is foundational

Stories 81-2 (harness), 81-3 (grader), 81-4 (CLI) all depend on the envelope shape this story establishes. The harness CAPTURES `verdict`, `total_turns`, `total_tokens` from the per-story state after each A/B dispatch; the grader CONSUMES those fields to compute the four signal axes. Without these fields, those stories would have to either:
- (a) parse turn-count and tokens from raw dispatch envelopes, scattering parse logic across the harness (fragile, no permanent provenance)
- (b) capture them via a side-channel (e.g., a separate file written by the harness, not the orchestrator) — divergent from the v0.20.115 provenance-hardening pattern Epic 77 established

The forward-only-additive approach is consistent with substrate's persistence discipline (the v0.20.115/118/124/130 ship pattern) and gives Epic 81 a durable, queryable signal source that survives notification deletion and worktree teardown.

### The verdict field's dual identity

`CodeReviewResultSchema` in `src/modules/compiled-workflows/schemas.ts` performs a deterministic re-computation of the verdict based on issue severities (lines 152-159, 221), preserving the agent's original verdict as `agentVerdict` (lines 226-229) only when the recomputed verdict is SHIP_IT.

For this story, the `PerStoryState.verdict` field should capture the **agent's verdict** when available (it's the verdict that drove substrate's dispatch decisions — Sonnet vs Opus routing happens off of THIS value, not the recomputed one), falling back to the recomputed verdict when agentVerdict is absent. The grader (81-3) cares about agent-perceived verdict distribution for prompt-drift detection; the orchestrator-decided verdict is already inferable from the `recovery_history` and downstream phase outcomes.

Document this choice clearly in the JSDoc comment on the field.

### Dispatch telemetry availability — KNOWN UNKNOWN

It's not currently confirmed that every per-story dispatch carries clean `total_turns` and `total_tokens` data at the aggregation site. The `_storyAgents` map (referenced in 77-4 AC1) holds dispatch agent metadata, but whether token/turn data is reliably populated for EVERY dispatch (create-story, test-plan, dev-story, code-review, fix-story, rework) needs empirical verification at task-implementation time.

If a phase doesn't reliably populate turn/token data:
- **Acceptable**: persist what's available, leave the field absent for unavailable phases, document the gap in the Dev Agent Record
- **NOT acceptable**: silently zero-fill missing data (would mis-aggregate in the grader; absence ≠ zero)
- **Out of scope for this story**: piping turn/token data through phases that currently don't track it. That's its own forward-only-additive ship if it turns out to be the gap.

### Canonical Import Paths

| Helper | Import path |
|---|---|
| `PerStoryStateSchema`, `PerStoryState` | `packages/sdlc/src/run-model/per-story-state.ts` |
| `manifestStore.patchStoryState` | Available on the orchestrator's `ManifestStore` interface (search for existing call sites) |
| `_storyAgents` map | Internal to the orchestrator (`src/modules/implementation-orchestrator/orchestrator-impl.ts`) |
| `CodeReviewResultSchema`, `agentVerdict` | `src/modules/compiled-workflows/schemas.ts:189-238` |
| `logger` | Whatever the orchestrator-impl.ts already imports (see existing `logger.warn` call sites near `:4027` and `:4707`) |

### Reference Capture Sites (do NOT modify; use as the implementation pattern)

| File:Line | Field written | Pattern to match |
|---|---|---|
| `orchestrator-impl.ts:4025-4027` | `escalation_reason` (Story 77-4) | `patchStoryState` + `logger.warn` fallback |
| `orchestrator-impl.ts:4707` | `commit_sha` (F-commitsha) | Same pattern at auto-commit lifecycle hook |
| `orchestrator-impl.ts:1284` | `escalation_reason` + `escalation_detail` (obs_032 / v0.20.130) | Same pattern via centralized `emitEscalation` |

Mimic the conventions exactly — single `patchStoryState` call per logical write group (so `total_turns` + `total_tokens` go in the SAME call alongside `commit_sha` if at the same site), try/catch around the entire write, log message names the failing field group.

### Testing Requirements

- Framework: **vitest** (match all other substrate test files)
- No live dispatch, no real Dolt, no real filesystem writes in unit tests
- Schema round-trip tests use Zod's `.safeParse()` + assertion on `.success` + `.data`
- Capture-site integration tests mock `manifestStore.patchStoryState` and assert call args
- Full eval-outcomes gate must remain GREEN: `node scripts/eval-outcomes.mjs --threshold 0.95`

### Key Files

| File | Purpose |
|---|---|
| `packages/sdlc/src/run-model/per-story-state.ts` | Schema additions (Task 1) |
| `packages/sdlc/src/run-model/__tests__/per-story-state.test.ts` | Schema round-trip tests (Task 5) |
| `src/modules/implementation-orchestrator/orchestrator-impl.ts` | Capture sites (Tasks 3 + 4) |
| `src/modules/implementation-orchestrator/dispatch-telemetry-aggregation.ts` | Pure aggregation helper (Task 2; create if absent) |
| `src/modules/implementation-orchestrator/__tests__/` | Capture-site integration tests (Task 6) |
| `src/modules/compiled-workflows/schemas.ts` | **Reference only** — `agentVerdict` source |
| `_bmad-output/eval-results/corpus/outcomes-corpus.yaml` | **Reference only** — Epic 77 corpus must continue passing |

## Interface Contracts

- **Schema extension**: `PerStoryStateSchema` gains three optional fields. Manifests written by older substrate versions remain parseable (all new fields are `.optional()`).
- **No new runtime contracts** — this story does not add new orchestrator events, new CLI flags, or new pipeline behaviors. All changes are downstream-visible only via the per-story state.

## Dev Agent Record

### Agent Model Used
<to be filled in by dispatched agent>

### Completion Notes List
<to be filled in by dispatched agent>

### File List
<to be filled in by dispatched agent>

## Change Log
