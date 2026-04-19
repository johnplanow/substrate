# Story 29-5: Migrate CLI Commands to Async Persistence

Status: pending

## Story

As a substrate developer,
I want all CLI commands to use `DatabaseAdapter` instead of raw `BetterSqlite3Database`,
so that the CLI works with both Dolt and in-memory persistence.

## Acceptance Criteria

### AC1: All 13 CLI commands use DatabaseAdapter
**Given** the CLI commands in `src/cli/commands/`
**When** a developer inspects their database initialization
**Then** they use `createDatabaseAdapter()` instead of `DatabaseWrapper` and pass `DatabaseAdapter` to query functions

### AC2: run.ts ~20 callsites converted
**Given** `src/cli/commands/run.ts` with ~20 `db`-passing callsites
**When** migrated
**Then** all callsites use `await` with `DatabaseAdapter`, pipeline execution flow preserved

### AC3: DatabaseWrapper usage replaced
**Given** CLI commands that currently create `new DatabaseWrapper(dbPath)`
**When** migrated
**Then** they use `createDatabaseAdapter({ basePath: dbPath })` factory

### AC4: All CLI command tests pass
**Given** the CLI command test files in `src/cli/commands/__tests__/`
**When** `npm run test:fast` runs
**Then** all tests pass with `DatabaseAdapter` mocks or `SqliteDatabaseAdapter` wrappers

### AC5: Build passes
**Given** all CLI command changes
**When** `npm run build` runs
**Then** exits 0 with zero type errors

## Tasks / Subtasks

- [ ] Task 1: Migrate `run.ts` (AC: #1, #2, #3) — largest file, ~20 callsites
  - [ ] Replace `DatabaseWrapper` with `createDatabaseAdapter()`
  - [ ] Add `await` to all query function calls
  - [ ] Update `TelemetryPersistence` and `createContextCompiler` to receive adapter
  - [ ] Update phase orchestrator and implementation orchestrator dependency injection

- [ ] Task 2: Migrate `amend.ts`, `resume.ts`, `retry-escalated.ts` (AC: #1, #3)
  - [ ] Replace `DatabaseWrapper` + `runMigrations` with adapter factory

- [ ] Task 3: Migrate `cost.ts`, `metrics.ts`, `export.ts` (AC: #1, #3)
  - [ ] Replace `DatabaseWrapper` with adapter factory
  - [ ] Add `await` to query calls

- [ ] Task 4: Migrate `health.ts`, `status.ts` (AC: #1, #3)
  - [ ] Replace `DatabaseWrapper` with adapter factory

- [ ] Task 5: Migrate `supervisor.ts`, `monitor.ts` (AC: #1, #3)
  - [ ] Replace `DatabaseWrapper` with adapter factory
  - [ ] Update monitor database usage

- [ ] Task 6: Migrate `init.ts`, `migrate.ts` (AC: #1, #3)
  - [ ] Replace `DatabaseWrapper` with adapter factory
  - [ ] `migrate.ts` may need special handling for SQLite→Dolt migration path

- [ ] Task 7: Update CLI command tests (AC: #4)
  - [ ] Update mocks to use `DatabaseAdapter` interface
  - [ ] Add `await` to all test assertions against query functions

- [ ] Task 8: Build + test validation (AC: #5)
  - [ ] `npm run build` exits 0
  - [ ] `npm run test:fast` all passing

## Dev Notes

### Architecture Constraints

- **run.ts is the critical path**: It has the most callsites and the most complex flow. Migrate it first and thoroughly test before touching other commands.
- **Migration command**: `migrate.ts` currently uses raw `better-sqlite3` for SQLite→Dolt data migration. This command may need to retain direct SQLite access for reading the source database, even after the rest of the CLI migrates. Alternatively, it can use `SqliteDatabaseAdapter` for reading the old DB — but this is a one-time migration tool, not a production code path.
- **Import style**: All imports use `.js` extensions (ESM).

### Testing Requirements

- All CLI command test files updated
- `run.ts` tests are the most important — verify pipeline execution flow is preserved
- Existing E2E behavior unchanged
