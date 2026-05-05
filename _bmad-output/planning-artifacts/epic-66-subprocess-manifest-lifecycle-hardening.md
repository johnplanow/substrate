# Epic 66: Subprocess + Manifest Lifecycle Hardening

## Vision

Close three substrate-internal observations that share a common root
cause: **substrate's subprocess and manifest lifecycle has structural
gaps that contaminate verification signal and break recovery**.

- **obs_2026-05-03_022** (high) — orchestrator advances pipeline phases
  (create-story → test-plan → dev-story, files written) without
  persisting the manifest beyond the initial `IN_STORY_CREATION
  dispatched` write. `substrate resume` against the frozen manifest
  re-dispatches IN_STORY_CREATION and clobbers in-progress dev work.
- **obs_2026-05-04_023 layers 3+4** (medium) — `spawnSync` ETIMEDOUT
  failures look identical to logical misses in eval reports, and
  subprocess stderr/stdout is lost when the process is killed on
  timeout. (Layers 1+2 — eval-harness carve-out + timeout policy
  bump — shipped via Story 65-7 / v0.20.51–v0.20.52.)
- **obs_2026-05-04_024** (medium) — runtime probe executor does not
  substitute the `<REPO_ROOT>` placeholder before invoking shell.
  Probes containing `<REPO_ROOT>/path` reach the shell verbatim and
  fail with `grep: <REPO_ROOT>/path: No such file or directory` or
  `Syntax error: "&&" unexpected` (because `<` parses as input
  redirect). Surfaced in Stories 65-5 and 65-7 verification, both
  required manual `wg_stories.status='complete'` workarounds.

The three observations form a coherent unit because they share the
same architectural symptom: **invariants the runtime documents but
doesn't enforce** (manifest writes on phase advancement; placeholder
substitution; timeout telemetry; forensic capture). Closing them
together reduces churn — the audit, telemetry, and test surfaces
overlap.

## Root cause it addresses

Three subsurfaces of the same class:

1. **Manifest persistence is required by `substrate resume` but not
   enforced** by an invariant. The orchestrator's phase-advancement
   code paths sometimes skip `_writeChain.patchStoryState({phase})`
   calls, leaving the manifest frozen while the working tree advances.
   Epic 57 (v0.20.9) closed the lost-update race for
   `verification_result` / `cost_usd` / phase-COMPLETE; obs_022 shows
   the broader phase-advancement surface still has gaps.

2. **Subprocess lifecycle telemetry is silent**. The dispatcher's
   spawnSync retry from 300s → 450s is hardcoded and not telemetered.
   When an eval reports `failure_reason: "spawnSync node ETIMEDOUT"`,
   the operator can't distinguish "LLM was making progress, slightly
   larger budget would catch it" from "subprocess hung indefinitely".
   Layer 5: subprocess output is lost on kill, removing the only
   signal that could disambiguate.

3. **Runtime placeholder convention is documented but unenforced**.
   `packs/bmad/prompts/probe-author.md:113` teaches `<REPO_ROOT>` as
   the path-rooting convention, but the executor at
   `packages/sdlc/src/verification/probes/executor.ts` invokes the
   shell against the literal placeholder string. Verification fails
   on the placeholder, NOT on the implementation. probe-author quality
   metrics are corrupted because `authoredProbesFailedCount` increments
   on placeholder-not-substituted failures.

Each subsurface fixed in isolation would still leave the meta-class
("substrate machinery has documented contracts the runtime doesn't
enforce") un-addressed. Bundling them lets us extract a shared
testing pattern (assert invariant → drive runtime → check invariant
held) and a shared finding-category pattern.

## Why now

Three converging signals:

1. **obs_022 is the highest-severity open obs in the queue**. Data-loss
   class (re-dispatch clobbers in-progress dev work). Once a consumer
   hits this in production, recovery requires manual `git stash` +
   `dolt sql UPDATE` — operator-hostile.

2. **obs_024 is corrupting Epic 65 telemetry RIGHT NOW**. Stories 65-5
   and 65-7 shipped via manual `wg_stories.status='complete'` because
   verification ERROR-flagged probe-author quality on placeholder bugs.
   Class-summary metrics (Story 65-6) are reading false-negatives as
   real probe-author failures. Until obs_024 is fixed, the Epic 65
   ramp-up signal is contaminated.

3. **obs_023 layers 3+4 are the natural complement to layers 1+2**.
   Story 65-7 shipped layers 1+2 (eval-harness carve-out, timeout
   policy bump). Layers 3+4 (telemetry event, forensic capture) close
   the obs cleanly and produce a reusable telemetry primitive
   (`dispatch:spawnsync-timeout` event) that obs_022's heartbeat
   extension (Story 66-2) can consume.

## Story Map

- 66-1: orchestrator phase-advancement persistence audit and invariant test (P0, Medium)
- 66-2: heartbeat events carry per_story_state snapshot (P1, Small)
- 66-3: substrate resume manifest-vs-disk drift detector and force-from-manifest flag (P0, Medium)
- 66-4: dispatch spawnsync-timeout telemetry event emission (P1, Small)
- 66-5: subprocess kill preserves stderr and stdout for forensic capture (P1, Medium)
- 66-6: runtime probe executor substitutes REPO_ROOT placeholder (P0, Small)
- 66-7: new runtime-probe-placeholder-not-substituted finding category (P1, Small)

Story-to-observation mapping (for cross-reference):

- 66-1 closes obs_2026-05-03_022 fix #1
- 66-2 closes obs_2026-05-03_022 fix #2
- 66-3 closes obs_2026-05-03_022 fix #3
- 66-4 closes obs_2026-05-04_023 fix #3
- 66-5 closes obs_2026-05-04_023 fix #4
- 66-6 closes obs_2026-05-04_024 fix #1
- 66-7 closes obs_2026-05-04_024 fix #3

Sequencing rationale: 66-1 / 66-3 / 66-6 are the "stop the bleeding"
tier (data-loss prevention, false-negative suppression). 66-2 / 66-4 /
66-5 / 66-7 are the observability + forensic tier — they don't change
correctness but produce signal needed for operator confidence.

## Story 66-1: orchestrator phase-advancement persistence audit + invariant test

**Priority**: must

**Description**: Audit `src/modules/implementation-orchestrator/orchestrator-impl.ts`
phase-advancement code paths and ensure every phase transition emits
`_writeChain.patchStoryState({phase: <next>})`. The file already has
`patchStoryState(retry_count)` and `patchStoryState(cost_usd)` writes
plus a `patchStoryState(dispatched)` write at story-creation start
(line ~1209), but the empirical timeline in obs_022 shows phase
advancement (IN_STORY_CREATION → IN_TEST_PLANNING → IN_DEV → IN_REVIEW
→ IN_VERIFICATION → COMPLETE) does NOT consistently emit a
`patchStoryState({phase})` call.

Two parts:

1. **Audit + wire missing writes**: walk every code path that
   transitions `state.phase` for any story and ensure each transition
   is followed by a `_writeChain.patchStoryState(storyKey, { phase: <next> })`
   call. The `_writeChain` is best-effort; phase write failures must
   log a warning but not fail the dispatch (consistent with existing
   `patchStoryState(cost_usd)` pattern at line ~842).
2. **Invariant test**: add unit test
   `src/modules/implementation-orchestrator/__tests__/phase-advancement-persistence.test.ts`
   that constructs a stub orchestrator with a recording `_writeChain`,
   drives it through every phase transition, and asserts every
   transition emitted a `patchStoryState({phase: <expected>})` call.
   The test must FAIL if any phase transition is added in the future
   without a corresponding manifest write.

**Acceptance Criteria**:

1. Every phase transition (IN_STORY_CREATION → IN_TEST_PLANNING →
   IN_DEV → IN_REVIEW → IN_VERIFICATION → COMPLETE; plus ESCALATED
   side-states) in orchestrator-impl.ts emits a `_writeChain.patchStoryState({phase: <next>})`
   call within 1 statement of the in-memory `state.phase` update.
2. Phase write failures log a warning (`logger.warn`) but do not
   throw or fail the dispatch — preserves the best-effort contract
   of `_writeChain.patchStoryState`.
3. New invariant test in
   `src/modules/implementation-orchestrator/__tests__/phase-advancement-persistence.test.ts`
   asserts each transition emits a `patchStoryState({phase})` call.
   Test FAILS if a future code change adds a phase transition without
   a corresponding write.
4. Test uses a mock `_writeChain` that records all `patchStoryState`
   calls; assertions check call count + ordering of phase values.
5. Existing `patchStoryState(retry_count)`, `patchStoryState(cost_usd)`,
   `patchStoryState(dispatched)`, `patchStoryState(<status>)` calls
   remain unchanged (this story adds; does not remove).
6. Commit message references obs_2026-05-03_022 fix #1.

**Files involved**:
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (audit + wire)
- `src/modules/implementation-orchestrator/__tests__/phase-advancement-persistence.test.ts` (new test)

## Story 66-2: heartbeat events carry per_story_state snapshot

**Priority**: should

**Description**: Extend the existing `pipeline:heartbeat` event (emitted
every ~30s by the orchestrator) to include a snapshot of
`per_story_state[storyKey].phase` for every active story. This lets
operators (and downstream tooling) compare the heartbeat-emitted phase
against the manifest-recorded phase in real-time, catching obs_022-class
drift before the orchestrator dies.

This is observability in service of obs_022 fix #2. It does NOT replace
fix #1 (66-1's invariant test); it is a complementary signal for cases
where the orchestrator is healthy but the manifest is stale.

**Acceptance Criteria**:

1. `pipeline:heartbeat` event schema in `packages/sdlc/src/run-model/event-types.ts`
   gains a new optional field
   `per_story_state: Record<string, { phase: string; status: string }>`
   alongside the existing `completed_dispatches: number` field.
2. Orchestrator's heartbeat emission populates the new field with the
   current in-memory `state.phase` and `state.status` for each active
   story.
3. Existing heartbeat consumers (CLI status output, supervisor) MUST
   continue to work without modification — the field is additive and
   optional.
4. Unit tests assert: (a) heartbeat event includes the new field when
   stories are active; (b) heartbeat event omits the field (or emits
   empty object) when no stories are dispatched; (c) field shape
   matches the schema.
5. `substrate status --output-format json` surfaces the latest
   heartbeat-emitted `per_story_state` snapshot under a top-level
   `latest_heartbeat_per_story_state` key (or equivalent), so
   operators can `jq` the drift check.
6. Commit message references obs_2026-05-03_022 fix #2.

**Files involved**:
- `packages/sdlc/src/run-model/event-types.ts` (schema extension)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (heartbeat emission)
- `src/cli/commands/status.ts` (surface in CLI output)
- corresponding test files

## Story 66-3: `substrate resume` manifest-vs-disk drift detector + `--force-from-manifest` flag

**Priority**: must

**Description**: When `substrate resume` is invoked, detect whether
the recorded manifest phase is stale relative to the working-tree
state, and refuse to resume if drift is detected unless the operator
explicitly opts in with `--force-from-manifest`.

Drift signal: for each story in `per_story_state` whose
`phase === 'IN_STORY_CREATION' && status === 'dispatched'`, scan the
project's expected dev-story output paths (a configurable hint, with
sensible defaults: `packages/*/src/**/*.ts`, `src/**/*.ts`) for files
whose mtime is newer than the manifest's `updated_at`. If any are
found, the manifest is stale relative to disk → drift detected.

When drift is detected, `substrate resume` exits non-zero with a
clear message:

```
substrate resume: manifest drift detected for story <key>
  manifest phase: IN_STORY_CREATION dispatched (recorded <ago>)
  working tree:   <N> files newer than manifest (sample: <path1>, <path2>, ...)

This usually means the orchestrator died after writing dev-story output but
before persisting the phase advancement (obs_2026-05-03_022 class).
Re-dispatching from IN_STORY_CREATION would clobber that work.

Recovery options:
  1. Inspect the working tree, validate dev-story output, then commit it
     as if the pipeline had shipped LGTM — see obs_022 recovery runbook.
  2. To proceed with re-dispatch anyway (clobbering disk state),
     re-run with --force-from-manifest.
```

**Acceptance Criteria**:

1. `src/cli/commands/resume.ts` (or its helper) gains a
   `detectManifestDriftAgainstWorkingTree(manifest, projectRoot)`
   helper returning `{drifted: boolean, evidence: { storyKey: string, sampleFiles: string[] }[] }`.
2. The helper is invoked at the start of resume; if `drifted === true`
   and `--force-from-manifest` was NOT passed, resume exits non-zero
   with the error message above (or substantively similar).
3. New `--force-from-manifest` boolean flag on `substrate resume`
   bypasses the drift check.
4. Drift detection scans configurable globs (default:
   `packages/*/src/**/*.ts`, `src/**/*.ts`); the glob set is
   overridable via `SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS` env var
   (comma-separated).
5. Integration test in `__tests__/integration/resume-manifest-drift.test.ts`:
   creates a fake manifest at IN_STORY_CREATION with `updated_at` of
   `T - 600s`; writes a fake source file to a tmpdir at `T`; runs
   resume against the fake manifest and asserts non-zero exit + error
   message contains "manifest drift detected"; re-runs with
   `--force-from-manifest` and asserts resume proceeds.
6. Coexists with `substrate resume`'s existing semantics — when no
   drift is detected, resume behavior is unchanged (regression-test
   guarded with at least one fixture where the manifest is coherent
   with disk).
7. Commit message references obs_2026-05-03_022 fix #3.

**Files involved**:
- `src/cli/commands/resume.ts` (drift check + flag)
- new helper module (likely `src/cli/commands/resume-drift-detector.ts`)
- `__tests__/integration/resume-manifest-drift.test.ts` (new)

## Story 66-4: `dispatch:spawnsync-timeout` telemetry event emission

**Priority**: should

**Description**: When the dispatcher hits `ETIMEDOUT` on a `spawnSync`
invocation of an agent CLI (claude-code or otherwise), emit a new
`dispatch:spawnsync-timeout` event with full context. Currently the
ETIMEDOUT is observable only via the eval report's `failure_reason`
string; an event makes it queryable in OTEL persistence and lets the
supervisor / status CLI surface timeout patterns across runs.

**Acceptance Criteria**:

1. New event type `dispatch:spawnsync-timeout` declared in
   `packages/sdlc/src/run-model/event-types.ts` with shape:
   ```ts
   {
     type: 'dispatch:spawnsync-timeout',
     storyKey: string,
     taskType: string,           // e.g. 'probe-author', 'dev-story'
     attemptNumber: 1 | 2,        // 1 = initial, 2 = retry
     timeoutMs: number,           // the timeout that was exceeded
     elapsedAtKill: number,       // wall-clock from spawn to kill (ms)
     pid?: number,                // child PID if available
     occurredAt: string           // ISO timestamp
   }
   ```
2. `packages/core/src/dispatch/dispatcher-impl.ts` emits the event
   from the existing ETIMEDOUT catch path. Both attempt 1 (initial,
   300_000 ms default) and attempt 2 (retry, 450_000 ms default at
   1.5×) emit the event distinctly via `attemptNumber`.
3. `elapsedAtKill` is measured with `Date.now()` deltas around the
   spawnSync call.
4. Unit test asserts event is emitted with correct fields when
   spawnSync ETIMEDOUTs (use a deliberately-slow stub subprocess).
5. Backward-compat: legacy event consumers MUST continue to work —
   this event is additive.
6. Commit message references obs_2026-05-04_023 fix #3.

**Files involved**:
- `packages/sdlc/src/run-model/event-types.ts` (new event type)
- `packages/core/src/dispatch/dispatcher-impl.ts` (emit on timeout)
- corresponding test

## Story 66-5: subprocess kill preserves stderr/stdout for forensic capture

**Priority**: should

**Description**: When the dispatcher kills a subprocess on timeout
(via `proc.kill('SIGTERM')` then `proc.kill('SIGKILL')` escalation),
currently any stderr/stdout the subprocess had buffered is lost. This
removes the only signal that could disambiguate "LLM was making
progress" from "subprocess hung indefinitely with no output".

Fix: capture the subprocess's stderr and stdout into in-process
buffers continuously while the subprocess runs. On timeout-kill,
attach the captured tails to the `dispatch:spawnsync-timeout` event
emitted by Story 66-4.

**Acceptance Criteria**:

1. `packages/core/src/dispatch/dispatcher-impl.ts` accumulates
   subprocess stderr and stdout into bounded buffers (max ~64KB per
   stream, tail-window discipline — most recent bytes preserved).
2. On timeout-kill, the captured `stderrTail: string` and
   `stdoutTail: string` are attached to the
   `dispatch:spawnsync-timeout` event (extending the schema from
   Story 66-4).
3. Buffer caps are enforced — no unbounded memory growth even on
   subprocesses that emit large output streams.
4. Buffer encoding: assume UTF-8; bytes that don't decode cleanly are
   replaced with U+FFFD per standard Buffer.toString('utf8') semantics.
5. Test: spawn a subprocess that writes "PROGRESS_MARKER\n" to stderr,
   sleeps long enough to exceed timeout, then asserts the
   `dispatch:spawnsync-timeout` event's `stderrTail` contains
   "PROGRESS_MARKER".
6. Test: spawn a subprocess that writes 200KB to stderr (above the
   buffer cap) and assert the captured tail contains the FINAL bytes
   (proving tail-window discipline), not the initial bytes.
7. Backward-compat: when a subprocess exits cleanly (no timeout-kill),
   the buffers are not surfaced — they exist only as a forensic
   artifact for the timeout path.
8. Commit message references obs_2026-05-04_023 fix #4.

**Files involved**:
- `packages/core/src/dispatch/dispatcher-impl.ts` (buffer accumulation + attach on kill)
- `packages/sdlc/src/run-model/event-types.ts` (extend schema with optional tails)
- corresponding test

## Story 66-6: runtime probe executor substitutes `<REPO_ROOT>` placeholder

**Priority**: must

**Description**: The runtime probe executor at
`packages/sdlc/src/verification/probes/executor.ts` currently invokes
the shell against the literal probe `command:` string. probe-author
has been authoring probes that contain `<REPO_ROOT>/path` per the
convention documented in `packs/bmad/prompts/probe-author.md:113`,
but the executor doesn't substitute the placeholder. Result: probes
containing `<REPO_ROOT>` reach the shell verbatim and fail with
`grep: <REPO_ROOT>/...: No such file or directory` or
`Syntax error: "&&" unexpected`.

Fix: before invoking the shell, substitute `<REPO_ROOT>` (and the
shell-natural variant `$REPO_ROOT` env-var-style) with the executor's
`cwd` value (which is already `process.cwd()` per executor.ts line ~174).

**Acceptance Criteria**:

1. New helper `substituteRuntimePlaceholders(command: string, projectRoot: string): string`
   in `packages/sdlc/src/verification/probes/executor.ts` (or a
   sibling module). Replaces every literal `<REPO_ROOT>` substring
   with `projectRoot`. Replaces every `$REPO_ROOT` token (whitespace-
   or punctuation-bounded) with `projectRoot` as well.
2. The executor invokes `substituteRuntimePlaceholders(probe.command, cwd)`
   before passing to shell. Both `executeProbeOnHost` and `twin`
   sandbox paths apply substitution consistently.
3. Probes WITHOUT placeholders are unchanged byte-for-byte (no
   spurious substitution).
4. Probes containing `<REPO_ROOT>` appearing twice substitute both.
5. Probes containing unknown `<UNKNOWN_PLACEHOLDER>` strings reach
   the shell unchanged (Story 66-7 handles the unknown-placeholder
   finding category separately).
6. Tests: ≥4 unit tests covering positive cases, negative cases,
   double-occurrence, and unknown-placeholder pass-through. Use
   inline fixtures.
7. Integration test: author a probe with `cd <REPO_ROOT> && pwd`,
   run via the executor, assert exit 0 and stdout matches the
   expected projectRoot.
8. Backward-compat: any existing probe shell that legitimately
   contained the literal text `<REPO_ROOT>` (none expected) would
   change behavior — flagged in commit message as expected.
9. Commit message references obs_2026-05-04_024 fix #1.

**Files involved**:
- `packages/sdlc/src/verification/probes/executor.ts` (substitution helper + call site)
- `packages/sdlc/src/__tests__/verification/probes/executor.test.ts` (or new test file)

## Story 66-7: new `runtime-probe-placeholder-not-substituted` finding category

**Priority**: should

**Description**: When a probe shell fails AND the failure pattern
matches a placeholder-not-substituted shape (e.g.,
`grep: <[A-Z_]+>:`, `Syntax error.*&&.*unexpected` adjacent to a
literal `<NAME>` token), emit a richer finding category
`runtime-probe-placeholder-not-substituted` instead of the generic
`runtime-probe-fail`. This lets operators (and probe-author quality
dashboards) carve placeholder-class failures out from real runtime
failures.

Story 66-6 substitutes `<REPO_ROOT>` specifically. Story 66-7 catches
the residual class — any unrecognized `<UNKNOWN_PLACEHOLDER>` token
that escapes substitution.

**Acceptance Criteria**:

1. New finding category `runtime-probe-placeholder-not-substituted`
   added alongside existing categories (`runtime-probe-fail`,
   `runtime-probe-error-response`,
   `runtime-probe-missing-production-trigger`,
   `runtime-probe-missing-declared-probes`) in
   `packages/sdlc/src/verification/checks/runtime-probe-check.ts`.
2. Severity: `error` (matches `runtime-probe-fail` baseline).
3. Detection rule: when probe exits non-zero AND stderr/stdout
   matches `/^[\w]*:\s*<[A-Z_]+>:?/` (placeholder leakage pattern)
   OR contains `Syntax error: "&&" unexpected` immediately after a
   `<` literal token.
4. Finding includes a hint field: `unrecognizedPlaceholder: string`
   (the token that escaped substitution, e.g. `<UNKNOWN_VAR>`).
5. Tests: unit tests asserting category fires for representative
   stderr patterns (grep-no-such-file with placeholder, syntax-error
   with placeholder); does NOT fire for genuine runtime failures
   (assertion failures, exit-1 from real grep, syntax errors with no
   placeholder).
6. Backward-compat: probes that fail with non-placeholder patterns
   still emit `runtime-probe-fail` per existing semantics.
7. Commit message references obs_2026-05-04_024 fix #3.

**Files involved**:
- `packages/sdlc/src/verification/checks/runtime-probe-check.ts` (new category + detection)
- corresponding test additions

## Risks and assumptions

**Assumption 1 (orchestrator audit yields a tractable list of
phase transitions)**: 66-1's audit assumes `state.phase` updates in
orchestrator-impl.ts cluster around a small number of transition
points (~6-8 from the phase enum). If audit reveals a sprawl of
intermediate sub-phases not covered by the enum, 66-1 may need to
split into "audit + inventory" and "wire missing writes" sub-stories.

**Assumption 2 (heartbeat snapshot doesn't burst event size
unmanageably)**: 66-2 adds N×schema-fields to every 30s heartbeat.
For typical N≤10 active stories this is bounded; pipelines with
hundreds of concurrent stories would need pagination. Out of scope
for now (substrate's typical dispatch shape is N≤30).

**Assumption 3 (drift glob defaults are safe)**: 66-3's default scan
globs (`packages/*/src/**/*.ts`, `src/**/*.ts`) cover substrate's own
shape and most TypeScript consumer projects. Non-TypeScript consumers
(future) may need different defaults; the env-var override addresses
that.

**Risk: Story 66-1 surfaces new bugs**: the audit may reveal phase
transitions that were *never* persisted across the orchestrator's
history, not just the obs_022-specific gap. If true, fixing them all
may require additional sprint cycles. Acceptable — better to surface
them all in 66-1 than ship a partial fix.

**Risk: Story 66-3's drift detection produces false positives for
legitimate workflows**: e.g., an operator who *intends* to re-dispatch
a story whose source files were edited externally. Mitigation:
`--force-from-manifest` flag escapes the check. Operators who hit
false positives can opt out per-invocation.

**Risk: Story 66-5's buffer accumulation introduces overhead**: minor
runtime cost (constant per-byte memcpy). 64KB cap per stream is well
within reason for any reasonable subprocess. No mitigation needed.

## Dependencies

- **Story 65-7** (v0.20.51 / v0.20.52) — closed obs_023 layers 1+2
  (eval-harness carve-out + timeout policy bump). Epic 66 closes
  layers 3+4. No code dependency, but the obs file's status_history
  must transition from `partial-fix-shipped` → `resolved` after Epic
  66 ships.
- **Epic 57** (v0.20.9, SHIPPED) — `_writeChain` write-path
  serialization. Story 66-1 audits the consumers of `_writeChain`;
  no changes to `_writeChain` itself.
- **Epic 60 Phase 2** (v0.20.41, SHIPPED) — telemetry event
  infrastructure. Stories 66-2, 66-4, 66-5 reuse the existing event
  emission pattern.

## Out of scope

- **Auto-recovery from manifest drift** — Story 66-3 detects drift
  and refuses to resume; it does NOT auto-reconcile the manifest to
  match disk. Auto-reconciliation is a separate decision (would need
  to validate dev-story output, infer phase, etc.) — defer until the
  detection signal demonstrates need.
- **Universal placeholder substitution framework** — Story 66-6
  handles `<REPO_ROOT>` specifically; Story 66-7 catches unknown
  placeholders as a finding category. A general "executor knows about
  every placeholder convention" framework is out of scope; current
  conventions are scoped to `<REPO_ROOT>`.
- **Cross-process supervisor coordination on heartbeat drift** —
  Story 66-2 emits the heartbeat snapshot but does not extend the
  supervisor's automatic-restart logic to consume it. Supervisor-side
  consumption is a separate decision (need to validate the drift
  signal is actionable before automating on it).
- **Migration of pre-existing probes that contain `<REPO_ROOT>`** —
  Story 66-6 substitutes at runtime; no migration of stored probe
  text is needed.

## References

- obs_2026-05-03_022:
  `~/code/jplanow/strata/_observations-pending-cpo.md` lines 2020–2117
- obs_2026-05-04_023:
  `~/code/jplanow/strata/_observations-pending-cpo.md` lines 2119–2213
- obs_2026-05-04_024:
  `~/code/jplanow/strata/_observations-pending-cpo.md` lines 2295–2372
- Epic 57 (manifest write serialization, SHIPPED v0.20.9):
  `_bmad-output/planning-artifacts/epic-57-*.md`
- Story 65-7 (obs_023 layers 1+2, SHIPPED v0.20.52):
  `epic-65-probe-author-state-integrating-acs.md`

## Status history

| At | By | Status | Note |
|---|---|---|---|
| 2026-05-04 | party-mode session (jplanow + Mary + Winston + Bob + Quinn + Amelia) | open | Filed as joint sprint covering obs_022 (high) + obs_023 layers 3+4 (medium) + obs_024 (medium). Three substrate-internal observations sharing the "documented contract, unenforced runtime invariant" architectural pattern. Sequenced priority-first: 66-1 / 66-3 / 66-6 stop-the-bleeding tier; 66-2 / 66-4 / 66-5 / 66-7 observability + forensic tier. Substrate-on-substrate dispatch with `--max-review-cycles 3`. |
