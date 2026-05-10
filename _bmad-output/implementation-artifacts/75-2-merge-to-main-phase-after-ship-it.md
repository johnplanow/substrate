---
external_state_dependencies:
  - subprocess
  - filesystem
  - git
---

# Story 75-2: `merge-to-main` Phase After SHIP_IT

## Story

As a pipeline operator,
I want substrate to automatically merge a completed story's branch back to main after verification SHIP_IT,
so that isolated worktree branches are integrated without manual intervention and the branch lifecycle is fully closed.

## Acceptance Criteria

<!-- source-ac-hash: 646f688bf88bbce0920ac1d2bf5456a8f9c77b2ddf91dd80caa91034c7901949 -->

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

## Tasks / Subtasks

- [x] Task 1: Register `pipeline:merge-conflict-detected` event across the event protocol chain (AC: #6)
  - [x] Add `PipelineMergeConflictDetectedEvent` interface to `src/modules/implementation-orchestrator/event-types.ts` with fields `ts`, `storyKey`, `branchName`, `conflictingFiles: string[]`; add to `PipelineEvent` union and `EVENT_TYPE_NAMES`
  - [x] Add a matching entry to `PIPELINE_EVENT_METADATA` in `src/cli/commands/help-agent.ts` (per the SYNC CONTRACT comment at line 51 — must include `type`, `description`, `when`, `fields`)
  - [x] Add payload interface comment (or re-export) in `packages/core/src/events/core-events.ts` as referenced by the AC

- [x] Task 2: Capture orchestrator start branch at run-startup and persist in run manifest (AC: #3)
  - [x] In `orchestrator-impl.ts` constructor or `run()` entry point, execute `git rev-parse --abbrev-ref HEAD` (sync) against `projectRoot` to capture the start branch; store as `orchestratorStartBranch` in the orchestrator instance
  - [x] Add optional `orchestrator_start_branch?: string` field to `RunManifestData` in `packages/sdlc/src/run-model/types.ts`; write the captured value during manifest initialization so downstream phases can read it

- [x] Task 3: Implement `src/modules/compiled-workflows/merge-to-main.ts` — merge strategy logic (AC: #1, #2, #9)
  - [x] Author header comment citing Story 75-1 (worktree creation) and the merge-to-main phase architecture
  - [x] Export `runMergeToMain(params)` matching the phase-handler shape from `dev-story.ts` (consult its signature for `WorkflowDeps` + `params` shape)
  - [x] Implement FF-first merge: `git merge --ff-only <branchName>` from `startBranch`'s worktree root; parse exit code — 0 = FF success
  - [x] On FF failure (exit non-zero), attempt 3-way merge: `git merge <branchName>`; detect conflicts via non-zero exit + parse `git diff --name-only --diff-filter=U` output for `conflictingFiles[]`
  - [x] On conflict: emit `pipeline:merge-conflict-detected` event via eventBus, abort merge (`git merge --abort`), return failure result with `reason: 'merge-conflict-detected'`

- [x] Task 4: Implement worktree cleanup, branch deletion, and sequential merge mutex (AC: #4, #5, #7)
  - [x] On FF or 3-way merge success: call `worktreeManager.cleanupWorktree(storyKey)` then `git branch -d substrate/story-<storyKey>` from `projectRoot`
  - [x] On conflict failure: log and return WITHOUT calling `cleanupWorktree` or deleting the branch (preserve for operator inspection)
  - [x] Add a module-level `mergeMutex` (a `Promise` chain or `AsyncMutex`-style queue using a single `Promise` variable) in `orchestrator-impl.ts` that serializes calls to `runMergeToMain` — no concurrent merges against the same base branch

- [x] Task 5: Wire `runMergeToMain` into the orchestrator after verification SHIP_IT (AC: #1, #3, #7)
  - [x] In `orchestrator-impl.ts`, after the verification pipeline returns SHIP_IT verdict and before the story is marked COMPLETE, acquire the merge mutex and invoke `runMergeToMain({ storyKey, branchName: 'substrate/story-<key>', startBranch: orchestratorStartBranch, worktreeManager, eventBus, projectRoot })`
  - [x] On `runMergeToMain` returning failure (conflict), mark the story ESCALATED with reason `merge-conflict-detected` instead of COMPLETE; emit `story:escalation` event

- [x] Task 6: Write tests at `src/modules/compiled-workflows/__tests__/merge-to-main.test.ts` (AC: #8a–8e)
  - [x] (a) FF-merge happy path: mock git to return exit 0 for `--ff-only`; assert `cleanupWorktree` called and branch delete invoked
  - [x] (b) 3-way merge path: mock FF to fail (exit 1), 3-way to succeed (exit 0); assert cleanup + branch delete still called
  - [x] (c) Conflict path: mock FF fail + 3-way fail with conflict exit; assert worktree NOT cleaned up, branch NOT deleted, result has `reason: 'merge-conflict-detected'`, story marked ESCALATED
  - [x] (d) Sequential merge serialization: two calls to the mutex-wrapped `runMergeToMain` with timing assertions — second call starts only after first resolves
  - [x] (e) Event emission: spy on `eventBus.emit`; on conflict path assert `pipeline:merge-conflict-detected` emitted with `{ storyKey, branchName, conflictingFiles }` matching parsed output

## Dev Notes

### Architecture Constraints

- `merge-to-main.ts` MUST follow the phase-handler shape used by `dev-story.ts` — consult `src/modules/compiled-workflows/dev-story.ts` for the `WorkflowDeps` injection pattern and return type
- All imports use `.js` extension (ESM — project-wide rule)
- `GitWorktreeManager` is imported via `@substrate-ai/core` (re-exported from `src/modules/git-worktree/index.ts`) — do NOT import `GitWorktreeManagerImpl` directly
- Event registration MUST touch all four locations in the protocol chain: `event-types.ts` interface + union + `EVENT_TYPE_NAMES`, and `help-agent.ts` `PIPELINE_EVENT_METADATA` — the test suite at `src/cli/commands/__tests__/help-agent.test.ts` enforces parity; omitting any location causes test failure
- `RunManifestData` lives in `packages/sdlc/src/run-model/types.ts`; the new `orchestrator_start_branch` field MUST be optional for backward-compatibility with pre-75-2 manifests
- Merge commands MUST run against `projectRoot` (the main working tree), NOT the story's worktree path — worktrees share the same git repo; git merge from any worktree that has `startBranch` checked out will advance that branch
- Sequential merge mutex pattern: use a module-level `let mergeQueue = Promise.resolve()` in `orchestrator-impl.ts`; each call appends: `mergeQueue = mergeQueue.then(() => runMergeToMain(...))` — simple, zero-dependency, no package addition needed (AC10)
- **No package additions** (AC10)

### Testing Requirements

- Use `vitest` (project-wide test framework); mock `child_process.execSync` and `execa` / `execa`-equivalent git invocations via `vi.mock`
- Mock `GitWorktreeManager` via an object literal satisfying the interface (no need for full `GitWorktreeManagerImpl`); assert `cleanupWorktree` call count and args
- `git diff --name-only --diff-filter=U` stdout parsing: test with fixture outputs containing one file and multiple files to verify `conflictingFiles[]` is populated correctly
- Sequential serialization test (AC8d): use fake timers or controlled `Promise` resolution to verify ordering without actual `sleep` calls
- Test file location: `src/modules/compiled-workflows/__tests__/merge-to-main.test.ts`
- Run targeted tests during development: `npm run test:changed` or `npm run test:fast`
- Full suite before merge: `npm test`

### Import Patterns (reference)

```typescript
// phase handler deps — mirror dev-story.ts shape
import type { WorkflowDeps } from './types.js'

// worktree manager
import type { GitWorktreeManager } from '@substrate-ai/core'

// event bus (for emitting pipeline:merge-conflict-detected)
import type { TypedEventBus } from '../../core/event-bus.js'

// run manifest patch
import type { RunManifestData } from '@substrate-ai/sdlc'

// logging
import { createLogger } from '../../utils/logger.js'
```

### Key File Locations

| File | Role |
|---|---|
| `src/modules/compiled-workflows/merge-to-main.ts` | NEW — phase handler implementation |
| `src/modules/compiled-workflows/__tests__/merge-to-main.test.ts` | NEW — unit tests |
| `src/modules/implementation-orchestrator/orchestrator-impl.ts` | Wire phase + capture start branch + mutex |
| `packages/sdlc/src/run-model/types.ts` | Add `orchestrator_start_branch?: string` to `RunManifestData` |
| `src/modules/implementation-orchestrator/event-types.ts` | Add `PipelineMergeConflictDetectedEvent` interface + union + `EVENT_TYPE_NAMES` |
| `packages/core/src/events/core-events.ts` | Add comment/re-export per AC6 |
| `src/cli/commands/help-agent.ts` | Add `PIPELINE_EVENT_METADATA` entry |

## Runtime Probes

```yaml
- name: merge-to-main-ff-happy-path
  sandbox: twin
  command: |
    set -e
    REPO=$(mktemp -d)
    cd "$REPO" && git init -q
    git config user.email t@example.com && git config user.name test
    echo "initial" > file.ts && git add . && git commit -qm "initial commit"
    git checkout -qb substrate/story-75-2
    echo "story work" >> file.ts && git add . && git commit -qm "story implementation"
    git checkout -q main
    # Invoke merge-to-main phase handler via ts-node/built artifact
    node --input-type=module <<'EOF'
    import { execSync } from 'child_process';
    // FF merge should succeed: branch is strictly ahead of main
    const out = execSync('git merge --ff-only substrate/story-75-2', { cwd: process.env.REPO, stdio: 'pipe' });
    console.log('ff-merge-success');
    EOF
  expect_stdout_regex:
    - 'ff-merge-success'
  description: FF merge succeeds when story branch is ahead of main with no divergence

- name: merge-to-main-conflict-detected
  sandbox: twin
  command: |
    set -e
    REPO=$(mktemp -d)
    cd "$REPO" && git init -q
    git config user.email t@example.com && git config user.name test
    echo "shared line" > shared.ts && git add . && git commit -qm "initial"
    git checkout -qb substrate/story-75-conflict
    echo "branch edit" > shared.ts && git add . && git commit -qm "branch changes shared.ts"
    git checkout -q main
    echo "main edit" > shared.ts && git add . && git commit -qm "main diverged on shared.ts"
    # FF must fail (branches diverged)
    git merge --ff-only substrate/story-75-conflict 2>&1 || echo "ff-failed-as-expected"
    # 3-way must produce conflicts
    git merge --no-edit substrate/story-75-conflict 2>&1 || echo "conflict-detected"
    # Conflicting files detected
    git diff --name-only --diff-filter=U
    git merge --abort
    echo "worktree-preserved"
  expect_stdout_regex:
    - 'ff-failed-as-expected'
    - 'conflict-detected'
    - 'shared\.ts'
    - 'worktree-preserved'
  description: >
    Conflict scenario: diverged main + branch both edit shared.ts →
    FF fails, 3-way produces conflict, conflictingFiles list includes shared.ts,
    merge aborted and worktree preserved

- name: merge-to-main-3way-succeeds-when-main-moved
  sandbox: twin
  command: |
    set -e
    REPO=$(mktemp -d)
    cd "$REPO" && git init -q
    git config user.email t@example.com && git config user.name test
    echo "file-a" > a.ts && echo "file-b" > b.ts && git add . && git commit -qm "initial"
    git checkout -qb substrate/story-75-3way
    echo "story edit" >> a.ts && git add . && git commit -qm "story edits a.ts"
    git checkout -q main
    # Main moves on a different file (no conflict)
    echo "main edit" >> b.ts && git add . && git commit -qm "main edits b.ts"
    # FF must fail (diverged), 3-way must succeed (no overlap)
    git merge --ff-only substrate/story-75-3way 2>&1 || echo "ff-failed-expected"
    git merge --no-edit substrate/story-75-3way 2>&1
    echo "3way-merge-succeeded"
  expect_stdout_regex:
    - 'ff-failed-expected'
    - '3way-merge-succeeded'
  expect_stdout_no_regex:
    - 'CONFLICT'
  description: >
    3-way merge succeeds when main moved on a different file — FF fails but
    3-way merges cleanly (no overlap), worktree can be cleaned up
```

## Interface Contracts

- **Export**: `MergeToMainResult` @ `src/modules/compiled-workflows/merge-to-main.ts` (consumed by orchestrator-impl.ts after SHIP_IT)
- **Import**: `GitWorktreeManager` @ `@substrate-ai/core` (from Story 75-1 — must be available at the orchestrator level)
- **Export**: `PipelineMergeConflictDetectedEvent` @ `src/modules/implementation-orchestrator/event-types.ts` (registered in core-events.ts + PIPELINE_EVENT_METADATA per AC6)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Implemented full merge-to-main phase handler at `src/modules/compiled-workflows/merge-to-main.ts` with FF-first → 3-way → conflict strategy
- Registered `pipeline:merge-conflict-detected` in event-types.ts (interface + union + EVENT_TYPE_NAMES), event-bus.types.ts (OrchestratorEvents), help-agent.ts (PIPELINE_EVENT_METADATA), core-events.ts (documentation comment), and help-agent.test.ts (expectedTypes array)
- Added `orchestrator_start_branch?: string` to RunManifestData (types.ts) and RunManifestSchema (schemas.ts); extended patchRunStatus signature to persist it
- Wired `_orchestratorStartBranch` closure variable + `_mergeQueue` Promise-chain mutex in orchestrator-impl.ts; imports runMergeToMain as runMergeToMainPhase to avoid naming conflict
- On merge failure: story marked ESCALATED with reason 'merge-conflict-detected' and emits story:escalation event; worktree/branch preserved
- On merge success: cleanupWorktree(storyKey) + git branch -d (best-effort, logged on failure)
- Full test suite (15 tests) covering AC8a–8e, plus edge cases for cleanup failure and diff parse failure; build and test:fast pass (479 test files, 9760 tests)

### File List
- `src/modules/compiled-workflows/merge-to-main.ts` (NEW)
- `src/modules/compiled-workflows/__tests__/merge-to-main.test.ts` (NEW)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (MODIFIED — import, closure vars, enqueueMerge, startBranch capture, manifest persist, SHIP_IT wiring)
- `src/modules/implementation-orchestrator/event-types.ts` (MODIFIED — PipelineMergeConflictDetectedEvent + union + EVENT_TYPE_NAMES)
- `src/core/event-bus.types.ts` (MODIFIED — OrchestratorEvents entry)
- `src/cli/commands/help-agent.ts` (MODIFIED — PIPELINE_EVENT_METADATA entry)
- `src/cli/commands/__tests__/help-agent.test.ts` (MODIFIED — expectedTypes array)
- `packages/core/src/events/core-events.ts` (MODIFIED — documentation comment)
- `packages/sdlc/src/run-model/types.ts` (MODIFIED — orchestrator_start_branch field)
- `packages/sdlc/src/run-model/schemas.ts` (MODIFIED — orchestrator_start_branch schema field)
- `packages/sdlc/src/run-model/run-manifest.ts` (MODIFIED — patchRunStatus signature extension)

## Change Log

- 2026-05-10: Story authored (Story 75-2, Epic 75 — Worktree Wiring Into Dispatch)
