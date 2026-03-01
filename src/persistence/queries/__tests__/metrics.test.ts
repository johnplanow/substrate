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
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../migrations/index.js'
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

function openDb(): BetterSqlite3Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

function insertPipelineRun(db: BetterSqlite3Database, id: string, status = 'completed'): void {
  db.prepare(
    `INSERT INTO pipeline_runs (id, methodology, status, parent_run_id, created_at, updated_at)
     VALUES (?, 'bmad', ?, NULL, datetime('now'), datetime('now'))`,
  ).run(id, status)
}

function seedRunMetrics(
  db: BetterSqlite3Database,
  overrides: Partial<RunMetricsInput> & { run_id: string },
): void {
  const { run_id, ...rest } = overrides
  writeRunMetrics(db, {
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
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
  })

  afterEach(() => {
    db.close()
  })

  it('inserts a row with all required fields', () => {
    seedRunMetrics(db, { run_id: 'run-001' })
    const row = getRunMetrics(db, 'run-001')
    expect(row).toBeDefined()
    expect(row!.run_id).toBe('run-001')
    expect(row!.methodology).toBe('bmad')
    expect(row!.status).toBe('completed')
  })

  it('stores optional numeric fields with defaults of 0', () => {
    seedRunMetrics(db, { run_id: 'run-002' })
    const row = getRunMetrics(db, 'run-002')!
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

  it('stores all provided optional fields correctly', () => {
    seedRunMetrics(db, {
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
    const row = getRunMetrics(db, 'run-003')!
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

  it('upserts (INSERT OR REPLACE) on duplicate run_id', () => {
    seedRunMetrics(db, { run_id: 'run-004', total_input_tokens: 100 })
    seedRunMetrics(db, { run_id: 'run-004', total_input_tokens: 200 })
    const row = getRunMetrics(db, 'run-004')!
    expect(row.total_input_tokens).toBe(200)
  })

  it('returns undefined for an unknown run_id', () => {
    const row = getRunMetrics(db, 'nonexistent')
    expect(row).toBeUndefined()
  })
})

describe('writeStoryMetrics (T9)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
  })

  afterEach(() => {
    db.close()
  })

  it('inserts a story metrics row', () => {
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
    writeStoryMetrics(db, input)
    const rows = getStoryMetricsForRun(db, 'run-s1')
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.story_key).toBe('17-1')
    expect(row.result).toBe('success')
    expect(row.input_tokens).toBe(500)
    expect(row.output_tokens).toBe(200)
    expect(row.review_cycles).toBe(2)
  })

  it('upserts on duplicate run_id + story_key', () => {
    const base: StoryMetricsInput = { run_id: 'run-s2', story_key: '17-1', result: 'failed' }
    writeStoryMetrics(db, base)
    writeStoryMetrics(db, { ...base, result: 'success', input_tokens: 999 })
    const rows = getStoryMetricsForRun(db, 'run-s2')
    expect(rows).toHaveLength(1)
    expect(rows[0].result).toBe('success')
    expect(rows[0].input_tokens).toBe(999)
  })

  it('stores phase_durations_json as a JSON string', () => {
    const durations = { 'create-story': 30, 'dev-story': 90 }
    writeStoryMetrics(db, {
      run_id: 'run-s3',
      story_key: '17-2',
      result: 'success',
      phase_durations_json: JSON.stringify(durations),
    })
    const rows = getStoryMetricsForRun(db, 'run-s3')
    expect(rows[0].phase_durations_json).toBe(JSON.stringify(durations))
  })

  it('returns empty array for run with no story metrics', () => {
    expect(getStoryMetricsForRun(db, 'no-such-run')).toHaveLength(0)
  })

  it('returns all stories for a run in insertion order', () => {
    writeStoryMetrics(db, { run_id: 'run-s4', story_key: 'A', result: 'success' })
    writeStoryMetrics(db, { run_id: 'run-s4', story_key: 'B', result: 'failed' })
    writeStoryMetrics(db, { run_id: 'run-s4', story_key: 'C', result: 'escalated' })
    const rows = getStoryMetricsForRun(db, 'run-s4')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.story_key)).toEqual(['A', 'B', 'C'])
  })
})

describe('aggregateTokenUsageForRun (T9)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
  })

  afterEach(() => {
    db.close()
  })

  it('returns zeros when no token_usage rows exist for the run', () => {
    const agg = aggregateTokenUsageForRun(db, 'run-tok-empty')
    expect(agg.input).toBe(0)
    expect(agg.output).toBe(0)
    expect(agg.cost).toBe(0)
  })

  it('aggregates token rows for a specific pipeline run', () => {
    // Insert a pipeline_run and token_usage rows directly
    insertPipelineRun(db, 'run-tok-1')
    db.prepare(
      `INSERT INTO token_usage (pipeline_run_id, phase, agent, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('run-tok-1', 'dev-story', 'claude', 100, 50, 0.005)
    db.prepare(
      `INSERT INTO token_usage (pipeline_run_id, phase, agent, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('run-tok-1', 'code-review', 'claude', 200, 100, 0.010)

    const agg = aggregateTokenUsageForRun(db, 'run-tok-1')
    expect(agg.input).toBe(300)
    expect(agg.output).toBe(150)
    expect(agg.cost).toBeCloseTo(0.015)
  })

  it('does not aggregate rows from a different run', () => {
    insertPipelineRun(db, 'run-tok-2a')
    insertPipelineRun(db, 'run-tok-2b')
    db.prepare(
      `INSERT INTO token_usage (pipeline_run_id, phase, agent, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('run-tok-2a', 'dev-story', 'claude', 999, 888, 0.099)

    const agg = aggregateTokenUsageForRun(db, 'run-tok-2b')
    expect(agg.input).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// T10: Metrics Query and Comparison
// ---------------------------------------------------------------------------

describe('listRunMetrics (T10)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
    // Seed three runs with distinct started_at values
    seedRunMetrics(db, { run_id: 'run-L1', started_at: '2026-01-01T00:00:00.000Z' })
    seedRunMetrics(db, { run_id: 'run-L2', started_at: '2026-01-02T00:00:00.000Z' })
    seedRunMetrics(db, { run_id: 'run-L3', started_at: '2026-01-03T00:00:00.000Z' })
  })

  afterEach(() => {
    db.close()
  })

  it('returns rows newest first', () => {
    const rows = listRunMetrics(db)
    expect(rows[0].run_id).toBe('run-L3')
    expect(rows[1].run_id).toBe('run-L2')
    expect(rows[2].run_id).toBe('run-L1')
  })

  it('respects the limit parameter', () => {
    const rows = listRunMetrics(db, 2)
    expect(rows).toHaveLength(2)
    expect(rows[0].run_id).toBe('run-L3')
    expect(rows[1].run_id).toBe('run-L2')
  })

  it('returns empty array when no rows exist', () => {
    const emptyDb = openDb()
    expect(listRunMetrics(emptyDb)).toHaveLength(0)
    emptyDb.close()
  })

  it('defaults to limit 10', () => {
    const db2 = openDb()
    for (let i = 1; i <= 12; i++) {
      seedRunMetrics(db2, {
        run_id: `bulk-run-${i}`,
        started_at: `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`,
      })
    }
    const rows = listRunMetrics(db2)
    expect(rows).toHaveLength(10)
    db2.close()
  })
})

describe('tagRunAsBaseline / getBaselineRunMetrics (T10)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
    seedRunMetrics(db, { run_id: 'run-B1' })
    seedRunMetrics(db, { run_id: 'run-B2' })
  })

  afterEach(() => {
    db.close()
  })

  it('returns undefined when no baseline is set', () => {
    expect(getBaselineRunMetrics(db)).toBeUndefined()
  })

  it('marks a run as baseline and returns it', () => {
    tagRunAsBaseline(db, 'run-B1')
    const baseline = getBaselineRunMetrics(db)
    expect(baseline).toBeDefined()
    expect(baseline!.run_id).toBe('run-B1')
    expect(baseline!.is_baseline).toBe(1)
  })

  it('clears previous baseline when a new one is set', () => {
    tagRunAsBaseline(db, 'run-B1')
    tagRunAsBaseline(db, 'run-B2')
    const baseline = getBaselineRunMetrics(db)
    expect(baseline!.run_id).toBe('run-B2')

    // Verify old baseline was cleared
    const oldRun = getRunMetrics(db, 'run-B1')!
    expect(oldRun.is_baseline).toBe(0)
  })

  it('updates is_baseline field on getRunMetrics after tagging', () => {
    tagRunAsBaseline(db, 'run-B1')
    expect(getRunMetrics(db, 'run-B1')!.is_baseline).toBe(1)
    tagRunAsBaseline(db, 'run-B2')
    expect(getRunMetrics(db, 'run-B1')!.is_baseline).toBe(0)
    expect(getRunMetrics(db, 'run-B2')!.is_baseline).toBe(1)
  })
})

describe('compareRunMetrics (T10)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
    seedRunMetrics(db, {
      run_id: 'run-C1',
      total_input_tokens: 1000,
      total_output_tokens: 500,
      total_cost_usd: 0.02,
      wall_clock_seconds: 200,
      total_review_cycles: 4,
    })
    seedRunMetrics(db, {
      run_id: 'run-C2',
      total_input_tokens: 1200,
      total_output_tokens: 600,
      total_cost_usd: 0.03,
      wall_clock_seconds: 250,
      total_review_cycles: 6,
    })
  })

  afterEach(() => {
    db.close()
  })

  it('returns null when run A does not exist', () => {
    expect(compareRunMetrics(db, 'ghost', 'run-C2')).toBeNull()
  })

  it('returns null when run B does not exist', () => {
    expect(compareRunMetrics(db, 'run-C1', 'ghost')).toBeNull()
  })

  it('computes correct token deltas (positive when B > A)', () => {
    const delta = compareRunMetrics(db, 'run-C1', 'run-C2')!
    expect(delta).not.toBeNull()
    expect(delta.token_input_delta).toBe(200)
    expect(delta.token_output_delta).toBe(100)
  })

  it('computes correct token percentage deltas', () => {
    const delta = compareRunMetrics(db, 'run-C1', 'run-C2')!
    // 200 / 1000 = 20%
    expect(delta.token_input_pct).toBeCloseTo(20)
    // 100 / 500 = 20%
    expect(delta.token_output_pct).toBeCloseTo(20)
  })

  it('computes correct wall clock delta', () => {
    const delta = compareRunMetrics(db, 'run-C1', 'run-C2')!
    expect(delta.wall_clock_delta_seconds).toBeCloseTo(50)
    // 50 / 200 = 25%
    expect(delta.wall_clock_pct).toBeCloseTo(25)
  })

  it('computes correct review cycle delta', () => {
    const delta = compareRunMetrics(db, 'run-C1', 'run-C2')!
    expect(delta.review_cycles_delta).toBe(2)
    // 2 / 4 = 50%
    expect(delta.review_cycles_pct).toBeCloseTo(50)
  })

  it('computes correct cost delta', () => {
    const delta = compareRunMetrics(db, 'run-C1', 'run-C2')!
    expect(delta.cost_delta).toBeCloseTo(0.01)
    // 0.01 / 0.02 = 50%
    expect(delta.cost_pct).toBeCloseTo(50)
  })

  it('returns negative deltas when B < A', () => {
    // Swap A and B
    const delta = compareRunMetrics(db, 'run-C2', 'run-C1')!
    expect(delta.token_input_delta).toBe(-200)
    expect(delta.token_input_pct).toBeCloseTo(-16.7)
  })

  it('returns null pct fields when base values are zero (undefined/infinite change)', () => {
    seedRunMetrics(db, {
      run_id: 'run-zero',
      total_input_tokens: 0,
      total_review_cycles: 0,
      wall_clock_seconds: 0,
    })
    const delta = compareRunMetrics(db, 'run-zero', 'run-C1')!
    expect(delta.token_input_pct).toBeNull()
    expect(delta.review_cycles_pct).toBeNull()
    expect(delta.wall_clock_pct).toBeNull()
  })

  it('populates run_id_a and run_id_b correctly', () => {
    const delta = compareRunMetrics(db, 'run-C1', 'run-C2')!
    expect(delta.run_id_a).toBe('run-C1')
    expect(delta.run_id_b).toBe('run-C2')
  })
})

describe('getRunSummaryForSupervisor (T10 / AC5)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
    seedRunMetrics(db, {
      run_id: 'run-sup-1',
      total_input_tokens: 1000,
      total_output_tokens: 500,
      total_review_cycles: 4,
    })
    writeStoryMetrics(db, { run_id: 'run-sup-1', story_key: '17-1', result: 'success' })
    writeStoryMetrics(db, { run_id: 'run-sup-1', story_key: '17-2', result: 'failed' })
  })

  afterEach(() => {
    db.close()
  })

  it('returns null for an unknown run', () => {
    expect(getRunSummaryForSupervisor(db, 'no-such-run')).toBeNull()
  })

  it('returns the run row and story rows', () => {
    const summary = getRunSummaryForSupervisor(db, 'run-sup-1')!
    expect(summary).not.toBeNull()
    expect(summary.run.run_id).toBe('run-sup-1')
    expect(summary.stories).toHaveLength(2)
    expect(summary.stories.map((s) => s.story_key)).toEqual(['17-1', '17-2'])
  })

  it('returns undefined baseline when none is set', () => {
    const summary = getRunSummaryForSupervisor(db, 'run-sup-1')!
    expect(summary.baseline).toBeUndefined()
    expect(summary.token_vs_baseline_pct).toBeNull()
    expect(summary.review_cycles_vs_baseline_pct).toBeNull()
  })

  it('computes token_vs_baseline_pct when baseline exists', () => {
    // Seed baseline run with known token counts
    seedRunMetrics(db, {
      run_id: 'run-baseline',
      total_input_tokens: 800,
      total_output_tokens: 400,
      total_review_cycles: 2,
    })
    tagRunAsBaseline(db, 'run-baseline')

    const summary = getRunSummaryForSupervisor(db, 'run-sup-1')!
    expect(summary.baseline).toBeDefined()
    expect(summary.baseline!.run_id).toBe('run-baseline')
    // Tokens: run=1500, baseline=1200 → pct = (1500-1200)/1200 * 100 = 25%
    expect(summary.token_vs_baseline_pct).toBeCloseTo(25)
  })

  it('computes review_cycles_vs_baseline_pct correctly', () => {
    seedRunMetrics(db, {
      run_id: 'run-baseline2',
      total_input_tokens: 1000,
      total_output_tokens: 500,
      total_review_cycles: 2,
    })
    tagRunAsBaseline(db, 'run-baseline2')

    const summary = getRunSummaryForSupervisor(db, 'run-sup-1')!
    // cycles: run=4, baseline=2 → pct = (4-2)/2 * 100 = 100%
    expect(summary.review_cycles_vs_baseline_pct).toBeCloseTo(100)
  })

  it('returns null deltas when the run IS the baseline', () => {
    tagRunAsBaseline(db, 'run-sup-1')
    const summary = getRunSummaryForSupervisor(db, 'run-sup-1')!
    // When the queried run is the baseline, skip delta calculation
    expect(summary.token_vs_baseline_pct).toBeNull()
    expect(summary.review_cycles_vs_baseline_pct).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// aggregateTokenUsageForStory (T9 — previously untested)
// ---------------------------------------------------------------------------

describe('aggregateTokenUsageForStory', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
  })

  afterEach(() => {
    db.close()
  })

  function insertTokenUsageWithMetadata(
    db: BetterSqlite3Database,
    runId: string,
    phase: string,
    input: number,
    output: number,
    cost: number,
    metadata: string | null,
  ): void {
    db.prepare(
      `INSERT INTO token_usage (pipeline_run_id, phase, agent, input_tokens, output_tokens, cost_usd, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, phase, 'claude', input, output, cost, metadata)
  }

  it('returns zeros when no token_usage rows exist for the run', () => {
    insertPipelineRun(db, 'run-story-empty')
    const agg = aggregateTokenUsageForStory(db, 'run-story-empty', '17-1')
    expect(agg.input).toBe(0)
    expect(agg.output).toBe(0)
    expect(agg.cost).toBe(0)
  })

  it('returns zeros when no rows match the given storyKey', () => {
    insertPipelineRun(db, 'run-story-nomatch')
    insertTokenUsageWithMetadata(
      db, 'run-story-nomatch', 'dev-story', 100, 50, 0.005,
      JSON.stringify({ storyKey: '17-2' }),
    )
    const agg = aggregateTokenUsageForStory(db, 'run-story-nomatch', '17-1')
    expect(agg.input).toBe(0)
    expect(agg.output).toBe(0)
    expect(agg.cost).toBe(0)
  })

  it('returns zeros when metadata is NULL', () => {
    insertPipelineRun(db, 'run-story-null-meta')
    insertTokenUsageWithMetadata(
      db, 'run-story-null-meta', 'dev-story', 100, 50, 0.005, null,
    )
    const agg = aggregateTokenUsageForStory(db, 'run-story-null-meta', '17-1')
    expect(agg.input).toBe(0)
    expect(agg.output).toBe(0)
    expect(agg.cost).toBe(0)
  })

  it('aggregates only rows matching the given storyKey', () => {
    insertPipelineRun(db, 'run-story-match')
    // Matching rows for story 17-1
    insertTokenUsageWithMetadata(
      db, 'run-story-match', 'dev-story', 100, 50, 0.005,
      JSON.stringify({ storyKey: '17-1' }),
    )
    insertTokenUsageWithMetadata(
      db, 'run-story-match', 'code-review', 200, 80, 0.010,
      JSON.stringify({ storyKey: '17-1' }),
    )
    // Non-matching row for story 17-2
    insertTokenUsageWithMetadata(
      db, 'run-story-match', 'dev-story', 999, 999, 0.999,
      JSON.stringify({ storyKey: '17-2' }),
    )
    const agg = aggregateTokenUsageForStory(db, 'run-story-match', '17-1')
    expect(agg.input).toBe(300)
    expect(agg.output).toBe(130)
    expect(agg.cost).toBeCloseTo(0.015)
  })

  it('does not aggregate rows from a different run', () => {
    insertPipelineRun(db, 'run-story-other-run-a')
    insertPipelineRun(db, 'run-story-other-run-b')
    insertTokenUsageWithMetadata(
      db, 'run-story-other-run-a', 'dev-story', 500, 200, 0.02,
      JSON.stringify({ storyKey: '17-1' }),
    )
    const agg = aggregateTokenUsageForStory(db, 'run-story-other-run-b', '17-1')
    expect(agg.input).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// incrementRunRestarts
// ---------------------------------------------------------------------------

describe('incrementRunRestarts', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
  })

  afterEach(() => {
    db.close()
  })

  it('increments restarts from 0 to 1 on first call', () => {
    seedRunMetrics(db, { run_id: 'run-restart-1', restarts: 0 })
    incrementRunRestarts(db, 'run-restart-1')
    expect(getRunMetrics(db, 'run-restart-1')!.restarts).toBe(1)
  })

  it('increments restarts multiple times correctly', () => {
    seedRunMetrics(db, { run_id: 'run-restart-2', restarts: 0 })
    incrementRunRestarts(db, 'run-restart-2')
    incrementRunRestarts(db, 'run-restart-2')
    incrementRunRestarts(db, 'run-restart-2')
    expect(getRunMetrics(db, 'run-restart-2')!.restarts).toBe(3)
  })

  it('does not throw when the run_id does not yet exist', () => {
    // Should not throw — inserts a placeholder row so the count is preserved
    expect(() => incrementRunRestarts(db, 'nonexistent-run')).not.toThrow()
  })

  it('preserves restart count when writeRunMetrics is called after incrementRunRestarts on nonexistent row', () => {
    // Simulates the real pipeline sequence: supervisor restarts before
    // writeRunMetrics has ever been called for a run_id.
    incrementRunRestarts(db, 'run-restart-preexist')
    incrementRunRestarts(db, 'run-restart-preexist')
    // Now writeRunMetrics is called at pipeline terminal state
    writeRunMetrics(db, {
      run_id: 'run-restart-preexist',
      methodology: 'bmad',
      status: 'completed',
      started_at: '2026-01-01T00:00:00.000Z',
    })
    expect(getRunMetrics(db, 'run-restart-preexist')!.restarts).toBe(2)
  })

  it('does not affect other runs', () => {
    seedRunMetrics(db, { run_id: 'run-restart-3a', restarts: 0 })
    seedRunMetrics(db, { run_id: 'run-restart-3b', restarts: 0 })
    incrementRunRestarts(db, 'run-restart-3a')
    expect(getRunMetrics(db, 'run-restart-3b')!.restarts).toBe(0)
  })
})
