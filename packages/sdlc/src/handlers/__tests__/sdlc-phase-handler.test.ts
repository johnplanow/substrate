/**
 * Unit tests for SdlcPhaseHandler.
 * Story 43-2.
 *
 * Covers all acceptance criteria (AC1–AC7) plus supplementary behaviours.
 *
 * Mock strategy: phase runner functions and PhaseOrchestrator are injected via
 * SdlcPhaseHandlerDeps (vi.fn() stubs passed directly) — no vi.mock needed
 * because the handler uses dependency injection, not module-level static imports.
 */

import { describe, it, expect, vi } from 'vitest'
import { createSdlcPhaseHandler } from '../sdlc-phase-handler.js'
import type {
  SdlcPhaseHandlerDeps,
  PhaseOrchestrator,
  PhaseRunners,
  EntryGateResult,
} from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal graph node for testing. */
function makeNode(id: string): { id: string; label: string; prompt: string } {
  return { id, label: `${id} label`, prompt: `${id} prompt` }
}

/** Build a minimal context stub that returns the provided key→value map. */
function makeContext(values: Record<string, string> = {}): {
  getString(key: string, defaultValue?: string): string
} {
  return {
    getString(key: string, defaultValue = ''): string {
      return key in values ? (values[key] as string) : defaultValue
    },
  }
}

/** Stub graph — not used by the handler. */
const stubGraph = {}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_RUN_ID = 'run-abc-123'
const DEFAULT_CONCEPT = 'build a todo app'

/** Default context keys available in most tests. */
const defaultContextValues: Record<string, string> = {
  runId: DEFAULT_RUN_ID,
  concept: DEFAULT_CONCEPT,
}

/**
 * Create a default set of vi.fn() phase runners.
 * Each runner resolves with a minimal success payload.
 */
function makePhaseRunners(): PhaseRunners {
  return {
    analysis: vi.fn().mockResolvedValue({ analysisResult: { result: 'success' } }),
    planning: vi.fn().mockResolvedValue({ planningResult: { result: 'success' } }),
    solutioning: vi.fn().mockResolvedValue({ solutioningResult: { result: 'success' } }),
  }
}

/** Create a default PhaseOrchestrator mock that reports success. */
function makeOrchestrator(
  overrides?: Partial<{ advanced: boolean; phase: string }>
): PhaseOrchestrator {
  const result = { advanced: true, phase: 'planning', ...overrides }
  return {
    advancePhase: vi.fn().mockResolvedValue(result),
    // Story 43-13: evaluateEntryGates defaults to passing
    evaluateEntryGates: vi.fn().mockResolvedValue({ passed: true } satisfies EntryGateResult),
  }
}

/** Build a default SdlcPhaseHandlerDeps for happy-path tests. */
function makeDeps(
  overrides: Partial<{
    orchestrator: PhaseOrchestrator
    phaseDeps: unknown
    advanceAfterRun: boolean
    phases: Partial<PhaseRunners>
  }> = {}
): SdlcPhaseHandlerDeps {
  const phases = { ...makePhaseRunners(), ...overrides.phases } as PhaseRunners
  const base: SdlcPhaseHandlerDeps = {
    orchestrator: overrides.orchestrator ?? makeOrchestrator(),
    phaseDeps: overrides.phaseDeps ?? {},
    phases,
  }
  // Only set advanceAfterRun when explicitly provided — exactOptionalPropertyTypes
  // disallows assigning `boolean | undefined` to the optional `boolean` field.
  if (overrides.advanceAfterRun !== undefined) {
    base.advanceAfterRun = overrides.advanceAfterRun
  }
  return base
}

// ---------------------------------------------------------------------------
// AC1: Analysis Phase Delegation
// ---------------------------------------------------------------------------

describe('AC1: analysis phase delegation', () => {
  it('calls phases.analysis with runId and concept, returns SUCCESS with contextUpdates', async () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(deps.phases.analysis).toHaveBeenCalledOnce()
    expect(deps.phases.analysis).toHaveBeenCalledWith(deps.phaseDeps, {
      runId: DEFAULT_RUN_ID,
      concept: DEFAULT_CONCEPT,
    })
    // Phase output is spread into contextUpdates
    expect(outcome.contextUpdates).toMatchObject({ analysisResult: { result: 'success' } })
  })
})

// ---------------------------------------------------------------------------
// AC2: Planning Phase Delegation
// ---------------------------------------------------------------------------

describe('AC2: planning phase delegation', () => {
  it('calls phases.planning with runId (no concept), returns SUCCESS with contextUpdates', async () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('planning')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(deps.phases.planning).toHaveBeenCalledOnce()
    expect(deps.phases.planning).toHaveBeenCalledWith(deps.phaseDeps, { runId: DEFAULT_RUN_ID })
    expect(outcome.contextUpdates).toMatchObject({ planningResult: { result: 'success' } })
  })
})

// ---------------------------------------------------------------------------
// AC3: Phase Dispatch Failure Returns FAILURE Outcome
// ---------------------------------------------------------------------------

describe('AC3: runner error returns FAILURE without re-throwing', () => {
  it('returns FAILURE with error message when runner throws', async () => {
    const failingPhases = makePhaseRunners()
    ;(failingPhases.solutioning as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('dispatch failed')
    )
    const deps = makeDeps({ phases: failingPhases })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('solutioning')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toBe('dispatch failed')
  })

  it('handles non-Error throws (string)', async () => {
    const failingPhases = makePhaseRunners()
    ;(failingPhases.analysis as ReturnType<typeof vi.fn>).mockRejectedValue('string error')
    const deps = makeDeps({ phases: failingPhases })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toBe('string error')
  })
})

// ---------------------------------------------------------------------------
// AC4: Gate Failure Returns FAILURE Outcome
// ---------------------------------------------------------------------------

describe('AC4: gate failure from advancePhase returns FAILURE with concatenated messages', () => {
  it('returns FAILURE with gate failure messages when advanced === false', async () => {
    const orchestrator: PhaseOrchestrator = {
      advancePhase: vi.fn().mockResolvedValue({
        advanced: false,
        phase: 'analysis',
        gateFailures: [{ gate: 'analysis-complete', error: 'no artifact' }],
      }),
      evaluateEntryGates: vi.fn().mockResolvedValue({ passed: true } satisfies EntryGateResult),
    }
    const deps = makeDeps({ orchestrator })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    // Story 43-13 AC3: exit gate failures are prefixed with 'exit gate failed: '
    expect(outcome.failureReason).toBe('exit gate failed: analysis-complete: no artifact')
  })

  it('concatenates multiple gate failures with semicolons', async () => {
    const orchestrator: PhaseOrchestrator = {
      advancePhase: vi.fn().mockResolvedValue({
        advanced: false,
        phase: 'planning',
        gateFailures: [
          { gate: 'gate-a', error: 'error-a' },
          { gate: 'gate-b', error: 'error-b' },
        ],
      }),
      evaluateEntryGates: vi.fn().mockResolvedValue({ passed: true } satisfies EntryGateResult),
    }
    const deps = makeDeps({ orchestrator })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('planning')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    // Story 43-13 AC3: exit gate failures are prefixed with 'exit gate failed: '
    expect(outcome.failureReason).toBe('exit gate failed: gate-a: error-a; gate-b: error-b')
  })

  it('handles missing gateFailures array with fallback message', async () => {
    const orchestrator: PhaseOrchestrator = {
      advancePhase: vi.fn().mockResolvedValue({
        advanced: false,
        phase: 'solutioning',
        // gateFailures omitted
      }),
      evaluateEntryGates: vi.fn().mockResolvedValue({ passed: true } satisfies EntryGateResult),
    }
    const deps = makeDeps({ orchestrator })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('solutioning')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    // Story 43-13 AC3: exit gate fallback uses the 'exit gate failed: ' prefix
    expect(outcome.failureReason).toBe('exit gate failed: no details')
  })
})

// ---------------------------------------------------------------------------
// AC5: Phase Name Resolved from Node ID
// ---------------------------------------------------------------------------

describe('AC5: phase selection driven by node.id', () => {
  it('dispatches solutioning runner (not analysis or planning) for node.id=solutioning', async () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('solutioning')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(deps.phases.solutioning).toHaveBeenCalledOnce()
    expect(deps.phases.analysis).not.toHaveBeenCalled()
    expect(deps.phases.planning).not.toHaveBeenCalled()
  })

  it('dispatches analysis runner for node.id=analysis (not solutioning or planning)', async () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext(defaultContextValues)

    await handler(node, context, stubGraph)

    expect(deps.phases.analysis).toHaveBeenCalledOnce()
    expect(deps.phases.solutioning).not.toHaveBeenCalled()
    expect(deps.phases.planning).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC6: Factory Function Pattern and Dependency Injection
// ---------------------------------------------------------------------------

describe('AC6: factory function and dependency injection', () => {
  it('createSdlcPhaseHandler returns a function (handler) accepting node, context, graph', () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)

    expect(typeof handler).toBe('function')
    expect(handler.length).toBe(3) // (node, context, graph)
  })

  it('handler uses injected orchestrator without accessing external singletons', async () => {
    const customOrchestrator = makeOrchestrator({ phase: 'solutioning' })
    const deps = makeDeps({ orchestrator: customOrchestrator })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(customOrchestrator.advancePhase).toHaveBeenCalledWith(DEFAULT_RUN_ID)
    expect(outcome.contextUpdates?.advancedPhase).toBe('solutioning')
  })

  it('passes phaseDeps through to runner without modification', async () => {
    const customPhaseDeps = { db: 'fake-db', pack: 'fake-pack' }
    const deps = makeDeps({ phaseDeps: customPhaseDeps })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('planning')
    const context = makeContext(defaultContextValues)

    await handler(node, context, stubGraph)

    expect(deps.phases.planning).toHaveBeenCalledWith(customPhaseDeps, expect.any(Object))
  })
})

// ---------------------------------------------------------------------------
// AC7: Unknown Phase Node Returns FAILURE Outcome
// ---------------------------------------------------------------------------

describe('AC7: unknown phase returns FAILURE without throwing', () => {
  it('returns FAILURE for node.id=unsupported-phase', async () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('unsupported-phase')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toBe('No phase runner registered for phase: unsupported-phase')
  })

  it('does not call any phase runner for unknown phase', async () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('non-existent')
    const context = makeContext(defaultContextValues)

    await handler(node, context, stubGraph)

    expect(deps.phases.analysis).not.toHaveBeenCalled()
    expect(deps.phases.planning).not.toHaveBeenCalled()
    expect(deps.phases.solutioning).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Supplementary: advanceAfterRun: false skips advancePhase
// ---------------------------------------------------------------------------

describe('advanceAfterRun: false skips orchestrator.advancePhase', () => {
  it('returns SUCCESS without calling advancePhase when advanceAfterRun is false', async () => {
    const orchestrator = makeOrchestrator()
    const deps = makeDeps({ orchestrator, advanceAfterRun: false })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(orchestrator.advancePhase).not.toHaveBeenCalled()
    // contextUpdates does NOT include advancedPhase
    expect(outcome.contextUpdates?.advancedPhase).toBeUndefined()
  })

  it('still runs the phase runner when advanceAfterRun is false', async () => {
    const deps = makeDeps({ advanceAfterRun: false })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('planning')
    const context = makeContext(defaultContextValues)

    await handler(node, context, stubGraph)

    expect(deps.phases.planning).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Supplementary: contextUpdates includes advancedPhase on success
// ---------------------------------------------------------------------------

describe('contextUpdates on success', () => {
  it('includes advancedPhase from advanceResult.phase in contextUpdates', async () => {
    const orchestrator = makeOrchestrator({ advanced: true, phase: 'solutioning' })
    const deps = makeDeps({ orchestrator })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('planning')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.contextUpdates?.advancedPhase).toBe('solutioning')
  })
})

// ---------------------------------------------------------------------------
// Supplementary: advancePhase itself throws
// ---------------------------------------------------------------------------

describe('advancePhase throwing returns FAILURE', () => {
  it('catches advancePhase errors and returns FAILURE', async () => {
    const orchestrator: PhaseOrchestrator = {
      advancePhase: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      evaluateEntryGates: vi.fn().mockResolvedValue({ passed: true } satisfies EntryGateResult),
    }
    const deps = makeDeps({ orchestrator })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toBe('DB connection lost')
  })
})

// ---------------------------------------------------------------------------
// Supplementary: concept not passed to non-analysis phases
// ---------------------------------------------------------------------------

describe('concept is only passed to analysis phase', () => {
  it('does NOT include concept in params for planning', async () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('planning')
    const context = makeContext({ runId: DEFAULT_RUN_ID, concept: DEFAULT_CONCEPT })

    await handler(node, context, stubGraph)

    const call = (deps.phases.planning as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call).toBeDefined()
    const params = call![1] as Record<string, unknown>
    expect(params).not.toHaveProperty('concept')
    expect(params).toHaveProperty('runId', DEFAULT_RUN_ID)
  })

  it('includes concept in params for analysis', async () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext({ runId: DEFAULT_RUN_ID, concept: DEFAULT_CONCEPT })

    await handler(node, context, stubGraph)

    const call = (deps.phases.analysis as ReturnType<typeof vi.fn>).mock.calls[0]
    const params = call![1] as Record<string, unknown>
    expect(params).toHaveProperty('concept', DEFAULT_CONCEPT)
    expect(params).toHaveProperty('runId', DEFAULT_RUN_ID)
  })
})

// ---------------------------------------------------------------------------
// Story 43-13 AC1: Entry gates evaluated before runner dispatch
// ---------------------------------------------------------------------------

describe('Story 43-13 AC1: evaluateEntryGates called before runner', () => {
  it('calls evaluateEntryGates before invoking the phase runner', async () => {
    const callOrder: string[] = []
    const orchestrator: PhaseOrchestrator = {
      advancePhase: vi.fn().mockResolvedValue({ advanced: true, phase: 'planning' }),
      evaluateEntryGates: vi.fn().mockImplementation(async () => {
        callOrder.push('entryGate')
        return { passed: true } satisfies EntryGateResult
      }),
    }
    const phases = makePhaseRunners()
    ;(phases.analysis as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('runner')
      return { analysisResult: { result: 'success' } }
    })
    const deps = makeDeps({ orchestrator, phases })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(callOrder[0]).toBe('entryGate')
    expect(callOrder[1]).toBe('runner')
    expect(callOrder).toHaveLength(2)
  })

  it('calls evaluateEntryGates with the runId from context', async () => {
    const orchestrator = makeOrchestrator()
    const deps = makeDeps({ orchestrator })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext(defaultContextValues)

    await handler(node, context, stubGraph)

    expect(orchestrator.evaluateEntryGates).toHaveBeenCalledWith(DEFAULT_RUN_ID)
  })

  it('evaluateEntryGates is called even when advanceAfterRun is false', async () => {
    const orchestrator = makeOrchestrator()
    const deps = makeDeps({ orchestrator, advanceAfterRun: false })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('planning')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(orchestrator.evaluateEntryGates).toHaveBeenCalledWith(DEFAULT_RUN_ID)
  })
})

// ---------------------------------------------------------------------------
// Story 43-13 AC2: Entry gate failure returns FAILURE with prefix
// ---------------------------------------------------------------------------

describe('Story 43-13 AC2: entry gate failure returns FAILURE with entry gate prefix', () => {
  it('returns FAILURE with prefixed failureReason when entry gate fails, runner NOT called', async () => {
    const orchestrator: PhaseOrchestrator = {
      advancePhase: vi.fn().mockResolvedValue({ advanced: true, phase: 'planning' }),
      evaluateEntryGates: vi.fn().mockResolvedValue({
        passed: false,
        failures: [{ gate: 'artifact-present', error: 'no concept artifact' }],
      } satisfies EntryGateResult),
    }
    const phases = makePhaseRunners()
    const deps = makeDeps({ orchestrator, phases })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toBe('entry gate failed: artifact-present: no concept artifact')
    // Runner must NOT be called when entry gate fails
    expect(phases.analysis).not.toHaveBeenCalled()
    // advancePhase must NOT be called when entry gate fails
    expect(orchestrator.advancePhase).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Story 43-13 AC4: Multiple entry gate failures concatenated with prefix
// ---------------------------------------------------------------------------

describe('Story 43-13 AC4: multiple entry gate failures concatenated', () => {
  it('joins multiple failures with "; " and single prefix', async () => {
    const orchestrator: PhaseOrchestrator = {
      advancePhase: vi.fn().mockResolvedValue({ advanced: true, phase: 'planning' }),
      evaluateEntryGates: vi.fn().mockResolvedValue({
        passed: false,
        failures: [
          { gate: 'g1', error: 'e1' },
          { gate: 'g2', error: 'e2' },
        ],
      } satisfies EntryGateResult),
    }
    const deps = makeDeps({ orchestrator })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('planning')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toBe('entry gate failed: g1: e1; g2: e2')
  })

  it('uses fallback "no details" when failures array is undefined', async () => {
    const orchestrator: PhaseOrchestrator = {
      advancePhase: vi.fn().mockResolvedValue({ advanced: true, phase: 'planning' }),
      evaluateEntryGates: vi.fn().mockResolvedValue({
        passed: false,
        // failures omitted
      } satisfies EntryGateResult),
    }
    const deps = makeDeps({ orchestrator })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('planning')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toBe('entry gate failed: no details')
  })
})

// ---------------------------------------------------------------------------
// Story 43-13: evaluateEntryGates throwing is caught by outer try/catch
// ---------------------------------------------------------------------------

describe('Story 43-13: evaluateEntryGates throw is caught and returned as FAILURE', () => {
  it('returns FAILURE with raw error message when evaluateEntryGates throws', async () => {
    const orchestrator: PhaseOrchestrator = {
      advancePhase: vi.fn().mockResolvedValue({ advanced: true, phase: 'planning' }),
      evaluateEntryGates: vi.fn().mockRejectedValue(new Error('gate registry unavailable')),
    }
    const deps = makeDeps({ orchestrator })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    // Raw error message — no prefix (caught by outer try/catch)
    expect(outcome.failureReason).toBe('gate registry unavailable')
  })
})

// ---------------------------------------------------------------------------
// Story 43-13 AC3: Exit gate failure prefix guard tests
// ---------------------------------------------------------------------------

describe('Story 43-13 AC3: exit gate and runner error prefix guard', () => {
  it('exit gate failure starts with "exit gate failed: " prefix', async () => {
    const orchestrator: PhaseOrchestrator = {
      advancePhase: vi.fn().mockResolvedValue({
        advanced: false,
        phase: 'planning',
        gateFailures: [{ gate: 'prd-complete', error: 'missing sections' }],
      }),
      evaluateEntryGates: vi.fn().mockResolvedValue({ passed: true } satisfies EntryGateResult),
    }
    const deps = makeDeps({ orchestrator })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toBe('exit gate failed: prd-complete: missing sections')
    expect(outcome.failureReason).not.toContain('entry gate failed')
  })

  it('runner dispatch error has NO prefix (raw message preserved)', async () => {
    const failingPhases = makePhaseRunners()
    ;(failingPhases.analysis as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('runner dispatch failed')
    )
    const deps = makeDeps({ phases: failingPhases })
    const handler = createSdlcPhaseHandler(deps)
    const node = makeNode('analysis')
    const context = makeContext(defaultContextValues)

    const outcome = await handler(node, context, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    // Raw error — no 'entry gate failed: ' or 'exit gate failed: ' prefix
    expect(outcome.failureReason).toBe('runner dispatch failed')
    expect(outcome.failureReason).not.toContain('entry gate failed')
    expect(outcome.failureReason).not.toContain('exit gate failed')
  })
})

// ---------------------------------------------------------------------------
// Phase-skip: already-completed phases return SUCCESS without dispatch
// ---------------------------------------------------------------------------

describe('Phase-skip: skip dispatch when phase artifact already exists', () => {
  it('skips analysis dispatch when product-brief artifact exists', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue([{ id: 'artifact-123' }]),
    }
    const deps = makeDeps({ phaseDeps: { db: mockDb } })
    const handler = createSdlcPhaseHandler(deps)
    const context = makeContext(defaultContextValues)

    const outcome = await handler(makeNode('analysis'), context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.notes).toContain('already complete')
    expect(deps.phases.analysis).not.toHaveBeenCalled()
  })

  it('skips planning dispatch when prd artifact exists', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue([{ id: 'artifact-456' }]),
    }
    const deps = makeDeps({ phaseDeps: { db: mockDb } })
    const handler = createSdlcPhaseHandler(deps)
    const context = makeContext(defaultContextValues)

    const outcome = await handler(makeNode('planning'), context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.notes).toContain('already complete')
    expect(deps.phases.planning).not.toHaveBeenCalled()
  })

  it('dispatches analysis normally when no artifact exists', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue([]),
    }
    const deps = makeDeps({ phaseDeps: { db: mockDb } })
    const handler = createSdlcPhaseHandler(deps)
    const context = makeContext(defaultContextValues)

    const outcome = await handler(makeNode('analysis'), context, stubGraph)

    expect(deps.phases.analysis).toHaveBeenCalled()
  })

  it('proceeds normally when phaseDeps has no db (backward compat)', async () => {
    const deps = makeDeps({ phaseDeps: {} })
    const handler = createSdlcPhaseHandler(deps)
    const context = makeContext(defaultContextValues)

    const outcome = await handler(makeNode('analysis'), context, stubGraph)

    expect(deps.phases.analysis).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Story-key skip: explicit story dispatch skips pre-implementation phases
// ---------------------------------------------------------------------------

describe('Story-key skip: explicit story dispatch skips pre-implementation phases', () => {
  it('skips analysis when storyKey is present in context', async () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)
    const context = makeContext({ ...defaultContextValues, storyKey: '48-1' })

    const outcome = await handler(makeNode('analysis'), context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.notes).toContain('skipped')
    expect(outcome.notes).toContain('explicit story dispatch')
    expect(deps.phases.analysis).not.toHaveBeenCalled()
  })

  it('skips planning when storyKey is present in context', async () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)
    const context = makeContext({ ...defaultContextValues, storyKey: '48-1' })

    const outcome = await handler(makeNode('planning'), context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.notes).toContain('skipped')
    expect(deps.phases.planning).not.toHaveBeenCalled()
  })

  it('skips solutioning when storyKey is present in context', async () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)
    const context = makeContext({ ...defaultContextValues, storyKey: '48-1' })

    const outcome = await handler(makeNode('solutioning'), context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.notes).toContain('skipped')
    expect(deps.phases.solutioning).not.toHaveBeenCalled()
  })

  it('does NOT skip when storyKey is empty', async () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)
    const context = makeContext({ ...defaultContextValues, storyKey: '' })

    await handler(makeNode('analysis'), context, stubGraph)

    expect(deps.phases.analysis).toHaveBeenCalled()
  })

  it('does NOT skip when storyKey is absent from context', async () => {
    const deps = makeDeps()
    const handler = createSdlcPhaseHandler(deps)
    const context = makeContext(defaultContextValues) // no storyKey

    await handler(makeNode('analysis'), context, stubGraph)

    expect(deps.phases.analysis).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Phase-skip artifact registration: registers artifacts for current pipeline run
// ---------------------------------------------------------------------------

describe('Phase-skip artifact registration for current pipeline run', () => {
  it('registers artifact for current run when pipelineRunId is in context', async () => {
    const mockDb = {
      query: vi
        .fn()
        // First call: check if artifact exists globally → yes
        .mockResolvedValueOnce([
          { id: 'a1', path: '/brief.md', content_hash: 'abc', summary: 'brief' },
        ])
        // Second call: check if already registered for current run → no
        .mockResolvedValueOnce([
          { id: 'a1', path: '/brief.md', content_hash: 'abc', summary: 'brief' },
        ])
        // Third call: check alreadyRegistered → empty
        .mockResolvedValueOnce([])
        // Fourth call: INSERT
        .mockResolvedValueOnce([]),
    }
    const deps = makeDeps({ phaseDeps: { db: mockDb } })
    const handler = createSdlcPhaseHandler(deps)
    const context = makeContext({ ...defaultContextValues, pipelineRunId: 'run-xyz' })

    const outcome = await handler(makeNode('analysis'), context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.notes).toContain('already complete')
    // Should have called INSERT with pipelineRunId
    const insertCall = mockDb.query.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT')
    )
    expect(insertCall).toBeDefined()
    expect(insertCall![1]).toContain('run-xyz')
  })

  it('does NOT attempt INSERT when pipelineRunId is absent', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValueOnce([{ id: 'a1' }]), // artifact exists globally
    }
    const deps = makeDeps({ phaseDeps: { db: mockDb } })
    const handler = createSdlcPhaseHandler(deps)
    const context = makeContext(defaultContextValues) // no pipelineRunId

    const outcome = await handler(makeNode('analysis'), context, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    const insertCall = mockDb.query.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT')
    )
    expect(insertCall).toBeUndefined()
  })
})
