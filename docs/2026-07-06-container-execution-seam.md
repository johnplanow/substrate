# Container execution seam (H4.4)

Status: seam only — typed and gated, no container backend implemented.

## What exists today

- `SpawnCommand.executionMode?: 'spawn' | 'container'` (both
  `packages/core/src/adapters/types.ts` and `src/adapters/types.ts` — the
  dual-schema pair Epic 79's contracts package will consolidate).
- The dispatcher (`packages/core/src/dispatch/dispatcher-impl.ts`) rejects any
  non-`'spawn'` mode with a failed DispatchResult, so an adapter cannot
  request containerization and silently run on the host.

## How a container backend would slot in

The two seams a bind-mount container backend needs are already isolation-clean
after H4.1/H4.2:

1. **Worktree lifecycle** (`GitWorktreeManagerImpl`): worktrees live at an
   external base (`~/.substrate/worktrees/<project>-<hash8>/<task>/` by
   default). A container backend bind-mounts exactly that directory to the
   same path inside the container. Because H4.1 already scrubs inherited git
   env and pins `GIT_CEILING_DIRECTORIES` to the worktree parent, the
   in-container view is identical to the host view — no repo above the
   worktree either way.

2. **Process execution** (`DispatcherImpl` spawn site): the single
   `spawn(cmd.binary, cmd.args, { cwd, env })` call is the only place a
   command becomes a process. The container backend replaces this one call
   with `docker|podman run --rm -v <worktreeBase>:<worktreeBase> -w <cwd>`
   (plus the same env allow-list), keyed off `cmd.executionMode`.

Everything between those seams — verification pipeline, commit-first,
finalization — operates on the worktree path via `effectiveProjectRoot` and is
path-backend-agnostic (proven by the fixture matrix running green under the
external base).

## Rule: no new direct-fs worktree access

All worktree path construction MUST flow through
`GitWorktreeManager.getWorktreePath()` / `resolveWorktreeBaseDirectory()`.
The enumerated exceptions (legacy or deliberate) are pinned by
`src/__tests__/worktree-path-conformance.test.ts`; adding a new hardcoded
`.substrate-worktrees` reference outside that allow-list fails the suite.
This keeps the bind-mount surface enumerable when the container backend lands.
