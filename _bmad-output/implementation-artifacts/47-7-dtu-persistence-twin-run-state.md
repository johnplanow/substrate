# Story 47-7: DTU Persistence — Twin Run State

## Story

As a factory operator,
I want twin lifecycle events (start, stop, health failures) persisted to the database,
so that I can observe twin activity alongside factory runs via `substrate metrics --run <id>`.

## Acceptance Criteria

### AC1: twin_runs Table Defined in Factory Schema
**Given** `factorySchema(adapter)` is called on a fresh DatabaseAdapter
**When** the function completes
**Then** a `twin_runs` table exists with columns: `id` (VARCHAR PK), `run_id` (VARCHAR nullable), `twin_name` (TEXT NOT NULL), `started_at` (DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP), `stopped_at` (DATETIME nullable), `status` (VARCHAR NOT NULL DEFAULT 'running'), and `ports_json` (TEXT nullable); and the call is idempotent (safe to call multiple times)

### AC2: twin_health_failures Table Defined in Factory Schema
**Given** `factorySchema(adapter)` is called
**When** the function completes
**Then** a `twin_health_failures` table exists with columns: `id` (INTEGER AUTOINCREMENT PK), `twin_name` (TEXT NOT NULL), `run_id` (VARCHAR nullable), `checked_at` (DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP), and `error_message` (TEXT NOT NULL); and an index `idx_twin_health_failures_twin` on `twin_name` is created idempotently

### AC3: insertTwinRun Persists a Twin Start Record
**Given** a `TwinRunInput` with `twin_name`, `ports`, and optional `run_id`
**When** `insertTwinRun(adapter, input)` is called
**Then** a row is inserted into `twin_runs` with `status='running'`, `started_at` defaulting to current timestamp, `ports_json` containing a JSON-serialized `PortMapping[]`, and the function returns the row's `id`

### AC4: updateTwinRun Records Twin Stop
**Given** an existing `twin_runs` row with a known `id`
**When** `updateTwinRun(adapter, id, { status: 'stopped', stopped_at })` is called
**Then** the row's `stopped_at` and `status` fields are updated to the supplied values

### AC5: recordTwinHealthFailure Persists Health Check Errors
**Given** a twin health check has failed with an error message
**When** `recordTwinHealthFailure(adapter, { twin_name, run_id, error_message })` is called
**Then** a row is inserted into `twin_health_failures` with `checked_at` set to the current timestamp and the supplied `error_message`

### AC6: getTwinRunsForRun Returns Lifecycle Summary
**Given** a `run_id` that had twin activity (start, stop, health failures)
**When** `getTwinRunsForRun(adapter, run_id)` is called
**Then** it returns an array of `TwinRunSummary` objects each containing `twin_name`, `started_at`, `stopped_at`, `status`, parsed `ports` (`PortMapping[]`), and `health_failure_count` (integer count of matching `twin_health_failures` rows)

### AC7: TwinPersistenceCoordinator Wires Events to Database
**Given** a `TwinPersistenceCoordinator` constructed with a `DatabaseAdapter` and factory event bus
**When** `twin:started` is emitted on the bus
**Then** `insertTwinRun` is called and the returned id is stored internally; and when `twin:stopped` is subsequently emitted for the same twin, `updateTwinRun` is called with `status='stopped'` and current timestamp

## Tasks / Subtasks

- [ ] Task 1: Extend factory-schema.ts with twin_runs and twin_health_failures tables (AC: #1, #2)
  - [ ] Append `CREATE TABLE IF NOT EXISTS twin_runs (...)` DDL after the existing `scenario_results` block
  - [ ] Append `CREATE TABLE IF NOT EXISTS twin_health_failures (...)` DDL with `CREATE INDEX IF NOT EXISTS` statement
  - [ ] Verify idempotency by confirming all DDL uses `IF NOT EXISTS` — no schema migration needed

- [ ] Task 2: Create packages/factory/src/twins/persistence.ts with types and query functions (AC: #3, #4, #5, #6)
  - [ ] Define `TwinRunInput` interface: `{ id?: string; run_id?: string; twin_name: string; ports: PortMapping[]; started_at?: string }`
  - [ ] Define `TwinRunRow` interface mirroring DB columns: `{ id: string; run_id: string | null; twin_name: string; started_at: string; stopped_at: string | null; status: string; ports_json: string | null }`
  - [ ] Define `TwinHealthFailureInput` interface: `{ twin_name: string; run_id?: string; error_message: string; checked_at?: string }`
  - [ ] Define `TwinRunSummary` interface: all `TwinRunRow` fields plus `ports: PortMapping[]` (parsed) and `health_failure_count: number`
  - [ ] Implement `insertTwinRun(adapter, input): Promise<string>` — use `crypto.randomUUID()` for id, `JSON.stringify(input.ports)` for ports_json, portable `INSERT INTO twin_runs (id, run_id, twin_name, started_at, status, ports_json) VALUES (?, ?, ?, ?, 'running', ?)` with positional params
  - [ ] Implement `updateTwinRun(adapter, id, patch: { status: string; stopped_at: string }): Promise<void>` — `UPDATE twin_runs SET status = ?, stopped_at = ? WHERE id = ?`
  - [ ] Implement `recordTwinHealthFailure(adapter, input): Promise<void>` — inserts into `twin_health_failures` with checked_at defaulting to `new Date().toISOString()`
  - [ ] Implement `getTwinRunsForRun(adapter, runId): Promise<TwinRunSummary[]>` — use two portable queries: (1) `SELECT * FROM twin_runs WHERE run_id = ?`, (2) `SELECT twin_name, COUNT(*) as cnt FROM twin_health_failures WHERE run_id = ? GROUP BY twin_name`; merge results client-side

- [ ] Task 3: Create TwinPersistenceCoordinator class in persistence.ts (AC: #7)
  - [ ] Define `TwinPersistenceCoordinator` class with constructor `(adapter: DatabaseAdapter, eventBus: TypedEventBus<FactoryEvents>)`
  - [ ] In constructor, subscribe to `twin:started`: call `insertTwinRun`, store `{ [twinName]: rowId }` in a private `Map<string, string>`
  - [ ] In constructor, subscribe to `twin:stopped`: look up stored id by `twinName`, call `updateTwinRun` with `status='stopped'` and `stopped_at=new Date().toISOString()`
  - [ ] Export `createTwinPersistenceCoordinator(adapter, eventBus): TwinPersistenceCoordinator` factory function

- [ ] Task 4: Export twin persistence from twins/index.ts barrel (AC: #3–#7)
  - [ ] Add named exports for `TwinRunInput`, `TwinRunRow`, `TwinRunSummary`, `TwinHealthFailureInput` from `./persistence.js`
  - [ ] Add named exports for `insertTwinRun`, `updateTwinRun`, `recordTwinHealthFailure`, `getTwinRunsForRun`, `TwinPersistenceCoordinator`, `createTwinPersistenceCoordinator` from `./persistence.js`

- [ ] Task 5: Extend metrics --run CLI output to display twin lifecycle info (AC: #7)
  - [ ] In the `metrics --run <id>` handler inside `factory-command.ts`, after existing run summary output, call `getTwinRunsForRun(adapter, runId)`
  - [ ] If the returned array is non-empty, print a `\nTwins:` section: for each twin, display `twin_name`, ports formatted as `host:container`, `started_at`, `stopped_at` (or `running`), `status`, and `health_failure_count`
  - [ ] If no twins are found for the run, skip the section silently (no output)

- [ ] Task 6: Write unit tests in packages/factory/src/twins/__tests__/persistence.test.ts (AC: #1–#7)
  - [ ] Test factorySchema creates twin_runs table (verify INSERT succeeds after schema init) — AC1
  - [ ] Test factorySchema creates twin_health_failures table with index (verify INSERT succeeds) — AC2
  - [ ] Test factorySchema is idempotent (call twice, no error) — AC1, AC2
  - [ ] Test insertTwinRun inserts row and returns a valid UUID-format id — AC3
  - [ ] Test insertTwinRun serializes ports correctly and row is readable — AC3
  - [ ] Test updateTwinRun sets stopped_at and status on existing row — AC4
  - [ ] Test recordTwinHealthFailure inserts row with checked_at — AC5
  - [ ] Test getTwinRunsForRun returns empty array when run_id has no twins — AC6
  - [ ] Test getTwinRunsForRun returns summary with correct health_failure_count — AC6
  - [ ] Test getTwinRunsForRun parses ports_json back to PortMapping[] — AC6
  - [ ] Test TwinPersistenceCoordinator: twin:started triggers insertTwinRun — AC7
  - [ ] Test TwinPersistenceCoordinator: twin:stopped triggers updateTwinRun — AC7
  - [ ] All tests use `MemoryDatabaseAdapter` from `@substrate-ai/core` — no real Dolt or SQLite

- [ ] Task 7: Build validation and regression (all ACs)
  - [ ] `npm run build` from repo root — zero TypeScript errors
  - [ ] `npm run test:fast` — all tests pass, no regressions in existing factory/twins tests

## Dev Notes

### Architecture Constraints

- **File paths:**
  - New: `packages/factory/src/twins/persistence.ts`
  - Modify: `packages/factory/src/persistence/factory-schema.ts` (append 2 new table DDLs)
  - Modify: `packages/factory/src/twins/index.ts` (add persistence exports)
  - Modify: `packages/factory/src/factory-command.ts` (extend metrics --run output)
  - New test: `packages/factory/src/twins/__tests__/persistence.test.ts`

- **ESM imports**: All relative imports require `.js` extension (e.g., `import { ... } from './persistence.js'`). Imports from `@substrate-ai/core` and `@substrate-ai/factory` use bare specifiers.

- **TypeScript**: No `any` types. Explicit return types on all exported functions. Use `import { randomUUID } from 'crypto'` (Node built-in, no `crypto.` global) or `crypto.randomUUID()` — verify which is available in the package and follow existing patterns (see `factory-queries.ts`).

- **SQL portability**: Use portable SQL only — no `ON CONFLICT`, no `RETURNING`, no dialect-specific functions. Follow the two-query pattern used in `factory-queries.ts` (`getFactoryRunSummaries`) for aggregation: run separate SELECT queries and merge results in TypeScript. Positional `?` placeholders for all values.

- **Ports serialization**: `PortMapping[]` from `types.ts` must be serialized to JSON string for `ports_json` on write and `JSON.parse()`-d back on read. Handle null `ports_json` gracefully (return `[]`).

- **Event types**: `twin:started` payload is `{ runId?: string; twinName: string; ports: PortMapping[]; healthStatus: 'healthy' | 'unknown' }` and `twin:stopped` payload is `{ twinName: string }` — verify exact shape in `events.ts` before implementing coordinator subscriptions.

- **factory-schema.ts pattern**: Append new DDL calls after the existing `scenario_results` index. Each `await adapter.exec(...)` call is standalone — no batching. Maintain the existing comment style (`-- twin_runs (AC1) ---`).

- **DatabaseAdapter param style**: Check `factory-queries.ts` to confirm whether `adapter.exec()` takes `(sql, params)` or `(sql)` only. The `run()` or `query()` method may be needed for parameterized queries — verify the `DatabaseAdapter` interface in `@substrate-ai/core`.

### Testing Requirements

- **Framework**: Vitest — `import { describe, it, expect, beforeEach } from 'vitest'`
- **Adapter**: `MemoryDatabaseAdapter` from `@substrate-ai/core` — initialize before each test with `await factorySchema(adapter)` to set up all tables
- **Event bus**: Use the factory event bus type from `@substrate-ai/factory` (check existing tests in `factory-command.test.ts` for the correct import path)
- **Minimum**: 12 test cases in `persistence.test.ts`
- **No real Docker, no network calls, no filesystem writes** in any unit test

### DDL Reference (exact SQL to append to factory-schema.ts)

```sql
-- twin_runs (AC1)
CREATE TABLE IF NOT EXISTS twin_runs (
  id          VARCHAR(255) PRIMARY KEY,
  run_id      VARCHAR(255),
  twin_name   TEXT NOT NULL,
  started_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  stopped_at  DATETIME,
  status      VARCHAR(32) NOT NULL DEFAULT 'running',
  ports_json  TEXT
)

-- twin_health_failures (AC2)
CREATE TABLE IF NOT EXISTS twin_health_failures (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  twin_name     TEXT NOT NULL,
  run_id        VARCHAR(255),
  checked_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  error_message TEXT NOT NULL
)

CREATE INDEX IF NOT EXISTS idx_twin_health_failures_twin ON twin_health_failures(twin_name)
```

### getTwinRunsForRun Two-Query Pattern

```typescript
export async function getTwinRunsForRun(
  adapter: DatabaseAdapter,
  runId: string
): Promise<TwinRunSummary[]> {
  // Query 1: fetch twin run rows for this run
  const rows = await adapter.query<TwinRunRow>(
    'SELECT * FROM twin_runs WHERE run_id = ?',
    [runId]
  )

  // Query 2: fetch health failure counts per twin for this run
  const failureCounts = await adapter.query<{ twin_name: string; cnt: number }>(
    'SELECT twin_name, COUNT(*) as cnt FROM twin_health_failures WHERE run_id = ? GROUP BY twin_name',
    [runId]
  )
  const failureMap = new Map(failureCounts.map(r => [r.twin_name, r.cnt]))

  return rows.map(row => ({
    ...row,
    ports: row.ports_json ? (JSON.parse(row.ports_json) as PortMapping[]) : [],
    health_failure_count: failureMap.get(row.twin_name) ?? 0,
  }))
}
```

### Metrics CLI Extension Pattern

In `factory-command.ts`, locate the `metrics --run` handler and append after existing output:

```typescript
const twinRuns = await getTwinRunsForRun(adapter, runId)
if (twinRuns.length > 0) {
  console.log('\nTwins:')
  for (const twin of twinRuns) {
    const ports = twin.ports.map((p: PortMapping) => `${p.host}:${p.container}`).join(', ')
    const stoppedAt = twin.stopped_at ?? 'still running'
    console.log(
      `  ${twin.twin_name} [${twin.status}] ports: ${ports || 'none'} ` +
      `started: ${twin.started_at} stopped: ${stoppedAt} ` +
      `health failures: ${twin.health_failure_count}`
    )
  }
}
```

## Interface Contracts

- **Export**: `TwinRunInput`, `TwinRunRow`, `TwinRunSummary`, `TwinHealthFailureInput` @ `packages/factory/src/twins/persistence.ts`
- **Export**: `insertTwinRun`, `updateTwinRun`, `recordTwinHealthFailure`, `getTwinRunsForRun` @ `packages/factory/src/twins/persistence.ts`
- **Export**: `TwinPersistenceCoordinator`, `createTwinPersistenceCoordinator` @ `packages/factory/src/twins/persistence.ts`
- **Import**: `twin:started`, `twin:stopped` event payload types @ `packages/factory/src/events.ts` (from story 47-2)
- **Import**: `DatabaseAdapter` @ `@substrate-ai/core`
- **Import**: `PortMapping` @ `packages/factory/src/twins/types.ts` (from story 47-1)
- **Extends**: `factorySchema` @ `packages/factory/src/persistence/factory-schema.ts` (from story 44-6) — adds 2 tables to existing function
- **Consumed by**: story 47-6 — imports `recordTwinHealthFailure` to persist health monitoring failures during factory runs

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
