/**
 * H5.2 (field finding #3): DDL ↔ writer column parity for telemetry tables.
 *
 * The efficiency-scores round-trip suite runs on InMemoryDatabaseAdapter,
 * which does NOT enforce columns — so when the EfficiencyScorer writer
 * gained `token_density_sub_score` + `cold_start_turns_excluded` without a
 * DDL change, every test stayed green while every production Dolt INSERT
 * warn-failed with "Unknown column" and telemetry silently lost all
 * efficiency scores.
 *
 * This suite closes the class statically: every column named in the
 * persistence layer's INSERT statements must exist in the corresponding
 * CREATE TABLE in telemetry-schema.ts (either the base DDL or a forward
 * ALTER migration).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..', '..')

const SCHEMA_SRC = readFileSync(
  resolve(REPO, 'packages', 'core', 'src', 'persistence', 'telemetry-schema.ts'),
  'utf-8',
)
const WRITER_SRC = readFileSync(resolve(HERE, '..', 'adapter-persistence.ts'), 'utf-8')

/** Columns declared for `table` in telemetry-schema.ts (DDL + ALTER migrations). */
function declaredColumns(table: string): Set<string> {
  const cols = new Set<string>()
  const ddl = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([^;]*?)\\)\\n\\s*\``, 's').exec(SCHEMA_SRC)
  expect(ddl, `CREATE TABLE for ${table} not found`).not.toBeNull()
  for (const line of ddl![1]!.split('\n')) {
    const m = /^\s*([a-z_]+)\s+(?:VARCHAR|TEXT|INTEGER|BIGINT|DOUBLE|BOOLEAN|DECIMAL)/.exec(line)
    if (m) cols.add(m[1]!)
  }
  // Forward ALTER migrations: `ALTER TABLE <table> ADD COLUMN ${col} ...`
  // driven by for-loops over string arrays/tuples near the table's DDL.
  const alterLoops = SCHEMA_SRC.matchAll(
    new RegExp(`for \\(const (?:col|\\[col[^\\]]*\\]) of \\[([^\\]]+)\\][^{]*\\{\\s*try \\{ await adapter\\.exec\\(\`ALTER TABLE ${table} ADD COLUMN`, 'gs'),
  )
  for (const loop of alterLoops) {
    for (const lit of loop[1]!.matchAll(/'([a-z_]+)'/g)) cols.add(lit[1]!)
  }
  return cols
}

/** Columns named in the writer's INSERT INTO <table> (...) list. */
function insertedColumns(table: string): string[] {
  const m = new RegExp(`INSERT INTO ${table} \\(([^)]*)\\)`, 's').exec(WRITER_SRC)
  expect(m, `INSERT INTO ${table} not found in adapter-persistence.ts`).not.toBeNull()
  return m![1]!
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
}

describe('telemetry DDL ↔ writer parity (H5.2 / finding #3)', () => {
  for (const table of ['efficiency_scores', 'turn_analysis'] as const) {
    it(`every column ${table}'s INSERT writes exists in its DDL`, () => {
      const declared = declaredColumns(table)
      const missing = insertedColumns(table).filter((c) => !declared.has(c))
      expect(
        missing,
        `writer inserts columns missing from telemetry-schema.ts DDL for ${table} — production Dolt INSERTs will fail with "Unknown column": ${missing.join(', ')}`,
      ).toEqual([])
    })
  }
})
