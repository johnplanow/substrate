/**
 * Unit tests for the phase_outputs table and its query functions.
 *
 * phase_outputs captures the raw LLM output string per dispatch step so the
 * eval CLI (and future consumers) can judge the actual artifact the model
 * produced, rather than reconstructing from parsed decisions. See
 * docs/eval-system.md and deferred-work item G2.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../memory-adapter.js'
import { initSchema } from '../schema.js'
import {
  upsertPhaseOutput,
  getRawOutputsByPhaseForRun,
} from '../queries/phase-outputs.js'

async function openTestDb() {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return adapter
}

describe('phase_outputs schema', () => {
  let db: InMemoryDatabaseAdapter

  beforeEach(async () => {
    db = await openTestDb()
  })

  it('creates the phase_outputs table', () => {
    const tables = db.querySync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='phase_outputs'",
    )
    expect(tables).toHaveLength(1)
    expect(tables[0]!.name).toBe('phase_outputs')
  })

  it('creates the phase_outputs run_phase index', () => {
    const indexes = db.querySync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='phase_outputs'",
    )
    expect(indexes.map((i) => i.name)).toContain('idx_phase_outputs_run_phase')
  })

  it('migration is idempotent', async () => {
    await expect(initSchema(db)).resolves.not.toThrow()
  })
})

describe('upsertPhaseOutput', () => {
  let db: InMemoryDatabaseAdapter

  beforeEach(async () => {
    db = await openTestDb()
  })

  it('inserts a new row with a generated UUID', async () => {
    const row = await upsertPhaseOutput(db, {
      pipeline_run_id: 'run-1',
      phase: 'analysis',
      step_name: 'step-1',
      raw_output: 'The raw text the LLM produced.',
    })

    expect(row.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(row.pipeline_run_id).toBe('run-1')
    expect(row.phase).toBe('analysis')
    expect(row.step_name).toBe('step-1')
    expect(row.raw_output).toBe('The raw text the LLM produced.')
    expect(row.created_at).toBeDefined()
    expect(row.updated_at).toBeDefined()
  })

  it('updates the existing row in place when the composite key matches', async () => {
    const first = await upsertPhaseOutput(db, {
      pipeline_run_id: 'run-1',
      phase: 'analysis',
      step_name: 'step-1',
      raw_output: 'initial output',
    })

    const second = await upsertPhaseOutput(db, {
      pipeline_run_id: 'run-1',
      phase: 'analysis',
      step_name: 'step-1',
      raw_output: 'updated output',
    })

    // Same id — we updated, did not insert a duplicate.
    expect(second.id).toBe(first.id)
    expect(second.raw_output).toBe('updated output')

    const all = await getRawOutputsByPhaseForRun(db, 'run-1', 'analysis')
    expect(all).toHaveLength(1)
    expect(all[0]!.raw_output).toBe('updated output')
  })

  it('stores different rows for different step names within the same phase', async () => {
    await upsertPhaseOutput(db, {
      pipeline_run_id: 'run-1',
      phase: 'analysis',
      step_name: 'step-1',
      raw_output: 'first step',
    })
    await upsertPhaseOutput(db, {
      pipeline_run_id: 'run-1',
      phase: 'analysis',
      step_name: 'step-2',
      raw_output: 'second step',
    })

    const rows = await getRawOutputsByPhaseForRun(db, 'run-1', 'analysis')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.step_name).sort()).toEqual(['step-1', 'step-2'])
  })

  it('preserves very long raw output without truncation', async () => {
    const longOutput = 'x'.repeat(50_000)
    const row = await upsertPhaseOutput(db, {
      pipeline_run_id: 'run-1',
      phase: 'analysis',
      step_name: 'step-1',
      raw_output: longOutput,
    })
    expect(row.raw_output).toHaveLength(50_000)
  })

  it('accepts a null pipeline_run_id (phase-level captures without a run context)', async () => {
    const row = await upsertPhaseOutput(db, {
      pipeline_run_id: null,
      phase: 'analysis',
      step_name: 'step-1',
      raw_output: 'orphan output',
    })
    expect(row.pipeline_run_id).toBeNull()
  })

  it('upserts correctly when pipeline_run_id is null (SQL NULL semantics)', async () => {
    // Regression for a SQL NULL pitfall: `WHERE pipeline_run_id = ?` with a
    // null parameter returns zero rows because NULL != NULL in standard SQL.
    // The upsert must branch to IS NULL for null run_ids so a second write
    // updates in place rather than inserting a duplicate.
    const first = await upsertPhaseOutput(db, {
      pipeline_run_id: null,
      phase: 'analysis',
      step_name: 'orphan-step',
      raw_output: 'first',
    })
    const second = await upsertPhaseOutput(db, {
      pipeline_run_id: null,
      phase: 'analysis',
      step_name: 'orphan-step',
      raw_output: 'second',
    })
    expect(second.id).toBe(first.id)
    expect(second.raw_output).toBe('second')

    // Confirm only one row exists for the null-run composite key
    const all = db.querySync<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM phase_outputs WHERE pipeline_run_id IS NULL AND step_name = 'orphan-step'",
    )
    expect(all[0]!.cnt).toBe(1)
  })

  it('rejects invalid input via Zod validation', async () => {
    await expect(
      upsertPhaseOutput(db, {
        pipeline_run_id: 'run-1',
        phase: '',
        step_name: 'step-1',
        raw_output: 'text',
      }),
    ).rejects.toThrow()
  })
})

describe('getRawOutputsByPhaseForRun', () => {
  let db: InMemoryDatabaseAdapter

  beforeEach(async () => {
    db = await openTestDb()
  })

  it('returns rows ordered by created_at ascending', async () => {
    await upsertPhaseOutput(db, {
      pipeline_run_id: 'run-1',
      phase: 'analysis',
      step_name: 'step-a',
      raw_output: 'first',
    })
    await upsertPhaseOutput(db, {
      pipeline_run_id: 'run-1',
      phase: 'analysis',
      step_name: 'step-b',
      raw_output: 'second',
    })
    await upsertPhaseOutput(db, {
      pipeline_run_id: 'run-1',
      phase: 'analysis',
      step_name: 'step-c',
      raw_output: 'third',
    })

    const rows = await getRawOutputsByPhaseForRun(db, 'run-1', 'analysis')
    expect(rows.map((r) => r.raw_output)).toEqual(['first', 'second', 'third'])
  })

  it('returns an empty array when no rows match (legacy-run fallback signal)', async () => {
    const rows = await getRawOutputsByPhaseForRun(db, 'nonexistent-run', 'analysis')
    expect(rows).toEqual([])
  })

  it('filters correctly by phase within a run', async () => {
    await upsertPhaseOutput(db, {
      pipeline_run_id: 'run-1',
      phase: 'analysis',
      step_name: 'step-1',
      raw_output: 'a1',
    })
    await upsertPhaseOutput(db, {
      pipeline_run_id: 'run-1',
      phase: 'planning',
      step_name: 'step-1',
      raw_output: 'p1',
    })

    const analysis = await getRawOutputsByPhaseForRun(db, 'run-1', 'analysis')
    const planning = await getRawOutputsByPhaseForRun(db, 'run-1', 'planning')
    expect(analysis).toHaveLength(1)
    expect(analysis[0]!.raw_output).toBe('a1')
    expect(planning).toHaveLength(1)
    expect(planning[0]!.raw_output).toBe('p1')
  })

  it('isolates rows by pipeline_run_id', async () => {
    await upsertPhaseOutput(db, {
      pipeline_run_id: 'run-1',
      phase: 'analysis',
      step_name: 'step-1',
      raw_output: 'run-1 output',
    })
    await upsertPhaseOutput(db, {
      pipeline_run_id: 'run-2',
      phase: 'analysis',
      step_name: 'step-1',
      raw_output: 'run-2 output',
    })

    const r1 = await getRawOutputsByPhaseForRun(db, 'run-1', 'analysis')
    const r2 = await getRawOutputsByPhaseForRun(db, 'run-2', 'analysis')
    expect(r1).toHaveLength(1)
    expect(r1[0]!.raw_output).toBe('run-1 output')
    expect(r2).toHaveLength(1)
    expect(r2[0]!.raw_output).toBe('run-2 output')
  })
})
