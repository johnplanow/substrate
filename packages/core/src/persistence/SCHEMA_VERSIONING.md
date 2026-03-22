# Schema Versioning Guide

This document describes the schema version management strategy for `@substrate-ai/core` and the factory package (Epic 44+).

---

## 1. Version Numbering Convention

Schema versions are non-negative integers starting at **1**.

- Increment the version by **exactly 1** for each schema change.
- **Never reuse or skip version numbers.**
- Version `0` is reserved to mean "unversioned" — do not use it as an applied version.
- The current version for each schema is stored in the `schema_version` table, keyed by `schema_name`.

---

## 2. Authoring a Migration

Define a migration as a `SchemaMigration` object and include it in your schema's migration list:

```typescript
import type { SchemaMigration } from '@substrate-ai/core'
import type { DatabaseAdapter } from '@substrate-ai/core'

const migration_1_to_2: SchemaMigration = {
  fromVersion: 1,
  toVersion: 2,
  description: 'Add retries column to tasks table',
  async up(adapter: DatabaseAdapter): Promise<void> {
    await adapter.exec(`ALTER TABLE tasks ADD COLUMN retries INTEGER NOT NULL DEFAULT 0`)
  },
}
```

Pass the list to your `MigrationRunner` implementation along with the target version:

```typescript
await runMigrations(adapter, [migration_1_to_2], CORE_SCHEMA_NAME, 2)
```

The runner is responsible for:
1. Querying the current version via `SchemaVersionManager.getCurrentVersion`
2. Filtering migrations whose `fromVersion >= currentVersion && toVersion <= targetVersion`
3. Executing `up()` in ascending `fromVersion` order
4. Updating the stored version via `SchemaVersionManager.setVersion` after each successful step

---

## 3. Independent Schema Tracking

Two schema names are defined in `schema-version.ts`:

| Constant              | Value       | Owner                 |
|-----------------------|-------------|-----------------------|
| `CORE_SCHEMA_NAME`    | `'core'`    | `packages/core` / monolith |
| `FACTORY_SCHEMA_NAME` | `'factory'` | `packages/factory` (Epic 44+) |

Each schema name has its own row in the `schema_version` table:

```sql
SELECT * FROM schema_version;
-- schema_name | version | applied_at
-- core        | 3       | 2026-03-22T10:00:00.000Z
-- factory     | 1       | 2026-03-22T10:01:00.000Z
```

A migration to the **factory** schema increments only the `factory` version row. It does **not** change the `core` version row. The two schemas evolve independently.

---

## 4. Backward Compatibility Rules

### Additive changes — use `action: 'migrate'`

The `'migrate'` path is for **strictly additive** changes only:

- ✅ Add a new column with a default value: `ALTER TABLE foo ADD COLUMN bar TEXT DEFAULT ''`
- ✅ Create a new table: `CREATE TABLE IF NOT EXISTS new_table (...)`
- ✅ Add a new index
- ✅ Add a new view

### Breaking changes — use `action: 'incompatible'`

Some changes are inherently incompatible with older stored data:

- ❌ `DROP COLUMN` — **never** drop a column in a `SchemaMigration.up` function
- ❌ `DROP TABLE`
- ❌ Rename a column or table
- ❌ Change a column's type in a way that truncates data

For breaking changes, record `action: 'incompatible'` in the `SchemaVersionCheckResult` and require a manual migration path (backup + restore from scratch, or a dedicated out-of-band script).

---

## 5. Rollback Procedure

**Automatic downgrades are not supported.** There is no `down()` migration function.

To roll back to a previous schema version:

1. **Before applying migrations**, take a full database backup:
   ```bash
   cp substrate.db substrate.db.bak-v$(date +%Y%m%d%H%M%S)
   # or, for Dolt:
   dolt backup sync <remote>
   ```
2. Run the migration.
3. If the migration fails or produces incorrect results, restore from the backup:
   ```bash
   cp substrate.db.bak-<timestamp> substrate.db
   ```
4. Fix the migration and try again.

Downgrades by reversing `up()` operations are fragile and error-prone. Always rely on a verified backup.
