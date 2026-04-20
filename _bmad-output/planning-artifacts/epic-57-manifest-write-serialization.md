# Epic 57: Manifest Write Serialization & Verification Visibility

## Vision

Close the lost-update race in `RunManifest.patchStoryState()` that silently
drops fields when concurrent fire-and-forget patches interleave, and give
operators a way to distinguish "verification ran clean" from "verification
did not run at all" in `substrate status` / `substrate metrics` JSON.

Source: strata agent report 2026-04-19. For Story 1-11a (run_id
`e4bef458-01ad-484e-aa98-e55a57123397`), `per_story_state['1-11a']`
shipped with `verification_result === undefined` while a prior story
`1-8` in the same session had a fully populated `verification_result`.
Both stories went through the same orchestrator code path; the
difference was solely timing. The strata report correctly identified
that the v0.20.6 `rollupFindingCounts()` reader returns
`{error:0, warn:0, info:0}` for absent results, making "skipped" and
"clean" indistinguishable in the CLI output.

## Root Cause

`packages/sdlc/src/run-model/run-manifest.ts:358-407`
(`patchStoryState()`) performs read → merge → write without optimistic
concurrency control. The orchestrator fires **three concurrent
non-awaited** `patchStoryState` calls on the LGTM_WITH_NOTES →
COMPLETE transition:

1. `persistVerificationResult()` → `{ verification_result: summary }` —
   `src/modules/implementation-orchestrator/verification-integration.ts:142`
2. `updateStory({ phase: 'COMPLETE', ... })` → `{ status, phase,
   completed_at, review_cycles, dispatches }` —
   `src/modules/implementation-orchestrator/orchestrator-impl.ts:1192`
3. `writeStoryMetricsBestEffort()` → `{ cost_usd }` —
   `src/modules/implementation-orchestrator/orchestrator-impl.ts:807`

Whichever writer reads the manifest after the others have issued their
reads — but before they've written — silently drops any fields set by
the concurrent writers. Classic lost update.

## Scope

### Sprint 1 — Fix + Observability Signal

Three stories, correctness-first ordering. All touch the same surface
(`RunManifest` + orchestrator wiring + status/metrics CLI readers), so
same-surface dispatch rule permits a single batch.

---

### Story 57-1: Serialize Manifest Writes via Per-Instance Promise Chain

**Priority**: must

**Description**: Add a single in-memory promise chain on the
`RunManifest` instance so that all writes — `write()`, `patchStoryState()`,
`patchCLIFlags()`, `appendRecoveryEntry()` — execute strictly
sequentially. Callers retain their non-blocking fire-and-forget
behavior, but the patch operations themselves no longer race. This is
the primary fix for the lost-update bug that dropped
`verification_result` from the strata 1-11a manifest.

**Acceptance Criteria**:
- `RunManifest` gains a private `_writeChain: Promise<void>` field,
  initialized to `Promise.resolve()`
- Every public mutation method (`write`, `patchStoryState`,
  `patchCLIFlags`, `appendRecoveryEntry`) awaits and then replaces
  `_writeChain` with `this._writeChain.then(() => doActualWork())`
- The returned promise from each mutation still resolves when that
  call's work completes (so existing `.catch()` fire-and-forget
  callers continue to log warnings on failure)
- A regression test fires N=100 concurrent
  `patchStoryState('s', { fieldA })` / `patchStoryState('s', { fieldB })`
  / `patchStoryState('s', { fieldC })` calls; the final manifest read
  must contain all three fields with zero losses across 10 runs
- No behavioral change to single-threaded callers (existing tests pass
  unchanged)
- A failure in one queued write must not block subsequent queued
  writes — the chain catches and logs, then continues

**Key File Paths**:
- `packages/sdlc/src/run-model/run-manifest.ts` (modify)
- `packages/sdlc/src/run-model/__tests__/run-manifest-concurrent-writes.test.ts` (new)

**FRs:** MO-1 (data integrity under concurrency)

---

### Story 57-2: Await Verification-Result Persist Before COMPLETE Transition

**Priority**: must

**Description**: Belt-and-suspenders defense for Story 57-1: the
orchestrator's LGTM_WITH_NOTES → COMPLETE and auto-approve → COMPLETE
paths must `await` the verification-result manifest write before the
phase-COMPLETE patch fires. This guarantees ordering even if a future
caller bypasses the write-chain queue. Also adds an invariant warning
when a story transitions to COMPLETE with
`config.skipVerification !== true` but `per_story_state[storyKey]
.verification_result` is absent — loud log line, not a throw, so the
pipeline still ships but the anomaly surfaces in operator review.

**Acceptance Criteria**:
- `persistVerificationResult()` in
  `src/modules/implementation-orchestrator/verification-integration.ts`
  gains a companion `persistVerificationResultSync()` (or returns the
  underlying promise); call sites in the LGTM_WITH_NOTES and
  auto-approve COMPLETE paths in
  `src/modules/implementation-orchestrator/orchestrator-impl.ts` await
  the write before calling `updateStory({ phase: 'COMPLETE', ... })`
- A post-COMPLETE invariant check runs at the terminal-transition site:
  if `config.skipVerification !== true` AND the manifest's
  `per_story_state[storyKey].verification_result` is undefined after
  the patch, log a `warn`-level line with category
  `verification-result-missing` and the storyKey
- Existing non-fatal posture preserved: a manifest write failure still
  only warns, never throws; the invariant check is advisory
- Unit test: assert the verification_result patch promise is awaited
  before the phase-COMPLETE patch on the LGTM_WITH_NOTES path
- Unit test: assert the invariant warning fires when
  `verification_result` is absent post-COMPLETE

**Key File Paths**:
- `src/modules/implementation-orchestrator/verification-integration.ts` (modify)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (modify, two call sites near line 3018 and 3296)
- `src/modules/implementation-orchestrator/__tests__/verification-integration.test.ts` (extend)

**FRs:** MO-3 (verification coverage)

---

### Story 57-3: Surface `verification_ran` Signal in Status and Metrics JSON

**Priority**: must

**Description**: Add a `verification_ran: boolean` field alongside the
existing `verification_findings: {error, warn, info}` in the per-story
rollup of `substrate status --output-format json` and `substrate
metrics --output-format json`. True when `per_story_state[storyKey]
.verification_result` is present (any status), false when absent. This
gives operators and the mesh reporter a way to distinguish
"verification ran and found nothing" from "verification did not run"
— independent of whether the underlying cause is `--skip-verification`,
a race, or a broken code path.

**Acceptance Criteria**:
- `src/cli/commands/status.ts` per-story rollup includes
  `verification_ran: verificationResult !== undefined && verificationResult !== null`
- `src/cli/commands/metrics.ts` per-story rollup includes the same
  `verification_ran` field
- `verification_findings` field continues to report
  `{error:0, warn:0, info:0}` for both cases (back-compat — existing
  consumers don't break)
- Unit tests updated for both CLIs to assert `verification_ran: true`
  when verification_result is present and `verification_ran: false`
  when absent
- The agent-mesh reporter
  (`src/modules/telemetry/mesh-reporter.ts`) forwards the new field so
  downstream dashboards can distinguish the two cases

**Key File Paths**:
- `src/cli/commands/status.ts` (modify)
- `src/cli/commands/metrics.ts` (modify)
- `src/cli/commands/__tests__/status-verification-findings-counts.test.ts` (extend)
- `src/cli/commands/__tests__/metrics-verification-findings-counts.test.ts` (extend)
- `src/modules/telemetry/mesh-reporter.ts` (modify)

**FRs:** MO-3 (telemetry accuracy)

---

## Out of Scope (separate epics)

- **Graph-engine verification handler**: `packages/sdlc/graphs/sdlc-pipeline.dot`
  has no verification node and no `SdlcVerificationHandler` exists. Stories
  using `--engine=graph` ship with no Tier A gate at all. Separate epic.
- **AC-evidence severity policy**: 1-11a's missing AC-named deliverables
  (`ollama-client.ts`, `telemetry.ts`, `real-ollama-chat-probe.mjs`) may
  have been flagged as `warn` not `error` by the AC-evidence check, so the
  story proceeded to COMPLETE despite the gap. Policy question for a
  separate epic: when the check observes a hard miss on an AC-enumerated
  new-file path, should it escalate to `error` and gate the ship?
