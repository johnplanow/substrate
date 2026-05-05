/**
 * Invariant tests for phase-advancement persistence in the implementation
 * orchestrator — Story 66-1 (obs_2026-05-03_022 fix #1).
 *
 * Asserts that every phase transition in the happy-path sequence emits a
 * runManifest.patchStoryState({ phase }) call so that pipeline state is
 * durable across restarts and `substrate resume` re-enters from the correct
 * phase rather than re-dispatching work already completed.
 *
 * Covers AC1 (every phase transition emits patchStoryState({phase})),
 * AC2 (write failures are non-fatal), AC3 (invariant test file),
 * AC4 (mock _writeChain records calls; call count + ordering asserted).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'
import type { RunManifest } from '@substrate-ai/sdlc'
import { createDefaultVerificationPipeline } from '@substrate-ai/sdlc'

vi.mock('../../compiled-workflows/create-story.js', () => ({
  runCreateStory: vi.fn(),
  isValidStoryFile: vi.fn().mockResolvedValue({ valid: false, reason: 'not-found' }),
  extractStorySection: vi.fn().mockReturnValue(null),
}))
vi.mock('../../compiled-workflows/dev-story.js', () => ({
  runDevStory: vi.fn(),
}))
vi.mock('../../compiled-workflows/code-review.js', () => ({
  runCodeReview: vi.fn(),
}))
vi.mock('../../compiled-workflows/test-plan.js', () => ({
  runTestPlan: vi.fn(),
}))
vi.mock('../../../persistence/queries/decisions.js', () => ({
  updatePipelineRun: vi.fn(),
  addTokenUsage: vi.fn().mockResolvedValue(undefined),
  getDecisionsByPhase: vi.fn().mockReturnValue([]),
  getDecisionsByCategory: vi.fn().mockReturnValue([]),
  registerArtifact: vi.fn(),
  createDecision: vi.fn(),
}))
vi.mock('../../../persistence/queries/metrics.js', () => ({
  writeRunMetrics: vi.fn(),
  writeStoryMetrics: vi.fn(),
  aggregateTokenUsageForRun: vi.fn().mockReturnValue({ input: 0, output: 0, cost: 0 }),
  aggregateTokenUsageForStory: vi.fn().mockReturnValue({ input: 0, output: 0, cost: 0 }),
}))
vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('mock readFile: file not found')),
}))
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readdirSync: vi.fn().mockReturnValue([]),
  readFileSync: vi.fn().mockReturnValue(''),
  renameSync: vi.fn(),
  statSync: vi.fn(),
}))
vi.mock('../../../cli/commands/health.js', () => ({
  inspectProcessTree: vi.fn().mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))
vi.mock('../../agent-dispatch/dispatcher-impl.js', () => ({
  runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
  checkGitDiffFiles: vi.fn().mockReturnValue(['src/some-modified-file.ts']),
}))
vi.mock('../../agent-dispatch/interface-change-detector.js', () => ({
  detectInterfaceChanges: vi.fn().mockReturnValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] }),
}))
vi.mock('@substrate-ai/sdlc', () => ({
  createDefaultVerificationPipeline: vi.fn(() => ({
    run: vi.fn().mockResolvedValue({ storyKey: '5-1', checks: [], status: 'pass', duration_ms: 0 }),
    register: vi.fn(),
  })),
}))

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { runTestPlan } from '../../compiled-workflows/test-plan.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)

function createMockDb(): DatabaseAdapter {
  return {} as DatabaseAdapter
}

function createMockPack(): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack',
      phases: [],
      prompts: {},
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(''),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function createMockContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn(),
    registerTemplate: vi.fn(),
    getTemplate: vi.fn(),
  } as unknown as ContextCompiler
}

function createMockDispatcher(): Dispatcher {
  const mockResult: DispatchResult<unknown> = {
    id: 'test-dispatch',
    status: 'completed',
    exitCode: 0,
    output: '',
    parsed: null,
    parseError: null,
    durationMs: 100,
    tokenEstimate: { input: 10, output: 5 },
  }
  const mockHandle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
    id: 'test-dispatch',
    status: 'completed',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: Promise.resolve(mockResult),
  }
  return {
    dispatch: vi.fn().mockReturnValue(mockHandle),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    getMemoryState: vi.fn().mockReturnValue({ isPressured: false, freeMB: 1024, thresholdMB: 256, pressureLevel: 0 }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockEventBus(): TypedEventBus {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}

function defaultConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    maxConcurrency: 1,
    maxReviewCycles: 2,
    pipelineRunId: 'test-run-id',
    gcPauseMs: 0,
    ...overrides,
  }
}

function createMockRunManifest(): { mock: RunManifest; patchSpy: ReturnType<typeof vi.fn> } {
  const patchSpy = vi.fn().mockResolvedValue(undefined)
  const mock = {
    patchStoryState: patchSpy,
    read: vi.fn().mockResolvedValue({
      run_id: 'test-run-id',
      status: 'running',
      started_at: new Date().toISOString(),
      per_story_state: {},
    }),
  } as unknown as RunManifest
  return { mock, patchSpy }
}

function phaseFromCall(updates: unknown): string | undefined {
  if (typeof updates === 'object' && updates !== null && 'phase' in updates) {
    return String((updates as Record<string, unknown>).phase)
  }
  return undefined
}

function makeCreateStorySuccess(storyKey = '5-1') {
  return {
    result: 'success' as const,
    story_file: `/path/to/${storyKey}.md`,
    story_key: storyKey,
    story_title: 'Test Story',
    tokenUsage: { input: 100, output: 50 },
  }
}

function makeDevStorySuccess() {
  return {
    result: 'success' as const,
    ac_met: ['AC1'],
    ac_failures: [],
    files_modified: ['src/foo.ts'],
    tests: 'pass' as const,
    tokenUsage: { input: 200, output: 100 },
  }
}

function makeCodeReviewShipIt() {
  return {
    verdict: 'SHIP_IT' as const,
    issues: 0,
    issue_list: [],
    tokenUsage: { input: 150, output: 50 },
  }
}

function makeTestPlanSuccess() {
  return {
    result: 'success' as const,
    test_files: [],
    test_categories: [],
    coverage_notes: '',
    tokenUsage: { input: 50, output: 20 },
  }
}

describe('Phase-advancement persistence invariant (Story 66-1, AC1-AC4)', () => {
  let db: DatabaseAdapter
  let pack: MethodologyPack
  let contextCompiler: ContextCompiler
  let dispatcher: Dispatcher
  let eventBus: TypedEventBus
  let config: OrchestratorConfig

  beforeEach(() => {
    vi.clearAllMocks()
    db = createMockDb()
    pack = createMockPack()
    contextCompiler = createMockContextCompiler()
    dispatcher = createMockDispatcher()
    eventBus = createMockEventBus()
    config = defaultConfig()

    mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
  })

  it('AC1+AC4: emits patchStoryState({phase}) for every phase in the happy-path sequence, in order', async () => {
    const { mock: runManifest, patchSpy } = createMockRunManifest()

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    const status = await orchestrator.run(['5-1'])
    expect(status.stories['5-1']?.phase).toBe('COMPLETE')

    const phaseCalls = patchSpy.mock.calls.filter(
      ([, updates]: [unknown, unknown]) => phaseFromCall(updates) !== undefined,
    )
    const phases = phaseCalls.map(([, updates]: [unknown, unknown]) => phaseFromCall(updates))

    expect(phases).toEqual([
      'IN_STORY_CREATION',
      'IN_TEST_PLANNING',
      'IN_DEV',
      'IN_REVIEW',
      'COMPLETE',
    ])
    expect(phases).toHaveLength(5)
  })

  it('AC1+AC4: emits patchStoryState({phase: ESCALATED}) when story is escalated', async () => {
    mockRunCreateStory.mockResolvedValue({
      result: 'failed' as const,
      error: 'create-story-failed',
      tokenUsage: { input: 100, output: 0 },
    })

    const { mock: runManifest, patchSpy } = createMockRunManifest()

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    await orchestrator.run(['5-1'])

    const phaseCalls = patchSpy.mock.calls.filter(
      ([, updates]: [unknown, unknown]) => phaseFromCall(updates) !== undefined,
    )
    const phases = phaseCalls.map(([, updates]: [unknown, unknown]) => phaseFromCall(updates))

    expect(phases).toContain('ESCALATED')
    expect(phases[0]).toBe('IN_STORY_CREATION')
    expect(phases[phases.length - 1]).toBe('ESCALATED')
  })

  it('AC1: emits patchStoryState({phase: VERIFICATION_FAILED}) when verification fails', async () => {
    const mockCreateVerif = vi.mocked(createDefaultVerificationPipeline)
    mockCreateVerif.mockReturnValueOnce({
      run: vi.fn().mockResolvedValue({ storyKey: '5-1', checks: [], status: 'fail', duration_ms: 0 }),
      register: vi.fn(),
    } as unknown as ReturnType<typeof createDefaultVerificationPipeline>)

    const { mock: runManifest, patchSpy } = createMockRunManifest()

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    await orchestrator.run(['5-1'])

    const phaseCalls = patchSpy.mock.calls.filter(
      ([, updates]: [unknown, unknown]) => phaseFromCall(updates) !== undefined,
    )
    const phases = phaseCalls.map(([, updates]: [unknown, unknown]) => phaseFromCall(updates))

    expect(phases).toContain('VERIFICATION_FAILED')
    expect(phases[phases.length - 1]).toBe('VERIFICATION_FAILED')
  })

  it('AC2: orchestrator does not throw when patchStoryState rejects for intermediate phase writes', async () => {
    const patchSpy = vi.fn().mockRejectedValue(new Error('disk full'))
    const runManifest = {
      patchStoryState: patchSpy,
      read: vi.fn().mockResolvedValue({
        run_id: 'test-run-id',
        status: 'running',
        started_at: new Date().toISOString(),
        per_story_state: {},
      }),
    } as unknown as RunManifest

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    const status = await orchestrator.run(['5-1'])
    expect(status.state).toBe('COMPLETE')
    expect(status.stories['5-1']?.phase).toBe('COMPLETE')

    const phaseCalls = patchSpy.mock.calls.filter(
      ([, updates]: [unknown, unknown]) => phaseFromCall(updates) !== undefined,
    )
    expect(phaseCalls.length).toBeGreaterThan(0)
  })

  it('AC1: intermediate phase writes carry {phase} and correct storyKey', async () => {
    const { mock: runManifest, patchSpy } = createMockRunManifest()

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    await orchestrator.run(['5-1'])

    const intermediatePhases = ['IN_TEST_PLANNING', 'IN_DEV', 'IN_REVIEW']
    for (const expectedPhase of intermediatePhases) {
      const matchingCall = patchSpy.mock.calls.find(
        ([storyKey, updates]: [unknown, unknown]) =>
          storyKey === '5-1' && phaseFromCall(updates) === expectedPhase,
      )
      expect(matchingCall, `expected patchStoryState call with phase=${expectedPhase}`).toBeDefined()
    }
  })

  it('AC4: existing patchStoryState call sites (dispatched, complete status) are unchanged', async () => {
    const { mock: runManifest, patchSpy } = createMockRunManifest()

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    await orchestrator.run(['5-1'])

    const dispatchedCall = patchSpy.mock.calls.find(
      ([, updates]: [unknown, unknown]) => (updates as Record<string, unknown>).status === 'dispatched',
    )
    expect(dispatchedCall).toBeDefined()

    const completeCall = patchSpy.mock.calls.find(
      ([, updates]: [unknown, unknown]) => (updates as Record<string, unknown>).status === 'complete',
    )
    expect(completeCall).toBeDefined()
    const [, completeUpdates] = completeCall!
    const cu = completeUpdates as Record<string, unknown>
    expect(cu.completed_at).toBeDefined()
    expect(cu.review_cycles).toBeDefined()
    expect(cu.dispatches).toBeDefined()
  })
})
