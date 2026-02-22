/**
 * Tests for Migration 008: Amendment Schema
 *
 * Validates:
 * - pipeline_runs table receives parent_run_id column (nullable, self-ref FK)
 * - pipeline_runs status CHECK constraint includes 'stopped'
 * - decisions table receives superseded_by column (nullable, FK with SET NULL)
 * - Indexes on parent_run_id and superseded_by are created
 * - Data preservation across table recreation
 * - FK constraint enforcement for parent_run_id and superseded_by
 * - Idempotency (running migrations twice produces same schema)
 * - Active-decisions query efficiency using superseded_by index
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../src/persistence/migrations/index.js'
import { migration007DecisionStore } from '../../../src/persistence/migrations/007-decision-store.js'
import { migration008AmendmentSchema } from '../../../src/persistence/migrations/008-amendment-schema.js'

function openMemoryDb(): BetterSqlite3Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

/**
 * Apply migrations 1–7 via the full runner, then apply 008 specifically.
 * Returns a db ready to test migration 008 effects.
 */
function setupDb(): BetterSqlite3Database {
  const db = openMemoryDb()
  runMigrations(db)
  return db
}

/**
 * Apply only migrations 007 + 008 without the full runner (for isolated schema tests).
 */
function setupMinimalDb(): BetterSqlite3Database {
  const db = openMemoryDb()

  // Manually create schema_migrations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // Apply migration 007 (creates pipeline_runs + decisions tables)
  migration007DecisionStore.up(db)
  db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
    migration007DecisionStore.version,
    migration007DecisionStore.name,
  )

  // Apply migration 008
  migration008AmendmentSchema.up(db)
  db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
    migration008AmendmentSchema.version,
    migration008AmendmentSchema.name,
  )

  return db
}

// ---------------------------------------------------------------------------
// Helper: get column info for a table
// ---------------------------------------------------------------------------
function getTableColumns(db: BetterSqlite3Database, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

function getIndexNames(db: BetterSqlite3Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

// ---------------------------------------------------------------------------
// AC1: pipeline_runs table receives parent_run_id column
// ---------------------------------------------------------------------------
describe('AC1: pipeline_runs parent_run_id column', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = setupDb()
  })

  afterEach(() => {
    db.close()
  })

  it('adds parent_run_id column to pipeline_runs', () => {
    const columns = getTableColumns(db, 'pipeline_runs')
    expect(columns).toContain('parent_run_id')
  })

  it('parent_run_id is nullable (can insert NULL)', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO pipeline_runs (id, methodology, status) VALUES ('run-1', 'bmad', 'running')`,
      ).run()
    }).not.toThrow()

    const row = db
      .prepare('SELECT parent_run_id FROM pipeline_runs WHERE id = ?')
      .get('run-1') as { parent_run_id: string | null }
    expect(row.parent_run_id).toBeNull()
  })

  it('parent_run_id can reference an existing pipeline_run (self-referencing FK)', () => {
    db.prepare(
      `INSERT INTO pipeline_runs (id, methodology, status) VALUES ('parent-1', 'bmad', 'completed')`,
    ).run()

    expect(() => {
      db.prepare(
        `INSERT INTO pipeline_runs (id, methodology, status, parent_run_id) VALUES ('child-1', 'bmad', 'running', 'parent-1')`,
      ).run()
    }).not.toThrow()

    const row = db
      .prepare('SELECT parent_run_id FROM pipeline_runs WHERE id = ?')
      .get('child-1') as { parent_run_id: string }
    expect(row.parent_run_id).toBe('parent-1')
  })

  it('rejects invalid parent_run_id (FK enforcement)', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO pipeline_runs (id, methodology, status, parent_run_id) VALUES ('orphan-1', 'bmad', 'running', 'nonexistent-id')`,
      ).run()
    }).toThrow()
  })

  it('ON DELETE CASCADE: deleting parent also deletes child amendment runs', () => {
    db.prepare(
      `INSERT INTO pipeline_runs (id, methodology, status) VALUES ('parent-del', 'bmad', 'completed')`,
    ).run()
    db.prepare(
      `INSERT INTO pipeline_runs (id, methodology, status, parent_run_id) VALUES ('child-del', 'bmad', 'running', 'parent-del')`,
    ).run()

    db.prepare('DELETE FROM pipeline_runs WHERE id = ?').run('parent-del')

    const child = db
      .prepare('SELECT id FROM pipeline_runs WHERE id = ?')
      .get('child-del')
    expect(child).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC2: pipeline_runs status CHECK constraint includes 'stopped'
// ---------------------------------------------------------------------------
describe('AC2: pipeline_runs status CHECK includes stopped', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = setupDb()
  })

  afterEach(() => {
    db.close()
  })

  const validStatuses = ['running', 'paused', 'completed', 'failed', 'stopped']

  for (const status of validStatuses) {
    it(`accepts status='${status}'`, () => {
      expect(() => {
        db.prepare(
          `INSERT INTO pipeline_runs (id, methodology, status) VALUES (?, 'bmad', ?)`,
        ).run(`run-${status}`, status)
      }).not.toThrow()
    })
  }

  it('rejects invalid status value', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO pipeline_runs (id, methodology, status) VALUES ('run-bad', 'bmad', 'invalid_status')`,
      ).run()
    }).toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC3: decisions table receives superseded_by column
// ---------------------------------------------------------------------------
describe('AC3: decisions superseded_by column', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = setupDb()
  })

  afterEach(() => {
    db.close()
  })

  it('adds superseded_by column to decisions', () => {
    const columns = getTableColumns(db, 'decisions')
    expect(columns).toContain('superseded_by')
  })

  it('superseded_by is nullable by default', () => {
    db.prepare(
      `INSERT INTO pipeline_runs (id, methodology, status) VALUES ('r1', 'bmad', 'running')`,
    ).run()
    db.prepare(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value) VALUES ('d1', 'r1', 'analysis', 'cat', 'k', 'v')`,
    ).run()

    const row = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get('d1') as { superseded_by: string | null }
    expect(row.superseded_by).toBeNull()
  })

  it('superseded_by can reference an existing decision', () => {
    db.prepare(
      `INSERT INTO pipeline_runs (id, methodology, status) VALUES ('r2', 'bmad', 'running')`,
    ).run()
    db.prepare(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value) VALUES ('d-original', 'r2', 'analysis', 'cat', 'k', 'v1')`,
    ).run()
    db.prepare(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value) VALUES ('d-new', 'r2', 'analysis', 'cat', 'k', 'v2')`,
    ).run()

    expect(() => {
      db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ?').run('d-new', 'd-original')
    }).not.toThrow()

    const row = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get('d-original') as { superseded_by: string }
    expect(row.superseded_by).toBe('d-new')
  })

  it('rejects invalid superseded_by value (FK enforcement)', () => {
    db.prepare(
      `INSERT INTO pipeline_runs (id, methodology, status) VALUES ('r3', 'bmad', 'running')`,
    ).run()
    db.prepare(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value) VALUES ('d-x', 'r3', 'analysis', 'cat', 'k', 'v')`,
    ).run()

    expect(() => {
      db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ?').run('nonexistent-decision', 'd-x')
    }).toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC4: Index on pipeline_runs.parent_run_id
// ---------------------------------------------------------------------------
describe('AC4: idx_pipeline_runs_parent_run_id index', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = setupDb()
  })

  afterEach(() => {
    db.close()
  })

  it('creates idx_pipeline_runs_parent_run_id index', () => {
    const indexes = getIndexNames(db)
    expect(indexes).toContain('idx_pipeline_runs_parent_run_id')
  })
})

// ---------------------------------------------------------------------------
// AC5: Index on decisions.superseded_by
// ---------------------------------------------------------------------------
describe('AC5: idx_decisions_superseded_by index', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = setupDb()
  })

  afterEach(() => {
    db.close()
  })

  it('creates idx_decisions_superseded_by index', () => {
    const indexes = getIndexNames(db)
    expect(indexes).toContain('idx_decisions_superseded_by')
  })
})

// ---------------------------------------------------------------------------
// AC6: Active decisions query supports NULL filter
// ---------------------------------------------------------------------------
describe('AC6: Active decisions WHERE superseded_by IS NULL', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = setupDb()
    // Seed data
    db.prepare(
      `INSERT INTO pipeline_runs (id, methodology, status) VALUES ('run-ac6', 'bmad', 'completed')`,
    ).run()
    // Insert 5 decisions, then supersede 2 of them
    for (let i = 1; i <= 5; i++) {
      db.prepare(
        `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value) VALUES ('dec-${i}', 'run-ac6', 'analysis', 'cat', 'key-${i}', 'val-${i}')`,
      ).run()
    }
    // Insert superseding decisions
    db.prepare(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value) VALUES ('dec-new-1', 'run-ac6', 'analysis', 'cat', 'key-1-new', 'val-1-new')`,
    ).run()
    db.prepare(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value) VALUES ('dec-new-2', 'run-ac6', 'analysis', 'cat', 'key-2-new', 'val-2-new')`,
    ).run()
    // Supersede dec-1 and dec-2
    db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ?').run('dec-new-1', 'dec-1')
    db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ?').run('dec-new-2', 'dec-2')
  })

  afterEach(() => {
    db.close()
  })

  it('returns only non-superseded decisions', () => {
    const rows = db
      .prepare('SELECT id FROM decisions WHERE superseded_by IS NULL ORDER BY id')
      .all() as Array<{ id: string }>
    const ids = rows.map((r) => r.id)
    // dec-3, dec-4, dec-5, dec-new-1, dec-new-2 should be active
    expect(ids).toContain('dec-3')
    expect(ids).toContain('dec-4')
    expect(ids).toContain('dec-5')
    expect(ids).toContain('dec-new-1')
    expect(ids).toContain('dec-new-2')
    // dec-1 and dec-2 are superseded
    expect(ids).not.toContain('dec-1')
    expect(ids).not.toContain('dec-2')
    expect(rows.length).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// AC7: Decision supersession FK integrity (ON DELETE SET NULL)
// ---------------------------------------------------------------------------
describe('AC7: Decision supersession FK integrity (SET NULL)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = setupDb()
    db.prepare(
      `INSERT INTO pipeline_runs (id, methodology, status) VALUES ('run-ac7', 'bmad', 'running')`,
    ).run()
    db.prepare(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value) VALUES ('d-old', 'run-ac7', 'analysis', 'cat', 'k', 'old-val')`,
    ).run()
    db.prepare(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value) VALUES ('d-new', 'run-ac7', 'analysis', 'cat', 'k', 'new-val')`,
    ).run()
    db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ?').run('d-new', 'd-old')
  })

  afterEach(() => {
    db.close()
  })

  it('deleting superseding decision sets superseded_by to NULL (not cascades)', () => {
    db.prepare('DELETE FROM decisions WHERE id = ?').run('d-new')

    // d-old should still exist
    const old = db
      .prepare('SELECT id, superseded_by FROM decisions WHERE id = ?')
      .get('d-old') as { id: string; superseded_by: string | null }
    expect(old).toBeDefined()
    expect(old.superseded_by).toBeNull()
  })

  it('inserting decision with invalid superseded_by FK throws', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value, superseded_by) VALUES ('d-bad', 'run-ac7', 'analysis', 'cat', 'k', 'v', 'does-not-exist')`,
      ).run()
    }).toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC8: Data preservation across table recreation
// ---------------------------------------------------------------------------
describe('AC8: Data preservation across table recreation', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    // Use minimal db to seed data before 008 is applied
    const db007 = openMemoryDb()
    db007.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL,
        applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `)
    migration007DecisionStore.up(db007)
    db007.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(7, '007-decision-store')

    // Seed pipeline_runs before migration 008
    db007.prepare(
      `INSERT INTO pipeline_runs (id, methodology, status, created_at, updated_at)
       VALUES ('preserved-run', 'bmad', 'completed', '2024-01-01T00:00:00', '2024-01-01T00:00:00')`,
    ).run()

    // Seed decisions before migration 008
    db007.prepare(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value, created_at, updated_at)
       VALUES ('preserved-dec', 'preserved-run', 'analysis', 'cat', 'key1', 'val1', '2024-01-01T00:00:00', '2024-01-01T00:00:00')`,
    ).run()

    // Now apply migration 008 to the seeded db
    migration008AmendmentSchema.up(db007)
    db = db007
  })

  afterEach(() => {
    db.close()
  })

  it('preserves all pipeline_runs rows', () => {
    const row = db
      .prepare('SELECT * FROM pipeline_runs WHERE id = ?')
      .get('preserved-run') as Record<string, unknown>
    expect(row).toBeDefined()
    expect(row.methodology).toBe('bmad')
    expect(row.status).toBe('completed')
    expect(row.created_at).toBe('2024-01-01T00:00:00')
    expect(row.updated_at).toBe('2024-01-01T00:00:00')
    expect(row.parent_run_id).toBeNull()
  })

  it('preserves all decisions rows', () => {
    const row = db
      .prepare('SELECT * FROM decisions WHERE id = ?')
      .get('preserved-dec') as Record<string, unknown>
    expect(row).toBeDefined()
    expect(row.pipeline_run_id).toBe('preserved-run')
    expect(row.phase).toBe('analysis')
    expect(row.category).toBe('cat')
    expect(row.key).toBe('key1')
    expect(row.value).toBe('val1')
    expect(row.created_at).toBe('2024-01-01T00:00:00')
    expect(row.updated_at).toBe('2024-01-01T00:00:00')
    expect(row.superseded_by).toBeNull()
  })

  it('no rows are lost after migration', () => {
    const runCount = (db.prepare('SELECT COUNT(*) as cnt FROM pipeline_runs').get() as { cnt: number }).cnt
    const decCount = (db.prepare('SELECT COUNT(*) as cnt FROM decisions').get() as { cnt: number }).cnt
    expect(runCount).toBe(1)
    expect(decCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// PRAGMA fix verification: migration succeeds through runner when FK data exists
// ---------------------------------------------------------------------------
describe('PRAGMA foreign_keys fix: runner with pre-existing FK data', () => {
  it('runs migration 008 through the runner without FK constraint errors when decisions rows reference pipeline_runs', () => {
    // Build a db with migrations 1-7 applied, then seed rows that create
    // a FK relationship between decisions and pipeline_runs.  Running
    // migration 008 via the runner (which previously wrapped up() in a
    // transaction making PRAGMA foreign_keys=OFF a no-op) must not throw.
    const db = openMemoryDb()

    // Apply migrations 1-7 manually so we can seed data before 008 runs
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL,
        applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `)
    migration007DecisionStore.up(db)
    db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
      migration007DecisionStore.version,
      migration007DecisionStore.name,
    )

    // Seed a pipeline_run and a decision referencing it (creates the FK
    // relationship that caused DROP TABLE pipeline_runs to fail when
    // PRAGMA foreign_keys=OFF was a no-op inside a transaction)
    db.prepare(
      `INSERT INTO pipeline_runs (id, methodology, status) VALUES ('fk-run-1', 'bmad', 'completed')`,
    ).run()
    db.prepare(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value) VALUES ('fk-dec-1', 'fk-run-1', 'analysis', 'cat', 'k', 'v')`,
    ).run()

    // Run the full migration runner — this applies migration 008 via the
    // runner's managesOwnTransaction path, ensuring PRAGMA takes effect
    expect(() => runMigrations(db)).not.toThrow()

    // Data is preserved
    const run = db.prepare('SELECT id FROM pipeline_runs WHERE id = ?').get('fk-run-1')
    expect(run).toBeDefined()
    const dec = db.prepare('SELECT id, superseded_by FROM decisions WHERE id = ?').get('fk-dec-1') as { id: string; superseded_by: string | null }
    expect(dec).toBeDefined()
    expect(dec.superseded_by).toBeNull()

    // New columns exist
    const cols = (db.prepare('PRAGMA table_info(pipeline_runs)').all() as Array<{ name: string }>).map(r => r.name)
    expect(cols).toContain('parent_run_id')

    db.close()
  })
})

// ---------------------------------------------------------------------------
// AC9: Migration is idempotent (via migration runner)
// ---------------------------------------------------------------------------
describe('AC9: Migration 008 idempotency', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('running full migration suite twice does not throw', () => {
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
  })

  it('migration 008 is recorded only once in schema_migrations', () => {
    runMigrations(db)
    runMigrations(db)

    const rows = db
      .prepare('SELECT version FROM schema_migrations WHERE version = 8')
      .all() as Array<{ version: number }>
    expect(rows.length).toBe(1)
  })

  it('schema remains consistent after double run', () => {
    runMigrations(db)
    runMigrations(db)

    const prCols = getTableColumns(db, 'pipeline_runs')
    expect(prCols).toContain('parent_run_id')

    const decCols = getTableColumns(db, 'decisions')
    expect(decCols).toContain('superseded_by')
  })
})

// ---------------------------------------------------------------------------
// AC10: Backward compatibility — pre-amendment data with NULL values
// ---------------------------------------------------------------------------
describe('AC10: Backward compatibility for pre-amendment data', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = setupDb()
    // Insert pre-amendment style data (no parent_run_id, no superseded_by)
    db.prepare(
      `INSERT INTO pipeline_runs (id, methodology, status) VALUES ('legacy-run', 'bmad', 'completed')`,
    ).run()
    db.prepare(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value) VALUES ('legacy-dec', 'legacy-run', 'analysis', 'cat', 'k', 'v')`,
    ).run()
  })

  afterEach(() => {
    db.close()
  })

  it('pre-amendment pipeline_runs have parent_run_id = NULL', () => {
    const row = db
      .prepare('SELECT parent_run_id FROM pipeline_runs WHERE id = ?')
      .get('legacy-run') as { parent_run_id: string | null }
    expect(row.parent_run_id).toBeNull()
  })

  it('pre-amendment decisions have superseded_by = NULL', () => {
    const row = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get('legacy-dec') as { superseded_by: string | null }
    expect(row.superseded_by).toBeNull()
  })

  it('WHERE parent_run_id IS NULL includes pre-amendment runs', () => {
    const rows = db
      .prepare('SELECT id FROM pipeline_runs WHERE parent_run_id IS NULL')
      .all() as Array<{ id: string }>
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('legacy-run')
  })

  it('WHERE superseded_by IS NULL includes pre-amendment decisions', () => {
    const rows = db
      .prepare('SELECT id FROM decisions WHERE superseded_by IS NULL')
      .all() as Array<{ id: string }>
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('legacy-dec')
  })
})

// ---------------------------------------------------------------------------
// Additional: Verify all expected indexes exist after migration
// ---------------------------------------------------------------------------
describe('Index completeness after migration 008', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = setupDb()
  })

  afterEach(() => {
    db.close()
  })

  it('has all expected pipeline_runs indexes', () => {
    const indexes = getIndexNames(db)
    expect(indexes).toContain('idx_pipeline_runs_status')
    expect(indexes).toContain('idx_pipeline_runs_parent_run_id')
  })

  it('has all expected decisions indexes', () => {
    const indexes = getIndexNames(db)
    expect(indexes).toContain('idx_decisions_phase')
    expect(indexes).toContain('idx_decisions_key')
    expect(indexes).toContain('idx_decisions_superseded_by')
  })
})

// ---------------------------------------------------------------------------
// Schema validation: column list completeness
// ---------------------------------------------------------------------------
describe('Schema column completeness after migration 008', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = setupDb()
  })

  afterEach(() => {
    db.close()
  })

  it('pipeline_runs has all expected columns', () => {
    const cols = getTableColumns(db, 'pipeline_runs')
    const expected = [
      'id', 'methodology', 'current_phase', 'status',
      'config_json', 'token_usage_json', 'parent_run_id',
      'created_at', 'updated_at',
    ]
    for (const col of expected) {
      expect(cols, `Expected column '${col}' in pipeline_runs`).toContain(col)
    }
  })

  it('decisions has all expected columns', () => {
    const cols = getTableColumns(db, 'decisions')
    const expected = [
      'id', 'pipeline_run_id', 'phase', 'category', 'key',
      'value', 'rationale', 'superseded_by', 'created_at', 'updated_at',
    ]
    for (const col of expected) {
      expect(cols, `Expected column '${col}' in decisions`).toContain(col)
    }
  })
})
