/**
 * Tests for routing-token-accumulator.ts
 *
 * AC1: Two onRoutingSelected events with same dispatchId → second overwrites (last-writer-wins)
 * AC2: onAgentCompleted with registered vs unregistered dispatchId
 * AC3: flush(runId) calls stateStore.setMetric with correct PhaseTokenBreakdown
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type pino from 'pino'

import { RoutingTokenAccumulator } from '../routing-token-accumulator.js'
import type { ModelRoutingConfig } from '../model-routing-config.js'
import type { StateStore } from '../../state/index.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockLogger(): pino.Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(),
    level: 'debug',
  } as unknown as pino.Logger
}

function createMockStateStore(): StateStore {
  return {
    setMetric: vi.fn().mockResolvedValue(undefined),
    getMetric: vi.fn().mockResolvedValue(null),
    // minimal no-ops for other StateStore methods
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    clear: vi.fn(),
    close: vi.fn(),
    branchForStory: vi.fn(),
    mergeStory: vi.fn(),
    rollbackStory: vi.fn(),
    getCurrentBranch: vi.fn(),
    listBranches: vi.fn(),
    createRun: vi.fn(),
    getRun: vi.fn(),
    updateRun: vi.fn(),
    listRuns: vi.fn(),
    createStoryRun: vi.fn(),
    getStoryRun: vi.fn(),
    updateStoryRun: vi.fn(),
    listStoryRuns: vi.fn(),
    getStoryRunsByRun: vi.fn(),
    getLatestStoryRun: vi.fn(),
    getAggregateMetrics: vi.fn(),
  } as unknown as StateStore
}

const FIXTURE_CONFIG: ModelRoutingConfig = {
  version: 1,
  phases: {
    explore: { model: 'claude-haiku-4-5' },
    generate: { model: 'claude-sonnet-4-5' },
    review: { model: 'claude-sonnet-4-5' },
  },
  baseline_model: 'claude-sonnet-4-5',
}

// ---------------------------------------------------------------------------
// AC1: onRoutingSelected — last-writer-wins for duplicate dispatchId
// ---------------------------------------------------------------------------

describe('RoutingTokenAccumulator.onRoutingSelected (AC1 — last-writer-wins)', () => {
  let logger: pino.Logger
  let stateStore: StateStore
  let accumulator: RoutingTokenAccumulator

  beforeEach(() => {
    logger = createMockLogger()
    stateStore = createMockStateStore()
    accumulator = new RoutingTokenAccumulator(FIXTURE_CONFIG, stateStore, logger)
  })

  it('AC1: registers an initial routing selection', async () => {
    accumulator.onRoutingSelected({
      dispatchId: 'dispatch-1',
      phase: 'generate',
      model: 'claude-sonnet-4-5',
    })
    accumulator.onAgentCompleted({ dispatchId: 'dispatch-1', inputTokens: 100, outputTokens: 50 })
    await accumulator.flush('run-1')

    const call = vi.mocked(stateStore.setMetric).mock.calls[0]
    const breakdown = call[2] as { entries: Array<{ model: string }> }
    expect(breakdown.entries[0].model).toBe('claude-sonnet-4-5')
  })

  it('AC1: second onRoutingSelected for same dispatchId overwrites the first (last-writer-wins)', async () => {
    accumulator.onRoutingSelected({
      dispatchId: 'dispatch-1',
      phase: 'generate',
      model: 'claude-sonnet-4-5',
    })
    // Second event for same dispatchId — should overwrite
    accumulator.onRoutingSelected({
      dispatchId: 'dispatch-1',
      phase: 'review',
      model: 'claude-haiku-4-5',
    })
    accumulator.onAgentCompleted({ dispatchId: 'dispatch-1', inputTokens: 200, outputTokens: 100 })
    await accumulator.flush('run-1')

    const call = vi.mocked(stateStore.setMetric).mock.calls[0]
    const breakdown = call[2] as { entries: Array<{ phase: string; model: string }> }
    expect(breakdown.entries).toHaveLength(1)
    expect(breakdown.entries[0].phase).toBe('review')
    expect(breakdown.entries[0].model).toBe('claude-haiku-4-5')
  })

  it('AC1: logs debug for each onRoutingSelected call', () => {
    accumulator.onRoutingSelected({
      dispatchId: 'dispatch-1',
      phase: 'generate',
      model: 'claude-sonnet-4-5',
    })
    expect(logger.debug).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// AC2: onAgentCompleted — registered vs unregistered dispatchId
// ---------------------------------------------------------------------------

describe('RoutingTokenAccumulator.onAgentCompleted (AC2 — dispatch attribution)', () => {
  let logger: pino.Logger
  let stateStore: StateStore
  let accumulator: RoutingTokenAccumulator

  beforeEach(() => {
    logger = createMockLogger()
    stateStore = createMockStateStore()
    accumulator = new RoutingTokenAccumulator(FIXTURE_CONFIG, stateStore, logger)
  })

  it('AC2: registered dispatchId attributes tokens to the correct phase bucket', async () => {
    accumulator.onRoutingSelected({
      dispatchId: 'dispatch-1',
      phase: 'explore',
      model: 'claude-haiku-4-5',
    })
    accumulator.onAgentCompleted({ dispatchId: 'dispatch-1', inputTokens: 300, outputTokens: 150 })
    await accumulator.flush('run-2')

    const breakdown = vi.mocked(stateStore.setMetric).mock.calls[0][2] as {
      entries: Array<{
        phase: string
        model: string
        inputTokens: number
        outputTokens: number
        dispatchCount: number
      }>
    }
    expect(breakdown.entries).toHaveLength(1)
    expect(breakdown.entries[0].phase).toBe('explore')
    expect(breakdown.entries[0].model).toBe('claude-haiku-4-5')
    expect(breakdown.entries[0].inputTokens).toBe(300)
    expect(breakdown.entries[0].outputTokens).toBe(150)
    expect(breakdown.entries[0].dispatchCount).toBe(1)
  })

  it('AC2: unregistered dispatchId falls back to phase: default, model: unknown', async () => {
    accumulator.onAgentCompleted({
      dispatchId: 'unknown-dispatch',
      inputTokens: 50,
      outputTokens: 25,
    })
    await accumulator.flush('run-2')

    const breakdown = vi.mocked(stateStore.setMetric).mock.calls[0][2] as {
      entries: Array<{ phase: string; model: string }>
    }
    expect(breakdown.entries).toHaveLength(1)
    expect(breakdown.entries[0].phase).toBe('default')
    expect(breakdown.entries[0].model).toBe('unknown')
  })

  it('AC2: multiple dispatches for the same phase+model accumulate into one bucket', async () => {
    accumulator.onRoutingSelected({
      dispatchId: 'dispatch-a',
      phase: 'generate',
      model: 'claude-sonnet-4-5',
    })
    accumulator.onRoutingSelected({
      dispatchId: 'dispatch-b',
      phase: 'generate',
      model: 'claude-sonnet-4-5',
    })
    accumulator.onAgentCompleted({ dispatchId: 'dispatch-a', inputTokens: 100, outputTokens: 50 })
    accumulator.onAgentCompleted({ dispatchId: 'dispatch-b', inputTokens: 200, outputTokens: 100 })
    await accumulator.flush('run-3')

    const breakdown = vi.mocked(stateStore.setMetric).mock.calls[0][2] as {
      entries: Array<{
        phase: string
        inputTokens: number
        outputTokens: number
        dispatchCount: number
      }>
    }
    expect(breakdown.entries).toHaveLength(1)
    expect(breakdown.entries[0].inputTokens).toBe(300)
    expect(breakdown.entries[0].outputTokens).toBe(150)
    expect(breakdown.entries[0].dispatchCount).toBe(2)
  })

  it('AC2: distinct (phase, model) combinations produce separate entries', async () => {
    accumulator.onRoutingSelected({
      dispatchId: 'dispatch-a',
      phase: 'explore',
      model: 'claude-haiku-4-5',
    })
    accumulator.onRoutingSelected({
      dispatchId: 'dispatch-b',
      phase: 'generate',
      model: 'claude-sonnet-4-5',
    })
    accumulator.onAgentCompleted({ dispatchId: 'dispatch-a', inputTokens: 100, outputTokens: 50 })
    accumulator.onAgentCompleted({ dispatchId: 'dispatch-b', inputTokens: 200, outputTokens: 100 })
    await accumulator.flush('run-4')

    const breakdown = vi.mocked(stateStore.setMetric).mock.calls[0][2] as {
      entries: Array<{ phase: string; model: string }>
    }
    expect(breakdown.entries).toHaveLength(2)
    const phases = breakdown.entries.map((e) => e.phase).sort()
    expect(phases).toEqual(['explore', 'generate'])
  })
})

// ---------------------------------------------------------------------------
// AC3: flush(runId) — persists PhaseTokenBreakdown to StateStore
// ---------------------------------------------------------------------------

describe('RoutingTokenAccumulator.flush (AC3 — StateStore persistence)', () => {
  let logger: pino.Logger
  let stateStore: StateStore
  let accumulator: RoutingTokenAccumulator

  beforeEach(() => {
    logger = createMockLogger()
    stateStore = createMockStateStore()
    accumulator = new RoutingTokenAccumulator(FIXTURE_CONFIG, stateStore, logger)
  })

  it('AC3: flush calls stateStore.setMetric with the correct runId and key', async () => {
    accumulator.onRoutingSelected({
      dispatchId: 'dispatch-1',
      phase: 'generate',
      model: 'claude-sonnet-4-5',
    })
    accumulator.onAgentCompleted({ dispatchId: 'dispatch-1', inputTokens: 100, outputTokens: 50 })
    await accumulator.flush('run-abc-123')

    expect(stateStore.setMetric).toHaveBeenCalledWith(
      'run-abc-123',
      'phase_token_breakdown',
      expect.any(Object)
    )
  })

  it('AC3: flush persists the correct breakdown structure', async () => {
    accumulator.onRoutingSelected({
      dispatchId: 'dispatch-1',
      phase: 'generate',
      model: 'claude-sonnet-4-5',
    })
    accumulator.onAgentCompleted({ dispatchId: 'dispatch-1', inputTokens: 100, outputTokens: 50 })
    await accumulator.flush('run-abc-123')

    const breakdown = vi.mocked(stateStore.setMetric).mock.calls[0][2] as {
      entries: unknown[]
      baselineModel: string
      runId: string
    }
    expect(breakdown.runId).toBe('run-abc-123')
    expect(breakdown.baselineModel).toBe('claude-sonnet-4-5')
    expect(breakdown.entries).toHaveLength(1)
  })

  it('AC3: flush persists empty entries when no dispatches were recorded', async () => {
    await accumulator.flush('run-empty')

    expect(stateStore.setMetric).toHaveBeenCalledOnce()
    const breakdown = vi.mocked(stateStore.setMetric).mock.calls[0][2] as { entries: unknown[] }
    expect(breakdown.entries).toHaveLength(0)
  })

  it('AC3: flush clears in-memory state — a second flush writes an empty breakdown', async () => {
    accumulator.onRoutingSelected({
      dispatchId: 'dispatch-1',
      phase: 'generate',
      model: 'claude-sonnet-4-5',
    })
    accumulator.onAgentCompleted({ dispatchId: 'dispatch-1', inputTokens: 100, outputTokens: 50 })
    await accumulator.flush('run-first')
    await accumulator.flush('run-second')

    const firstBreakdown = vi.mocked(stateStore.setMetric).mock.calls[0][2] as {
      entries: unknown[]
    }
    const secondBreakdown = vi.mocked(stateStore.setMetric).mock.calls[1][2] as {
      entries: unknown[]
    }
    expect(firstBreakdown.entries).toHaveLength(1)
    expect(secondBreakdown.entries).toHaveLength(0)
  })

  it('AC3: flush logs a debug message with entryCount', async () => {
    accumulator.onRoutingSelected({
      dispatchId: 'dispatch-1',
      phase: 'generate',
      model: 'claude-sonnet-4-5',
    })
    accumulator.onAgentCompleted({ dispatchId: 'dispatch-1', inputTokens: 100, outputTokens: 50 })
    await accumulator.flush('run-log-test')

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-log-test', entryCount: 1 }),
      expect.any(String)
    )
  })
})
