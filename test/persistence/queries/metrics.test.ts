/**
 * Tests for metrics query functions (Story 17-2).
 *
 * Covers: writeRunMetrics, writeStoryMetrics, listRunMetrics, getRunMetrics,
 *         getStoryMetricsForRun, compareRunMetrics, tagRunAsBaseline,
 *         getBaselineRunMetrics, aggregateTokenUsageForRun.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../src/persistence/migrations/index.js'
import {
  writeRunMetrics,
  writeStoryMetrics,
  getRunMetrics,
  listRunMetrics,
  getStoryMetricsForRun,
  compareRunMetrics,
  tagRunAsBaseline,
  getBaselineRunMetrics,
  aggregateTokenUsageForRun,
} from '../../../src/persistence/queries/metrics.js'

function openMemoryDb(): BetterSqlite3Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

const BASE_RUN: Parameters<typeof writeRunMetrics>[1] = {
  run_id: 'run-001',
  methodology: 'bmad',
  status: 'completed',
  started_at: '2026-01-01T00:00:00Z',
  completed_at: '2026-01-01T00:05:00Z',
  wall_clock_seconds: 300,
  total_input_tokens: 10000,
  total_output_tokens: 5000,
  total_cost_usd: 0.05,
  stories_attempted: 2,
  stories_succeeded: 2,
  stories_failed: 0,
  stories_escalated: 0,
  total_review_cycles: 3,
  total_dispatches: 6,
  concurrency_setting: 3,
}

describe('run metrics queries', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  describe('writeRunMetrics', () => {
    it('inserts a run metrics row without error', () => {
      expect(() => writeRunMetrics(db, BASE_RUN)).not.toThrow()
    })

    it('round-trips the run metrics row', () => {
      writeRunMetrics(db, BASE_RUN)
      const row = getRunMetrics(db, 'run-001')
      expect(row).toBeDefined()
      expect(row?.run_id).toBe('run-001')
      expect(row?.methodology).toBe('bmad')
      expect(row?.status).toBe('completed')
      expect(row?.total_input_tokens).toBe(10000)
      expect(row?.total_output_tokens).toBe(5000)
      expect(row?.total_cost_usd).toBe(0.05)
      expect(row?.stories_attempted).toBe(2)
      expect(row?.stories_succeeded).toBe(2)
      expect(row?.stories_failed).toBe(0)
      expect(row?.stories_escalated).toBe(0)
      expect(row?.total_review_cycles).toBe(3)
      expect(row?.total_dispatches).toBe(6)
      expect(row?.concurrency_setting).toBe(3)
      expect(row?.is_baseline).toBe(0)
    })

    it('upserts on repeated write (INSERT OR REPLACE)', () => {
      writeRunMetrics(db, BASE_RUN)
      writeRunMetrics(db, { ...BASE_RUN, status: 'failed', stories_failed: 1 })
      const row = getRunMetrics(db, 'run-001')
      expect(row?.status).toBe('failed')
      expect(row?.stories_failed).toBe(1)
    })

    it('uses defaults for optional fields', () => {
      writeRunMetrics(db, {
        run_id: 'run-min',
        methodology: 'bmad',
        status: 'running',
        started_at: '2026-01-01T00:00:00Z',
      })
      const row = getRunMetrics(db, 'run-min')
      expect(row?.total_input_tokens).toBe(0)
      expect(row?.total_output_tokens).toBe(0)
      expect(row?.is_baseline).toBe(0)
      expect(row?.restarts).toBe(0)
    })
  })

  describe('getRunMetrics', () => {
    it('returns undefined for unknown run_id', () => {
      expect(getRunMetrics(db, 'nonexistent')).toBeUndefined()
    })

    it('returns the correct row for known run_id', () => {
      writeRunMetrics(db, BASE_RUN)
      const row = getRunMetrics(db, 'run-001')
      expect(row?.run_id).toBe('run-001')
    })
  })

  describe('listRunMetrics', () => {
    it('returns empty array when no rows exist', () => {
      expect(listRunMetrics(db)).toEqual([])
    })

    it('returns all rows when fewer than limit', () => {
      writeRunMetrics(db, BASE_RUN)
      writeRunMetrics(db, { ...BASE_RUN, run_id: 'run-002', started_at: '2026-01-02T00:00:00Z' })
      const rows = listRunMetrics(db)
      expect(rows).toHaveLength(2)
    })

    it('respects limit parameter', () => {
      for (let i = 1; i <= 5; i++) {
        writeRunMetrics(db, {
          ...BASE_RUN,
          run_id: `run-00${i}`,
          started_at: `2026-01-0${i}T00:00:00Z`,
        })
      }
      const rows = listRunMetrics(db, 3)
      expect(rows).toHaveLength(3)
    })

    it('returns rows in descending started_at order', () => {
      writeRunMetrics(db, { ...BASE_RUN, run_id: 'run-a', started_at: '2026-01-01T00:00:00Z' })
      writeRunMetrics(db, { ...BASE_RUN, run_id: 'run-b', started_at: '2026-01-03T00:00:00Z' })
      writeRunMetrics(db, { ...BASE_RUN, run_id: 'run-c', started_at: '2026-01-02T00:00:00Z' })
      const rows = listRunMetrics(db)
      expect(rows[0].run_id).toBe('run-b')
      expect(rows[1].run_id).toBe('run-c')
      expect(rows[2].run_id).toBe('run-a')
    })
  })

  describe('tagRunAsBaseline', () => {
    it('marks the run as baseline', () => {
      writeRunMetrics(db, BASE_RUN)
      tagRunAsBaseline(db, 'run-001')
      const row = getRunMetrics(db, 'run-001')
      expect(row?.is_baseline).toBe(1)
    })

    it('clears existing baseline when tagging a new one', () => {
      writeRunMetrics(db, BASE_RUN)
      writeRunMetrics(db, { ...BASE_RUN, run_id: 'run-002', started_at: '2026-01-02T00:00:00Z' })
      tagRunAsBaseline(db, 'run-001')
      tagRunAsBaseline(db, 'run-002')
      const row1 = getRunMetrics(db, 'run-001')
      const row2 = getRunMetrics(db, 'run-002')
      expect(row1?.is_baseline).toBe(0)
      expect(row2?.is_baseline).toBe(1)
    })
  })

  describe('getBaselineRunMetrics', () => {
    it('returns undefined when no baseline is set', () => {
      writeRunMetrics(db, BASE_RUN)
      expect(getBaselineRunMetrics(db)).toBeUndefined()
    })

    it('returns the baseline row after tagging', () => {
      writeRunMetrics(db, BASE_RUN)
      tagRunAsBaseline(db, 'run-001')
      const baseline = getBaselineRunMetrics(db)
      expect(baseline?.run_id).toBe('run-001')
    })
  })

  describe('compareRunMetrics', () => {
    beforeEach(() => {
      writeRunMetrics(db, BASE_RUN)
      writeRunMetrics(db, {
        ...BASE_RUN,
        run_id: 'run-002',
        started_at: '2026-01-02T00:00:00Z',
        total_input_tokens: 12000,
        total_output_tokens: 6000,
        wall_clock_seconds: 360,
        total_review_cycles: 4,
        total_cost_usd: 0.06,
      })
    })

    it('returns null when run A is not found', () => {
      expect(compareRunMetrics(db, 'unknown', 'run-002')).toBeNull()
    })

    it('returns null when run B is not found', () => {
      expect(compareRunMetrics(db, 'run-001', 'unknown')).toBeNull()
    })

    it('computes correct token deltas', () => {
      const delta = compareRunMetrics(db, 'run-001', 'run-002')
      expect(delta).not.toBeNull()
      expect(delta?.token_input_delta).toBe(2000)   // 12000 - 10000
      expect(delta?.token_output_delta).toBe(1000)  // 6000 - 5000
    })

    it('computes correct token percentage deltas', () => {
      const delta = compareRunMetrics(db, 'run-001', 'run-002')
      expect(delta?.token_input_pct).toBe(20)  // 2000/10000 * 100
      expect(delta?.token_output_pct).toBe(20) // 1000/5000 * 100
    })

    it('computes correct wall clock delta', () => {
      const delta = compareRunMetrics(db, 'run-001', 'run-002')
      expect(delta?.wall_clock_delta_seconds).toBe(60) // 360 - 300
    })

    it('computes correct review cycle delta', () => {
      const delta = compareRunMetrics(db, 'run-001', 'run-002')
      expect(delta?.review_cycles_delta).toBe(1) // 4 - 3
    })

    it('includes run IDs in result', () => {
      const delta = compareRunMetrics(db, 'run-001', 'run-002')
      expect(delta?.run_id_a).toBe('run-001')
      expect(delta?.run_id_b).toBe('run-002')
    })
  })
})

describe('story metrics queries', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMemoryDb()
    // story_metrics has run_id FK — write a run_metrics row first
    writeRunMetrics(db, {
      run_id: 'run-001',
      methodology: 'bmad',
      status: 'running',
      started_at: '2026-01-01T00:00:00Z',
    })
  })

  afterEach(() => {
    db.close()
  })

  describe('writeStoryMetrics', () => {
    it('inserts a story metrics row without error', () => {
      expect(() => writeStoryMetrics(db, {
        run_id: 'run-001',
        story_key: '17-1',
        result: 'success',
        review_cycles: 2,
        dispatches: 3,
      })).not.toThrow()
    })

    it('round-trips the story metrics row', () => {
      writeStoryMetrics(db, {
        run_id: 'run-001',
        story_key: '17-1',
        result: 'success',
        phase_durations_json: '{"create-story":10,"dev-story":120,"code-review":30}',
        review_cycles: 2,
        dispatches: 4,
        input_tokens: 5000,
        output_tokens: 2000,
        cost_usd: 0.02,
      })
      const rows = getStoryMetricsForRun(db, 'run-001')
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(row.story_key).toBe('17-1')
      expect(row.result).toBe('success')
      expect(row.review_cycles).toBe(2)
      expect(row.dispatches).toBe(4)
      expect(row.phase_durations_json).toBe('{"create-story":10,"dev-story":120,"code-review":30}')
    })

    it('upserts on repeated write (ON CONFLICT)', () => {
      writeStoryMetrics(db, {
        run_id: 'run-001',
        story_key: '17-1',
        result: 'escalated',
        review_cycles: 0,
        dispatches: 1,
      })
      writeStoryMetrics(db, {
        run_id: 'run-001',
        story_key: '17-1',
        result: 'success',
        review_cycles: 2,
        dispatches: 4,
      })
      const rows = getStoryMetricsForRun(db, 'run-001')
      expect(rows).toHaveLength(1)
      expect(rows[0].result).toBe('success')
      expect(rows[0].review_cycles).toBe(2)
    })

    it('stores result=failed correctly', () => {
      writeStoryMetrics(db, {
        run_id: 'run-001',
        story_key: '17-2',
        result: 'failed',
      })
      const rows = getStoryMetricsForRun(db, 'run-001')
      expect(rows[0].result).toBe('failed')
    })

    it('uses 0 defaults for optional numeric fields', () => {
      writeStoryMetrics(db, {
        run_id: 'run-001',
        story_key: '17-3',
        result: 'success',
      })
      const rows = getStoryMetricsForRun(db, 'run-001')
      expect(rows[0].review_cycles).toBe(0)
      expect(rows[0].dispatches).toBe(0)
      expect(rows[0].input_tokens).toBe(0)
    })
  })

  describe('getStoryMetricsForRun', () => {
    it('returns empty array when no rows exist for run', () => {
      expect(getStoryMetricsForRun(db, 'run-001')).toEqual([])
    })

    it('returns multiple story rows for a run', () => {
      writeStoryMetrics(db, { run_id: 'run-001', story_key: '17-1', result: 'success' })
      writeStoryMetrics(db, { run_id: 'run-001', story_key: '17-2', result: 'escalated' })
      const rows = getStoryMetricsForRun(db, 'run-001')
      expect(rows).toHaveLength(2)
    })

    it('does not return rows for other runs', () => {
      writeRunMetrics(db, {
        run_id: 'run-002',
        methodology: 'bmad',
        status: 'running',
        started_at: '2026-01-02T00:00:00Z',
      })
      writeStoryMetrics(db, { run_id: 'run-001', story_key: '17-1', result: 'success' })
      writeStoryMetrics(db, { run_id: 'run-002', story_key: '17-1', result: 'success' })
      expect(getStoryMetricsForRun(db, 'run-001')).toHaveLength(1)
    })
  })
})

describe('aggregateTokenUsageForRun', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('returns zeros when no token_usage rows exist for run', () => {
    const agg = aggregateTokenUsageForRun(db, 'nonexistent-run')
    expect(agg).toEqual({ input: 0, output: 0, cost: 0 })
  })

  it('aggregates token_usage rows for a run', () => {
    // Insert a pipeline run and token usage records
    db.exec(`INSERT INTO pipeline_runs (id, methodology, current_phase, status, created_at, updated_at)
      VALUES ('run-tok', 'bmad', 'implementation', 'running', datetime('now'), datetime('now'))`)
    db.prepare(`INSERT INTO token_usage (pipeline_run_id, phase, agent, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('run-tok', 'create-story', 'claude-code', 1000, 500, 0.01)
    db.prepare(`INSERT INTO token_usage (pipeline_run_id, phase, agent, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('run-tok', 'dev-story', 'claude-code', 2000, 1000, 0.02)

    const agg = aggregateTokenUsageForRun(db, 'run-tok')
    expect(agg.input).toBe(3000)
    expect(agg.output).toBe(1500)
    expect(agg.cost).toBeCloseTo(0.03, 5)
  })
})
