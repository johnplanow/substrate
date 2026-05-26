/**
 * EpicIngester — upserts parsed epic data into the Dolt work-graph tables.
 *
 * Story 31-2: Epic Doc Ingestion
 *
 * Accepts a `DatabaseAdapter` (see `src/persistence/adapter.ts`) so that the
 * same code runs against Dolt in production and InMemoryDatabaseAdapter in tests.
 */

import type { DatabaseAdapter } from '../../persistence/adapter.js'
import type { ParsedStory, ParsedDependency } from './epic-parser.js'
import { detectCycles } from './cycle-detector.js'
import { CyclicDependencyError } from './errors.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestResult {
  /** Number of story rows inserted or updated */
  storiesUpserted: number
  /** Number of dependency rows replaced (delete + re-insert count) */
  dependenciesReplaced: number
}

// ---------------------------------------------------------------------------
// EpicIngester
// ---------------------------------------------------------------------------

export class EpicIngester {
  private readonly adapter: DatabaseAdapter

  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter
  }

  /**
   * Upsert stories and sync dependencies into the database.
   *
   * Both operations are wrapped in a single transaction: if either fails the
   * entire batch is rolled back.
   *
   * @param stories      - Parsed story metadata from `EpicParser.parseStories()`.
   * @param dependencies - Parsed dependency edges from `EpicParser.parseDependencies()`.
   * @returns `IngestResult` with counts of affected rows.
   */
  async ingest(stories: ParsedStory[], dependencies: ParsedDependency[]): Promise<IngestResult> {
    // Fail-fast cycle check BEFORE opening a transaction — ensures zero DB
    // side-effects when cycles are present (AC6).
    const cycle = detectCycles(dependencies)
    if (cycle !== null) {
      throw new CyclicDependencyError(cycle)
    }

    return this.adapter.transaction(async (tx) => {
      let storiesUpserted = 0

      // ------------------------------------------------------------------
      // Upsert stories into wg_stories — must be idempotent AND adapter-portable.
      //
      // CRITICAL (Story 77-6 prep, 2026-05-25): the previous read-then-write
      // pattern (SELECT existing → branch UPDATE/INSERT) is broken under the
      // Dolt CLI-mode adapter, where `transact()` COLLECTS statements and a
      // mid-transaction SELECT always returns [] (documented in dolt-client.ts).
      // So the existence check always missed and re-ingesting an epic whose
      // stories already exist died on `duplicate primary key`. It only worked in
      // tests because InMemoryDatabaseAdapter runs transactions live. Fix: two
      // UNCONDITIONAL statements, no JS branch on a read —
      //   1. INSERT IGNORE — creates new stories at status='planned'; existing
      //      rows are silently skipped, so their status is PRESERVED.
      //   2. UPDATE title — refreshes title/updated_at on all; never touches
      //      status. (Both INSERT IGNORE and UPDATE are supported by Dolt AND
      //      InMemoryDatabaseAdapter, and both work in CLI batch mode.)
      // ------------------------------------------------------------------

      for (const story of stories) {
        const now = new Date().toISOString()
        await tx.query(
          'INSERT IGNORE INTO wg_stories (story_key, epic, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          [story.story_key, String(story.epic_num), story.title, 'planned', now, now],
        )
        await tx.query(
          'UPDATE wg_stories SET title = ?, updated_at = ? WHERE story_key = ?',
          [story.title, now, story.story_key],
        )
        storiesUpserted++
      }

      // ------------------------------------------------------------------
      // Sync dependencies
      //
      // Delete all existing 'explicit' dependency rows for this epic, then
      // bulk-insert the fresh batch.
      // ------------------------------------------------------------------

      const epicNum = stories.length > 0 ? stories[0]!.epic_num : null

      if (epicNum !== null) {
        await tx.query(
          `DELETE FROM story_dependencies WHERE source = 'explicit' AND story_key LIKE ?`,
          [`${epicNum}-%`],
        )
      }

      // Bulk-insert the fresh dependency batch
      for (const dep of dependencies) {
        await tx.query(
          'INSERT INTO story_dependencies (story_key, depends_on, dependency_type, source) VALUES (?, ?, ?, ?)',
          [dep.story_key, dep.depends_on, dep.dependency_type, dep.source],
        )
      }

      return {
        storiesUpserted,
        dependenciesReplaced: dependencies.length,
      }
    })
  }
}
