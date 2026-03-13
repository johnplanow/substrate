# Story 29-9: Migrate Test Files from better-sqlite3 to WASM Mock + Delete Legacy Files

Status: pending

## Story

As a substrate developer,
I want all test files to use the WASM-backed `better-sqlite3` mock (sql.js) instead of the native C++ module,
so that `better-sqlite3` can be fully removed from `package.json` (including devDependencies) and the legacy SQLite adapter/wrapper/migration files can be deleted.

## Context

Story 29-8 moved `better-sqlite3` from production dependencies to devDependencies and scaffolded the WASM mock infrastructure:
- `src/__mocks__/better-sqlite3.ts` — sql.js-backed mock with named parameter support and path caching
- `src/persistence/schema.ts` — consolidated DDL (replaces 11 migration files)
- `src/persistence/wasm-sqlite-adapter.ts` — DatabaseAdapter backed by sql.js

87 test files still import `better-sqlite3` directly. Once migrated, the following files can be deleted.

## Acceptance Criteria

### AC1: vitest alias redirects better-sqlite3 imports
**Given** `vitest.config.ts`
**When** any test file imports `better-sqlite3`
**Then** the import resolves to `src/__mocks__/better-sqlite3.ts` (WASM mock) via `resolve.alias`

### AC2: File-based integration tests adapted
**Given** tests that create file-path SQLite databases (e.g. `new Database(join(tmpDir, 'substrate.db'))`)
**When** those tests run with the WASM mock
**Then** they work correctly — either via the mock's path-caching or by refactoring to use DatabaseAdapter directly

### AC3: SqliteDatabaseAdapter deleted
**Given** all test consumers migrated to use `WasmSqliteDatabaseAdapter` or `InMemoryDatabaseAdapter`
**When** no import of `SqliteDatabaseAdapter` remains
**Then** `src/persistence/sqlite-adapter.ts` is deleted

### AC4: DatabaseWrapper deleted
**Given** all test consumers migrated
**When** no import of `DatabaseWrapper` or `DatabaseServiceImpl` remains
**Then** `src/persistence/database.ts` is deleted

### AC5: Migration files deleted
**Given** tests use `initSchema(adapter)` from `src/persistence/schema.ts` instead of `runMigrations(db)`
**When** no import of `runMigrations` remains
**Then** `src/persistence/migrations/` directory is deleted (all 11 migration files + index.ts + monitor schema)

### AC6: better-sqlite3 removed from devDependencies
**Given** no source or test file imports `better-sqlite3` directly
**When** `package.json` is inspected
**Then** neither `better-sqlite3` nor `@types/better-sqlite3` appear anywhere in package.json

### AC7: All tests pass
**Given** the complete test suite
**When** `npm run test:fast` runs
**Then** all 6300+ tests pass with zero regressions

### AC8: Build passes
**Given** all deletions
**When** `npm run build` runs
**Then** it exits 0 with no type errors

## Dev Notes

### Known Edge Cases

1. **File-path integration tests**: Tests in `export-action.test.ts`, `auto-metrics.test.ts` create real file paths and check `existsSync(dbPath)`. The WASM mock's path cache handles same-path reuse, but `existsSync` checks fail since no real file is created. These tests need either:
   - A mock of `existsSync` for the DB path, or
   - Refactoring to use `DatabaseAdapter` directly (preferred)

2. **Named parameters**: The WASM mock handles `@param` → `$param` conversion for better-sqlite3's named parameter syntax. `monitor-database.ts` uses this extensively. Once tests use `DatabaseAdapter.query()` with positional `?` params, this is no longer needed.

3. **`runMigrations()` vs `initSchema()`**: Many tests call `runMigrations(db)` to set up schema. Replace with `await initSchema(adapter)` from `src/persistence/schema.ts`.

4. **`db.prepare()` / `db.pragma()` direct calls**: Some tests call better-sqlite3 APIs directly (not through adapter). These need refactoring to use adapter.query() or adapter.exec().

### Scaffolding Already Built (from 29-8)

- `src/__mocks__/better-sqlite3.ts` — Full mock with named params, path caching, transaction support
- `src/persistence/schema.ts` — Consolidated DDL with `initSchema(adapter: DatabaseAdapter)`
- `src/persistence/wasm-sqlite-adapter.ts` — `WasmSqliteDatabaseAdapter` + `createWasmSqliteAdapter()` factory

### Estimated Scope

- ~87 test files to migrate
- ~23 production source files still import `better-sqlite3` (but only for types; runtime paths already use DatabaseAdapter)
- 3 files to delete: `sqlite-adapter.ts`, `database.ts`, `migrations/` directory
- Suggest splitting into sub-tasks by directory (persistence tests, CLI tests, module tests, integration tests)

## Tasks

- [ ] Task 1: Add `better-sqlite3` vitest alias to `vitest.config.ts`
- [ ] Task 2: Migrate `src/persistence/__tests__/` (5 files)
- [ ] Task 3: Migrate `src/persistence/queries/__tests__/` (4 files)
- [ ] Task 4: Migrate `test/persistence/` (3 files)
- [ ] Task 5: Migrate `src/modules/` test files (~35 files)
- [ ] Task 6: Migrate `src/cli/commands/__tests__/` (~25 files)
- [ ] Task 7: Migrate `src/__tests__/` and `test/integration/` (~15 files)
- [ ] Task 8: Migrate production source files (type imports → remove or use local types)
- [ ] Task 9: Delete `sqlite-adapter.ts`, `database.ts`, `migrations/` directory
- [ ] Task 10: Remove `better-sqlite3` and `@types/better-sqlite3` from devDependencies
- [ ] Task 11: Run full test suite + build validation
