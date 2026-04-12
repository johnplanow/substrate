// Unit tests for InMemoryDatabaseAdapter's UNIQUE INDEX enforcement.
//
// G10 adds composite UNIQUE constraints to decisions and phase_outputs. The
// in-memory adapter is the primary test fixture for the query layer, so it
// must enforce UNIQUE INDEX semantics identically to Dolt/MySQL for these
// tests to cover the constraint contract.
//
// Pre-G10 the adapter's _createIndex parser recognized `CREATE [UNIQUE] INDEX`
// but only stored metadata — it did not enforce UNIQUE on INSERT, and the
// CREATE TABLE parser explicitly skipped table-level UNIQUE constraints.

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../memory-adapter.js'
import { initSchema } from '../schema.js'

describe('InMemoryDatabaseAdapter UNIQUE INDEX enforcement (G10)', () => {
  let db: InMemoryDatabaseAdapter

  beforeEach(() => {
    db = new InMemoryDatabaseAdapter()
  })

  it('rejects an INSERT that duplicates a single-column UNIQUE INDEX', async () => {
    await db.exec('CREATE TABLE t (id VARCHAR(64) PRIMARY KEY, label VARCHAR(64))')
    await db.exec('CREATE UNIQUE INDEX uniq_t_label ON t(label)')

    await db.query('INSERT INTO t (id, label) VALUES (?, ?)', ['1', 'alpha'])
    await expect(
      db.query('INSERT INTO t (id, label) VALUES (?, ?)', ['2', 'alpha']),
    ).rejects.toThrow(/UNIQUE/i)

    const rows = await db.query<{ id: string }>('SELECT * FROM t')
    expect(rows).toHaveLength(1)
  })

  it('rejects an INSERT that duplicates a composite (multi-column) UNIQUE INDEX', async () => {
    await db.exec(
      'CREATE TABLE decisions_like (id VARCHAR(64) PRIMARY KEY, run_id VARCHAR(64), category VARCHAR(64), `key` VARCHAR(64), value TEXT)',
    )
    await db.exec(
      'CREATE UNIQUE INDEX uniq_composite ON decisions_like(run_id, category, `key`)',
    )

    await db.query(
      'INSERT INTO decisions_like (id, run_id, category, `key`, value) VALUES (?, ?, ?, ?, ?)',
      ['1', 'run-a', 'architecture', 'language', 'TypeScript'],
    )
    await expect(
      db.query(
        'INSERT INTO decisions_like (id, run_id, category, `key`, value) VALUES (?, ?, ?, ?, ?)',
        ['2', 'run-a', 'architecture', 'language', 'Go'],
      ),
    ).rejects.toThrow(/UNIQUE/i)

    const rows = await db.query<{ id: string }>('SELECT * FROM decisions_like')
    expect(rows).toHaveLength(1)
  })

  it('permits INSERT when any column of the composite key differs', async () => {
    await db.exec(
      'CREATE TABLE t (id VARCHAR(64) PRIMARY KEY, a VARCHAR(64), b VARCHAR(64), c VARCHAR(64))',
    )
    await db.exec('CREATE UNIQUE INDEX uniq_t_ab ON t(a, b)')

    await db.query('INSERT INTO t (id, a, b, c) VALUES (?, ?, ?, ?)', ['1', 'x', 'y', 'first'])
    // a differs
    await db.query('INSERT INTO t (id, a, b, c) VALUES (?, ?, ?, ?)', ['2', 'w', 'y', 'second'])
    // b differs
    await db.query('INSERT INTO t (id, a, b, c) VALUES (?, ?, ?, ?)', ['3', 'x', 'z', 'third'])

    const rows = await db.query<{ id: string }>('SELECT * FROM t')
    expect(rows).toHaveLength(3)
  })

  it('permits multiple rows with NULL in a UNIQUE-indexed column (standard SQL semantics)', async () => {
    // In MySQL/SQLite, NULL values in a UNIQUE column are considered
    // distinct — multiple rows with NULL in the same column do NOT violate
    // the constraint. G10 upsert code relies on this to handle orphan
    // captures (pipeline_run_id IS NULL) via the legacy SELECT-then-write
    // path, which depends on this NULL semantics holding.
    await db.exec('CREATE TABLE t (id VARCHAR(64) PRIMARY KEY, run_id VARCHAR(64), label VARCHAR(64))')
    await db.exec('CREATE UNIQUE INDEX uniq_t_run_label ON t(run_id, label)')

    // Insert two rows with NULL run_id and SAME label — should be allowed
    await db.query('INSERT INTO t (id, run_id, label) VALUES (?, ?, ?)', ['1', null, 'orphan'])
    await db.query('INSERT INTO t (id, run_id, label) VALUES (?, ?, ?)', ['2', null, 'orphan'])

    const rows = await db.query<{ id: string }>('SELECT * FROM t')
    expect(rows).toHaveLength(2)
  })

  it('the UNIQUE violation error message names the table and offending columns', async () => {
    await db.exec('CREATE TABLE t (id VARCHAR(64) PRIMARY KEY, a VARCHAR(64), b VARCHAR(64))')
    await db.exec('CREATE UNIQUE INDEX uniq_t_ab ON t(a, b)')
    await db.query('INSERT INTO t (id, a, b) VALUES (?, ?, ?)', ['1', 'x', 'y'])

    // Error must be diagnostic-friendly for upsert code that catches it
    // and retries as UPDATE — the caller needs to know it was a UNIQUE
    // violation, not a schema error or type mismatch.
    let threw: Error | undefined
    try {
      await db.query('INSERT INTO t (id, a, b) VALUES (?, ?, ?)', ['2', 'x', 'y'])
    } catch (err) {
      threw = err as Error
    }
    expect(threw).toBeDefined()
    expect(threw?.message).toMatch(/UNIQUE constraint failed/i)
    expect(threw?.message).toMatch(/a, b/)
  })
})

describe('initSchema installs G10 composite UNIQUE indexes', () => {
  let db: InMemoryDatabaseAdapter

  beforeEach(async () => {
    db = new InMemoryDatabaseAdapter()
    await initSchema(db)
  })

  it('decisions(pipeline_run_id, category, `key`) rejects a duplicate raw INSERT', async () => {
    // Insert a baseline row directly (bypass upsertDecision to target the
    // schema constraint itself).
    await db.query(
      "INSERT INTO decisions (id, pipeline_run_id, phase, category, `key`, value) VALUES (?, ?, ?, ?, ?, ?)",
      ['id-1', 'run-1', 'solutioning', 'architecture', 'language', 'TypeScript'],
    )

    // Attempting to insert a second row with the same composite key must
    // fail with a UNIQUE violation. Pre-G10, this succeeded and produced
    // a duplicate — silently breaking upsertDecision under concurrent writers.
    await expect(
      db.query(
        "INSERT INTO decisions (id, pipeline_run_id, phase, category, `key`, value) VALUES (?, ?, ?, ?, ?, ?)",
        ['id-2', 'run-1', 'solutioning', 'architecture', 'language', 'Go'],
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/i)
  })

  it('phase_outputs(pipeline_run_id, phase, step_name) rejects a duplicate raw INSERT', async () => {
    await db.query(
      'INSERT INTO phase_outputs (id, pipeline_run_id, phase, step_name, raw_output) VALUES (?, ?, ?, ?, ?)',
      ['id-1', 'run-1', 'analysis', 'step-1', 'first'],
    )
    await expect(
      db.query(
        'INSERT INTO phase_outputs (id, pipeline_run_id, phase, step_name, raw_output) VALUES (?, ?, ?, ?, ?)',
        ['id-2', 'run-1', 'analysis', 'step-1', 'second'],
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/i)
  })

  it('decisions composite constraint allows different (category, `key`) combos within same run', async () => {
    await db.query(
      "INSERT INTO decisions (id, pipeline_run_id, phase, category, `key`, value) VALUES (?, ?, ?, ?, ?, ?)",
      ['id-1', 'run-1', 'solutioning', 'architecture', 'language', 'TypeScript'],
    )
    // Different key — should be allowed
    await db.query(
      "INSERT INTO decisions (id, pipeline_run_id, phase, category, `key`, value) VALUES (?, ?, ?, ?, ?, ?)",
      ['id-2', 'run-1', 'solutioning', 'architecture', 'runtime', 'Bun'],
    )
    // Different category — should be allowed
    await db.query(
      "INSERT INTO decisions (id, pipeline_run_id, phase, category, `key`, value) VALUES (?, ?, ?, ?, ?, ?)",
      ['id-3', 'run-1', 'solutioning', 'patterns', 'language', 'AnyValue'],
    )
    // Different run — should be allowed
    await db.query(
      "INSERT INTO decisions (id, pipeline_run_id, phase, category, `key`, value) VALUES (?, ?, ?, ?, ?, ?)",
      ['id-4', 'run-2', 'solutioning', 'architecture', 'language', 'Go'],
    )

    const rows = await db.query<{ id: string }>('SELECT * FROM decisions')
    expect(rows).toHaveLength(4)
  })

  it('decisions composite constraint allows multiple null-run rows with same (category, `key`)', async () => {
    // NULL run_id is standard-SQL distinct — the UNIQUE index must NOT
    // block orphan decisions. upsertDecision's null-run path still relies
    // on SELECT-then-write application-level dedup for null captures.
    await db.query(
      "INSERT INTO decisions (id, pipeline_run_id, phase, category, `key`, value) VALUES (?, ?, ?, ?, ?, ?)",
      ['id-1', null, 'solutioning', 'architecture', 'language', 'A'],
    )
    await db.query(
      "INSERT INTO decisions (id, pipeline_run_id, phase, category, `key`, value) VALUES (?, ?, ?, ?, ?, ?)",
      ['id-2', null, 'solutioning', 'architecture', 'language', 'B'],
    )
    const rows = await db.query<{ id: string }>('SELECT * FROM decisions')
    expect(rows).toHaveLength(2)
  })
})
