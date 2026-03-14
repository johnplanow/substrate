/**
 * WorkGraphRepository — CRUD operations for the work-graph tables.
 *
 * Operates against `wg_stories` and `story_dependencies` tables using a
 * DatabaseAdapter.  Intentionally avoids querying the `ready_stories` VIEW
 * so that the InMemoryDatabaseAdapter (which has no VIEW support) works
 * correctly in unit tests.
 */

import type { DatabaseAdapter } from '../../persistence/adapter.js'
import type { WgStory, StoryDependency } from './types.js'

export class WorkGraphRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  // -------------------------------------------------------------------------
  // upsertStory
  // -------------------------------------------------------------------------

  /**
   * Insert or replace a work-graph story node.
   * Uses DELETE + INSERT so it works on InMemoryDatabaseAdapter (which does
   * not support ON DUPLICATE KEY UPDATE).
   */
  async upsertStory(story: WgStory): Promise<void> {
    await this.db.query(`DELETE FROM wg_stories WHERE story_key = ?`, [story.story_key])
    await this.db.query(
      `INSERT INTO wg_stories (story_key, epic, title, status, spec_path, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        story.story_key,
        story.epic,
        story.title ?? null,
        story.status,
        story.spec_path ?? null,
        story.created_at ?? null,
        story.updated_at ?? null,
        story.completed_at ?? null,
      ]
    )
  }

  // -------------------------------------------------------------------------
  // addDependency
  // -------------------------------------------------------------------------

  /**
   * Insert a dependency edge.  Idempotent — if a row with the same
   * (story_key, depends_on) already exists it is silently skipped.
   */
  async addDependency(dep: StoryDependency): Promise<void> {
    // Check first so InMemoryDatabaseAdapter (which doesn't support
    // ON DUPLICATE KEY UPDATE or INSERT IGNORE PK detection) also works.
    const existing = await this.db.query<{ story_key: string }>(
      `SELECT story_key FROM story_dependencies WHERE story_key = ? AND depends_on = ?`,
      [dep.story_key, dep.depends_on]
    )
    if (existing.length > 0) return
    await this.db.query(
      `INSERT INTO story_dependencies (story_key, depends_on, dep_type, source, created_at) VALUES (?, ?, ?, ?, ?)`,
      [dep.story_key, dep.depends_on, dep.dep_type, dep.source, dep.created_at ?? null]
    )
  }

  // -------------------------------------------------------------------------
  // listStories
  // -------------------------------------------------------------------------

  /**
   * Return all work-graph stories, optionally filtered by epic and/or status.
   */
  async listStories(filter?: { epic?: string; status?: string }): Promise<WgStory[]> {
    if (!filter || (!filter.epic && !filter.status)) {
      return this.db.query<WgStory>(`SELECT * FROM wg_stories`)
    }

    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.epic) {
      conditions.push(`epic = ?`)
      params.push(filter.epic)
    }
    if (filter.status) {
      conditions.push(`status = ?`)
      params.push(filter.status)
    }

    const where = conditions.join(' AND ')
    return this.db.query<WgStory>(`SELECT * FROM wg_stories WHERE ${where}`, params)
  }

  // -------------------------------------------------------------------------
  // getReadyStories
  // -------------------------------------------------------------------------

  /**
   * Return stories that are eligible for dispatch.
   *
   * A story is ready when:
   *   1. Its status is 'planned' or 'ready', AND
   *   2. It has no 'blocks' dependency whose blocking story is not 'complete'.
   *
   * Soft ('informs') dependencies never block dispatch.
   *
   * This is implemented programmatically rather than via the `ready_stories`
   * VIEW so that the InMemoryDatabaseAdapter can handle it without VIEW support.
   */
  async getReadyStories(): Promise<WgStory[]> {
    // Fetch all stories and filter in JS (avoids IN clause not supported by
    // InMemoryDatabaseAdapter's WHERE parser).
    const allStories = await this.db.query<WgStory>(`SELECT * FROM wg_stories`)
    const candidates = allStories.filter((s) => s.status === 'planned' || s.status === 'ready')
    if (candidates.length === 0) return []

    // Fetch all hard-blocking deps for all stories
    const deps = await this.db.query<{ story_key: string; depends_on: string }>(
      `SELECT story_key, depends_on FROM story_dependencies WHERE dep_type = 'blocks'`
    )
    if (deps.length === 0) return candidates

    // Build blockerStatus map from all stories (avoids IN clause)
    const blockerStatus = new Map(allStories.map((s) => [s.story_key, s.status]))

    // Build a map from story_key → list of blocker story_keys
    const depsMap = new Map<string, string[]>()
    for (const d of deps) {
      if (!depsMap.has(d.story_key)) depsMap.set(d.story_key, [])
      depsMap.get(d.story_key)!.push(d.depends_on)
    }

    return candidates.filter((s) => {
      const blocking = depsMap.get(s.story_key) ?? []
      return blocking.every((dep) => blockerStatus.get(dep) === 'complete')
    })
  }
}
