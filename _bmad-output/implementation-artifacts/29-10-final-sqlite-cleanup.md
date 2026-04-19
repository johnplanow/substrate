# Story 29-10: Final SQLite Reference Cleanup + Epic 29 Closure

Status: draft

## Story

As a substrate developer,
I want all remaining `better-sqlite3` references removed from production source and test files,
so that Epic 29's goal of "zero native C++ dependencies" is fully realized with no lingering confusion for contributors.

## Context

Stories 29-1 through 29-9 completed the structural migration: production code uses `DatabaseAdapter` (Dolt/InMemory), the native `better-sqlite3` package is removed from `package.json`, and a vitest alias redirects test-time imports to a WASM mock. However, three categories of cleanup remain:

1. **~80 test files** still `import Database from 'better-sqlite3'` — resolved at test time by the vitest alias to `src/__mocks__/better-sqlite3.ts`, but confusing to contributors who see the import and assume a native dependency exists.
2. **`migrate.ts` escape hatch** — contains `await import('better-sqlite3')` in a try/catch to support users upgrading from pre-Epic-29. This should be sunset now that v0.5.0 is imminent.
3. **Stale comments** — several production files reference `better-sqlite3` in comments/docstrings that describe historical context no longer relevant.
4. **Mock infrastructure** — `src/__mocks__/better-sqlite3.ts` and the vitest alias in `vitest.config.ts` exist solely to support the aliased test imports. Once test files are migrated, both can be removed.

This story ensures Epic 29 closes clean: no `better-sqlite3` string appears anywhere in the project except the CHANGELOG (historical record).

## Acceptance Criteria

### AC1: Test files migrated from aliased imports to direct WASM adapter
**Given** ~80 test files that `import Database from 'better-sqlite3'`
**When** each file is updated to use `createWasmSqliteAdapter()` from `src/persistence/wasm-sqlite-adapter.ts`
**Then** no test file imports `better-sqlite3` directly
**And** each test's setup pattern uses `const adapter = await createWasmSqliteAdapter(); await initSchema(adapter)` instead of `new Database(':memory:')`

### AC2: vitest alias and mock removed
**Given** AC1 is complete (no consumer of the mock remains)
**When** `vitest.config.ts` and `tsconfig.json` are inspected
**Then** the `better-sqlite3` alias entry is removed from `resolve.alias` in vitest config
**And** the `better-sqlite3` path mapping is removed from `tsconfig.json` (if present)
**And** `src/__mocks__/better-sqlite3.ts` is deleted

### AC3: migrate.ts escape hatch removed
**Given** `src/cli/commands/migrate.ts` contains `await import('better-sqlite3')` try/catch
**When** the escape hatch is removed
**Then** the migration command no longer attempts to open legacy SQLite databases
**And** the command prints a clear message directing pre-Epic-29 users to export data before upgrading
**And** no runtime `import('better-sqlite3')` or `require('better-sqlite3')` exists in any production file

### AC4: adapter.ts LegacySqliteAdapter backend removed
**Given** `src/persistence/adapter.ts` contains a `case 'sqlite':` path that calls `require('better-sqlite3')`
**When** the `'sqlite'` backend case is removed
**Then** `createDatabaseAdapter()` only supports `'auto'`, `'dolt'`, and `'memory'` backends
**And** `LegacySqliteAdapter` class is deleted from `adapter.ts`
**And** `DatabaseAdapterConfig.backend` type updated to `'auto' | 'dolt' | 'memory'`

### AC5: Stale comments cleaned up
**Given** production source files contain comments referencing `better-sqlite3`
**When** all comment-only references are updated or removed
**Then** no production `.ts` file in `src/` contains the string `better-sqlite3` (excluding test files and the deleted mock)

### AC6: All tests pass
**Given** the complete test suite
**When** `npm run test:fast` runs
**Then** all tests pass with zero regressions

### AC7: Build passes
**Given** all changes
**When** `npm run build` runs
**Then** it exits 0 with no type errors

### AC8: No runtime import of better-sqlite3 exists
**Given** the entire `src/` directory
**When** searched for `require('better-sqlite3')`, `import('better-sqlite3')`, or `from 'better-sqlite3'`
**Then** zero matches are found (excluding CHANGELOG and git history)

## Dev Notes

### Migration Pattern for Test Files

Each test file follows one of two patterns:

**Pattern A — Direct Database usage (most common):**
```typescript
// BEFORE
import Database from 'better-sqlite3'
const db = new Database(':memory:')
// ... raw db.prepare().run() calls

// AFTER
import { createWasmSqliteAdapter } from '../../persistence/wasm-sqlite-adapter.js'
import { initSchema } from '../../persistence/schema.js'
const adapter = await createWasmSqliteAdapter()
await initSchema(adapter)
// ... adapter.query() / adapter.exec() calls
```

**Pattern B — Mock factory for production code (vi.mock):**
```typescript
// BEFORE
vi.mock('../../persistence/adapter.js', () => {
  let mockAdapter: DatabaseAdapter | null = null
  return {
    createDatabaseAdapter: () => mockAdapter!,
    __setMockAdapter: (a: DatabaseAdapter) => { mockAdapter = a },
  }
})
// ... then creates Database from 'better-sqlite3' and wraps in LegacySqliteAdapter

// AFTER
vi.mock('../../persistence/adapter.js', () => { /* same pattern */ })
// ... then creates adapter via createWasmSqliteAdapter()
```

### Scope Estimate

- ~80 test files across 7 directories (phase-orchestrator, implementation-orchestrator, compiled-workflows, cli/commands, persistence, modules, e2e)
- 3 production files to modify (adapter.ts, migrate.ts, monitor-database.ts comments)
- 2 production files with comment-only changes (telemetry/persistence.ts, telemetry/adapter-persistence.ts)
- 2 infrastructure files to delete (mock + vitest alias entry)
- Suggest splitting by directory into 4-5 sub-agent dispatches for parallelism

### Risks

1. **Pattern B tests** that use `vi.mock` with `__setMockAdapter` — adapter injection pattern stays the same, only the adapter creation changes. Low risk.
2. **`db.prepare().run()` direct calls** — some tests call better-sqlite3 APIs directly (not through adapter). These need refactoring to `adapter.query()`/`adapter.exec()`. Medium effort.
3. **`LegacySqliteAdapter` removal in adapter.ts** — verify no production code path still instantiates it. The `backend: 'sqlite'` case was already documented as test-only, so removal should be safe.
4. **migrate.ts escape hatch removal** — users upgrading from pre-v0.4.0 with a `substrate.db` file lose the auto-migration path. Mitigate with a clear error message and docs link.

### Epic 30 Note (informational, not in scope)

Quinn flagged: `TelemetryAdvisor` (story 30-5) will read from the same adapter that `TelemetryPipeline` writes to. Currently, the pipeline and the metrics CLI create separate adapter instances. Story 30-5 should ensure they share an instance or that Dolt handles concurrent connections cleanly. Document this in the 30-5 story spec when it is created.

## Tasks

- [ ] Task 1: Migrate `src/persistence/__tests__/` and `src/persistence/queries/__tests__/` test files (~8 files)
- [ ] Task 2: Migrate `src/cli/commands/__tests__/` test files (~6 files)
- [ ] Task 3: Migrate `src/modules/phase-orchestrator/__tests__/` and `phases/__tests__/` test files (~20 files)
- [ ] Task 4: Migrate `src/modules/implementation-orchestrator/__tests__/` test files (~15 files)
- [ ] Task 5: Migrate `src/modules/compiled-workflows/__tests__/` test files (~5 files)
- [ ] Task 6: Migrate remaining module test files (cost-tracker, debate-panel, context-compiler, supervisor, export, telemetry) (~10 files)
- [ ] Task 7: Migrate `src/__tests__/` and `test/` test files (~8 files)
- [ ] Task 8: Remove `LegacySqliteAdapter` class and `backend: 'sqlite'` case from `adapter.ts` (AC4)
- [ ] Task 9: Remove `migrate.ts` escape hatch — delete `import('better-sqlite3')` try/catch, add clear upgrade message (AC3)
- [ ] Task 10: Clean up all remaining `better-sqlite3` comments in production files (AC5)
- [ ] Task 11: Delete `src/__mocks__/better-sqlite3.ts`, remove vitest alias from `vitest.config.ts`, remove tsconfig path mapping if present (AC2)
- [ ] Task 12: Run full test suite + build validation (AC6, AC7)
- [ ] Task 13: Final grep validation — zero `better-sqlite3` matches in `src/` (AC8)

## Change Log

- 2026-03-13: Story created from BMAD party mode architectural review (stories 29-6/29-8 review session)
