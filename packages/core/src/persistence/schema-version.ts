/**
 * Schema version management contract for @substrate-ai/core.
 *
 * This module defines the versioning contract — interfaces, type aliases,
 * constants, and the `checkSchemaVersion` runtime function. It does NOT
 * contain schema DDL for application tables (those live in schema.ts).
 *
 * The concrete `SchemaVersionManagerImpl` is added in Epic 41 (story 41-3).
 * Factory schema versioning (Epic 44) uses `FACTORY_SCHEMA_NAME` defined here.
 */

import type { DatabaseAdapter } from './types.js'

// ---------------------------------------------------------------------------
// Schema name constants
// ---------------------------------------------------------------------------

/** Canonical schema name for the core (monolith) persistence schema. */
export const CORE_SCHEMA_NAME = 'core' as const

/** Canonical schema name for the factory persistence schema (Epic 44+). */
export const FACTORY_SCHEMA_NAME = 'factory' as const

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * Canonical DDL for the `schema_version` table.
 * Epic 41 will call this as part of `initSchema`.
 */
export const SCHEMA_VERSION_DDL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    schema_name TEXT    NOT NULL,
    version     INTEGER NOT NULL,
    applied_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (schema_name)
  )
` as const

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** A single row in the `schema_version` table. */
export interface SchemaVersionRecord {
  schema_name: string
  version: number
  applied_at: string
}

/**
 * Result returned by `checkSchemaVersion`.
 *
 * - `action: 'ok'`           — stored version matches expected; no action needed
 * - `action: 'migrate'`      — stored version is less than expected; run migrations
 * - `action: 'incompatible'` — stored version is null (table empty) or greater
 *                              than expected; manual intervention required
 */
export interface SchemaVersionCheckResult {
  compatible: boolean
  storedVersion: number | null
  expectedVersion: number
  action: 'ok' | 'migrate' | 'incompatible'
}

/**
 * Interface for the schema version manager.
 * The concrete implementation (`SchemaVersionManagerImpl`) is added in Epic 41.
 */
export interface SchemaVersionManager {
  /** Ensure the `schema_version` table exists (idempotent). */
  ensureVersionTable(adapter: DatabaseAdapter): Promise<void>

  /**
   * Return the currently stored version for `schemaName`, or `null` if no
   * row exists for that schema.
   */
  getCurrentVersion(adapter: DatabaseAdapter, schemaName: string): Promise<number | null>

  /** Upsert the version row for `schemaName`. */
  setVersion(adapter: DatabaseAdapter, schemaName: string, version: number): Promise<void>
}

// ---------------------------------------------------------------------------
// Migration types
// ---------------------------------------------------------------------------

/**
 * A single schema migration step.
 * Migrations must be strictly additive on the `'migrate'` path (new columns
 * with defaults, new tables). Destructive changes require `'incompatible'`.
 */
export interface SchemaMigration {
  fromVersion: number
  toVersion: number
  description: string
  up: (adapter: DatabaseAdapter) => Promise<void>
}

/**
 * Function type alias for the migration orchestration entry point.
 * Implementations are responsible for ordering migrations by `fromVersion`,
 * executing them in sequence, and updating the version row after each step.
 */
export type MigrationRunner = (
  adapter: DatabaseAdapter,
  migrations: SchemaMigration[],
  schemaName: string,
  targetVersion: number
) => Promise<void>

// ---------------------------------------------------------------------------
// Runtime helper
// ---------------------------------------------------------------------------

/**
 * Check whether the stored schema version for `schemaName` is compatible with
 * `expectedVersion`.
 *
 * Queries the `schema_version` table directly via `adapter`.  Callers must
 * ensure the table exists before calling this function (use
 * `SchemaVersionManager.ensureVersionTable` or include `SCHEMA_VERSION_DDL`
 * in `initSchema`).
 *
 * Decision logic:
 *   - `storedVersion === expectedVersion`  → `{ action: 'ok', compatible: true }`
 *   - `storedVersion < expectedVersion`    → `{ action: 'migrate', compatible: false }`
 *   - `storedVersion > expectedVersion`    → `{ action: 'incompatible', compatible: false }`
 *   - no row for `schemaName`              → `{ action: 'incompatible', compatible: false }`
 */
export async function checkSchemaVersion(
  adapter: DatabaseAdapter,
  schemaName: string,
  expectedVersion: number
): Promise<SchemaVersionCheckResult> {
  const rows = await adapter.query<SchemaVersionRecord>(
    'SELECT schema_name, version, applied_at FROM schema_version WHERE schema_name = ?',
    [schemaName]
  )

  const firstRow = rows.length > 0 ? rows[0] : undefined
  const storedVersion: number | null = firstRow !== undefined ? firstRow.version : null

  if (storedVersion === null) {
    return { compatible: false, storedVersion: null, expectedVersion, action: 'incompatible' }
  }

  if (storedVersion === expectedVersion) {
    return { compatible: true, storedVersion, expectedVersion, action: 'ok' }
  }

  if (storedVersion < expectedVersion) {
    return { compatible: false, storedVersion, expectedVersion, action: 'migrate' }
  }

  // storedVersion > expectedVersion
  return { compatible: false, storedVersion, expectedVersion, action: 'incompatible' }
}
