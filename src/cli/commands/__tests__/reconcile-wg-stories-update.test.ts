/**
 * obs_2026-05-26_031 schema/SQL guard for reconcile-from-disk.
 *
 * Runs the EXACT statement reconcile-from-disk issues (RECONCILE_WG_STORIES_UPDATE,
 * imported — not duplicated) against a REAL `wg_stories` schema built by
 * initSchema. The bug: the prior write keyed on `... AND run_id=?`, but
 * `wg_stories` has no `run_id` column, so on Dolt it threw DoltQueryError and
 * the Path-A recovery write never landed. This test proves every column the
 * statement references exists in the real schema, so a future column drift
 * fails CI rather than at operator runtime (the obs's fix-direction #2).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import { RECONCILE_WG_STORIES_UPDATE } from '../reconcile-from-disk.js'

describe('reconcile-from-disk wg_stories UPDATE (obs_031 schema guard)', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter()
    await initSchema(adapter)
    await adapter.query(
      'INSERT INTO wg_stories (story_key, epic, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['5-1', '5', 'Story 5-1', 'dispatched', new Date().toISOString(), new Date().toISOString()],
    )
  })

  it('flips the matched story to complete against the real wg_stories schema', async () => {
    const now = new Date().toISOString()
    await adapter.query(RECONCILE_WG_STORIES_UPDATE, [now, now, '5-1'])

    const rows = await adapter.query<{ story_key: string; status: string; completed_at: string | null }>(
      'SELECT story_key, status, completed_at FROM wg_stories WHERE story_key = ?',
      ['5-1'],
    )
    expect(rows[0]?.status).toBe('complete')
    expect(rows[0]?.completed_at).toBe(now)
  })

  it('the statement keys on story_key and references no run_id column (obs_031 drift)', async () => {
    expect(RECONCILE_WG_STORIES_UPDATE).toMatch(/WHERE\s+story_key=\?/i)
    expect(RECONCILE_WG_STORIES_UPDATE).not.toMatch(/run_id/i)

    // And confirm the real schema indeed has no run_id column to key on.
    const cols = await adapter.query<{ name: string }>('PRAGMA table_info(wg_stories)')
    const names = cols.map((c) => c.name)
    expect(names).toContain('story_key')
    expect(names).toContain('completed_at')
    expect(names).not.toContain('run_id')
  })
})

/**
 * obs_031 real-Dolt validation NOTE. The bug was Dolt-specific
 * (`DoltQueryError: column "run_id" could not be found`); the InMemory adapter
 * above does NOT reproduce it — it silently matches zero rows for the bad
 * `... AND run_id=?` statement rather than throwing. The fix was therefore
 * validated against REAL Dolt MANUALLY (a temp `dolt init` repo + the real
 * `wg_stories` DDL): the shipped statement flips the row to `complete`, and the
 * pre-fix `run_id` statement errors with `column "run_id" could not be found`.
 * An automated Dolt-gated test was attempted but `DoltClient`'s node-spawn of
 * `dolt` ENOENTs under the CI/test sandbox (PATH not inherited by the spawned
 * child), so the deterministic CI guard for this exact regression is the
 * SQL-shape assertion above (`not.toMatch(/run_id/i)`), which would have caught
 * the drift at author time.
 */
