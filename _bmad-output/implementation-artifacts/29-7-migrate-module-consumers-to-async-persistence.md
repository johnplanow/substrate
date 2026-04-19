# Story 29-7: Migrate Module Consumers to Async Persistence

Status: pending

## Story

As a substrate developer,
I want all module code that uses `BetterSqlite3Database` to use `DatabaseAdapter` instead,
so that the entire codebase is async-persistence-ready and SQLite-free.

## Acceptance Criteria

### AC1: implementation-orchestrator migrated
**Given** the 5 files in `src/modules/implementation-orchestrator/`
**When** a developer inspects their imports and database usage
**Then** they accept `DatabaseAdapter`, use `await` for all query calls, and have zero `BetterSqlite3Database` references

### AC2: compiled-workflows migrated
**Given** the 8 files in `src/modules/compiled-workflows/`
**When** migrated
**Then** they accept `DatabaseAdapter` and use async query calls

### AC3: phase-orchestrator migrated
**Given** the 5 files in `src/modules/phase-orchestrator/`
**When** migrated
**Then** they accept `DatabaseAdapter` and use async query calls

### AC4: supervisor migrated
**Given** the 2 files in `src/modules/supervisor/`
**When** migrated
**Then** they accept `DatabaseAdapter` and use async query calls

### AC5: Remaining modules migrated
**Given** `context-compiler`, `debate-panel`, `cost-tracker`, `amendment-handlers`
**When** migrated
**Then** they accept `DatabaseAdapter` and use async query calls

### AC6: Formatters updated
**Given** `src/cli/formatters/retry-formatter.ts`
**When** migrated
**Then** it uses `DatabaseAdapter` type instead of `BetterSqlite3Database`

### AC7: Build and tests pass
**Given** all module changes
**When** `npm run build` and `npm run test:fast` run
**Then** both exit 0 with all tests passing

## Tasks / Subtasks

- [ ] Task 1: Migrate implementation-orchestrator (AC: #1)
  - [ ] Update all 5 files to accept `DatabaseAdapter`
  - [ ] Add `await` to all decision/metrics query calls
  - [ ] Update tests

- [ ] Task 2: Migrate compiled-workflows (AC: #2)
  - [ ] Update all 8 files to accept `DatabaseAdapter`
  - [ ] Add `await` to all decision query calls
  - [ ] Update tests

- [ ] Task 3: Migrate phase-orchestrator (AC: #3)
  - [ ] Update all 5 files to accept `DatabaseAdapter`
  - [ ] Add `await` to all query calls
  - [ ] Update tests

- [ ] Task 4: Migrate supervisor (AC: #4)
  - [ ] Update 2 files to accept `DatabaseAdapter`
  - [ ] Add `await` to metrics/decision query calls
  - [ ] Update tests

- [ ] Task 5: Migrate remaining modules (AC: #5)
  - [ ] `context-compiler-impl.ts` — replace `BetterSqlite3Database` type
  - [ ] `debate-panel-impl.ts` — replace type + add await
  - [ ] `cost-tracker-impl.ts` — replace type + add await
  - [ ] `amendment-handlers/index.ts` — replace type + add await
  - [ ] Update tests for each

- [ ] Task 6: Update formatters (AC: #6)
  - [ ] `retry-formatter.ts` — replace `BetterSqlite3Database` type with `DatabaseAdapter`

- [ ] Task 7: Build + test validation (AC: #7)
  - [ ] `npm run build` exits 0
  - [ ] `npm run test:fast` all passing

## Dev Notes

### Architecture Constraints

- **Mechanical migration**: This story is almost entirely mechanical — replace `db: BetterSqlite3Database` with `adapter: DatabaseAdapter` in function signatures, add `await` before query calls. The logic does not change.
- **Dependency injection**: Most modules receive `db` through constructor options or function parameters. Update the types in the options interfaces.
- **Test mocking**: Module tests that mock `db` should mock `DatabaseAdapter` instead. If tests create real SQLite databases, wrap them in `SqliteDatabaseAdapter`.
- **Import style**: All imports use `.js` extensions (ESM).
- **Parallelizable**: Tasks 1-6 are independent and can be worked on in any order.

### Testing Requirements

- Every module's test suite must pass after migration
- Tests should use either `SqliteDatabaseAdapter` (wrapping in-memory SQLite) or mock `DatabaseAdapter`
- No behavioral changes — this is a type/interface migration only
