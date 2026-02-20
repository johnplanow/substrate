/**
 * DatabaseService — re-exports the real implementation from src/persistence/database.ts.
 *
 * This file previously contained a stub implementation. Story 2-2 replaced the stub
 * with a full SQLite implementation backed by better-sqlite3. All consumers that
 * import DatabaseService, DatabaseServiceImpl, or createDatabaseService from this
 * module continue to work unchanged.
 */

export type { DatabaseService } from '../../persistence/database.js'
export { DatabaseServiceImpl, createDatabaseService } from '../../persistence/database.js'
