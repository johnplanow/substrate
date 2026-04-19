# Story 26-8: Status + Health CLI Migration

Status: complete

## Story

As a pipeline operator,
I want `substrate status` and `substrate health` to query story state from the StateStore instead of only the SQLite decision store,
so that when the Dolt backend is active, pipeline state is sourced from a single queryable truth layer with commit-history support.

## Acceptance Criteria

### AC1: Status Command Reads Story States from StateStore
**Given** a StateStore is passed to `runStatusAction` (file or Dolt backend)
**When** `substrate status` is invoked
**Then** story phase data is read via `stateStore.queryStories({})` and rendered in the existing human-readable format (one line per story: `key: PHASE (N review cycles)`)
**And** the existing `pipeline_runs` / `token_usage_json` SQLite path remains as a fallback when StateStore is not provided or returns no stories

### AC2: Status JSON Output Includes StateStore Story Data
**Given** a StateStore is provided and contains story records
**When** `substrate status --output-format json` is invoked
**Then** the JSON response includes a top-level `story_states` array of `StoryRecord` objects from `queryStories({})`
**And** the existing `story_metrics` and `pipeline_metrics` fields are preserved alongside the new field

### AC3: Health Command Includes Dolt Connectivity Check
**Given** `substrate health` is invoked with a Dolt-backend StateStore
**When** the health action runs
**Then** the `PipelineHealthOutput` object includes a `dolt_state` field: `{ initialized: boolean; responsive: boolean; version?: string }`
**And** if the `.substrate/state/` Dolt repo does not exist, `dolt_state.initialized` is `false` and `dolt_state.responsive` is `false`
**And** if Dolt is initialized but `dolt version` throws an error, `dolt_state.responsive` is `false`
**And** when `--output-format json` is used, `dolt_state` appears in the JSON output

### AC4: Status History Flag Shows Dolt Commit Log
**Given** `substrate status --history` is invoked with a Dolt backend
**When** the StateStore has commit history (populated by story branch merges from story 26-7)
**Then** human output shows a table of the last 20 entries with columns: `TIMESTAMP`, `HASH` (7 chars), and `MESSAGE`
**And** with `--output-format json --history`, a structured JSON array of `HistoryEntry` objects is returned
**And** when the file backend is active, `--history` prints: `History not available with file backend. Use Dolt backend for state history.` and exits 0

### AC5: StateStore Interface Extended with getHistory
**Given** the `StateStore` interface in `src/modules/state/types.ts`
**When** other modules import it
**Then** the interface additionally exports:
- `HistoryEntry` interface: `{ hash: string; message: string; timestamp: string; author?: string }`
- `getHistory(limit?: number): Promise<HistoryEntry[]>` — return commit log entries, empty array for file backend
**And** `FileStateStore` implements `getHistory()` returning `[]`
**And** `DoltStateStore` implements `getHistory(limit?)` by running `dolt log --oneline -n <limit>` in `.substrate/state/` via `DoltClient.runCli()`, parsing each line as `hash message` with the commit timestamp

### AC6: Backward Compatibility with File Backend
**Given** no `state.backend` config is present (defaults to file)
**When** `substrate status` or `substrate health` is invoked
**Then** behavior is identical to the pre-26-8 implementation: reads from SQLite decision store, no `dolt_state` field in health output, `--history` prints the unavailability message and exits 0

### AC7: StateStore Factory Wired in CLI Registration
**Given** a substrate config with `state.backend: dolt` (or `file`)
**When** `registerStatusCommand` or `registerHealthCommand` registers the command
**Then** the action handler calls `createStateStore({ backend, basePath, doltPort })`, calls `initialize()` before use, and calls `close()` in a `finally` block
**And** if config loading fails or throws, the command proceeds without a StateStore (degraded mode — backward compat)

## Interface Contracts

- **Import**: `StateStore`, `StoryRecord`, `StateStoreConfig`, `createStateStore` @ `src/modules/state/index.ts` (from story 26-1)
- **Import**: `DoltStateStore` @ `src/modules/state/dolt-store.ts` (from story 26-3)
- **Export**: `HistoryEntry` @ `src/modules/state/types.ts` (new type extension to the 26-1 interface)

## Tasks / Subtasks

- [x] Task 1: Extend StateStore interface with `HistoryEntry` and `getHistory` (AC5)
  - [x] Add `HistoryEntry` interface to `src/modules/state/types.ts`: `{ hash: string; message: string; timestamp: string; author?: string }`
  - [x] Add `getHistory(limit?: number): Promise<HistoryEntry[]>` method signature to the `StateStore` interface in `types.ts`
  - [x] Export `HistoryEntry` from `src/modules/state/index.ts`
  - [x] Implement `getHistory()` in `FileStateStore` (`src/modules/state/file-store.ts`): always resolves to `[]`
  - [x] Implement `getHistory(limit = 20)` in `DoltStateStore` (`src/modules/state/dolt-store.ts`): call `this._client.runCli(['log', '--oneline', `-n`, `${limit}`], this._repoPath)`; parse each stdout line as `<hash7> <rest>` — set `hash` to first token, `message` to remainder, `timestamp` to empty string (oneline log omits timestamp); for full timestamps use `dolt log --pretty=format:"%H|%s|%ai" -n <limit>` and split on `|`
  - [x] Unit tests in `src/modules/state/__tests__/file-store.test.ts`: `getHistory()` returns `[]`
  - [x] Unit tests in `src/modules/state/__tests__/dolt-store.test.ts`: mock `DoltClient.runCli` returning sample log lines; verify `HistoryEntry[]` shape

- [x] Task 2: Add StateStore-aware story fetch to `runStatusAction` (AC1, AC2, AC6)
  - [x] Add `stateStore?: StateStore` and `history?: boolean` to `StatusOptions` interface in `src/cli/commands/status.ts`
  - [x] In `runStatusAction`: after the existing SQLite run query, call `const storeStories = stateStore ? await stateStore.queryStories({}) : []`
  - [x] Human output: if `storeStories.length > 0`, render story section using `storeStories` (override the `token_usage_json` blob parsing); else keep existing rendering
  - [x] JSON output: add `story_states: storeStories` to the `enhancedOutput` object (before `story_metrics`); empty array when no StateStore
  - [x] Guard all StateStore calls with `try/catch` — log and continue without store data on error
  - [x] Unit tests in `src/cli/commands/__tests__/status-store-integration.test.ts`: test with mock StateStore returning stories; verify JSON output includes `story_states`

- [x] Task 3: Add `--history` flag to status command (AC4, AC6)
  - [x] Add `--history` boolean option to `registerStatusCommand` in `status.ts`
  - [x] In `runStatusAction`: when `options.history === true`:
    - If no `stateStore`: print `History not available with file backend. Use Dolt backend for state history.\n` to stdout; return 0
    - Else: call `const entries = await stateStore.getHistory(20)`
    - Human: print header `TIMESTAMP            HASH     MESSAGE`, then one line per entry (pad columns)
    - JSON: print `JSON.stringify(entries, null, 2)` and return 0 immediately (skip normal status output)
  - [x] Unit tests: `--history` with mock StateStore returning 3 entries (human format, JSON format); file backend message

- [x] Task 4: Add Dolt connectivity check to `getAutoHealthData` and `PipelineHealthOutput` (AC3, AC6)
  - [x] Add `DoltStateInfo` interface to `health.ts`: `{ initialized: boolean; responsive: boolean; version?: string }`
  - [x] Add optional `dolt_state?: DoltStateInfo` to `PipelineHealthOutput` interface
  - [x] Add `stateStore?: StateStore` parameter to `getAutoHealthData` options type
  - [x] In `getAutoHealthData`: if `stateStoreConfig.backend === 'dolt'`, compute `dolt_state`:
    - `initialized`: check `existsSync(join(repoPath, '.dolt'))`
    - `responsive`: try `await stateStore.getHistory(1)` — success → `true`; catch → `false`
    - `version`: parse from `dolt version` output via execFile
  - [x] Expose `dolt_state` in `runHealthAction` JSON and human output
  - [x] Human: add `  Dolt State:   initialized=yes responsive=yes (vX.Y.Z)\n` line when `dolt_state` present
  - [x] Unit tests in `src/cli/commands/__tests__/health-dolt-state.test.ts`: verify `dolt_state` field presence; verify file backend path omits `dolt_state`

- [x] Task 5: Wire StateStore factory into CLI registration (AC7, AC6)
  - [x] In `registerStatusCommand` (`status.ts`): detect `.substrate/state/.dolt`; build StateStore via `createStateStore()`; pass to `runStatusAction`
  - [x] Wrap `createStateStore` in `try/catch`; on any error, pass `stateStore: undefined` (backward compat)
  - [x] In `registerHealthCommand` (`health.ts`): same pattern — build StateStore, pass to `runHealthAction` which forwards to `getAutoHealthData`
  - [x] Call `await stateStore.initialize()` before use; call `await stateStore.close()` in `finally`
  - [x] Unit tests: verify that when stateStore is undefined, `runStatusAction` is still called (degraded mode)

- [x] Task 6: Contract test suite update and integration tests (AC1, AC5, AC7)
  - [x] `getHistory` in shared contract test suite (`state-store.contract.test.ts`): verified method exists and returns an array
  - [x] Integration test file `src/cli/commands/__tests__/status-store-integration.test.ts`:
    - Test: `runStatusAction` with no stateStore → `story_states` is empty array (falls back)
    - Test: `runStatusAction` with mock store returning 2 stories → `story_states` in JSON has 2 entries
    - Test: `runStatusAction` with history=true, mock store returning 3 HistoryEntries → table rendered with 3 rows
    - Test: `getAutoHealthData` with mock DoltStateStore → `dolt_state.initialized` and `dolt_state.responsive` present
    - Test: degraded mode — `runStatusAction` works when stateStore is undefined
    - Test: degraded mode — `runStatusAction` works when queryStories throws
  - [x] Run `npm run test:fast` — 4604 tests pass (181 files)

## Dev Notes

### Architecture Constraints
- **File paths**: `src/modules/state/types.ts` (extend interface + add HistoryEntry), `src/modules/state/file-store.ts` (implement getHistory), `src/modules/state/dolt-store.ts` (implement getHistory), `src/cli/commands/status.ts` (StateStore-aware status), `src/cli/commands/health.ts` (Dolt connectivity check + StateStore wiring)
- **Import style**: ES modules with `.js` extensions on all local imports (e.g., `import { createStateStore } from '../../modules/state/index.js'`)
- **Node builtins**: use `node:` prefix (e.g., `import { existsSync } from 'node:fs'`)
- **Type imports**: use `import type { ... }` for type-only imports
- **Interface extension is additive**: adding `getHistory` to `StateStore` requires implementing it in both `FileStateStore` and `DoltStateStore`. TypeScript will error if either class is missing the new method — fix both before running `npm run build`.
- **Logger**: `import { createLogger } from '../../utils/logger.js'`; reuse existing namespaces (`'status-cmd'`, `'health-cmd'`)
- **DoltStateStore instanceof check**: to avoid a circular import, check for the Dolt backend via `config.backend === 'dolt'` (from StateStoreConfig) rather than `instanceof DoltStateStore` — this keeps health.ts decoupled from dolt-store.ts

### StateStore Wiring Pattern

```typescript
// In registerStatusCommand action handler:
let stateStore: StateStore | undefined
try {
  const config = await loadSubstrateConfig(projectRoot)
  stateStore = createStateStore({
    backend: config.state?.backend ?? 'file',
    basePath: config.state?.basePath,
    doltPort: config.state?.doltPort,
  })
  await stateStore.initialize()
} catch {
  // Degraded mode — proceed without StateStore
  stateStore = undefined
}
try {
  const exitCode = await runStatusAction({ outputFormat, runId, projectRoot, stateStore, history })
  process.exitCode = exitCode
} finally {
  try { await stateStore?.close() } catch { /* ignore */ }
}
```

### DoltStateStore.getHistory Implementation Pattern

```typescript
async getHistory(limit = 20): Promise<HistoryEntry[]> {
  const raw = await this._client.runCli(
    ['log', '--pretty=format:%H|%s|%ai', `-n`, `${limit}`],
    this._repoPath
  )
  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => {
      const [hash = '', message = '', timestamp = ''] = line.split('|')
      return { hash: hash.slice(0, 7), message: message.trim(), timestamp: timestamp.trim() }
    })
}
```

### PipelineHealthOutput Extension

```typescript
export interface DoltStateInfo {
  initialized: boolean
  responsive: boolean
  version?: string
}

export interface PipelineHealthOutput {
  // ... existing fields ...
  dolt_state?: DoltStateInfo
}
```

Add `dolt_state` only when the Dolt backend is configured — omit it entirely for file backend to preserve the existing JSON contract for callers that don't use Dolt.

### Backward Compatibility Guarantee

The existing `runStatusAction` and `runHealthAction` call signatures are preserved. New parameters (`stateStore`, `history`) are **optional** in `StatusOptions` and `HealthOptions`. When undefined, all existing code paths execute unchanged. No existing tests need modification unless they break due to the `PipelineHealthOutput` type extension (which is additive and backward-compatible).

### Config Loader Reference

Check `src/config/` or `src/utils/` for the existing substrate config loader (used by `run.ts` and `supervisor.ts`). Common pattern in this codebase: `readSubstrateConfig(projectRoot)` or `loadConfig(projectRoot)`. Search for where `state.backend` config is consumed post-26-1.

### Testing Requirements
- **Framework**: vitest (NOT jest). Run with `npm run test:fast`.
- **Coverage threshold**: 80% enforced — do not drop below.
- **New test files**: `src/cli/commands/__tests__/status-store-integration.test.ts` for integration; extend existing `src/cli/commands/__tests__/status.test.ts` and `src/cli/commands/__tests__/health.test.ts` for new flags and fields
- **DoltStateStore tests**: skip if `dolt` binary not found on PATH (`try { execSync('dolt version') } catch { return }`)
- **Mock pattern**: use `vi.fn()` to create mock StateStore satisfying the `StateStore` interface; inject via `StatusOptions.stateStore`

## Dev Agent Record

### Agent Model Used
claude-opus-4-20250514

### Completion Notes List
- Fixed missing `_storyBranches` Map and `_branchFor` method on DoltStateStore class (causing runtime errors in branch/diff operations)
- Fixed missing `MergeResultRow` and `ConflictRow` interfaces in dolt-store.ts
- Added `author?: string` field to `HistoryEntry` interface per AC5 spec (review finding 3)
- Verified `DoltMergeConflict` alias exists in errors.ts and is re-exported from index.ts (review finding 4 — was already correct)
- Added comprehensive happy-path integration tests for AC1/AC2 (review finding 2) — tests verify `story_states` in JSON output when DB exists and StateStore provides stories
- Added degraded mode tests for AC7 (review finding 5) — tests verify runStatusAction works when stateStore is undefined or queryStories throws
- Restored `execFile` and `promisify` imports that were inadvertently removed from dolt-store.ts
- All 4604 tests pass, build succeeds

### File List
- src/modules/state/types.ts (added `author?: string` to HistoryEntry)
- src/modules/state/dolt-store.ts (added `_storyBranches` Map, `_branchFor` method, `MergeResultRow`/`ConflictRow` interfaces, restored execFile imports)
- src/cli/commands/__tests__/status-store-integration.test.ts (NEW — integration tests for AC1/AC2/AC4/AC6/AC7)
- _bmad-output/implementation-artifacts/26-8-status-health-cli-migration.md (updated status and task checkboxes)

## Change Log
- 2026-03-09: Rework implementation addressing all 5 review findings. Added missing class members to DoltStateStore, fixed HistoryEntry type, added comprehensive integration tests.
