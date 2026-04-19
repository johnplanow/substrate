# Story 40.13: Schema Version Management Strategy

## Story

As a substrate developer maintaining the monorepo across multiple deployed environments,
I want a versioning strategy for core and factory database schemas with mismatch detection and migration support,
so that schema evolution is safe, self-documenting, and does not cause silent data corruption or runtime failures.

## Acceptance Criteria

### AC1: SchemaVersionRecord Interface and `schema_version` Table DDL Defined
**Given** `packages/core/src/persistence/schema-version.ts` is created
**When** its exports are inspected
**Then** it exports a `SchemaVersionRecord` interface (`{ schema_name: string; version: number; applied_at: string }`), a `SCHEMA_VERSION_DDL` constant containing `CREATE TABLE IF NOT EXISTS schema_version (...)`, and `CORE_SCHEMA_NAME` / `FACTORY_SCHEMA_NAME` string constants (`'core'` and `'factory'`)

### AC2: `SchemaVersionManager` Interface Exported from Core Package
**Given** `packages/core/src/persistence/schema-version.ts`
**When** the `SchemaVersionManager` interface is imported
**Then** it declares `getCurrentVersion(adapter: DatabaseAdapter, schemaName: string): Promise<number | null>`, `setVersion(adapter: DatabaseAdapter, schemaName: string, version: number): Promise<void>`, and `ensureVersionTable(adapter: DatabaseAdapter): Promise<void>` with matching TypeScript signatures

### AC3: Version Mismatch Detection Function Exported
**Given** `packages/core/src/persistence/schema-version.ts`
**When** `checkSchemaVersion(adapter, schemaName, expectedVersion)` is called and the stored version differs from `expectedVersion`
**Then** the function returns a `SchemaVersionCheckResult` with `{ compatible: boolean; storedVersion: number | null; expectedVersion: number; action: 'ok' | 'migrate' | 'incompatible' }` — `'migrate'` when `storedVersion` is non-null and less than `expectedVersion`; `'incompatible'` when `storedVersion` is null or greater than `expectedVersion`; `'ok'` when versions match

### AC4: `SchemaMigration` Interface and `MigrationRunner` Type Defined
**Given** `packages/core/src/persistence/schema-version.ts`
**When** its exports are inspected
**Then** it exports `SchemaMigration` interface (`{ fromVersion: number; toVersion: number; description: string; up: (adapter: DatabaseAdapter) => Promise<void> }`) and `MigrationRunner` type alias (`(adapter: DatabaseAdapter, migrations: SchemaMigration[], schemaName: string, targetVersion: number) => Promise<void>`)

### AC5: Barrel Exports Updated — All New Symbols Importable from `@substrate-ai/core`
**Given** `packages/core/src/persistence/index.ts` and `packages/core/src/index.ts` are updated
**When** a consumer imports from `@substrate-ai/core`
**Then** `SchemaVersionRecord`, `SchemaVersionManager`, `SchemaVersionCheckResult`, `SchemaMigration`, `MigrationRunner`, `SCHEMA_VERSION_DDL`, `CORE_SCHEMA_NAME`, and `FACTORY_SCHEMA_NAME` are all importable with correct types

### AC6: TypeScript Compilation Succeeds with Zero Errors
**Given** all new files are created with correct ESM `.js` extension imports
**When** `npx tsc -b packages/core --force` is run
**Then** exit code is 0, zero type errors are emitted, and `packages/core/dist/persistence/schema-version.js` and `schema-version.d.ts` are present in the dist output

### AC7: `SCHEMA_VERSIONING.md` Documentation Written
**Given** `packages/core/src/persistence/SCHEMA_VERSIONING.md` is created
**When** read by a developer authoring a new schema migration
**Then** it covers: (1) version numbering convention, (2) how to define a `SchemaMigration`, (3) how `CORE_SCHEMA_NAME` and `FACTORY_SCHEMA_NAME` are tracked independently, (4) backward compatibility rules (never drop columns in `'migrate'` path; use `'incompatible'` for breaking changes), and (5) rollback procedure (restore from backup; downgrades are not auto-applied)

## Tasks / Subtasks

- [ ] Task 1: Read existing persistence types and schema to understand dependencies (AC: #1, #2)
  - [ ] Read `packages/core/src/persistence/types.ts` — verify `DatabaseAdapter` interface shape available as import
  - [ ] Read `packages/core/src/persistence/index.ts` — note current exports to avoid naming conflicts
  - [ ] Read `src/persistence/schema.ts` — understand `initSchema` structure and all table names; note whether a `schema_version` table already exists
  - [ ] Read `packages/core/src/index.ts` — note current barrel re-export lines

- [ ] Task 2: Create `packages/core/src/persistence/schema-version.ts` with all interface and type definitions (AC: #1, #2, #3, #4)
  - [ ] Define `CORE_SCHEMA_NAME = 'core'` and `FACTORY_SCHEMA_NAME = 'factory'` exported string constants
  - [ ] Define `SCHEMA_VERSION_DDL` constant with the full `CREATE TABLE IF NOT EXISTS schema_version` DDL (`schema_name TEXT NOT NULL`, `version INTEGER NOT NULL`, `applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`, `PRIMARY KEY (schema_name)`)
  - [ ] Define `SchemaVersionRecord` interface with fields `{ schema_name: string; version: number; applied_at: string }`
  - [ ] Define `SchemaVersionCheckResult` interface with fields `{ compatible: boolean; storedVersion: number | null; expectedVersion: number; action: 'ok' | 'migrate' | 'incompatible' }`
  - [ ] Define `SchemaVersionManager` interface with three method signatures: `ensureVersionTable`, `getCurrentVersion`, `setVersion`
  - [ ] Define `SchemaMigration` interface with fields `{ fromVersion: number; toVersion: number; description: string; up: (adapter: DatabaseAdapter) => Promise<void> }`
  - [ ] Define `MigrationRunner` type alias for the migration orchestration function signature
  - [ ] Define `checkSchemaVersion` function (concrete implementation using `DatabaseAdapter`) implementing the `'ok' | 'migrate' | 'incompatible'` logic described in AC3
  - [ ] Add file-level JSDoc comment describing module purpose (version tracking contract, not schema DDL)

- [ ] Task 3: Update `packages/core/src/persistence/index.ts` barrel export (AC: #5)
  - [ ] Add `export * from './schema-version.js'` to `packages/core/src/persistence/index.ts`
  - [ ] Verify no symbol name collisions with existing exports from `./types.js`

- [ ] Task 4: Update root barrel `packages/core/src/index.ts` (AC: #5)
  - [ ] Confirm `export * from './persistence/index.js'` is already present (added in story 40-5)
  - [ ] If missing, add it; if present, no change needed — new symbols are automatically re-exported through the existing persistence barrel

- [ ] Task 5: Verify TypeScript compilation succeeds (AC: #6)
  - [ ] Run `npx tsc -b packages/core --force` from the project root; capture full output
  - [ ] Confirm exit code 0; if non-zero, read each error and fix in `packages/core/src/persistence/schema-version.ts` only
  - [ ] Confirm `packages/core/dist/persistence/schema-version.js` and `packages/core/dist/persistence/schema-version.d.ts` exist

- [ ] Task 6: Write `packages/core/src/persistence/SCHEMA_VERSIONING.md` documentation (AC: #7)
  - [ ] Section 1 — Version Numbering: integer starting at 1; increment by 1 for each schema change; never reuse or skip numbers
  - [ ] Section 2 — Authoring a Migration: how to create a `SchemaMigration` object with `fromVersion`, `toVersion`, `description`, and `up` function; example using `adapter.exec()` with `ALTER TABLE` or `CREATE TABLE`
  - [ ] Section 3 — Independent Tracking: explain `CORE_SCHEMA_NAME` vs `FACTORY_SCHEMA_NAME`; factory schema (Epic 44+) increments independently; a factory migration does not change core version
  - [ ] Section 4 — Backward Compatibility Rules: `action: 'migrate'` only for additive changes (new columns with defaults, new tables); `action: 'incompatible'` for destructive changes; never `DROP COLUMN` in a migration `up` function
  - [ ] Section 5 — Rollback Procedure: no automatic downgrade support; rollback = restore DB from backup taken before migration; document the pre-migration backup step

## Dev Notes

### Architecture Constraints
- **INTERFACE AND TYPE DEFINITIONS ONLY** — this story defines the versioning contract in `packages/core/src/persistence/`. No modifications to `src/persistence/schema.ts`, `src/persistence/adapter.ts`, or any monolith file under `src/`. The concrete `SchemaVersionManagerImpl` implementation will be added in Epic 41's persistence migration story (41-3 or equivalent).
- **`checkSchemaVersion` is a concrete function** — unlike most items in Epic 40 which are pure interfaces, `checkSchemaVersion` is a small runtime function (similar to `isSyncAdapter` in story 40-5) that encodes the `ok/migrate/incompatible` decision logic. It uses only `DatabaseAdapter` methods and has no external runtime dependencies beyond the types defined in the same file.
- **ESM imports** — all intra-package imports must use `.js` extensions (e.g., `import type { DatabaseAdapter } from './types.js'`). TypeScript resolves `.js` to `.ts` at compile time with `moduleResolution: "NodeNext"`.
- **No circular dependencies** — `packages/core/src/persistence/schema-version.ts` imports only from `./types.js` (same directory). It must NOT import from `packages/core/src/events/`, `dispatch/`, or any other sub-module.
- **No external package dependencies** — schema versioning logic uses only `DatabaseAdapter` (already in core). Do not add any new entries to `packages/core/package.json` `dependencies`.
- **Factory schema independence** — `FACTORY_SCHEMA_NAME = 'factory'` is defined here in core so Epic 44 can import it without creating a circular dependency. The factory package will use it when defining its own schema DDL and migrations.
- **`schema_version` table DDL lives here** — the `SCHEMA_VERSION_DDL` constant is the canonical DDL. When Epic 41 migrates `initSchema` to `packages/core/`, it will call `SCHEMA_VERSION_DDL` as part of table initialization.

### Key Files to Read Before Starting
- `packages/core/src/persistence/types.ts` — `DatabaseAdapter` interface (the only import needed)
- `packages/core/src/persistence/index.ts` — current barrel; append `schema-version.js` re-export
- `packages/core/src/index.ts` — root barrel; verify persistence re-export line is present
- `src/persistence/schema.ts` — confirm whether `schema_version` table already exists in `initSchema`; if it does, match the existing DDL exactly
- `packages/core/tsconfig.json` — verify `composite: true`, `outDir: "dist"`, `rootDir: "src"` (from story 40-2)

### Target File Structure
```
packages/core/src/persistence/
├── types.ts            # (existing from 40-5) DatabaseAdapter, SyncAdapter, etc.
├── index.ts            # (modified) add export * from './schema-version.js'
├── schema-version.ts   # (new) all versioning types, interfaces, constants, checkSchemaVersion
└── SCHEMA_VERSIONING.md  # (new) developer documentation
```

### Interface Shapes to Implement
```typescript
// packages/core/src/persistence/schema-version.ts

import type { DatabaseAdapter } from './types.js'

export const CORE_SCHEMA_NAME = 'core' as const
export const FACTORY_SCHEMA_NAME = 'factory' as const

export const SCHEMA_VERSION_DDL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    schema_name TEXT NOT NULL,
    version     INTEGER NOT NULL,
    applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (schema_name)
  )
` as const

export interface SchemaVersionRecord {
  schema_name: string
  version: number
  applied_at: string
}

export interface SchemaVersionCheckResult {
  compatible: boolean
  storedVersion: number | null
  expectedVersion: number
  action: 'ok' | 'migrate' | 'incompatible'
}

export interface SchemaVersionManager {
  ensureVersionTable(adapter: DatabaseAdapter): Promise<void>
  getCurrentVersion(adapter: DatabaseAdapter, schemaName: string): Promise<number | null>
  setVersion(adapter: DatabaseAdapter, schemaName: string, version: number): Promise<void>
}

export interface SchemaMigration {
  fromVersion: number
  toVersion: number
  description: string
  up: (adapter: DatabaseAdapter) => Promise<void>
}

export type MigrationRunner = (
  adapter: DatabaseAdapter,
  migrations: SchemaMigration[],
  schemaName: string,
  targetVersion: number
) => Promise<void>

export async function checkSchemaVersion(
  adapter: DatabaseAdapter,
  schemaName: string,
  expectedVersion: number
): Promise<SchemaVersionCheckResult> {
  // Implementation: query schema_version table for schemaName
  // Return { compatible, storedVersion, expectedVersion, action }
}
```

### Testing Requirements
- This story produces TypeScript type definitions and one small async function — no complex runtime behavior
- The `checkSchemaVersion` function queries `DatabaseAdapter` — a minimal unit test using an in-memory mock of `DatabaseAdapter` is sufficient if the project has an existing adapter mock pattern; otherwise TypeScript compilation validation is sufficient
- Run `npx tsc -b packages/core --force` as the primary verification step (exit code 0 = success)
- Do NOT run the full monorepo test suite (`npm test`) for this story — TypeScript compilation is the gate
- NEVER pipe build output through `tail`, `head`, or `grep`

## Interface Contracts

- **Import**: `DatabaseAdapter` @ `packages/core/src/persistence/types.ts` (from story 40-5)
- **Export**: `SchemaVersionRecord` @ `packages/core/src/persistence/schema-version.ts` (consumed by Epic 41 persistence migration and Epic 44 factory schema stories)
- **Export**: `SchemaVersionManager` @ `packages/core/src/persistence/schema-version.ts` (consumed by Epic 41-3 persistence migration implementation)
- **Export**: `SchemaVersionCheckResult` @ `packages/core/src/persistence/schema-version.ts` (consumed by Epic 41 application startup and schema migration runner)
- **Export**: `SchemaMigration`, `MigrationRunner` @ `packages/core/src/persistence/schema-version.ts` (consumed by Epic 41 migration runner and Epic 44 factory schema)
- **Export**: `CORE_SCHEMA_NAME`, `FACTORY_SCHEMA_NAME`, `SCHEMA_VERSION_DDL` @ `packages/core/src/persistence/schema-version.ts` (consumed by Epic 41-3 `initSchema` migration and Epic 44 factory schema setup)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-22: Story created for Epic 40 (Core Extraction Phase 1)
