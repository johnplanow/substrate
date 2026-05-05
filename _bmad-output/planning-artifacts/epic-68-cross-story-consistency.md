# Epic 68: Cross-Story Consistency and Diff Validation

## Vision

Close the recurring **cross-story interaction race** failure mode that
hit substrate-on-substrate dispatches in Epic 66 and Epic 67. When
multiple stories in the same dispatch modify the same file (typically
shared test files like `methodology-pack.test.ts` or
`verification-pipeline.test.ts`), substrate's concurrent-dispatch
loop produces transient verification failures because story A's
verification runs before story B's commit lands, even though both
stories' implementations are independently correct.

Empirical pattern from Epic 66 + Epic 67:

- **Epic 66 (run a832487a, 7 stories)**: 67-1's methodology-pack
  budget-bump landed AFTER 66-2/66-7 verification ran on un-bumped
  tree → checkpoint-retry-timeout escalations on 66-1 + 66-7.
  Recovery via /bmad-party-mode + Path A reconciliation.
- **Epic 67 (run a59e4c96, 3 stories)**: 67-1's methodology-pack
  budget-bump 30000→32000 landed AFTER 67-2's verification ran;
  67-3's new pipeline check landed AFTER same verification ran →
  pipeline reported `failed:["67-1","67-2"]` despite all on-disk
  state coherent.

In both cases, the eventual on-disk state was correct (build green,
tests pass, gates clean), but the pipeline's failure verdict was
misleading. Operators must run `/bmad-party-mode` panel review +
Path A reconciliation to recover. This is repeatable enough to be
classified as a substrate verification gap rather than incidental
dispatch noise.

## Root cause it addresses

Two related gaps:

1. **No pre-dispatch detection**: substrate's concurrency dispatch
   loop (orchestrator-impl.ts ~line 1500) assigns concurrent stories
   without checking whether they touch overlapping file paths. Stories
   are independent at the AC level but share verification-test-file
   dependencies.

2. **No post-completion contract validation**: when concurrent stories
   modify cross-story interfaces (shared types, exported symbols,
   shared test fixtures), there's no check that interface-modifying
   stories' contracts cohere. The substrate pipeline already emits
   `story:interface-change-warning` events (Story 60-15 telemetry) but
   no gate consumes them.

## Why now

Three signals:

1. **Two consecutive substrate-on-substrate dispatches hit the
   pattern** (Epic 66 + Epic 67), both requiring manual reconciliation.
   Each iteration adds operator workload + cognitive overhead.

2. **The pattern is observable today**: heartbeat events
   (Story 66-2) carry `perStoryState` snapshot; combined with
   Story 60-15's interface-change-warning telemetry, substrate has
   the raw signal it needs to detect collisions before they cause
   transient verification failures.

3. **Path A reconciliation is becoming a learned pattern but isn't
   self-documenting** — new operators encountering substrate
   dispatch failures don't know to /bmad-party-mode-review. Cross-story
   consistency check would either prevent the failure outright or
   surface a clear "concurrent-modification detected" finding that
   tells the operator what to do.

## Story Map

- 68-1: cross-story consistency check + diff validation (P0, Medium)

Single story, focused implementation. Larger Epic 54 follow-ons
(Recovery Engine, Structured Completion Report, etc.) deferred to
future epics if Epic 68 demonstrates the pattern works.

## Story 68-1: Cross-story consistency check + diff validation

**Priority**: must

**Description**: Implement the Verification Tier B
cross-story-consistency check originally scoped as Story 54-4
("Verification Tier B — Cross-Story Consistency and Diff Validation").
This is a fresh extraction with a focused scope: detect concurrent
file modifications across stories in the same dispatch, validate
shared interface coherence, and either gate dispatch or surface a
clear finding when a collision risks a transient verification
failure.

The check has two layers:

**Layer 1 — pre-dispatch concurrency-collision detection:**
- When the orchestrator assigns concurrent stories, scan each story's
  declared `target_files` (from the rendered story spec, if available)
  OR the recently-modified files from the corresponding dev-story
  agent's working tree
- If two concurrent stories target the same file path, emit a
  `dispatch:cross-story-file-collision` event and EITHER serialize
  the dispatches (preferred for now — small operator cost, prevents
  transient failures) OR continue with concurrency and emit a warning
  finding that operators can use to interpret subsequent verification
  failures correctly

**Layer 2 — post-completion contract validation:**
- When two stories complete and both have modified the same file, run
  `git diff --no-renames` against the shared file and check for:
  - conflicting type definitions (same identifier with different shapes)
  - duplicate namespace creation
  - contradictory exports
- Existing telemetry: substrate already emits
  `story:interface-change-warning` events with `modifiedInterfaces` +
  `potentiallyAffectedTests` arrays (Story 60-15, v0.20.41). Reuse
  this signal source.
- DiffValidationCheck runs `git diff --numstat <baseline>..<story>`
  filtering binary files; only runs if BuildCheck passed (broken code
  diffs are misleading)
- New finding category `cross-story-concurrent-modification` at
  severity `warn` initially (defensive rollout per Story 60-16
  pattern); promotion to `error` after empirical low-false-positive
  validation

**Acceptance Criteria:**

1. New module `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts`
   exporting `runCrossStoryConsistencyCheck(input)` matching the
   existing check shape (consult `runtime-probe-check.ts` or
   `source-ac-shellout-check.ts` for the contract).
2. Check registered in the verification pipeline (likely
   `packages/sdlc/src/verification/verification-pipeline.ts` and
   `checks/index.ts` registry wiring).
3. New event type `dispatch:cross-story-file-collision` declared in
   `packages/core/src/events/core-events.ts` and mirrored in
   `src/core/event-bus.types.ts` `OrchestratorEvents` (per Epic 66
   discipline — both interfaces must stay in sync, typecheck:gate
   catches mirror gaps).
4. Layer 1 detection: when orchestrator assigns concurrent stories,
   if two stories' `target_files` (or per-story modified file lists
   from working-tree state) intersect, emit
   `dispatch:cross-story-file-collision` event with `storyKeys`,
   `collisionPaths`, `recommendedAction: 'serialize' | 'warn'`.
5. Layer 2 detection: new finding category
   `cross-story-concurrent-modification` at severity `warn`. Fires
   when post-completion analysis shows two stories modified the same
   file AND interface signatures differ between commits.
6. DiffValidationCheck: only runs if BuildCheck passed (gate gate the
   gate); reports binary-filtered diff stats per story.
7. Tests in `packages/sdlc/src/__tests__/verification/cross-story-consistency-check.test.ts`:
   ≥6 cases including the canonical Epic 66 + Epic 67 reproduction
   fixtures (concurrent stories modifying methodology-pack.test.ts
   with conflicting budget assertions).
8. Backward-compat: existing checks continue to pass; new check is
   additive and conditional (only fires when run model has multi-story
   per_story_state with file-modification overlap).
9. Cite Epic 66 (run a832487a) + Epic 67 (run a59e4c96) as motivating
   incidents in the implementation file's header comment, per Story
   60-4/60-10 convention.
10. Commit message references the cross-story-interaction class +
    Epic 66/67 reconciliation pattern.

**Files involved:**
- `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts` (NEW)
- `packages/sdlc/src/verification/verification-pipeline.ts` (registry)
- `packages/sdlc/src/verification/checks/index.ts` (registry)
- `packages/sdlc/src/verification/findings.ts` (new finding category)
- `packages/core/src/events/core-events.ts` (new event type)
- `src/core/event-bus.types.ts` (mirror event type)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (Layer 1 collision detection in dispatch loop)
- `packages/sdlc/src/__tests__/verification/cross-story-consistency-check.test.ts` (NEW)

## Risks and assumptions

**Assumption 1 (target_files reliably available)**: Story specs may
not consistently declare `target_files` upfront, especially for
prompt-edit stories. Mitigation: Layer 1 falls back to runtime
detection via working-tree mtime comparison if `target_files` is
absent; still effective post-dev-story.

**Assumption 2 (serialize-on-collision is acceptable cost)**: Default
behavior on detected collision is serialize (run sequentially). This
adds ~5-10 min wall-clock for 2-story collisions but eliminates the
transient failure class. Operators can opt in to warn-only via
`--cross-story-policy=warn` flag (deferred — not in initial scope).

**Risk: detection over-fires.** Layer 1's "any two stories modify the
same file" rule may fire on benign cases (both stories adding
DIFFERENT functions to the same module). Mitigation: severity `warn`
initially, metric collection, escalation path per Story 60-16
pattern.

**Risk: 68-1 itself hits the cross-story interaction.** Single-story
dispatch eliminates the risk that triggered Epic 66 + 67. Self-applying
validation: 68-1 adds the very check that would have caught its own
predecessors' failures.

## Dependencies

- **Story 60-15** (v0.20.41) — telemetry events including
  `story:interface-change-warning` with `modifiedInterfaces` arrays.
  68-1 reuses this signal.
- **Epic 66 Story 66-2** (v0.20.57) — `perStoryState` snapshot in
  heartbeat events. 68-1 may consume this signal for runtime-side
  collision detection.
- **Epic 66 Story 66-3** (v0.20.57) — substrate resume drift
  detector. 68-1's Layer 2 reuses similar working-tree-state-scanning
  logic.

## Out of scope

- **Recovery Engine with Tiered Autonomy** (Story 54-1): deferred to
  potential Epic 70.
- **Decision Router with `--halt-on` flag** (Story 54-2): deferred.
- **Interactive Prompt and Notification Signal** (Story 54-3): deferred.
- **Structured Completion Report** (Story 54-5): deferred to potential
  Epic 69 (could ship in parallel since independent of dispatch flow).
- **Headless Invocation Support** (Story 54-6): deferred.
- **AC-to-Test Traceability Check** (Story 54-7): deferred.
- **Verification-to-Learning Feedback Loop** (Story 54-8): deferred.

These were originally scoped as Epic 54 / Phase D capstone but are
out of scope for Epic 68. Track Epic 68 effectiveness in 1-2 consumer
dispatches before deciding which Epic 54 stories warrant follow-on
epics.

## References

- Epic 66 (v0.20.57) — first cross-story-interaction race observed
  in substrate-on-substrate dispatch
- Epic 67 (v0.20.58) — second cross-story-interaction race; same
  failure mode (concurrent budget-bump landed after concurrent
  verification ran)
- Story 54-4 (Phase D plan, 2026-04-05) — original Epic 54
  scoping; this Epic 68 is a focused single-story extraction

## Status history

| At | By | Status | Note |
|---|---|---|---|
| 2026-05-05 | party-mode session (post-Epic 67 retrospective) | open | Filed after recurring cross-story-interaction race in Epic 66 + Epic 67 substrate-on-substrate dispatches. Single-story focused scope (extracted from Phase D Story 54-4 spec). Predecessor Story 54-4 wg_stories row marked `escalated` on 2026-05-05 dispatch attempt — failure was substrate's epic-shard-discovery couldn't locate Phase D file (multi-epic format, no `## Story Map` heading per parser expectation). Epic 68 ships the same intent in substrate-canonical single-epic-per-file format. Substrate-on-substrate dispatch with `--max-review-cycles 3`. |
