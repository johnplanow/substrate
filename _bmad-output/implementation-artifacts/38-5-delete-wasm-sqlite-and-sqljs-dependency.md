# Story 38-5: Delete WasmSqlite Adapter and Remove sql.js Dependency

Status: ready
Depends on: 38-2, 38-3a, 38-3b, 38-4

## Story

As a substrate developer,
I want the `WasmSqliteDatabaseAdapter`, its type declaration, and the `sql.js` package dependency removed from the codebase,
so that SQLite is completely eliminated and cannot silently re-enter the project.

## Acceptance Criteria

### AC1: WasmSqlite Adapter Deleted
**Given** the file `src/persistence/wasm-sqlite-adapter.ts`
**When** I check the codebase
**Then** it does not exist

### AC2: Type Declaration Deleted
**Given** the file `src/sql-js.d.ts`
**When** I check the codebase
**Then** it does not exist

### AC3: sql.js Removed from package.json
**Given** `package.json`
**When** I check dependencies and devDependencies
**Then** `sql.js` does not appear

### AC4: Zero Import/Runtime References Remain
**Given** a grep for `wasm-sqlite|WasmSqlite|sql\.js|createWasmSqliteAdapter` in the entire `src/` and `test/` directories
**When** I search
**Then** zero import statements or runtime references remain. Stale comments referencing these terms must be updated or removed.

### AC5: Build Passes
**Given** the cleaned codebase
**When** I run `npm run build`
**Then** it succeeds with no errors

### AC6: Full Test Suite Passes With No Regressions
**Given** the cleaned codebase
**When** I run `npm run test:fast`
**Then** all test files pass (zero `Failed to load url sql.js` errors) and the total passing test count is >= 5800 (current passing: 4849 + the ~1036 that currently fail due to sql.js = ~5885 expected)

## Tasks / Subtasks

- [ ] Task 1: Delete dead files (AC: #1, #2)
  - [ ] Delete `src/persistence/wasm-sqlite-adapter.ts`
  - [ ] Delete `src/sql-js.d.ts`

- [ ] Task 2: Remove sql.js dependency (AC: #3)
  - [ ] Remove `"sql.js": "^1.14.1"` from `package.json`
  - [ ] Run `npm install` to update lockfile

- [ ] Task 3: Clean up all stale references (AC: #4)
  - [ ] Grep for any remaining `wasm-sqlite`, `WasmSqlite`, `sql.js`, `createWasmSqliteAdapter` in `src/` and `test/`
  - [ ] Remove or update import statements, comments, and error messages
  - [ ] Update `src/persistence/adapter.ts` doc comments that reference WasmSqlite
  - [ ] Update `src/persistence/monitor-database.ts` if any references remain

- [ ] Task 4: Verify build and tests (AC: #5, #6)
  - [ ] Run `npm run build` — must succeed
  - [ ] Run `npm run test:fast` — all test files must pass
  - [ ] Verify zero `Failed to load url sql.js` errors in test output
  - [ ] Verify total passing tests >= 5800

## Dev Notes

### Architecture Constraints
- This story MUST run last after 38-2, 38-3a, 38-3b, and 38-4 are complete
- If any test still references WasmSqlite, this story will fail at AC4/AC6 — that's intentional; it validates the prior stories
- The `SyncAdapter` interface in `adapter.ts` stays — it's a valid interface now implemented by InMemoryDatabaseAdapter

### File List
- `src/persistence/wasm-sqlite-adapter.ts` (delete)
- `src/sql-js.d.ts` (delete)
- `package.json` (modify — remove sql.js)
- `src/persistence/adapter.ts` (modify — update comments)
- `src/persistence/monitor-database.ts` (modify — update references if any remain)
