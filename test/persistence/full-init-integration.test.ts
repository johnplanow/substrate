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
import { fileURLToPath } from 'node:url'
import { DoltClient, DoltDatabaseAdapter, initializeDolt, initSchema } from '@substrate-ai/core'

function doltAvailable(): boolean {
  try {
    const result = spawnSync('dolt', ['version'], { stdio: 'ignore' })
    return result.error == null && result.status === 0
  } catch {
    return false
  }
}

// Resolve the bundled schema.sql relative to this test file. The build copies
// it to `dist/schema.sql`; the source lives at `src/modules/state/schema.sql`.
function resolveSchemaSqlPath(): string {
  const thisFileDir = fileURLToPath(new URL('.', import.meta.url))
  // test/persistence/ → repo root → src/modules/state/schema.sql
  return join(thisFileDir, '..', '..', 'src', 'modules', 'state', 'schema.sql')
}

describe.skipIf(!doltAvailable())('Ship 2: full-init schema regression gate (real Dolt)', () => {
  let tempDir: string
  let client: DoltClient
  let adapter: DoltDatabaseAdapter

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'substrate-ship2-init-'))

    // `initializeDolt` runs `dolt init`, applies schema.sql, and commits.
    const schemaPath = resolveSchemaSqlPath()
    if (!existsSync(schemaPath)) {
      throw new Error(`bundled schema.sql not found at expected path: ${schemaPath}`)
    }

    // initializeDolt configures the global dolt identity if absent. Run it.
    await initializeDolt({ projectRoot: tempDir, schemaPath })

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
    // From schema.sql (init-time DDL)
    '_schema_version',
    'build_results',
    'contracts',
    'dispatch_log',
    'metrics',
    'repo_map_meta',
    'repo_map_symbols',
    'review_verdicts',
    'stories',
    // From schema.sql (telemetry — Epic 27-4, 27-5, 27-7, 30-1, 30-3)
    'category_stats',
    'consumer_stats',
    'efficiency_scores',
    'recommendations',
    'turn_analysis',
    // From schema.sql (work-graph — Epic 31-1)
    'story_dependencies',
    'wg_stories',
    // From initSchema (runtime DDL — orchestrator session/task model)
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

  // The 4 formerly-conflicted tables MUST carry the schema.sql (production-
  // resident) shape — NOT the dolt-store.ts intended shape, which was excised
  // in Ship 1 because the production code path never wrote to these tables.
  // If Ship 3 ports them to a TS module, the port MUST preserve these columns
  // exactly.

  it('stories table has the schema.sql shape (status/ac_results/error_message)', async () => {
    type ColRow = { COLUMN_NAME: string }
    const rows = await adapter.query<ColRow>(
      `SELECT COLUMN_NAME FROM information_schema.columns
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stories'
       ORDER BY COLUMN_NAME`,
    )
    const cols = rows.map((r) => r.COLUMN_NAME).sort()
    expect(cols).toEqual([
      'ac_results',
      'completed_at',
      'created_at',
      'error_message',
      'phase',
      'sprint',
      'status',
      'story_key',
      'updated_at',
    ])
  })

  it('contracts table uses column name "name" (NOT dolt-store.ts\'s "contract_name")', async () => {
    type ColRow = { COLUMN_NAME: string }
    const rows = await adapter.query<ColRow>(
      `SELECT COLUMN_NAME FROM information_schema.columns
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contracts'
       ORDER BY COLUMN_NAME`,
    )
    const cols = rows.map((r) => r.COLUMN_NAME)
    expect(cols).toContain('name')
    expect(cols).not.toContain('contract_name')
  })

  it('metrics table uses composite PK (story_key, task_type, recorded_at) — not AUTO_INCREMENT id', async () => {
    type ColRow = { COLUMN_NAME: string; COLUMN_KEY: string }
    const rows = await adapter.query<ColRow>(
      `SELECT COLUMN_NAME, COLUMN_KEY FROM information_schema.columns
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metrics'
       ORDER BY COLUMN_NAME`,
    )
    const pkCols = rows.filter((r) => r.COLUMN_KEY === 'PRI').map((r) => r.COLUMN_NAME).sort()
    expect(pkCols).toEqual(['recorded_at', 'story_key', 'task_type'])

    // No surrogate id column
    expect(rows.map((r) => r.COLUMN_NAME)).not.toContain('id')
  })

  it('review_verdicts table uses composite PK (story_key, timestamp) — no task_type column', async () => {
    type ColRow = { COLUMN_NAME: string; COLUMN_KEY: string }
    const rows = await adapter.query<ColRow>(
      `SELECT COLUMN_NAME, COLUMN_KEY FROM information_schema.columns
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'review_verdicts'
       ORDER BY COLUMN_NAME`,
    )
    const pkCols = rows.filter((r) => r.COLUMN_KEY === 'PRI').map((r) => r.COLUMN_NAME).sort()
    expect(pkCols).toEqual(['story_key', 'timestamp'])

    const allCols = rows.map((r) => r.COLUMN_NAME)
    expect(allCols).not.toContain('task_type')
    expect(allCols).not.toContain('id')
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

  // The `_schema_version` table is vestigial post-Ship-1 (its INSERT IGNORE
  // rows were removed from dolt-store.ts) but the table itself remains for
  // backward-compat with existing repos. Ship 7 will decide its fate.
  it('_schema_version table is present (vestigial, scheduled for Ship 7)', async () => {
    type CountRow = { c: number }
    const rows = await adapter.query<CountRow>(
      `SELECT COUNT(*) AS c FROM information_schema.tables
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_schema_version' AND TABLE_TYPE = 'BASE TABLE'`,
    )
    expect(rows[0]?.c).toBe(1)
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
    expect(plain).toMatch(/Initialize substrate state schema|Initialize data repository/i)
  })
})
