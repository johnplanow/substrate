# Story 38-2: Migrate Persistence Tests from WasmSqlite to InMemory

Status: ready
Depends on: 38-1

## Story

As a substrate developer,
I want all persistence layer tests to use `InMemoryDatabaseAdapter` instead of `createWasmSqliteAdapter()`,
so that tests no longer depend on sql.js and the currently-failing test files pass again.

## Acceptance Criteria

### AC1: All Persistence Tests Use InMemory
**Given** the test files in `src/persistence/__tests__/` and `src/persistence/queries/__tests__/`
**When** I run them
**Then** none import from `wasm-sqlite-adapter.ts` — all use `InMemoryDatabaseAdapter`

### AC2: Monitor Database Tests Pass
**Given** `src/persistence/__tests__/monitor-database.test.ts`
**When** I run it with InMemory adapter
**Then** all tests pass (MonitorDatabaseImpl now accepts InMemory via SyncAdapter from 38-1)

### AC3: Decision Store Tests Pass
**Given** `src/persistence/__tests__/decisions.test.ts`
**When** I run it with InMemory adapter
**Then** all tests pass

### AC4: Cost and Metrics Tests Pass
**Given** `src/persistence/queries/__tests__/cost.test.ts` and `metrics.test.ts`
**When** I run them with InMemory adapter
**Then** all tests pass

### AC5: Amendment Tests Pass
**Given** `src/persistence/queries/__tests__/amendments.test.ts`
**When** I run it with InMemory adapter
**Then** all tests pass

### AC6: Zero WasmSqlite Imports Remain in Scope
**Given** a grep for `createWasmSqliteAdapter|wasm-sqlite-adapter` in `src/persistence/`
**When** I search (excluding `wasm-sqlite-adapter.ts` itself)
**Then** zero matches in test files

## Tasks / Subtasks

- [ ] Task 1: Migrate persistence/__tests__/ (AC: #1, #2, #3)
  - [ ] `adapter.contract.test.ts` — remove WasmSqlite describe block, keep InMemory and Dolt blocks
  - [ ] `monitor-database.test.ts` — replace `createWasmSqliteAdapter()` with `new InMemoryDatabaseAdapter()` + `await initSchema(adapter)`
  - [ ] `decisions.test.ts` — same replacement pattern
  - [ ] `performance-aggregates.test.ts` — same replacement pattern

- [ ] Task 2: Migrate persistence/queries/__tests__/ (AC: #4, #5)
  - [ ] `cost.test.ts` — replace adapter creation
  - [ ] `metrics.test.ts` — replace adapter creation
  - [ ] `amendments.test.ts` — replace adapter creation
  - [ ] `retry-escalated.test.ts` — replace adapter creation

- [ ] Task 3: Handle sync→async migration in tests
  - [ ] Where tests use `adapter.querySync()` or `adapter.execSync()`, keep them as-is — InMemory now supports SyncAdapter (from 38-1)
  - [ ] For tests that cast to `WasmSqliteDatabaseAdapter`, remove the cast — `InMemoryDatabaseAdapter` implements SyncAdapter directly, so `adapter.querySync()` / `adapter.execSync()` work without casting
  - [ ] Remove all `import { WasmSqliteDatabaseAdapter } from '../wasm-sqlite-adapter.js'` and `import { createWasmSqliteAdapter } from '../wasm-sqlite-adapter.js'`

- [ ] Task 4: Catch-all sweep (AC: #6)
  - [ ] After completing listed files, grep for any remaining `createWasmSqliteAdapter` or `wasm-sqlite-adapter` imports in `src/persistence/` (excluding `wasm-sqlite-adapter.ts` itself)
  - [ ] Migrate any files found that were not in the task list

## Dev Notes

### Pattern for Each Test File

Replace:
```typescript
import { createWasmSqliteAdapter } from '../wasm-sqlite-adapter.js'
// ...
const adapter = await createWasmSqliteAdapter()
```

With:
```typescript
import { InMemoryDatabaseAdapter } from '../memory-adapter.js'
import { initSchema } from '../schema.js'
// ...
const adapter = new InMemoryDatabaseAdapter()
await initSchema(adapter)
```

For files that cast to WasmSqliteDatabaseAdapter for sync access:
```typescript
// Before:
import { createWasmSqliteAdapter } from '../wasm-sqlite-adapter.js'
import type { WasmSqliteDatabaseAdapter } from '../wasm-sqlite-adapter.js'
const adapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
adapter.execSync('INSERT INTO ...')

// After:
import { InMemoryDatabaseAdapter } from '../memory-adapter.js'
import { initSchema } from '../schema.js'
const adapter = new InMemoryDatabaseAdapter()
await initSchema(adapter)
adapter.execSync('INSERT INTO ...')  // Works — InMemory implements SyncAdapter
```

### File List (8 files)
- `src/persistence/__tests__/adapter.contract.test.ts`
- `src/persistence/__tests__/monitor-database.test.ts`
- `src/persistence/__tests__/decisions.test.ts`
- `src/persistence/__tests__/performance-aggregates.test.ts`
- `src/persistence/queries/__tests__/cost.test.ts`
- `src/persistence/queries/__tests__/metrics.test.ts`
- `src/persistence/queries/__tests__/amendments.test.ts`
- `src/persistence/queries/__tests__/retry-escalated.test.ts`
