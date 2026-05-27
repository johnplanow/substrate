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
import { createDatabaseAdapter } from '../../../persistence/adapter.js'
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
 * Dolt-backed guard (obs_031, post-review hardening). IMPORTANT: the InMemory
 * adapter above does NOT validate column references — it silently matched zero
 * rows for the old `... AND run_id=?` statement rather than throwing. The bug
 * was Dolt-specific (`DoltQueryError: column "run_id" could not be found`), so
 * the genuine "column drift fails CI" guard the obs asked for requires running
 * against real Dolt. This block runs in CI (DOLT_INTEGRATION_TEST=1, dolt on
 * PATH per .github/workflows/{ci,publish}.yml); skipped locally by default.
 */
describe('reconcile-from-disk wg_stories UPDATE — real Dolt (obs_031 column-drift guard)', () => {
  const runIntegration = process.env['DOLT_INTEGRATION_TEST'] === '1'

  it.skipIf(!runIntegration)('executes against real Dolt; the dropped run_id predicate would throw', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { DoltClient } = await import('../../../modules/state/dolt-client.js')
    const execFileAsync = promisify(execFile)

    const tmpDir = await mkdtemp('/tmp/dolt-reconcile-test-')
    try {
      await execFileAsync('dolt', ['init'], { cwd: tmpDir })
      const adapter = createDatabaseAdapter({ backend: 'dolt', basePath: tmpDir }, (rp) => new DoltClient({ repoPath: rp }))
      try {
        await initSchema(adapter) // builds the REAL wg_stories schema
        await adapter.query(
          'INSERT INTO wg_stories (story_key, epic, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          ['5-1', '5', 'Story 5-1', 'dispatched', new Date().toISOString(), new Date().toISOString()],
        )

        // The shipped statement executes cleanly and flips the row.
        const now = new Date().toISOString()
        await adapter.query(RECONCILE_WG_STORIES_UPDATE, [now, now, '5-1'])
        const rows = await adapter.query<{ status: string }>('SELECT status FROM wg_stories WHERE story_key = ?', ['5-1'])
        expect(rows[0]?.status).toBe('complete')

        // The pre-fix statement (with the bogus run_id predicate) throws on Dolt —
        // this is the regression that escaped because the old test mocked the adapter.
        await expect(
          adapter.query("UPDATE wg_stories SET status='complete', updated_at=? WHERE story_key=? AND run_id=?", [now, '5-1', 'run']),
        ).rejects.toThrow(/run_id/i)
      } finally {
        await adapter.close?.()
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
