/**
 * Unit tests for the SDLC event bridge.
 *
 * Story 43-9: SDLC-as-Graph NDJSON Event Compatibility.
 * AC1, AC2, AC3, AC4, AC5, AC7.
 */

import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSdlcEventBridge } from '../event-bridge.js'
import type { SdlcEventBridgeOptions } from '../event-bridge.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a fresh test fixture: EventEmitter for graphEvents, vi.fn() mock for sdlcBus. */
function makeFixture(overrides: Partial<SdlcEventBridgeOptions> = {}) {
  const graphEvents = new EventEmitter()
  const sdlcBus = { emit: vi.fn() }
  const opts: SdlcEventBridgeOptions = {
    storyKey: '43-9',
    sdlcBus,
    graphEvents: graphEvents as unknown as SdlcEventBridgeOptions['graphEvents'],
    ...overrides,
  }
  const bridge = createSdlcEventBridge(opts)
  return { graphEvents, sdlcBus, bridge }
}

// ---------------------------------------------------------------------------
// AC1: graph:node-started → orchestrator:story-phase-start
// ---------------------------------------------------------------------------

describe('AC1: graph:node-started → orchestrator:story-phase-start', () => {
  it('emits story-phase-start for dev_story with phase "dev"', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    graphEvents.emit('graph:node-started', { runId: 'r1', nodeId: 'dev_story', nodeType: 'sdlc.dev-story' })
    expect(sdlcBus.emit).toHaveBeenCalledWith(
      'orchestrator:story-phase-start',
      expect.objectContaining({ storyKey: '43-9', phase: 'dev' }),
    )
  })

  it('maps all SDLC nodes to correct phase names', () => {
    const nodeToPhase: Array<[string, string]> = [
      ['analysis', 'analysis'],
      ['planning', 'planning'],
      ['solutioning', 'solutioning'],
      ['create_story', 'create'],
      ['dev_story', 'dev'],
      ['code_review', 'review'],
    ]

    for (const [nodeId, expectedPhase] of nodeToPhase) {
      const { graphEvents, sdlcBus } = makeFixture()
      graphEvents.emit('graph:node-started', { runId: 'r1', nodeId, nodeType: 'sdlc.phase' })
      expect(sdlcBus.emit).toHaveBeenCalledWith(
        'orchestrator:story-phase-start',
        expect.objectContaining({ storyKey: '43-9', phase: expectedPhase }),
      )
    }
  })

  it('includes pipelineRunId in payload when provided', () => {
    const { graphEvents, sdlcBus } = makeFixture({ pipelineRunId: 'run-42' })
    graphEvents.emit('graph:node-started', { runId: 'r1', nodeId: 'dev_story', nodeType: 'sdlc.dev-story' })
    expect(sdlcBus.emit).toHaveBeenCalledWith(
      'orchestrator:story-phase-start',
      expect.objectContaining({ storyKey: '43-9', phase: 'dev', pipelineRunId: 'run-42' }),
    )
  })

  it('includes storyKey from opts in all emitted events', () => {
    const { graphEvents, sdlcBus } = makeFixture({ storyKey: 'custom-key-1' })
    graphEvents.emit('graph:node-started', { runId: 'r1', nodeId: 'planning', nodeType: 'sdlc.phase' })
    expect(sdlcBus.emit).toHaveBeenCalledWith(
      'orchestrator:story-phase-start',
      expect.objectContaining({ storyKey: 'custom-key-1', phase: 'planning' }),
    )
  })
})

// ---------------------------------------------------------------------------
// AC2: graph:node-completed → orchestrator:story-phase-complete
// ---------------------------------------------------------------------------

describe('AC2: graph:node-completed → orchestrator:story-phase-complete', () => {
  it('emits story-phase-complete for code_review with outcome in result', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    const outcome = { status: 'SUCCESS', notes: 'LGTM' }
    graphEvents.emit('graph:node-completed', { runId: 'r1', nodeId: 'code_review', outcome })
    expect(sdlcBus.emit).toHaveBeenCalledWith(
      'orchestrator:story-phase-complete',
      expect.objectContaining({ storyKey: '43-9', phase: 'review', result: outcome }),
    )
  })

  it('emits story-phase-complete for dev_story with phase "dev"', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    const outcome = { status: 'SUCCESS' }
    graphEvents.emit('graph:node-completed', { runId: 'r1', nodeId: 'dev_story', outcome })
    expect(sdlcBus.emit).toHaveBeenCalledWith(
      'orchestrator:story-phase-complete',
      expect.objectContaining({ storyKey: '43-9', phase: 'dev', result: outcome }),
    )
  })

  it('includes pipelineRunId in story-phase-complete when provided', () => {
    const { graphEvents, sdlcBus } = makeFixture({ pipelineRunId: 'pipeline-99' })
    graphEvents.emit('graph:node-completed', { runId: 'r1', nodeId: 'analysis', outcome: { status: 'SUCCESS' } })
    expect(sdlcBus.emit).toHaveBeenCalledWith(
      'orchestrator:story-phase-complete',
      expect.objectContaining({ pipelineRunId: 'pipeline-99' }),
    )
  })
})

// ---------------------------------------------------------------------------
// AC3: graph:completed (SUCCESS) → orchestrator:story-complete
// ---------------------------------------------------------------------------

describe('AC3: graph:completed → orchestrator:story-complete', () => {
  it('emits story-complete with reviewCycles=0 when no retries occurred', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    graphEvents.emit('graph:completed', {
      runId: 'r1',
      finalOutcome: { status: 'SUCCESS' },
      totalCostUsd: 0,
      durationMs: 0,
    })
    expect(sdlcBus.emit).toHaveBeenCalledWith(
      'orchestrator:story-complete',
      expect.objectContaining({ storyKey: '43-9', reviewCycles: 0 }),
    )
  })

  it('emits story-complete with reviewCycles=2 after two graph:node-retried events for dev_story', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    graphEvents.emit('graph:node-retried', { runId: 'r1', nodeId: 'dev_story', attempt: 1, maxAttempts: 3, delayMs: 0 })
    graphEvents.emit('graph:node-retried', { runId: 'r1', nodeId: 'dev_story', attempt: 2, maxAttempts: 3, delayMs: 0 })
    graphEvents.emit('graph:completed', {
      runId: 'r1',
      finalOutcome: { status: 'SUCCESS' },
      totalCostUsd: 0,
      durationMs: 0,
    })
    expect(sdlcBus.emit).toHaveBeenCalledWith(
      'orchestrator:story-complete',
      expect.objectContaining({ storyKey: '43-9', reviewCycles: 2 }),
    )
  })

  it('does NOT emit story-complete when finalOutcome.status is not SUCCESS', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    graphEvents.emit('graph:completed', {
      runId: 'r1',
      finalOutcome: { status: 'FAIL' },
      totalCostUsd: 0,
      durationMs: 0,
    })
    expect(sdlcBus.emit).not.toHaveBeenCalledWith(
      'orchestrator:story-complete',
      expect.anything(),
    )
  })
})

// ---------------------------------------------------------------------------
// AC4: graph:goal-gate-unsatisfied → orchestrator:story-escalated
// ---------------------------------------------------------------------------

describe('AC4: graph:goal-gate-unsatisfied → orchestrator:story-escalated', () => {
  it('emits story-escalated with NEEDS_MAJOR_REWORK when dev_story goal gate is unsatisfied', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    graphEvents.emit('graph:goal-gate-unsatisfied', { runId: 'r1', nodeId: 'dev_story', retryTarget: null })
    expect(sdlcBus.emit).toHaveBeenCalledWith(
      'orchestrator:story-escalated',
      expect.objectContaining({
        storyKey: '43-9',
        lastVerdict: 'NEEDS_MAJOR_REWORK',
        reviewCycles: 0,
        issues: [],
      }),
    )
  })

  it('includes correct reviewCycles count in escalation payload', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    graphEvents.emit('graph:node-retried', { runId: 'r1', nodeId: 'dev_story', attempt: 1, maxAttempts: 3, delayMs: 0 })
    graphEvents.emit('graph:node-retried', { runId: 'r1', nodeId: 'dev_story', attempt: 2, maxAttempts: 3, delayMs: 0 })
    graphEvents.emit('graph:node-retried', { runId: 'r1', nodeId: 'dev_story', attempt: 3, maxAttempts: 3, delayMs: 0 })
    graphEvents.emit('graph:goal-gate-unsatisfied', { runId: 'r1', nodeId: 'dev_story', retryTarget: null })
    expect(sdlcBus.emit).toHaveBeenCalledWith(
      'orchestrator:story-escalated',
      expect.objectContaining({ reviewCycles: 3 }),
    )
  })

  it('does NOT emit story-escalated for non-dev_story nodes', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    graphEvents.emit('graph:goal-gate-unsatisfied', { runId: 'r1', nodeId: 'code_review', retryTarget: null })
    expect(sdlcBus.emit).not.toHaveBeenCalledWith(
      'orchestrator:story-escalated',
      expect.anything(),
    )
  })
})

// ---------------------------------------------------------------------------
// AC5: Non-SDLC nodes are silently ignored
// ---------------------------------------------------------------------------

describe('AC5: non-SDLC nodes are silently ignored', () => {
  it('emits no SDLC event for graph:node-started on "start" node', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    graphEvents.emit('graph:node-started', { runId: 'r1', nodeId: 'start', nodeType: 'start' })
    expect(sdlcBus.emit).not.toHaveBeenCalled()
  })

  it('emits no SDLC event for graph:node-started on "exit" node', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    graphEvents.emit('graph:node-started', { runId: 'r1', nodeId: 'exit', nodeType: 'exit' })
    expect(sdlcBus.emit).not.toHaveBeenCalled()
  })

  it('emits no SDLC event for graph:node-completed on "start" node', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    graphEvents.emit('graph:node-completed', { runId: 'r1', nodeId: 'start', outcome: { status: 'SUCCESS' } })
    expect(sdlcBus.emit).not.toHaveBeenCalled()
  })

  it('emits no SDLC event for graph:node-completed on "exit" node', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    graphEvents.emit('graph:node-completed', { runId: 'r1', nodeId: 'exit', outcome: { status: 'SUCCESS' } })
    expect(sdlcBus.emit).not.toHaveBeenCalled()
  })

  it('emits no SDLC event for an unknown node ID', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    graphEvents.emit('graph:node-started', { runId: 'r1', nodeId: 'unknown_node', nodeType: 'custom' })
    expect(sdlcBus.emit).not.toHaveBeenCalled()
  })

  it('does NOT count graph:node-retried for non-dev_story nodes in reviewCycles', () => {
    const { graphEvents, sdlcBus } = makeFixture()
    // Retry on code_review (not dev_story) should NOT count toward reviewCycles
    graphEvents.emit('graph:node-retried', { runId: 'r1', nodeId: 'code_review', attempt: 1, maxAttempts: 3, delayMs: 0 })
    graphEvents.emit('graph:completed', {
      runId: 'r1',
      finalOutcome: { status: 'SUCCESS' },
      totalCostUsd: 0,
      durationMs: 0,
    })
    expect(sdlcBus.emit).toHaveBeenCalledWith(
      'orchestrator:story-complete',
      expect.objectContaining({ reviewCycles: 0 }),
    )
  })
})

// ---------------------------------------------------------------------------
// AC7: Bridge teardown removes all graph event listeners
// ---------------------------------------------------------------------------

describe('AC7: bridge teardown removes all graph event listeners', () => {
  it('after teardown(), graph events produce no further SDLC emissions', () => {
    const { graphEvents, sdlcBus, bridge } = makeFixture()

    // Fire some events before teardown to establish baseline behavior
    graphEvents.emit('graph:node-started', { runId: 'r1', nodeId: 'dev_story', nodeType: 'sdlc.dev-story' })
    const callsBeforeTeardown = sdlcBus.emit.mock.calls.length
    expect(callsBeforeTeardown).toBeGreaterThan(0)

    // Teardown the bridge
    bridge.teardown()

    // Reset the mock to verify no new calls happen
    sdlcBus.emit.mockClear()

    // Fire the same events again — should produce zero SDLC emissions
    graphEvents.emit('graph:node-started', { runId: 'r1', nodeId: 'dev_story', nodeType: 'sdlc.dev-story' })
    graphEvents.emit('graph:node-completed', { runId: 'r1', nodeId: 'dev_story', outcome: { status: 'SUCCESS' } })
    graphEvents.emit('graph:node-retried', { runId: 'r1', nodeId: 'dev_story', attempt: 1, maxAttempts: 2, delayMs: 0 })
    graphEvents.emit('graph:completed', { runId: 'r1', finalOutcome: { status: 'SUCCESS' }, totalCostUsd: 0, durationMs: 0 })
    graphEvents.emit('graph:goal-gate-unsatisfied', { runId: 'r1', nodeId: 'dev_story', retryTarget: null })

    expect(sdlcBus.emit).not.toHaveBeenCalled()
  })

  it('teardown() removes exactly the registered listeners (EventEmitter listener count drops to zero)', () => {
    const graphEvents = new EventEmitter()
    const sdlcBus = { emit: vi.fn() }
    const bridge = createSdlcEventBridge({
      storyKey: 'teardown-test',
      sdlcBus,
      graphEvents: graphEvents as unknown as SdlcEventBridgeOptions['graphEvents'],
    })

    // Before teardown: listeners are registered
    expect(graphEvents.listenerCount('graph:node-started')).toBe(1)
    expect(graphEvents.listenerCount('graph:node-completed')).toBe(1)
    expect(graphEvents.listenerCount('graph:node-retried')).toBe(1)
    expect(graphEvents.listenerCount('graph:completed')).toBe(1)
    expect(graphEvents.listenerCount('graph:goal-gate-unsatisfied')).toBe(1)

    bridge.teardown()

    // After teardown: all listeners removed
    expect(graphEvents.listenerCount('graph:node-started')).toBe(0)
    expect(graphEvents.listenerCount('graph:node-completed')).toBe(0)
    expect(graphEvents.listenerCount('graph:node-retried')).toBe(0)
    expect(graphEvents.listenerCount('graph:completed')).toBe(0)
    expect(graphEvents.listenerCount('graph:goal-gate-unsatisfied')).toBe(0)
  })
})
