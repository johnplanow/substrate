# Story 29-3: Create DatabaseAdapter Interface + Dual Implementations

Status: review

## Story

As a substrate developer migrating from SQLite to Dolt,
I want a unified async `DatabaseAdapter` interface that both engines implement,
so that the persistence layer can be migrated incrementally without breaking existing behavior.

## Acceptance Criteria

### AC1: DatabaseAdapter interface defined
**Given** a new file `src/persistence/adapter.ts`
**When** a developer reads the interface definition
**Then** it exports a `DatabaseAdapter` interface with async methods: `query<T>(sql: string, params?: unknown[]): Promise<T[]>`, `exec(sql: string): Promise<void>`, `transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>`, and `close(): Promise<void>`

### AC2: SqliteDatabaseAdapter wraps better-sqlite3
**Given** a `SqliteDatabaseAdapter` implementation in `src/persistence/sqlite-adapter.ts`
**When** it receives a `BetterSqlite3Database` instance
**Then** it wraps synchronous `.prepare().all()` and `.run()` calls in resolved promises, preserving all existing behavior

### AC3: DoltDatabaseAdapter wraps DoltClient
**Given** a `DoltDatabaseAdapter` implementation in `src/persistence/dolt-adapter.ts`
**When** Dolt is available on PATH and the repo is initialized
**Then** it delegates to `DoltClient.query()` for all SQL operations

### AC4: InMemoryDatabaseAdapter for CI/test
**Given** an `InMemoryDatabaseAdapter` implementation in `src/persistence/memory-adapter.ts`
**When** no external database is available (CI, unit tests)
**Then** it satisfies the interface using in-memory data structures (Maps, arrays), with no persistence

### AC5: Factory function with auto-detection
**Given** a `createDatabaseAdapter(config?)` factory function
**When** called with no arguments
**Then** it auto-detects Dolt availability (reusing detection logic from `src/modules/state/index.ts`), returning `DoltDatabaseAdapter` when available or `InMemoryDatabaseAdapter` as fallback

### AC6: Contract test suite
**Given** a test file `src/persistence/__tests__/adapter.contract.test.ts`
**When** the contract tests run
**Then** all three implementations (Sqlite, Dolt-mocked, InMemory) pass the same interface expectations for query, exec, transaction, and close

### AC7: No existing consumers changed
**Given** this story is additive only
**When** `npm run test:fast` runs
**Then** all existing tests pass — no query modules or CLI commands are modified in this story

## Tasks / Subtasks

- [x] Task 1: Define `DatabaseAdapter` interface (AC: #1)
  - [x] Create `src/persistence/adapter.ts` with interface + type exports
  - [x] Include `DatabaseAdapterConfig` type with `backend: 'sqlite' | 'dolt' | 'memory' | 'auto'`

- [x] Task 2: Implement `SqliteDatabaseAdapter` (AC: #2)
  - [x] Create `src/persistence/sqlite-adapter.ts`
  - [x] Wrap `db.prepare(sql).all(...params)` → `Promise.resolve(rows)`
  - [x] Wrap `db.exec(sql)` → `Promise.resolve()`
  - [x] Wrap `db.transaction(fn)()` → `Promise.resolve(fn())`

- [x] Task 3: Implement `DoltDatabaseAdapter` (AC: #3)
  - [x] Create `src/persistence/dolt-adapter.ts`
  - [x] Delegate to existing `DoltClient.query<T>()` from `src/modules/state/dolt-client.ts`
  - [x] Handle Dolt-specific SQL dialect differences if any (MySQL vs SQLite syntax)

- [x] Task 4: Implement `InMemoryDatabaseAdapter` (AC: #4)
  - [x] Create `src/persistence/memory-adapter.ts`
  - [x] In-memory table storage using Maps keyed by table name
  - [x] Basic SQL parsing for INSERT/SELECT/UPDATE/DELETE (or use a minimal SQL-in-memory lib)
  - [x] Transaction support via snapshot-and-restore pattern

- [x] Task 5: Create factory function (AC: #5)
  - [x] Add `createDatabaseAdapter()` to `src/persistence/adapter.ts`
  - [x] Reuse Dolt detection logic from `src/modules/state/index.ts`

- [x] Task 6: Write contract tests (AC: #6)
  - [x] Create `src/persistence/__tests__/adapter.contract.test.ts`
  - [x] Test all three adapters against: basic query, parameterized query, exec DDL, transaction commit, transaction rollback, close

- [x] Task 7: Build + test validation (AC: #7)
  - [x] `npm run build` exits 0
  - [x] `npm run test:fast` all passing

## Dev Notes

### Architecture Constraints

- **DoltClient reuse**: The `DoltDatabaseAdapter` should import and wrap the existing `DoltClient` from `src/modules/state/dolt-client.ts` — do NOT create a new Dolt connection layer.
- **SQL dialect**: Dolt uses MySQL syntax. Most queries in `src/persistence/queries/` use standard SQL that works on both SQLite and MySQL. Watch for: `INTEGER PRIMARY KEY AUTOINCREMENT` (SQLite) vs `INT AUTO_INCREMENT PRIMARY KEY` (MySQL), `datetime('now')` (SQLite) vs `NOW()` (MySQL), `INSERT OR REPLACE` (SQLite) vs `REPLACE INTO` or `INSERT ... ON DUPLICATE KEY UPDATE` (MySQL).
- **InMemoryDatabaseAdapter complexity**: This does NOT need to be a full SQL engine. It needs to support the specific query patterns used by `src/persistence/queries/` — primarily simple CRUD with WHERE clauses. Consider using `alasql` or a similar lightweight in-memory SQL library if hand-rolling a parser is too complex.
- **Import style**: All imports use `.js` extensions (ESM).
- **Test framework**: Vitest.

### Testing Requirements

- Contract test suite validates interface compliance for all three adapters
- SqliteDatabaseAdapter tested against real better-sqlite3 in-memory database (`:memory:`)
- DoltDatabaseAdapter tested with mocked DoltClient
- InMemoryDatabaseAdapter tested directly
- No existing test files modified in this story
