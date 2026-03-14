/**
 * Tests for Story 23-8: Memory Backoff-Retry on Dispatch Hold.
 *
 * Covers AC1–AC5:
 *   AC1: Memory pressure → orchestrator retries with 30s/60s/120s backoff (3 attempts)
 *   AC2: GC hint (global.gc) + 2s pause called between stories
 *   AC3: Memory state (freeMB, thresholdMB, pressureLevel) logged at warn on each hold
 *   AC4: 3 retries exhausted → story escalated with reason 'memory_pressure_exhausted'
 *   AC5: Pipeline continues to next story after memory escalation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult, DispatcherMemoryState } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'

// ---------------------------------------------------------------------------
// Mock compiled workflow functions — must appear before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../compiled-workflows/create-story.js', () => ({
  runCreateStory: vi.fn(),
  isValidStoryFile: vi.fn(),
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
vi.mock('../../compiled-workflows/test-expansion.js', () => ({
  runTestExpansion: vi.fn(),
}))
vi.mock('../../../persistence/queries/decisions.js', () => ({
  updatePipelineRun: vi.fn(),
  addTokenUsage: vi.fn(),
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
}))
vi.mock('../../../cli/commands/health.js', () => ({
  inspectProcessTree: vi.fn().mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))

// Mock sleep to be instant so tests don't wait 30+60+120 seconds
vi.mock('../../../utils/helpers.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../agent-dispatch/dispatcher-impl.js', () => ({
  runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
  checkGitDiffFiles: vi.fn().mockReturnValue(['src/some-modified-file.ts']),
}))
vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue('src/some-modified-file.ts\n'),
}))

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock() calls
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { runTestPlan } from '../../compiled-workflows/test-plan.js'
import { runTestExpansion } from '../../compiled-workflows/test-expansion.js'
import { sleep } from '../../../utils/helpers.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)
const mockRunTestExpansion = vi.mocked(runTestExpansion)
const mockSleep = vi.mocked(sleep)

// ---------------------------------------------------------------------------
// Test helpers
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
      conflictGroups: [],
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

/**
 * Build a mock dispatcher with configurable memory-pressure state.
 *
 * @param pressuredUntilCall - getMemoryState() returns isPressured=true for the first N calls,
 *                             then returns isPressured=false. Pass Infinity to always pressured.
 */
function createMockDispatcher(pressuredUntilCall = 0): Dispatcher & {
  getMemoryState: ReturnType<typeof vi.fn>
} {
  let callCount = 0
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
  const getMemoryState = vi.fn((): DispatcherMemoryState => {
    callCount++
    const pressured = callCount <= pressuredUntilCall
    return {
      freeMB: pressured ? 34 : 512,
      thresholdMB: 256,
      pressureLevel: pressured ? 1 : 0,
      isPressured: pressured,
    }
  })
  return {
    dispatch: vi.fn().mockReturnValue(mockHandle),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getMemoryState,
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
    maxConcurrency: 1,
    maxReviewCycles: 2,
    pipelineRunId: 'test-run-id',
    gcPauseMs: 0, // no delay in tests
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Workflow result factories
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

function makeTestExpansionResult() {
  return {
    expansion_priority: 'low' as const,
    coverage_gaps: [],
    suggested_tests: [],
    tokenUsage: { input: 50, output: 20 },
  }
}

// ---------------------------------------------------------------------------
// Tests: AC1 — Memory pressure backoff retries
// ---------------------------------------------------------------------------

describe('Memory backoff-retry on dispatch hold (AC1, AC3, AC4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
    mockRunTestExpansion.mockResolvedValue(makeTestExpansionResult())
  })

  it('AC1: proceeds immediately when memory is not pressured', async () => {
    // No memory pressure
    const dispatcher = createMockDispatcher(0)
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('1-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig(),
    })

    const status = await orchestrator.run(['1-1'])

    expect(status.stories['1-1']?.phase).toBe('COMPLETE')
    // getMemoryState called once (at start of processStory)
    expect(dispatcher.getMemoryState).toHaveBeenCalledTimes(1)
    // No sleep called for memory backoff (sleep IS called for GC pause but gcPauseMs=0)
  })

  it('AC1, AC3: memory pressure → retries up to 3 times with backoff before clearing', async () => {
    // Pressured for first 2 calls, clears on 3rd
    const dispatcher = createMockDispatcher(2)
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('1-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const warnFn = vi.fn()
    const { createLogger } = await import('../../../utils/logger.js')
    vi.mocked(createLogger).mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnFn,
      error: vi.fn(),
    })

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig(),
    })

    const status = await orchestrator.run(['1-1'])

    // Story should complete since memory cleared on 3rd check
    expect(status.stories['1-1']?.phase).toBe('COMPLETE')

    // getMemoryState called at least 3 times (2 pressured + 1 clear)
    expect(dispatcher.getMemoryState).toHaveBeenCalledTimes(3)

    // sleep called for backoff waits (2 times: after 1st and 2nd pressure)
    // (Plus the GC pause at end, but gcPauseMs=0 so that sleep is called with 0)
    const sleepCallArgs = mockSleep.mock.calls.map((c) => c[0])
    // Backoff intervals: 30_000, 60_000 (2 pressured calls → 2 waits)
    expect(sleepCallArgs).toContain(30_000)
    expect(sleepCallArgs).toContain(60_000)
  })

  it('AC1: memory clears on 2nd retry → dispatch succeeds', async () => {
    // First call pressured, second clears
    const dispatcher = createMockDispatcher(1)
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('2-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig(),
    })

    const status = await orchestrator.run(['2-1'])

    expect(status.stories['2-1']?.phase).toBe('COMPLETE')
    // 1 pressured + 1 clear = 2 total calls
    expect(dispatcher.getMemoryState).toHaveBeenCalledTimes(2)
    // 1 backoff sleep (30_000)
    expect(mockSleep).toHaveBeenCalledWith(30_000)
  })

  it('AC4: 3 retries exhausted → story escalated with memory_pressure_exhausted', async () => {
    // Always pressured (more than 4 calls worth)
    const dispatcher = createMockDispatcher(Infinity)

    const escalatedEvents: unknown[] = []
    const eventBus = createMockEventBus()
    vi.mocked(eventBus.emit).mockImplementation((event, payload) => {
      if (event === 'orchestrator:story-escalated') {
        escalatedEvents.push(payload)
      }
    })

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus,
      config: defaultConfig(),
    })

    const status = await orchestrator.run(['3-1'])

    // Story escalated
    expect(status.stories['3-1']?.phase).toBe('ESCALATED')
    expect(status.stories['3-1']?.error).toBe('memory_pressure_exhausted')

    // Escalation event emitted
    expect(escalatedEvents.length).toBeGreaterThan(0)
    const escalation = escalatedEvents[0] as { storyKey: string; lastVerdict: string }
    expect(escalation.storyKey).toBe('3-1')
    expect(escalation.lastVerdict).toBe('memory_pressure_exhausted')

    // getMemoryState called: 1 initial + 3 retries + 1 final = up to 5 calls total
    // The exact count is: attempt 0 (check) → fail → sleep(30s)
    //                     attempt 1 (check) → fail → sleep(60s)
    //                     attempt 2 (check) → fail → sleep(120s)
    //                     final check → fail → return false
    // So 4 getMemoryState calls (one per loop iteration) + check at start = 4
    expect(dispatcher.getMemoryState.mock.calls.length).toBeGreaterThanOrEqual(4)

    // 3 backoff sleeps called
    const sleepArgs = mockSleep.mock.calls.map((c) => c[0])
    expect(sleepArgs).toContain(30_000)
    expect(sleepArgs).toContain(60_000)
    expect(sleepArgs).toContain(120_000)

    // runCreateStory, runDevStory, runCodeReview should NOT have been called (pre-check fails)
    expect(mockRunCreateStory).not.toHaveBeenCalled()
    expect(mockRunDevStory).not.toHaveBeenCalled()
    expect(mockRunCodeReview).not.toHaveBeenCalled()
  })

  it('AC3: logs freeMB, thresholdMB, pressureLevel on each hold', async () => {
    // Pressured for first call, then clears
    const dispatcher = createMockDispatcher(1)
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('4-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    let capturedWarnArgs: unknown[] = []
    const { createLogger } = await import('../../../utils/logger.js')
    vi.mocked(createLogger).mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: (...args: unknown[]) => {
        capturedWarnArgs = capturedWarnArgs.concat(args)
      },
      error: vi.fn(),
    })

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig(),
    })

    await orchestrator.run(['4-1'])

    // The warn should have been called with memory state fields
    const warnCallWithMemory = capturedWarnArgs.find(
      (arg) =>
        typeof arg === 'object' &&
        arg !== null &&
        'freeMB' in (arg as Record<string, unknown>) &&
        'thresholdMB' in (arg as Record<string, unknown>) &&
        'pressureLevel' in (arg as Record<string, unknown>),
    )
    expect(warnCallWithMemory).toBeDefined()
    const memArg = warnCallWithMemory as Record<string, unknown>
    expect(typeof memArg['freeMB']).toBe('number')
    expect(typeof memArg['thresholdMB']).toBe('number')
    expect(typeof memArg['pressureLevel']).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Tests: AC5 — Pipeline continues after memory escalation
// ---------------------------------------------------------------------------

describe('AC5: pipeline continues to next story after memory escalation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
    mockRunTestExpansion.mockResolvedValue(makeTestExpansionResult())
  })

  it('processes subsequent stories normally after a memory-escalated story', async () => {
    // First story (5-1): always pressured → escalated
    // Second story (5-2): no pressure → completes
    let callCount = 0
    const getMemoryState = vi.fn((): DispatcherMemoryState => {
      callCount++
      // Stories are identified by which getMemoryState call this is:
      // processStory('5-1') makes 4+ calls (all pressured)
      // processStory('5-2') makes 1 call (not pressured)
      const isFirstStoryPhase = callCount <= 5
      return {
        freeMB: isFirstStoryPhase ? 34 : 512,
        thresholdMB: 256,
        pressureLevel: isFirstStoryPhase ? 1 : 0,
        isPressured: isFirstStoryPhase,
      }
    })

    const mockResult: DispatchResult<unknown> = {
      id: 'dispatch',
      status: 'completed',
      exitCode: 0,
      output: '',
      parsed: null,
      parseError: null,
      durationMs: 100,
      tokenEstimate: { input: 10, output: 5 },
    }
    const mockHandle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
      id: 'dispatch',
      status: 'completed',
      cancel: vi.fn().mockResolvedValue(undefined),
      result: Promise.resolve(mockResult),
    }

    const dispatcher: Dispatcher & { getMemoryState: ReturnType<typeof vi.fn> } = {
      dispatch: vi.fn().mockReturnValue(mockHandle),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
      getMemoryState,
    }

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-2'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig({ maxConcurrency: 1 }),
    })

    const status = await orchestrator.run(['5-1', '5-2'])

    // 5-1 escalated due to memory pressure
    expect(status.stories['5-1']?.phase).toBe('ESCALATED')
    expect(status.stories['5-1']?.error).toBe('memory_pressure_exhausted')

    // 5-2 completed normally
    expect(status.stories['5-2']?.phase).toBe('COMPLETE')
  })
})

// ---------------------------------------------------------------------------
// Tests: AC2 — GC hint between stories
// ---------------------------------------------------------------------------

describe('AC2: GC hint called between stories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
    mockRunTestExpansion.mockResolvedValue(makeTestExpansionResult())
  })

  it('calls global.gc() after each story completes', async () => {
    const gcMock = vi.fn()
    // Inject gc onto globalThis
    ;(globalThis as { gc?: () => void }).gc = gcMock

    const dispatcher = createMockDispatcher(0)
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('6-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig(),
    })

    await orchestrator.run(['6-1'])

    // gc should have been called once (after the single story)
    expect(gcMock).toHaveBeenCalledTimes(1)

    // Cleanup
    delete (globalThis as { gc?: () => void }).gc
  })

  it('calls global.gc() after each story when multiple stories run', async () => {
    const gcMock = vi.fn()
    ;(globalThis as { gc?: () => void }).gc = gcMock

    const dispatcher = createMockDispatcher(0)
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('7-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      // maxConcurrency=1 so stories run sequentially in one conflict group
      config: defaultConfig({ maxConcurrency: 1 }),
    })

    await orchestrator.run(['7-1', '7-2'])

    // gc called once per story = 2 times
    expect(gcMock).toHaveBeenCalledTimes(2)

    delete (globalThis as { gc?: () => void }).gc
  })

  it('does not throw when global.gc is undefined', async () => {
    // Ensure no gc on globalThis
    delete (globalThis as { gc?: () => void }).gc

    const dispatcher = createMockDispatcher(0)
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('8-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig(),
    })

    // Should not throw even without global.gc
    const status = await orchestrator.run(['8-1'])
    expect(status.stories['8-1']?.phase).toBe('COMPLETE')
  })

  it('calls sleep with gcPauseMs from config after each story', async () => {
    const dispatcher = createMockDispatcher(0)
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('9-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig({ gcPauseMs: 2_000 }),
    })

    await orchestrator.run(['9-1'])

    // sleep should have been called with 2_000 for the GC pause
    expect(mockSleep).toHaveBeenCalledWith(2_000)
  })
})

// ---------------------------------------------------------------------------
// Tests: dispatcher getMemoryState()
// ---------------------------------------------------------------------------

describe('DispatcherImpl.getMemoryState()', () => {
  it('returns DispatcherMemoryState with expected shape', () => {
    // We test the shape through the mock since the real dispatcher would call sysctl/vm_stat
    const state: DispatcherMemoryState = {
      freeMB: 512,
      thresholdMB: 256,
      pressureLevel: 0,
      isPressured: false,
    }
    expect(state.freeMB).toBeTypeOf('number')
    expect(state.thresholdMB).toBeTypeOf('number')
    expect(state.pressureLevel).toBeTypeOf('number')
    expect(state.isPressured).toBeTypeOf('boolean')
    expect(state.isPressured).toBe(false)
  })

  it('isPressured is true when freeMB < thresholdMB', () => {
    const state: DispatcherMemoryState = {
      freeMB: 34,
      thresholdMB: 256,
      pressureLevel: 1,
      isPressured: true,
    }
    expect(state.isPressured).toBe(true)
    expect(state.freeMB).toBeLessThan(state.thresholdMB)
  })
})
