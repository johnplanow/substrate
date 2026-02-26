/**
 * Migration 009: Token Usage Metadata Column
 *
 * Adds a `metadata` TEXT column to the `token_usage` table to support storing
 * batch context (batchIndex, storyKey, etc.) as a JSON string alongside each
 * token usage record.
 *
 * SQLite supports ADD COLUMN when the column has no NOT NULL constraint and no
 * default other than NULL, so no table-recreation is needed here.
 */

import type { Migration } from './index.js'

export const migration009TokenUsageMetadata: Migration = {
  version: 9,
  name: '009-token-usage-metadata',

  up(db) {
    // Add nullable metadata column — safe as an ADD COLUMN in SQLite
    db.exec(`
      ALTER TABLE token_usage ADD COLUMN metadata TEXT;
    `)
  },
}
