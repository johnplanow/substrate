/**
 * SDLC Parity Test Suite — Story 43-11
 *
 * Verifies that the graph SDLC engine (SdlcEventBridge + GraphOrchestrator)
 * produces the same orchestrator:story-* event sequences as the linear
 * reference model across happy-path, rework, escalation, and batch scenarios.
 *
 * All execution is driven by in-process mock executors — no network calls,
 * no actual dispatcher invocations (AC6).
 *
 * ADR-003 compliance: imports only from packages/sdlc/src/ — no imports
 * from the monolith src/ or @substrate-ai/factory runtime values.
 */

import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import { createGraphOrchestrator } from '../orchestrator/graph-orchestrator.js'
import type {
  GraphShape,
  IGraphExecutorLocal,
  GraphRunResult,
} from '../orchestrator/graph-orchestrator.js'
import { createSdlcEventBridge } from '../handlers/event-bridge.js'
import type { GraphEventEmitter, SdlcEventBus } from '../handlers/event-bridge.js'

// ---------------------------------------------------------------------------
// Task 1: Harness types
// ---------------------------------------------------------------------------

/** A single captured SDLC bus event with its name and payload. */
interface ParityEvent {
  name: string
  payload: Record<string, unknown>
}

/**
 * Scenario descriptor for the parity harness.
 * Note: 'PariityScenario' spelling is intentional per story 43-11 spec.
 */
type PariityScenario = {
  storyKey: string
  phases: Array<{ nodeId: string; outcomeStatus: 'SUCCESS' | 'FAIL' }>
}

/** Captured output from a graph scenario run. */
interface ParityCapture {
  events: ParityEvent[]
  summary: { successCount: number; failureCount: number; totalStories: number }
}

// ---------------------------------------------------------------------------
// SDLC node phase map — local copy, event-bridge.ts does not export it
// ---------------------------------------------------------------------------

/** Maps factory graph node IDs to SDLC phase names (mirrors event-bridge.ts). */
const SDLC_NODE_PHASE_MAP: Record<string, string> = {
  analysis: 'analysis',
  planning: 'planning',
  solutioning: 'solutioning',
  create_story: 'create',
  dev_story: 'dev',
  code_review: 'review',
}

// ---------------------------------------------------------------------------
// Task 1: buildReferenceEvents — linear reference model
// ---------------------------------------------------------------------------

/**
 * Derives the expected linear-engine event sequence from the SDLC_NODE_PHASE_MAP
 * and the scenario's phase list.
 *
 * Rules:
 * - Each phase produces a phase-start + phase-complete pair.
 * - A code_review FAIL that has a subsequent phase → devStoryRetries++ (retry scheduled).
 * - A code_review FAIL with no subsequent phase → escalation terminal event.
 * - Non-SDLC nodes (start, exit) are silently ignored.
 * - Terminal event is either story-complete (with reviewCycles) or story-escalated.
 */
function buildReferenceEvents(scenario: PariityScenario): ParityEvent[] {
  const { storyKey, phases } = scenario
  const events: ParityEvent[] = []
  let devStoryRetries = 0
  let isEscalated = false

  for (const [i, phase] of phases.entries()) {
    const phaseName = SDLC_NODE_PHASE_MAP[phase.nodeId]
    if (!phaseName) continue // silently ignore non-SDLC nodes (start, exit)

    events.push({
      name: 'orchestrator:story-phase-start',
      payload: { storyKey, phase: phaseName },
    })
    events.push({
      name: 'orchestrator:story-phase-complete',
      payload: { storyKey, phase: phaseName, result: { status: phase.outcomeStatus } },
    })

    // Track rework cycles: a failed code_review with a next phase means a retry was scheduled
    if (phase.nodeId === 'code_review' && phase.outcomeStatus === 'FAIL') {
      const hasNextPhase = i + 1 < phases.length
      if (hasNextPhase) {
        devStoryRetries++
      } else {
        // Final failure — retries exhausted → escalation
        isEscalated = true
      }
    }
  }

  // Append terminal event
  if (isEscalated) {
    events.push({
      name: 'orchestrator:story-escalated',
      payload: {
        storyKey,
        lastVerdict: 'NEEDS_MAJOR_REWORK',
        reviewCycles: devStoryRetries,
        issues: [],
      },
    })
  } else {
    events.push({
      name: 'orchestrator:story-complete',
      payload: { storyKey, reviewCycles: devStoryRetries },
    })
  }

  return events
}

// ---------------------------------------------------------------------------
// Task 2: runGraphScenario — drives SdlcEventBridge with mock graph events
// ---------------------------------------------------------------------------

/**
 * Runs a scenario through the graph engine by manually wiring an SdlcEventBridge
 * to a local EventEmitter and emitting synthetic graph:* events according to
 * the scenario's phase list.
 *
 * Event emission rules:
 * - Each phase: graph:node-started → graph:node-completed
 * - code_review FAIL + has next phase → graph:node-retried { nodeId: 'dev_story' }
 * - code_review FAIL + no next phase → graph:goal-gate-unsatisfied { nodeId: 'dev_story' }
 * - No escalation → graph:completed { finalOutcome: { status: 'SUCCESS' } }
 */
async function runGraphScenario(
  scenario: PariityScenario,
  _opts: { maxReviewCycles?: number } = {},
): Promise<ParityCapture> {
  const capturedEvents: ParityEvent[] = []
  const sdlcBus: SdlcEventBus = {
    emit: (name: string, payload: unknown) => {
      capturedEvents.push({ name, payload: payload as Record<string, unknown> })
    },
  }

  // Per-story factory bus — the bridge subscribes to this
  const factoryBus = new EventEmitter()
  const bridge = createSdlcEventBridge({
    storyKey: scenario.storyKey,
    pipelineRunId: 'test-run-id',
    sdlcBus,
    graphEvents: factoryBus as unknown as GraphEventEmitter,
  })

  let isEscalated = false
  try {
    const phases = scenario.phases
    for (const [i, phase] of phases.entries()) {
      factoryBus.emit('graph:node-started', { nodeId: phase.nodeId })
      factoryBus.emit('graph:node-completed', {
        nodeId: phase.nodeId,
        outcome: { status: phase.outcomeStatus },
      })

      // code_review FAIL drives retry or escalation signalling
      if (phase.nodeId === 'code_review' && phase.outcomeStatus === 'FAIL') {
        const hasNextPhase = i + 1 < phases.length
        if (hasNextPhase) {
          // Retry scheduled — emit node-retried so bridge increments devStoryRetries
          factoryBus.emit('graph:node-retried', { nodeId: 'dev_story' })
        } else {
          // Retries exhausted → escalation
          factoryBus.emit('graph:goal-gate-unsatisfied', { nodeId: 'dev_story' })
          isEscalated = true
        }
      }
    }

    if (!isEscalated) {
      factoryBus.emit('graph:completed', { finalOutcome: { status: 'SUCCESS' } })
    }
  } finally {
    bridge.teardown()
  }

  return {
    events: capturedEvents,
    summary: {
      successCount: isEscalated ? 0 : 1,
      failureCount: isEscalated ? 1 : 0,
      totalStories: 1,
    },
  }
}

// ---------------------------------------------------------------------------
// Task 3: assertParity — comparison helper
// ---------------------------------------------------------------------------

/**
 * Asserts that the graph engine event sequence matches the linear reference.
 *
 * - Checks event name sequences are identical (catches ordering/count divergences).
 * - For each matching index, checks the graph payload contains all reference fields
 *   via objectContaining (allows extra fields such as pipelineRunId).
 * - If event counts differ, the failure message includes the counts.
 *
 * Throws an AssertionError (via Vitest expect) on any divergence (AC7).
 */
function assertParity(linear: ParityEvent[], graph: ParityEvent[]): void {
  const linearNames = linear.map((e) => e.name)
  const graphNames = graph.map((e) => e.name)

  expect(
    graphNames,
    `Event sequence mismatch — linear has ${linear.length} events, graph has ${graph.length} events`,
  ).toEqual(linearNames)

  for (const [i, linearEvent] of linear.entries()) {
    const graphEvent = graph[i]!
    expect(
      graphEvent.payload,
      `Payload mismatch at index ${i} (event: ${linearEvent.name})`,
    ).toMatchObject(linearEvent.payload)
  }
}

// ---------------------------------------------------------------------------
// Shared scenario phase definitions
// ---------------------------------------------------------------------------

/** Happy path: all three phases succeed on first attempt. */
const happyPathPhases: PariityScenario['phases'] = [
  { nodeId: 'create_story', outcomeStatus: 'SUCCESS' },
  { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' },
  { nodeId: 'code_review', outcomeStatus: 'SUCCESS' },
]

/**
 * Rework scenario: code_review fails once, then dev_story retries and
 * code_review succeeds on the second attempt (reviewCycles: 1).
 */
const reworkPhases: PariityScenario['phases'] = [
  { nodeId: 'create_story', outcomeStatus: 'SUCCESS' },
  { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' },
  { nodeId: 'code_review', outcomeStatus: 'FAIL' }, // triggers retry
  { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' }, // retry 1
  { nodeId: 'code_review', outcomeStatus: 'SUCCESS' }, // success on second attempt
]

/**
 * Escalation scenario (maxReviewCycles: 2): code_review always fails.
 * After 2 retries (3 total code_review attempts), goal-gate-unsatisfied fires.
 * Results in reviewCycles: 2 in the escalated event.
 */
const escalationPhases: PariityScenario['phases'] = [
  { nodeId: 'create_story', outcomeStatus: 'SUCCESS' },
  { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' },
  { nodeId: 'code_review', outcomeStatus: 'FAIL' }, // attempt 1 → node-retried [retries: 1]
  { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' }, // retry 1
  { nodeId: 'code_review', outcomeStatus: 'FAIL' }, // attempt 2 → node-retried [retries: 2]
  { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' }, // retry 2 (last chance)
  { nodeId: 'code_review', outcomeStatus: 'FAIL' }, // attempt 3 → goal-gate-unsatisfied
]

// ---------------------------------------------------------------------------
// Task 4: Happy-path parity test (AC1, AC5)
// ---------------------------------------------------------------------------

describe('AC1: happy-path parity — events and summary match', () => {
  it('event name sequence and summary equal the linear reference', async () => {
    const scenario: PariityScenario = { storyKey: 'test-happy', phases: happyPathPhases }
    const referenceEvents = buildReferenceEvents(scenario)
    const capture = await runGraphScenario(scenario, { maxReviewCycles: 2 })

    // AC1: summary must show successCount: 1, failureCount: 0, totalStories: 1
    expect(capture.summary).toEqual({ successCount: 1, failureCount: 0, totalStories: 1 })

    // AC1: ordered event sequence must match the linear reference
    assertParity(referenceEvents, capture.events)
  })
})

// ---------------------------------------------------------------------------
// AC5: Phase event payload shape matches linear contract
// ---------------------------------------------------------------------------

describe('AC5: phase event payload shape matches linear contract', () => {
  it('story-phase-start payloads contain { storyKey, phase } fields', async () => {
    const scenario: PariityScenario = { storyKey: 'test-shape', phases: happyPathPhases }
    const capture = await runGraphScenario(scenario)
    const phaseStartEvents = capture.events.filter(
      (e) => e.name === 'orchestrator:story-phase-start',
    )

    expect(phaseStartEvents.length).toBeGreaterThan(0)
    for (const event of phaseStartEvents) {
      // Required fields per AC5; pipelineRunId is optional
      expect(event.payload).toMatchObject({
        storyKey: 'test-shape',
        phase: expect.any(String),
      })
    }
  })

  it('story-phase-complete payloads contain { storyKey, phase, result } fields', async () => {
    const scenario: PariityScenario = { storyKey: 'test-shape', phases: happyPathPhases }
    const capture = await runGraphScenario(scenario)
    const phaseCompleteEvents = capture.events.filter(
      (e) => e.name === 'orchestrator:story-phase-complete',
    )

    expect(phaseCompleteEvents.length).toBeGreaterThan(0)
    for (const event of phaseCompleteEvents) {
      // Required fields per AC5; pipelineRunId is optional
      expect(event.payload).toMatchObject({
        storyKey: 'test-shape',
        phase: expect.any(String),
        result: expect.anything(),
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Task 5: Rework-cycle parity test (AC2)
// ---------------------------------------------------------------------------

describe('AC2: rework-cycle parity — review retry event sequence matches', () => {
  it('emits two phase-start/complete pairs for dev and review; story-complete reviewCycles: 1', async () => {
    const scenario: PariityScenario = { storyKey: 'test-rework', phases: reworkPhases }
    const referenceEvents = buildReferenceEvents(scenario)
    const capture = await runGraphScenario(scenario, { maxReviewCycles: 2 })

    // AC2: two orchestrator:story-phase-start events for the 'dev' phase
    const devStarts = capture.events.filter(
      (e) => e.name === 'orchestrator:story-phase-start' && e.payload['phase'] === 'dev',
    )
    expect(devStarts).toHaveLength(2)

    // AC2: two orchestrator:story-phase-start events for the 'review' phase
    const reviewStarts = capture.events.filter(
      (e) => e.name === 'orchestrator:story-phase-start' && e.payload['phase'] === 'review',
    )
    expect(reviewStarts).toHaveLength(2)

    // AC2: terminal event is story-complete with reviewCycles: 1
    const terminal = capture.events.at(-1)
    expect(terminal).toBeDefined()
    expect(terminal!.name).toBe('orchestrator:story-complete')
    expect(terminal!.payload['reviewCycles']).toBe(1)

    // Full parity assertion
    assertParity(referenceEvents, capture.events)
  })
})

// ---------------------------------------------------------------------------
// Task 6: Escalation parity test (AC3)
// ---------------------------------------------------------------------------

describe('AC3: escalation parity — escalated events match', () => {
  it('emits story-escalated (not story-complete); summary failureCount: 1', async () => {
    const scenario: PariityScenario = { storyKey: 'test-escalate', phases: escalationPhases }
    const referenceEvents = buildReferenceEvents(scenario)
    const capture = await runGraphScenario(scenario, { maxReviewCycles: 2 })

    // AC3: summary must show successCount: 0, failureCount: 1
    expect(capture.summary).toEqual({ successCount: 0, failureCount: 1, totalStories: 1 })

    // AC3: terminal event must be story-escalated (not story-complete)
    const terminal = capture.events.at(-1)
    expect(terminal).toBeDefined()
    expect(terminal!.name).toBe('orchestrator:story-escalated')
    expect(terminal!.name).not.toBe('orchestrator:story-complete')

    // Full parity assertion
    assertParity(referenceEvents, capture.events)
  })
})

// ---------------------------------------------------------------------------
// Task 6: Multi-story batch parity test (AC4)
// ---------------------------------------------------------------------------

describe('AC4: multi-story batch parity — per-story events are isolated', () => {
  it('story A (happy) and story B (escalation) events are isolated; summary 1 success + 1 failure', async () => {
    // Per-storyKey event capture — proves isolation (no cross-story contamination)
    const capturedByStory = new Map<string, ParityEvent[]>()
    const sdlcBus: SdlcEventBus = {
      emit: (name: string, payload: unknown) => {
        const p = payload as Record<string, unknown>
        const sk = p['storyKey'] as string
        if (sk) {
          if (!capturedByStory.has(sk)) capturedByStory.set(sk, [])
          capturedByStory.get(sk)!.push({ name, payload: p })
        }
      },
    }

    // Phase data keyed by storyKey
    const phasesByStory = new Map<string, PariityScenario['phases']>([
      ['test-A', happyPathPhases],
      ['test-B', escalationPhases],
    ])

    // Minimal 8-node graph shape (orchestrator validates nodes + edges arrays exist)
    const graphShape: GraphShape = {
      nodes: [
        'start',
        'analysis',
        'planning',
        'solutioning',
        'create_story',
        'dev_story',
        'code_review',
        'exit',
      ].map((id) => ({ id, type: 'sdlc.phase', label: id, prompt: '' })),
      edges: [],
    }

    // Mock executor: emits graph events on the factoryBus supplied by the orchestrator
    const executor: IGraphExecutorLocal = {
      run: vi.fn().mockImplementation(async (_graph, config) => {
        const storyKey = (config.initialContext as Record<string, unknown>)?.['storyKey'] as string
        const phases = phasesByStory.get(storyKey) ?? []
        const bus = config.eventBus as EventEmitter

        let isEscalated = false
        for (const [i, phase] of phases.entries()) {
          bus.emit('graph:node-started', { nodeId: phase.nodeId })
          bus.emit('graph:node-completed', {
            nodeId: phase.nodeId,
            outcome: { status: phase.outcomeStatus },
          })
          if (phase.nodeId === 'code_review' && phase.outcomeStatus === 'FAIL') {
            if (i + 1 < phases.length) {
              bus.emit('graph:node-retried', { nodeId: 'dev_story' })
            } else {
              bus.emit('graph:goal-gate-unsatisfied', { nodeId: 'dev_story' })
              isEscalated = true
            }
          }
        }
        if (!isEscalated) {
          bus.emit('graph:completed', { finalOutcome: { status: 'SUCCESS' } })
        }

        // Executor return status drives orchestrator's success/failure count
        return { status: isEscalated ? 'FAIL' : 'SUCCESS' } as GraphRunResult
      }),
    }

    const orchestrator = createGraphOrchestrator({
      graph: graphShape,
      executor,
      handlerRegistry: {},
      projectRoot: '/test/root',
      methodologyPack: 'default',
      maxConcurrency: 1,
      logsRoot: '/test/logs',
      runId: 'parity-test-run',
      gcPauseMs: 0,
      eventBus: sdlcBus,
      pipelineRunId: 'test-run-id',
    })

    const summary = await orchestrator.run(['test-A', 'test-B'])

    // AC4: summary shows 1 success + 1 failure
    expect(summary).toMatchObject({ successCount: 1, failureCount: 1, totalStories: 2 })

    const eventsA = capturedByStory.get('test-A') ?? []
    const eventsB = capturedByStory.get('test-B') ?? []

    // AC4: no cross-story event contamination
    expect(eventsA.every((e) => e.payload['storyKey'] === 'test-A')).toBe(true)
    expect(eventsB.every((e) => e.payload['storyKey'] === 'test-B')).toBe(true)

    // AC4: per-story events match their respective references
    const referenceA = buildReferenceEvents({ storyKey: 'test-A', phases: happyPathPhases })
    assertParity(referenceA, eventsA)

    const referenceB = buildReferenceEvents({ storyKey: 'test-B', phases: escalationPhases })
    assertParity(referenceB, eventsB)
  })
})

// ---------------------------------------------------------------------------
// Task 7: Divergence detection test (AC7)
// ---------------------------------------------------------------------------

describe('AC7: divergence detection — injected divergence causes clear test failure', () => {
  it('assertParity throws when graph capture has an extra story-phase-start event', () => {
    const scenario: PariityScenario = { storyKey: 'test-diverge', phases: happyPathPhases }
    const referenceEvents = buildReferenceEvents(scenario)

    // Inject one extra orchestrator:story-phase-start before the terminal event
    const dirtyEvents = [...referenceEvents]
    dirtyEvents.splice(dirtyEvents.length - 1, 0, {
      name: 'orchestrator:story-phase-start',
      payload: { storyKey: 'test-diverge', phase: 'dev' },
    })

    // Parity assertion must fail and throw — catching divergence (AC7)
    expect(() => assertParity(referenceEvents, dirtyEvents)).toThrow()
  })

  it('assertParity does NOT throw when graph capture exactly matches the reference', () => {
    const scenario: PariityScenario = { storyKey: 'test-match', phases: happyPathPhases }
    const referenceEvents = buildReferenceEvents(scenario)
    // Clone to ensure we're not comparing the same reference
    const matchingEvents = referenceEvents.map((e) => ({ ...e, payload: { ...e.payload } }))

    expect(() => assertParity(referenceEvents, matchingEvents)).not.toThrow()
  })
})
