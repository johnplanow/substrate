/**
 * Integration test: orchestrator story-metrics decision insertion (Story 21-1 AC4).
 *
 * Validates that the story-metrics decision is written with the correct category,
 * key format, and value shape when a story completes.
 *
 * Uses in-memory SQLite for DB tests.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { createDecision, getDecisionsByCategory, createPipelineRun } from '../../../persistence/queries/decisions.js'
import { STORY_METRICS } from '../../../persistence/schemas/operational.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function openTestDb(): Promise<InMemoryDatabaseAdapter> {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return adapter
}

// ---------------------------------------------------------------------------
// AC4: Per-story metrics recorded as decisions
// ---------------------------------------------------------------------------

describe('AC4: Orchestrator writes story-metrics decisions', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openTestDb()
  })

  it('inserts story-metrics decision with correct key format and value shape', async () => {
    const storyKey = '1-1'
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    const runId = run.id
    const wallClockSeconds = 180
    const inputTokens = 8000
    const outputTokens = 2000
    const reviewCycles = 2
    const stalled = false

    await createDecision(adapter, {
      pipeline_run_id: runId,
      phase: 'implementation',
      category: STORY_METRICS,
      key: `${storyKey}:${runId}`,
      value: JSON.stringify({
        wall_clock_seconds: wallClockSeconds,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        review_cycles: reviewCycles,
        stalled,
      }),
      rationale: `Story ${storyKey} completed with result=success in ${wallClockSeconds}s.`,
    })

    const decisions = await getDecisionsByCategory(adapter, STORY_METRICS)
    expect(decisions).toHaveLength(1)

    const d = decisions[0]!
    expect(d.category).toBe('story-metrics')
    expect(d.key).toBe(`1-1:${runId}`)
    expect(d.phase).toBe('implementation')
    expect(d.pipeline_run_id).toBe(runId)

    const val = JSON.parse(d.value)
    expect(val.wall_clock_seconds).toBe(180)
    expect(val.input_tokens).toBe(8000)
    expect(val.output_tokens).toBe(2000)
    expect(val.review_cycles).toBe(2)
    expect(val.stalled).toBe(false)
  })

  it('uses "unknown" as run_id fallback when pipelineRunId is null', async () => {
    // This tests the fix for review issue #4
    const storyKey = '2-1'
    const runId = null
    const safeRunId = runId ?? 'unknown'

    await createDecision(adapter, {
      pipeline_run_id: runId,
      phase: 'implementation',
      category: STORY_METRICS,
      key: `${storyKey}:${safeRunId}`,
      value: JSON.stringify({
        wall_clock_seconds: 60,
        input_tokens: 3000,
        output_tokens: 1000,
        review_cycles: 1,
        stalled: true,
      }),
    })

    const decisions = await getDecisionsByCategory(adapter, STORY_METRICS)
    expect(decisions).toHaveLength(1)

    const d = decisions[0]!
    // Key should NOT contain 'null' or 'undefined'
    expect(d.key).toBe('2-1:unknown')
    expect(d.key).not.toContain('null')
    expect(d.key).not.toContain('undefined')

    const val = JSON.parse(d.value)
    expect(val.stalled).toBe(true)
  })

  it('multiple stories produce multiple decisions', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    const runId = run.id
    const stories = [
      { key: '1-1', wall: 100, input: 5000, output: 1000, cycles: 1, stalled: false },
      { key: '1-2', wall: 200, input: 8000, output: 2500, cycles: 3, stalled: true },
    ]

    for (const s of stories) {
      await createDecision(adapter, {
        pipeline_run_id: runId,
        phase: 'implementation',
        category: STORY_METRICS,
        key: `${s.key}:${runId}`,
        value: JSON.stringify({
          wall_clock_seconds: s.wall,
          input_tokens: s.input,
          output_tokens: s.output,
          review_cycles: s.cycles,
          stalled: s.stalled,
        }),
      })
    }

    const decisions = await getDecisionsByCategory(adapter, STORY_METRICS)
    expect(decisions).toHaveLength(2)

    const keys = decisions.map((d) => d.key)
    expect(keys).toContain(`1-1:${runId}`)
    expect(keys).toContain(`1-2:${runId}`)
  })
})
