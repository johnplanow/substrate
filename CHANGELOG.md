# Changelog

## [0.9.0] — 2026-03-22

### Feature: @substrate-ai/core package extraction (Epic 41)

The `@substrate-ai/core` npm workspace package now contains all general-purpose agent
infrastructure modules previously embedded in the Substrate monolith. Downstream packages
(SDLC, factory) can import from `@substrate-ai/core` without coupling to SDLC-specific types.

Stories 41-1 through 41-12 migrated the following module groups into `packages/core/src/`:
adapters, config, dispatch, events, git, persistence, routing, telemetry, supervisor, budget,
cost-tracker, monitor, and version-manager.

**Backward-compatibility shim strategy:** Every `src/` module in the monolith that was migrated
retains a thin re-export shim (e.g., `src/events/index.ts` re-exports from `@substrate-ai/core`)
so that existing internal import paths continue to resolve without modification. No call sites
outside `packages/core/` were changed.

**Who is affected:**
- Downstream packages that previously imported from `substrate-ai` internals and now want
  transport-agnostic types: import from `@substrate-ai/core` directly.
- CI and integration test environments: no change required — the shim layer is transparent.

**Who is NOT affected:**
- Existing CLI users — the `substrate` command behavior is unchanged.
- Projects importing from `substrate-ai` top-level exports — all public API surface is intact.

## [0.5.0] — 2026-03-14

### Breaking: Full SQLite removal — better-sqlite3 removed (Epic 29)

`better-sqlite3` and `@types/better-sqlite3` have been completely removed from the project. The `SqliteDatabaseAdapter`, `LegacySqliteAdapter`, all 11 SQLite migration files, and the WASM mock infrastructure have been deleted. The `backend: 'sqlite'` config option no longer exists.

**Who is affected:**
- Developers who called `createDatabaseAdapter({ backend: 'sqlite', ... })` — this backend has been removed entirely. Use `'auto'` or `'dolt'` instead.
- Users of `substrate monitor` and `substrate metrics` who relied on reading historical `.db` SQLite files — these commands now use Dolt (when available) or in-memory storage
- Any code importing from `src/persistence/sqlite-adapter.ts` or `src/persistence/migrations/` — these files are deleted

**Who is NOT affected:**
- CI environments using `InMemoryDatabaseAdapter` (no change)
- Environments with Dolt installed and initialized (primary supported backend)
- Fresh installations — `npm install substrate-ai` now completes without any C++ native addon compilation

**Remediation (if you have historical SQLite data):**
Run `substrate migrate` (from Epic 26-13) **before** upgrading to this version to move data to Dolt. After upgrade, run with `--dolt` or ensure Dolt is available on PATH.

### Breaking: FileStateStore no longer persists metrics to SQLite (Epic 29)

`FileStateStore` has been updated to be a pure in-memory TypeScript implementation with no `better-sqlite3` dependency. The `db?` option on `FileStateStoreOptions` has been removed — the constructor now only accepts `basePath?: string`.

**Who is affected:** Users who ran substrate pipeline runs before Epic 29 (v0.4.x) and have historical metrics stored in `.substrate/*.db` SQLite files.

**Remediation:** If you want to retain historical SQLite metric data, run `substrate migrate` (from Epic 26-13) **before** upgrading to v0.4.x to move data to Dolt. After upgrade, all new metrics are stored in Dolt when Dolt is available on your PATH, or are ephemeral in-memory when `FileStateStore` is used (CI environments).
