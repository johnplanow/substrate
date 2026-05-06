# Epic 69: Path A Reconciliation Primitive — `substrate reconcile-from-disk`

## Vision

Codify the **Path A reconciliation pattern** — used 3 times in one day
across Epic 66, Epic 67, and Epic 68 substrate-on-substrate dispatch
recoveries — into a first-class CLI primitive. When orchestrator dies
mid-dispatch or the pipeline reports `failed` on stories whose on-disk
state is actually coherent, operators currently run a 7-step manual
runbook (git status → build → test:fast → typecheck:gate →
check:circular → manual Dolt UPDATE → commit). `substrate
reconcile-from-disk` packages that runbook as a single command with
gate validation, atomic Dolt mutation, and operator confirmation.

Epic 69 is the **foundation primitive** for Stream A+B (Epic 69-74).
Epic 70 (Pipeline-verdict accuracy) and Epic 73 (Recovery Engine)
will call this primitive. Shipping it first unblocks the rest of the
sprint and immediately reduces operator workload on the next
substrate-on-substrate dispatch that hits a cross-story-interaction
race.

## Root cause it addresses

When substrate-on-substrate dispatch hits cross-story-interaction
races (Epic 66 → Epic 67 → Epic 68 pattern), the on-disk artifacts
land coherently — auto-committed `feat(story-N-M)` commits live in
git history, working-tree changes from incomplete stories live in
the tree, all gates green — but `wg_stories.status` rows in Dolt
remain stuck on intermediate states (`developing`, `verifying`,
`escalated`). The operator must:

1. Run `git status` to inventory survived working-tree changes
2. Run `npm run build` (gate)
3. Run `npm run check:circular` (gate)
4. Run `npm run typecheck:gate` (gate)
5. Run `npm run test:fast` (gate)
6. Connect to Dolt, manually `UPDATE wg_stories SET status='complete' WHERE ...`
7. Commit + version bump + ship

Steps 2-6 are mechanical, well-defined, and identical across
incidents. Step 1's diff is the input. Step 6's mutation is
deterministic given Step 1's output and Steps 2-5's pass.

The manual procedure is a runbook, not a craft skill. It belongs as
a primitive.

## Why now

Three signals:

1. **Three Path A reconciliations in one day** (Epic 66, Epic 67,
   Epic 68 ships, all 2026-05-05). Pattern recognition: this is
   recurring, not incidental.

2. **Stream A+B sprint plan depends on it.** Epic 70 (Pipeline-verdict
   accuracy) needs to **invoke** reconcile-from-disk programmatically
   when its retry logic determines tree state is coherent despite a
   `failed` verdict. Epic 73 (Recovery Engine) needs the same
   primitive for tier-A auto-recovery. Building Epic 69 first
   unblocks both.

3. **New-operator friction.** The /bmad-party-mode panel-review
   recovery pattern works but isn't self-documenting. New operators
   encountering pipeline `failed` verdicts on coherent trees don't
   know to trigger /bmad-party-mode + manual Dolt UPDATE. A primitive
   with a clear command name and `--dry-run` preview makes the
   recovery legible.

## Story Map

- 69-1: substrate reconcile-from-disk CLI command + Dolt mutation primitive (P0, Medium)

Single story, focused implementation. Auto-recovery semantics
(no-prompt, programmatic invocation from Recovery Engine) deferred
to Epic 70 / 73.

## Story 69-1: `substrate reconcile-from-disk` CLI command

**Priority**: must

**Description**: Implement a new `substrate reconcile-from-disk`
CLI command at `src/cli/commands/reconcile-from-disk.ts` that
reconciles `wg_stories.status` against actual working-tree + git
history state for stories in an active or recently-completed
pipeline run.

The command operates in three phases:

**Phase 1 — Discovery:**
- Resolve target run via `--run-id <id>` flag OR (default) the
  latest run from the run manifest (`.substrate/runs/manifest.json`)
- Load the run manifest and identify stories with
  `status NOT IN ('complete', 'cancelled')` — these are the
  candidates for reconciliation
- For each candidate story:
  - Look for auto-committed `feat(story-<key>)` commits in git history
    since `manifest.started_at` (`git log --oneline --since=<ts>
    --grep "feat(story-<key>"`)
  - Look for working-tree modifications to files declared in the
    story's `target_files` (if available in manifest) OR scan
    working-tree changes since `manifest.started_at`
    (`git diff --name-only HEAD@{<ts>} HEAD` if reflog available,
    falling back to `git status --porcelain`)
  - Build per-story diff: { storyKey, autoCommittedSha, modifiedFiles[] }

**Phase 2 — Validation (gate chain, fail-fast):**
- Run `npm run build` (timeout 180s)
- Run `npm run check:circular` (timeout 60s)
- Run `npm run typecheck:gate` (timeout 120s)
- Run `npm run test:fast` (timeout 300s)
- If ANY gate fails: surface failure output, do NOT reconcile,
  exit code 1 with `pipeline:reconcile-gate-failed` event

**Phase 3 — Reconciliation (operator-confirmed):**
- Print human-readable plan: per-story diff summary + which stories
  will be marked `complete`
- Prompt operator: `Reconcile N stories to status='complete'? [y/N]`
  (skip if `--yes` flag passed)
- On confirmation: open single Dolt transaction, run
  `UPDATE wg_stories SET status='complete', updated_at=<utc-now>
  WHERE story_key IN (<candidates>) AND run_id = <run_id>` for all
  candidates atomically
- On decline: exit 0 (clean), no Dolt write
- Emit `pipeline:reconcile-from-disk` event with affected_stories[],
  gates_passed[], operator_confirmed bool

**Acceptance Criteria:**

1. New command file `src/cli/commands/reconcile-from-disk.ts`
   exporting a Commander subcommand registered in
   `src/cli/index.ts`. Command shape:
   `substrate reconcile-from-disk [--run-id <id>] [--dry-run]
   [--yes] [--output-format <human|json>]`.

2. **`--run-id` resolution**: when omitted, default to the most
   recent run in `.substrate/runs/manifest.json`. When no runs
   exist, exit 1 with friendly error pointing at `substrate
   metrics --output-format json` for run history.

3. **Discovery phase**: for each non-`complete`,
   non-`cancelled` story in the run manifest, build a per-story
   diff record: `{ storyKey, autoCommittedSha?: string,
   modifiedFiles: string[], reconcilable: boolean }`. `reconcilable`
   is `true` iff the story has either an auto-commit OR
   working-tree changes that match its `target_files` declaration.

4. **Validation phase**: run gates in order: build →
   check:circular → typecheck:gate → test:fast. Each gate via
   `child_process.spawnSync` with explicit timeout (180/60/120/300s
   respectively). On any gate failure: capture stderr/stdout (64KB
   tail-window per Story 66-5 pattern), emit
   `pipeline:reconcile-gate-failed` event, exit code 1.

5. **Reconciliation phase**: present plan to operator (per-story
   diff summary), prompt `[y/N]` unless `--yes` passed. On
   confirmation, open Dolt transaction via existing
   `DoltClient.transact()` (Story 53-14 pattern); UPDATE all
   candidate stories' `status='complete'` + `updated_at` in single
   transaction; commit. On decline OR `--dry-run`: print plan,
   exit 0, no Dolt write.

6. **`--dry-run` flag**: skips both gate execution AND Dolt
   mutation. Prints discovery output + would-run gate list +
   would-update story list. Exit 0.

7. **`--yes` flag**: skips operator confirmation prompt. Used for
   programmatic invocation from Epic 70 / 73 (deferred). Gates
   STILL run; gate failure still aborts.

8. **`--output-format json`**: structured output with
   `{ runId, candidates: [...], gateResults: [...], reconciled:
   boolean, affectedStoryKeys: [...] }`. Default human-readable.

9. **Idempotency**: re-running on a run where all candidate
   stories are already `complete` is a no-op — exit 0 with
   `affectedStoryKeys: []`.

10. **New event types** declared in
    `packages/core/src/events/core-events.ts` AND mirrored in
    `src/core/event-bus.types.ts` `OrchestratorEvents` (per Epic 66
    Story 66-4 typecheck:gate discipline — both interfaces must
    stay in sync, typecheck:gate catches mirror gaps):
    - `pipeline:reconcile-from-disk` — `{ runId, affectedStories,
      gatesPassed, operatorConfirmed, durationMs }`
    - `pipeline:reconcile-gate-failed` — `{ runId, failedGate,
      stderrTail, stdoutTail, durationMs }`

11. **Tests** at `src/__tests__/cli/reconcile-from-disk.test.ts`
    (unit, ≥7 cases): (a) discovery with auto-commit detection,
    (b) discovery with working-tree-change detection, (c) gate
    failure → no Dolt write + exit 1, (d) operator decline → no
    Dolt write + exit 0, (e) idempotency on already-reconciled
    run, (f) `--dry-run` skips both gates and write, (g) no active
    run → friendly error.

12. **Integration test** at
    `__tests__/integration/reconcile-from-disk.test.ts` (≥1
    end-to-end case using real `mktemp -d` fixture per Story
    65-5/67-2 discipline): real git init + real Dolt fixture +
    real `feat(story-N-M)` commit + real working-tree change →
    real reconcile-from-disk invocation → asserts Dolt row
    transitioned to `complete`.

13. **Header comment** in implementation file cites Epic 66
    (run a832487a), Epic 67 (run a59e4c96), and Epic 68
    (run a59e4c96-13e0-4727-8f46-6aa95a7e134c) as motivating
    Path A reconciliation incidents, per Story 60-4/60-10
    convention.

14. **Commit message** references Path A reconciliation pattern +
    Epic 66/67/68 motivating incidents + that this is the
    foundation primitive for Epic 70 / 73.

**Files involved:**
- `src/cli/commands/reconcile-from-disk.ts` (NEW)
- `src/cli/index.ts` (register subcommand)
- `packages/core/src/events/core-events.ts` (new event types)
- `src/core/event-bus.types.ts` (mirror event types)
- `src/__tests__/cli/reconcile-from-disk.test.ts` (NEW)
- `__tests__/integration/reconcile-from-disk.test.ts` (NEW)

**Tasks / Subtasks:**

- [ ] AC1: implement Commander subcommand `reconcile-from-disk` with
      flags `--run-id`, `--dry-run`, `--yes`, `--output-format`
- [ ] AC2: run-id resolution + manifest loading + friendly
      no-active-run error
- [ ] AC3: discovery phase — per-story diff record building
- [ ] AC4: gate-chain validation phase with timeout per gate +
      stderr/stdout tail capture on failure
- [ ] AC5: reconciliation phase — operator confirmation + Dolt
      atomic transaction
- [ ] AC6: `--dry-run` skips gates AND Dolt mutation
- [ ] AC7: `--yes` skips confirmation, gates still run
- [ ] AC8: `--output-format json` structured output
- [ ] AC9: idempotency on already-reconciled run
- [ ] AC10: new event types declared + mirrored both interfaces;
      typecheck:gate validates mirror coherence
- [ ] AC11: unit tests (≥7 cases)
- [ ] AC12: integration test with mktemp fixture
- [ ] AC13: header comment citations
- [ ] AC14: commit message follows convention

## Risks and assumptions

**Assumption 1 (run manifest is authoritative for non-complete
candidates)**: `.substrate/runs/manifest.json` is the source of
truth for active-run story state per Story 52-3+ "manifest
authoritative, Dolt degraded fallback" decision. Discovery reads
the manifest, not Dolt. Mitigation: if manifest is missing or
malformed, exit 1 with "no recoverable state" error pointing at
manual recovery.

**Assumption 2 (gate chain composition matches CI)**: build →
check:circular → typecheck:gate → test:fast IS the substrate CI
gate chain (per `.claude/commands/ship.md`). If CI evolves (e.g.,
adds linting), this primitive must update in lockstep. Mitigation:
read gate list from `package.json` scripts at runtime — out of
scope for 69-1, defer to Epic 75 if needed.

**Assumption 3 (auto-commits use `feat(story-<key>):` prefix)**:
substrate's dev-story phase auto-commits with this exact prefix
(per memory note). If substrate ever changes the auto-commit
message format, discovery's `git log --grep` regex must update.
Mitigation: regex is `/^feat\(story-([0-9]+-[0-9]+)\)/m`,
configurable via constant, validated by unit test.

**Risk: Dolt transaction fails mid-batch.** If reconciling 5
stories and Dolt connection drops at story 3, partial state.
Mitigation: use existing `DoltClient.transact()` (Story 53-14
pool-pinning + statement-batching). Single transaction guarantees
atomicity per Story 53-14 contract.

**Risk: 69-1 itself hits cross-story-interaction race during
substrate-on-substrate dispatch.** Single-story epic eliminates
the risk that triggered Epic 66+67+68. Self-applying validation:
69-1 ships the exact primitive that would have automated its own
ship's Path A recovery if it had occurred.

**Risk: operator runs reconcile-from-disk against the wrong
run-id.** Mitigation: `--dry-run` is the default discipline;
operator confirms run-id + affected stories before mutation. Plan
output shows `runId: <id>` prominently.

## Dependencies

- **Story 53-14** (v0.19.42) — `DoltClient.transact()` with
  pool-pinning + CLI batching. 69-1 reuses this for atomic
  multi-story status update.
- **Story 52-3+** (v0.19.30+) — Run manifest format
  (`.substrate/runs/manifest.json`) with `started_at` per-run +
  per-story state. 69-1 reads this format.
- **Story 66-3** (v0.20.57) — substrate resume drift detector. 69-1
  reuses similar working-tree-state-scanning logic at
  `src/cli/commands/resume-drift-detector.ts`.
- **Story 66-5** (v0.20.57) — subprocess stderr/stdout 64KB
  tail-window forensic capture pattern. 69-1 uses identical
  pattern for gate failure capture.
- **Story 60-15** (v0.20.41) — telemetry event mirror discipline
  (CoreEvents + OrchestratorEvents). 69-1 follows same pattern
  for new event types.

## Out of scope

- **Auto-recovery (no-prompt) auto-reconcile**: deferred to Epic 70
  / 73. Initial scope is operator-confirmed primitive only.
- **Re-running failed stories with fresh fix-context**: Epic 70
  scope (Pipeline-verdict accuracy).
- **Tiered autonomy (Recovery Engine with `--halt-on`)**: Epic 73
  scope.
- **Reconcile across multiple runs in one invocation**: out of
  scope; single-run primitive only.
- **Auto-commit + version bump + push**: out of scope; primitive
  stops at Dolt mutation. Operator continues to Path A step 6
  (`/ship`) manually.

## References

- Epic 66 (v0.20.57, 2026-05-05) — first Path A reconciliation
  incident in substrate-on-substrate dispatch (run a832487a)
- Epic 67 (v0.20.58, 2026-05-05) — second Path A reconciliation
  (run a59e4c96)
- Epic 68 (v0.20.59, 2026-05-05) — third Path A reconciliation
  + ships the cross-story-consistency check that Epic 70 will
  build on
- `.claude/commands/ship.md` Step 5 "auto-commit awareness" —
  documents the 7-step manual Path A pattern this primitive
  codifies
- Phase D Plan 2026-04-05 — original Epic 54 capstone scoping
  (Recovery Engine + Decision Router) which this primitive is
  the foundation for

## Status history

| At | By | Status | Note |
|---|---|---|---|
| 2026-05-05 | party-mode session (post-Epic 68 retrospective) | open | Filed as foundation primitive for Stream A+B sprint plan (Epic 69-74). Codifies Path A reconciliation pattern used 3 times in one day across Epic 66 + Epic 67 + Epic 68 ships. Single-story focused scope; auto-recovery semantics defer to Epic 70 + 73. Substrate-on-substrate dispatch with `--max-review-cycles 3`. |
