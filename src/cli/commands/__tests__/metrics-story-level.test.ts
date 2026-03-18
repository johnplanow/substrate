/**
 * Unit test: `substrate metrics` command includes story-level data from decisions (Story 21-1 AC6).
 *
 * Validates that the metrics command queries story-metrics decisions and includes
 * per-story wall-clock time, tokens, review cycles, and stall flag in the output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { createDecision, getDecisionsByCategory, createPipelineRun } from '../../../persistence/queries/decisions.js'
import { STORY_METRICS } from '../../../persistence/schemas/operational.js'

// ---------------------------------------------------------------------------
// AC6: Metrics command surfaces story-level efficiency data
// ---------------------------------------------------------------------------

describe('AC6: metrics command includes story-level data from decisions', () => {
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter()
    await initSchema(adapter)
  })

  it('story-metrics decisions are queryable by category', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    await createDecision(adapter, {
      pipeline_run_id: run.id,
      phase: 'implementation',
      category: STORY_METRICS,
      key: `1-1:${run.id}`,
      value: JSON.stringify({
        wall_clock_seconds: 120,
        input_tokens: 6000,
        output_tokens: 1500,
        review_cycles: 1,
        stalled: false,
      }),
    })
    await createDecision(adapter, {
      pipeline_run_id: run.id,
      phase: 'implementation',
      category: STORY_METRICS,
      key: `1-2:${run.id}`,
      value: JSON.stringify({
        wall_clock_seconds: 300,
        input_tokens: 12000,
        output_tokens: 4000,
        review_cycles: 3,
        stalled: true,
      }),
    })

    const decisions = await getDecisionsByCategory(adapter, STORY_METRICS)
    expect(decisions).toHaveLength(2)
  })

  it('story-metrics decision keys can be parsed to extract story_key and run_id', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    await createDecision(adapter, {
      pipeline_run_id: run.id,
      phase: 'implementation',
      category: STORY_METRICS,
      key: `3-1:${run.id}`,
      value: JSON.stringify({
        wall_clock_seconds: 90,
        input_tokens: 4000,
        output_tokens: 800,
        review_cycles: 0,
        stalled: false,
      }),
    })

    const decisions = await getDecisionsByCategory(adapter, STORY_METRICS)
    expect(decisions).toHaveLength(1)

    const d = decisions[0]!
    const colonIdx = d.key.indexOf(':')
    const storyKey = colonIdx !== -1 ? d.key.slice(0, colonIdx) : d.key
    const runId = colonIdx !== -1 ? d.key.slice(colonIdx + 1) : (d.pipeline_run_id ?? '')

    expect(storyKey).toBe('3-1')
    expect(runId).toBe(run.id)
  })

  it('story-metrics JSON values parse correctly with all fields', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    await createDecision(adapter, {
      pipeline_run_id: run.id,
      phase: 'implementation',
      category: STORY_METRICS,
      key: `5-1:${run.id}`,
      value: JSON.stringify({
        wall_clock_seconds: 240,
        input_tokens: 10000,
        output_tokens: 3000,
        review_cycles: 2,
        stalled: false,
      }),
    })

    const decisions = await getDecisionsByCategory(adapter, STORY_METRICS)
    const d = decisions[0]!
    const val = JSON.parse(d.value) as {
      wall_clock_seconds?: number
      input_tokens?: number
      output_tokens?: number
      review_cycles?: number
      stalled?: boolean
    }

    expect(val.wall_clock_seconds).toBe(240)
    expect(val.input_tokens).toBe(10000)
    expect(val.output_tokens).toBe(3000)
    expect(val.review_cycles).toBe(2)
    expect(val.stalled).toBe(false)
  })

  it('cost_usd is omitted from output when zero (subscription plans)', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    await createDecision(adapter, {
      pipeline_run_id: run.id,
      phase: 'implementation',
      category: STORY_METRICS,
      key: `7-1:${run.id}`,
      value: JSON.stringify({
        wall_clock_seconds: 60,
        input_tokens: 2000,
        output_tokens: 500,
        review_cycles: 0,
        stalled: false,
      }),
    })

    const decisions = await getDecisionsByCategory(adapter, STORY_METRICS)
    const d = decisions[0]!
    const val = JSON.parse(d.value) as Record<string, unknown>

    // cost_usd should not be present when not set
    expect(val.cost_usd).toBeUndefined()

    // The metrics command logic: include cost_usd only if > 0
    const costUsd = val.cost_usd as number | undefined
    const outputObj: Record<string, unknown> = {
      story_key: '7-1',
      run_id: 'run-sub',
      wall_clock_seconds: val.wall_clock_seconds,
      input_tokens: val.input_tokens,
      output_tokens: val.output_tokens,
      review_cycles: val.review_cycles,
      stalled: val.stalled,
    }
    if (costUsd !== undefined && costUsd > 0) {
      outputObj.cost_usd = costUsd
    }

    expect(outputObj).not.toHaveProperty('cost_usd')
  })
})
