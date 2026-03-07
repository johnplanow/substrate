/**
 * Tests for Story 24-4 AC5/AC6: status command includes pipeline metrics v2.
 *
 * Validates that `substrate status --output-format json` includes:
 *   - story_metrics: per-story wall_clock_ms, phase_breakdown, tokens, review_cycles, dispatches
 *   - pipeline_metrics: total_wall_clock_ms, total_review_cycles, stories_per_hour, cost_usd (last)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { createPipelineRun } from '../../../persistence/queries/decisions.js'
import { writeStoryMetrics } from '../../../persistence/queries/metrics.js'
import { runStatusAction } from '../status.js'

// ---------------------------------------------------------------------------
// Mock resolveMainRepoRoot so the action uses an in-memory DB path override
// ---------------------------------------------------------------------------

const mockResolveMainRepoRoot = vi.fn()
vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: (...args: unknown[]) => mockResolveMainRepoRoot(...args),
}))

// Mock fs to skip the existsSync check on the db path
const mockExistsSync = vi.fn()
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}))

// We need to override DatabaseWrapper so we can inject our in-memory DB.
let _injectedDb: BetterSqlite3Database | null = null

vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    close: vi.fn(),
    get db() {
      return _injectedDb
    },
    get isOpen() {
      return true
    },
  })),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function createTestDb(): BetterSqlite3Database {
  const db = new Database(':memory:')
  runMigrations(db)
  return db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AC5/AC6: status --output-format json includes pipeline metrics v2', () => {
  let db: BetterSqlite3Database
  let stdoutChunks: string[]

  beforeEach(() => {
    db = createTestDb()
    _injectedDb = db

    stdoutChunks = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString())
      return true
    })

    mockExistsSync.mockReturnValue(true)
    mockResolveMainRepoRoot.mockResolvedValue('/fake/project')
  })

  it('JSON output includes story_metrics array and pipeline_metrics object', async () => {
    const run = createPipelineRun(db, { methodology: 'bmad' })

    // Write story metrics for two stories
    writeStoryMetrics(db, {
      run_id: run.id,
      story_key: '24-1',
      result: 'success',
      phase_durations_json: JSON.stringify({ dev: 60, review: 30 }),
      wall_clock_seconds: 90,
      input_tokens: 5000,
      output_tokens: 2000,
      cost_usd: 0.01,
      review_cycles: 1,
      dispatches: 2,
    })

    writeStoryMetrics(db, {
      run_id: run.id,
      story_key: '24-2',
      result: 'escalated',
      phase_durations_json: JSON.stringify({ dev: 120, review: 60 }),
      wall_clock_seconds: 180,
      input_tokens: 8000,
      output_tokens: 3500,
      cost_usd: 0.02,
      review_cycles: 2,
      dispatches: 3,
    })

    // Mock the queries that status.ts does directly on db
    const origPrepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      // Allow real queries to pass through
      return origPrepare(sql)
    })

    // Manually insert the run into pipeline_runs with created_at/updated_at
    db.prepare(
      `UPDATE pipeline_runs SET status='completed', created_at=datetime('now', '-1 hour'), updated_at=datetime('now') WHERE id=?`,
    ).run(run.id)

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
      runId: run.id,
    })

    const output = stdoutChunks.join('')
    expect(output.length).toBeGreaterThan(0)

    const parsed = JSON.parse(output) as {
      success: boolean
      data: {
        story_metrics: Array<{
          story_key: string
          result: string
          wall_clock_ms: number
          phase_breakdown: Record<string, number>
          tokens: { input: number; output: number }
          review_cycles: number
          dispatches: number
        }>
        pipeline_metrics: {
          total_wall_clock_ms: number
          total_review_cycles: number
          stories_per_hour: number
          cost_usd: number
        }
      }
    }

    expect(parsed.success).toBe(true)
    const data = parsed.data

    // story_metrics array should have 2 entries
    expect(Array.isArray(data.story_metrics)).toBe(true)
    expect(data.story_metrics).toHaveLength(2)

    // First story
    const s1 = data.story_metrics.find((s) => s.story_key === '24-1')
    expect(s1).toBeDefined()
    expect(s1!.result).toBe('success')
    expect(s1!.wall_clock_ms).toBe(90000) // 90 seconds * 1000
    expect(s1!.phase_breakdown).toEqual({ dev: 60000, review: 30000 })
    expect(s1!.tokens).toEqual({ input: 5000, output: 2000 })
    expect(s1!.review_cycles).toBe(1)
    expect(s1!.dispatches).toBe(2)

    // Second story
    const s2 = data.story_metrics.find((s) => s.story_key === '24-2')
    expect(s2).toBeDefined()
    expect(s2!.wall_clock_ms).toBe(180000) // 180 seconds * 1000
    expect(s2!.review_cycles).toBe(2)

    // pipeline_metrics object
    expect(data.pipeline_metrics).toBeDefined()
    expect(typeof data.pipeline_metrics.total_wall_clock_ms).toBe('number')
    expect(data.pipeline_metrics.total_wall_clock_ms).toBeGreaterThanOrEqual(0)
    expect(data.pipeline_metrics.total_review_cycles).toBe(3) // 1 + 2
    expect(typeof data.pipeline_metrics.stories_per_hour).toBe('number')
    // AC5: total tokens aggregated at pipeline level
    expect((data.pipeline_metrics as unknown as Record<string, number>).total_input_tokens).toBe(13000) // 5000 + 8000
    expect((data.pipeline_metrics as unknown as Record<string, number>).total_output_tokens).toBe(5500) // 2000 + 3500
    // cost_usd is last key (deprioritized per AC6)
    const keys = Object.keys(data.pipeline_metrics)
    expect(keys[keys.length - 1]).toBe('cost_usd')
  })

  it('pipeline_metrics.cost_usd is the last key in the object (AC6)', async () => {
    const run = createPipelineRun(db, { methodology: 'bmad' })
    writeStoryMetrics(db, {
      run_id: run.id,
      story_key: '1-1',
      result: 'success',
      wall_clock_seconds: 60,
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.005,
      review_cycles: 1,
      dispatches: 1,
    })

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
      runId: run.id,
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: Record<string, unknown> }
    const pipelineMetrics = parsed.data.pipeline_metrics as Record<string, unknown>
    const keys = Object.keys(pipelineMetrics)
    expect(keys[keys.length - 1]).toBe('cost_usd')
  })

  it('stories_per_hour is computed for completed stories', async () => {
    const run = createPipelineRun(db, { methodology: 'bmad' })

    // One success story with 1-hour wall clock
    writeStoryMetrics(db, {
      run_id: run.id,
      story_key: '3-1',
      result: 'success',
      wall_clock_seconds: 3600,
      review_cycles: 1,
      dispatches: 1,
    })

    // Set run to have a 1-hour wall clock
    db.prepare(
      `UPDATE pipeline_runs SET created_at=datetime('now', '-1 hour'), updated_at=datetime('now') WHERE id=?`,
    ).run(run.id)

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
      runId: run.id,
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { pipeline_metrics: { stories_per_hour: number; total_wall_clock_ms: number } } }
    expect(parsed.success).toBe(true)
    // stories_per_hour = 1 story / (pipelineWallClockMs / 3600000)
    // pipelineWallClockMs ≈ 3600000ms (1 hour), so ≈ 1.0
    const storiesPerHour = parsed.data.pipeline_metrics.stories_per_hour
    expect(storiesPerHour).toBeGreaterThan(0)
    // total_wall_clock_ms should be roughly 1 hour (allow ±5 seconds for test timing)
    const totalMs = parsed.data.pipeline_metrics.total_wall_clock_ms
    expect(totalMs).toBeGreaterThan(3_590_000)
    expect(totalMs).toBeLessThan(3_610_000)
  })

  it('story_metrics is empty when no story metrics exist', async () => {
    const run = createPipelineRun(db, { methodology: 'bmad' })

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
      runId: run.id,
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { story_metrics: unknown[] } }
    expect(parsed.success).toBe(true)
    expect(parsed.data.story_metrics).toEqual([])
  })
})
