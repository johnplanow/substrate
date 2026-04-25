/**
 * Unit tests for per-story state manifest wiring in the implementation
 * orchestrator — Story 52-4.
 *
 * Covers AC4 (dispatched transition recorded), AC5 (terminal transitions
 * recorded), and AC6 (non-fatal on failure / null manifest).
 *
 * The RunManifest is injected via OrchestratorDeps.runManifest; tests use
 * a plain mock object with vi.fn() instead of the full class to avoid real
 * file I/O in orchestrator unit tests.
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

// ---------------------------------------------------------------------------
// Module mocks (must appear before any imports that use them)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock() calls
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { runTestPlan } from '../../compiled-workflows/test-plan.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

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

/** Build a minimal mock RunManifest with a tracked patchStoryState spy. */
function createMockRunManifest(): { mock: RunManifest; patchSpy: ReturnType<typeof vi.fn> } {
  const patchSpy = vi.fn().mockResolvedValue(undefined)
  const mock = { patchStoryState: patchSpy } as unknown as RunManifest
  return { mock, patchSpy }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Orchestrator per-story-state manifest wiring (Story 52-4)', () => {
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

  // -------------------------------------------------------------------------
  // AC4: dispatched transition recorded on story start
  // -------------------------------------------------------------------------

  it('AC4: calls patchStoryState with status=dispatched and started_at when story starts processing', async () => {
    const { mock: runManifest, patchSpy } = createMockRunManifest()

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    await orchestrator.run(['5-1'])

    // Should have been called at least once with dispatched status
    const dispatchedCall = patchSpy.mock.calls.find(
      ([, updates]) => updates.status === 'dispatched',
    )
    expect(dispatchedCall).toBeDefined()
    const [storyKey, updates] = dispatchedCall!
    expect(storyKey).toBe('5-1')
    expect(updates.started_at).toBeDefined()
    expect(typeof updates.started_at).toBe('string')
  })

  // -------------------------------------------------------------------------
  // AC5: complete terminal transition recorded
  // -------------------------------------------------------------------------

  it('AC5: calls patchStoryState with status=complete and completed_at when story completes (SHIP_IT)', async () => {
    const { mock: runManifest, patchSpy } = createMockRunManifest()

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    await orchestrator.run(['5-1'])

    // Should have been called with complete status
    const completeCall = patchSpy.mock.calls.find(
      ([, updates]) => updates.status === 'complete',
    )
    expect(completeCall).toBeDefined()
    const [storyKey, updates] = completeCall!
    expect(storyKey).toBe('5-1')
    expect(updates.completed_at).toBeDefined()
    expect(typeof updates.completed_at).toBe('string')
  })

  // -------------------------------------------------------------------------
  // AC5: escalated terminal transition recorded
  // -------------------------------------------------------------------------

  it('AC5: calls patchStoryState with status=escalated and completed_at when story is escalated', async () => {
    const { mock: runManifest, patchSpy } = createMockRunManifest()

    // Make create-story fail so the story gets escalated
    mockRunCreateStory.mockResolvedValue({
      result: 'failed' as const,
      error: 'create-story failed',
      tokenUsage: { input: 100, output: 0 },
    })

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    await orchestrator.run(['5-1'])

    const escalatedCall = patchSpy.mock.calls.find(
      ([, updates]) => updates.status === 'escalated',
    )
    expect(escalatedCall).toBeDefined()
    const [storyKey, updates] = escalatedCall!
    expect(storyKey).toBe('5-1')
    expect(updates.completed_at).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // AC6: patchStoryState throwing does NOT crash the orchestrator
  // -------------------------------------------------------------------------

  it('AC6: orchestrator does not throw when patchStoryState throws', async () => {
    const patchSpy = vi.fn().mockRejectedValue(new Error('disk full'))
    const runManifest = { patchStoryState: patchSpy } as unknown as RunManifest

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    // Should complete without throwing even though patchStoryState always rejects
    const status = await orchestrator.run(['5-1'])
    expect(status.state).toBe('COMPLETE')
    expect(status.stories['5-1']?.phase).toBe('COMPLETE')
  })

  // -------------------------------------------------------------------------
  // AC4, AC6: null runManifest — orchestrator proceeds without error
  // -------------------------------------------------------------------------

  it('AC4, AC6: orchestrator proceeds normally when runManifest is null', async () => {
    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
      runManifest: null,
    })

    const status = await orchestrator.run(['5-1'])
    expect(status.state).toBe('COMPLETE')
    expect(status.stories['5-1']?.phase).toBe('COMPLETE')
  })

  it('AC4, AC6: orchestrator proceeds normally when runManifest is not provided (undefined)', async () => {
    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
      // runManifest not provided — defaults to null via destructuring
    })

    const status = await orchestrator.run(['5-1'])
    expect(status.state).toBe('COMPLETE')
    expect(status.stories['5-1']?.phase).toBe('COMPLETE')
  })

  // -------------------------------------------------------------------------
  // AC5: verification-failed terminal transition recorded
  // -------------------------------------------------------------------------

  it('AC5: calls patchStoryState with status=verification-failed and completed_at when verification pipeline fails', async () => {
    const { mock: runManifest, patchSpy } = createMockRunManifest()

    // Override the verification pipeline to return 'fail' for this test.
    // createDefaultVerificationPipeline is called inside createImplementationOrchestrator,
    // so the mock must be set up before the orchestrator is created.
    const mockCreateVerif = vi.mocked(createDefaultVerificationPipeline)
    mockCreateVerif.mockReturnValueOnce({
      run: vi.fn().mockResolvedValue({ storyKey: '5-1', checks: [], status: 'fail', duration_ms: 0 }),
      register: vi.fn(),
    } as unknown as ReturnType<typeof createDefaultVerificationPipeline>)

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    await orchestrator.run(['5-1'])

    const verificationFailedCall = patchSpy.mock.calls.find(
      ([, updates]) => (updates as Record<string, unknown>).status === 'verification-failed',
    )
    expect(verificationFailedCall).toBeDefined()
    const [storyKey, updates] = verificationFailedCall!
    expect(storyKey).toBe('5-1')
    expect((updates as Record<string, unknown>).completed_at).toBeDefined()
    expect(typeof (updates as Record<string, unknown>).completed_at).toBe('string')
  })
})
