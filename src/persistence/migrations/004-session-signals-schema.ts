/**
 * Migration 004: Session signals table.
 *
 * Adds the session_signals table used by the pause/resume/cancel commands
 * to signal a running orchestrator process via the SQLite database.
 *
 * This implements the DB-based signal queue described in the Dev Notes for
 * Story 5.3 (Pause, Resume & Cancel Commands).
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { Migration } from './index.js'

export const sessionSignalsSchemaMigration: Migration = {
  version: 4,
  name: '004-session-signals-schema',
  up(db: BetterSqlite3Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_signals (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT NOT NULL,
        signal       TEXT NOT NULL CHECK(signal IN ('pause', 'resume', 'cancel')),
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_session_signals_unprocessed
        ON session_signals(session_id, processed_at)
        WHERE processed_at IS NULL;
    `)
  },
}
