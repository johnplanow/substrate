/**
 * Migration runner for the SQLite persistence layer.
 *
 * Responsibilities:
 *  - Ensure the `schema_migrations` table exists
 *  - Track which migrations have already been applied
 *  - Apply pending migrations in version order (idempotent)
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { createLogger } from '../../utils/logger.js'
import { initialSchemaMigration } from './001-initial-schema.js'
import { costTrackerSchemaMigration } from './002-cost-tracker-schema.js'
import { budgetEnforcerSchemaMigration } from './003-budget-enforcer-schema.js'
import { sessionSignalsSchemaMigration } from './004-session-signals-schema.js'
import { migration005PlansTable } from './005-plans-table.js'
import { migration006PlanVersions } from './006-plan-versions.js'

const logger = createLogger('persistence:migrations')

// ---------------------------------------------------------------------------
// Migration interface
// ---------------------------------------------------------------------------

export interface Migration {
  /** Unique version number (integer) */
  version: number
  /** Human-readable name for the migration */
  name: string
  /** Execute the migration — must be idempotent */
  up(db: BetterSqlite3Database): void
}

// ---------------------------------------------------------------------------
// Registered migrations — add new migrations here in version order
// ---------------------------------------------------------------------------

const MIGRATIONS: Migration[] = [initialSchemaMigration, costTrackerSchemaMigration, budgetEnforcerSchemaMigration, sessionSignalsSchemaMigration, migration005PlansTable, migration006PlanVersions]

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Ensure `schema_migrations` table exists and run any pending migrations.
 * Safe to call multiple times — already-applied migrations are skipped.
 */
export function runMigrations(db: BetterSqlite3Database): void {
  logger.info('Starting migration runner')

  // Create the tracking table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      name      TEXT    NOT NULL,
      applied_at TEXT   NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // Determine which versions have already been applied
  const appliedVersions = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (row) => row.version,
    ),
  )

  // Apply pending migrations in version order
  const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version)).sort(
    (a, b) => a.version - b.version,
  )

  if (pending.length === 0) {
    logger.info('No pending migrations')
    return
  }

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
  )

  for (const migration of pending) {
    logger.info({ version: migration.version, name: migration.name }, 'Applying migration')

    // Run the migration and record it atomically
    const applyMigration = db.transaction(() => {
      migration.up(db)
      insertMigration.run(migration.version, migration.name)
    })

    applyMigration()

    logger.info({ version: migration.version }, 'Migration applied successfully')
  }

  logger.info({ count: pending.length }, 'All pending migrations applied')
}
