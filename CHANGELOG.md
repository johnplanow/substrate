# Changelog

## [Unreleased] — v0.4.x

### Changed: better-sqlite3 moved to devDependencies (Epic 29, Story 29-8)

`better-sqlite3` and `@types/better-sqlite3` have been moved from production `dependencies` to `devDependencies`. Production installs (`npm install substrate-ai`) no longer require native C++ compilation. A self-referential `substrate-ai` transitive dependency has also been removed.

`sql.js` (WASM SQLite) has been added to `devDependencies` for future test migration work.

### Breaking: FileStateStore no longer persists metrics to SQLite (Epic 29)

`FileStateStore` has been updated to be a pure in-memory TypeScript implementation with no `better-sqlite3` dependency. The `db?` option on `FileStateStoreOptions` has been removed — the constructor now only accepts `basePath?: string`.

**Who is affected:** Users who ran substrate pipeline runs before Epic 29 (v0.4.x) and have historical metrics stored in `.substrate/*.db` SQLite files.

**Remediation:** If you want to retain historical SQLite metric data, run `substrate migrate` (from Epic 26-13) **before** upgrading to v0.4.x to move data to Dolt. After upgrade, all new metrics are stored in Dolt when Dolt is available on your PATH, or are ephemeral in-memory when `FileStateStore` is used (CI environments).
