# Story 44-6: Factory Schema — scenario_results and graph_runs Tables

## Story

As a factory pipeline runtime,
I want dedicated database tables for graph execution runs, per-node results, and scenario validation outcomes,
so that factory pipeline metrics can be persisted, queried, and reported independently from the core SDLC tables.

## Acceptance Criteria

### AC1: graph_runs Table Exists with Correct Schema
**Given** `factorySchema(adapter)` is called on a `DatabaseAdapter`
**When** the function completes successfully
**Then** the `graph_runs` table exists with all required columns: `id` (VARCHAR PRIMARY KEY), `graph_file`, `graph_goal`, `status`, `started_at`, `completed_at`, `total_cost_usd`, `node_count`, `final_outcome`, and `checkpoint_path`

### AC2: graph_node_results Table Exists with Correct Schema
**Given** `factorySchema(adapter)` completes
**When** the `graph_node_results` table is inspected
**Then** it has columns: `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `run_id`, `node_id`, `attempt`, `status`, `started_at`, `completed_at`, `duration_ms`, `cost_usd`, `failure_reason`, and `context_snapshot`

### AC3: scenario_results Table Exists with Correct Schema
**Given** `factorySchema(adapter)` completes
**When** the `scenario_results` table is inspected
**Then** it has columns: `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `run_id`, `node_id`, `iteration`, `total_scenarios`, `passed`, `failed`, `satisfaction_score`, `threshold`, `passes`, `details`, and `executed_at` — matching architecture Section 9.1 exactly

### AC4: Required Indexes Are Created
**Given** `factorySchema(adapter)` completes
**When** the database indexes are inspected
**Then** both `idx_scenario_results_run` (on `scenario_results(run_id)`) and `idx_graph_node_results_run` (on `graph_node_results(run_id)`) exist

### AC5: factorySchema Is Idempotent
**Given** `factorySchema(adapter)` has already been called once
**When** it is called a second time on the same adapter
**Then** no error is thrown — all DDL uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`

### AC6: factorySchema Is Exported and Callable
**Given** a consumer that imports from `packages/factory/src/persistence/factory-schema.ts`
**When** they call `await factorySchema(adapter)`
**Then** it accepts any `DatabaseAdapter` (including the in-memory adapter from `@substrate-ai/core`) and resolves without error

### AC7: Unit Tests Cover All Three Tables and Both Indexes
**Given** `packages/factory/src/persistence/__tests__/factory-schema.test.ts` is run
**When** all tests execute
**Then** at least 7 tests pass — one per AC above, verifying table existence, column presence, index existence, and idempotency — using the `MemoryDatabaseAdapter` (or equivalent in-memory adapter from `@substrate-ai/core`)

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/persistence/` directory and the schema file (AC: #1, #2, #3, #4, #5, #6)
  - [ ] Create directory `packages/factory/src/persistence/`
  - [ ] Create `packages/factory/src/persistence/factory-schema.ts`
  - [ ] Add file-level JSDoc comment: "Factory schema DDL for graph execution and scenario validation tables. Companion to `@substrate-ai/core`'s `initSchema` — call both during factory initialization."
  - [ ] Add import: `import type { DatabaseAdapter } from '@substrate-ai/core'`
  - [ ] Declare and export the function: `export async function factorySchema(adapter: DatabaseAdapter): Promise<void>`

- [ ] Task 2: Implement `graph_runs` table DDL (AC: #1, #5)
  - [ ] In `factorySchema`, add `await adapter.exec(...)` for `graph_runs`:
    ```sql
    CREATE TABLE IF NOT EXISTS graph_runs (
      id              VARCHAR(255) PRIMARY KEY,
      graph_file      TEXT NOT NULL,
      graph_goal      TEXT,
      status          VARCHAR(32) NOT NULL DEFAULT 'running',
      started_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at    DATETIME,
      total_cost_usd  DOUBLE NOT NULL DEFAULT 0.0,
      node_count      INTEGER NOT NULL DEFAULT 0,
      final_outcome   VARCHAR(32),
      checkpoint_path TEXT
    )
    ```
  - [ ] Use backtick-delimited template literal, consistent with the pattern in `packages/core/src/persistence/schema.ts`

- [ ] Task 3: Implement `graph_node_results` table DDL and its index (AC: #2, #4, #5)
  - [ ] Add `await adapter.exec(...)` for `graph_node_results`:
    ```sql
    CREATE TABLE IF NOT EXISTS graph_node_results (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id           VARCHAR(255) NOT NULL REFERENCES graph_runs(id),
      node_id          VARCHAR(255) NOT NULL,
      attempt          INTEGER NOT NULL DEFAULT 1,
      status           VARCHAR(32) NOT NULL,
      started_at       DATETIME NOT NULL,
      completed_at     DATETIME,
      duration_ms      INTEGER,
      cost_usd         DOUBLE NOT NULL DEFAULT 0.0,
      failure_reason   TEXT,
      context_snapshot TEXT
    )
    ```
  - [ ] Add `await adapter.exec('CREATE INDEX IF NOT EXISTS idx_graph_node_results_run ON graph_node_results(run_id)')`

- [ ] Task 4: Implement `scenario_results` table DDL and its index (AC: #3, #4, #5)
  - [ ] Add `await adapter.exec(...)` for `scenario_results`:
    ```sql
    CREATE TABLE IF NOT EXISTS scenario_results (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id             VARCHAR(255) NOT NULL REFERENCES graph_runs(id),
      node_id            VARCHAR(255) NOT NULL,
      iteration          INTEGER NOT NULL DEFAULT 1,
      total_scenarios    INTEGER NOT NULL,
      passed             INTEGER NOT NULL,
      failed             INTEGER NOT NULL,
      satisfaction_score DOUBLE NOT NULL,
      threshold          DOUBLE NOT NULL DEFAULT 0.8,
      passes             BOOLEAN NOT NULL,
      details            TEXT,
      executed_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    ```
  - [ ] Add `await adapter.exec('CREATE INDEX IF NOT EXISTS idx_scenario_results_run ON scenario_results(run_id)')`

- [ ] Task 5: Create test file for the schema (AC: #7)
  - [ ] Create directory `packages/factory/src/persistence/__tests__/`
  - [ ] Create `packages/factory/src/persistence/__tests__/factory-schema.test.ts`
  - [ ] Import `{ describe, it, expect, beforeEach }` from `'vitest'`
  - [ ] Import the `MemoryDatabaseAdapter` (or `createDatabaseAdapter({ backend: 'memory' })`) from `'@substrate-ai/core'`
  - [ ] Import `{ factorySchema }` from `'../factory-schema.js'`
  - [ ] Write a `beforeEach` that creates a fresh adapter and calls `await factorySchema(adapter)`
  - [ ] Test AC1: after schema init, `await adapter.query('SELECT * FROM graph_runs LIMIT 0')` resolves without error (table exists)
  - [ ] Test AC2: after schema init, `await adapter.query('SELECT * FROM graph_node_results LIMIT 0')` resolves without error
  - [ ] Test AC3: after schema init, `await adapter.query('SELECT * FROM scenario_results LIMIT 0')` resolves without error
  - [ ] Test AC4 (indexes): insert a `graph_runs` row, then insert `graph_node_results` and `scenario_results` rows referencing it; verify `query` by `run_id` works (confirms index was created without error)
  - [ ] Test AC5 (idempotency): call `await factorySchema(adapter)` a second time; assert no error thrown
  - [ ] Test that `graph_runs` accepts a full row insert with all documented columns (column names validation)
  - [ ] Test that `scenario_results` row with `satisfaction_score`, `threshold`, `passes`, `details` columns can be inserted
  - [ ] Minimum 7 tests, all passing

- [ ] Task 6: Build and validate (AC: #6)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all tests pass, no regressions
  - [ ] Confirm `factorySchema` is importable from the factory package path

## Dev Notes

### Architecture Constraints

- **New file:** `packages/factory/src/persistence/factory-schema.ts` — the only file this story creates
- **New test file:** `packages/factory/src/persistence/__tests__/factory-schema.test.ts`
- **No changes** to `packages/core/src/persistence/schema.ts` — factory tables are factory-only
- **No changes** to the factory `index.ts` export yet — the export wire-up will be done in story 44-9 (Factory Config + CLI) when `factorySchema` is called during factory initialization
- **Import pattern:** Use `import type { DatabaseAdapter } from '@substrate-ai/core'` — NOT from a relative path. The `@substrate-ai/core` package is a direct dependency of `@substrate-ai/factory` (see `packages/factory/package.json`)
- **ESM imports:** All imports within the factory package use `.js` extensions in import paths (e.g., `import { factorySchema } from '../factory-schema.js'`). This applies to test files too.
- **SQL dialect:** Match the DDL patterns from `packages/core/src/persistence/schema.ts` exactly — template literals for multi-line DDL, single-line strings for index creation

### Exact SQL DDL (from Architecture Section 9.1)

```sql
-- Graph execution runs
CREATE TABLE IF NOT EXISTS graph_runs (
  id              VARCHAR(255) PRIMARY KEY,
  graph_file      TEXT NOT NULL,
  graph_goal      TEXT,
  status          VARCHAR(32) NOT NULL DEFAULT 'running',
  started_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at    DATETIME,
  total_cost_usd  DOUBLE NOT NULL DEFAULT 0.0,
  node_count      INTEGER NOT NULL DEFAULT 0,
  final_outcome   VARCHAR(32),
  checkpoint_path TEXT
);

-- Per-node execution results
CREATE TABLE IF NOT EXISTS graph_node_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          VARCHAR(255) NOT NULL REFERENCES graph_runs(id),
  node_id         VARCHAR(255) NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 1,
  status          VARCHAR(32) NOT NULL,
  started_at      DATETIME NOT NULL,
  completed_at    DATETIME,
  duration_ms     INTEGER,
  cost_usd        DOUBLE NOT NULL DEFAULT 0.0,
  failure_reason  TEXT,
  context_snapshot TEXT
);

-- Scenario validation results
CREATE TABLE IF NOT EXISTS scenario_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          VARCHAR(255) NOT NULL REFERENCES graph_runs(id),
  node_id         VARCHAR(255) NOT NULL,
  iteration       INTEGER NOT NULL DEFAULT 1,
  total_scenarios INTEGER NOT NULL,
  passed          INTEGER NOT NULL,
  failed          INTEGER NOT NULL,
  satisfaction_score DOUBLE NOT NULL,
  threshold       DOUBLE NOT NULL DEFAULT 0.8,
  passes          BOOLEAN NOT NULL,
  details         TEXT,
  executed_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scenario_results_run ON scenario_results(run_id);
CREATE INDEX IF NOT EXISTS idx_graph_node_results_run ON graph_node_results(run_id);
```

### DatabaseAdapter Import Resolution

The `@substrate-ai/core` package exposes `DatabaseAdapter` from `packages/core/src/persistence/types.ts` (re-exported via `packages/core/src/persistence/index.ts`). Use a type-only import:

```typescript
import type { DatabaseAdapter } from '@substrate-ai/core'
```

For tests, use the in-memory adapter to avoid Dolt dependencies:

```typescript
import { createDatabaseAdapter } from '@substrate-ai/core'
const adapter = await createDatabaseAdapter({ backend: 'memory' })
```

Alternatively, if `createDatabaseAdapter` is not exported from the core public API at the time of implementation, import `MemoryDatabaseAdapter` directly from its path within `@substrate-ai/core` or check `packages/core/src/persistence/index.ts` for the exact export name.

### Pattern Reference

This story directly mirrors `initSchema` from `packages/core/src/persistence/schema.ts`:
- Same `adapter: DatabaseAdapter` parameter type
- Same `Promise<void>` return type
- Same `CREATE TABLE IF NOT EXISTS` idempotency pattern
- Same `CREATE INDEX IF NOT EXISTS` pattern for indexes
- Each DDL statement is a separate `await adapter.exec(...)` call (not batched)

The only structural difference: this function is named `factorySchema` (not `initSchema`) and lives in `packages/factory/src/persistence/factory-schema.ts`.

### Testing Requirements

- **Framework:** Vitest (`import { describe, it, expect, beforeEach } from 'vitest'`)
- **No Dolt:** Tests must use an in-memory adapter — never attempt to connect to Dolt in unit tests
- **Table existence check pattern:** `await adapter.query('SELECT * FROM <table> LIMIT 0')` — if the table exists, this resolves; if it doesn't, it throws. Wrap with `expect(...).resolves.not.toThrow()` or `await expect(adapter.query(...)).resolves.toBeDefined()`
- **Row insert pattern for column validation:**
  ```typescript
  await adapter.exec(`INSERT INTO graph_runs (id, graph_file, status, started_at, total_cost_usd, node_count)
    VALUES ('r1', 'pipeline.dot', 'running', CURRENT_TIMESTAMP, 0.0, 0)`)
  const rows = await adapter.query<{ id: string }>('SELECT id FROM graph_runs WHERE id = ?', ['r1'])
  expect(rows[0].id).toBe('r1')
  ```
- **Idempotency pattern:** Call `factorySchema(adapter)` twice in sequence; assert second call resolves (no throw)
- **Run tests:** `npm run test:fast` (unit-only, ~50s)
- **Never pipe output** through `head`/`tail`/`grep` — look for the `Test Files` summary line in the output
- **Confirm results** by checking for "Test Files" in output — exit code 0 alone is insufficient

### Dependency Notes

- **Depends on:** Story 41-3 (persistence layer migration) — `DatabaseAdapter` interface available in `@substrate-ai/core`
- **Unblocks:** Story 44-7 (File-Backed Run State Directory Structure) — uses `graph_runs.id` as the run identifier for file paths
- **Unblocks:** Story 44-9 (Factory Config + CLI) — calls `factorySchema(adapter)` during factory initialization
- **Unblocks:** Story 44-10 (Scenario Store Integration Test) — integration tests insert rows into these tables

## Interface Contracts

- **Export**: `factorySchema` @ `packages/factory/src/persistence/factory-schema.ts` (consumed by story 44-9 factory init)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-23: Story created for Epic 44, Phase B — Scenario Store + Runner
