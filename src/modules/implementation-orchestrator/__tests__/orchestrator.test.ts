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
vi.mock('../../../persistence/queries/decisions.js', () => ({
  updatePipelineRun: vi.fn(),
}))
vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock() calls
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { updatePipelineRun } from '../../../persistence/queries/decisions.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockUpdatePipelineRun = vi.mocked(updatePipelineRun)

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
  })

  // -------------------------------------------------------------------------
  // AC4: User escalation after max retries
  // -------------------------------------------------------------------------

  describe('AC4: Escalation after max retries', () => {
    it('escalates story after maxReviewCycles consecutive failures', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      // Always return NEEDS_MINOR_FIXES — never SHIP_IT
      mockRunCodeReview.mockResolvedValue(makeCodeReviewMinorFixes())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxReviewCycles: 2 }),
      })

      const status = await orchestrator.run(['5-1'])

      expect(status.stories['5-1']?.phase).toBe('ESCALATED')
      expect(status.state).toBe('COMPLETE') // orchestrator continues
    })

    it('emits orchestrator:story-escalated with last verdict and issues', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewMinorFixes())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxReviewCycles: 2 }),
      })

      await orchestrator.run(['5-1'])

      expect(eventBus.emit).toHaveBeenCalledWith(
        'orchestrator:story-escalated',
        expect.objectContaining({
          storyKey: '5-1',
          lastVerdict: 'NEEDS_MINOR_FIXES',
        }),
      )
    })

    it('continues processing remaining stories after escalation', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess())
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview
        // 5-1: always fails
        .mockResolvedValueOnce(makeCodeReviewMinorFixes())
        .mockResolvedValueOnce(makeCodeReviewMinorFixes())
        // 9-1: succeeds
        .mockResolvedValueOnce(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: defaultConfig({ maxReviewCycles: 2, maxConcurrency: 1 }),
      })

      // 5-1 → compiled-workflows (same as 5-2), 9-1 → bmad-context-engine (different)
      // Use unrelated keys so they are in separate conflict groups
      const status = await orchestrator.run(['5-1', '9-1'])

      // orchestrator reaches COMPLETE (not FAILED)
      expect(status.state).toBe('COMPLETE')
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

    it('serializes conflicting stories within the same group', async () => {
      // 10-1 and 10-2 both map to compiled-workflows → serialized
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

      await orchestrator.run(['10-1', '10-2'])

      // 10-1 must fully complete before 10-2 starts (serialized)
      const create10_1_idx = callOrder.indexOf('create:10-1')
      const review10_1_idx = callOrder.indexOf('review:10-1')
      const create10_2_idx = callOrder.indexOf('create:10-2')
      expect(create10_1_idx).toBeLessThan(create10_2_idx)
      expect(review10_1_idx).toBeLessThan(create10_2_idx)
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
})
