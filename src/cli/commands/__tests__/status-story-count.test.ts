/**
 * Tests for Story 23-9: Status Endpoint Consistency
 *
 * Covers AC1-AC3:
 *   AC1: Status reports correct stories_count (from token_usage_json, not requirements table)
 *   AC2: Status stories_completed agrees with health stories.completed
 *   AC3: Status count updates after story completion (real-time reflection from DB)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { createPipelineRun } from '../../../persistence/queries/decisions.js'
import type { PipelineRun } from '../../../persistence/queries/decisions.js'
import { SqliteDatabaseAdapter } from '../../../persistence/sqlite-adapter.js'
import {
  buildPipelineStatusOutput,
} from '../pipeline-shared.js'
import { getAutoHealthData } from '../health.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): BetterSqlite3Database {
  const db = new Database(':memory:')
  runMigrations(db)
  return db
}

async function createTestRun(
  db: BetterSqlite3Database,
  overrides: {
    status?: string
    current_phase?: string
    token_usage_json?: string | null
    updated_at?: string
  } = {},
): Promise<PipelineRun> {
  const run = await createPipelineRun(new SqliteDatabaseAdapter(db), {
    methodology: 'bmad',
    start_phase: 'implementation',
    config_json: null,
  })
  if (overrides.status !== undefined) {
    db.prepare(`UPDATE pipeline_runs SET status = ? WHERE id = ?`).run(overrides.status, run.id)
  }
  if (overrides.current_phase !== undefined) {
    db.prepare(`UPDATE pipeline_runs SET current_phase = ? WHERE id = ?`).run(overrides.current_phase, run.id)
  }
  if (overrides.token_usage_json !== undefined) {
    db.prepare(`UPDATE pipeline_runs SET token_usage_json = ? WHERE id = ?`).run(overrides.token_usage_json, run.id)
  }
  if (overrides.updated_at !== undefined) {
    db.prepare(`UPDATE pipeline_runs SET updated_at = ? WHERE id = ?`).run(overrides.updated_at, run.id)
  }
  return db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(run.id) as PipelineRun
}

function makeOrchestratorState(
  stories: Record<string, { phase: string; reviewCycles: number }>,
): string {
  return JSON.stringify({ state: 'RUNNING', stories })
}

// ---------------------------------------------------------------------------
// AC1: Status Reports Correct Story Counts
// ---------------------------------------------------------------------------

describe('AC1: stories_count from token_usage_json (not requirements table)', () => {
  it('stories_count equals total stories in token_usage_json when present', async () => {
    const db = createTestDb()
    // No rows in requirements table → old code returned 0
    // But token_usage_json has 3 stories
    const storyState = makeOrchestratorState({
      '23-1': { phase: 'COMPLETE', reviewCycles: 1 },
      '23-2': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-3': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(db, {
      status: 'running',
      current_phase: 'implementation',
      token_usage_json: storyState,
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    // Must report 3, not 0
    expect(result.stories_count).toBe(3)

    db.close()
  })

  it('stories_count is 4 when 4 stories exist with mixed phases', async () => {
    const db = createTestDb()
    const storyState = makeOrchestratorState({
      '10-1': { phase: 'COMPLETE', reviewCycles: 2 },
      '10-2': { phase: 'COMPLETE', reviewCycles: 1 },
      '10-3': { phase: 'IN_REVIEW', reviewCycles: 1 },
      '10-4': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(db, {
      status: 'running',
      token_usage_json: storyState,
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories_count).toBe(4)

    db.close()
  })

  it('stories_count falls back to passed parameter when no token_usage_json', async () => {
    const db = createTestDb()
    // No token_usage_json — legacy behavior: use the passed storiesCount param
    const run = await createTestRun(db)

    const result = buildPipelineStatusOutput(run, [], 0, 7)

    expect(result.stories_count).toBe(7)

    db.close()
  })

  it('stories_count is 0 when no token_usage_json and param is 0', async () => {
    const db = createTestDb()
    const run = await createTestRun(db)

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories_count).toBe(0)

    db.close()
  })

  it('stories_completed equals number of COMPLETE stories', async () => {
    const db = createTestDb()
    const storyState = makeOrchestratorState({
      '23-1': { phase: 'COMPLETE', reviewCycles: 1 },
      '23-2': { phase: 'COMPLETE', reviewCycles: 2 },
      '23-3': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-4': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(db, {
      status: 'running',
      token_usage_json: storyState,
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories_completed).toBe(2)

    db.close()
  })

  it('stories_completed is 0 when no COMPLETE stories', async () => {
    const db = createTestDb()
    const storyState = makeOrchestratorState({
      '23-1': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-2': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(db, {
      status: 'running',
      token_usage_json: storyState,
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories_completed).toBe(0)

    db.close()
  })

  it('stories_completed is 0 when no token_usage_json', async () => {
    const db = createTestDb()
    const run = await createTestRun(db)

    const result = buildPipelineStatusOutput(run, [], 0, 5)

    expect(result.stories_completed).toBe(0)

    db.close()
  })
})

// ---------------------------------------------------------------------------
// AC2: Status and Health Agree on Counts
// ---------------------------------------------------------------------------

// Mock filesystem/DB for health command integration
vi.mock('../../../persistence/database.js', async () => {
  const { SqliteDatabaseAdapter } = await import('../../../persistence/sqlite-adapter.js')
  let mockDb: BetterSqlite3Database | null = null
  return {
    DatabaseWrapper: class {
      db: BetterSqlite3Database
      constructor() {
        this.db = mockDb!
      }
      open() { /* noop */ }
      close() { /* noop */ }
      get adapter() {
        return new SqliteDatabaseAdapter(this.db)
      }
    },
    __setMockDb: (db: BetterSqlite3Database) => { mockDb = db },
  }
})

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/test-project'),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
  }
})

describe('AC2: Status and Health story completion counts agree', () => {
  let db: BetterSqlite3Database

  beforeEach(async () => {
    db = createTestDb()
    const dbModule = await import('../../../persistence/database.js') as {
      __setMockDb: (db: BetterSqlite3Database) => void
    }
    dbModule.__setMockDb(db)
  })

  afterEach(() => {
    db.close()
  })

  it('status stories_count equals total stories in health.stories (active+completed+escalated)', async () => {
    const storyState = makeOrchestratorState({
      '23-1': { phase: 'COMPLETE', reviewCycles: 1 },
      '23-2': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-3': { phase: 'ESCALATED', reviewCycles: 2 },
      '23-4': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(db, {
      status: 'running',
      current_phase: 'implementation',
      token_usage_json: storyState,
      updated_at: new Date().toISOString(),
    })

    // Status path
    const statusOutput = buildPipelineStatusOutput(run, [], 0, 0)

    // Health path
    const healthData = await getAutoHealthData({ projectRoot: '/tmp/test-project' })

    // Both report 4 total stories: active(1) + completed(1) + escalated(1) + pending(1) = 4
    expect(statusOutput.stories_count).toBe(4)
    // Health now exposes pending count so consumers can reconcile total:
    // active + completed + escalated + pending === total stories
    const healthTotal =
      healthData.stories.active +
      healthData.stories.completed +
      healthData.stories.escalated +
      (healthData.stories.pending ?? 0)
    expect(statusOutput.stories_count).toBe(healthTotal)

    db.close()
  })

  it('status stories_completed matches health stories.completed', async () => {
    const storyState = makeOrchestratorState({
      '23-1': { phase: 'COMPLETE', reviewCycles: 1 },
      '23-2': { phase: 'COMPLETE', reviewCycles: 2 },
      '23-3': { phase: 'IN_DEV', reviewCycles: 0 },
    })
    const run = await createTestRun(db, {
      status: 'running',
      current_phase: 'implementation',
      token_usage_json: storyState,
      updated_at: new Date().toISOString(),
    })

    // Status path
    const statusOutput = buildPipelineStatusOutput(run, [], 0, 0)

    // Health path
    const healthData = await getAutoHealthData({ projectRoot: '/tmp/test-project' })

    // Both must agree on completed count
    expect(statusOutput.stories_completed).toBe(healthData.stories.completed)
    expect(statusOutput.stories_completed).toBe(2)

    db.close()
  })

  it('status stories_count is not 0 when health reports active stories', async () => {
    const storyState = makeOrchestratorState({
      '23-1': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-2': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(db, {
      status: 'running',
      current_phase: 'implementation',
      token_usage_json: storyState,
      updated_at: new Date().toISOString(),
    })

    const statusOutput = buildPipelineStatusOutput(run, [], 0, 0)
    const healthData = await getAutoHealthData({ projectRoot: '/tmp/test-project' })

    // Health reports 1 active — status must not report 0 total stories
    expect(healthData.stories.active).toBe(1)
    expect(statusOutput.stories_count).toBeGreaterThan(0)

    db.close()
  })
})

// ---------------------------------------------------------------------------
// AC3: Status Updates in Real-Time
// ---------------------------------------------------------------------------

describe('AC3: Status count updates after story completion', () => {
  it('stories_completed increases when a story transitions to COMPLETE', async () => {
    const db = createTestDb()

    // Initial state: 1 story IN_DEV, 1 PENDING
    const initialState = makeOrchestratorState({
      '23-1': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-2': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(db, {
      status: 'running',
      token_usage_json: initialState,
    })

    const before = buildPipelineStatusOutput(run, [], 0, 0)
    expect(before.stories_completed).toBe(0)

    // Simulate story completion: update token_usage_json
    const updatedState = makeOrchestratorState({
      '23-1': { phase: 'COMPLETE', reviewCycles: 1 },
      '23-2': { phase: 'PENDING', reviewCycles: 0 },
    })
    db.prepare(`UPDATE pipeline_runs SET token_usage_json = ? WHERE id = ?`)
      .run(updatedState, run.id)

    // Re-query the run (as status command does each invocation)
    const updatedRun = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(run.id) as PipelineRun
    const after = buildPipelineStatusOutput(updatedRun, [], 0, 0)

    expect(after.stories_completed).toBe(1)
    expect(after.stories_count).toBe(2)

    db.close()
  })

  it('stories_count is stable as stories progress through phases', async () => {
    const db = createTestDb()

    const storyState = makeOrchestratorState({
      '23-1': { phase: 'IN_STORY_CREATION', reviewCycles: 0 },
      '23-2': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-3': { phase: 'IN_REVIEW', reviewCycles: 1 },
    })
    const run = await createTestRun(db, {
      status: 'running',
      token_usage_json: storyState,
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)
    // Total is always 3, regardless of phase
    expect(result.stories_count).toBe(3)
    expect(result.stories_completed).toBe(0)

    db.close()
  })

  it('all stories_completed when all are COMPLETE', async () => {
    const db = createTestDb()

    const storyState = makeOrchestratorState({
      '23-1': { phase: 'COMPLETE', reviewCycles: 1 },
      '23-2': { phase: 'COMPLETE', reviewCycles: 2 },
      '23-3': { phase: 'COMPLETE', reviewCycles: 1 },
    })
    const run = await createTestRun(db, {
      status: 'completed',
      token_usage_json: storyState,
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)
    expect(result.stories_count).toBe(3)
    expect(result.stories_completed).toBe(3)

    db.close()
  })
})
