# Story 38-1: Add SyncAdapter to InMemoryDatabaseAdapter

Status: ready

## Story

As a substrate developer,
I want `InMemoryDatabaseAdapter` to implement the `SyncAdapter` interface (`querySync`, `execSync`),
so that `MonitorDatabaseImpl` and tests can use InMemory instead of the WasmSqlite adapter backed by sql.js.

This is the foundational story for removing the sql.js dependency entirely (Epic 38).

## Acceptance Criteria

### AC1: SyncAdapter Implementation
**Given** the existing `InMemoryDatabaseAdapter` class
**When** I instantiate it
**Then** it implements both `DatabaseAdapter` and `SyncAdapter` interfaces, and `isSyncAdapter()` returns true

### AC2: querySync Executes Real SQL
**Given** an `InMemoryDatabaseAdapter` instance with tables and data
**When** I call `querySync<T>(sql, params)`
**Then** it returns typed rows identically to the async `query()` method (same internal SQL parser)

### AC3: execSync Executes DDL/DML
**Given** an `InMemoryDatabaseAdapter` instance
**When** I call `execSync(sql)` with CREATE TABLE / INSERT / UPDATE / DELETE statements
**Then** the schema and data are modified identically to the async `exec()` method

### AC4: MonitorDatabaseImpl Accepts InMemory
**Given** an `InMemoryDatabaseAdapter` instance
**When** I pass it to `new MonitorDatabaseImpl(adapter)`
**Then** it does not throw (the SyncAdapter check passes)

### AC5: Contract Tests Pass
**Given** the existing adapter contract test suite (`adapter.contract.test.ts`)
**When** I run the InMemory tests
**Then** all existing tests pass, plus new tests for querySync/execSync

### AC6: initSchema() Succeeds on InMemory
**Given** a fresh `InMemoryDatabaseAdapter` instance
**When** I call `initSchema(adapter)`
**Then** it completes without error — all CREATE TABLE, CREATE INDEX, and CREATE VIEW statements in `schema.ts` are handled (tables created, indexes/views silently ignored)

### AC7: GROUP BY Support for MonitorDatabase
**Given** `MonitorDatabaseImpl.rebuildAggregates()` uses `GROUP BY agent, task_type` with SUM, COUNT, CASE WHEN
**When** this query runs against InMemory
**Then** it returns correctly grouped and aggregated results. The InMemory SQL parser must support GROUP BY with basic aggregate functions (SUM, COUNT, COALESCE) and CASE WHEN expressions.

## Tasks / Subtasks

- [ ] Task 1: Add `SyncAdapter` to `InMemoryDatabaseAdapter` class declaration (AC: #1, #2, #3)
  - [ ] In `src/persistence/memory-adapter.ts`, change `implements DatabaseAdapter` to `implements DatabaseAdapter, SyncAdapter`
  - [ ] Import `SyncAdapter` from `./adapter.js`
  - [ ] Add `querySync<T>(sql, params)` — calls `this._execute(sql.trim(), params) as T[]`
  - [ ] Add `execSync(sql)` — calls `this._execute(sql.trim(), undefined)`
  - [ ] The internal `_execute()` method is already synchronous (the async wrappers just return Promises). This is trivial.

- [ ] Task 2: Add GROUP BY support to InMemory SQL parser (AC: #7)
  - [ ] In `_select()`, before the ORDER BY/LIMIT stripping, detect and extract `GROUP BY col1, col2` clause
  - [ ] When GROUP BY is present: group filtered rows by the specified columns, then evaluate aggregate expressions (SUM, COUNT, COALESCE) per group
  - [ ] Must handle `SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END)` pattern — used by `MonitorDatabaseImpl.rebuildAggregates()`
  - [ ] Add `CASE WHEN col = 'val' THEN expr ELSE expr END` support in `_evalAggregateExpr()`
  - [ ] This is the critical SQL gap — without it, MonitorDatabaseImpl will fail at runtime on InMemory

- [ ] Task 3: Update `MonitorDatabaseImpl` references (AC: #4)
  - [ ] In `src/persistence/monitor-database.ts`, update error messages to reference `InMemoryDatabaseAdapter` instead of `createWasmSqliteAdapter()`
  - [ ] Remove the comment at line 598-599 that says "InMemoryAdapter may not support complex aggregates" — it will now

- [ ] Task 4: Add contract tests for SyncAdapter on InMemory (AC: #2, #3, #5, #6, #7)
  - [ ] In `src/persistence/__tests__/adapter.contract.test.ts`, add a describe block for InMemory SyncAdapter
  - [ ] Test `isSyncAdapter()` returns true for InMemoryDatabaseAdapter
  - [ ] Test `querySync` returns same results as `query` for SELECT
  - [ ] Test `execSync` applies schema changes for CREATE TABLE
  - [ ] Test `initSchema(adapter)` completes without error on a fresh InMemoryDatabaseAdapter
  - [ ] Test GROUP BY with SUM/COUNT aggregation returns correct grouped results

- [ ] Task 5: Smoke-test one representative file from each downstream story group
  - [ ] Run one persistence test file (e.g., `decisions.test.ts`) after swapping to InMemory — verify it passes
  - [ ] Run one module test file (e.g., `cost-tracker.test.ts`) after swapping to InMemory — verify it passes
  - [ ] Run one CLI test file (e.g., `health-bugs.test.ts`) after swapping to InMemory — verify it passes
  - [ ] This validates the pattern works end-to-end before stories 38-2/3/4 fan out

## Dev Notes

### Architecture Constraints
- **File**: `src/persistence/memory-adapter.ts` — main implementation (add SyncAdapter + GROUP BY)
- **File**: `src/persistence/monitor-database.ts` — update error messages, remove "may not support" caveat
- **File**: `src/persistence/__tests__/adapter.contract.test.ts` — add SyncAdapter + GROUP BY tests
- **Import style**: `.js` extension on all local imports (ESM)
- **Test framework**: vitest (not jest)

### SQL Parser Gap Analysis (CRITICAL)
The InMemory parser currently handles: CREATE TABLE, DROP TABLE, INSERT [IGNORE] INTO, SELECT (with WHERE, LIKE, IS NULL, aggregates SUM/COUNT/COALESCE), UPDATE, DELETE.

**Missing features needed for MonitorDatabaseImpl:**
1. **GROUP BY** — `rebuildAggregates()` uses `GROUP BY agent, task_type`
2. **CASE WHEN** — `SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END)`
3. **CAST / NULLIF** — used in `ORDER BY` in one query (line 542). Since InMemory strips ORDER BY, these are harmless — no parser change needed.

**Features NOT needed (already handled):**
- CREATE INDEX → silently ignored (falls to unknown statement handler)
- CREATE VIEW → explicitly handled as no-op (line 87-90)
- INSERT IGNORE INTO → already supported (line 91-92)
- ORDER BY / LIMIT → stripped before parsing (line 194-196)
- CHECK constraints → ignored in CREATE TABLE (only table name extracted)
- AUTO_INCREMENT → ignored in CREATE TABLE (only table name extracted)
- BEGIN / COMMIT / ROLLBACK → silently ignored (line 104)

### File List
- `src/persistence/memory-adapter.ts` (modify — add SyncAdapter impl + GROUP BY + CASE WHEN)
- `src/persistence/adapter.ts` (no changes — SyncAdapter interface already defined)
- `src/persistence/monitor-database.ts` (modify — update error messages)
- `src/persistence/__tests__/adapter.contract.test.ts` (modify — add tests)
