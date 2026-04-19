# Story 29-6: Migrate TelemetryPersistence + MonitorDatabase to DatabaseAdapter

Status: pending

## Story

As a substrate developer,
I want `TelemetryPersistence` and `MonitorDatabaseImpl` to use `DatabaseAdapter` instead of raw `better-sqlite3`,
so that telemetry and monitor data flow through a single database engine with no dual-write path.

## Acceptance Criteria

### AC1: TelemetryPersistence uses DatabaseAdapter
**Given** `src/modules/telemetry/persistence.ts`
**When** a developer inspects the class
**Then** it accepts `DatabaseAdapter` in its constructor, has zero `better-sqlite3` imports, and no compiled prepared statements

### AC2: Telemetry dual-write eliminated
**Given** telemetry tables (turn_analysis, efficiency_scores, recommendations, category_stats, consumer_stats)
**When** telemetry data is recorded during a pipeline run
**Then** data is written only through the `DatabaseAdapter` (to Dolt or in-memory) — not duplicated across SQLite and Dolt

### AC3: MonitorDatabaseImpl uses DatabaseAdapter
**Given** `src/persistence/monitor-database.ts`
**When** migrated
**Then** it accepts `DatabaseAdapter` instead of creating its own `better-sqlite3` connection, and monitor tables (task_metrics, performance_aggregates, routing_recommendations) are managed by the shared adapter

### AC4: Separate monitor.db file eliminated
**Given** the monitor module previously created a separate `~/.substrate/monitor.db` SQLite file
**When** migrated
**Then** monitor tables live in the main database (Dolt or in-memory), no separate DB file created

### AC5: All ITelemetryPersistence methods work
**Given** the 13 async methods on `ITelemetryPersistence`
**When** tested against `DoltDatabaseAdapter` (mocked) and `InMemoryDatabaseAdapter`
**Then** all methods produce correct results

### AC6: All MonitorDatabase methods work
**Given** the 9 methods on `MonitorDatabase`
**When** tested against `DoltDatabaseAdapter` (mocked) and `InMemoryDatabaseAdapter`
**Then** all methods produce correct results including `rebuildAggregates()` transaction

### AC7: Build passes
**Given** all changes
**When** `npm run build` runs
**Then** exits 0

## Tasks / Subtasks

- [ ] Task 1: Rewrite TelemetryPersistence (AC: #1, #2)
  - [ ] Replace constructor to accept `DatabaseAdapter` instead of `BetterSqlite3Database`
  - [ ] Replace 12 prepared statements with `adapter.query()` / `adapter.exec()` calls
  - [ ] Remove `better-sqlite3` imports
  - [ ] Schema initialization via `adapter.exec()` instead of `db.exec()`

- [ ] Task 2: Eliminate telemetry dual-write (AC: #2)
  - [ ] Remove SQLite telemetry table creation from `src/persistence/migrations/011-telemetry-schema.ts` (or mark as no-op)
  - [ ] Ensure DoltStateStore's telemetry tables are the single source of truth
  - [ ] Update TelemetryPipeline to write only through adapter

- [ ] Task 3: Rewrite MonitorDatabaseImpl (AC: #3, #4)
  - [ ] Replace constructor to accept `DatabaseAdapter`
  - [ ] Migrate `applyMonitorSchema()` to `adapter.exec()`
  - [ ] Replace all `.prepare().run()` / `.all()` with adapter calls
  - [ ] Remove separate DB file creation logic

- [ ] Task 4: Update telemetry tests (AC: #5)
  - [ ] Update `src/modules/telemetry/__tests__/` to use adapter
  - [ ] Test against InMemoryDatabaseAdapter

- [ ] Task 5: Update monitor tests (AC: #6)
  - [ ] Update `src/persistence/__tests__/monitor-database.test.ts` to use adapter
  - [ ] Verify `rebuildAggregates()` transaction works via `adapter.transaction()`

- [ ] Task 6: Build + test validation (AC: #7)
  - [ ] `npm run build` exits 0
  - [ ] `npm run test:fast` all passing

## Dev Notes

### Architecture Constraints

- **Prepared statement removal**: TelemetryPersistence compiles 12 statements at constructor time. This pattern doesn't work with async adapters. Replace with direct `adapter.query()` calls per invocation. The performance impact is negligible — telemetry writes happen at ~1/sec during runs.
- **Monitor DB consolidation**: The separate `monitor.db` file was a design choice to isolate monitor metrics from pipeline state. With DatabaseAdapter, both share the same Dolt instance (or InMemory instance). This simplifies connection management but means monitor tables share the same namespace.
- **Schema management**: Telemetry and monitor schemas are currently applied via `db.exec(DDL)`. Replace with `adapter.exec(DDL)`. The DDL may need MySQL syntax adjustments for Dolt compatibility (see 29-3 dev notes on dialect differences).

### Testing Requirements

- Test TelemetryPersistence and MonitorDatabase against InMemoryDatabaseAdapter
- Verify dual-write path is eliminated by confirming no SQLite telemetry writes remain
- Transaction handling in rebuildAggregates must work through adapter.transaction()
