# Epic 29: Dolt Default + Full SQLite Sunset

**Status: IN_PROGRESS — Sprint 1 complete, Sprint 2 near-complete (29-6, 29-8 done; 29-10 remaining)**

## Vision

After Epics 27 (OTEL Observability) and 28 (Context Engineering) exercised the Dolt backend under real production load, Dolt is proven infrastructure. This epic makes Dolt the default backend and removes the `better-sqlite3` native dependency **entirely** — not just from the state store, but from the whole project.

Sprint 1 (complete) flipped the state store default to `'auto'` and decoupled `FileStateStore` from SQLite. Sprint 2 migrates the remaining persistence layer (`src/persistence/` — decisions, metrics, telemetry, monitor) from `better-sqlite3` to Dolt, then removes the native dependency from `package.json`.

The end state: **one database engine (Dolt)**, one in-memory fallback for CI, zero native C++ dependencies.

## Rationale

### Why consolidate to one engine?

- The persistence layer grew organically across epics: SQLite was first (Epic 1), Dolt was added for state versioning (Epic 26), telemetry tables were duplicated across both (Epic 27). The result is **three database instances** (main SQLite, monitor SQLite, Dolt) with telemetry data written to two of them.
- `better-sqlite3` is a **native C++ addon** — the heaviest dependency in substrate. It requires compilation during `npm install`, fails on some platforms, and adds ~5MB to the install footprint.
- Dolt supports everything SQLite does here — it's MySQL-wire-compatible with parameterized queries, transactions, and schema migrations. There's no technical reason to keep two engines.
- Cognitive overhead: every new feature must answer "does this go in SQLite or Dolt?" The answer keeps being "both" for telemetry. One engine eliminates this.

### Why now?

- Dolt has accumulated real usage across Epics 27 and 28 — multiple weeks of pipeline runs on the ynab cross-project validation with zero Dolt-related issues.
- Sprint 1 already proved the pattern: `FileStateStore` shed its SQLite dependency and became pure in-memory TypeScript with no regressions.
- The persistence layer migration is bounded: 33 query functions, 40+ consumer files, all mechanical async conversion.

## Scope

### In Scope

- **Sprint 1 (COMPLETE):** Flip `createStateStore` default to `'auto'`, decouple `FileStateStore` from SQLite
- **Sprint 2:** Create `DatabaseAdapter` abstraction, migrate all `src/persistence/` query modules to Dolt, migrate all CLI commands and modules to async persistence, fold `MonitorDatabase` and `TelemetryPersistence` into Dolt, remove `better-sqlite3` entirely

### Out of Scope

- Removing FileStateStore entirely (it's still valuable for CI/testing as in-memory fallback)
- DoltHub remote collaboration (future)
- New Dolt features beyond what's needed for the migration

### Prerequisites

- **Epic 26 Sprint 4 complete**: auto-detection, init bootstrapping, migration tool — DONE
- **Epic 27 complete**: OTEL features exercised Dolt under real pipeline load — DONE
- **Epic 28 complete**: Context engineering exercised Dolt schema extensions — DONE
- **Sprint 1 complete**: State store defaults to Dolt, FileStateStore is SQLite-free — DONE

## Story Map

```
Sprint 1 — Default Flip + State Store Cleanup (COMPLETE):
  Story 29-1: Make 'auto' the Default Backend (P0, S) ✓
  Story 29-2: Remove better-sqlite3 from FileStateStore (P0, M) ✓

Sprint 2 — Full Persistence Migration:
  Story 29-3: Create DatabaseAdapter Interface + Dual Implementations (P0, S) ✓
  Story 29-4: Migrate Query Modules to DatabaseAdapter (P0, M) ✓
  Story 29-5: Migrate CLI Commands to Async Persistence (P0, M) ✓
  Story 29-6: Migrate TelemetryPersistence + MonitorDatabase to DatabaseAdapter (P0, M) ✓
  Story 29-7: Migrate Module Consumers to Async Persistence (P0, M) ✓
  Story 29-8: Remove better-sqlite3 + Cleanup (P0, S) ✓
  Story 29-9: Migrate Test Files to WASM Mock + Delete Legacy Files (P0, M) ✓
  Story 29-10: Final SQLite Reference Cleanup (P0, M) — test file migration, escape hatch sunset, stale comments
```

## Story Details

### Story 29-1: Make 'auto' the Default Backend (P0, S)

**Status: COMPLETE**

**Problem:** After Epics 27 and 28, Dolt is proven infrastructure. The factory default should reflect this — users with Dolt installed should get it automatically without any config.

**Acceptance Criteria:**
- AC1: `createStateStore()` with no config uses `'auto'` detection (was `'file'`)
- AC2: `StateStoreConfig.backend` default value changed from `'file'` to `'auto'`
- AC3: Existing `backend: 'file'` configs continue to work (explicit override honored)
- AC4: CLAUDE.md updated: substrate commands table includes `diff` and `history`, OTEL and repo-map features documented as requiring Dolt
- AC5: `substrate init` output updated to prominently show Dolt status
- AC6: All tests pass — CI uses FileStateStore (no Dolt binary in CI), production uses auto-detected Dolt

**Depends on:** Epic 26 Sprint 4 (26-10 auto-detection), Epics 27 and 28 complete

**Files:** `src/modules/state/types.ts`, `src/modules/state/index.ts`, `src/cli/templates/claude-md-substrate-section.md`, `src/cli/commands/init.ts`

### Story 29-2: Remove better-sqlite3 from FileStateStore (P0, M)

**Status: COMPLETE**

**Problem:** `better-sqlite3` is a native C++ addon. With Dolt as the default state backend, the FileStateStore's SQLite dependency serves no purpose — it should become a pure in-memory backend for CI/testing.

**Acceptance Criteria:**
- AC1: `file-store.ts` contains zero `better-sqlite3` imports
- AC2: `FileStateStoreOptions.db` field removed
- AC3: `FileStateStore.recordMetric` uses only in-memory storage
- AC4: `run.ts` updated to drop the `db` option from FileStateStore
- AC5: All unit tests pass without SQLite mocks
- AC6: `npm run build` exits 0
- AC7: CHANGELOG upgrade warning added for pre-29 SQLite users

**Depends on:** Story 29-1 (default is 'auto'), Story 26-13 (migration tool exists)

**Files:** `src/modules/state/file-store.ts`, `src/cli/commands/run.ts`, `CHANGELOG.md`

### Story 29-3: Create DatabaseAdapter Interface + Dual Implementations (P0, S)

**Status: COMPLETE**

**Problem:** The persistence layer uses raw `better-sqlite3` synchronous calls throughout. To migrate to Dolt, we need an async abstraction that both engines can implement, enabling incremental migration.

**Acceptance Criteria:**
- AC1: `DatabaseAdapter` interface defined in `src/persistence/adapter.ts` with async `query<T>(sql, params?)`, `exec(sql)`, `transaction<T>(fn)`, and `close()` methods
- AC2: `SqliteDatabaseAdapter` wraps existing `better-sqlite3` calls, returns resolved promises — all existing behavior preserved
- AC3: `DoltDatabaseAdapter` wraps `DoltClient.query()` for production use when Dolt is available
- AC4: `InMemoryDatabaseAdapter` satisfies the interface with Maps/arrays for CI/test environments without Dolt
- AC5: Factory function `createDatabaseAdapter(config)` auto-detects Dolt availability (reuses existing detection from state store) and returns appropriate adapter
- AC6: Contract test suite validates all three implementations against the same interface expectations
- AC7: All existing tests pass — no consumers changed yet, this is additive only

**Depends on:** Story 29-2 (FileStateStore already SQLite-free)

**Files:** `src/persistence/adapter.ts`, `src/persistence/sqlite-adapter.ts`, `src/persistence/dolt-adapter.ts`, `src/persistence/memory-adapter.ts`, `src/persistence/__tests__/adapter.contract.test.ts`

### Story 29-4: Migrate Query Modules to DatabaseAdapter (P0, M)

**Status: COMPLETE**

**Problem:** The 5 query modules in `src/persistence/queries/` accept raw `BetterSqlite3Database` and use synchronous `.prepare().all()` / `.run()` calls. They need to accept `DatabaseAdapter` and return Promises.

**Acceptance Criteria:**
- AC1: All 33 functions across `decisions.ts`, `cost.ts`, `amendments.ts`, `metrics.ts`, `retry-escalated.ts` accept `DatabaseAdapter` instead of `BetterSqlite3Database`
- AC2: All functions are async, returning `Promise<T>` instead of `T`
- AC3: All existing query tests updated to pass `SqliteDatabaseAdapter` — behavior unchanged
- AC4: Transaction-wrapped operations use `adapter.transaction()` instead of `db.transaction()`
- AC5: Prepared statement caching patterns replaced with adapter-compatible equivalents
- AC6: `npm run build` exits 0, `npm run test:fast` all passing

**Depends on:** Story 29-3 (DatabaseAdapter interface exists)

**Files:** `src/persistence/queries/decisions.ts`, `src/persistence/queries/cost.ts`, `src/persistence/queries/amendments.ts`, `src/persistence/queries/metrics.ts`, `src/persistence/queries/retry-escalated.ts`, `src/persistence/queries/__tests__/*.ts`

### Story 29-5: Migrate CLI Commands to Async Persistence (P0, M)

**Status: COMPLETE**

**Problem:** 13 CLI command files pass raw `db` (BetterSqlite3Database) to query functions. With query functions now async, all callsites need `await` and commands need to use `DatabaseAdapter`.

**Acceptance Criteria:**
- AC1: All 13 CLI commands (`run.ts`, `amend.ts`, `cost.ts`, `health.ts`, `status.ts`, `metrics.ts`, `resume.ts`, `monitor.ts`, `retry-escalated.ts`, `supervisor.ts`, `migrate.ts`, `export.ts`, `init.ts`) use `DatabaseAdapter` instead of raw `BetterSqlite3Database`
- AC2: `run.ts` ~20 callsites converted to `await` — pipeline execution flow preserved
- AC3: `DatabaseWrapper` usage replaced with `createDatabaseAdapter()` factory
- AC4: All CLI command tests pass
- AC5: `npm run build` exits 0

**Depends on:** Story 29-4 (query modules are async)

**Files:** `src/cli/commands/run.ts`, `src/cli/commands/amend.ts`, `src/cli/commands/cost.ts`, `src/cli/commands/health.ts`, `src/cli/commands/status.ts`, `src/cli/commands/metrics.ts`, `src/cli/commands/resume.ts`, `src/cli/commands/monitor.ts`, `src/cli/commands/retry-escalated.ts`, `src/cli/commands/supervisor.ts`, `src/cli/commands/migrate.ts`, `src/cli/commands/export.ts`, `src/cli/commands/init.ts`

### Story 29-6: Migrate TelemetryPersistence + MonitorDatabase to DatabaseAdapter (P0, M)

**Status: COMPLETE** — TelemetryPersistence delegated to AdapterTelemetryPersistence, MonitorDatabase rewritten to SyncAdapter

**Problem:** `TelemetryPersistence` compiles 12 prepared statements against SQLite at constructor time. `MonitorDatabaseImpl` is a separate SQLite database file. Both need to use `DatabaseAdapter`, eliminating the telemetry dual-write path and the separate monitor DB.

**Current state (post 29-9):** `src/modules/telemetry/persistence.ts` and `src/persistence/monitor-database.ts` are the only two files that still import `better-sqlite3` directly. The `AdapterTelemetryPersistence` alternative already exists in `src/modules/telemetry/adapter-persistence.ts` and is wired into `metrics.ts`. The remaining work is migrating the original `TelemetryPersistence` class and `MonitorDatabaseImpl` to use `DatabaseAdapter`.

**Acceptance Criteria:**
- AC1: `TelemetryPersistence` rewritten to use `DatabaseAdapter` — no `better-sqlite3` imports, no prepared statement caching
- AC2: Telemetry dual-write eliminated — telemetry tables exist only in Dolt (or in-memory adapter), not duplicated across SQLite and Dolt
- AC3: `MonitorDatabaseImpl` rewritten to use `DatabaseAdapter` — monitor tables folded into main database, separate `monitor.db` file eliminated
- AC4: All 13 `ITelemetryPersistence` methods work against `DoltDatabaseAdapter` and `InMemoryDatabaseAdapter`
- AC5: All 9 `MonitorDatabase` methods work against `DoltDatabaseAdapter` and `InMemoryDatabaseAdapter`
- AC6: All telemetry and monitor tests pass
- AC7: `npm run build` exits 0

**Depends on:** Story 29-3 (DatabaseAdapter interface exists) — DONE

**Files:** `src/modules/telemetry/persistence.ts`, `src/persistence/monitor-database.ts`, `src/modules/telemetry/__tests__/*.ts`, `src/persistence/__tests__/monitor-database.test.ts`

### Story 29-7: Migrate Module Consumers to Async Persistence (P0, M)

**Status: COMPLETE**

**Problem:** 25+ module files accept `BetterSqlite3Database` type and call query functions synchronously. With the query layer now async, all module consumers need `await` and `DatabaseAdapter`.

**Acceptance Criteria:**
- AC1: `implementation-orchestrator` (5 files) migrated to `DatabaseAdapter` + async
- AC2: `compiled-workflows` (8 files) migrated to `DatabaseAdapter` + async
- AC3: `phase-orchestrator` (5 files) migrated to `DatabaseAdapter` + async
- AC4: `supervisor` (2 files) migrated to `DatabaseAdapter` + async
- AC5: `context-compiler`, `debate-panel`, `cost-tracker`, `amendment-handlers` migrated
- AC6: `retry-formatter.ts` updated to use `DatabaseAdapter` type
- AC7: All module tests pass, `npm run build` exits 0

**Depends on:** Story 29-4 (query modules are async)

**Files:** `src/modules/implementation-orchestrator/*.ts`, `src/modules/compiled-workflows/*.ts`, `src/modules/phase-orchestrator/*.ts`, `src/modules/supervisor/*.ts`, `src/modules/context-compiler/context-compiler-impl.ts`, `src/modules/debate-panel/debate-panel-impl.ts`, `src/modules/cost-tracker/cost-tracker-impl.ts`, `src/modules/amendment-handlers/index.ts`, `src/cli/formatters/retry-formatter.ts`

### Story 29-8: Remove better-sqlite3 + Cleanup (P0, S)

**Status: COMPLETE** — better-sqlite3 removed from package.json, migrations deleted, sqlite-adapter.ts deleted

**Problem:** With all consumers migrated to `DatabaseAdapter`, `better-sqlite3` and the SQLite-specific code can be removed entirely.

**Current state (post 29-9):** `DatabaseWrapper` class already deleted (`src/persistence/database.ts` removed). `database.test.ts` deleted. `sqlite-adapter.ts` still exists (modified but not deleted). `migrations/` directory still exists. `better-sqlite3` still in devDependencies because `persistence.ts` and `monitor-database.ts` still import it (blocked on 29-6).

**Acceptance Criteria:**
- AC1: `better-sqlite3` and `@types/better-sqlite3` removed from `package.json` (both dependencies and devDependencies)
- ~~AC2: `SqliteDatabaseAdapter` removed~~ — REVISED: `sqlite-adapter.ts` to be deleted
- ~~AC3: `DatabaseWrapper` class removed from `src/persistence/database.ts`~~ — DONE in 29-9
- AC4: `src/persistence/migrations/` removed — Dolt schema managed by adapter init
- AC5: `npm install` completes with zero native C++ compilation
- AC6: All 5400+ tests pass
- AC7: CHANGELOG updated with full SQLite removal notice and migration path
- AC8: `npm run build` exits 0

**Depends on:** Story 29-6 (telemetry + monitor migrated — last better-sqlite3 consumers)

**Files:** `package.json`, `src/persistence/sqlite-adapter.ts`, `src/persistence/migrations/`, `CHANGELOG.md`

### Story 29-10: Final SQLite Reference Cleanup (P0, M)

**Status: DRAFT** — Created from architectural review of 29-6/29-8 changes

**Problem:** Stories 29-1 through 29-9 completed the structural migration, but residual `better-sqlite3` references remain: ~80 test files use aliased imports (resolved by vitest to WASM mock), `migrate.ts` has a try/catch escape hatch for pre-Epic-29 users, `adapter.ts` still contains the `LegacySqliteAdapter` class and `backend: 'sqlite'` code path, and several production files have stale comments. These don't break anything today but (a) confuse contributors, (b) leave dead code paths, and (c) prevent fully closing Epic 29's "zero native C++ dependency" goal.

**Acceptance Criteria:**
- AC1: All ~80 test files migrated from `import Database from 'better-sqlite3'` to `createWasmSqliteAdapter()` — no test file imports `better-sqlite3`
- AC2: vitest alias, tsconfig path mapping, and `src/__mocks__/better-sqlite3.ts` deleted
- AC3: `migrate.ts` escape hatch removed — no runtime `import('better-sqlite3')` in production
- AC4: `LegacySqliteAdapter` class and `backend: 'sqlite'` case removed from `adapter.ts`
- AC5: Zero `better-sqlite3` string matches in any production `.ts` file
- AC6: All tests pass, build exits 0

**Depends on:** Stories 29-6, 29-8 (production code fully migrated)

**Full story spec:** `_bmad-output/implementation-artifacts/29-10-final-sqlite-cleanup.md`

## Dependency Analysis

**Sprint 1 (COMPLETE):**
- Story 29-1 → 29-2 (sequential: default must flip before FileStateStore sheds SQLite)

**Sprint 2 (mostly COMPLETE):**
- Story 29-3 (DatabaseAdapter) ✓
- Story 29-4 (query modules) ✓
- Story 29-5 (CLI commands) ✓
- Story 29-6 (telemetry + monitor) ✓
- Story 29-7 (module consumers) ✓
- Story 29-8 (remove SQLite) ✓
- Story 29-9 (test migration + legacy deletion) ✓
- Story 29-10 (final cleanup) — **DRAFT, last story before epic closure**

**Remaining dependency chain:**
```
29-6 (telemetry+monitor) ✓ → 29-8 (remove better-sqlite3, delete sqlite-adapter.ts, delete migrations/) ✓ → 29-10 (final cleanup: ~80 test files, migrate.ts escape hatch, LegacySqliteAdapter removal, stale comments, mock deletion)
```

## Sprint Plan

**Sprint 1 (COMPLETE):** Stories 29-1, 29-2 — Flip default, decouple FileStateStore from SQLite.

**Sprint 2 (NEAR-COMPLETE):** Stories 29-3 through 29-10 — Full persistence migration to Dolt.
- 29-3, 29-4, 29-5, 29-6, 29-7, 29-8, 29-9: COMPLETE
- 29-10: Final cleanup — test file migration, escape hatch sunset, dead code removal

## Success Metrics

- `npm install` completes with zero native C++ compilation
- Package install size reduced by removal of `better-sqlite3` native addon
- All 6000+ tests pass with Dolt or InMemoryDatabaseAdapter
- Zero production regressions — Dolt handles all persistence, InMemory handles CI
- Single database engine in production — no dual-write paths, no separate DB files
- Every query function has a single async code path (no sync/async split)

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Sync-to-async cascade breaks too many files at once | Story 29-4 migrates query layer first; consumers migrate in parallel stories 29-5/6/7 |
| Dolt query performance worse than SQLite for write-heavy telemetry | Benchmark in 29-6; Dolt handles MySQL wire protocol efficiently, volumes are low |
| InMemoryDatabaseAdapter doesn't cover all test scenarios | Contract test suite (29-3 AC6) validates all three adapters against same expectations |
| Migration too large for single sprint | Stories 29-5, 29-6, 29-7 are parallelizable; each is independently shippable |
| Prepared statement caching loss affects performance | Telemetry ingestion rate is low (~1 write/sec during runs); ad-hoc queries are fine |
| CI environments lose persistence between commands | Acceptable — CI never needed persistent decisions. `InMemoryDatabaseAdapter` matches `FileStateStore` ephemeral pattern |
