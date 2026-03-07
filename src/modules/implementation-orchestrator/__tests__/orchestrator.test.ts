/**
 * Unit tests for createImplementationOrchestrator().
 *
 * Covers AC1-AC9: story lifecycle, retry, escalation, parallel execution,
 * conflict serialization, pause/resume, state persistence, and event emission.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'

// ---------------------------------------------------------------------------
// Mock compiled workflow functions
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
  addTokenUsage: vi.fn(),
  getDecisionsByPhase: vi.fn().mockReturnValue([]),
  registerArtifact: vi.fn(),
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
  readFile: vi.fn().mockRejectedValue(new Error('mock readFile: file not found')),
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

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock() calls
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { runTestPlan } from '../../compiled-workflows/test-plan.js'
import { updatePipelineRun } from '../../../persistence/queries/decisions.js'
import { createLogger } from '../../../utils/logger.js'
import { readFile } from 'node:fs/promises'
import { runBuildVerification, checkGitDiffFiles } from '../../agent-dispatch/dispatcher-impl.js'
import { detectInterfaceChanges } from '../../agent-dispatch/interface-change-detector.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)
const mockUpdatePipelineRun = vi.mocked(updatePipelineRun)
const mockCreateLogger = vi.mocked(createLogger)
const mockRunBuildVerification = vi.mocked(runBuildVerification)
const mockCheckGitDiffFiles = vi.mocked(checkGitDiffFiles)
const mockDetectInterfaceChanges = vi.mocked(detectInterfaceChanges)

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockDb(): BetterSqlite3Database {
  return {} as BetterSqlite3Database
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
    id: 'fix-dispatch',
    status: 'completed',
    exitCode: 0,
    output: '',
    parsed: null,
    parseError: null,
    durationMs: 100,
    tokenEstimate: { input: 10, output: 5 },
  }
  const mockHandle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
    id: 'fix-dispatch',
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
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

function defaultConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    maxConcurrency: 3,
    maxReviewCycles: 2,
    pipelineRunId: 'test-run-id',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Default workflow result factories
// ---------------------------------------------------------------------------

function makeCreateStorySuccess(storyKey = 'test-story') {
  return {
    result: 'success' as const,
    story_file: `/path/to/${storyKey}.md`,
    story_key: storyKey,
    story_title: 'Test Story',
    tokenUsage: { input: 100, output: 50 },
  }
}

function makeCreateStoryFailure(error = 'create failed') {
  return {
    result: 'failed' as const,
    error,
    tokenUsage: { input: 100, output: 0 },
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

function makeDevStoryFailure(error = 'dev failed') {
  return {
    result: 'failed' as const,
    ac_met: [],
    ac_failures: ['AC1'],
    files_modified: [],
    tests: 'fail' as const,
    error,
    tokenUsage: { input: 200, output: 0 },
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
    issues: 2,
    issue_list: [{ severity: 'minor' as const, description: 'Fix lint' }],
    tokenUsage: { input: 150, output: 50 },
  }
}

function makeCodeReviewMajorRework() {
  return {
    verdict: 'NEEDS_MAJOR_REWORK' as const,
    issues: 3,
    issue_list: [{ severity: 'blocker' as const, description: 'Broken architecture' }],
    tokenUsage: { input: 150, output: 80 },
  }
}

function makeTestPlanSuccess() {
  return {
    result: 'success' as const,
    test_files: ['src/modules/foo/__tests__/foo.test.ts'],
    test_categories: ['unit'],
    coverage_notes: 'AC1 covered by foo.test.ts',
    tokenUsage: { input: 50, output: 20 },
  }
}

function makeTestPlanFailure() {
  return {
    result: 'failed' as const,
    test_files: [],
    test_categories: [],
    coverage_notes: '',
    error: 'dispatch failed',
    tokenUsage: { input: 50, output: 0 },
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('createImplementationOrchestrator', () => {
  let db: BetterSqlite3Database
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
    // Default: test-plan succeeds (non-blocking — won't affect other tests)
    mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
  })

  // -------------------------------------------------------------------------
  // AC6: Initial state
  // -------------------------------------------------------------------------

  describe('getStatus()', () => {
    it('returns IDLE state before run() is called', () => {
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })
      const status = orchestrator.getStatus()
      expect(status.state).toBe('IDLE')
      expect(status.stories).toEqual({})
    })
  })

  // -------------------------------------------------------------------------
  // AC1: Happy path — single story SHIP_IT
  // -------------------------------------------------------------------------

  describe('AC1: Story lifecycle cycle', () => {
    it('processes a single story through create → dev → review(SHIP_IT) → COMPLETE', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      expect(status.state).toBe('COMPLETE')
      expect(status.stories['5-1']?.phase).toBe('COMPLETE')
      expect(mockRunCreateStory).toHaveBeenCalledOnce()
      expect(mockRunDevStory).toHaveBeenCalledOnce()
      expect(mockRunCodeReview).toHaveBeenCalledOnce()
    })

    it('transitions orchestrator state IDLE → RUNNING → COMPLETE', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('1-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      expect(orchestrator.getStatus().state).toBe('IDLE')
      const status = await orchestrator.run(['1-1'])
      expect(status.state).toBe('COMPLETE')
    })

    it('initialises story in PENDING phase before processing begins', async () => {
      let capturedStatus: ReturnType<typeof orchestrator.getStatus> | undefined

      // Capture status during create-story execution
      mockRunCreateStory.mockImplementation(async () => {
        capturedStatus = orchestrator.getStatus()
        return makeCreateStorySuccess('1-1')
      })
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['1-1'])

      // Story was set to IN_STORY_CREATION before create ran, but captured at start of mock
      expect(capturedStatus).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Minor fixes retry
  // -------------------------------------------------------------------------

  describe('AC2: Minor fixes retry cycle', () => {
    it('dispatches minor-fixes then re-reviews and marks COMPLETE on SHIP_IT', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMinorFixes())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      expect(status.state).toBe('COMPLETE')
      expect(status.stories['5-1']?.phase).toBe('COMPLETE')
      expect(mockRunCodeReview).toHaveBeenCalledTimes(2)
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ taskType: 'minor-fixes' }),
      )
    })

    it('tracks reviewCycles in story state', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMinorFixes())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      // After SHIP_IT on second review, reviewCycles was 1 when review ran
      expect(status.stories['5-1']?.reviewCycles).toBeGreaterThanOrEqual(0)
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Major rework
  // -------------------------------------------------------------------------

  describe('AC3: Major rework escalation', () => {
    it('dispatches major-rework prompt after NEEDS_MAJOR_REWORK verdict', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMajorRework())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      expect(status.stories['5-1']?.phase).toBe('COMPLETE')
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ taskType: 'major-rework' }),
      )
    })

    it('uses Opus model for major-rework fix dispatch', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMajorRework())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      // The fix dispatch (not the code-review dispatch) should include model escalation
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ taskType: 'major-rework', model: 'claude-opus-4-6' }),
      )
    })

    it('does not use Opus model for minor-fixes dispatch', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMinorFixes())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      // minor-fixes dispatch should NOT have model override
      const dispatchCalls = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls
      const fixCall = dispatchCalls.find((call: unknown[]) =>
        (call[0] as { taskType: string }).taskType === 'minor-fixes'
      )
      expect(fixCall).toBeDefined()
      expect((fixCall![0] as { model?: string }).model).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Scoped re-reviews
  // -------------------------------------------------------------------------

  describe('Scoped re-reviews', () => {
    it('passes previous issues to second code review call', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMinorFixes())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      // First review should have no previousIssues
      const firstReviewCall = mockRunCodeReview.mock.calls[0]
      expect(firstReviewCall[1].previousIssues).toBeUndefined()

      // Second review should have previousIssues from first review
      const secondReviewCall = mockRunCodeReview.mock.calls[1]
      expect(secondReviewCall[1].previousIssues).toBeDefined()
      expect(secondReviewCall[1].previousIssues!.length).toBeGreaterThan(0)
      expect(secondReviewCall[1].previousIssues![0].description).toBe('Fix lint')
    })
  })

  // -------------------------------------------------------------------------
  // AC4: User escalation after max retries
  // -------------------------------------------------------------------------

  describe('AC4: Escalation after max retries', () => {
    it('auto-approves story with only minor fixes at review cycle limit', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      // Always return NEEDS_MINOR_FIXES — converged on nits
      mockRunCodeReview.mockResolvedValue(makeCodeReviewMinorFixes())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxReviewCycles: 2 }),
      })

      const status = await orchestrator.run(['5-1'])

      // Auto-approved: minor fixes applied, then marked COMPLETE
      expect(status.stories['5-1']?.phase).toBe('COMPLETE')
      expect(status.state).toBe('COMPLETE')
    })

    it('emits orchestrator:story-complete (not escalated) for minor fixes at limit', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewMinorFixes())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxReviewCycles: 2 }),
      })

      await orchestrator.run(['5-1'])

      expect(eventBus.emit).toHaveBeenCalledWith(
        'orchestrator:story-complete',
        expect.objectContaining({
          storyKey: '5-1',
        }),
      )
    })

    it('escalates story with major rework at review cycle limit', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      // Always return NEEDS_MAJOR_REWORK — fundamental issues remain
      mockRunCodeReview.mockResolvedValue(makeCodeReviewMajorRework())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxReviewCycles: 2 }),
      })

      const status = await orchestrator.run(['5-1'])

      expect(status.stories['5-1']?.phase).toBe('ESCALATED')
      expect(eventBus.emit).toHaveBeenCalledWith(
        'orchestrator:story-escalated',
        expect.objectContaining({
          storyKey: '5-1',
          lastVerdict: 'NEEDS_MAJOR_REWORK',
        }),
      )
    })

    it('continues processing remaining stories after auto-approve', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess())
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        // 5-1: minor fixes (will be auto-approved)
        .mockResolvedValueOnce(makeCodeReviewMinorFixes())
        .mockResolvedValueOnce(makeCodeReviewMinorFixes())
        // 9-1: succeeds
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxReviewCycles: 2, maxConcurrency: 1 }),
      })

      const status = await orchestrator.run(['5-1', '9-1'])

      expect(status.state).toBe('COMPLETE')
    })
  })

  // -------------------------------------------------------------------------
  // Timeout retry: review timeout → retry once without incrementing cycle
  // -------------------------------------------------------------------------

  describe('Review timeout retry', () => {
    it('retries review once on timeout then proceeds with real verdict', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        // First call: timeout (phantom NEEDS_MAJOR_REWORK)
        .mockResolvedValueOnce({
          verdict: 'NEEDS_MAJOR_REWORK' as const,
          issues: 0,
          issue_list: [],
          error: 'Dispatch status: timeout. The agent did not complete within the allowed time.',
          tokenUsage: { input: 150, output: 0 },
        })
        // Retry: real verdict
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      expect(status.stories['5-1']?.phase).toBe('COMPLETE')
      // Review was called twice (timeout + retry), not three times
      expect(mockRunCodeReview).toHaveBeenCalledTimes(2)
    })

    it('does not retry timeout more than once', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      // Both calls timeout
      mockRunCodeReview.mockResolvedValue({
        verdict: 'NEEDS_MAJOR_REWORK' as const,
        issues: 0,
        issue_list: [],
        error: 'Dispatch status: timeout. The agent did not complete within the allowed time.',
        tokenUsage: { input: 150, output: 0 },
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxReviewCycles: 3 }),
      })

      const status = await orchestrator.run(['5-1'])

      // Should escalate — timeout retried once, then the second timeout
      // is treated as real, triggering fix cycles that also get timeouts
      expect(status.stories['5-1']?.phase).toBe('ESCALATED')
    })

    it('timeout retry does not count toward review cycle limit', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        // Cycle 0: timeout → retried
        .mockResolvedValueOnce({
          verdict: 'NEEDS_MAJOR_REWORK' as const,
          issues: 0,
          issue_list: [],
          error: 'Dispatch status: timeout. The agent did not complete within the allowed time.',
          tokenUsage: { input: 150, output: 0 },
        })
        // Retry of cycle 0: minor fixes (real verdict)
        .mockResolvedValueOnce(makeCodeReviewMinorFixes())
        // Cycle 1 (after fix): SHIP_IT
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxReviewCycles: 2 }),
      })

      const status = await orchestrator.run(['5-1'])

      // Should complete — the timeout retry didn't consume a review cycle
      expect(status.stories['5-1']?.phase).toBe('COMPLETE')
      // 3 review calls: timeout + retry + post-fix
      expect(mockRunCodeReview).toHaveBeenCalledTimes(3)
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Parallel story execution
  // -------------------------------------------------------------------------

  describe('AC5: Parallel story execution', () => {
    it('runs non-conflicting stories concurrently', async () => {
      // 10-4 and 10-5 are in different module groups → can run in parallel
      const callOrder: string[] = []

      mockRunCreateStory.mockImplementation(async (_deps, params) => {
        callOrder.push(`create:${params.storyKey}`)
        return makeCreateStorySuccess(params.storyKey)
      })
      mockRunDevStory.mockImplementation(async (_deps, params) => {
        callOrder.push(`dev:${params.storyKey}`)
        return makeDevStorySuccess()
      })
      mockRunCodeReview.mockImplementation(async (_deps, params) => {
        callOrder.push(`review:${params.storyKey}`)
        return makeCodeReviewShipIt()
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxConcurrency: 3 }),
      })

      const status = await orchestrator.run(['10-4', '10-5'])

      expect(status.stories['10-4']?.phase).toBe('COMPLETE')
      expect(status.stories['10-5']?.phase).toBe('COMPLETE')
      // Both stories were processed
      expect(callOrder.filter((c) => c.includes('10-4'))).toHaveLength(3)
      expect(callOrder.filter((c) => c.includes('10-5'))).toHaveLength(3)
    })

    it('tracks maxConcurrentActual equal to the number of groups that ran concurrently', async () => {
      // 6-1, 7-1, 8-1 each map to distinct modules (task-graph, worker-pool, monitor)
      // so detectConflictGroups assigns each to its own group.  With maxConcurrency=3
      // all three groups are enqueued together, meaning maxConcurrentActual should be 3.
      mockRunCreateStory.mockImplementation(async (_deps, params) =>
        makeCreateStorySuccess(params.storyKey),
      )
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxConcurrency: 3 }),
      })

      const status = await orchestrator.run(['6-1', '7-1', '8-1'])

      expect(status.stories['6-1']?.phase).toBe('COMPLETE')
      expect(status.stories['7-1']?.phase).toBe('COMPLETE')
      expect(status.stories['8-1']?.phase).toBe('COMPLETE')
      expect(status.maxConcurrentActual).toBe(3)
    })

    it('serializes conflicting stories within the same group (AC4: pack-configured conflictGroups)', async () => {
      // 10-1 and 10-2 both map to compiled-workflows → serialized when
      // the pack has the substrate module map in conflictGroups.
      const callOrder: string[] = []

      mockRunCreateStory.mockImplementation(async (_deps, params) => {
        callOrder.push(`create:${params.storyKey}`)
        return makeCreateStorySuccess(params.storyKey)
      })
      mockRunDevStory.mockImplementation(async (_deps, params) => {
        callOrder.push(`dev:${params.storyKey}`)
        return makeDevStorySuccess()
      })
      mockRunCodeReview.mockImplementation(async (_deps, params) => {
        callOrder.push(`review:${params.storyKey}`)
        return makeCodeReviewShipIt()
      })

      // Pack with substrate-specific conflictGroups to ensure 10-1 and 10-2 serialize
      const packWithConflicts: MethodologyPack = {
        ...createMockPack(),
        manifest: {
          ...createMockPack().manifest,
          conflictGroups: {
            '10-1': 'compiled-workflows',
            '10-2': 'compiled-workflows',
            '10-3': 'compiled-workflows',
          },
        },
      }

      const orchestrator = createImplementationOrchestrator({
        db, pack: packWithConflicts, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxConcurrency: 3 }),
      })

      await orchestrator.run(['10-1', '10-2'])

      // 10-1 must fully complete before 10-2 starts (serialized)
      const create10_1_idx = callOrder.indexOf('create:10-1')
      const review10_1_idx = callOrder.indexOf('review:10-1')
      const create10_2_idx = callOrder.indexOf('create:10-2')
      expect(create10_1_idx).toBeLessThan(create10_2_idx)
      expect(review10_1_idx).toBeLessThan(create10_2_idx)
    })

    it('AC5: cross-project stories run in parallel when pack has no conflictGroups', async () => {
      // 6 independent stories, no conflictGroups in pack → all isolated → max parallelism
      const callOrder: string[] = []

      mockRunCreateStory.mockImplementation(async (_deps, params) => {
        callOrder.push(`create:${params.storyKey}`)
        return makeCreateStorySuccess(params.storyKey)
      })
      mockRunDevStory.mockImplementation(async (_deps, params) => {
        callOrder.push(`dev:${params.storyKey}`)
        return makeDevStorySuccess()
      })
      mockRunCodeReview.mockImplementation(async (_deps, params) => {
        callOrder.push(`review:${params.storyKey}`)
        return makeCodeReviewShipIt()
      })

      // No conflictGroups in pack → cross-project: every story is its own group
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxConcurrency: 3 }),
      })

      const status = await orchestrator.run(['4-1', '4-2', '4-3', '4-4', '4-5', '4-6'])

      // All stories complete
      for (const key of ['4-1', '4-2', '4-3', '4-4', '4-5', '4-6']) {
        expect(status.stories[key]?.phase).toBe('COMPLETE')
      }
      // maxConcurrentActual > 1 (stories ran in parallel)
      expect(status.maxConcurrentActual).toBeGreaterThan(1)
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Orchestrator state management
  // -------------------------------------------------------------------------

  describe('AC6: Orchestrator state management', () => {
    it('getStatus() returns correct structure with all required fields', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      expect(status).toMatchObject({
        state: 'COMPLETE',
        stories: expect.any(Object),
        startedAt: expect.any(String),
        completedAt: expect.any(String),
        totalDurationMs: expect.any(Number),
      })
    })

    it('each story state includes required fields', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])
      const storyState = status.stories['5-1']

      expect(storyState).toBeDefined()
      expect(storyState?.phase).toBe('COMPLETE')
      expect(typeof storyState?.reviewCycles).toBe('number')
      expect(storyState?.startedAt).toBeDefined()
      expect(storyState?.completedAt).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Pause and resume
  // -------------------------------------------------------------------------

  describe('AC7: Pause and resume', () => {
    it('transitions state to PAUSED when pause() is called', async () => {
      let orchestratorRef!: ReturnType<typeof createImplementationOrchestrator>

      let pausePoint!: () => void
      const pauseBarrier = new Promise<void>((res) => { pausePoint = res })

      mockRunCreateStory.mockImplementation(async () => {
        // Signal test to pause, then wait
        pausePoint()
        await new Promise((res) => setTimeout(res, 50))
        return makeCreateStorySuccess('5-1')
      })
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      orchestratorRef = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const runPromise = orchestratorRef.run(['5-1'])

      // Wait until orchestrator is inside create-story
      await pauseBarrier
      orchestratorRef.pause()
      expect(orchestratorRef.getStatus().state).toBe('PAUSED')

      // Resume so test can complete
      orchestratorRef.resume()
      await runPromise
    })

    it('resume() transitions state back to RUNNING and emits events', async () => {
      let orchestratorRef!: ReturnType<typeof createImplementationOrchestrator>

      let pausePoint!: () => void
      const pauseBarrier = new Promise<void>((res) => { pausePoint = res })

      mockRunCreateStory.mockImplementation(async () => {
        pausePoint()
        await new Promise((res) => setTimeout(res, 50))
        return makeCreateStorySuccess('5-1')
      })
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      orchestratorRef = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const runPromise = orchestratorRef.run(['5-1'])

      await pauseBarrier
      orchestratorRef.pause()
      orchestratorRef.resume()

      await runPromise

      expect(eventBus.emit).toHaveBeenCalledWith('orchestrator:paused', {})
      expect(eventBus.emit).toHaveBeenCalledWith('orchestrator:resumed', {})
    })
  })

  // -------------------------------------------------------------------------
  // AC8: State persistence
  // -------------------------------------------------------------------------

  describe('AC8: Pipeline state persistence', () => {
    it('calls updatePipelineRun after each phase completion', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      // Should be called multiple times (after each phase + final)
      expect(mockUpdatePipelineRun).toHaveBeenCalled()
      expect(mockUpdatePipelineRun).toHaveBeenCalledWith(
        db,
        'test-run-id',
        expect.objectContaining({ current_phase: 'implementation' }),
      )
    })

    it('stores serialized orchestrator state in token_usage_json field', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const calls = mockUpdatePipelineRun.mock.calls
      const lastCall = calls[calls.length - 1]
      expect(lastCall).toBeDefined()
      const updates = lastCall?.[2]
      expect(updates?.token_usage_json).toBeDefined()
      const parsed = JSON.parse(updates?.token_usage_json as string)
      expect(parsed).toMatchObject({ state: 'COMPLETE', stories: expect.any(Object) })
    })

    it('does not call updatePipelineRun when no pipelineRunId is configured', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ pipelineRunId: undefined }),
      })

      await orchestrator.run(['5-1'])

      expect(mockUpdatePipelineRun).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // AC9: Event bus integration
  // -------------------------------------------------------------------------

  describe('AC9: Event bus integration', () => {
    it('emits orchestrator:started when run() begins', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      expect(eventBus.emit).toHaveBeenCalledWith(
        'orchestrator:started',
        expect.objectContaining({ storyKeys: ['5-1'] }),
      )
    })

    it('emits orchestrator:story-phase-complete after each story phase', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const phaseCompleteEmits = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === 'orchestrator:story-phase-complete',
      )
      expect(phaseCompleteEmits.length).toBeGreaterThanOrEqual(3)
      const phases = phaseCompleteEmits.map((c: unknown[]) => (c[1] as { phase: string }).phase)
      expect(phases).toContain('IN_STORY_CREATION')
      expect(phases).toContain('IN_DEV')
      expect(phases).toContain('IN_REVIEW')
    })

    it('emits orchestrator:story-complete when story reaches COMPLETE', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      expect(eventBus.emit).toHaveBeenCalledWith(
        'orchestrator:story-complete',
        expect.objectContaining({ storyKey: '5-1' }),
      )
    })

    it('emits orchestrator:complete when all stories are done', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      expect(eventBus.emit).toHaveBeenCalledWith(
        'orchestrator:complete',
        expect.objectContaining({ totalStories: 1, completed: 1 }),
      )
    })

    it('emits events in correct order: started → phase-complete × N → story-complete → complete', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const emittedEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      )

      expect(emittedEvents[0]).toBe('orchestrator:started')
      expect(emittedEvents.at(-1)).toBe('orchestrator:complete')
      expect(emittedEvents).toContain('orchestrator:story-complete')
    })
  })

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('escalates story when create-story returns failed result', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStoryFailure('Epic not found'))

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      expect(status.stories['5-1']?.phase).toBe('ESCALATED')
      expect(status.stories['5-1']?.error).toBe('Epic not found')
      expect(mockRunDevStory).not.toHaveBeenCalled()
    })

    it('escalates story when create-story throws an exception', async () => {
      mockRunCreateStory.mockRejectedValue(new Error('Network error'))

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      expect(status.stories['5-1']?.phase).toBe('ESCALATED')
      expect(status.stories['5-1']?.error).toBe('Network error')
    })

    it('proceeds to code review when dev-story fails (agent may have produced code)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStoryFailure('Build failed'))
      mockRunCodeReview.mockResolvedValue({
        verdict: 'NEEDS_MAJOR_REWORK',
        issues: 1,
        issue_list: [{ severity: 'major', description: 'Incomplete implementation' }],
        tokenUsage: { input: 100, output: 50 },
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxReviewCycles: 1 }),
      })

      const status = await orchestrator.run(['5-1'])

      // Should proceed to review instead of immediately escalating
      expect(mockRunCodeReview).toHaveBeenCalled()
      // Will escalate after review cycles exhausted, not from dev failure
      expect(status.stories['5-1']?.phase).toBe('ESCALATED')
    })
  })

  // -------------------------------------------------------------------------
  // AC5 (story 22-7): Orchestrator calls runTestPlan() between create-story
  // and dev-story, and sets IN_TEST_PLANNING phase during test planning.
  // -------------------------------------------------------------------------

  describe('AC5: test-plan phase wiring', () => {
    it('calls runTestPlan() after create-story succeeds and before runDevStory()', async () => {
      const callOrder: string[] = []

      mockRunCreateStory.mockImplementation(async () => {
        callOrder.push('create-story')
        return makeCreateStorySuccess('5-1')
      })
      mockRunTestPlan.mockImplementation(async () => {
        callOrder.push('test-plan')
        return makeTestPlanSuccess()
      })
      mockRunDevStory.mockImplementation(async () => {
        callOrder.push('dev-story')
        return makeDevStorySuccess()
      })
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      expect(callOrder).toEqual(['create-story', 'test-plan', 'dev-story'])
    })

    it('sets story phase to IN_TEST_PLANNING during test planning', async () => {
      let capturedPhase: string | undefined

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunTestPlan.mockImplementation(async () => {
        // Capture phase while test-plan is running
        capturedPhase = orchestrator.getStatus().stories['5-1']?.phase
        return makeTestPlanSuccess()
      })
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      expect(capturedPhase).toBe('IN_TEST_PLANNING')
    })

    it('still calls runDevStory() when runTestPlan() returns a failure result (non-blocking)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunTestPlan.mockResolvedValue(makeTestPlanFailure())
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      expect(mockRunDevStory).toHaveBeenCalledOnce()
      expect(status.stories['5-1']?.phase).toBe('COMPLETE')
    })

    it('still calls runDevStory() when runTestPlan() throws an exception (non-blocking)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunTestPlan.mockRejectedValue(new Error('Dispatch timeout'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      expect(mockRunDevStory).toHaveBeenCalledOnce()
      expect(status.stories['5-1']?.phase).toBe('COMPLETE')
    })

    it('emits orchestrator:story-phase-complete with actual test-plan result', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const emittedArgs: Array<{ phase: string; result: { result: string } }> = []
      const mockEmit = vi.fn((_event: string, payload: unknown) => {
        const p = payload as { phase?: string; result?: { result: string } }
        if (p.phase === 'IN_TEST_PLANNING') {
          emittedArgs.push(p as { phase: string; result: { result: string } })
        }
      })
      const bus = { ...createMockEventBus(), emit: mockEmit }

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus: bus, config,
      })

      await orchestrator.run(['5-1'])

      expect(emittedArgs).toHaveLength(1)
      expect(emittedArgs[0]?.result.result).toBe('success')
    })

    it('emits orchestrator:story-phase-complete with failed result when test-plan fails', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunTestPlan.mockResolvedValue(makeTestPlanFailure())
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const emittedArgs: Array<{ phase: string; result: { result: string } }> = []
      const mockEmit = vi.fn((_event: string, payload: unknown) => {
        const p = payload as { phase?: string; result?: { result: string } }
        if (p.phase === 'IN_TEST_PLANNING') {
          emittedArgs.push(p as { phase: string; result: { result: string } })
        }
      })
      const bus = { ...createMockEventBus(), emit: mockEmit }

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus: bus, config,
      })

      await orchestrator.run(['5-1'])

      expect(emittedArgs).toHaveLength(1)
      expect(emittedArgs[0]?.result.result).toBe('failed')
    })

    it('logs info (not warn) when runTestPlan() returns success', async () => {
      const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      mockCreateLogger.mockReturnValue(mockLogger as ReturnType<typeof createLogger>)

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const infoMessages = mockLogger.info.mock.calls.map((c) => c[1])
      const warnMessages = mockLogger.warn.mock.calls.map((c) => c[1])
      expect(infoMessages).toContain('Test plan generated successfully')
      expect(warnMessages).not.toContain('Test planning returned failed result — proceeding to dev-story without test plan')
    })

    it('logs warn (not info) when runTestPlan() returns result=failed', async () => {
      const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      mockCreateLogger.mockReturnValue(mockLogger as ReturnType<typeof createLogger>)

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunTestPlan.mockResolvedValue(makeTestPlanFailure())
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const infoMessages = mockLogger.info.mock.calls.map((c) => c[1])
      const warnMessages = mockLogger.warn.mock.calls.map((c) => c[1])
      expect(warnMessages).toContain('Test planning returned failed result — proceeding to dev-story without test plan')
      expect(infoMessages).not.toContain('Test plan generated successfully')
    })
  })

  // -------------------------------------------------------------------------
  // Story 23-5: Major-Rework Re-Dev Routing
  // -------------------------------------------------------------------------

  describe('Story 23-5: Major-Rework Re-Dev Routing', () => {
    it('AC1: uses rework-story template for NEEDS_MAJOR_REWORK verdict', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMajorRework())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      // Verify pack.getPrompt was called with 'rework-story' (not 'fix-story')
      const getPromptCalls = (pack.getPrompt as ReturnType<typeof vi.fn>).mock.calls
      const promptNames = getPromptCalls.map((call: unknown[]) => call[0])
      expect(promptNames).toContain('rework-story')
    })

    it('AC4: uses fix-story template for NEEDS_MINOR_FIXES verdict', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMinorFixes())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      // Verify pack.getPrompt was called with 'fix-story' for minor fixes
      const getPromptCalls = (pack.getPrompt as ReturnType<typeof vi.fn>).mock.calls
      const promptNames = getPromptCalls.map((call: unknown[]) => call[0])
      expect(promptNames).toContain('fix-story')
      // rework-story should NOT be used for minor fixes
      expect(promptNames).not.toContain('rework-story')
    })

    it('AC2: rework prompt includes review findings with severity and file locations', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce({
          verdict: 'NEEDS_MAJOR_REWORK' as const,
          issues: 2,
          issue_list: [
            { severity: 'blocker' as const, description: 'Wrong story implemented', file: 'src/foo.ts', line: 42 },
            { severity: 'major' as const, description: 'Missing tests', file: 'src/bar.ts' },
          ],
          tokenUsage: { input: 150, output: 80 },
        })
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      // Mock readFile to return story content so prompt assembly succeeds
      const mockReadFile = vi.mocked(readFile)
      mockReadFile.mockResolvedValue('# Story 5-1\nTest story content' as never)

      // Mock getPrompt to return a template with the review_findings placeholder
      ;(pack.getPrompt as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
        if (name === 'rework-story') {
          return '{{story_content}}\n\n{{review_findings}}\n\n{{arch_constraints}}\n\n{{git_diff}}'
        }
        return ''
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      // The dispatch call should contain the review findings with severity
      const dispatchCalls = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls
      const reworkCall = dispatchCalls.find((call: unknown[]) =>
        (call[0] as { taskType: string }).taskType === 'major-rework'
      )
      expect(reworkCall).toBeDefined()
      const capturedPrompt = (reworkCall![0] as { prompt: string }).prompt
      expect(capturedPrompt).toContain('Issues from previous review that MUST be addressed')
      expect(capturedPrompt).toContain('[blocker]')
      expect(capturedPrompt).toContain('[major]')
      expect(capturedPrompt).toContain('Wrong story implemented')
      expect(capturedPrompt).toContain('src/foo.ts:42')
      expect(capturedPrompt).toContain('src/bar.ts')

      // Reset readFile mock to default
      mockReadFile.mockRejectedValue(new Error('mock readFile: file not found'))
    })

    it('AC3: uses Opus model (claude-opus-4-6) for major-rework dispatch', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMajorRework())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const dispatchCalls = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls
      const reworkCall = dispatchCalls.find((call: unknown[]) =>
        (call[0] as { taskType: string }).taskType === 'major-rework'
      )
      expect(reworkCall).toBeDefined()
      expect((reworkCall![0] as { model?: string }).model).toBe('claude-opus-4-6')
    })

    it('AC4: minor-fixes uses default model (no Opus)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMinorFixes())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const dispatchCalls = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls
      const fixCall = dispatchCalls.find((call: unknown[]) =>
        (call[0] as { taskType: string }).taskType === 'minor-fixes'
      )
      expect(fixCall).toBeDefined()
      expect((fixCall![0] as { model?: string }).model).toBeUndefined()
    })

    it('AC6: major-rework dispatch uses DevStoryResultSchema', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMajorRework())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const dispatchCalls = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls
      const reworkCall = dispatchCalls.find((call: unknown[]) =>
        (call[0] as { taskType: string }).taskType === 'major-rework'
      )
      expect(reworkCall).toBeDefined()
      // Verify outputSchema is passed for major-rework
      expect((reworkCall![0] as { outputSchema?: unknown }).outputSchema).toBeDefined()
    })

    it('AC6: minor-fixes dispatch does NOT use DevStoryResultSchema', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMinorFixes())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const dispatchCalls = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls
      const fixCall = dispatchCalls.find((call: unknown[]) =>
        (call[0] as { taskType: string }).taskType === 'minor-fixes'
      )
      expect(fixCall).toBeDefined()
      // Minor-fixes should NOT have outputSchema
      expect((fixCall![0] as { outputSchema?: unknown }).outputSchema).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Story 24-2: Build Verification Gate — failure/escalation paths
  // -------------------------------------------------------------------------

  describe('Story 24-2: Build verification gate failure paths', () => {
    it('escalates story when build verification returns failed status (AC3)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())

      // Pre-flight passes, then post-dev gate returns failure
      mockRunBuildVerification
        .mockReturnValueOnce({ status: 'passed', exitCode: 0 })
        .mockReturnValueOnce({
          status: 'failed',
          exitCode: 1,
          reason: 'build-verification-failed',
          output: 'error TS2305: Module has no exported member "MissingSchema"',
        })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      // Story should be escalated
      expect(status.stories['5-1']?.phase).toBe('ESCALATED')
      expect(status.stories['5-1']?.error).toBe('build-verification-failed')
      // Code-review should NOT have been called
      expect(mockRunCodeReview).not.toHaveBeenCalled()
    })

    it('emits story:build-verification-failed event on build failure (AC7)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())

      // Pre-flight passes, then post-dev gate returns failure
      mockRunBuildVerification
        .mockReturnValueOnce({ status: 'passed', exitCode: 0 })
        .mockReturnValueOnce({
          status: 'failed',
          exitCode: 1,
          reason: 'build-verification-failed',
          output: 'Cannot find module "missing-dep"',
        })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      expect(eventBus.emit).toHaveBeenCalledWith(
        'story:build-verification-failed',
        expect.objectContaining({
          storyKey: '5-1',
          exitCode: 1,
          output: expect.stringContaining('Cannot find module'),
        }),
      )
    })

    it('escalates story when build verification returns timeout status (AC8)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())

      // Pre-flight passes, then post-dev gate returns timeout
      mockRunBuildVerification
        .mockReturnValueOnce({ status: 'passed', exitCode: 0 })
        .mockReturnValueOnce({
          status: 'timeout',
          exitCode: -1,
          reason: 'build-verification-timeout',
          output: '',
        })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      expect(status.stories['5-1']?.phase).toBe('ESCALATED')
      expect(status.stories['5-1']?.error).toBe('build-verification-timeout')
      expect(mockRunCodeReview).not.toHaveBeenCalled()
    })

    it('emits story:build-verification-failed event on build timeout (AC7+AC8)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())

      // Pre-flight passes, then post-dev gate returns timeout
      mockRunBuildVerification
        .mockReturnValueOnce({ status: 'passed', exitCode: 0 })
        .mockReturnValueOnce({
          status: 'timeout',
          exitCode: -1,
          reason: 'build-verification-timeout',
          output: 'Process timed out',
        })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      expect(eventBus.emit).toHaveBeenCalledWith(
        'story:build-verification-failed',
        expect.objectContaining({
          storyKey: '5-1',
          exitCode: -1,
          output: 'Process timed out',
        }),
      )
    })

    it('truncates build output to 2000 chars in failure event (AC7)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())

      const longOutput = 'x'.repeat(3000)
      // Pre-flight passes, then post-dev gate returns failure with long output
      mockRunBuildVerification
        .mockReturnValueOnce({ status: 'passed', exitCode: 0 })
        .mockReturnValueOnce({
          status: 'failed',
          exitCode: 1,
          reason: 'build-verification-failed',
          output: longOutput,
        })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const failedCall = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => call[0] === 'story:build-verification-failed',
      )
      expect(failedCall).toBeDefined()
      const eventPayload = failedCall![1] as { output: string }
      expect(eventPayload.output.length).toBeLessThanOrEqual(2000)
    })

    it('emits story:build-verification-passed on successful build (AC2)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      // Default mock already returns { status: 'passed' }, but be explicit
      mockRunBuildVerification.mockReturnValueOnce({
        status: 'passed',
        exitCode: 0,
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      expect(eventBus.emit).toHaveBeenCalledWith(
        'story:build-verification-passed',
        expect.objectContaining({ storyKey: '5-1' }),
      )
      // Code review should proceed
      expect(mockRunCodeReview).toHaveBeenCalled()
    })

    it('does not emit escalation event when build is skipped (AC6)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      mockRunBuildVerification.mockReturnValueOnce({
        status: 'skipped',
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      expect(eventBus.emit).not.toHaveBeenCalledWith(
        'story:build-verification-failed',
        expect.anything(),
      )
      // Should proceed to code-review normally
      expect(mockRunCodeReview).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Story 24-3: Interface Change Detection Warning — orchestrator-level
  // -------------------------------------------------------------------------

  describe('Story 24-3: Interface change detection warning', () => {
    it('emits story:interface-change-warning when detectInterfaceChanges returns affected tests (AC3)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      // Make detectInterfaceChanges return cross-module affected test files
      mockDetectInterfaceChanges.mockReturnValueOnce({
        modifiedInterfaces: ['MyInterface'],
        potentiallyAffectedTests: ['src/other/__tests__/other.test.ts'],
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      expect(eventBus.emit).toHaveBeenCalledWith(
        'story:interface-change-warning',
        expect.objectContaining({
          storyKey: '5-1',
          modifiedInterfaces: ['MyInterface'],
          potentiallyAffectedTests: ['src/other/__tests__/other.test.ts'],
        }),
      )
      // Warning is non-blocking — code-review must still run
      expect(mockRunCodeReview).toHaveBeenCalled()
    })

    it('uses git diff files (ground truth) instead of agent self-reported files_modified', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      // Dev agent claims it modified src/foo.ts (from makeDevStorySuccess)
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      // Git diff reports different files than the agent claimed
      mockCheckGitDiffFiles.mockReturnValueOnce(['src/real-change.ts', 'src/other-change.ts'])

      mockDetectInterfaceChanges.mockReturnValueOnce({
        modifiedInterfaces: [],
        potentiallyAffectedTests: [],
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      // detectInterfaceChanges should receive git diff files, not agent's files_modified
      expect(mockDetectInterfaceChanges).toHaveBeenCalledWith(
        expect.objectContaining({
          filesModified: ['src/real-change.ts', 'src/other-change.ts'],
        }),
      )
    })

    it('falls back to agent files_modified when dev-story fails (no git diff run)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      // Dev agent fails but reports partial files
      mockRunDevStory.mockResolvedValue({
        ...makeDevStorySuccess(),
        result: 'failed' as const,
        files_modified: ['src/partial-work.ts'],
      })
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      mockDetectInterfaceChanges.mockReturnValueOnce({
        modifiedInterfaces: [],
        potentiallyAffectedTests: [],
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      // When dev fails, zero-diff gate doesn't run, so gitDiffFiles is undefined.
      // Falls back to agent's self-reported files_modified.
      expect(mockDetectInterfaceChanges).toHaveBeenCalledWith(
        expect.objectContaining({
          filesModified: ['src/partial-work.ts'],
        }),
      )
    })

    it('does not emit story:interface-change-warning when no affected tests found (AC4)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      // Default mock already returns empty results, but be explicit
      mockDetectInterfaceChanges.mockReturnValueOnce({
        modifiedInterfaces: [],
        potentiallyAffectedTests: [],
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      expect(eventBus.emit).not.toHaveBeenCalledWith(
        'story:interface-change-warning',
        expect.anything(),
      )
    })
  })

  // -------------------------------------------------------------------------
  // Fix-story prompt enrichment: targeted_files + maxTurns for minor fixes
  // -------------------------------------------------------------------------

  describe('Fix-story prompt enrichment', () => {
    it('includes targeted_files section with file paths and line numbers from issue_list', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce({
          verdict: 'NEEDS_MINOR_FIXES' as const,
          issues: 2,
          issue_list: [
            { severity: 'minor' as const, description: 'Missing type annotation', file: 'src/foo.ts', line: 42 },
            { severity: 'minor' as const, description: 'Unused import', file: 'src/bar.ts', line: 7 },
          ],
          tokenUsage: { input: 150, output: 50 },
        })
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const mockReadFile = vi.mocked(readFile)
      mockReadFile.mockResolvedValue('# Story 5-1\n- [ ] Task 1: Do something\n- [ ] Task 2: Do more' as never)

      ;(pack.getPrompt as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
        if (name === 'fix-story') {
          return '{{story_content}}\n\n{{review_feedback}}\n\n{{arch_constraints}}\n\n{{targeted_files}}'
        }
        return ''
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const dispatchCalls = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls
      const fixCall = dispatchCalls.find((call: unknown[]) =>
        (call[0] as { taskType: string }).taskType === 'minor-fixes'
      )
      expect(fixCall).toBeDefined()
      const capturedPrompt = (fixCall![0] as { prompt: string }).prompt
      expect(capturedPrompt).toContain('src/foo.ts')
      expect(capturedPrompt).toContain('src/bar.ts')
      expect(capturedPrompt).toContain('42')

      mockReadFile.mockRejectedValue(new Error('mock readFile: file not found'))
    })

    it('omits targeted_files section when issues have no file references', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce({
          verdict: 'NEEDS_MINOR_FIXES' as const,
          issues: 1,
          issue_list: [
            { severity: 'minor' as const, description: 'Generic issue without file' },
          ],
          tokenUsage: { input: 150, output: 50 },
        })
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const mockReadFile = vi.mocked(readFile)
      mockReadFile.mockResolvedValue('# Story 5-1\n- [ ] Task 1: Do something' as never)

      ;(pack.getPrompt as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
        if (name === 'fix-story') {
          return '{{story_content}}\n\n{{review_feedback}}\n\n{{arch_constraints}}\n\n{{targeted_files}}'
        }
        return ''
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      // targeted_files placeholder should be replaced with empty string (no file references)
      const dispatchCalls = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls
      const fixCall = dispatchCalls.find((call: unknown[]) =>
        (call[0] as { taskType: string }).taskType === 'minor-fixes'
      )
      expect(fixCall).toBeDefined()
      // The prompt should NOT contain file bullet points
      const capturedPrompt = (fixCall![0] as { prompt: string }).prompt
      expect(capturedPrompt).not.toMatch(/^- src\//m)

      mockReadFile.mockRejectedValue(new Error('mock readFile: file not found'))
    })

    it('passes maxTurns to minor-fix dispatch on the general fix path', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMinorFixes())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const mockReadFile = vi.mocked(readFile)
      mockReadFile.mockResolvedValue('# Story 5-1\n- [ ] Task 1: Do something' as never)

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const dispatchCalls = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls
      const fixCall = dispatchCalls.find((call: unknown[]) =>
        (call[0] as { taskType: string }).taskType === 'minor-fixes'
      )
      expect(fixCall).toBeDefined()
      // maxTurns should be set (resolveFixStoryMaxTurns(1) = 50 base for low complexity)
      expect((fixCall![0] as { maxTurns?: number }).maxTurns).toBe(50)

      mockReadFile.mockRejectedValue(new Error('mock readFile: file not found'))
    })

    it('passes maxTurns to minor-fix dispatch on the auto-approve path', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      // Always return minor fixes — triggers auto-approve at review cycle limit
      mockRunCodeReview.mockResolvedValue(makeCodeReviewMinorFixes())

      const mockReadFile = vi.mocked(readFile)
      mockReadFile.mockResolvedValue('# Story 5-1\n- [ ] Task 1: Do something' as never)

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxReviewCycles: 2 }),
      })

      await orchestrator.run(['5-1'])

      // Find the auto-approve fix dispatch (last minor-fixes dispatch)
      const dispatchCalls = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls
      const fixCalls = dispatchCalls.filter((call: unknown[]) =>
        (call[0] as { taskType: string }).taskType === 'minor-fixes'
      )
      expect(fixCalls.length).toBeGreaterThan(0)
      const lastFixCall = fixCalls[fixCalls.length - 1]
      expect((lastFixCall[0] as { maxTurns?: number }).maxTurns).toBe(50)

      mockReadFile.mockRejectedValue(new Error('mock readFile: file not found'))
    })

    it('does not change maxTurns behavior for major-rework dispatches', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        .mockResolvedValueOnce(makeCodeReviewMajorRework())
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const mockReadFile = vi.mocked(readFile)
      mockReadFile.mockResolvedValue('# Story 5-1\n- [ ] Task 1: Do something' as never)

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const dispatchCalls = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls
      const reworkCall = dispatchCalls.find((call: unknown[]) =>
        (call[0] as { taskType: string }).taskType === 'major-rework'
      )
      expect(reworkCall).toBeDefined()
      // Major rework should still have maxTurns set (from existing Story 24-6 behavior)
      expect((reworkCall![0] as { maxTurns?: number }).maxTurns).toBe(50)

      mockReadFile.mockRejectedValue(new Error('mock readFile: file not found'))
    })
  })
})
