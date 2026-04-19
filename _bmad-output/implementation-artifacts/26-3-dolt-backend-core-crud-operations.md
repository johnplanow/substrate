# Story 26-3: Dolt Backend — Core CRUD Operations

Status: complete

## Story

As a pipeline orchestrator,
I want a `DoltStateStore` that implements the `StateStore` interface via SQL queries to a local Dolt repository,
so that all pipeline state is persisted in a version-controlled, SQL-queryable database with reliable CRUD semantics.

## Acceptance Criteria

### AC1: DoltStateStore Implements Full StateStore Interface
**Given** the `StateStore` interface defined in `src/modules/state/types.ts` (story 26-1)
**When** `DoltStateStore` is instantiated with a valid Dolt repo path
**Then** it satisfies the full `StateStore` interface: `getStoryState`, `setStoryState`, `queryStories`, `recordMetric`, `queryMetrics`, `getContracts`, `setContracts`, `branchForStory`, `mergeStory`, `rollbackStory`, `diffStory`, `initialize`, `close`

### AC2: mysql2 Via Unix Socket (Primary Path)
**Given** `dolt sql-server` is running on a local unix socket at `.substrate/state/.dolt/dolt.sock`
**When** any CRUD operation is called on `DoltStateStore`
**Then** the query executes via `mysql2` using the unix socket connection (no TCP port, no port conflicts)

### AC3: CLI Fallback When Server Not Running
**Given** `dolt sql-server` is NOT running (socket file absent or connection refused)
**When** any CRUD operation is called on `DoltStateStore`
**Then** the query falls back to executing `dolt sql -q "<sql>"` as a child process from the repo directory, and results are parsed from stdout

### AC4: Full CRUD Coverage Across All State Tables
**Given** an initialized Dolt repo with the schema from story 26-2
**When** each CRUD operation is exercised
**Then**:
- `setStoryState` / `getStoryState` insert or upsert rows in the `stories` table
- `queryStories(filter)` returns filtered rows with correct field mapping
- `recordMetric` inserts a row into the `metrics` table
- `queryMetrics(filter)` returns filtered metric rows supporting aggregation
- `setContracts` / `getContracts` upsert and select rows in the `contracts` table
- Delete operations (used by `rollbackStory`) remove rows tied to a story branch

### AC5: Shared Contract Test Suite Passes
**Given** the contract test suite in `src/modules/state/__tests__/state-store.contract.test.ts` (shared with `FileStateStore` from story 26-1)
**When** the suite is run with a `DoltStateStore` instance backed by a real Dolt binary
**Then** all contract tests pass, confirming behavioral equivalence between backends

### AC6: Batched Dolt Commits After Write Operations
**Given** a sequence of write calls (`setStoryState`, `recordMetric`, `setContracts`)
**When** the writes complete
**Then** a `dolt commit -Am "<message>"` is issued once per logical write batch (not per-row), and the commit message includes the story key and operation type

### AC7: Typed Error Classes for All Failure Modes
**Given** a `DoltStateStore` encountering error conditions
**When** Dolt is not initialized, a SQL query fails, or a merge conflict is detected
**Then** it throws the appropriate typed error:
- `DoltNotInitializedError` — repo path has no `.dolt/` directory
- `DoltQueryError` — SQL execution fails (includes original SQL and stderr)
- `DoltMergeConflictError` — merge detects conflicting rows (includes table name and conflicting keys)

## Interface Contracts

- **Import**: `StateStore`, `StoryState`, `StoryFilter`, `MetricRecord`, `MetricFilter`, `ContractRecord` @ `src/modules/state/types.ts` (from story 26-1)
- **Import**: SQL schema (via Dolt DDL already applied by story 26-2 `dolt-init.ts`)
- **Export**: `DoltStateStore` @ `src/modules/state/dolt-store.ts` (consumed by stories 26-4, 26-5, 26-6, 26-7)
- **Export**: `DoltClient` @ `src/modules/state/dolt-client.ts` (consumed by `DoltStateStore` and story 26-7 branch operations)
- **Export**: `DoltNotInitializedError`, `DoltQueryError`, `DoltMergeConflictError` @ `src/modules/state/errors.ts` (consumed by stories 26-4, 26-7)

## Tasks / Subtasks

- [ ] Task 1: Add `mysql2` dependency and create `dolt-client.ts` (AC2, AC3)
  - [ ] Add `mysql2` to `package.json` dependencies (`npm install mysql2`)
  - [ ] Create `src/modules/state/dolt-client.ts` exporting `DoltClient` class
  - [ ] Implement `connect()`: probe unix socket path; if present, create `mysql2` pool with `socketPath`; otherwise set `useCliMode = true`
  - [ ] Implement `query<T>(sql: string, params?: unknown[]): Promise<T[]>` — routes to mysql2 pool or CLI fallback
  - [ ] Implement CLI fallback: `execFile('dolt', ['sql', '-q', sql, '--result-format', 'json'])` in repo directory, parse JSON stdout
  - [ ] Implement `close()`: drain mysql2 pool if open
  - [ ] Unit tests for `DoltClient` using a mock child process and mock mysql2 pool

- [ ] Task 2: Create typed error classes in `src/modules/state/errors.ts` (AC7)
  - [ ] Define base `StateStoreError extends Error` with `code: string` field
  - [ ] Define `DoltNotInitializedError` (code: `DOLT_NOT_INITIALIZED`, includes repo path)
  - [ ] Define `DoltQueryError` (code: `DOLT_QUERY_ERROR`, includes `sql: string` and `detail: string`)
  - [ ] Define `DoltMergeConflictError` (code: `DOLT_MERGE_CONFLICT`, includes `table: string` and `conflictingKeys: string[]`)
  - [ ] Unit tests asserting error name, code, and message fields

- [ ] Task 3: Implement `DoltStateStore` shell + story-state CRUD (AC1, AC4)
  - [ ] Create `src/modules/state/dolt-store.ts` — `DoltStateStore implements StateStore`
  - [ ] Constructor accepts `{ repoPath: string; client: DoltClient }` (dependency injection)
  - [ ] `initialize()`: verify `.dolt/` directory exists at `repoPath`; throw `DoltNotInitializedError` if absent
  - [ ] `setStoryState(storyKey, state)`: UPSERT into `stories` table; queue for batch commit
  - [ ] `getStoryState(storyKey)`: SELECT from `stories` where `key = ?`; return `null` if not found
  - [ ] `queryStories(filter)`: build WHERE clause from filter fields; return mapped `StoryState[]`
  - [ ] Unit tests for story CRUD operations using a test Dolt repo (created in `beforeAll`)

- [ ] Task 4: Implement contracts and metrics CRUD (AC4)
  - [ ] `setContracts(storyKey, contracts)`: DELETE existing rows for storyKey then INSERT all; queue for batch commit
  - [ ] `getContracts(storyKey)`: SELECT from `contracts` where `story_key = ?`
  - [ ] `recordMetric(metric)`: INSERT into `metrics` table; queue for batch commit
  - [ ] `queryMetrics(filter)`: build WHERE clause from filter; support `groupBy` and `aggregations` if present in filter
  - [ ] Unit tests covering insert, select, filter, and aggregate paths

- [ ] Task 5: Implement batch commit mechanism (AC6)
  - [ ] Maintain a `_pendingWrites: number` counter; increment on every write call
  - [ ] After each write method, call private `_maybeCommit(storyKey, operation)` which decrements and—if batch is complete—executes `dolt commit -Am "state: <operation> for story <storyKey>"`
  - [ ] Alternatively, expose `flush(storyKey, message?)` for explicit commit control (called at end of dispatch cycle)
  - [ ] Commit runs via `execFile('dolt', ['commit', '-Am', message], { cwd: repoPath })`
  - [ ] Unit tests: assert commit is called once per batch, not once per row

- [ ] Task 6: Implement branch/merge/rollback/diff stub methods (AC1)
  - [ ] `branchForStory(storyKey)`: run `dolt checkout -b story/<storyKey>` via `execFile`
  - [ ] `mergeStory(storyKey)`: checkout main, run `dolt merge story/<storyKey>`, detect conflict markers in output, throw `DoltMergeConflictError` if present
  - [ ] `rollbackStory(storyKey)`: checkout main, run `dolt branch -D story/<storyKey>`
  - [ ] `diffStory(storyKey)`: run `dolt diff story/<storyKey>` and return raw output string (full structured diff is story 26-7)
  - [ ] Unit tests using mocked `execFile` to verify correct Dolt CLI commands are issued

- [ ] Task 7: Create shared StateStore contract test suite (AC5)
  - [ ] Create `src/modules/state/__tests__/state-store.contract.test.ts` with parameterized `describe.each([['file', createFileStore], ['dolt', createDoltStore]])` pattern
  - [ ] Contract tests cover: initialize, set/get story state, query stories with filter, record/query metrics, set/get contracts, rollback clears state
  - [ ] DoltStateStore fixture: use `beforeAll` to `dolt init` a temp directory, run schema DDL, `afterAll` to delete it
  - [ ] Skip DoltStateStore tests if `dolt` binary not found on PATH (with clear skip message)
  - [ ] Ensure contract tests also pass for FileStateStore backend (regression guard from story 26-1)

- [ ] Task 8: Update `src/modules/state/index.ts` exports (AC1)
  - [ ] Export `DoltStateStore` and `createDoltStateStore` factory from `dolt-store.ts`
  - [ ] Export `DoltClient` and `createDoltClient` factory from `dolt-client.ts`
  - [ ] Export all error classes from `errors.ts`
  - [ ] Update `createStateStore(config)` factory in `index.ts` to instantiate `DoltStateStore` when `config.backend === 'dolt'`
  - [ ] Verify full test suite passes: `npm run test:fast`

## Dev Notes

### Architecture Constraints
- **File paths**: `src/modules/state/dolt-store.ts`, `src/modules/state/dolt-client.ts`, `src/modules/state/errors.ts`
- **Import style**: ES modules with `.js` extensions on all local imports (e.g., `import { StateStore } from './types.js'`)
- **Node builtins**: use `node:` prefix (e.g., `import { execFile } from 'node:child_process'`)
- **Type imports**: use `import type { ... }` for type-only imports
- **DI pattern**: `DoltStateStore` constructor takes a single `deps` object; factory function `createDoltStateStore(deps)` is the public API
- **Logger**: `import { createLogger } from '../../utils/logger.js'`; namespace `'modules:state:dolt'`
- **No global state**: all Dolt CLI invocations must pass `cwd: repoPath` to `execFile` — never rely on process working directory
- **mysql2**: unix socket connection only; never TCP. Socket path convention: `<repoPath>/.dolt/dolt.sock`
- **`mysql2/promise`**: use the promise-based API (`import mysql from 'mysql2/promise'`)
- **Batch commits**: commit granularity is per-operation-boundary (e.g., per `setStoryState` call), not per-row. The `flush()` method commits explicitly.
- **Story 26-1 dependency**: `StateStore`, `StoryState`, `StoryFilter`, `MetricRecord`, `MetricFilter`, `ContractRecord` types must be imported from `./types.js`. If story 26-1 is not yet merged, create stub interfaces to unblock development.
- **Story 26-2 dependency**: Dolt schema DDL is already applied by `dolt-init.ts`; `DoltStateStore` does NOT run DDL — it only reads/writes to existing tables.

### Testing Requirements
- **Framework**: vitest (NOT jest). Run tests with `npm run test:fast`.
- **Coverage threshold**: 80% — do not drop below this.
- **Dolt binary**: required for contract tests. Guard with `try { execSync('dolt version') } catch { skip }`.
- **Temp directories**: use `os.tmpdir()` + unique suffix for test Dolt repos; clean up in `afterAll`.
- **Mock strategy for unit tests**: mock `execFile` at the module level using `vi.mock('node:child_process')` for branch/merge/rollback tests; use a real Dolt repo only for contract/integration tests.
- **Contract test file**: `src/modules/state/__tests__/state-store.contract.test.ts` — runs both File and Dolt backends to ensure behavioral equivalence.
- **Test isolation**: each `describe` block gets its own Dolt repo to prevent state bleed between test suites.

### Key Dolt CLI Commands Used
```bash
# Check initialization
ls <repoPath>/.dolt/

# SQL via CLI fallback
dolt sql -q "SELECT * FROM stories WHERE key = 'story-key'" --result-format json

# Commit
dolt commit -Am "state: setStoryState for story 1-1"

# Branch operations (story 26-7 will expand these)
dolt checkout -b story/1-1
dolt merge story/1-1
dolt branch -D story/1-1
dolt diff story/1-1
```

### mysql2 Unix Socket Connection
```typescript
import mysql from 'mysql2/promise'

const pool = await mysql.createPool({
  socketPath: `${repoPath}/.dolt/dolt.sock`,
  user: 'root',
  database: 'doltdb',
  waitForConnections: true,
  connectionLimit: 5,
})
```

### Error Detection Patterns
- `DoltNotInitializedError`: check for absence of `<repoPath>/.dolt/` directory before any query
- `DoltQueryError`: catch `execFile` non-zero exit or mysql2 `QueryError`; include `sql` and `stderr` in error
- `DoltMergeConflictError`: detect `CONFLICT` in `dolt merge` stdout; parse table name from conflict output lines like `CONFLICT (content): Merge conflict in stories`

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
