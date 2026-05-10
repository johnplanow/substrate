# Epic 75: Worktree Wiring Into Dispatch — make the README's claim true

## Vision

Wire git worktrees into substrate's main dispatch path. Each dispatched story runs in its own git worktree on its own branch (`substrate/story-<key>`). The agent's `git commit` (it auto-commits as a tool use, not substrate code) lands on the branch instead of main. After SHIP_IT verification, a new `merge-to-main` phase merges the branch back. After failure, the branch is preserved for `substrate reconcile-from-disk` inspection (Epic 76 extends reconcile to read branches).

## Root cause it addresses

A 2026-05-10 code audit revealed substrate has NEVER created worktrees in the dispatch path. Every `dispatcher.dispatch()` call passes `workingDirectory: deps.projectRoot` — the main project root — across 14 dispatch sites in `src/modules/compiled-workflows/*.ts` and `src/modules/implementation-orchestrator/orchestrator-impl.ts`. The variable name `worktreePath` in `packages/core/src/dispatch/dispatcher-impl.ts:584` is misleading — it's actually `workingDirectory ?? process.cwd()`, never a worktree.

`GitWorktreeManager` exists in `packages/core/src/git/git-worktree-manager-impl.ts` and subscribes to `task:ready` / `task:complete` / `task:failed` events. **Those events are emitted nowhere.** The manager is dead code outside operator commands (`substrate worktrees`, `substrate merge`).

The README claims:
- Line 9: "coordinating multiple AI coding agents across isolated worktree branches"
- Line 24: "Dispatches work to worker agents in parallel worktrees"
- Line 38: "dispatches 5 stories across 3 agents in parallel worktrees"
- Line 156: "Stories run in parallel across your available agents, each in its own git worktree"
- Line 167: "build succeeds against the dev's worktree"

All five are inaccurate today. Substrate's actual concurrency mechanism is "conflict groups" — stories in the same group serialize, different groups run in parallel, all in the same working tree. Cross-story races (two stories in different conflict groups touching the same file) are silent at write time and only caught post-hoc by Epic 70's auto-recovery.

## Why now

1. **Just discovered**: a 2026-05-10 dispatch-path audit confirmed the gap. The code receipt is conclusive — `grep -rn "\.createWorktree(" src packages` returns zero call sites outside the manager itself and operator-CLI commands.
2. **Architecture validated**: a 2026-05-10 spike created `.substrate-worktrees/story-<key>` on a fresh branch + simulated agent commit. Branch advanced; main HEAD unchanged. `git worktree add` + `cwd: <worktree>` is sufficient — no substrate code change needed for the auto-commit-on-branch behavior because the agent runs `git commit` itself (as a tool use) in whatever cwd substrate provides.
3. **Path E priority from operator**: explicit user choice on 2026-05-10 to pursue this as a real epic before Path B (CPO Bridge) and Path C (Strata dispatch).
4. **No migration period requested**: per operator decision 2026-05-10, this ships as default-on with `--no-worktree` as safety valve only — not a transition flag.
5. **README's claim is currently a lie**. Either fix the docs (cheap option, never chosen by this codebase's culture) or fix the code. We're fixing the code.

## Story Map

- 75-1: Productionize per-story worktree creation (P0, Medium)
- 75-2: `merge-to-main` phase after SHIP_IT (P0, Medium)
- 75-3: `--no-worktree` opt-out flag + `SUBSTRATE_NO_WORKTREE=1` env var (P0, Small)
- 75-4: Orchestrator + dispatch test updates (P0, Medium)
- 75-5: README + CLAUDE.md scaffold + `--help-agent` docs alignment (P0, Small)

Five focused stories. Telemetry events (`worktree:created`, `worktree:merged`, `worktree:abandoned`), `substrate reconcile-from-disk --branch <name>` extension, and the cross-story-isolation integration test deferred to Epic 76.

## Story 75-1: Productionize per-story worktree creation

**Priority**: must

**Description**: Wire `GitWorktreeManager.createWorktree()` into `processStory()` in the orchestrator. After the memory-pressure check (line 1531 in `src/modules/implementation-orchestrator/orchestrator-impl.ts`), create a per-story worktree at `.substrate-worktrees/story-<key>` on a new branch `substrate/story-<key>` rooted at the orchestrator's start HEAD. Override `projectRoot` for ALL phase dispatches within that story (create-story, test-plan, dev-story, code-review, build-fix, probe-author) so every agent invocation runs with `cwd: <worktree>`.

The 2026-05-10 spike at `spike/worktree-dispatch` proved the architecture but only overrode `dev-story`'s deps. Production must override every phase via a per-story `effectiveProjectRoot` pattern.

**Acceptance Criteria:**

1. **Orchestrator instantiates `GitWorktreeManager`** in its constructor (or accepts it as an injected dep) using the orchestrator's existing `eventBus` + `projectRoot`. Use the canonical factory: `createGitWorktreeManager({ eventBus, projectRoot })` from `packages/core/src/git/git-worktree-manager-impl.ts:432`.

2. **Per-story worktree created at story start**: in `processStory()` between lines 1531 (after memory check) and 1533 (before create-story phase), call `worktreeManager.createWorktree(storyKey)`. Branch name: `substrate/story-<storyKey>` (matches existing `BRANCH_PREFIX` constant). Worktree path: `.substrate-worktrees/story-<storyKey>` relative to projectRoot. Failure to create the worktree MUST throw — do NOT silently fall back to projectRoot. The whole point is isolation; silent fallback defeats it.

3. **`effectiveProjectRoot` threaded through all phase deps**: every site in `processStory()` (and helper closures within) that constructs phase deps with `projectRoot` MUST use `effectiveProjectRoot` (the per-story worktree path) instead. Specifically: lines 2572-2575, 2672-2675, 3550 (runDevStory call sites), and any other dispatch deps — verify by grep of `projectRoot,` within `processStory()` after this change.

4. **Gap-1 fix in `git-utils.ts:208`**: before `git worktree add`, check whether the worktree directory already exists. If yes AND `git worktree list --porcelain` does NOT mention it (orphan), preemptively call `cleanupAllWorktrees()` to clear orphans, then create. If the dir is registered AND clean, fail with a clear error pointing to `substrate worktrees --cleanup`. This closes the audit's gap-1.

5. **Cleanup on story success/failure**: when `processStory()` exits successfully OR throws, the worktree is NOT removed by this story (Story 75-2 handles success-path merge + remove; failure-path keeps the worktree and branch for `substrate reconcile-from-disk` inspection per Epic 76). This story's contract: create the worktree, override the cwd, return.

6. **Behavior under `--no-worktree`**: Story 75-3 adds the opt-out flag. This story's contract is "default ON". When the flag is set (Story 75-3 lands first or in parallel), the entire worktree-creation block short-circuits and `effectiveProjectRoot` falls back to `projectRoot`. AC8 requires this story to consume the opt-out signal.

7. **Tests** at `src/modules/implementation-orchestrator/__tests__/per-story-worktree.test.ts`:
   - (a) on `processStory()` start, `worktreeManager.createWorktree()` is invoked exactly once with the story key
   - (b) phase deps construction uses the worktree path (assert via mock dispatcher capturing the `workingDirectory` passed in)
   - (c) two sequential stories produce two separate worktree directories + branches
   - (d) when worktree creation throws (mock failure), `processStory()` propagates the error (does not silently fall back)
   - (e) when `--no-worktree` config is set, no worktree is created and `effectiveProjectRoot === projectRoot`

8. **CRITICAL: use canonical helpers** (per Stream A+B durable lesson):
   - `createGitWorktreeManager` from `@substrate-ai/core` — do NOT instantiate `GitWorktreeManagerImpl` directly
   - Branch naming uses the existing `BRANCH_PREFIX` constant from `git-worktree-manager-impl.ts`
   - Worktree path derivation uses `manager.getWorktreePath(taskId)` if available; else `path.join(projectRoot, '.substrate-worktrees', taskId)`

9. **Header comment** cites Path E spike (2026-05-10) + the 14 dispatch sites in compiled-workflows + orchestrator-impl.ts that previously passed bare projectRoot.

10. **No package additions**.

**Files involved:**
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (instantiate manager + per-story worktree + thread effectiveProjectRoot through every phase deps construction)
- `packages/core/src/git/git-utils.ts` (gap-1 fix: existing-worktree-dir check + recovery)
- `src/modules/implementation-orchestrator/__tests__/per-story-worktree.test.ts` (NEW)

## Story 75-2: `merge-to-main` phase after SHIP_IT

**Priority**: must

**Description**: After verification SHIP_IT, substrate must merge the story branch back to main (or whatever the orchestrator's start branch was), then remove the worktree. Today substrate doesn't merge anything because everything's already on main; with 75-1's per-story branches, merging becomes mandatory.

**Acceptance Criteria:**

1. **New phase `merge-to-main`** runs after `verification` passes (SHIP_IT) and before the story is marked COMPLETE. Implementation lives at `src/modules/compiled-workflows/merge-to-main.ts` matching the existing phase-handler shape (consult `dev-story.ts` for the contract).

2. **Merge strategy**: attempt fast-forward first (`git merge --ff-only <branch>` from main). If FF-impossible (main moved during this story's execution), attempt 3-way merge (`git merge <branch>`). If 3-way merge produces conflicts, the merge fails and the story is marked ESCALATED with reason `merge-conflict-detected`.

3. **Branch + base detection**: the orchestrator's start branch is captured at run-startup time (whatever HEAD was when `substrate run` invoked); `merge-to-main` merges back to that branch (typically `main` but could be a feature branch in some workflows). Capture once, store in run manifest, consume here.

4. **Worktree cleanup on success**: after successful merge, call `worktreeManager.cleanupWorktree(storyKey)` to remove the worktree directory. The branch is also deleted (it's been merged; no value in keeping it).

5. **Worktree preservation on failure**: if merge fails (conflicts), DO NOT remove the worktree or delete the branch. Operator inspects via `substrate reconcile-from-disk --branch substrate/story-<key>` (Epic 76 extension) or manual `git checkout` + resolve.

6. **New event `pipeline:merge-conflict-detected`** with fields `{ storyKey, branchName, conflictingFiles[] }`. Emitted on 3-way merge failure. Per existing event protocol convention, register in `packages/core/src/events/core-events.ts` event-metadata + add to `--help-agent` docs.

7. **Sequential merge serialization**: when multiple stories complete simultaneously (parallel conflict groups), their merges MUST serialize. Two `git merge` operations against the same main branch racing is a data-corruption risk. Use a simple in-orchestrator mutex / queue.

8. **Tests** at `src/modules/compiled-workflows/__tests__/merge-to-main.test.ts`:
   - (a) FF-merge happy path: branch ahead of main → FF succeeds → worktree removed → branch deleted
   - (b) 3-way merge: main moved during story → 3-way succeeds → worktree removed → branch deleted
   - (c) conflict path: main edited same lines → merge fails → worktree preserved → branch preserved → ESCALATED with merge-conflict-detected reason
   - (d) sequential merges: two stories complete simultaneously → merges run sequentially, neither corrupts the other
   - (e) event emission: merge-conflict-detected event includes correct conflictingFiles list

9. **Header comment** cites Story 75-1 (worktree creation) + the new merge-to-main phase architecture.

10. **No package additions**.

**Files involved:**
- `src/modules/compiled-workflows/merge-to-main.ts` (NEW)
- `src/modules/compiled-workflows/__tests__/merge-to-main.test.ts` (NEW)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (invoke merge-to-main after verification SHIP_IT; capture orchestrator start branch at run-startup)
- `packages/core/src/events/core-events.ts` (register `pipeline:merge-conflict-detected`)
- `src/cli/commands/help-agent.ts` (event schema docs update)

## Story 75-3: `--no-worktree` opt-out flag

**Priority**: must

**Description**: Add a `--no-worktree` flag to `substrate run` and a `SUBSTRATE_NO_WORKTREE=1` env var that bypasses per-story worktree creation. When set, all phases dispatch with `cwd: projectRoot` (the legacy behavior). This is a SAFETY VALVE for projects where worktrees aren't suitable (submodules, bare repos, large checkouts where parallel worktrees blow disk), NOT a migration mechanism.

**Acceptance Criteria:**

1. New CLI flag `--no-worktree` registered on `substrate run` (in `src/cli/commands/run.ts`'s `registerRunCommand` options block). Boolean. Default false.

2. Env var `SUBSTRATE_NO_WORKTREE=1` honored — same effect as `--no-worktree`. CLI flag takes precedence over env var (consistent with existing `SUBSTRATE_NO_UPDATE_CHECK` pattern).

3. **Config-flow plumbing**: pass `noWorktree: boolean` through `RunActionOptions` → `OrchestratorConfig`. Story 75-1's worktree creation block consumes it; when true, `effectiveProjectRoot` falls back to `projectRoot`.

4. **Manifest captures the choice**: `cli_flags` in the run manifest records `no_worktree: true` when the flag is set, so post-run forensics know whether worktrees were used.

5. **Documentation in `--help` text**: the option's description must explain "use this when worktree mode causes problems (submodules, bare repos, large checkouts) — it's a safety valve, not the recommended path".

6. **Tests** at `src/cli/commands/__tests__/no-worktree-flag.test.ts`:
   - (a) `--no-worktree` parsed from argv produces config with `noWorktree: true`
   - (b) `SUBSTRATE_NO_WORKTREE=1` produces same config
   - (c) CLI flag takes precedence over env var (CLI explicitly false + env var "1" → false)
   - (d) When config.noWorktree is true, the orchestrator does not invoke createWorktree (verify via mock manager)
   - (e) Run manifest persists `cli_flags.no_worktree` correctly

7. **CRITICAL**: do NOT introduce a separate config-format-version bump for this flag. Add it to the existing `cli_flags` field per Stream A+B canonical-helper pattern.

**Files involved:**
- `src/cli/commands/run.ts` (option registration + parse)
- `src/modules/implementation-orchestrator/types.ts` (add `noWorktree?: boolean` to OrchestratorConfig)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (consume in worktree-creation block from 75-1)
- `src/cli/commands/__tests__/no-worktree-flag.test.ts` (NEW)
- `packages/sdlc/src/run-model/run-manifest.ts` (extend cli_flags schema)

## Story 75-4: Orchestrator + dispatch test updates

**Priority**: must

**Description**: The orchestrator + dispatch test surface assumes `cwd === projectRoot` in many places. With 75-1, `cwd` becomes the worktree path per story. Update tests to expect this. Without 75-4, 75-1 + 75-2 ship CI-red.

**Acceptance Criteria:**

1. **Audit + update**: every test in `src/modules/implementation-orchestrator/__tests__/` and `src/modules/compiled-workflows/__tests__/` that asserts on `workingDirectory` or `projectRoot` matches in dispatch options. After Story 75-1 lands, those should expect a worktree path matching `<tmpDir>/.substrate-worktrees/story-<key>` (or be agnostic via a regex).

2. **Mock-manager pattern**: introduce a test helper `createMockWorktreeManager(opts?)` that returns a stub matching `GitWorktreeManager` and lets tests assert on createWorktree/cleanupWorktree calls. Lives at `src/modules/implementation-orchestrator/__tests__/test-helpers/mock-worktree-manager.ts`.

3. **e2e fixture update**: `__tests__/integration/non-interactive-run.test.ts` — verify it still passes with worktree mode default-on. The story key `0-1` will create a real worktree dir; ensure the test cleans up the `.substrate-worktrees/` directory in afterEach.

4. **`packages/sdlc/src/__tests__/fixtures/ynab-cross-project-fixture.ts`**: this cross-project fixture exercises conflictGroups. With worktrees, conflictGroups remain useful for ordering hints but are no longer the safety mechanism. Update fixture comments to reflect reality.

5. **No new tests required** — this is a test-update story, not a new-feature story. The new tests live in 75-1 + 75-2 + 75-3.

6. **Suite must pass at HEAD after this story** with `DOLT_INTEGRATION_TEST=1 npm test`. CI matrix [ubuntu-latest, macos-latest] both green.

**Files involved:**
- `src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts` (update existing assertions)
- `src/modules/implementation-orchestrator/__tests__/test-helpers/mock-worktree-manager.ts` (NEW)
- `src/modules/compiled-workflows/__tests__/*.test.ts` (audit + update where needed)
- `__tests__/integration/non-interactive-run.test.ts` (afterEach cleanup of worktree dir)
- `packages/sdlc/src/__tests__/fixtures/ynab-cross-project-fixture.ts` (comment update)

## Story 75-5: README + CLAUDE.md scaffold + `--help-agent` docs alignment

**Priority**: must

**Description**: README's 5 worktree claims become accurate. CLAUDE.md scaffold (the `<!-- substrate:start --> ... <!-- substrate:end -->` block + the three template variants) gains a brief note on per-story worktrees and the `--no-worktree` opt-out. `substrate run --help-agent` event-protocol doc adds `pipeline:merge-conflict-detected` from Story 75-2.

**Acceptance Criteria:**

1. **README.md updates**:
   - Lines 9, 24, 38, 156, 167 are now accurate as-written (just verify, don't rephrase if they're already correct post-implementation).
   - Add a new short subsection under "How It Works" explaining: "Each story dispatches into a per-story git worktree at `.substrate-worktrees/story-<key>` on branch `substrate/story-<key>`. After verification SHIP_IT, the branch merges back to main and the worktree is removed. After verification failure, the worktree+branch are preserved for `substrate reconcile-from-disk` inspection."
   - Add `--no-worktree` row to the CLI flag table in "CLI Command Reference".
   - Note in "State Backend" or similar that `.substrate-worktrees/` is added to the on-disk operator surface.

2. **CLAUDE.md scaffold templates** (`src/cli/templates/{claude,agents,gemini}-md-substrate-section.md`):
   - Add a one-paragraph note: "Each dispatched story runs in `.substrate-worktrees/story-<key>` on its own branch. The agent's auto-commit (e.g., `feat(story-N-M): ...`) lands on the branch, not main. Merge to main happens after verification SHIP_IT. Use `--no-worktree` if your project doesn't support worktrees (submodules, bare repos)."
   - Add `--no-worktree` row to the "Key Commands Reference" table.

3. **Live `/home/jplanow/code/jplanow/substrate/CLAUDE.md`** (the in-tree project file) — same updates within its `<!-- substrate:start --> ... <!-- substrate:end -->` block.

4. **`substrate run --help-agent`** (`src/cli/commands/help-agent.ts`):
   - Document `--no-worktree` in the substrate run options table
   - Document `pipeline:merge-conflict-detected` event in event-schema section (auto-generated from PIPELINE_EVENT_METADATA — verify Story 75-2 added the metadata correctly)
   - Update the Operator Files section to mention `.substrate-worktrees/`

5. **Tests** at `src/cli/commands/__tests__/help-agent.test.ts`:
   - (a) `--no-worktree` flag appears in the commands section
   - (b) `pipeline:merge-conflict-detected` event appears in event-schema section
   - (c) `.substrate-worktrees/` mentioned in Operator Files section

6. **Token-budget bump** in help-agent.test.ts AC5 if needed (currently 5000; this adds ~30 lines of doc, may push past).

**Files involved:**
- `README.md`
- `CLAUDE.md` (live in-tree file)
- `src/cli/templates/claude-md-substrate-section.md`
- `src/cli/templates/agents-md-substrate-section.md`
- `src/cli/templates/gemini-md-substrate-section.md`
- `src/cli/commands/help-agent.ts`
- `src/cli/commands/__tests__/help-agent.test.ts`

---

## Dispatch order

Stories must dispatch in this order due to dependencies:

1. **75-3 first** (the opt-out flag) — small, low-risk, allows operators to disable worktrees IF other stories regress something.
2. **75-1** (worktree creation, default ON) — depends on 75-3's flag plumbing.
3. **75-2** (merge-to-main) — depends on 75-1's worktrees existing.
4. **75-4** (test updates) — depends on 75-1 + 75-2 behavior so tests can assert on real outcomes.
5. **75-5** (docs) — depends on all of the above; describes the new behavior.

Conflict groups: 75-3 alone in group A. 75-1 alone in group B (depends on A). 75-2 alone in group C (depends on B). 75-4 + 75-5 in group D (depend on C). Total: 4 sequential batches.

## Out-of-scope (Epic 76 follow-up)

- `pipeline:worktree-created` / `pipeline:worktree-merged` / `pipeline:worktree-abandoned` telemetry events
- `substrate reconcile-from-disk --branch <name>` extension to reconcile against unmerged story branches
- Cross-story-isolation integration test (write same file from two parallel stories, assert no race)
- Submodule support (advise users to `--no-worktree`)
- Bare-repo support (same)
- Disk-space monitoring + auto-cleanup of long-stale worktrees
