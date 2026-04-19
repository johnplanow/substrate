# Story 41.3: Persistence Layer Migration

## Story

As a substrate-core package consumer,
I want `InMemoryDatabaseAdapter`, `DoltDatabaseAdapter`, `createDatabaseAdapter`, `initSchema`, and all query modules available from `packages/core/src/persistence/`,
so that SDLC and factory packages can import the full persistence layer from `@substrate-ai/core` without depending on the monolith's `src/persistence/` source.

## Acceptance Criteria

### AC1: Core persistence barrel exports all implementation symbols
**Given** `packages/core/src/persistence/` contains `adapter.ts`, `schema.ts`, `memory-adapter.ts`, `dolt-adapter.ts`, `queries/`, and `schemas/`
**When** code does `import { createDatabaseAdapter, initSchema, InMemoryDatabaseAdapter, DoltDatabaseAdapter } from '@substrate-ai/core'`
**Then** all exports resolve and TypeScript compiles without errors

### AC2: `createDatabaseAdapter({ backend: 'memory' })` returns a working adapter
**Given** `createDatabaseAdapter` is imported from `@substrate-ai/core`
**When** called with `{ backend: 'memory' }` and used to `exec()` a `CREATE TABLE` statement then `query()` it
**Then** the adapter performs operations without errors and returns expected results

### AC3: `initSchema(adapter)` creates all expected tables
**Given** `initSchema` is imported from `@substrate-ai/core` and called with an `InMemoryDatabaseAdapter`
**When** it completes
**Then** all tables (`sessions`, `tasks`, `task_dependencies`, `execution_log`, `cost_entries`, `pipeline_runs`, `decisions`, `requirements`, `constraints`, `artifacts`, `token_usage`, `plans`, `plan_versions`, `session_signals`, `run_metrics`, `story_metrics`, `task_metrics`, `performance_aggregates`, `routing_recommendations`, `turn_analysis`, `efficiency_scores`, `recommendations`, `category_stats`, `consumer_stats`) are present on the adapter

### AC4: Re-export shims keep all original import paths valid
**Given** `src/persistence/adapter.ts`, `src/persistence/schema.ts`, `src/persistence/dolt-adapter.ts`, `src/persistence/memory-adapter.ts`, `src/persistence/queries/*.ts`, and `src/persistence/schemas/*.ts` are converted to re-export shims pointing at `packages/core/`
**When** any existing monolith file imports from those original paths
**Then** the imports resolve correctly and TypeScript compiles without errors

### AC5: `DoltDatabaseAdapter` uses a duck-typed `DoltClientLike` interface
**Given** `packages/core/src/persistence/dolt-adapter.ts` defines a local `DoltClientLike` interface capturing only the methods it uses (`query<T>()`, `close()`)
**When** `DoltDatabaseAdapter` is compiled
**Then** it has zero imports from `src/modules/state/dolt-client.ts` and accepts any object satisfying `DoltClientLike`

### AC6: Factory uses dependency injection for the Dolt backend
**Given** `createDatabaseAdapter()` in `packages/core/src/persistence/adapter.ts` accepts an optional `doltClientFactory?: (repoPath: string) => DoltClientLike` parameter
**When** called with `backend: 'dolt'` or `backend: 'auto'` (with Dolt available)
**Then** it invokes `doltClientFactory(repoPath)` to construct the backend; the monolith's shim at `src/persistence/adapter.ts` supplies the concrete `DoltClient` constructor

### AC7: All existing persistence tests pass without modification
**Given** the migration is complete and shims are in place
**When** `npm run test:fast` is executed
**Then** all tests in `src/persistence/__tests__/` (adapter.contract.test.ts, decisions.test.ts, monitor-database.test.ts, performance-aggregates.test.ts) and `src/persistence/dolt-adapter.test.ts` continue to pass

## Tasks / Subtasks

- [x] Task 1: Migrate `InMemoryDatabaseAdapter` to core (AC: #1, #2, #4, #7)
  - [x] Copy `src/persistence/memory-adapter.ts` to `packages/core/src/persistence/memory-adapter.ts`
  - [x] Update imports in the copied file: change `import type { DatabaseAdapter, SyncAdapter } from './adapter.js'` to `import type { DatabaseAdapter, SyncAdapter } from './types.js'`
  - [x] Replace `src/persistence/memory-adapter.ts` with a re-export shim: `export { InMemoryDatabaseAdapter } from '../../packages/core/src/persistence/memory-adapter.js'`
  - [x] Run `npm run build` and verify zero TypeScript errors

- [x] Task 2: Migrate `DoltDatabaseAdapter` with `DoltClientLike` interface (AC: #1, #4, #5, #7)
  - [x] Create `packages/core/src/persistence/dolt-adapter.ts` with a local `DoltClientLike` interface: `{ query<T>(sql: string, params?: unknown[]): Promise<T[]>; close(): Promise<void> }`
  - [x] Copy `DoltDatabaseAdapter` class body from `src/persistence/dolt-adapter.ts`, replacing `DoltClient` with `DoltClientLike` throughout
  - [x] Update import of `DatabaseAdapter` to come from `./types.js` (not `./adapter.js`)
  - [x] Replace `src/persistence/dolt-adapter.ts` with a re-export shim pointing at the core file

- [x] Task 3: Migrate `initSchema` and `schema.ts` to core (AC: #1, #3, #4, #7)
  - [x] Copy `src/persistence/schema.ts` to `packages/core/src/persistence/schema.ts`
  - [x] Update import in the copied file: change `import type { DatabaseAdapter } from './adapter.js'` to `import type { DatabaseAdapter } from './types.js'`
  - [x] Replace `src/persistence/schema.ts` with a re-export shim: `export { initSchema } from '../../packages/core/src/persistence/schema.js'`

- [x] Task 4: Migrate factory `createDatabaseAdapter` with dependency injection (AC: #1, #2, #4, #6, #7)
  - [x] Create `packages/core/src/persistence/adapter.ts` containing the `createDatabaseAdapter()` factory and `isDoltAvailable()` helper; change the factory signature to `createDatabaseAdapter(config?: DatabaseAdapterConfig, doltClientFactory?: (repoPath: string) => DoltClientLike): DatabaseAdapter`
  - [x] Import `DoltDatabaseAdapter` from `./dolt-adapter.js`, `InMemoryDatabaseAdapter` from `./memory-adapter.js`; import logger from existing core utilities if available, otherwise inline a `console.debug` stub
  - [x] Replace `src/persistence/adapter.ts` with a re-export shim that: (a) re-exports interfaces and type guard from `@substrate-ai/core`, (b) re-exports `createDatabaseAdapter` from core but wraps it to inject `DoltClient` as the `doltClientFactory` argument, e.g.: `import { DoltClient } from '../modules/state/dolt-client.js'; export function createDatabaseAdapter(cfg?) { return coreCreate(cfg, (p) => new DoltClient({ repoPath: p })) }`

- [x] Task 5: Migrate Zod schema artifacts and query modules to core (AC: #1, #4, #7)
  - [x] Copy `src/persistence/schemas/decisions.ts` and `src/persistence/schemas/operational.ts` to `packages/core/src/persistence/schemas/`
  - [x] Copy all 5 files from `src/persistence/queries/` (`amendments.ts`, `cost.ts`, `decisions.ts`, `metrics.ts`, `retry-escalated.ts`) to `packages/core/src/persistence/queries/`
  - [x] Update imports in all copied query files: change `from '../adapter.js'` to `from '../types.js'` and `from '../schemas/X.js'` to `from '../schemas/X.js'` (paths remain the same relative to queries/)
  - [x] Replace each `src/persistence/queries/*.ts` and `src/persistence/schemas/*.ts` with re-export shims pointing at the core copies

- [x] Task 6: Update core persistence barrel and top-level index (AC: #1, #2, #7)
  - [x] Update `packages/core/src/persistence/index.ts` to export from all new files: `adapter.js`, `memory-adapter.js`, `dolt-adapter.js`, `schema.js`, `queries/amendments.js`, `queries/cost.js`, `queries/decisions.js`, `queries/metrics.js`, `queries/retry-escalated.js`, `schemas/decisions.js`, `schemas/operational.js`
  - [x] Update `packages/core/src/index.ts` to add `export * from './persistence/index.js'`
  - [x] Run `npm run build` inside `packages/core/` and from the root; fix any TypeScript compilation errors

- [x] Task 7: Run full test suite and verify zero regressions (AC: #2, #3, #7)
  - [x] Run `npm run test:fast` — confirm all persistence tests pass
  - [x] If any test fails due to an import path, trace the broken import chain and fix the corresponding shim
  - [x] Confirm `npm run build` from the root succeeds with zero errors

## Dev Notes

### Architecture Constraints
- All files under `packages/core/src/` MUST use ESM imports with `.js` extensions (e.g., `import ... from './types.js'`). The tsconfig uses `"module": "NodeNext"` with `"moduleResolution": "NodeNext"`.
- `packages/core/tsconfig.json` sets `rootDir: "src"` and `include: ["src/**/*.ts"]` — files in `packages/core/` **cannot** import from `src/` via relative paths crossing the project boundary. This is the key constraint driving the dependency injection pattern for `DoltClient`.
- The `types.ts` file in `packages/core/src/persistence/` already contains all interface definitions (from story 40-5). Migrated implementation files import from `./types.js`, NOT from `./adapter.js` (which will be the new factory file, not the types file).
- Do NOT re-declare `DatabaseAdapter`, `SyncAdapter`, `DatabaseAdapterConfig`, `isSyncAdapter`, or `InitSchemaFn` in any new file — they already exist in `types.ts`.

### DoltClient Dependency — Dependency Injection Pattern
`packages/core` cannot import `DoltClient` from `src/modules/state/dolt-client.ts` (project reference boundary). The solution is:

1. **In `packages/core/src/persistence/dolt-adapter.ts`**: define a local `DoltClientLike` interface:
   ```typescript
   interface DoltClientLike {
     query<T>(sql: string, params?: unknown[]): Promise<T[]>
     close(): Promise<void>
   }
   ```
   `DoltDatabaseAdapter` uses `DoltClientLike` everywhere instead of `DoltClient`. No import from `src/` is needed.

2. **In `packages/core/src/persistence/adapter.ts`**: the factory accepts an optional `doltClientFactory` param:
   ```typescript
   export function createDatabaseAdapter(
     config: DatabaseAdapterConfig = { backend: 'auto' },
     doltClientFactory?: (repoPath: string) => DoltClientLike
   ): DatabaseAdapter
   ```
   When `doltClientFactory` is undefined and backend is `'dolt'` or `'auto'`-detected, throw an error or fall through to memory. Callers that need Dolt must supply the factory.

3. **In `src/persistence/adapter.ts` (the shim)**: provide a concrete wrapper that injects `DoltClient`:
   ```typescript
   import { DoltClient } from '../modules/state/dolt-client.js'
   import { createDatabaseAdapter as _create } from '../../packages/core/src/persistence/adapter.js'
   export function createDatabaseAdapter(config?: DatabaseAdapterConfig) {
     return _create(config, (repoPath) => new DoltClient({ repoPath }))
   }
   ```

### Re-export Shim Pattern
Follow the pattern from stories 41-1 and 41-2. A typical shim:
```typescript
// src/persistence/memory-adapter.ts — re-export shim (migrated to packages/core in story 41-3)
export { InMemoryDatabaseAdapter } from '../../packages/core/src/persistence/memory-adapter.js'
```

### Key Files to Read Before Starting
- `packages/core/src/persistence/types.ts` — interfaces already defined here (from story 40-5); do NOT duplicate
- `packages/core/src/persistence/index.ts` — current barrel (exports types only, needs expansion)
- `packages/core/src/index.ts` — top-level barrel to update
- `packages/core/tsconfig.json` — project reference constraints
- `src/persistence/adapter.ts` — factory + interface declarations; note the factory instantiates `DoltClient` directly
- `src/persistence/dolt-adapter.ts` — `DoltDatabaseAdapter` implementation (91 lines)
- `src/persistence/memory-adapter.ts` — `InMemoryDatabaseAdapter` implementation (large file)
- `src/persistence/schema.ts` — `initSchema` DDL covering all 20+ tables
- `src/persistence/queries/*.ts` — 5 query module files
- `src/persistence/schemas/decisions.ts`, `src/persistence/schemas/operational.ts` — Zod schemas imported by query modules

### Testing Requirements
- Run `npm run build` after each task to catch TypeScript errors early; do not wait until Task 7
- `src/persistence/__tests__/adapter.contract.test.ts` tests both adapters against the contract — must pass
- `src/persistence/__tests__/decisions.test.ts` — must pass
- `src/persistence/__tests__/monitor-database.test.ts` — must pass
- `src/persistence/__tests__/performance-aggregates.test.ts` — must pass
- `src/persistence/dolt-adapter.test.ts` — must pass
- No new tests are required; existing coverage is sufficient for this migration
- Use `npm run test:fast` (not `npm test`) during iteration to avoid slow feedback loops

## Interface Contracts

- **Export**: `InMemoryDatabaseAdapter`, `DoltDatabaseAdapter`, `DoltClientLike`, `createDatabaseAdapter`, `initSchema` @ `packages/core/src/persistence/` (consumed by stories 41-6a, 41-7)
- **Export**: Query modules (amendments, cost, decisions, metrics, retry-escalated) @ `packages/core/src/persistence/queries/` (consumed by downstream stories 41-6a through 41-10)
- **Export**: Zod schema artifacts @ `packages/core/src/persistence/schemas/` (consumed by query modules in downstream stories)
- **Import**: `DatabaseAdapter`, `SyncAdapter`, `DatabaseAdapterConfig`, `isSyncAdapter`, `InitSchemaFn` @ `packages/core/src/persistence/types.ts` (from story 40-5)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All 7 tasks completed. Minor fixes applied by fix-story agent (review cycle).
- Issue 1 fix: Created packages/core/src/persistence/cost-types.ts as canonical source; updated queries/cost.ts to import from there; made src/modules/cost-tracker/types.ts re-export from core.
- Issue 2 fix: Removed redundant type re-exports from queries/decisions.ts; updated index.ts to use explicit named exports for cost and decisions queries to avoid TS2308 ambiguity.
- Issue 4 fix: Removed deprecated _parseAssignments() method from packages/core/src/persistence/memory-adapter.ts.

### File List
- packages/core/src/persistence/cost-types.ts
- packages/core/src/persistence/queries/cost.ts
- packages/core/src/persistence/queries/decisions.ts
- packages/core/src/persistence/index.ts
- packages/core/src/persistence/memory-adapter.ts
- src/modules/cost-tracker/types.ts
- packages/core/src/persistence/adapter.ts
- packages/core/src/persistence/dolt-adapter.ts
- packages/core/src/persistence/schema.ts
- packages/core/src/persistence/queries/amendments.ts
- packages/core/src/persistence/queries/metrics.ts
- packages/core/src/persistence/queries/retry-escalated.ts
- packages/core/src/persistence/schemas/decisions.ts
- packages/core/src/persistence/schemas/operational.ts
- src/persistence/adapter.ts
- src/persistence/dolt-adapter.ts
- src/persistence/memory-adapter.ts
- src/persistence/schema.ts
- src/persistence/queries/amendments.ts
- src/persistence/queries/cost.ts
- src/persistence/queries/decisions.ts
- src/persistence/queries/metrics.ts
- src/persistence/queries/retry-escalated.ts
- src/persistence/schemas/decisions.ts
- src/persistence/schemas/operational.ts

## Change Log

- 2026-03-22: Created (story 41-3)
