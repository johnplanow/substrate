# Story 28-10: Dolt Schema Migration — dependencies Column

Status: review

## Story

As a pipeline operator upgrading from Sprint 1 to Sprint 2+,
I want existing Dolt databases to automatically gain the `dependencies JSON` column on `repo_map_symbols`,
so that `findByDependedBy()` queries work without requiring a manual database rebuild.

## Acceptance Criteria

### AC1: Detect Missing Column
**Given** a Dolt database created with schema v5 (before `dependencies` column was added)
**When** `DoltStateStore.ensureSchema()` runs during pipeline startup
**Then** it detects that `repo_map_symbols` is missing the `dependencies` column and applies the migration

### AC2: Idempotent ALTER TABLE
**Given** a Dolt database that already has the `dependencies` column (schema v6+)
**When** `ensureSchema()` runs
**Then** no error occurs and no duplicate column is added; the migration is a no-op

### AC3: Column Default for Existing Rows
**Given** existing rows in `repo_map_symbols` without a `dependencies` value
**When** the `ALTER TABLE ADD COLUMN` migration runs
**Then** existing rows receive `NULL` as their `dependencies` value, and `_rowToRepoMapSymbol()` correctly treats `NULL` as empty array `[]`

### AC4: Schema Version Bump
**Given** a successful migration
**When** the migration completes
**Then** schema version 6 is recorded in `_schema_version` table with description matching the INSERT IGNORE in schema.sql

### AC5: Migration Logged
**Given** a database requiring migration
**When** `ALTER TABLE` is applied
**Then** an info-level log is emitted: `{ component: 'dolt-state', migration: 'v5-to-v6' }` with the column name and table

## Tasks / Subtasks

- [x] Task 1: Add column-existence detection in DoltStateStore init path
  - [x] Query `DESCRIBE repo_map_symbols` or `SHOW COLUMNS FROM repo_map_symbols` to check for `dependencies` column
  - [x] If missing, run `ALTER TABLE repo_map_symbols ADD COLUMN dependencies JSON`
  - [x] Insert schema version 6 if not present

- [x] Task 2: Unit tests
  - [x] Test: migration runs when column is missing (mock SHOW COLUMNS returning no `dependencies`)
  - [x] Test: migration is skipped when column exists (mock SHOW COLUMNS returning `dependencies`)
  - [x] Test: schema version 6 inserted after migration

## Dev Notes

### Architecture Constraints
- Migration runs in `DoltStateStore.ensureSchema()` AFTER `CREATE TABLE IF NOT EXISTS` statements
- Use `SHOW COLUMNS FROM repo_map_symbols LIKE 'dependencies'` — returns 0 rows if missing, 1 row if present
- `ALTER TABLE ... ADD COLUMN` is idempotent in Dolt when combined with the column check
- This is a Dolt-only concern — FileStateStore uses in-memory Maps and has no schema migration

### File Paths
```
src/modules/state/dolt-state-store.ts  ← MODIFY: add migration logic to ensureSchema()
src/modules/state/__tests__/dolt-state-store.test.ts  ← MODIFY: add migration tests
```

### Interface Contracts
- **No new exports** — this is internal migration logic
- **Depends on**: schema.sql v6 definition (already applied in Sprint 1 fix)

## Change Log
- 2026-03-12: Story created to capture Dolt schema migration gap identified during Sprint 1 review
