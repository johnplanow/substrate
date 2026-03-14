/**
 * Unit tests for src/persistence/queries/metrics.ts
 *
 * Covers:
 *  T9 - Metrics persistence: writeRunMetrics, writeStoryMetrics, aggregateTokenUsageForRun
 *  T10 - Metrics query & comparison: listRunMetrics, getRunMetrics, tagRunAsBaseline,
 *        getBaselineRunMetrics, getStoryMetricsForRun, compareRunMetrics,
 *        getRunSummaryForSupervisor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWasmSqliteAdapter, WasmSqliteDatabaseAdapter } from '../../wasm-sqlite-adapter.js'
import { initSchema } from '../../schema.js'
import {
  writeRunMetrics,
  writeStoryMetrics,
  aggregateTokenUsageForRun,
  aggregateTokenUsageForStory,
  incrementRunRestarts,
  getRunMetrics,
  listRunMetrics,
  tagRunAsBaseline,
  getBaselineRunMetrics,
  getStoryMetricsForRun,
  compareRunMetrics,
  getRunSummaryForSupervisor,
} from '../metrics.js'
import type { RunMetricsInput, StoryMetricsInput } from '../metrics.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openDb() {
  const adapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
  await initSchema(adapter)
  return adapter
}

function insertPipelineRun(adapter: WasmSqliteDatabaseAdapter, id: string, status = 'completed'): void {
  adapter.querySync(
    `INSERT INTO pipeline_runs (id, methodology, status, parent_run_id, created_at, updated_at)
     VALUES (?, 'bmad', ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, status],
  )
}

async function seedRunMetrics(
  adapter: WasmSqliteDatabaseAdapter,
  overrides: Partial<RunMetricsInput> & { run_id: string },
): Promise<void> {
  const { run_id, ...rest } = overrides
  await writeRunMetrics(adapter, {
    run_id,
    methodology: 'bmad',
    status: 'completed',
    started_at: '2026-01-01T00:00:00.000Z',
    ...rest,
  })
}

// ---------------------------------------------------------------------------
// T9: Metrics Persistence
// ---------------------------------------------------------------------------

describe('writeRunMetrics (T9)', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('inserts a row with all required fields', async () => {
    await seedRunMetrics(adapter, { run_id: 'run-001' })
    const row = await getRunMetrics(adapter, 'run-001')
    expect(row).toBeDefined()
    expect(row!.run_id).toBe('run-001')
    expect(row!.methodology).toBe('bmad')
    expect(row!.status).toBe('completed')
  })

  it('stores optional numeric fields with defaults of 0', async () => {
    await seedRunMetrics(adapter, { run_id: 'run-002' })
    const row = (await getRunMetrics(adapter, 'run-002'))!
    expect(row.total_input_tokens).toBe(0)
    expect(row.total_output_tokens).toBe(0)
    expect(row.total_cost_usd).toBe(0)
    expect(row.stories_attempted).toBe(0)
    expect(row.stories_succeeded).toBe(0)
    expect(row.stories_failed).toBe(0)
    expect(row.stories_escalated).toBe(0)
    expect(row.total_review_cycles).toBe(0)
    expect(row.total_dispatches).toBe(0)
    expect(row.restarts).toBe(0)
    expect(row.is_baseline).toBe(0)
  })

  it('stores all provided optional fields correctly', async () => {
    await seedRunMetrics(adapter, {
      run_id: 'run-003',
      total_input_tokens: 1000,
      total_output_tokens: 500,
      total_cost_usd: 0.025,
      stories_attempted: 5,
      stories_succeeded: 4,
      stories_failed: 1,
      stories_escalated: 0,
      total_review_cycles: 8,
      total_dispatches: 20,
      concurrency_setting: 3,
      max_concurrent_actual: 2,
      restarts: 1,
      wall_clock_seconds: 300.5,
      completed_at: '2026-01-01T01:00:00.000Z',
    })
    const row = (await getRunMetrics(adapter, 'run-003'))!
    expect(row.total_input_tokens).toBe(1000)
    expect(row.total_output_tokens).toBe(500)
    expect(row.total_cost_usd).toBeCloseTo(0.025)
    expect(row.stories_attempted).toBe(5)
    expect(row.stories_succeeded).toBe(4)
    expect(row.stories_failed).toBe(1)
    expect(row.stories_escalated).toBe(0)
    expect(row.total_review_cycles).toBe(8)
    expect(row.total_dispatches).toBe(20)
    expect(row.concurrency_setting).toBe(3)
    expect(row.max_concurrent_actual).toBe(2)
    expect(row.restarts).toBe(1)
    expect(row.wall_clock_seconds).toBeCloseTo(300.5)
    expect(row.completed_at).toBe('2026-01-01T01:00:00.000Z')
  })

  it('upserts (INSERT OR REPLACE) on duplicate run_id', async () => {
    await seedRunMetrics(adapter, { run_id: 'run-004', total_input_tokens: 100 })
    await seedRunMetrics(adapter, { run_id: 'run-004', total_input_tokens: 200 })
    const row = (await getRunMetrics(adapter, 'run-004'))!
    expect(row.total_input_tokens).toBe(200)
  })

  it('returns undefined for an unknown run_id', async () => {
    const row = await getRunMetrics(adapter, 'nonexistent')
    expect(row).toBeUndefined()
  })
})

describe('writeStoryMetrics (T9)', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('inserts a story metrics row', async () => {
    const input: StoryMetricsInput = {
      run_id: 'run-s1',
      story_key: '17-1',
      result: 'success',
      input_tokens: 500,
      output_tokens: 200,
      cost_usd: 0.01,
      review_cycles: 2,
      dispatches: 5,
      wall_clock_seconds: 60,
      phase_durations_json: JSON.stringify({ 'create-story': 10, 'dev-story': 50 }),
    }
    await writeStoryMetrics(adapter, input)
    const rows = await getStoryMetricsForRun(adapter, 'run-s1')
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.story_key).toBe('17-1')
    expect(row.result).toBe('success')
    expect(row.input_tokens).toBe(500)
    expect(row.output_tokens).toBe(200)
    expect(row.review_cycles).toBe(2)
  })

  it('upserts on duplicate run_id + story_key', async () => {
    const base: StoryMetricsInput = { run_id: 'run-s2', story_key: '17-1', result: 'failed' }
    await writeStoryMetrics(adapter, base)
    await writeStoryMetrics(adapter, { ...base, result: 'success', input_tokens: 999 })
    const rows = await getStoryMetricsForRun(adapter, 'run-s2')
    expect(rows).toHaveLength(1)
    expect(rows[0].result).toBe('success')
    expect(rows[0].input_tokens).toBe(999)
  })

  it('stores phase_durations_json as a JSON string', async () => {
    const durations = { 'create-story': 30, 'dev-story': 90 }
    await writeStoryMetrics(adapter, {
      run_id: 'run-s3',
      story_key: '17-2',
      result: 'success',
      phase_durations_json: JSON.stringify(durations),
    })
    const rows = await getStoryMetricsForRun(adapter, 'run-s3')
    expect(rows[0].phase_durations_json).toBe(JSON.stringify(durations))
  })

  it('returns empty array for run with no story metrics', async () => {
    expect(await getStoryMetricsForRun(adapter, 'no-such-run')).toHaveLength(0)
  })

  it('returns all stories for a run in insertion order', async () => {
    await writeStoryMetrics(adapter, { run_id: 'run-s4', story_key: 'A', result: 'success' })
    await writeStoryMetrics(adapter, { run_id: 'run-s4', story_key: 'B', result: 'failed' })
    await writeStoryMetrics(adapter, { run_id: 'run-s4', story_key: 'C', result: 'escalated' })
    const rows = await getStoryMetricsForRun(adapter, 'run-s4')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.story_key)).toEqual(['A', 'B', 'C'])
  })
})

describe('aggregateTokenUsageForRun (T9)', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns zeros when no token_usage rows exist for the run', async () => {
    const agg = await aggregateTokenUsageForRun(adapter, 'run-tok-empty')
    expect(agg.input).toBe(0)
    expect(agg.output).toBe(0)
    expect(agg.cost).toBe(0)
  })

  it('aggregates token rows for a specific pipeline run', async () => {
    // Insert a pipeline_run and token_usage rows directly
    insertPipelineRun(adapter, 'run-tok-1')
    adapter.querySync(
      `INSERT INTO token_usage (pipeline_run_id, phase, agent, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['run-tok-1', 'dev-story', 'claude', 100, 50, 0.005],
    )
    adapter.querySync(
      `INSERT INTO token_usage (pipeline_run_id, phase, agent, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['run-tok-1', 'code-review', 'claude', 200, 100, 0.010],
    )

    const agg = await aggregateTokenUsageForRun(adapter, 'run-tok-1')
    expect(agg.input).toBe(300)
    expect(agg.output).toBe(150)
    expect(agg.cost).toBeCloseTo(0.015)
  })

  it('does not aggregate rows from a different run', async () => {
    insertPipelineRun(adapter, 'run-tok-2a')
    insertPipelineRun(adapter, 'run-tok-2b')
    adapter.querySync(
      `INSERT INTO token_usage (pipeline_run_id, phase, agent, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['run-tok-2a', 'dev-story', 'claude', 999, 888, 0.099],
    )

    const agg = await aggregateTokenUsageForRun(adapter, 'run-tok-2b')
    expect(agg.input).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// T10: Metrics Query and Comparison
// ---------------------------------------------------------------------------

describe('listRunMetrics (T10)', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    // Seed three runs with distinct started_at values
    await seedRunMetrics(adapter, { run_id: 'run-L1', started_at: '2026-01-01T00:00:00.000Z' })
    await seedRunMetrics(adapter, { run_id: 'run-L2', started_at: '2026-01-02T00:00:00.000Z' })
    await seedRunMetrics(adapter, { run_id: 'run-L3', started_at: '2026-01-03T00:00:00.000Z' })
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns rows newest first', async () => {
    const rows = await listRunMetrics(adapter)
    expect(rows[0].run_id).toBe('run-L3')
    expect(rows[1].run_id).toBe('run-L2')
    expect(rows[2].run_id).toBe('run-L1')
  })

  it('respects the limit parameter', async () => {
    const rows = await listRunMetrics(adapter, 2)
    expect(rows).toHaveLength(2)
    expect(rows[0].run_id).toBe('run-L3')
    expect(rows[1].run_id).toBe('run-L2')
  })

  it('returns empty array when no rows exist', async () => {
    const emptyAdapter = await openDb()
    expect(await listRunMetrics(emptyAdapter)).toHaveLength(0)
    await emptyAdapter.close()
  })

  it('defaults to limit 10', async () => {
    const adapter2 = await openDb()
    for (let i = 1; i <= 12; i++) {
      await seedRunMetrics(adapter2, {
        run_id: `bulk-run-${i}`,
        started_at: `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`,
      })
    }
    const rows = await listRunMetrics(adapter2)
    expect(rows).toHaveLength(10)
    await adapter2.close()
  })
})

describe('tagRunAsBaseline / getBaselineRunMetrics (T10)', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    await seedRunMetrics(adapter, { run_id: 'run-B1' })
    await seedRunMetrics(adapter, { run_id: 'run-B2' })
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns undefined when no baseline is set', async () => {
    expect(await getBaselineRunMetrics(adapter)).toBeUndefined()
  })

  it('marks a run as baseline and returns it', async () => {
    await tagRunAsBaseline(adapter, 'run-B1')
    const baseline = await getBaselineRunMetrics(adapter)
    expect(baseline).toBeDefined()
    expect(baseline!.run_id).toBe('run-B1')
    expect(baseline!.is_baseline).toBe(1)
  })

  it('clears previous baseline when a new one is set', async () => {
    await tagRunAsBaseline(adapter, 'run-B1')
    await tagRunAsBaseline(adapter, 'run-B2')
    const baseline = await getBaselineRunMetrics(adapter)
    expect(baseline!.run_id).toBe('run-B2')

    // Verify old baseline was cleared
    const oldRun = (await getRunMetrics(adapter, 'run-B1'))!
    expect(oldRun.is_baseline).toBe(0)
  })

  it('updates is_baseline field on getRunMetrics after tagging', async () => {
    await tagRunAsBaseline(adapter, 'run-B1')
    expect((await getRunMetrics(adapter, 'run-B1'))!.is_baseline).toBe(1)
    await tagRunAsBaseline(adapter, 'run-B2')
    expect((await getRunMetrics(adapter, 'run-B1'))!.is_baseline).toBe(0)
    expect((await getRunMetrics(adapter, 'run-B2'))!.is_baseline).toBe(1)
  })
})

describe('compareRunMetrics (T10)', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    await seedRunMetrics(adapter, {
      run_id: 'run-C1',
      total_input_tokens: 1000,
      total_output_tokens: 500,
      total_cost_usd: 0.02,
      wall_clock_seconds: 200,
      total_review_cycles: 4,
    })
    await seedRunMetrics(adapter, {
      run_id: 'run-C2',
      total_input_tokens: 1200,
      total_output_tokens: 600,
      total_cost_usd: 0.03,
      wall_clock_seconds: 250,
      total_review_cycles: 6,
    })
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns null when run A does not exist', async () => {
    expect(await compareRunMetrics(adapter, 'ghost', 'run-C2')).toBeNull()
  })

  it('returns null when run B does not exist', async () => {
    expect(await compareRunMetrics(adapter, 'run-C1', 'ghost')).toBeNull()
  })

  it('computes correct token deltas (positive when B > A)', async () => {
    const delta = (await compareRunMetrics(adapter, 'run-C1', 'run-C2'))!
    expect(delta).not.toBeNull()
    expect(delta.token_input_delta).toBe(200)
    expect(delta.token_output_delta).toBe(100)
  })

  it('computes correct token percentage deltas', async () => {
    const delta = (await compareRunMetrics(adapter, 'run-C1', 'run-C2'))!
    // 200 / 1000 = 20%
    expect(delta.token_input_pct).toBeCloseTo(20)
    // 100 / 500 = 20%
    expect(delta.token_output_pct).toBeCloseTo(20)
  })

  it('computes correct wall clock delta', async () => {
    const delta = (await compareRunMetrics(adapter, 'run-C1', 'run-C2'))!
    expect(delta.wall_clock_delta_seconds).toBeCloseTo(50)
    // 50 / 200 = 25%
    expect(delta.wall_clock_pct).toBeCloseTo(25)
  })

  it('computes correct review cycle delta', async () => {
    const delta = (await compareRunMetrics(adapter, 'run-C1', 'run-C2'))!
    expect(delta.review_cycles_delta).toBe(2)
    // 2 / 4 = 50%
    expect(delta.review_cycles_pct).toBeCloseTo(50)
  })

  it('computes correct cost delta', async () => {
    const delta = (await compareRunMetrics(adapter, 'run-C1', 'run-C2'))!
    expect(delta.cost_delta).toBeCloseTo(0.01)
    // 0.01 / 0.02 = 50%
    expect(delta.cost_pct).toBeCloseTo(50)
  })

  it('returns negative deltas when B < A', async () => {
    // Swap A and B
    const delta = (await compareRunMetrics(adapter, 'run-C2', 'run-C1'))!
    expect(delta.token_input_delta).toBe(-200)
    expect(delta.token_input_pct).toBeCloseTo(-16.7)
  })

  it('returns null pct fields when base values are zero (undefined/infinite change)', async () => {
    await seedRunMetrics(adapter, {
      run_id: 'run-zero',
      total_input_tokens: 0,
      total_review_cycles: 0,
      wall_clock_seconds: 0,
    })
    const delta = (await compareRunMetrics(adapter, 'run-zero', 'run-C1'))!
    expect(delta.token_input_pct).toBeNull()
    expect(delta.review_cycles_pct).toBeNull()
    expect(delta.wall_clock_pct).toBeNull()
  })

  it('populates run_id_a and run_id_b correctly', async () => {
    const delta = (await compareRunMetrics(adapter, 'run-C1', 'run-C2'))!
    expect(delta.run_id_a).toBe('run-C1')
    expect(delta.run_id_b).toBe('run-C2')
  })
})

describe('getRunSummaryForSupervisor (T10 / AC5)', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
    await seedRunMetrics(adapter, {
      run_id: 'run-sup-1',
      total_input_tokens: 1000,
      total_output_tokens: 500,
      total_review_cycles: 4,
    })
    await writeStoryMetrics(adapter, { run_id: 'run-sup-1', story_key: '17-1', result: 'success' })
    await writeStoryMetrics(adapter, { run_id: 'run-sup-1', story_key: '17-2', result: 'failed' })
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns null for an unknown run', async () => {
    expect(await getRunSummaryForSupervisor(adapter, 'no-such-run')).toBeNull()
  })

  it('returns the run row and story rows', async () => {
    const summary = (await getRunSummaryForSupervisor(adapter, 'run-sup-1'))!
    expect(summary).not.toBeNull()
    expect(summary.run.run_id).toBe('run-sup-1')
    expect(summary.stories).toHaveLength(2)
    expect(summary.stories.map((s) => s.story_key)).toEqual(['17-1', '17-2'])
  })

  it('returns undefined baseline when none is set', async () => {
    const summary = (await getRunSummaryForSupervisor(adapter, 'run-sup-1'))!
    expect(summary.baseline).toBeUndefined()
    expect(summary.token_vs_baseline_pct).toBeNull()
    expect(summary.review_cycles_vs_baseline_pct).toBeNull()
  })

  it('computes token_vs_baseline_pct when baseline exists', async () => {
    // Seed baseline run with known token counts
    await seedRunMetrics(adapter, {
      run_id: 'run-baseline',
      total_input_tokens: 800,
      total_output_tokens: 400,
      total_review_cycles: 2,
    })
    await tagRunAsBaseline(adapter, 'run-baseline')

    const summary = (await getRunSummaryForSupervisor(adapter, 'run-sup-1'))!
    expect(summary.baseline).toBeDefined()
    expect(summary.baseline!.run_id).toBe('run-baseline')
    // Tokens: run=1500, baseline=1200 → pct = (1500-1200)/1200 * 100 = 25%
    expect(summary.token_vs_baseline_pct).toBeCloseTo(25)
  })

  it('computes review_cycles_vs_baseline_pct correctly', async () => {
    await seedRunMetrics(adapter, {
      run_id: 'run-baseline2',
      total_input_tokens: 1000,
      total_output_tokens: 500,
      total_review_cycles: 2,
    })
    await tagRunAsBaseline(adapter, 'run-baseline2')

    const summary = (await getRunSummaryForSupervisor(adapter, 'run-sup-1'))!
    // cycles: run=4, baseline=2 → pct = (4-2)/2 * 100 = 100%
    expect(summary.review_cycles_vs_baseline_pct).toBeCloseTo(100)
  })

  it('returns null deltas when the run IS the baseline', async () => {
    await tagRunAsBaseline(adapter, 'run-sup-1')
    const summary = (await getRunSummaryForSupervisor(adapter, 'run-sup-1'))!
    // When the queried run is the baseline, skip delta calculation
    expect(summary.token_vs_baseline_pct).toBeNull()
    expect(summary.review_cycles_vs_baseline_pct).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// aggregateTokenUsageForStory (T9 — previously untested)
// ---------------------------------------------------------------------------

describe('aggregateTokenUsageForStory', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  function insertTokenUsageWithMetadata(
    adapter: WasmSqliteDatabaseAdapter,
    runId: string,
    phase: string,
    input: number,
    output: number,
    cost: number,
    metadata: string | null,
  ): void {
    adapter.querySync(
      `INSERT INTO token_usage (pipeline_run_id, phase, agent, input_tokens, output_tokens, cost_usd, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [runId, phase, 'claude', input, output, cost, metadata],
    )
  }

  it('returns zeros when no token_usage rows exist for the run', async () => {
    insertPipelineRun(adapter, 'run-story-empty')
    const agg = await aggregateTokenUsageForStory(adapter, 'run-story-empty', '17-1')
    expect(agg.input).toBe(0)
    expect(agg.output).toBe(0)
    expect(agg.cost).toBe(0)
  })

  it('returns zeros when no rows match the given storyKey', async () => {
    insertPipelineRun(adapter, 'run-story-nomatch')
    insertTokenUsageWithMetadata(
      adapter, 'run-story-nomatch', 'dev-story', 100, 50, 0.005,
      JSON.stringify({ storyKey: '17-2' }),
    )
    const agg = await aggregateTokenUsageForStory(adapter, 'run-story-nomatch', '17-1')
    expect(agg.input).toBe(0)
    expect(agg.output).toBe(0)
    expect(agg.cost).toBe(0)
  })

  it('returns zeros when metadata is NULL', async () => {
    insertPipelineRun(adapter, 'run-story-null-meta')
    insertTokenUsageWithMetadata(
      adapter, 'run-story-null-meta', 'dev-story', 100, 50, 0.005, null,
    )
    const agg = await aggregateTokenUsageForStory(adapter, 'run-story-null-meta', '17-1')
    expect(agg.input).toBe(0)
    expect(agg.output).toBe(0)
    expect(agg.cost).toBe(0)
  })

  it('aggregates only rows matching the given storyKey', async () => {
    insertPipelineRun(adapter, 'run-story-match')
    // Matching rows for story 17-1
    insertTokenUsageWithMetadata(
      adapter, 'run-story-match', 'dev-story', 100, 50, 0.005,
      JSON.stringify({ storyKey: '17-1' }),
    )
    insertTokenUsageWithMetadata(
      adapter, 'run-story-match', 'code-review', 200, 80, 0.010,
      JSON.stringify({ storyKey: '17-1' }),
    )
    // Non-matching row for story 17-2
    insertTokenUsageWithMetadata(
      adapter, 'run-story-match', 'dev-story', 999, 999, 0.999,
      JSON.stringify({ storyKey: '17-2' }),
    )
    const agg = await aggregateTokenUsageForStory(adapter, 'run-story-match', '17-1')
    expect(agg.input).toBe(300)
    expect(agg.output).toBe(130)
    expect(agg.cost).toBeCloseTo(0.015)
  })

  it('does not aggregate rows from a different run', async () => {
    insertPipelineRun(adapter, 'run-story-other-run-a')
    insertPipelineRun(adapter, 'run-story-other-run-b')
    insertTokenUsageWithMetadata(
      adapter, 'run-story-other-run-a', 'dev-story', 500, 200, 0.02,
      JSON.stringify({ storyKey: '17-1' }),
    )
    const agg = await aggregateTokenUsageForStory(adapter, 'run-story-other-run-b', '17-1')
    expect(agg.input).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// incrementRunRestarts
// ---------------------------------------------------------------------------

describe('incrementRunRestarts', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('increments restarts from 0 to 1 on first call', async () => {
    await seedRunMetrics(adapter, { run_id: 'run-restart-1', restarts: 0 })
    await incrementRunRestarts(adapter, 'run-restart-1')
    expect((await getRunMetrics(adapter, 'run-restart-1'))!.restarts).toBe(1)
  })

  it('increments restarts multiple times correctly', async () => {
    await seedRunMetrics(adapter, { run_id: 'run-restart-2', restarts: 0 })
    await incrementRunRestarts(adapter, 'run-restart-2')
    await incrementRunRestarts(adapter, 'run-restart-2')
    await incrementRunRestarts(adapter, 'run-restart-2')
    expect((await getRunMetrics(adapter, 'run-restart-2'))!.restarts).toBe(3)
  })

  it('does not throw when the run_id does not yet exist', async () => {
    // Should not throw — inserts a placeholder row so the count is preserved
    await expect(incrementRunRestarts(adapter, 'nonexistent-run')).resolves.not.toThrow()
  })

  it('preserves restart count when writeRunMetrics is called after incrementRunRestarts on nonexistent row', async () => {
    // Simulates the real pipeline sequence: supervisor restarts before
    // writeRunMetrics has ever been called for a run_id.
    await incrementRunRestarts(adapter, 'run-restart-preexist')
    await incrementRunRestarts(adapter, 'run-restart-preexist')
    // Now writeRunMetrics is called at pipeline terminal state
    await writeRunMetrics(adapter, {
      run_id: 'run-restart-preexist',
      methodology: 'bmad',
      status: 'completed',
      started_at: '2026-01-01T00:00:00.000Z',
    })
    expect((await getRunMetrics(adapter, 'run-restart-preexist'))!.restarts).toBe(2)
  })

  it('does not affect other runs', async () => {
    await seedRunMetrics(adapter, { run_id: 'run-restart-3a', restarts: 0 })
    await seedRunMetrics(adapter, { run_id: 'run-restart-3b', restarts: 0 })
    await incrementRunRestarts(adapter, 'run-restart-3a')
    expect((await getRunMetrics(adapter, 'run-restart-3b'))!.restarts).toBe(0)
  })
})
