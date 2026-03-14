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
      // Upsert stories
      //
      // For each story: check if it already exists.
      //   - If yes: UPDATE title, priority, size, sprint — preserve status.
      //   - If no:  INSERT with status = 'planned'.
      //
      // We use SELECT + conditional UPDATE/INSERT rather than MySQL's
      // ON DUPLICATE KEY UPDATE so that the same code runs correctly under
      // both DoltDatabaseAdapter and InMemoryDatabaseAdapter (the latter does
      // not support ON DUPLICATE KEY UPDATE syntax).
      // ------------------------------------------------------------------

      for (const story of stories) {
        const existing = await tx.query<{ status: string }>(
          'SELECT status FROM stories WHERE story_key = ?',
          [story.story_key],
        )

        if (existing.length > 0) {
          await tx.query(
            'UPDATE stories SET title = ?, priority = ?, size = ?, sprint = ? WHERE story_key = ?',
            [story.title, story.priority, story.size, story.sprint, story.story_key],
          )
        } else {
          await tx.query(
            'INSERT INTO stories (story_key, epic_num, story_num, title, priority, size, sprint, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              story.story_key,
              story.epic_num,
              story.story_num,
              story.title,
              story.priority,
              story.size,
              story.sprint,
              'planned',
            ],
          )
          storiesUpserted++
        }
      }

      // ------------------------------------------------------------------
      // Sync dependencies
      //
      // Delete all existing 'explicit' dependency rows for this epic, then
      // bulk-insert the fresh batch.  This ensures removed dependencies are
      // cleaned up on re-ingestion.
      //
      // The DELETE uses `story_key LIKE '<epicNum>-%'` so that dependencies
      // belonging to OTHER epics are left untouched.
      // ------------------------------------------------------------------

      const epicNum = stories.length > 0 ? stories[0]!.epic_num : null

      if (epicNum !== null) {
        // Delete all explicit deps where the downstream story is in this epic.
        // InMemoryDatabaseAdapter does not support LIKE; it silently treats the
        // LIKE condition as matching (i.e. deletes all 'explicit' rows), which
        // is acceptable in single-epic test fixtures.  DoltDatabaseAdapter
        // (MySQL-wire) evaluates LIKE correctly.
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
