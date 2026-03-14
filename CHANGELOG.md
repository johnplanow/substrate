# Changelog

## [Unreleased] — v0.4.x

### Breaking: Full SQLite removal — better-sqlite3 removed (Epic 29, Story 29-8)

`better-sqlite3` and `@types/better-sqlite3` have been completely removed from `package.json` (both `dependencies` and `devDependencies`). The `SqliteDatabaseAdapter` class (`src/persistence/sqlite-adapter.ts`) and all 11 SQLite migration files (`src/persistence/migrations/`) have also been deleted.

**Who is affected:**
- Developers who call `createDatabaseAdapter({ backend: 'sqlite', ... })` directly — the sqlite backend now requires better-sqlite3 to be installed separately (not recommended; use `'auto'` or `'dolt'` instead)
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
