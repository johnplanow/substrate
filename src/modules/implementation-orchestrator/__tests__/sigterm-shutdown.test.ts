/**
 * Unit and integration tests for SIGTERM/SIGINT graceful shutdown — Story 58-7.
 *
 * Covers:
 *   AC1: Signal handler installation and removal
 *   AC2: shutdownGracefully behavior (flag, drain, manifest, exit code)
 *   AC6: Unit tests for signal → shutdownGracefully, flag, exit codes, dispatch guard
 *   AC7: Integration test — process.emit('SIGTERM') triggers manifest write + exit(143)
 *
 * Design notes:
 *   - process.exit is mocked to record the exit code WITHOUT throwing, then unblocks any
 *     pending dispatch promise so that orchestrator.run() can complete and the signal
 *     handlers are properly removed in the finally block. This prevents test hangs and
 *     MaxListeners warnings from accumulated un-removed handlers.
 *   - Each test uses an independent orchestrator instance (fresh factory call).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'

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
  updatePipelineRun: vi.fn().mockResolvedValue(undefined),
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
    run: vi.fn().mockResolvedValue({ storyKey: '58-7', checks: [], status: 'pass', duration_ms: 0 }),
    register: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Import mocked modules
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { runTestPlan } from '../../compiled-workflows/test-plan.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'

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
    pipelineRunId: 'test-run-58-7',
    gcPauseMs: 0,
    skipPreflight: true,
    skipBuildVerify: true,
    shutdownGracePeriodMs: 150, // short grace period for tests
    ...overrides,
  }
}

function makeCreateStorySuccess(storyKey = '58-7') {
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

/** Build a mock RunManifest with controllable patchRunStatus */
function createMockRunManifest() {
  return {
    read: vi.fn().mockResolvedValue({
      run_id: 'test-run-58-7',
      cli_flags: {},
      story_scope: [],
      supervisor_pid: null,
      supervisor_session_id: null,
      per_story_state: {},
      recovery_history: [],
      cost_accumulation: { per_story: {}, run_total: 0 },
      pending_proposals: [],
      generation: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    patchStoryState: vi.fn().mockResolvedValue(undefined),
    patchRunStatus: vi.fn().mockResolvedValue(undefined),
    patchCLIFlags: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Create a deferred promise that can be resolved from outside.
 * Used to control when mock dispatches complete.
 */
function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SIGTERM/SIGINT graceful shutdown (Story 58-7)', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>
  // Captured exit codes from mocked process.exit calls
  let capturedExitCodes: number[]

  beforeEach(() => {
    vi.clearAllMocks()
    capturedExitCodes = []

    // Mock process.exit to record the exit code without actually exiting.
    // Returns `undefined as never` (valid at runtime despite the TypeScript type).
    // Individual tests may provide an onExit callback via setupBlockedDispatch.
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(
      (code?: number): never => {
        capturedExitCodes.push(code ?? -1)
        return undefined as never
      }
    )
  })

  afterEach(() => {
    processExitSpy.mockRestore()
  })

  // ---------------------------------------------------------------------------
  // AC1: Signal handler installation / removal
  // ---------------------------------------------------------------------------

  describe('AC1 — signal handler installation and removal', () => {
    it('installs SIGTERM and SIGINT handlers when run() starts and removes them on completion', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess())
      mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const before = {
        sigterm: process.listenerCount('SIGTERM'),
        sigint: process.listenerCount('SIGINT'),
      }

      const orchestrator = createImplementationOrchestrator({
        db: createMockDb(),
        pack: createMockPack(),
        contextCompiler: createMockContextCompiler(),
        dispatcher: createMockDispatcher(),
        eventBus: createMockEventBus(),
        config: defaultConfig(),
      })

      await orchestrator.run(['58-7'])

      // After clean completion, handler counts must return to baseline
      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm)
      expect(process.listenerCount('SIGINT')).toBe(before.sigint)
    })
  })

  // ---------------------------------------------------------------------------
  // AC6: Unit tests
  // ---------------------------------------------------------------------------

  describe('AC6 — unit tests', () => {
    it('SIGTERM calls patchRunStatus with status:stopped, stopped_reason:killed_by_user, and stopped_at (ISO)', async () => {
      const mockRunManifest = createMockRunManifest()
      const devStoryDeferred = createDeferred<ReturnType<typeof makeDevStorySuccess>>()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess())
      mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
      mockRunDevStory.mockReturnValue(devStoryDeferred.promise)
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      // When process.exit is called, unblock the dispatch so run() can complete cleanly.
      processExitSpy.mockImplementation((code?: number): never => {
        capturedExitCodes.push(code ?? -1)
        devStoryDeferred.resolve(makeDevStorySuccess())
        return undefined as never
      })

      const orchestrator = createImplementationOrchestrator({
        db: createMockDb(),
        pack: createMockPack(),
        contextCompiler: createMockContextCompiler(),
        dispatcher: createMockDispatcher(),
        eventBus: createMockEventBus(),
        config: defaultConfig({ shutdownGracePeriodMs: 50 }),
        runManifest: mockRunManifest as unknown as Parameters<typeof createImplementationOrchestrator>[0]['runManifest'],
      })

      // Start run() in the background
      const runPromise = orchestrator.run(['58-7'])

      // Allow run() to reach the blocked dispatch
      await new Promise(r => setTimeout(r, 30))

      // Emit SIGTERM — triggers shutdownGracefully asynchronously
      process.emit('SIGTERM')

      // Wait long enough for grace period + shutdown to complete
      await new Promise(r => setTimeout(r, 200))

      // Wait for run() to settle (unblocked by process.exit mock)
      await runPromise

      // AC6 core assertion: patchRunStatus called with correct args
      expect(mockRunManifest.patchRunStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          run_status: 'stopped',
          stopped_reason: 'killed_by_user',
        })
      )

      // stopped_at must be an ISO-8601 string
      const call = mockRunManifest.patchRunStatus.mock.calls[0]?.[0] as Record<string, unknown> | undefined
      expect(typeof call?.stopped_at).toBe('string')
      expect(call?.stopped_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })

    it('SIGTERM causes process.exit(143)', async () => {
      const devStoryDeferred = createDeferred<ReturnType<typeof makeDevStorySuccess>>()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess())
      mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
      mockRunDevStory.mockReturnValue(devStoryDeferred.promise)
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      processExitSpy.mockImplementation((code?: number): never => {
        capturedExitCodes.push(code ?? -1)
        devStoryDeferred.resolve(makeDevStorySuccess())
        return undefined as never
      })

      const orchestrator = createImplementationOrchestrator({
        db: createMockDb(),
        pack: createMockPack(),
        contextCompiler: createMockContextCompiler(),
        dispatcher: createMockDispatcher(),
        eventBus: createMockEventBus(),
        config: defaultConfig({ shutdownGracePeriodMs: 50 }),
      })

      const runPromise = orchestrator.run(['58-7'])
      await new Promise(r => setTimeout(r, 30))

      process.emit('SIGTERM')

      await new Promise(r => setTimeout(r, 200))
      await runPromise

      expect(capturedExitCodes).toContain(143)
    })

    it('SIGINT causes process.exit(130)', async () => {
      const devStoryDeferred = createDeferred<ReturnType<typeof makeDevStorySuccess>>()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess())
      mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
      mockRunDevStory.mockReturnValue(devStoryDeferred.promise)
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      processExitSpy.mockImplementation((code?: number): never => {
        capturedExitCodes.push(code ?? -1)
        devStoryDeferred.resolve(makeDevStorySuccess())
        return undefined as never
      })

      const orchestrator = createImplementationOrchestrator({
        db: createMockDb(),
        pack: createMockPack(),
        contextCompiler: createMockContextCompiler(),
        dispatcher: createMockDispatcher(),
        eventBus: createMockEventBus(),
        config: defaultConfig({ shutdownGracePeriodMs: 50 }),
      })

      const runPromise = orchestrator.run(['58-7'])
      await new Promise(r => setTimeout(r, 30))

      process.emit('SIGINT')

      await new Promise(r => setTimeout(r, 200))
      await runPromise

      expect(capturedExitCodes).toContain(130)
    })

    it('sets in-memory shutdown flag synchronously on SIGTERM so subsequent dispatches are skipped', async () => {
      // Strategy: create a 2-story run. Make story 1's devStory trigger SIGTERM.
      // After SIGTERM, the _shutdownRequested flag is set. If story 2 is in the
      // same conflict group, processConflictGroup will see the flag and skip it.
      // Verify that story 2's runDevStory is never called.

      const devStory1Deferred = createDeferred<ReturnType<typeof makeDevStorySuccess>>()
      let story2DevStoryCalled = false

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('58-7'))
      mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      // Story 1: devStory triggers SIGTERM when called
      let devStoryCallCount = 0
      mockRunDevStory.mockImplementation(async (..._args: unknown[]) => {
        devStoryCallCount++
        if (devStoryCallCount === 1) {
          // Emit SIGTERM synchronously — this sets _shutdownRequested immediately
          process.emit('SIGTERM')
          // Wait a tick so the signal handler has run
          await new Promise(r => setTimeout(r, 0))
          return makeDevStorySuccess()
        }
        // Story 2's dev-story — should never be reached
        story2DevStoryCalled = true
        return makeDevStorySuccess()
      })

      processExitSpy.mockImplementation((code?: number): never => {
        capturedExitCodes.push(code ?? -1)
        return undefined as never
      })

      const orchestrator = createImplementationOrchestrator({
        db: createMockDb(),
        pack: createMockPack(),
        contextCompiler: createMockContextCompiler(),
        dispatcher: createMockDispatcher(),
        eventBus: createMockEventBus(),
        // maxConcurrency: 1 so stories run sequentially (same "group")
        config: defaultConfig({ shutdownGracePeriodMs: 50, maxConcurrency: 1 }),
      })

      await orchestrator.run(['58-7', '58-8']).catch(() => null)

      // Story 2's dispatch should have been skipped
      expect(story2DevStoryCalled).toBe(false)

      // process.exit(143) should have been called
      expect(capturedExitCodes).toContain(143)
    })

    it('handlers are removed from process after run() completes normally (net listener change = 0)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess())
      mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const before = {
        sigterm: process.listenerCount('SIGTERM'),
        sigint: process.listenerCount('SIGINT'),
      }

      const orchestrator = createImplementationOrchestrator({
        db: createMockDb(),
        pack: createMockPack(),
        contextCompiler: createMockContextCompiler(),
        dispatcher: createMockDispatcher(),
        eventBus: createMockEventBus(),
        config: defaultConfig(),
      })

      await orchestrator.run(['58-7'])

      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm)
      expect(process.listenerCount('SIGINT')).toBe(before.sigint)
    })
  })

  // ---------------------------------------------------------------------------
  // AC7: Integration test
  // ---------------------------------------------------------------------------

  describe('AC7 — integration test', () => {
    it(
      'SIGTERM with blocked dispatch: manifest gets stopped_reason=killed_by_user, stopped_at ISO, and exit(143)',
      async () => {
        const mockRunManifest = createMockRunManifest()
        const devStoryDeferred = createDeferred<ReturnType<typeof makeDevStorySuccess>>()

        // Dispatch is blocked until process.exit is called (simulates a running agent)
        mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess())
        mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
        mockRunDevStory.mockReturnValue(devStoryDeferred.promise)
        mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

        // Unblock dispatch when process.exit is called so run() can complete cleanly
        processExitSpy.mockImplementation((code?: number): never => {
          capturedExitCodes.push(code ?? -1)
          devStoryDeferred.resolve(makeDevStorySuccess())
          return undefined as never
        })

        const orchestrator = createImplementationOrchestrator({
          db: createMockDb(),
          pack: createMockPack(),
          contextCompiler: createMockContextCompiler(),
          dispatcher: createMockDispatcher(),
          eventBus: createMockEventBus(),
          config: defaultConfig({ shutdownGracePeriodMs: 100 }),
          runManifest: mockRunManifest as unknown as Parameters<typeof createImplementationOrchestrator>[0]['runManifest'],
        })

        // Start run() — it will block on the devStory dispatch
        const runPromise = orchestrator.run(['58-7'])

        // Allow orchestrator to progress past startup into the dispatch loop
        await new Promise(r => setTimeout(r, 50))

        // Send SIGTERM via process.emit (no fork needed — handlers on this process)
        process.emit('SIGTERM')

        // Wait for grace period to elapse and shutdown to complete
        await new Promise(r => setTimeout(r, 250))

        // Wait for run() to complete (unblocked by process.exit mock)
        await runPromise

        // AC7 assertion 1: patchRunStatus called with stopped_reason=killed_by_user
        expect(mockRunManifest.patchRunStatus).toHaveBeenCalledWith(
          expect.objectContaining({
            run_status: 'stopped',
            stopped_reason: 'killed_by_user',
          })
        )

        // AC7 assertion 2: stopped_at is an ISO-8601 string
        const call = mockRunManifest.patchRunStatus.mock.calls[0]?.[0] as Record<string, unknown> | undefined
        expect(typeof call?.stopped_at).toBe('string')
        expect(call?.stopped_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)

        // AC7 assertion 3: process.exit called with 143
        expect(capturedExitCodes).toContain(143)
      },
      { timeout: 10000 },
    )
  })
})
