/**
 * Tests for Story 23-9: Status Endpoint Consistency
 *
 * Covers AC1-AC3:
 *   AC1: Status reports correct stories_count (from token_usage_json, not requirements table)
 *   AC2: Status stories_completed agrees with health stories.completed
 *   AC3: Status count updates after story completion (real-time reflection from DB)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import { createPipelineRun } from '../../../persistence/queries/decisions.js'
import type { PipelineRun } from '../../../persistence/queries/decisions.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import {
  buildPipelineStatusOutput,
} from '../pipeline-shared.js'
import { getAutoHealthData } from '../health.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<DatabaseAdapter> {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return adapter
}

async function createTestRun(
  adapter: DatabaseAdapter,
  overrides: {
    status?: string
    current_phase?: string
    token_usage_json?: string | null
    updated_at?: string
  } = {},
): Promise<PipelineRun> {
  const run = await createPipelineRun(adapter, {
    methodology: 'bmad',
    start_phase: 'implementation',
    config_json: null,
  })
  if (overrides.status !== undefined) {
    await adapter.query(`UPDATE pipeline_runs SET status = ? WHERE id = ?`, [overrides.status, run.id])
  }
  if (overrides.current_phase !== undefined) {
    await adapter.query(`UPDATE pipeline_runs SET current_phase = ? WHERE id = ?`, [overrides.current_phase, run.id])
  }
  if (overrides.token_usage_json !== undefined) {
    await adapter.query(`UPDATE pipeline_runs SET token_usage_json = ? WHERE id = ?`, [overrides.token_usage_json, run.id])
  }
  if (overrides.updated_at !== undefined) {
    await adapter.query(`UPDATE pipeline_runs SET updated_at = ? WHERE id = ?`, [overrides.updated_at, run.id])
  }
  const rows = await adapter.query<PipelineRun>('SELECT * FROM pipeline_runs WHERE id = ?', [run.id])
  return rows[0]!
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
    const adapter = await createTestDb()
    // No rows in requirements table → old code returned 0
    // But token_usage_json has 3 stories
    const storyState = makeOrchestratorState({
      '23-1': { phase: 'COMPLETE', reviewCycles: 1 },
      '23-2': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-3': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      token_usage_json: storyState,
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    // Must report 3, not 0
    expect(result.stories_count).toBe(3)

    await adapter.close()
  })

  it('stories_count is 4 when 4 stories exist with mixed phases', async () => {
    const adapter = await createTestDb()
    const storyState = makeOrchestratorState({
      '10-1': { phase: 'COMPLETE', reviewCycles: 2 },
      '10-2': { phase: 'COMPLETE', reviewCycles: 1 },
      '10-3': { phase: 'IN_REVIEW', reviewCycles: 1 },
      '10-4': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(adapter, {
      status: 'running',
      token_usage_json: storyState,
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories_count).toBe(4)

    await adapter.close()
  })

  it('stories_count falls back to passed parameter when no token_usage_json', async () => {
    const adapter = await createTestDb()
    // No token_usage_json — legacy behavior: use the passed storiesCount param
    const run = await createTestRun(adapter)

    const result = buildPipelineStatusOutput(run, [], 0, 7)

    expect(result.stories_count).toBe(7)

    await adapter.close()
  })

  it('stories_count is 0 when no token_usage_json and param is 0', async () => {
    const adapter = await createTestDb()
    const run = await createTestRun(adapter)

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories_count).toBe(0)

    await adapter.close()
  })

  it('stories_completed equals number of COMPLETE stories', async () => {
    const adapter = await createTestDb()
    const storyState = makeOrchestratorState({
      '23-1': { phase: 'COMPLETE', reviewCycles: 1 },
      '23-2': { phase: 'COMPLETE', reviewCycles: 2 },
      '23-3': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-4': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(adapter, {
      status: 'running',
      token_usage_json: storyState,
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories_completed).toBe(2)

    await adapter.close()
  })

  it('stories_completed is 0 when no COMPLETE stories', async () => {
    const adapter = await createTestDb()
    const storyState = makeOrchestratorState({
      '23-1': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-2': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(adapter, {
      status: 'running',
      token_usage_json: storyState,
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories_completed).toBe(0)

    await adapter.close()
  })

  it('stories_completed is 0 when no token_usage_json', async () => {
    const adapter = await createTestDb()
    const run = await createTestRun(adapter)

    const result = buildPipelineStatusOutput(run, [], 0, 5)

    expect(result.stories_completed).toBe(0)

    await adapter.close()
  })
})

// ---------------------------------------------------------------------------
// AC2: Status and Health Agree on Counts
// ---------------------------------------------------------------------------

// Mock adapter for health command integration — initSchema is NOT mocked
// because the test's own createTestDb() calls it to set up real tables.
// The production health.ts code calls initSchema(adapter) on the injected
// adapter which is idempotent (CREATE TABLE IF NOT EXISTS).
vi.mock('../../../persistence/adapter.js', () => {
  let mockAdapter: DatabaseAdapter | null = null
  return {
    createDatabaseAdapter: () => mockAdapter!,
    __setMockAdapter: (a: DatabaseAdapter) => { mockAdapter = a },
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
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
    const dbModule = await import('../../../persistence/adapter.js') as {
      __setMockAdapter: (a: DatabaseAdapter) => void
    }
    dbModule.__setMockAdapter(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('status stories_count equals total stories in health.stories (active+completed+escalated)', async () => {
    const storyState = makeOrchestratorState({
      '23-1': { phase: 'COMPLETE', reviewCycles: 1 },
      '23-2': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-3': { phase: 'ESCALATED', reviewCycles: 2 },
      '23-4': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(adapter, {
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

    await adapter.close()
  })

  it('status stories_completed matches health stories.completed', async () => {
    const storyState = makeOrchestratorState({
      '23-1': { phase: 'COMPLETE', reviewCycles: 1 },
      '23-2': { phase: 'COMPLETE', reviewCycles: 2 },
      '23-3': { phase: 'IN_DEV', reviewCycles: 0 },
    })
    const run = await createTestRun(adapter, {
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

    await adapter.close()
  })

  it('status stories_count is not 0 when health reports active stories', async () => {
    const storyState = makeOrchestratorState({
      '23-1': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-2': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(adapter, {
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

    await adapter.close()
  })
})

// ---------------------------------------------------------------------------
// AC3: Status Updates in Real-Time
// ---------------------------------------------------------------------------

describe('AC3: Status count updates after story completion', () => {
  it('stories_completed increases when a story transitions to COMPLETE', async () => {
    const adapter = await createTestDb()

    // Initial state: 1 story IN_DEV, 1 PENDING
    const initialState = makeOrchestratorState({
      '23-1': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-2': { phase: 'PENDING', reviewCycles: 0 },
    })
    const run = await createTestRun(adapter, {
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
    await adapter.query(`UPDATE pipeline_runs SET token_usage_json = ? WHERE id = ?`, [updatedState, run.id])

    // Re-query the run (as status command does each invocation)
    const rows = await adapter.query<PipelineRun>('SELECT * FROM pipeline_runs WHERE id = ?', [run.id])
    const updatedRun = rows[0]!
    const after = buildPipelineStatusOutput(updatedRun, [], 0, 0)

    expect(after.stories_completed).toBe(1)
    expect(after.stories_count).toBe(2)

    await adapter.close()
  })

  it('stories_count is stable as stories progress through phases', async () => {
    const adapter = await createTestDb()

    const storyState = makeOrchestratorState({
      '23-1': { phase: 'IN_STORY_CREATION', reviewCycles: 0 },
      '23-2': { phase: 'IN_DEV', reviewCycles: 0 },
      '23-3': { phase: 'IN_REVIEW', reviewCycles: 1 },
    })
    const run = await createTestRun(adapter, {
      status: 'running',
      token_usage_json: storyState,
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)
    // Total is always 3, regardless of phase
    expect(result.stories_count).toBe(3)
    expect(result.stories_completed).toBe(0)

    await adapter.close()
  })

  it('all stories_completed when all are COMPLETE', async () => {
    const adapter = await createTestDb()

    const storyState = makeOrchestratorState({
      '23-1': { phase: 'COMPLETE', reviewCycles: 1 },
      '23-2': { phase: 'COMPLETE', reviewCycles: 2 },
      '23-3': { phase: 'COMPLETE', reviewCycles: 1 },
    })
    const run = await createTestRun(adapter, {
      status: 'completed',
      token_usage_json: storyState,
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)
    expect(result.stories_count).toBe(3)
    expect(result.stories_completed).toBe(3)

    await adapter.close()
  })
})
