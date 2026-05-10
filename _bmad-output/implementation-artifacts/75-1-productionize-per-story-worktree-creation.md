---
external_state_dependencies:
  - subprocess
  - filesystem
  - git
---

# Story 75-1: Productionize per-story worktree creation

## Story

As a pipeline operator,
I want every phase of a story dispatch to run inside its own isolated git worktree,
so that concurrent story implementations cannot corrupt each other's working trees and failed stories leave their branch intact for reconciliation.

## Acceptance Criteria

<!-- source-ac-hash: 108d21043d61516a7a7c59126ccdcb865411a93454a15f308f253e82f84d8c12 -->

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

## Tasks / Subtasks

- [ ] Task 1: Instantiate `GitWorktreeManager` in orchestrator constructor (AC1, AC8, AC10)
  - [ ] Import `createGitWorktreeManager` from `@substrate-ai/core` (resolves to `packages/core/src/git/git-worktree-manager-impl.ts`)
  - [ ] Add a `worktreeManager: GitWorktreeManager` private field on the orchestrator class (or as a closure variable if the orchestrator uses a closure pattern — check the class vs. factory style)
  - [ ] Wire `createGitWorktreeManager({ eventBus, projectRoot })` in the constructor; do NOT pass `db` or `logger` from scratch — reuse the existing orchestrator `logger` if the signature accepts it
  - [ ] Add a `noWorktree` boolean drawn from `config.noWorktree ?? false` (consumed in Task 2 for AC6); this is the opt-out flag slot Story 75-3 will populate via CLI
  - [ ] Add header comment (AC9): cite Path E spike (2026-05-10) and the ~14 dispatch sites that previously passed bare `projectRoot`

- [ ] Task 2: Insert per-story worktree creation block in `processStory()` (AC2, AC5, AC6)
  - [ ] After the memory-pressure guard (line 1531) and before the create-story phase (line 1533), insert:
    ```ts
    // Path E spike (2026-05-10): worktree isolation for all phase dispatches
    let effectiveProjectRoot = projectRoot
    if (!noWorktree) {
      const wt = await worktreeManager.createWorktree(storyKey)
      effectiveProjectRoot = wt.worktreePath  // or manager.getWorktreePath(storyKey)
    }
    ```
  - [ ] Confirm `createWorktree` on `GitWorktreeManager` interface accepts `storyKey` directly (it does — see `git-worktree-manager.ts:createWorktree(taskId: string)`)
  - [ ] Do NOT wrap with try/catch to swallow failure — let the error propagate per AC2 (failure MUST throw)
  - [ ] Worktree path must be `.substrate-worktrees/story-<storyKey>` — note the existing `BRANCH_PREFIX` constant is `substrate/task-` so the branch name will be `substrate/task-<storyKey>`; verify the manager's internal logic and align with AC2's branch pattern intent; flag discrepancy in dev notes if `BRANCH_PREFIX` doesn't match `substrate/story-`

- [ ] Task 3: Thread `effectiveProjectRoot` through every dispatch site inside `processStory()` (AC3)
  - [ ] Replace `projectRoot,` → `effectiveProjectRoot,` at lines 1705, 2336, 2405, 2573, 2673, 3551, 3803, 3850, 4183 (all `projectRoot,` occurrences inside `processStory()`); do NOT touch `projectRoot` references outside `processStory()` (orchestrator-level deps are correctly scoped)
  - [ ] Also replace `workingDirectory: projectRoot` with `workingDirectory: effectiveProjectRoot` at lines 3808, 3855, 4189, 4307
  - [ ] After replacing, run `grep -n 'projectRoot,' src/modules/implementation-orchestrator/orchestrator-impl.ts` scoped to inside `processStory()` to confirm zero remaining bare uses of `projectRoot,`
  - [ ] Ensure `artifactsDir` (line 1557) and `_bmad-output` joins also use `effectiveProjectRoot` where the artifact is expected in the worktree

- [ ] Task 4: Gap-1 fix in `git-utils.ts:208` — orphan directory guard (AC4)
  - [ ] In `createWorktree()` at `packages/core/src/git/git-utils.ts:208`, before `spawnGit(['worktree', 'add', ...])`:
    - Check whether `worktreePath` already exists on disk (`fs.access(worktreePath)` or `existsSync`)
    - If it does NOT exist → proceed normally (happy path)
    - If it DOES exist, run `git worktree list --porcelain` and parse output to check if the path is registered
    - **Orphan case** (dir exists, NOT in `git worktree list`): call `cleanupAllWorktrees()` on the manager (or `gitUtils.removeWorktree(worktreePath, projectRoot)` from within git-utils), then retry once
    - **Registered + clean case** (dir exists AND IS in `git worktree list`): throw with message: `Worktree at ${worktreePath} is already registered. Run \`substrate worktrees --cleanup\` to remove it.`
  - [ ] Note: `git-utils.ts`'s `createWorktree` is a standalone function, not a method on the class — it cannot call `cleanupAllWorktrees()` on the manager. Instead, remove only the specific orphan path via `removeWorktree(worktreePath, projectRoot)` (available in the same file), then proceed with `git worktree add`.
  - [ ] Add a `spawnGit(['worktree', 'list', '--porcelain'], { cwd: projectRoot })` helper call; parse for `worktree <path>` lines

- [ ] Task 5: Write tests at `src/modules/implementation-orchestrator/__tests__/per-story-worktree.test.ts` (AC7)
  - [ ] Test (a): mock `worktreeManager.createWorktree`; call `processStory('10-1')`; assert `createWorktree` called exactly once with `'10-1'`
  - [ ] Test (b): capture `workingDirectory` from mock dispatcher; assert it equals `worktreeManager.getWorktreePath('10-1')` not bare `projectRoot`
  - [ ] Test (c): call `processStory` for `'10-1'` then `'10-2'`; assert `getWorktreePath('10-1') !== getWorktreePath('10-2')` and two distinct branch names emitted
  - [ ] Test (d): mock `createWorktree` to throw `new Error('git worktree add failed')`; assert `processStory()` rejects with that error (no swallowing)
  - [ ] Test (e): set `config.noWorktree = true`; assert `createWorktree` NOT called and dispatcher receives `workingDirectory === projectRoot`
  - [ ] Use Vitest + standard mock patterns (vi.fn(), vi.spyOn); mock at `@substrate-ai/core` path per vitest mock pattern note in MEMORY.md
  - [ ] Use `spawnDiag` helper pattern for any subprocess assertions per v0.20.72 lesson

## Dev Notes

### Architecture Constraints

- **Canonical factory only**: import `createGitWorktreeManager` from `packages/core/src/git/git-worktree-manager-impl.ts` (re-exported via `@substrate-ai/core`). Never instantiate `GitWorktreeManagerImpl` directly.
- **`getWorktreePath(taskId)`** is available on the `GitWorktreeManager` interface (`packages/core/src/git/git-worktree-manager.ts:114`). Use it for worktree path derivation — do not construct the path manually.
- **`BRANCH_PREFIX` discrepancy**: the existing constant in `git-worktree-manager-impl.ts` is `'substrate/task-'` (line 33). The AC specifies branch name `substrate/story-<storyKey>`, but AC8 says "use the existing `BRANCH_PREFIX` constant". These conflict. Resolution: use `BRANCH_PREFIX` as-is (produces `substrate/task-<storyKey>`); the parenthetical `(matches existing BRANCH_PREFIX constant)` in AC2 indicates intent to reuse the constant, not to change the prefix string. Flag this in the completion notes.
- **No package additions**: all required types and factories already exist in `@substrate-ai/core` and `@substrate-ai/sdlc`.
- **`effectiveProjectRoot` scope**: it is a `const` (or `let` for the `--no-worktree` fallback) declared at the top of `processStory()` immediately after the worktree creation block. Every `projectRoot,` and `workingDirectory: projectRoot` inside `processStory()` must use `effectiveProjectRoot`.
- **Cleanup contract (AC5)**: this story does NOT remove the worktree on exit. Story 75-2 owns success-path merge + remove. Failure-path keeps the branch for `substrate reconcile-from-disk`. Do not add `finally { worktreeManager.removeWorktree(...) }`.
- **`git-utils.ts` gap-1 fix scope**: the `createWorktree` function at line 202 of `packages/core/src/git/git-utils.ts` is a standalone function. It cannot call `manager.cleanupAllWorktrees()`. Use `removeWorktree(worktreePath, projectRoot)` (same file, line 238) to remove the specific orphan path before retrying.
- **Mock path for tests**: mock at `packages/core/src/git/git-worktree-manager-impl.ts` not the monolith shim path, per MEMORY.md vitest mock pattern note.

### Testing Requirements

- Framework: Vitest (existing test infrastructure)
- Run targeted: `npm run test:changed` during iteration
- Test file path: `src/modules/implementation-orchestrator/__tests__/per-story-worktree.test.ts`
- Never use `expect(result.status).toBe(0)` alone for subprocess-spawning tests — always use `spawnDiag`-style builder as second arg per v0.20.72 lesson
- `cleanEnv` propagation: if any test spawns a subprocess, pass `cleanEnv = {PATH, HOME, USER, SHELL}` not `{...process.env}` per v0.20.73 lesson
- Tests must be completely self-contained (no prod Dolt writes; mock all I/O)

### File Paths

- **Modified**: `src/modules/implementation-orchestrator/orchestrator-impl.ts`
  - Constructor: instantiate `worktreeManager` via `createGitWorktreeManager`
  - `processStory()` lines 1531-1533: insert worktree creation block
  - All `projectRoot,` dispatch sites within `processStory()`: replace with `effectiveProjectRoot,`
  - Lines 3808, 3855, 4189, 4307: replace `workingDirectory: projectRoot` → `workingDirectory: effectiveProjectRoot`
- **Modified**: `packages/core/src/git/git-utils.ts`
  - `createWorktree()` at line 202: add orphan-directory guard before `git worktree add`
- **New**: `src/modules/implementation-orchestrator/__tests__/per-story-worktree.test.ts`

### Reference: Prior Spike

The 2026-05-10 spike at `spike/worktree-dispatch` proved the architecture but only overrode `dev-story`'s deps. This story productionizes that spike by threading `effectiveProjectRoot` through ALL 14 dispatch sites (create-story, test-plan, dev-story, code-review, build-fix, probe-author) within `processStory()`.

## Runtime Probes

```yaml
- name: worktree-created-for-story-key
  sandbox: twin
  command: |
    set -e
    REPO=$(mktemp -d)
    cd "$REPO" && git init -q
    git config user.email t@example.com && git config user.name test
    echo "initial" > README.md && git add . && git commit -qm "initial"
    # Invoke the GitWorktreeManager factory directly against this fixture repo
    node -e "
      const { createGitWorktreeManager } = require('/home/jplanow/code/jplanow/substrate/dist/cli/index.js');
      // Fallback: use git-worktree-manager-impl directly from compiled output
    " 2>/dev/null || \
    node --input-type=module <<'EOF'
      import { createGitWorktreeManager } from '/home/jplanow/code/jplanow/substrate/packages/core/src/git/git-worktree-manager-impl.js'
      import { EventEmitter } from 'events'
      const bus = new EventEmitter()
      const mgr = createGitWorktreeManager({ eventBus: bus, projectRoot: process.env.REPO })
      const result = await mgr.createWorktree('test-story-1')
      console.log('worktree_path=' + result.worktreePath)
    EOF
    ls "$REPO/.substrate-worktrees/test-story-1/"
  expect_stdout_regex:
    - 'worktree_path=.*\.substrate-worktrees/test-story-1'
  description: GitWorktreeManager creates worktree directory and branch for a given story key

- name: gap1-orphan-dir-cleared-before-create
  sandbox: twin
  command: |
    set -e
    REPO=$(mktemp -d)
    cd "$REPO" && git init -q
    git config user.email t@example.com && git config user.name test
    echo "initial" > README.md && git add . && git commit -qm "initial"
    # Simulate orphan: directory exists but not registered in git worktree list
    mkdir -p "$REPO/.substrate-worktrees/orphan-story"
    # Verify git worktree list does NOT contain it
    git -C "$REPO" worktree list --porcelain | grep -c "orphan-story" && echo "ERROR: orphan unexpectedly registered" && exit 1 || true
    # Now invoke createWorktree — gap-1 fix should detect orphan, clear it, and succeed
    node --input-type=module <<EOF
      import { createGitWorktreeManager } from '/home/jplanow/code/jplanow/substrate/packages/core/src/git/git-worktree-manager-impl.js'
      import { EventEmitter } from 'events'
      const bus = new EventEmitter()
      const mgr = createGitWorktreeManager({ eventBus: bus, projectRoot: '$REPO' })
      await mgr.createWorktree('orphan-story')
      console.log('orphan_recovered=true')
    EOF
  expect_stdout_regex:
    - 'orphan_recovered=true'
  description: gap-1 fix — orphan directory cleared and worktree re-created without manual intervention

- name: gap1-registered-dir-errors-with-cleanup-hint
  sandbox: twin
  command: |
    set -e
    REPO=$(mktemp -d)
    cd "$REPO" && git init -q
    git config user.email t@example.com && git config user.name test
    echo "initial" > README.md && git add . && git commit -qm "initial"
    # Create a legitimately registered worktree first
    git -C "$REPO" worktree add "$REPO/.substrate-worktrees/registered-story" -b substrate/task-registered-story
    # Now attempt to createWorktree for the same key — should throw with cleanup hint
    node --input-type=module <<EOF 2>&1 || true
      import { createGitWorktreeManager } from '/home/jplanow/code/jplanow/substrate/packages/core/src/git/git-worktree-manager-impl.js'
      import { EventEmitter } from 'events'
      const bus = new EventEmitter()
      const mgr = createGitWorktreeManager({ eventBus: bus, projectRoot: '$REPO' })
      try {
        await mgr.createWorktree('registered-story')
        console.log('ERROR: expected throw but succeeded')
      } catch (e) {
        console.log('threw_with_message=' + e.message)
      }
    EOF
  expect_stdout_regex:
    - 'threw_with_message=.*substrate worktrees --cleanup'
  description: gap-1 fix — registered+existing worktree directory produces actionable error with cleanup hint
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log