# Story 29-4: Migrate Query Modules to DatabaseAdapter

Status: pending

## Story

As a substrate developer,
I want all persistence query functions to use the `DatabaseAdapter` interface instead of raw `BetterSqlite3Database`,
so that queries work against both Dolt and the in-memory fallback.

## Acceptance Criteria

### AC1: All query functions accept DatabaseAdapter
**Given** the 5 query modules in `src/persistence/queries/`
**When** a developer inspects their function signatures
**Then** every function accepts `DatabaseAdapter` as its first parameter instead of `BetterSqlite3Database`

### AC2: All functions are async
**Given** the 33 query functions across all modules
**When** called by consumers
**Then** they return `Promise<T>` and use `await adapter.query()` / `adapter.exec()` internally

### AC3: Existing tests pass with SqliteDatabaseAdapter
**Given** the query module test files
**When** `npm run test:fast` runs
**Then** all tests pass — they construct a `SqliteDatabaseAdapter` wrapping an in-memory SQLite database

### AC4: Transaction operations use adapter.transaction()
**Given** query functions that currently use `db.transaction(fn)()`
**When** migrated to `DatabaseAdapter`
**Then** they use `adapter.transaction(async (tx) => { ... })` for atomic operations

### AC5: Prepared statement caching replaced
**Given** `cost.ts` and `metrics.ts` which cache prepared statements in WeakMaps
**When** migrated to `DatabaseAdapter`
**Then** caching is removed — adapter handles statement lifecycle internally

### AC6: Build and tests pass
**Given** all query module changes
**When** `npm run build` and `npm run test:fast` run
**Then** both exit 0 with all tests passing

## Tasks / Subtasks

- [ ] Task 1: Migrate `decisions.ts` (AC: #1, #2, #4)
  - [ ] Convert all 15 functions to async, accepting `DatabaseAdapter`
  - [ ] Replace `db.prepare(sql).all()` with `await adapter.query(sql, params)`
  - [ ] Replace `db.prepare(sql).run()` with `await adapter.exec(sql)` or `await adapter.query(sql, params)`
  - [ ] Update transaction usage in `createPipelineRun`, `upsertDecision`

- [ ] Task 2: Migrate `cost.ts` (AC: #1, #2, #5)
  - [ ] Convert all 6 functions to async
  - [ ] Remove WeakMap prepared statement cache
  - [ ] Replace direct `.prepare().run()` with adapter calls

- [ ] Task 3: Migrate `amendments.ts` (AC: #1, #2, #4)
  - [ ] Convert all 6 functions to async
  - [ ] Update transaction usage in `createAmendmentRun`

- [ ] Task 4: Migrate `metrics.ts` (AC: #1, #2, #5)
  - [ ] Convert all 5 functions to async
  - [ ] Remove WeakMap prepared statement cache
  - [ ] Replace `.prepare().all()` with adapter calls

- [ ] Task 5: Migrate `retry-escalated.ts` (AC: #1, #2)
  - [ ] Convert 1 function to async

- [ ] Task 6: Update all query module tests (AC: #3)
  - [ ] Each test file creates `SqliteDatabaseAdapter(db)` instead of passing raw `db`
  - [ ] Add `await` to all query function calls in tests

- [ ] Task 7: Build + test validation (AC: #6)
  - [ ] `npm run build` exits 0
  - [ ] `npm run test:fast` all passing

## Dev Notes

### Architecture Constraints

- **SQL dialect portability**: All queries must work on both SQLite (via SqliteDatabaseAdapter) and MySQL (via DoltDatabaseAdapter). Avoid SQLite-specific functions. Use parameterized queries (`?` placeholders) throughout.
- **Parameter binding**: SQLite uses `?` positional params. MySQL also supports `?`. Stick with positional `?` everywhere.
- **Return types**: `adapter.query<T>()` returns `T[]`. Map existing `.get()` calls (single row) to `query()[0]`.
- **Import style**: All imports use `.js` extensions (ESM).

### Testing Requirements

- Every query module test file updated to use `SqliteDatabaseAdapter`
- Tests remain against real SQLite in-memory database — this story does NOT change the test database engine, only the adapter layer
- Full test suite must pass to ensure no behavioral regressions
