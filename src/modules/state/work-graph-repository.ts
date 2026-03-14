/**
 * WorkGraphRepository — CRUD operations for the work-graph tables.
 *
 * Operates against `wg_stories` and `story_dependencies` tables using a
 * DatabaseAdapter.  Intentionally avoids querying the `ready_stories` VIEW
 * so that the InMemoryDatabaseAdapter (which has no VIEW support) works
 * correctly in unit tests.
 */

import type { DatabaseAdapter } from '../../persistence/adapter.js'
import type { WgStory, WgStoryStatus, StoryDependency } from './types.js'
import { detectCycles } from '../work-graph/cycle-detector.js'

export interface BlockedStoryInfo {
  story: WgStory
  blockers: Array<{ key: string; title: string; status: WgStoryStatus }>
}

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
      `INSERT INTO story_dependencies (story_key, depends_on, dependency_type, source, created_at) VALUES (?, ?, ?, ?, ?)`,
      [dep.story_key, dep.depends_on, dep.dependency_type, dep.source, dep.created_at ?? null]
    )
  }

  // -------------------------------------------------------------------------
  // addContractDependencies
  // -------------------------------------------------------------------------

  /**
   * Persist contract-based dependency edges to `story_dependencies` as
   * best-effort, idempotent writes.
   *
   * - edges where `reason` does NOT start with `'dual export:'` are persisted
   *   as `dependency_type = 'blocks'` (hard prerequisites).
   * - edges where `reason` starts with `'dual export:'` are persisted as
   *   `dependency_type = 'informs'` (serialization hints, not hard gates).
   *
   * Idempotency is delegated to `addDependency()`, which skips the INSERT if
   * a row with the same `(story_key, depends_on)` already exists.
   *
   * @param edges - Readonly list of contract dependency edges to persist.
   */
  async addContractDependencies(
    edges: ReadonlyArray<{ from: string; to: string; reason?: string }>,
  ): Promise<void> {
    if (edges.length === 0) return

    for (const edge of edges) {
      const dependency_type: 'blocks' | 'informs' = edge.reason?.startsWith('dual export:')
        ? 'informs'
        : 'blocks'
      await this.addDependency({
        story_key: edge.to,
        depends_on: edge.from,
        dependency_type,
        source: 'contract',
        created_at: new Date().toISOString(),
      })
    }
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
  // updateStoryStatus
  // -------------------------------------------------------------------------

  /**
   * Update the `status` (and optionally `completed_at`) of an existing
   * work-graph story.
   *
   * This is a read-modify-write operation: SELECT existing row → build
   * updated WgStory → upsertStory(). If no row exists for `storyKey` the
   * call is a no-op (AC4).
   *
   * @param storyKey - Story identifier, e.g. "31-4"
   * @param status   - Target WgStoryStatus value
   * @param opts     - Optional `completedAt` ISO string for terminal phases
   */
  async updateStoryStatus(
    storyKey: string,
    status: WgStoryStatus,
    opts?: { completedAt?: string },
  ): Promise<void> {
    const rows = await this.db.query<WgStory>(
      `SELECT * FROM wg_stories WHERE story_key = ?`,
      [storyKey],
    )
    if (rows.length === 0) return // no-op: story not in wg_stories

    const existing = rows[0]!
    const now = new Date().toISOString()
    const isTerminal = status === 'complete' || status === 'escalated'

    const updated: WgStory = {
      ...existing,
      status,
      updated_at: now,
      completed_at: isTerminal
        ? (opts?.completedAt ?? now)
        : existing.completed_at,
    }

    await this.upsertStory(updated)
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
      `SELECT story_key, depends_on FROM story_dependencies WHERE dependency_type = 'blocks'`
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

  // -------------------------------------------------------------------------
  // getBlockedStories
  // -------------------------------------------------------------------------

  /**
   * Return stories that are planned/ready but cannot be dispatched because
   * at least one hard-blocking ('blocks') dependency is not yet complete.
   *
   * For each blocked story, the returned object includes the full WgStory
   * record plus the list of unsatisfied blockers (key, title, status).
   *
   * Soft ('informs') dependencies are ignored here, matching getReadyStories().
   */
  // -------------------------------------------------------------------------
  // detectCycles
  // -------------------------------------------------------------------------

  /**
   * Query the database for all 'blocks' dependency rows and run DFS cycle
   * detection over them.
   *
   * Returns an empty array if no cycle is found (consistent with other
   * repository methods that return empty arrays rather than null).
   *
   * Only 'blocks' deps are checked — soft 'informs' deps cannot cause
   * dispatch deadlocks (AC5).
   */
  async detectCycles(): Promise<string[]> {
    const rows = await this.db.query<{ story_key: string; depends_on: string }>(
      `SELECT story_key, depends_on FROM story_dependencies WHERE dependency_type = 'blocks'`,
    )
    const cycle = detectCycles(rows)
    return cycle ?? []
  }

  async getBlockedStories(): Promise<BlockedStoryInfo[]> {
    const allStories = await this.db.query<WgStory>(`SELECT * FROM wg_stories`)
    const candidates = allStories.filter((s) => s.status === 'planned' || s.status === 'ready')
    if (candidates.length === 0) return []

    const deps = await this.db.query<{ story_key: string; depends_on: string }>(
      `SELECT story_key, depends_on FROM story_dependencies WHERE dependency_type = 'blocks'`
    )
    if (deps.length === 0) return []

    const statusMap = new Map(allStories.map((s) => [s.story_key, s]))

    const depsMap = new Map<string, string[]>()
    for (const d of deps) {
      if (!depsMap.has(d.story_key)) depsMap.set(d.story_key, [])
      depsMap.get(d.story_key)!.push(d.depends_on)
    }

    const result: BlockedStoryInfo[] = []
    for (const story of candidates) {
      const blockerKeys = depsMap.get(story.story_key) ?? []
      const unsatisfied = blockerKeys
        .filter((key) => statusMap.get(key)?.status !== 'complete')
        .map((key) => {
          const s = statusMap.get(key)
          return { key, title: s?.title ?? key, status: (s?.status ?? 'unknown') as WgStoryStatus }
        })
      if (unsatisfied.length > 0) {
        result.push({ story, blockers: unsatisfied })
      }
    }
    return result
  }
}
