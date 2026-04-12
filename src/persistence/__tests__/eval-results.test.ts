/**
 * Unit tests for the eval_results table and its query functions (V1b-2).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '@substrate-ai/core'
import { initSchema } from '../schema.js'
import {
  writeEvalResult,
  getLatestEvalForRun,
  getEvalsForRun,
  loadEvalPairForComparison,
} from '../queries/eval-results.js'

async function openTestDb() {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return adapter
}

describe('eval_results schema', () => {
  let db: InMemoryDatabaseAdapter

  beforeEach(async () => {
    db = await openTestDb()
  })

  it('creates the eval_results table', () => {
    const tables = db.querySync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='eval_results'",
    )
    expect(tables).toHaveLength(1)
    expect(tables[0]!.name).toBe('eval_results')
  })

  it('creates the run_id index', () => {
    const indexes = db.querySync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='eval_results'",
    )
    expect(indexes.map((i) => i.name)).toContain('idx_eval_results_run_id')
  })

  it('creates the eval_id unique index', () => {
    const indexes = db.querySync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='eval_results'",
    )
    expect(indexes.map((i) => i.name)).toContain('uniq_eval_results_eval_id')
  })

  it('schema is idempotent', async () => {
    await expect(initSchema(db)).resolves.not.toThrow()
  })
})

describe('writeEvalResult', () => {
  let db: InMemoryDatabaseAdapter

  beforeEach(async () => {
    db = await openTestDb()
  })

  it('inserts a row and returns it with all fields', async () => {
    const evalId = crypto.randomUUID()
    const row = await writeEvalResult(db, {
      run_id: 'run-1',
      eval_id: evalId,
      depth: 'standard',
      timestamp: '2026-04-12T10:00:00Z',
      overall_score: 0.82,
      pass: true,
      phases_json: JSON.stringify([{ phase: 'analysis', score: 0.82 }]),
      metadata_json: JSON.stringify({ schemaVersion: '1b', gitSha: 'abc1234' }),
    })

    expect(row.run_id).toBe('run-1')
    expect(row.eval_id).toBe(evalId)
    expect(row.depth).toBe('standard')
    expect(row.overall_score).toBe(0.82)
    expect(row.pass).toBe(true)
    expect(row.phases_json).toContain('analysis')
    expect(row.metadata_json).toContain('abc1234')
  })

  it('rejects duplicate eval_id', async () => {
    const evalId = crypto.randomUUID()
    const input = {
      run_id: 'run-1',
      eval_id: evalId,
      depth: 'standard' as const,
      timestamp: '2026-04-12T10:00:00Z',
      overall_score: 0.82,
      pass: true,
      phases_json: '[]',
    }

    await writeEvalResult(db, input)
    await expect(writeEvalResult(db, input)).rejects.toThrow()
  })

  it('allows multiple evals for the same run_id', async () => {
    await writeEvalResult(db, {
      run_id: 'run-1',
      eval_id: crypto.randomUUID(),
      depth: 'standard',
      timestamp: '2026-04-12T10:00:00Z',
      overall_score: 0.75,
      pass: true,
      phases_json: '[]',
    })
    await writeEvalResult(db, {
      run_id: 'run-1',
      eval_id: crypto.randomUUID(),
      depth: 'deep',
      timestamp: '2026-04-12T11:00:00Z',
      overall_score: 0.80,
      pass: true,
      phases_json: '[]',
    })

    const all = await getEvalsForRun(db, 'run-1')
    expect(all).toHaveLength(2)
  })

  it('handles null metadata_json', async () => {
    const row = await writeEvalResult(db, {
      run_id: 'run-1',
      eval_id: crypto.randomUUID(),
      depth: 'standard',
      timestamp: '2026-04-12T10:00:00Z',
      overall_score: 0.70,
      pass: true,
      phases_json: '[]',
      metadata_json: null,
    })

    expect(row.metadata_json).toBeNull()
  })
})

describe('getLatestEvalForRun', () => {
  let db: InMemoryDatabaseAdapter

  beforeEach(async () => {
    db = await openTestDb()
  })

  it('returns the most recent eval for a run', async () => {
    await writeEvalResult(db, {
      run_id: 'run-1',
      eval_id: crypto.randomUUID(),
      depth: 'standard',
      timestamp: '2026-04-12T10:00:00Z',
      overall_score: 0.70,
      pass: true,
      phases_json: '[]',
    })
    await writeEvalResult(db, {
      run_id: 'run-1',
      eval_id: crypto.randomUUID(),
      depth: 'deep',
      timestamp: '2026-04-12T11:00:00Z',
      overall_score: 0.85,
      pass: true,
      phases_json: '[]',
    })

    const latest = await getLatestEvalForRun(db, 'run-1')
    expect(latest).toBeDefined()
    expect(latest!.overall_score).toBe(0.85)
    expect(latest!.depth).toBe('deep')
  })

  it('returns undefined when no eval exists', async () => {
    const result = await getLatestEvalForRun(db, 'nonexistent')
    expect(result).toBeUndefined()
  })
})

describe('loadEvalPairForComparison', () => {
  let db: InMemoryDatabaseAdapter

  beforeEach(async () => {
    db = await openTestDb()
  })

  it('returns both results when both runs have evals', async () => {
    await writeEvalResult(db, {
      run_id: 'run-a',
      eval_id: crypto.randomUUID(),
      depth: 'standard',
      timestamp: '2026-04-12T10:00:00Z',
      overall_score: 0.70,
      pass: true,
      phases_json: '[]',
    })
    await writeEvalResult(db, {
      run_id: 'run-b',
      eval_id: crypto.randomUUID(),
      depth: 'standard',
      timestamp: '2026-04-12T11:00:00Z',
      overall_score: 0.85,
      pass: true,
      phases_json: '[]',
    })

    const [a, b] = await loadEvalPairForComparison(db, 'run-a', 'run-b')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a!.run_id).toBe('run-a')
    expect(b!.run_id).toBe('run-b')
  })

  it('returns undefined for runs without evals', async () => {
    await writeEvalResult(db, {
      run_id: 'run-a',
      eval_id: crypto.randomUUID(),
      depth: 'standard',
      timestamp: '2026-04-12T10:00:00Z',
      overall_score: 0.70,
      pass: true,
      phases_json: '[]',
    })

    const [a, b] = await loadEvalPairForComparison(db, 'run-a', 'run-missing')
    expect(a).toBeDefined()
    expect(b).toBeUndefined()
  })
})

describe('round-trip: write then read preserves all fields', () => {
  it('phases_json and metadata_json round-trip correctly', async () => {
    const db = await openTestDb()
    const phases = [{ phase: 'analysis', score: 0.82, pass: true, layers: [], issues: [], feedback: '' }]
    const metadata = { schemaVersion: '1b', gitSha: 'abc1234', rubricHashes: { analysis: 'deadbeef' } }

    await writeEvalResult(db, {
      run_id: 'run-rt',
      eval_id: crypto.randomUUID(),
      depth: 'deep',
      timestamp: '2026-04-12T12:00:00Z',
      overall_score: 0.82,
      pass: true,
      phases_json: JSON.stringify(phases),
      metadata_json: JSON.stringify(metadata),
    })

    const latest = await getLatestEvalForRun(db, 'run-rt')
    expect(latest).toBeDefined()
    expect(JSON.parse(latest!.phases_json)).toEqual(phases)
    expect(JSON.parse(latest!.metadata_json!)).toEqual(metadata)
    expect(latest!.pass).toBe(true)
    expect(latest!.overall_score).toBe(0.82)
  })
})
