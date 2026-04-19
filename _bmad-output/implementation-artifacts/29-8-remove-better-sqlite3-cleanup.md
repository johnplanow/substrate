# Story 29-8: Remove better-sqlite3 + Cleanup

Status: pending

## Story

As a substrate user installing the CLI,
I want `npm install` to complete without any native C++ compilation,
so that installation is fast, reliable, and works on all platforms without a C++ toolchain.

## Acceptance Criteria

### AC1: better-sqlite3 removed from package.json
**Given** `package.json`
**When** a developer inspects dependencies
**Then** neither `better-sqlite3` nor `@types/better-sqlite3` appear in dependencies or devDependencies

### AC2: SqliteDatabaseAdapter removed
**Given** `src/persistence/sqlite-adapter.ts`
**When** all consumers use `DoltDatabaseAdapter` or `InMemoryDatabaseAdapter`
**Then** the SqliteDatabaseAdapter file is deleted — it was a transitional bridge only

### AC3: DatabaseWrapper removed
**Given** `src/persistence/database.ts`
**When** all consumers use `createDatabaseAdapter()` factory
**Then** the `DatabaseWrapper` class and `DatabaseServiceImpl` are removed

### AC4: Migration files removed
**Given** `src/persistence/migrations/`
**When** Dolt manages its own schema via adapter initialization
**Then** the 11 SQLite migration files and migration runner are removed

### AC5: npm install has zero native compilation
**Given** a clean `npm install` on a machine without C++ toolchain
**When** installation completes
**Then** it exits 0 with no native addon compilation step

### AC6: All tests pass
**Given** the complete test suite
**When** `npm run test:fast` runs
**Then** all 6000+ tests pass using `DoltDatabaseAdapter` (when Dolt available) or `InMemoryDatabaseAdapter` (CI)

### AC7: CHANGELOG updated
**Given** `CHANGELOG.md`
**When** a user reads the latest entry
**Then** it documents the full SQLite removal: what changed, who is affected, and the `substrate migrate` remediation path

### AC8: Build passes
**Given** all removals and cleanup
**When** `npm run build` runs
**Then** exits 0 with zero type errors — no orphaned imports from deleted files

## Tasks / Subtasks

- [ ] Task 1: Remove SqliteDatabaseAdapter (AC: #2)
  - [ ] Delete `src/persistence/sqlite-adapter.ts`
  - [ ] Remove all imports of SqliteDatabaseAdapter from test files
  - [ ] Update tests to use InMemoryDatabaseAdapter or DoltDatabaseAdapter mocks

- [ ] Task 2: Remove DatabaseWrapper (AC: #3)
  - [ ] Delete or gut `src/persistence/database.ts` — remove DatabaseWrapper class and DatabaseServiceImpl
  - [ ] Keep file if it still exports types/interfaces used elsewhere, otherwise delete
  - [ ] Remove all `DatabaseWrapper` imports across codebase

- [ ] Task 3: Remove migration files (AC: #4)
  - [ ] Delete `src/persistence/migrations/001-initial-schema.ts` through `011-telemetry-schema.ts`
  - [ ] Delete `src/persistence/migrations/index.ts` (migration runner)
  - [ ] Ensure DoltDatabaseAdapter.init() applies equivalent schema via Dolt DDL
  - [ ] Ensure InMemoryDatabaseAdapter.init() sets up equivalent in-memory schema

- [ ] Task 4: Remove better-sqlite3 from package.json (AC: #1, #5)
  - [ ] Remove `"better-sqlite3"` from dependencies
  - [ ] Remove `"@types/better-sqlite3"` from devDependencies
  - [ ] Run `npm install` to regenerate lockfile
  - [ ] Verify no native compilation in install output

- [ ] Task 5: Search and clean orphaned imports (AC: #8)
  - [ ] Grep entire codebase for `better-sqlite3`, `BetterSqlite3Database`, `DatabaseWrapper`, `runMigrations`
  - [ ] Remove or replace any remaining references
  - [ ] `npm run build` exits 0

- [ ] Task 6: Update CHANGELOG (AC: #7)
  - [ ] Add entry under `## [Unreleased]` documenting full SQLite removal
  - [ ] Include: what changed, who is affected, remediation (`substrate migrate`)

- [ ] Task 7: Full test validation (AC: #6)
  - [ ] `npm run build` exits 0
  - [ ] `npm run test:fast` all passing
  - [ ] Verify test count hasn't dropped significantly (all existing tests should have equivalents)

## Dev Notes

### Architecture Constraints

- **Schema management in Dolt**: With SQLite migrations removed, Dolt schema must be applied by `DoltDatabaseAdapter.init()` or equivalent. The schema DDL from the 11 migrations should be consolidated into a single schema file that `DoltDatabaseAdapter` applies on first connection.
- **InMemoryDatabaseAdapter schema**: If using an in-memory SQL library (e.g., alasql), it needs the same consolidated schema. If using raw Maps, the "schema" is implicit in the data structures.
- **migrate.ts special case**: The `substrate migrate` command reads from old SQLite databases to migrate data to Dolt. This command may need to keep a lightweight SQLite reader (e.g., bundled as an optional dependency or using a pure-JS SQLite reader like `sql.js`) — OR it can be removed entirely if the migration window has passed. Discuss with team.
- **Test infrastructure**: Tests currently using `:memory:` SQLite databases need to switch to InMemoryDatabaseAdapter. This may require test helper updates.

### Testing Requirements

- Full test suite must pass — this is the final validation story
- Verify no test file imports from deleted modules
- Verify `npm install` on clean environment has no native compilation
- Package size comparison: before vs after
