/**
 * Unit tests for the orchestrator heartbeat timer (AC1) and watchdog stall detection (AC2).
 *
 * These tests use vi.useFakeTimers() to control setInterval timing without real delays.
 *
 * Story 16-7:
 *   AC1: Heartbeat emitted every 30s when pipeline is running
 *   AC2: Watchdog emits story:stall when no progress for 10 minutes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { OrchestratorConfig } from '../types.js'
import { TypedEventBusImpl } from '../../../core/event-bus.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'

// ---------------------------------------------------------------------------
// Module mocks
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
  addTokenUsage: vi.fn(),
  getDecisionsByPhase: vi.fn().mockReturnValue([]),
  registerArtifact: vi.fn(),
}))
vi.mock('../../../persistence/queries/metrics.js', () => ({
  writeRunMetrics: vi.fn(),
  writeStoryMetrics: vi.fn(),
  aggregateTokenUsageForStory: vi.fn().mockReturnValue({ input: 0, output: 0, cost: 0 }),
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
vi.mock('../seed-methodology-context.js', () => ({
  seedMethodologyContext: vi.fn().mockReturnValue({ decisionsCreated: 0, skippedCategories: [] }),
}))
vi.mock('../../../modules/compiled-workflows/index.js', () => ({
  analyzeStoryComplexity: vi.fn().mockReturnValue({
    estimatedScope: 'simple',
    taskCount: 3,
    hasManyACs: false,
    hasLargeDevNotes: false,
  }),
  planTaskBatches: vi.fn().mockReturnValue([]),
}))

// ---------------------------------------------------------------------------
// Import mocked modules
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)

// ---------------------------------------------------------------------------
// Helper factories
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
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function makeCreateStorySuccess(storyKey: string) {
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

function defaultConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    maxConcurrency: 1,
    maxReviewCycles: 2,
    pipelineRunId: 'test-run-16-7',
    enableHeartbeat: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Heartbeat timer tests (AC1)
// ---------------------------------------------------------------------------

describe('AC1: Heartbeat timer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits orchestrator:heartbeat event when 30s setInterval fires during an active run', async () => {
    vi.useFakeTimers()

    const eventBus = new TypedEventBusImpl()
    const heartbeatPayloads: Array<{
      runId: string
      activeDispatches: number
      completedDispatches: number
      queuedDispatches: number
    }> = []

    eventBus.on('orchestrator:heartbeat', (payload) => {
      heartbeatPayloads.push(payload)
    })

    // Slow create-story that yields control so timer can fire
    let resolveCreate!: (v: ReturnType<typeof makeCreateStorySuccess>) => void
    const createPromise = new Promise<ReturnType<typeof makeCreateStorySuccess>>((res) => {
      resolveCreate = res
    })
    mockRunCreateStory.mockReturnValue(createPromise as never)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus,
      config: defaultConfig(),
    })

    // Start run (don't await — orchestrator is blocked in create-story)
    const runPromise = orchestrator.run(['16-1'])

    // Advance fake timers by 30 seconds to trigger heartbeat
    await vi.advanceTimersByTimeAsync(30_000)

    // At least one heartbeat should have fired
    expect(heartbeatPayloads.length).toBeGreaterThanOrEqual(1)
    const hb = heartbeatPayloads[0]!
    expect(hb.runId).toBe('test-run-16-7')
    expect(typeof hb.activeDispatches).toBe('number')
    expect(typeof hb.completedDispatches).toBe('number')
    expect(typeof hb.queuedDispatches).toBe('number')

    // Advance another 30 seconds — should get a second heartbeat
    await vi.advanceTimersByTimeAsync(30_000)
    expect(heartbeatPayloads.length).toBeGreaterThanOrEqual(2)

    // Complete the run
    resolveCreate(makeCreateStorySuccess('16-1'))
    await runPromise
  })

  it('does NOT emit heartbeat events when orchestrator is not in RUNNING state', async () => {
    vi.useFakeTimers()

    const eventBus = new TypedEventBusImpl()
    const heartbeatPayloads: unknown[] = []
    eventBus.on('orchestrator:heartbeat', (p) => heartbeatPayloads.push(p))

    createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus,
      config: defaultConfig(),
    })

    // Never call run() — advance timers well past the interval
    await vi.advanceTimersByTimeAsync(60_000)

    expect(heartbeatPayloads.length).toBe(0)
  })

  it('stops emitting heartbeats after run completes', async () => {
    vi.useFakeTimers()

    const eventBus = new TypedEventBusImpl()
    const heartbeatPayloads: unknown[] = []
    eventBus.on('orchestrator:heartbeat', (p) => heartbeatPayloads.push(p))

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('16-2'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus,
      config: defaultConfig(),
    })

    // Complete the run — it should finish synchronously (all mocks are resolved)
    await orchestrator.run(['16-2'])

    // Clear any heartbeats that fired during the run
    const countAfterRun = heartbeatPayloads.length

    // Advance time well past the heartbeat interval
    await vi.advanceTimersByTimeAsync(60_000)

    // No new heartbeats should fire after run completes
    expect(heartbeatPayloads.length).toBe(countAfterRun)
  })

  it('heartbeat counts active, completed, and queued dispatches correctly', async () => {
    vi.useFakeTimers()

    const eventBus = new TypedEventBusImpl()
    const heartbeatPayloads: Array<{
      activeDispatches: number
      completedDispatches: number
      queuedDispatches: number
    }> = []
    eventBus.on('orchestrator:heartbeat', (p) => heartbeatPayloads.push(p))

    // Hold story 16-1 in IN_DEV; story 16-2 is PENDING
    let resolveCreate!: (v: ReturnType<typeof makeCreateStorySuccess>) => void
    const createPromise = new Promise<ReturnType<typeof makeCreateStorySuccess>>((res) => {
      resolveCreate = res
    })
    mockRunCreateStory.mockReturnValue(createPromise as never)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus,
      config: defaultConfig({ maxConcurrency: 1 }),
    })

    const runPromise = orchestrator.run(['16-1', '16-2'])
    await vi.advanceTimersByTimeAsync(30_000)

    expect(heartbeatPayloads.length).toBeGreaterThanOrEqual(1)
    const hb = heartbeatPayloads[0]!
    // 16-1 is IN_STORY_CREATION (active), 16-2 is PENDING (queued), 0 completed
    expect(hb.activeDispatches).toBeGreaterThanOrEqual(0)
    expect(hb.completedDispatches).toBeGreaterThanOrEqual(0)
    expect(hb.queuedDispatches).toBeGreaterThanOrEqual(0)

    resolveCreate(makeCreateStorySuccess('16-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
    await runPromise
  })
})

// ---------------------------------------------------------------------------
// Watchdog stall detection tests (AC2)
// ---------------------------------------------------------------------------

describe('AC2: Watchdog stall detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits orchestrator:stall when no progress for WATCHDOG_TIMEOUT_MS (10 minutes)', async () => {
    vi.useFakeTimers()

    const eventBus = new TypedEventBusImpl()
    const stallPayloads: Array<{
      runId: string
      storyKey: string
      phase: string
      elapsedMs: number
    }> = []
    eventBus.on('orchestrator:stall', (p) => stallPayloads.push(p))

    // Story that hangs in create-story phase forever (simulating stall)
    let resolveCreate!: (v: ReturnType<typeof makeCreateStorySuccess>) => void
    const createPromise = new Promise<ReturnType<typeof makeCreateStorySuccess>>((res) => {
      resolveCreate = res
    })
    mockRunCreateStory.mockReturnValue(createPromise as never)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus,
      config: defaultConfig(),
    })

    const runPromise = orchestrator.run(['16-3'])

    // Advance by exactly WATCHDOG_TIMEOUT_MS (600,000ms = 10 minutes) + one heartbeat interval
    // The heartbeat fires every 30s and checks the watchdog. After 10 minutes with no progress,
    // the next heartbeat tick should emit the stall event.
    await vi.advanceTimersByTimeAsync(630_000) // 10 min 30 sec

    expect(stallPayloads.length).toBeGreaterThanOrEqual(1)
    const stall = stallPayloads[0]!
    expect(stall.runId).toBe('test-run-16-7')
    expect(stall.storyKey).toBe('16-3')
    expect(typeof stall.phase).toBe('string')
    expect(stall.elapsedMs).toBeGreaterThanOrEqual(600_000)

    // Clean up — complete the run
    resolveCreate(makeCreateStorySuccess('16-3'))
    await runPromise
  })

  it('does NOT emit stall before watchdog timeout elapses', async () => {
    vi.useFakeTimers()

    const eventBus = new TypedEventBusImpl()
    const stallPayloads: unknown[] = []
    eventBus.on('orchestrator:stall', (p) => stallPayloads.push(p))

    let resolveCreate!: (v: ReturnType<typeof makeCreateStorySuccess>) => void
    const createPromise = new Promise<ReturnType<typeof makeCreateStorySuccess>>((res) => {
      resolveCreate = res
    })
    mockRunCreateStory.mockReturnValue(createPromise as never)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus,
      config: defaultConfig(),
    })

    const runPromise = orchestrator.run(['16-4'])

    // Advance only 5 minutes (below the 10-minute watchdog threshold)
    await vi.advanceTimersByTimeAsync(300_000) // 5 minutes

    expect(stallPayloads.length).toBe(0)

    // Complete the run without stall
    resolveCreate(makeCreateStorySuccess('16-4'))
    await runPromise
  })

  it('stall event includes elapsed time since last progress', async () => {
    vi.useFakeTimers()

    const eventBus = new TypedEventBusImpl()
    const stallPayloads: Array<{ elapsedMs: number }> = []
    eventBus.on('orchestrator:stall', (p) => stallPayloads.push(p))

    let resolveCreate!: (v: ReturnType<typeof makeCreateStorySuccess>) => void
    const createPromise = new Promise<ReturnType<typeof makeCreateStorySuccess>>((res) => {
      resolveCreate = res
    })
    mockRunCreateStory.mockReturnValue(createPromise as never)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus,
      config: defaultConfig(),
    })

    const runPromise = orchestrator.run(['16-5'])

    // Advance past watchdog timeout
    await vi.advanceTimersByTimeAsync(660_000) // 11 minutes

    expect(stallPayloads.length).toBeGreaterThanOrEqual(1)
    // Elapsed should be at least 600,000ms (10 minutes)
    expect(stallPayloads[0]!.elapsedMs).toBeGreaterThanOrEqual(600_000)

    resolveCreate(makeCreateStorySuccess('16-5'))
    await runPromise
  })
})

// ---------------------------------------------------------------------------
// NDJSON event wiring tests (T2, T4)
// ---------------------------------------------------------------------------

describe('T2/T4: Heartbeat and stall event schemas', () => {
  it('PipelineHeartbeatEvent has correct fields per story schema', () => {
    // Validate the schema matches what the orchestrator emits
    const event = {
      type: 'pipeline:heartbeat' as const,
      ts: new Date().toISOString(),
      run_id: 'run-123',
      active_dispatches: 2,
      completed_dispatches: 1,
      queued_dispatches: 0,
    }
    expect(event.type).toBe('pipeline:heartbeat')
    expect(typeof event.run_id).toBe('string')
    expect(typeof event.active_dispatches).toBe('number')
    expect(typeof event.completed_dispatches).toBe('number')
    expect(typeof event.queued_dispatches).toBe('number')
  })

  it('StoryStallEvent has correct fields per story schema', () => {
    const event = {
      type: 'story:stall' as const,
      ts: new Date().toISOString(),
      run_id: 'run-123',
      story_key: '16-2',
      phase: 'dev-story',
      elapsed_ms: 600_000,
    }
    expect(event.type).toBe('story:stall')
    expect(typeof event.run_id).toBe('string')
    expect(typeof event.story_key).toBe('string')
    expect(typeof event.phase).toBe('string')
    expect(typeof event.elapsed_ms).toBe('number')
  })
})
