// @vitest-environment node
/**
 * Ship 2 (schema-unification arc, 2026-05): Layer 2 regression gate.
 *
 * Asserts that the full production init path produces the exact schema set
 * we depend on — combining:
 *   1. `initializeDolt()` applying the bundled `schema.sql` (init-time DDL)
 *   2. `initSchema()` applying runtime DDL on top
 *
 * Locks in the current schema as the migration target BEFORE Ships 3-5 move
 * DDL into TS modules. Any port that drops, renames, or shape-changes a
 * table without updating the golden set MUST fail this test.
 *
 * Skips automatically when the Dolt binary is not on PATH. This is the only
 * test in the suite that spawns real `dolt` — keep it that way until Ship 3
 * decides whether the DoltStateStore-CRUD layer is reborn.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { DoltClient, DoltDatabaseAdapter, initializeDolt, initSchema } from '@substrate-ai/core'

function doltAvailable(): boolean {
  try {
    const result = spawnSync('dolt', ['version'], { stdio: 'ignore' })
    return result.error == null && result.status === 0
  } catch {
    return false
  }
}

describe.skipIf(!doltAvailable())('Ship 2: full-init schema regression gate (real Dolt)', () => {
  let tempDir: string
  let client: DoltClient
  let adapter: DoltDatabaseAdapter

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'substrate-ship2-init-'))

    // `initializeDolt` creates an empty Dolt repo with an initial commit.
    // Post-Ship-3 (2026-05): no DDL is applied at init — `initSchema` below
    // is the sole runtime contract.
    await initializeDolt({ projectRoot: tempDir })

    // The Dolt repo now lives at <tempDir>/.substrate/state/.dolt/
    const statePath = join(tempDir, '.substrate', 'state')

    // Force CLI mode by pointing the socket at a nonexistent path. This is
    // deterministic for tests (avoids socket-race flakes) and matches what
    // CI's no-pool environment uses.
    client = new DoltClient({ repoPath: statePath, socketPath: '/nonexistent/socket.sock' })
    adapter = new DoltDatabaseAdapter(client)

    // Apply the runtime DDL on top.
    await initSchema(adapter)
  }, 60_000)

  afterAll(async () => {
    try {
      await adapter?.close()
    } catch {
      // ignore close errors
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  // ---------------------------------------------------------------------------
  // Golden table set — the union of schema.sql + initSchema-managed tables.
  //
  // Ships 3-5 will move DDL ownership between schema.sql / initSchema / future
  // *-schema.ts modules. The MIGRATION TARGET is "no table dropped, no column
  // changed without an explicit migration." If your port removes a table from
  // this list, that's the bug — update it AS PART OF the same commit and
  // document why in the message.
  // ---------------------------------------------------------------------------

  const EXPECTED_TABLES = [
    // From repo-map-schema.ts (Epic 28-2)
    'repo_map_meta',
    'repo_map_symbols',
    // From telemetry-schema.ts (Epic 27-4, 27-5, 27-7, 30-1, 30-3)
    'category_stats',
    'consumer_stats',
    'efficiency_scores',
    'recommendations',
    'turn_analysis',
    // From work-graph-schema.ts (Epic 31-1)
    'story_dependencies',
    'wg_stories',
    // From core-schema.ts + pipeline-schema.ts + monitor-schema.ts (runtime
    // orchestrator session/task model + pipeline state + monitor metrics)
    'artifacts',
    'constraints',
    'cost_entries',
    'decisions',
    'execution_log',
    'performance_aggregates',
    'pipeline_runs',
    'plan_versions',
    'plans',
    'requirements',
    'routing_recommendations',
    'run_metrics',
    'schema_migrations',
    'session_signals',
    'sessions',
    'story_metrics',
    'task_dependencies',
    'task_metrics',
    'tasks',
    'token_usage',
  ] as const

  // Tables that USED to be created (pre-Ship-8) and must now be absent on a
  // fresh init. Ship 8 (v0.20.99) deleted the six legacy state tables that
  // were empty in every audited production project (orchestrator wires
  // FileStateStore, not DoltStateStore). `_schema_version` was the seventh,
  // deleted in Ship 7.
  const DELETED_TABLES = [
    '_schema_version',
    'build_results',
    'contracts',
    'dispatch_log',
    'metrics',
    'review_verdicts',
    'stories',
  ] as const

  const EXPECTED_VIEWS = [
    'ready_stories',
    'ready_tasks',
    'session_cost_summary',
  ] as const

  it('produces exactly the expected union of tables (no missing, no surplus)', async () => {
    type TableRow = { TABLE_NAME: string; TABLE_TYPE: string }
    const rows = await adapter.query<TableRow>(
      `SELECT TABLE_NAME, TABLE_TYPE
       FROM information_schema.tables
       WHERE TABLE_SCHEMA = DATABASE()
       ORDER BY TABLE_NAME`,
    )

    const baseTables = rows.filter((r) => r.TABLE_TYPE === 'BASE TABLE').map((r) => r.TABLE_NAME).sort()
    const expected = [...EXPECTED_TABLES].sort()

    expect(baseTables).toEqual(expected)
  })

  it('produces exactly the expected views', async () => {
    type ViewRow = { TABLE_NAME: string }
    const rows = await adapter.query<ViewRow>(
      `SELECT TABLE_NAME
       FROM information_schema.views
       WHERE TABLE_SCHEMA = DATABASE()
       ORDER BY TABLE_NAME`,
    )

    const views = rows.map((r) => r.TABLE_NAME).sort()
    const expected = [...EXPECTED_VIEWS].sort()

    expect(views).toEqual(expected)
  })

  // Ship 8 (v0.20.99) deleted the six legacy state tables (stories, contracts,
  // metrics, dispatch_log, build_results, review_verdicts) — empty in every
  // audited production project. The four shape-pinning tests that used to
  // assert schema.sql-resident column layouts (stories/contracts/metrics/
  // review_verdicts) are replaced by the absence assertion below.
  it.each(DELETED_TABLES)('legacy table %s is absent on fresh init', async (name) => {
    type CountRow = { c: number }
    const rows = await adapter.query<CountRow>(
      `SELECT COUNT(*) AS c FROM information_schema.tables
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${name}' AND TABLE_TYPE = 'BASE TABLE'`,
    )
    expect(rows[0]?.c).toBe(0)
  })

  // The v0.20.91 regression target — these tables and the view were the
  // immediate symptom of the schema-divergence defect that initiated this arc.
  // They MUST be present after a fresh init for the test to pass.

  it('wg_stories table is present (v0.20.91 regression target)', async () => {
    type CountRow = { c: number }
    const rows = await adapter.query<CountRow>(
      `SELECT COUNT(*) AS c FROM information_schema.tables
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wg_stories' AND TABLE_TYPE = 'BASE TABLE'`,
    )
    expect(rows[0]?.c).toBe(1)
  })

  it('story_dependencies table is present (v0.20.91 regression target)', async () => {
    type CountRow = { c: number }
    const rows = await adapter.query<CountRow>(
      `SELECT COUNT(*) AS c FROM information_schema.tables
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'story_dependencies' AND TABLE_TYPE = 'BASE TABLE'`,
    )
    expect(rows[0]?.c).toBe(1)
  })

  it('ready_stories view is present and queryable (v0.20.91 regression target)', async () => {
    // The view's JOIN+aggregation only works on Dolt (InMemory adapter no-ops
    // CREATE VIEW). Smoke-test by querying it — empty result is fine,
    // SQL error means the view definition is broken.
    type Row = { key: string }
    const rows = await adapter.query<Row>('SELECT * FROM ready_stories LIMIT 1')
    expect(Array.isArray(rows)).toBe(true)
  })

  it('story_dependencies.created_at column is present (v0.12.0 migration baked in)', async () => {
    type ColRow = { COLUMN_NAME: string }
    const rows = await adapter.query<ColRow>(
      `SELECT COLUMN_NAME FROM information_schema.columns
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'story_dependencies' AND COLUMN_NAME = 'created_at'`,
    )
    expect(rows).toHaveLength(1)
  })

  it('dolt commit log shows the schema-init commit (init wired the commit)', async () => {
    // Smoke-test that initializeDolt() committed the schema. Failure here
    // means the init path stopped committing — Ships 3+ would lose the
    // ability to fork story branches that include the tables.
    const output = execFileSync('dolt', ['log', '--oneline'], {
      cwd: join(tempDir, '.substrate', 'state'),
      encoding: 'utf-8',
    })
    expect(output.length).toBeGreaterThan(0)
    // Strip ANSI escape codes and assert at least one commit message is present.
    // Dolt uses base32-encoded commit hashes (not hex), so assert on the message
    // text we know `initializeDolt` writes.
    // eslint-disable-next-line no-control-regex
    const plain = output.replace(/\[[0-9;]*m/g, '')
    expect(plain).toMatch(/Initialize substrate state repo|Initialize data repository/i)
  })
})
