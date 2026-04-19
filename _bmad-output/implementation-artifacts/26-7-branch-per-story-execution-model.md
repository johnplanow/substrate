# Story 26-7: Branch-Per-Story Execution Model

Status: complete

## Story

As a pipeline orchestrator,
I want each story's state writes to be isolated on a Dolt branch and merged into main only on successful completion,
so that parallel story execution cannot corrupt shared pipeline state and failed stories leave no partial state behind.

## Acceptance Criteria

### AC1: DoltStateStore Creates a Branch Before Story Dispatch
**Given** a `DoltStateStore` instance and a story key (e.g., `26-7`)
**When** `stateStore.branchForStory('26-7')` is called
**Then**:
- A Dolt branch named `story/26-7` is created from the current `main` HEAD via `CALL DOLT_BRANCH('story/26-7')` (server mode) or `dolt sql -b main -q "CALL DOLT_BRANCH('story/26-7')"` (CLI mode)
- The mapping `storyKey → 'story/26-7'` is recorded in `DoltStateStore._storyBranches: Map<string, string>`
- On `FileStateStore`, the method is a no-op (returns `Promise<void>` immediately)

### AC2: State Writes Target the Story Branch
**Given** `branchForStory('26-7')` has been called on the `DoltStateStore`
**When** any write method is called with `storyKey = '26-7'` (e.g., `setStoryState`, `recordMetric`, `setContracts`)
**Then**:
- The SQL write targets the story branch using the `--branch story/26-7` CLI flag or a server-mode connection with `USE \`substrate/story/26-7\``
- Writes for story keys with no registered branch continue to target `main`
- Writes for different stories target their respective branches independently (no cross-contamination)

### AC3: Merge Story Branch into Main on COMPLETE
**Given** a story has been dispatched on branch `story/26-7`
**When** `stateStore.mergeStory('26-7')` is called (triggered by the orchestrator on COMPLETE)
**Then**:
- `CALL DOLT_MERGE('story/26-7')` is executed targeting `main` (server mode: `USE \`substrate/main\``; CLI mode: `dolt sql -b main -q "CALL DOLT_MERGE('story/26-7')"`)
- A Dolt commit is created on `main` with message `"Merge story 26-7: COMPLETE"` via `CALL DOLT_COMMIT('-m', '...')`
- The `_storyBranches` entry for `'26-7'` is deleted
- If no branch exists for the story key, the method is a no-op (logs a warning)

### AC4: Roll Back Story Branch on FAILED or ESCALATED
**Given** a story has been dispatched on branch `story/26-7`
**When** `stateStore.rollbackStory('26-7')` is called (triggered by the orchestrator on FAILED or ESCALATED)
**Then**:
- The branch `story/26-7` is dropped via `CALL DOLT_BRANCH('-D', 'story/26-7')` (server mode) or `dolt sql -b main -q "CALL DOLT_BRANCH('-D', 'story/26-7')"` (CLI mode)
- No state from the story branch is merged into `main`
- The `_storyBranches` entry for `'26-7'` is deleted
- On `FileStateStore`, the method is a no-op

### AC5: Merge Conflicts Surfaced as `DoltMergeConflict`
**Given** two parallel stories (`26-7` and `26-8`) each modified the same row in the `stories` table
**When** the second `mergeStory()` call executes
**Then**:
- Dolt detects the conflict and the merge fails
- `DoltStateStore.mergeStory` throws a `DoltMergeConflict` error (already defined in 26-3) with:
  - `table`: name of the conflicting table (e.g., `'stories'`)
  - `rowKey`: the primary key value of the conflicting row
  - `ourValue` and `theirValue`: JSON-serialized cell values from each branch
- The orchestrator catches `DoltMergeConflict` and emits a `pipeline:contract-mismatch` event (or equivalent conflict escalation)

### AC6: `diffStory` Returns Structured Row-Level Diff
**Given** a story has written state changes to its branch
**When** `stateStore.diffStory('26-7')` is called
**Then**:
- The method executes `SELECT * FROM DOLT_DIFF('main', 'story/26-7', 'stories')` and repeats for all state tables (`contracts`, `metrics`, `dispatch_log`, `build_results`, `review_verdicts`)
- Returns a `StoryDiff` object: `{ storyKey: string; tables: TableDiff[] }` where `TableDiff` is `{ table: string; added: DiffRow[]; modified: DiffRow[]; deleted: DiffRow[] }`
- `DiffRow` is `{ rowKey: string; before?: Record<string, unknown>; after?: Record<string, unknown> }`
- If no branch exists for the story key, returns `{ storyKey, tables: [] }` (no diff)
- On `FileStateStore`, returns `{ storyKey, tables: [] }` always

### AC7: Orchestrator Wires Branch Lifecycle to Story Lifecycle
**Given** an orchestrator constructed with a `DoltStateStore`
**When** the pipeline dispatches and resolves stories
**Then**:
- Before dispatching each story, the orchestrator calls `await stateStore.branchForStory(storyKey).catch(logger.warn)` (best-effort)
- On story COMPLETE, the orchestrator calls `await stateStore.mergeStory(storyKey).catch(handleMergeError)` where `handleMergeError` logs and emits a conflict event on `DoltMergeConflict`
- On story FAILED or ESCALATED, the orchestrator calls `await stateStore.rollbackStory(storyKey).catch(logger.warn)` (best-effort)
- On `FileStateStore`, all three calls are no-ops — existing behavior is unchanged
- Integration test: 3 concurrent stories each complete successfully with distinct branches that are all merged into main

## Interface Contracts

- **Import**: `StateStore` @ `src/modules/state/types.ts` (from story 26-1)
- **Import**: `DoltStateStore`, `DoltMergeConflict` @ `src/modules/state/dolt-store.ts` (from story 26-3)
- **Import**: `FileStateStore` @ `src/modules/state/file-store.ts` (from story 26-1)
- **Import**: `OrchestratorImpl` with `stateStore` DI @ `src/modules/implementation-orchestrator/orchestrator-impl.ts` (from story 26-4)
- **Export**: `StoryDiff`, `TableDiff`, `DiffRow` @ `src/modules/state/types.ts` (new types consumed by story 26-8 and 26-9)

## Tasks / Subtasks

- [ ] Task 1: Add `StoryDiff`, `TableDiff`, `DiffRow` types and update `StateStore` interface (AC6)
  - [ ] In `src/modules/state/types.ts`, add:
    - `DiffRow: { rowKey: string; before?: Record<string, unknown>; after?: Record<string, unknown> }`
    - `TableDiff: { table: string; added: DiffRow[]; modified: DiffRow[]; deleted: DiffRow[] }`
    - `StoryDiff: { storyKey: string; tables: TableDiff[] }`
  - [ ] Confirm `StateStore` interface already declares `branchForStory`, `mergeStory`, `rollbackStory`, `diffStory` from story 26-1 (they were stubs); update return type of `diffStory` to `Promise<StoryDiff>`
  - [ ] Export `StoryDiff`, `TableDiff`, `DiffRow` from `src/modules/state/index.ts`
  - [ ] Update `FileStateStore` stub implementations: `branchForStory` and `rollbackStory` return `Promise.resolve()`, `mergeStory` returns `Promise.resolve()`, `diffStory` returns `Promise.resolve({ storyKey, tables: [] })`
  - [ ] Run `npm run build` to confirm zero TypeScript errors

- [ ] Task 2: Implement `branchForStory` in `DoltStateStore` (AC1)
  - [ ] Add `private _storyBranches: Map<string, string> = new Map()` field to `DoltStateStore`
  - [ ] Implement `branchForStory(storyKey: string): Promise<void>`:
    - Compute `branchName = 'story/' + storyKey`
    - Execute `CALL DOLT_BRANCH('${branchName}')` via `this._client.query('main', ...)` (server mode) or `this._client.exec(['sql', '-b', 'main', '-q', `CALL DOLT_BRANCH('${branchName}')`])` (CLI mode)
    - On success: `this._storyBranches.set(storyKey, branchName)`
    - On error: throw `DoltQueryError` wrapping the original error
  - [ ] Unit test (mocked `DoltClient`): assert SQL contains `DOLT_BRANCH`, assert `_storyBranches` has the entry after call

- [ ] Task 3: Route write methods to story branch (AC2)
  - [ ] Add private helper `_branchFor(storyKey?: string): string` that returns `this._storyBranches.get(storyKey ?? '') ?? 'main'`
  - [ ] Update `setStoryState(storyKey, record)`: pass `_branchFor(storyKey)` as the target branch parameter to `_client.query` / `_client.exec`
  - [ ] Update `recordMetric(metric)`: use `_branchFor(metric.storyKey)` if available
  - [ ] Update `setContracts(storyKey, contracts)`: use `_branchFor(storyKey)`
  - [ ] Update `setContractVerification(storyKey, results)`: use `_branchFor(storyKey)` (from story 26-6)
  - [ ] All other write methods that accept `storyKey` apply the same pattern; reads always target `main` (merged state is canonical for reads)
  - [ ] Unit tests: verify that after `branchForStory('26-7')`, a `setStoryState('26-7', ...)` call passes `'story/26-7'` as branch to the client mock

- [ ] Task 4: Implement `mergeStory` in `DoltStateStore` (AC3, AC5)
  - [ ] Implement `mergeStory(storyKey: string): Promise<void>`:
    - Retrieve `branchName` from `_storyBranches.get(storyKey)`; if not found, log warn and return early
    - Execute on `main` branch: `CALL DOLT_MERGE('${branchName}')` — detect merge conflicts from SQL result or exception
    - If merge succeeds: execute `CALL DOLT_COMMIT('-m', 'Merge story ${storyKey}: COMPLETE')` on `main`
    - `this._storyBranches.delete(storyKey)` after commit
    - If Dolt returns a conflict error: parse the conflict metadata (table name, row key, cell values) and throw `new DoltMergeConflict({ table, rowKey, ourValue, theirValue })`
  - [ ] Unit test (mocked client): assert `DOLT_MERGE` called with correct branch, assert commit message, assert `_storyBranches` entry removed
  - [ ] Unit test: mock client to return conflict → assert `DoltMergeConflict` thrown with correct fields

- [ ] Task 5: Implement `rollbackStory` in `DoltStateStore` (AC4)
  - [ ] Implement `rollbackStory(storyKey: string): Promise<void>`:
    - Retrieve `branchName` from `_storyBranches.get(storyKey)`; if not found, log warn and return early
    - Execute: `CALL DOLT_BRANCH('-D', '${branchName}')` targeting `main`
    - `this._storyBranches.delete(storyKey)`
  - [ ] Unit test: assert `DOLT_BRANCH('-D', ...)` called, entry removed from map
  - [ ] Unit test: if no branch registered → log warn, no SQL executed

- [ ] Task 6: Implement `diffStory` in `DoltStateStore` (AC6)
  - [ ] Define the tables to diff: `const DIFF_TABLES = ['stories', 'contracts', 'metrics', 'dispatch_log', 'build_results', 'review_verdicts'] as const`
  - [ ] Implement `diffStory(storyKey: string): Promise<StoryDiff>`:
    - If `_storyBranches.get(storyKey)` is undefined, return `{ storyKey, tables: [] }`
    - For each table, execute: `SELECT * FROM DOLT_DIFF('main', '${branchName}', '${table}')`
    - Map rows to `TableDiff`: rows where `diff_type = 'added'` → `added[]`, `'modified'` → `modified[]`, `'removed'` → `deleted[]`; extract `rowKey` from the table's primary key column, `before`/`after` from the `before_*`/`after_*` columns
    - Skip tables that return zero rows (no changes)
    - Return `{ storyKey, tables: nonEmptyTableDiffs }`
  - [ ] Unit test: mock client returning sample DOLT_DIFF rows → verify correct mapping to `added`, `modified`, `deleted`

- [ ] Task 7: Wire branch lifecycle into the orchestrator (AC7)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, locate the story dispatch site (where `_stories.set(storyKey, { phase: 'IN_DEV' })` or equivalent is called before the `dispatchStory` call)
  - [ ] Before each story dispatch: add `void stateStore?.branchForStory(storyKey).catch(err => logger.warn({ err }, 'branchForStory failed — continuing without branch isolation'))`
  - [ ] After a story reaches COMPLETE: add `void stateStore?.mergeStory(storyKey).catch(err => { if (err instanceof DoltMergeConflict) { /* emit conflict event */ } else logger.warn({ err }, 'mergeStory failed') })`
  - [ ] After a story reaches FAILED or ESCALATED: add `void stateStore?.rollbackStory(storyKey).catch(err => logger.warn({ err }, 'rollbackStory failed'))`
  - [ ] Import `DoltMergeConflict` from `'../state/index.js'` (use `import type` for type checking, regular import for `instanceof`)
  - [ ] All three calls are guarded by `stateStore?.` — no change in behavior when `stateStore` is absent
  - [ ] Unit test in `orchestrator-state-store.test.ts`: spy on `stateStore.branchForStory`, `mergeStory`, `rollbackStory`; verify each is called at the correct lifecycle point
  - [ ] Integration test: instantiate orchestrator with `FileStateStore`, dispatch 3 stories, verify all three stories complete and no-op branch calls do not throw

- [ ] Task 8: Build and test validation (all ACs)
  - [ ] Run `npm run build` — confirm zero TypeScript errors
  - [ ] Run `npm run test:fast` — confirm all tests pass, no regressions
  - [ ] Run `npm run test:changed` — confirm new test files are covered

## Dev Notes

### Architecture Constraints
- **File paths**:
  - `src/modules/state/types.ts` — add `StoryDiff`, `TableDiff`, `DiffRow`; update `diffStory` return type
  - `src/modules/state/index.ts` — export new types
  - `src/modules/state/file-store.ts` — implement stub branch methods (no-ops)
  - `src/modules/state/dolt-store.ts` — implement all branch/merge/rollback/diff methods
  - `src/modules/implementation-orchestrator/orchestrator-impl.ts` — wire lifecycle calls
  - `src/modules/state/__tests__/dolt-store-branch.test.ts` — new test file for branch operations
  - `src/modules/implementation-orchestrator/__tests__/orchestrator-state-store.test.ts` — extend with branch lifecycle assertions (file from story 26-4)
- **Import style**: ES modules with `.js` extension on all relative imports
- **Node builtins**: use `node:` prefix (e.g., `import { execSync } from 'node:child_process'`)
- **Type imports**: use `import type { ... }` for type-only imports; `DoltMergeConflict` needs a regular import (used with `instanceof`)
- **No new npm packages**: all branch operations go through `DoltClient` (from story 26-3) using Dolt stored procedures via SQL
- **Logger**: `createLogger('modules:state:dolt-store')` in `dolt-store.ts`; reuse existing orchestrator logger

### Dolt Branch Operations via SQL Stored Procedures

All git-level Dolt operations execute through SQL so they work in both server mode (mysql2) and CLI mode (`dolt sql -q`):

```sql
-- Create a branch from main
CALL DOLT_BRANCH('story/26-7');

-- Merge story branch into main (execute while targeting 'main' branch)
CALL DOLT_MERGE('story/26-7');

-- Commit after merge
CALL DOLT_COMMIT('-m', 'Merge story 26-7: COMPLETE');

-- Drop a branch
CALL DOLT_BRANCH('-D', 'story/26-7');

-- Diff between main and story branch for a table
SELECT * FROM DOLT_DIFF('main', 'story/26-7', 'stories');
```

For targeting a specific branch in CLI mode, use the `-b` / `--branch` flag:
```bash
dolt sql -b main -q "CALL DOLT_MERGE('story/26-7')"
```

For server mode (mysql2), switch branch context per query by passing a `branch` parameter to `DoltClient.query(branch, sql, params)` — the client should construct the database name as `substrate/main` or `substrate/story/26-7`.

### `DoltClient` Branch Targeting (from story 26-3)

The `DoltClient` from story 26-3 should already accept a branch parameter. If `query(branch: string, sql: string, params?: unknown[])` is not yet the signature, adapt as follows without breaking existing callers:

```typescript
// Preferred signature (if DoltClient supports it)
await this._client.query('story/26-7', 'INSERT INTO stories ...', [...params]);

// CLI fallback
await this._client.exec(['sql', '-b', 'story/26-7', '-q', sql]);
```

If `DoltClient` does not yet accept a branch argument on `query()`, add an optional second parameter with default `'main'` — this is additive and backward-compatible.

### Merge Conflict Detection

Dolt's `DOLT_MERGE()` stored procedure returns a result set with a `conflicts` column indicating the count of conflicts. When `conflicts > 0`, query `dolt_conflicts_<table>` to get cell-level detail:

```sql
-- After DOLT_MERGE detects conflicts:
SELECT base_story_key, our_status, their_status
FROM dolt_conflicts_stories;
```

Construct and throw `DoltMergeConflict` with whatever fields the 26-3 definition uses. If `DoltMergeConflict` from story 26-3 doesn't exist yet, define it locally in `dolt-store.ts` and re-export it from `src/modules/state/index.ts`.

### Branch Routing for Write Methods

The core pattern for routing writes to the story branch:

```typescript
private _branchFor(storyKey?: string): string {
  if (storyKey && this._storyBranches.has(storyKey)) {
    return this._storyBranches.get(storyKey)!;
  }
  return 'main';
}

async setStoryState(storyKey: string, record: StoryRecord): Promise<void> {
  const branch = this._branchFor(storyKey);
  await this._client.query(branch, 'INSERT INTO stories ...', [...]);
  await this._client.exec(['sql', '-b', branch, '-q', `CALL DOLT_COMMIT(...)`]);
}
```

**Reads always target `main`** — the merged branch is the canonical read source. Only writes are branch-isolated. This ensures `queryStories({})` always returns the committed state, not in-flight story-branch state.

### Orchestrator Integration Pattern

In `orchestrator-impl.ts`, the three branch calls must be fire-and-forget (never throw into the orchestrator's main path):

```typescript
// Before dispatch:
void this._stateStore?.branchForStory(storyKey)
  .catch(err => this._logger.warn({ err, storyKey }, 'branchForStory failed — continuing without isolation'));

// On COMPLETE:
void this._stateStore?.mergeStory(storyKey)
  .catch(err => {
    if (err instanceof DoltMergeConflict) {
      this._eventBus.emit('pipeline:state-conflict', { storyKey, conflict: err });
    } else {
      this._logger.warn({ err, storyKey }, 'mergeStory failed');
    }
  });

// On FAILED or ESCALATED:
void this._stateStore?.rollbackStory(storyKey)
  .catch(err => this._logger.warn({ err, storyKey }, 'rollbackStory failed — branch may persist'));
```

Use `import type { DoltMergeConflict } from '../state/index.js'` for typing, but also `import { DoltMergeConflict } from '../state/index.js'` for the `instanceof` check. TypeScript allows both when `DoltMergeConflict` is a class (not just an interface).

### Testing Requirements
- **Framework**: vitest (NOT jest). Run with `npm run test:fast`
- **Coverage threshold**: 80% enforced — do not drop below
- **DoltStateStore tests**: skip if `dolt` binary not on PATH; use mocked `DoltClient` for unit tests (do not require a real Dolt binary)
- **Parallel isolation test**: create 3 `FileStateStore`-backed orchestrators (or stub DoltStateStores), dispatch concurrently with `Promise.all`, verify no cross-contamination in the stored state
- **Test file locations**:
  - `src/modules/state/__tests__/dolt-store-branch.test.ts` — new, covers AC1–AC6
  - `src/modules/implementation-orchestrator/__tests__/orchestrator-state-store.test.ts` — extend existing file from story 26-4 with branch lifecycle assertions (AC7)
- **Mock pattern for DoltClient**:
  ```typescript
  const mockClient = { query: vi.fn().mockResolvedValue([]), exec: vi.fn().mockResolvedValue('') }
  const store = new DoltStateStore({ client: mockClient, repoPath: '/tmp/test' })
  ```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
