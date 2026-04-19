# Fix: Supervisor Token Tracking DB Path Divergence

Status: backlog

## Problem

The supervisor reports 0 tokens for pipelines run via `npm run substrate:dev` (local dev builds) or from git worktrees. The globally installed `substrate` command tracks tokens correctly.

## Root Cause

DB path resolution diverges between the `run` command and the supervisor's `getTokenSnapshot`/`incrementRestarts` functions:

| Component | Path resolution | Method |
|-----------|----------------|--------|
| `run.ts:213` | `resolveMainRepoRoot(projectRoot)` | Follows git worktree symlinks |
| `health.ts:238` (`getAutoHealthData`) | `resolveMainRepoRoot(projectRoot)` | Follows git worktree symlinks |
| `supervisor.ts:117` (`getTokenSnapshot`) | `join(projectRoot, '.substrate', 'substrate.db')` | Direct path, no worktree resolution |
| `supervisor.ts:103` (`incrementRestarts`) | `join(projectRoot, '.substrate', 'substrate.db')` | Direct path, no worktree resolution |

When `resolveMainRepoRoot` returns a different path than `projectRoot` (e.g., worktrees, or when CWD differs from the git root), the supervisor queries a different DB than where `run` wrote tokens.

## Observed Behavior

- Pipeline via `substrate run --stories 1-1,2-1` (global install, code-review-agent project): tokens tracked correctly (4,043 input / 368 output)
- Pipeline via `npm run substrate:dev -- run --events --stories 16-7` (local dev build, substrate project): 0 tokens in supervisor polls

## Fix

Make `getTokenSnapshot` and `incrementRestarts` in `supervisor.ts` use `resolveMainRepoRoot(projectRoot)` instead of `join(projectRoot, '.substrate')`. This aligns with the pattern already used by `getAutoHealthData` in `health.ts:238`.

Note: `resolveMainRepoRoot` is async, so `getTokenSnapshot` will need to become async (or pre-resolve the path once at supervisor startup and cache it).

### Files to modify
- `src/cli/commands/supervisor.ts` — `defaultSupervisorDeps()` lines 94-130

### Estimated scope
- ~15 lines of production code
- 1-2 test cases verifying resolved path is used

## Acceptance Criteria

- AC1: Supervisor `getTokenSnapshot` resolves DB path via `resolveMainRepoRoot`
- AC2: Supervisor `incrementRestarts` resolves DB path via `resolveMainRepoRoot`
- AC3: Token counts are non-zero in supervisor:poll events for dev-build pipelines
- AC4: Existing tests pass
