# Story 29-2: Remove better-sqlite3 Dependency from FileStateStore

Status: complete

## Story

As a substrate developer installing the CLI,
I want `FileStateStore` to operate without any `better-sqlite3` dependency,
so that the state module is a pure in-memory TypeScript implementation with no native C++ compilation requirements.

## Acceptance Criteria

### AC1: file-store.ts contains zero better-sqlite3 imports
**Given** `src/modules/state/file-store.ts` after this story's changes
**When** a developer inspects all import statements at the top of the file
**Then** there are no imports from `'better-sqlite3'` and no imports from `'../../persistence/queries/metrics.js'`

### AC2: FileStateStoreOptions.db field removed
**Given** the `FileStateStoreOptions` interface exported from `file-store.ts`
**When** a caller attempts `new FileStateStore({ db: someDb, basePath: '...' })`
**Then** TypeScript emits a compile error — the `db` field no longer exists on the interface; the only accepted option is `basePath?: string`

### AC3: FileStateStore.recordMetric uses only in-memory storage
**Given** a `FileStateStore` instance with no SQLite database
**When** `recordMetric(metric)` is called with a valid `MetricRecord`
**Then** the metric is appended to the internal `_metrics` array and is immediately retrievable via `queryMetrics`; no SQLite write is attempted under any circumstances

### AC4: src/cli/commands/run.ts updated to drop the db option
**Given** the `runPipelineAction` function in `src/cli/commands/run.ts`
**When** it constructs the `FileStateStore` instance (previously `new FileStateStore({ db, basePath: dbDir })`)
**Then** the call is changed to `new FileStateStore({ basePath: dbDir })` — the `db` argument is removed because the `FileStateStore` no longer accepts it

### AC5: All unit tests in file-store.test.ts pass without SQLite mocks
**Given** `src/modules/state/__tests__/file-store.test.ts`
**When** `npm run test:fast` runs
**Then** all tests in that file pass; no test sets up or expects any SQLite database mock; each test suite uses a fresh `new FileStateStore()` instance with no constructor arguments

### AC6: npm run build exits 0 after all changes
**Given** all file changes described in ACs 1–5 are applied
**When** `npm run build` runs
**Then** the TypeScript compiler exits 0 with zero type errors across the entire project — in particular no errors in `file-store.ts` or `run.ts`

### AC7: CHANGELOG upgrade warning added for pre-29 SQLite users
**Given** a user who ran substrate pipeline runs before Epic 29 and has historical metrics in `.substrate/*.db` SQLite files
**When** they read `CHANGELOG.md` (or the first lines of the README upgrade section)
**Then** they see a clear warning: "Epic 29 (v0.4.x): FileStateStore no longer persists metrics to SQLite. Users with pre-29 SQLite metric data who want to retain it should run `substrate migrate` (from Epic 26-13) before upgrading to move data to Dolt. After upgrade, all new metrics are stored in Dolt when Dolt is available, or are ephemeral in-memory when FileStateStore is used (CI environments)."

## Tasks / Subtasks

- [x] Task 1: Remove `db?` from `FileStateStoreOptions` and `FileStateStore` class body (AC: #1, #2, #3)
  - [x] In `src/modules/state/file-store.ts`, delete the line `import type { Database as BetterSqlite3Database } from 'better-sqlite3'`
  - [x] In `src/modules/state/file-store.ts`, delete the line `import { writeStoryMetrics } from '../../persistence/queries/metrics.js'`
  - [x] In `FileStateStoreOptions`, remove the `db?: BetterSqlite3Database` field entirely — the interface should only have `basePath?: string`
  - [x] In the `FileStateStore` class, remove the `private readonly _db: BetterSqlite3Database | undefined` field declaration
  - [x] In the `FileStateStore` constructor, remove the `this._db = options.db` assignment

- [x] Task 2: Remove the SQLite write path from `recordMetric` (AC: #3)
  - [x] In `FileStateStore.recordMetric`, delete the entire `if (this._db) { writeStoryMetrics(this._db, { ... }) }` block (approximately lines 119–131 of current file)
  - [x] Verify the in-memory push (`this._metrics.push(record)`) remains intact
  - [x] Remove the now-unused `/** Additionally persist to SQLite when a DB is available. */` comment

- [x] Task 3: Update `src/cli/commands/run.ts` to drop the `db` option from FileStateStore (AC: #4)
  - [x] Find the line `const stateStore = new FileStateStore({ db, basePath: dbDir })` (around line 553)
  - [x] Change it to `new FileStateStore({ basePath: dbDir })` — no direct FileStateStore instantiation in run.ts (uses createStateStore factory); AC4 is satisfied because the factory already passes no db arg
  - [x] The `db` variable itself is still used elsewhere in `run.ts` (for orchestrator deps, pipeline run metrics, etc.) — not removed

- [x] Task 4: Verify `file-store.test.ts` requires no SQLite mock changes (AC: #5)
  - [x] Confirmed all tests use `new FileStateStore()` or `new FileStateStore({ basePath: '...' })` with no `db` option
  - [x] No tests pass `db` to the constructor
  - [x] The existing `vi.mock('node:fs/promises', ...)` is kept for the `setContractVerification` basePath test

- [x] Task 5: Run build to confirm zero TypeScript errors (AC: #6)
  - [x] `npm run build` exits 0 — no TypeScript errors

- [x] Task 6: Run tests to confirm no regressions (AC: #5, #6)
  - [x] `npm run test:fast` — 220 Test Files passed, 5317 Tests passed

- [x] Task 7: Add CHANGELOG upgrade warning (AC: #7)
  - [x] Open (or create) `CHANGELOG.md` in the project root
  - [x] Add an entry under a `## [Unreleased]` or `## v0.4.x` heading with the upgrade warning described in AC7
  - [x] Keep it concise: 3–5 sentences covering what changed, who is affected, and the remediation step (`substrate migrate`)

## Dev Notes

### Architecture Constraints

- **File locations (must match exactly)**:
  - Primary change: `src/modules/state/file-store.ts` — remove imports and `db?` interface field
  - Secondary change: `src/cli/commands/run.ts` — remove `db` from FileStateStore constructor (one line)
  - Tests: `src/modules/state/__tests__/file-store.test.ts` — likely no changes needed (all tests already use in-memory path)
  - Documentation: `CHANGELOG.md` in project root

- **Import style**: All imports use `.js` extensions (ESM). When removing imports, ensure no orphaned `.js` import lines remain.

- **Test framework**: Vitest — `vi.mock`, `vi.fn()`, `vi.hoisted`. The `vi.mock('node:fs/promises', ...)` at the top of `file-store.test.ts` is still needed for the `setContractVerification` basePath test.

- **run.ts context**: The `db` variable in `run.ts` is the SQLite `BetterSqlite3Database` used by the orchestrator, context compiler, and decision store. It is NOT being removed in this story — only the FileStateStore constructor call drops it. The rest of `run.ts`'s `db` usage is unchanged.

- **Package.json note**: Story 29-2 does NOT remove `better-sqlite3` from `package.json`. The `src/persistence/` SQLite layer (`src/persistence/database.ts`, `src/persistence/queries/*.ts`) and several CLI commands still import it for decisions, run metrics, and telemetry. Full package removal requires migrating that layer to Dolt, which is tracked as a follow-on beyond this epic. This story's contribution is making `src/modules/state/file-store.ts` (and the state module) SQLite-free.

- **What is already in-memory**: Contracts (`setContracts`, `getContracts`, `queryContracts`, `setContractVerification`, `getContractVerification`) are already purely in-memory in `FileStateStore`. No changes needed to those methods — they have never used SQLite.

- **The `db?` option history**: The `db?: BetterSqlite3Database` option was added early in the project to give the FileStateStore optional SQLite metric persistence. With Dolt as the default backend (`createStateStore()` returning `DoltStateStore` when Dolt is present — from story 29-1), this SQLite fallback serves no purpose. The in-memory path already existed for CI environments.

- **callers that pass `db` to FileStateStore**: Only one production caller exists: `src/cli/commands/run.ts` line ~553. All other callers in tests and the factory use `new FileStateStore()` or `new FileStateStore({ basePath: ... })` without `db`. Confirm this with a project-wide search for `new FileStateStore({` before submitting.

### Testing Requirements

- **Unit tests**: No new test file needed. The existing `src/modules/state/__tests__/file-store.test.ts` already covers all in-memory paths. Verify it still passes.
- **Affected tests**: `src/modules/state/__tests__/file-store.test.ts`, potentially `src/modules/state/__tests__/state-store.contract.test.ts` (which runs FileStateStore through the full contract suite)
- **Coverage**: The removal of the SQLite conditional branch slightly reduces branch count but does not lower coverage — the branch being removed was the only SQLite path and was never exercised in tests.
- **Test run command**: `npm run test:fast` (unit only, no coverage, ~50s). Look for "Test Files" in output. NEVER pipe through `head`/`tail`/`grep`.

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All AC1–AC7 changes were already applied (likely by the story 29-1 agent as cleanup). Verified each AC against current source.
- `file-store.ts`: zero better-sqlite3 or writeStoryMetrics imports; FileStateStoreOptions has only basePath; recordMetric is pure in-memory.
- `run.ts`: No direct FileStateStore instantiation exists — the factory (`createStateStore`) handles construction; AC4 is satisfied.
- `file-store.test.ts`: All tests use `new FileStateStore()` with no db arg; vi.mock for fs/promises retained.
- `CHANGELOG.md`: Upgrade warning already present under `## [Unreleased] — v0.4.x`.
- Build: exit 0, 0 type errors. Tests: 220 files, 5317 tests, all passing.

### File List
- /home/jplanow/code/jplanow/substrate/src/modules/state/file-store.ts (verified clean — no changes needed)
- /home/jplanow/code/jplanow/substrate/src/cli/commands/run.ts (verified clean — no FileStateStore({db}) call exists)
- /home/jplanow/code/jplanow/substrate/src/modules/state/__tests__/file-store.test.ts (verified clean — no db arg)
- /home/jplanow/code/jplanow/substrate/CHANGELOG.md (verified — upgrade warning present)
- /home/jplanow/code/jplanow/substrate/_bmad-output/implementation-artifacts/29-2-remove-better-sqlite3-dependency.md (story status updated)

## Change Log
