/**
 * Tests for Story 22-8: Mid-Run Sprint Summary
 *
 * Covers AC1–AC6:
 *   AC1: Per-story status (phase, review_cycles) in stories.details
 *   AC2: Sprint progress counts (completed, in_progress, escalated, pending)
 *   AC3: elapsed_seconds per story
 *   AC4: Human-readable sprint table in formatPipelineStatusHuman
 *   AC5: state deserialization from pipeline_runs.token_usage_json
 *   AC6: Graceful fallback when no story state
 */

import { describe, it, expect, afterEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import { createPipelineRun } from '../../../persistence/queries/decisions.js'
import type { PipelineRun } from '../../../persistence/queries/decisions.js'
import { buildPipelineStatusOutput, formatPipelineStatusHuman } from '../pipeline-shared.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<InMemoryDatabaseAdapter> {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return adapter
}

async function createTestRun(
  adapter: InMemoryDatabaseAdapter,
  overrides: { token_usage_json?: string | null; config_json?: string | null } = {}
): Promise<PipelineRun> {
  const run = await createPipelineRun(adapter, {
    methodology: 'bmad',
    start_phase: 'analysis',
    config_json: overrides.config_json ?? null,
  })
  if (overrides.token_usage_json !== undefined) {
    adapter.querySync(`UPDATE pipeline_runs SET token_usage_json = ? WHERE id = ?`, [
      overrides.token_usage_json,
      run.id,
    ])
  }
  return adapter.querySync<PipelineRun>('SELECT * FROM pipeline_runs WHERE id = ?', [run.id])[0]!
}

/** Build a minimal OrchestratorStatus JSON string for token_usage_json */
function makeStoryState(
  stories: Record<
    string,
    {
      phase: string
      reviewCycles: number
      startedAt?: string
      completedAt?: string
    }
  >
): string {
  return JSON.stringify({ state: 'RUNNING', stories })
}

// ---------------------------------------------------------------------------
// AC5: State deserialization from pipeline_runs.token_usage_json
// AC6: Graceful fallback when no story state
// ---------------------------------------------------------------------------

describe('buildPipelineStatusOutput — AC5+AC6: state deserialization', () => {
  let adapter: InMemoryDatabaseAdapter

  afterEach(async () => {
    await adapter.close()
  })

  it('AC6: stories is undefined when token_usage_json is null', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, { token_usage_json: null })
    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories).toBeUndefined()
  })

  it('AC6: stories is undefined when token_usage_json has no stories key', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: JSON.stringify({ state: 'RUNNING', maxConcurrentActual: 1 }),
    })
    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories).toBeUndefined()
  })

  it('AC6: stories is undefined when stories map is empty', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: JSON.stringify({ state: 'RUNNING', stories: {} }),
    })
    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories).toBeUndefined()
  })

  it('AC6: gracefully handles malformed JSON in token_usage_json', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, { token_usage_json: 'NOT_VALID_JSON' })

    expect(() => buildPipelineStatusOutput(run, [], 0, 0)).not.toThrow()
    const result = buildPipelineStatusOutput(run, [], 0, 0)
    expect(result.stories).toBeUndefined()
  })

  it('AC5: deserializes story state from token_usage_json without orchestrator in-process', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'COMPLETE', reviewCycles: 1 },
        '22-2': { phase: 'IN_DEV', reviewCycles: 0 },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories).toBeDefined()
    expect(result.stories?.details['22-1']).toBeDefined()
    expect(result.stories?.details['22-2']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// AC1: Per-story status (phase, review_cycles) in stories.details
// ---------------------------------------------------------------------------

describe('buildPipelineStatusOutput — AC1: per-story details', () => {
  let adapter: InMemoryDatabaseAdapter

  afterEach(async () => {
    await adapter.close()
  })

  it('stories.details contains phase for each story', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'COMPLETE', reviewCycles: 1 },
        '22-2': { phase: 'IN_DEV', reviewCycles: 0 },
        '22-3': { phase: 'ESCALATED', reviewCycles: 3 },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories?.details['22-1'].phase).toBe('COMPLETE')
    expect(result.stories?.details['22-2'].phase).toBe('IN_DEV')
    expect(result.stories?.details['22-3'].phase).toBe('ESCALATED')
  })

  it('stories.details contains review_cycles for each story', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'COMPLETE', reviewCycles: 2 },
        '22-2': { phase: 'NEEDS_FIXES', reviewCycles: 1 },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories?.details['22-1'].review_cycles).toBe(2)
    expect(result.stories?.details['22-2'].review_cycles).toBe(1)
  })

  it('stories.details keys match story keys in state', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '10-1': { phase: 'COMPLETE', reviewCycles: 1 },
        '10-2': { phase: 'PENDING', reviewCycles: 0 },
        '10-3': { phase: 'IN_REVIEW', reviewCycles: 0 },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(Object.keys(result.stories?.details ?? {})).toEqual(
      expect.arrayContaining(['10-1', '10-2', '10-3'])
    )
  })
})

// ---------------------------------------------------------------------------
// AC2: Sprint progress counts
// ---------------------------------------------------------------------------

describe('buildPipelineStatusOutput — AC2: sprint progress counts', () => {
  let adapter: InMemoryDatabaseAdapter

  afterEach(async () => {
    await adapter.close()
  })

  it('counts completed stories (COMPLETE phase)', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'COMPLETE', reviewCycles: 1 },
        '22-2': { phase: 'COMPLETE', reviewCycles: 0 },
        '22-3': { phase: 'IN_DEV', reviewCycles: 0 },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories?.completed).toBe(2)
  })

  it('counts in_progress stories (IN_* and NEEDS_FIXES phases)', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'IN_STORY_CREATION', reviewCycles: 0 },
        '22-2': { phase: 'IN_DEV', reviewCycles: 0 },
        '22-3': { phase: 'IN_REVIEW', reviewCycles: 1 },
        '22-4': { phase: 'NEEDS_FIXES', reviewCycles: 1 },
        '22-5': { phase: 'IN_TEST_PLANNING', reviewCycles: 0 },
        '22-6': { phase: 'COMPLETE', reviewCycles: 1 },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories?.in_progress).toBe(5) // all IN_* + NEEDS_FIXES
    expect(result.stories?.completed).toBe(1)
  })

  it('counts escalated stories (ESCALATED phase)', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'ESCALATED', reviewCycles: 3 },
        '22-2': { phase: 'ESCALATED', reviewCycles: 3 },
        '22-3': { phase: 'COMPLETE', reviewCycles: 1 },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories?.escalated).toBe(2)
  })

  it('counts pending stories (PENDING phase)', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'PENDING', reviewCycles: 0 },
        '22-2': { phase: 'PENDING', reviewCycles: 0 },
        '22-3': { phase: 'PENDING', reviewCycles: 0 },
        '22-4': { phase: 'IN_DEV', reviewCycles: 0 },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories?.pending).toBe(3)
    expect(result.stories?.in_progress).toBe(1)
  })

  it('all four count fields are present even when some are zero', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'COMPLETE', reviewCycles: 1 },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories?.completed).toBe(1)
    expect(result.stories?.in_progress).toBe(0)
    expect(result.stories?.escalated).toBe(0)
    expect(result.stories?.pending).toBe(0)
  })

  it('mixed state: completed + in_progress + escalated + pending all counted correctly', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'COMPLETE', reviewCycles: 1 },
        '22-2': { phase: 'IN_DEV', reviewCycles: 0 },
        '22-3': { phase: 'ESCALATED', reviewCycles: 3 },
        '22-4': { phase: 'PENDING', reviewCycles: 0 },
        '22-5': { phase: 'NEEDS_FIXES', reviewCycles: 2 },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories?.completed).toBe(1)
    expect(result.stories?.in_progress).toBe(2) // IN_DEV + NEEDS_FIXES
    expect(result.stories?.escalated).toBe(1)
    expect(result.stories?.pending).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// AC3: elapsed_seconds per story
// ---------------------------------------------------------------------------

describe('buildPipelineStatusOutput — AC3: elapsed_seconds', () => {
  let adapter: InMemoryDatabaseAdapter

  afterEach(async () => {
    await adapter.close()
  })

  it('elapsed_seconds is positive for a story that started', async () => {
    adapter = await createTestDb()
    const startedAt = new Date(Date.now() - 120_000).toISOString() // 120s ago
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'IN_DEV', reviewCycles: 0, startedAt },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    const elapsed = result.stories?.details['22-1'].elapsed_seconds ?? 0
    // Allow ±5s tolerance for test execution
    expect(elapsed).toBeGreaterThanOrEqual(115)
    expect(elapsed).toBeLessThanOrEqual(130)
  })

  it('elapsed_seconds is 0 for a story with no startedAt', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'PENDING', reviewCycles: 0 },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories?.details['22-1'].elapsed_seconds).toBe(0)
  })

  it('elapsed_seconds is non-negative even for future startedAt (clock skew)', async () => {
    adapter = await createTestDb()
    const futureStartedAt = new Date(Date.now() + 60_000).toISOString()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'IN_DEV', reviewCycles: 0, startedAt: futureStartedAt },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    expect(result.stories?.details['22-1'].elapsed_seconds).toBe(0)
  })

  it('elapsed_seconds for a completed story reflects total time when completedAt not used', async () => {
    adapter = await createTestDb()
    const startedAt = new Date(Date.now() - 300_000).toISOString() // 5 minutes ago
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': {
          phase: 'COMPLETE',
          reviewCycles: 1,
          startedAt,
          completedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    // elapsed_seconds is computed as now - startedAt (not using completedAt)
    const elapsed = result.stories?.details['22-1'].elapsed_seconds ?? 0
    expect(elapsed).toBeGreaterThanOrEqual(295)
    expect(elapsed).toBeLessThanOrEqual(310)
  })
})

// ---------------------------------------------------------------------------
// AC4: Human-readable sprint table
// ---------------------------------------------------------------------------

describe('formatPipelineStatusHuman — AC4: sprint progress table', () => {
  let adapter: InMemoryDatabaseAdapter

  afterEach(async () => {
    await adapter.close()
  })

  it('shows sprint progress table when stories are present', async () => {
    adapter = await createTestDb()
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'COMPLETE', reviewCycles: 1, startedAt },
        '22-2': { phase: 'IN_DEV', reviewCycles: 0, startedAt },
      }),
    })

    const status = buildPipelineStatusOutput(run, [], 0, 0)
    const output = formatPipelineStatusHuman(status)

    expect(output).toContain('Sprint Progress')
    expect(output).toContain('STORY')
    expect(output).toContain('PHASE')
    expect(output).toContain('CYCLES')
    expect(output).toContain('ELAPSED')
  })

  it('shows each story key in the sprint table', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'COMPLETE', reviewCycles: 1 },
        '22-2': { phase: 'PENDING', reviewCycles: 0 },
        '22-3': { phase: 'IN_DEV', reviewCycles: 0 },
      }),
    })

    const status = buildPipelineStatusOutput(run, [], 0, 0)
    const output = formatPipelineStatusHuman(status)

    expect(output).toContain('22-1')
    expect(output).toContain('22-2')
    expect(output).toContain('22-3')
  })

  it('shows phases in the sprint table', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'COMPLETE', reviewCycles: 1 },
        '22-2': { phase: 'IN_REVIEW', reviewCycles: 2 },
      }),
    })

    const status = buildPipelineStatusOutput(run, [], 0, 0)
    const output = formatPipelineStatusHuman(status)

    expect(output).toContain('COMPLETE')
    expect(output).toContain('IN_REVIEW')
  })

  it('shows review cycle count in the sprint table', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'COMPLETE', reviewCycles: 3 },
      }),
    })

    const status = buildPipelineStatusOutput(run, [], 0, 0)
    const output = formatPipelineStatusHuman(status)

    expect(output).toContain('3')
  })

  it('shows elapsed time for stories with startedAt', async () => {
    adapter = await createTestDb()
    const startedAt = new Date(Date.now() - 90_000).toISOString() // 90s ago
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'IN_DEV', reviewCycles: 0, startedAt },
      }),
    })

    const status = buildPipelineStatusOutput(run, [], 0, 0)
    const output = formatPipelineStatusHuman(status)

    // Should contain a time in seconds (e.g., "85s" to "95s")
    expect(output).toMatch(/\d+s/)
  })

  it('shows "-" for elapsed when story has no startedAt', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'PENDING', reviewCycles: 0 },
      }),
    })

    const status = buildPipelineStatusOutput(run, [], 0, 0)
    const output = formatPipelineStatusHuman(status)

    expect(output).toContain('-')
  })

  it('shows count summary line at the bottom of sprint table', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'COMPLETE', reviewCycles: 1 },
        '22-2': { phase: 'IN_DEV', reviewCycles: 0 },
        '22-3': { phase: 'ESCALATED', reviewCycles: 3 },
        '22-4': { phase: 'PENDING', reviewCycles: 0 },
      }),
    })

    const status = buildPipelineStatusOutput(run, [], 0, 0)
    const output = formatPipelineStatusHuman(status)

    expect(output).toContain('Completed: 1')
    expect(output).toContain('In Progress: 1')
    expect(output).toContain('Escalated: 1')
    expect(output).toContain('Pending: 1')
  })

  it('does not show sprint table when no story state is available', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter) // no token_usage_json

    const status = buildPipelineStatusOutput(run, [], 0, 0)
    const output = formatPipelineStatusHuman(status)

    expect(output).not.toContain('Sprint Progress')
    expect(output).not.toContain('STORY')
  })

  it('AC4: existing human output fields are still present alongside sprint table', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'COMPLETE', reviewCycles: 1 },
      }),
      config_json: JSON.stringify({
        phaseHistory: [
          {
            phase: 'analysis',
            startedAt: '2026-01-01T00:00:00Z',
            completedAt: '2026-01-01T00:01:00Z',
            gateResults: [],
          },
        ],
      }),
    })

    const status = buildPipelineStatusOutput(run, [], 5, 3)
    const output = formatPipelineStatusHuman(status)

    // Existing fields still present
    expect(output).toContain('Pipeline Run:')
    expect(output).toContain('Phase Status:')
    expect(output).toContain('Decisions: 5')

    // Sprint table also present
    expect(output).toContain('Sprint Progress')
  })
})

// ---------------------------------------------------------------------------
// Backward compatibility: active_dispatches still works with new code
// ---------------------------------------------------------------------------

describe('buildPipelineStatusOutput — active_dispatches backward compatibility', () => {
  let adapter: InMemoryDatabaseAdapter

  afterEach(async () => {
    await adapter.close()
  })

  it('active_dispatches still counts non-terminal stories', async () => {
    adapter = await createTestDb()
    const run = await createTestRun(adapter, {
      token_usage_json: makeStoryState({
        '22-1': { phase: 'IN_DEV', reviewCycles: 0 },
        '22-2': { phase: 'IN_REVIEW', reviewCycles: 1 },
        '22-3': { phase: 'COMPLETE', reviewCycles: 1 },
        '22-4': { phase: 'PENDING', reviewCycles: 0 },
        '22-5': { phase: 'ESCALATED', reviewCycles: 3 },
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    // IN_DEV + IN_REVIEW = 2 active
    expect(result.active_dispatches).toBe(2)
  })
})
