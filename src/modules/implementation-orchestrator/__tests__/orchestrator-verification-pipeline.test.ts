/**
 * Orchestrator Verification Pipeline Integration Tests — Story 51-5 (AC7).
 *
 * Covers the four behavioral scenarios missing from verification-integration.test.ts:
 *   1. pipeline invoked on SHIP_IT
 *   2. VERIFICATION_FAILED set on fail result
 *   3. warn status does not block COMPLETE
 *   4. skip flag bypasses pipeline
 *
 * These tests exercise the full orchestrator run() path with a mocked
 * verificationPipeline.run() spy, verifying that processStory() hooks
 * the pipeline correctly in each branch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'

// ---------------------------------------------------------------------------
// Module mocks (must appear before any imports that use them)
// ---------------------------------------------------------------------------

vi.mock('../../compiled-workflows/create-story.js', () => ({
  runCreateStory: vi.fn(),
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
  readFile: vi.fn().mockResolvedValue('## Acceptance Criteria\n\n### AC1: Works'),
}))
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readdirSync: vi.fn().mockReturnValue([]),
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

/**
 * @substrate-ai/sdlc is mocked so that createDefaultVerificationPipeline returns a
 * controllable spy. The mock is initialized here with a default pass result;
 * individual tests override mockPipelineRun before calling orchestrator.run().
 */
vi.mock('@substrate-ai/sdlc', () => ({
  createDefaultVerificationPipeline: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock() calls
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { runTestPlan } from '../../compiled-workflows/test-plan.js'
import { createDefaultVerificationPipeline } from '@substrate-ai/sdlc'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)
const mockCreateDefaultPipeline = vi.mocked(createDefaultVerificationPipeline)

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

// ---------------------------------------------------------------------------
// Workflow result factories
// ---------------------------------------------------------------------------

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

function makeCodeReviewMinorFixes() {
  return {
    verdict: 'NEEDS_MINOR_FIXES' as const,
    issues: 1,
    issue_list: [
      { severity: 'minor' as const, description: 'polish naming', file: 'src/foo.ts' },
    ],
    tokenUsage: { input: 150, output: 50 },
  }
}

// ---------------------------------------------------------------------------
// Verification summary factories
// ---------------------------------------------------------------------------

function makeVerifSummary(storyKey: string, status: 'pass' | 'warn' | 'fail') {
  return { storyKey, checks: [], status, duration_ms: 5 }
}

// ---------------------------------------------------------------------------
// Tests: AC7 Behavioral Scenarios
// ---------------------------------------------------------------------------

describe('Orchestrator Verification Pipeline Integration (AC7)', () => {
  let db: DatabaseAdapter
  let pack: MethodologyPack
  let contextCompiler: ContextCompiler
  let dispatcher: Dispatcher
  let eventBus: TypedEventBus
  let config: OrchestratorConfig

  /** Spy on the verificationPipeline.run() method captured by the orchestrator. */
  let mockPipelineRun: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()

    db = createMockDb()
    pack = createMockPack()
    contextCompiler = createMockContextCompiler()
    dispatcher = createMockDispatcher()
    eventBus = createMockEventBus()
    config = defaultConfig()

    // Default: pipeline returns pass.
    // Tests that need fail/warn override mockPipelineRun before calling orchestrator.run().
    mockPipelineRun = vi.fn().mockResolvedValue(makeVerifSummary('5-1', 'pass'))
    mockCreateDefaultPipeline.mockReturnValue({
      run: mockPipelineRun,
      register: vi.fn(),
    })

    // Default workflow mocks
    mockRunTestPlan.mockResolvedValue({
      result: 'success' as const,
      test_files: [],
      test_categories: [],
      coverage_notes: '',
      tokenUsage: { input: 50, output: 20 },
    })
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
  })

  // -------------------------------------------------------------------------
  // AC1: Pipeline invoked on SHIP_IT
  // -------------------------------------------------------------------------

  it('invokes verificationPipeline.run() with correct storyKey after SHIP_IT verdict', async () => {
    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    const status = await orchestrator.run(['5-1'])

    expect(status.stories['5-1']?.phase).toBe('COMPLETE')
    // Pipeline must have been called exactly once for this story
    expect(mockPipelineRun).toHaveBeenCalledOnce()
    expect(mockPipelineRun).toHaveBeenCalledWith(
      expect.objectContaining({
        storyKey: '5-1',
        storyContent: expect.stringContaining('### AC1'),
        devStoryResult: expect.objectContaining({ ac_met: ['AC1'], tests: 'pass' }),
        outputTokenCount: 100,
      }),
      'A',
    )
  })

  // -------------------------------------------------------------------------
  // AC3: VERIFICATION_FAILED phase on fail result
  // -------------------------------------------------------------------------

  it('sets VERIFICATION_FAILED phase when pipeline returns fail status', async () => {
    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    // Override to return fail before running
    mockPipelineRun.mockResolvedValue(makeVerifSummary('5-1', 'fail'))

    const status = await orchestrator.run(['5-1'])

    expect(status.stories['5-1']?.phase).toBe('VERIFICATION_FAILED')
  })

  it('does not emit orchestrator:story-complete when pipeline returns fail', async () => {
    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    mockPipelineRun.mockResolvedValue(makeVerifSummary('5-1', 'fail'))

    await orchestrator.run(['5-1'])

    // story-complete must NOT be emitted for a VERIFICATION_FAILED story
    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
    const storyCompleteCalls = emitCalls.filter(
      (call: unknown[]) => call[0] === 'orchestrator:story-complete',
    )
    expect(storyCompleteCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // AC5: Warn status does not block COMPLETE
  // -------------------------------------------------------------------------

  it('proceeds to COMPLETE when pipeline returns warn status', async () => {
    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    mockPipelineRun.mockResolvedValue(makeVerifSummary('5-1', 'warn'))

    const status = await orchestrator.run(['5-1'])

    expect(status.stories['5-1']?.phase).toBe('COMPLETE')
    // Verify pipeline was still called (warn is non-blocking but runs)
    expect(mockPipelineRun).toHaveBeenCalledOnce()
  })

  it('runs verification before completing an auto-approved minor-fixes story', async () => {
    mockRunCodeReview.mockResolvedValue(makeCodeReviewMinorFixes())

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus,
      config: defaultConfig({ maxReviewCycles: 1 }),
    })

    const status = await orchestrator.run(['5-1'])

    expect(status.stories['5-1']?.phase).toBe('COMPLETE')
    expect(mockPipelineRun).toHaveBeenCalledOnce()
    expect(mockPipelineRun).toHaveBeenCalledWith(
      expect.objectContaining({
        storyKey: '5-1',
        devStoryResult: expect.objectContaining({ ac_met: ['AC1'] }),
      }),
      'A',
    )
  })

  it('blocks auto-approve completion when verification fails', async () => {
    mockRunCodeReview.mockResolvedValue(makeCodeReviewMinorFixes())
    mockPipelineRun.mockResolvedValue(makeVerifSummary('5-1', 'fail'))

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus,
      config: defaultConfig({ maxReviewCycles: 1 }),
    })

    const status = await orchestrator.run(['5-1'])

    expect(status.stories['5-1']?.phase).toBe('VERIFICATION_FAILED')
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      'orchestrator:story-complete',
      expect.objectContaining({ storyKey: '5-1' }),
    )
  })

  // -------------------------------------------------------------------------
  // AC6: Skip flag bypasses pipeline
  // -------------------------------------------------------------------------

  it('does not invoke pipeline when skipVerification is true', async () => {
    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus,
      config: defaultConfig({ skipVerification: true }),
    })

    const status = await orchestrator.run(['5-1'])

    expect(status.stories['5-1']?.phase).toBe('COMPLETE')
    // Pipeline must NOT have been called at all
    expect(mockPipelineRun).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC4: In-memory summary stored (bonus: verify pipeline is called per story)
  // -------------------------------------------------------------------------

  it('invokes pipeline for each story that reaches SHIP_IT', async () => {
    mockRunCreateStory.mockImplementation(async (_deps, params: { storyKey: string }) =>
      makeCreateStorySuccess(params.storyKey),
    )
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus,
      config: defaultConfig({ maxConcurrency: 1 }),
    })

    const status = await orchestrator.run(['5-1', '5-2'])

    expect(status.stories['5-1']?.phase).toBe('COMPLETE')
    expect(status.stories['5-2']?.phase).toBe('COMPLETE')
    // Pipeline must have run once per story
    expect(mockPipelineRun).toHaveBeenCalledTimes(2)
  })
})
