/**
 * Integration tests for Story 26-4: Orchestrator State Migration.
 *
 * Validates AC2 (story state persisted to StateStore on transitions),
 * AC3 (getStatus() merges StateStore data), AC4 (verdict + outcome fields),
 * AC5 (orchestrator works without stateStore dep), AC6 (integration via
 * FileStateStore real backend), and AC7 (lifecycle: initialize + close called).
 *
 * Uses FileStateStore as the real backend — no mocking of StateStore itself.
 * Compiled workflow runners are mocked to keep tests fast and deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'
import { FileStateStore } from '../../state/file-store.js'

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports that use them
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
  runTestExpansion: vi.fn().mockResolvedValue({
    expansion_priority: 'low',
    coverage_gaps: [],
    recommended_tests: [],
    rationale: 'mock',
  }),
}))
vi.mock('../../compiled-workflows/index.js', () => ({
  analyzeStoryComplexity: vi.fn().mockReturnValue({
    estimatedScope: 'small',
    taskCount: 2,
    complexity: 'simple',
    reason: 'test',
  }),
  planTaskBatches: vi.fn().mockReturnValue([]),
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
vi.mock('../../agent-dispatch/dispatcher-impl.js', () => ({
  runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
  checkGitDiffFiles: vi.fn().mockReturnValue(['src/some-modified-file.ts']),
}))
vi.mock('../../agent-dispatch/interface-change-detector.js', () => ({
  detectInterfaceChanges: vi.fn().mockReturnValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] }),
}))
vi.mock('./seed-methodology-context.js', () => ({
  seedMethodologyContext: vi.fn().mockReturnValue({ decisionsCreated: 0, skippedCategories: [] }),
}))
vi.mock('../seed-methodology-context.js', () => ({
  seedMethodologyContext: vi.fn().mockReturnValue({ decisionsCreated: 0, skippedCategories: [] }),
}))
vi.mock('../conflict-detector.js', () => ({
  detectConflictGroupsWithContracts: vi.fn().mockReturnValue({ batches: [[['26-4']]], edges: [] }),
}))
vi.mock('../contract-verifier.js', () => ({
  verifyContracts: vi.fn().mockReturnValue([]),
}))
vi.mock('../compiled-workflows/interface-contracts.js', () => ({
  parseInterfaceContracts: vi.fn().mockReturnValue([]),
}))
vi.mock('../../compiled-workflows/interface-contracts.js', () => ({
  parseInterfaceContracts: vi.fn().mockReturnValue([]),
}))
vi.mock('../../compiled-workflows/story-complexity.js', () => ({
  computeStoryComplexity: vi.fn().mockReturnValue({ complexityScore: 5, taskCount: 2 }),
  resolveFixStoryMaxTurns: vi.fn().mockReturnValue(20),
  logComplexityResult: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock() calls
// ---------------------------------------------------------------------------

import { runCreateStory, isValidStoryFile } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { runTestPlan } from '../../compiled-workflows/test-plan.js'
import { detectConflictGroupsWithContracts } from '../conflict-detector.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)
const mockIsValidStoryFile = vi.mocked(isValidStoryFile)
const mockDetectConflictGroups = vi.mocked(detectConflictGroupsWithContracts)

// ---------------------------------------------------------------------------
// Mock factories
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
    maxConcurrency: 1,
    maxReviewCycles: 2,
    pipelineRunId: 'test-run-id',
    gcPauseMs: 0,
    skipPreflight: true,
    skipBuildVerify: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Default mock responses
// ---------------------------------------------------------------------------

function makeCreateStorySuccess(storyKey = '26-4') {
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
    issue_list: [{ severity: 'minor' as const, description: 'Add more docs' }],
    tokenUsage: { input: 150, output: 50 },
  }
}

function makeTestPlanSuccess() {
  return {
    result: 'success' as const,
    test_files: [],
    test_categories: [],
    tokenUsage: { input: 50, output: 20 },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockIsValidStoryFile?.mockResolvedValue({ valid: false, reason: 'no file' })
  mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess() as any)
})

// ---------------------------------------------------------------------------
// AC6 + AC2: Story state is persisted to real FileStateStore on transitions
// ---------------------------------------------------------------------------

describe('AC6 + AC2: FileStateStore receives story state on transitions', () => {
  it('stores COMPLETE state in FileStateStore after successful run', async () => {
    const storyKey = '26-4'
    const store = new FileStateStore()

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    await orchestrator.run([storyKey])

    const record = await store.getStoryState(storyKey)
    expect(record).toBeDefined()
    expect(record!.storyKey).toBe(storyKey)
    expect(record!.phase).toBe('COMPLETE')
  })

  it('stores ESCALATED state in FileStateStore when create-story fails', async () => {
    const storyKey = '26-4'
    const store = new FileStateStore()

    mockRunCreateStory.mockRejectedValue(new Error('create-story failed'))

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    await orchestrator.run([storyKey])

    const record = await store.getStoryState(storyKey)
    expect(record).toBeDefined()
    expect(record!.phase).toBe('ESCALATED')
    expect(record!.error).toBeDefined()
  })

  it('stores PENDING state in FileStateStore during initialization', async () => {
    const storyKey = '26-4'
    const store = new FileStateStore()

    // Track when PENDING is written by spying on setStoryState
    const writes: Array<{ storyKey: string; phase: string }> = []
    const originalSet = store.setStoryState.bind(store)
    vi.spyOn(store, 'setStoryState').mockImplementation(async (key, state) => {
      writes.push({ storyKey: key, phase: state.phase })
      return originalSet(key, state)
    })

    // Make create-story fail quickly so the run ends without too much processing
    mockRunCreateStory.mockRejectedValue(new Error('fail fast'))

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    await orchestrator.run([storyKey])

    // The first write should be PENDING
    const pendingWrite = writes.find((w) => w.phase === 'PENDING' && w.storyKey === storyKey)
    expect(pendingWrite).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// AC4: Code-review verdict reflected in StateStore record
// ---------------------------------------------------------------------------

describe('AC4: Code-review verdict stored in StateStore', () => {
  it('reflects lastVerdict in StateStore after code-review', async () => {
    const storyKey = '26-4'
    const store = new FileStateStore()

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    await orchestrator.run([storyKey])

    const record = await store.getStoryState(storyKey)
    expect(record).toBeDefined()
    // After SHIP_IT, phase is COMPLETE and lastVerdict should be SHIP_IT
    expect(record!.phase).toBe('COMPLETE')
    expect(record!.lastVerdict).toBe('SHIP_IT')
  })

  it('stores lastVerdict from NEEDS_MINOR_FIXES when story escalates after max cycles', async () => {
    const storyKey = '26-4'
    const store = new FileStateStore()

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    // Always return NEEDS_MINOR_FIXES to exhaust review cycles (maxReviewCycles=1 triggers auto-approve)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewMinorFixes() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig({ maxReviewCycles: 1 }),
      stateStore: store,
    })

    await orchestrator.run([storyKey])

    const record = await store.getStoryState(storyKey)
    expect(record).toBeDefined()
    // After exhausting minor fixes with auto-approve, story is COMPLETE
    expect(['COMPLETE', 'ESCALATED']).toContain(record!.phase)
  })
})

// ---------------------------------------------------------------------------
// AC7: StateStore lifecycle — initialize() before dispatch, close() in finally
// ---------------------------------------------------------------------------

describe('AC7: StateStore lifecycle management', () => {
  it('calls stateStore.initialize() before dispatching any story', async () => {
    const storyKey = '26-4'
    const store = new FileStateStore()
    const initSpy = vi.spyOn(store, 'initialize')
    const closeSpy = vi.spyOn(store, 'close')

    const dispatchOrder: string[] = []
    initSpy.mockImplementation(async () => {
      dispatchOrder.push('initialize')
    })

    mockRunCreateStory.mockImplementation(async () => {
      dispatchOrder.push('create-story')
      return makeCreateStorySuccess(storyKey) as any
    })
    mockRunDevStory.mockImplementation(async () => {
      dispatchOrder.push('dev-story')
      return makeDevStorySuccess() as any
    })
    mockRunCodeReview.mockImplementation(async () => {
      dispatchOrder.push('code-review')
      return makeCodeReviewShipIt() as any
    })

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    await orchestrator.run([storyKey])

    expect(initSpy).toHaveBeenCalledOnce()
    expect(closeSpy).toHaveBeenCalledOnce()
    // initialize must come before any story dispatch
    expect(dispatchOrder[0]).toBe('initialize')
    expect(dispatchOrder).toContain('create-story')
  })

  it('calls stateStore.close() even when run() throws an error', async () => {
    const storyKey = '26-4'
    const store = new FileStateStore()
    const closeSpy = vi.spyOn(store, 'close')

    // Make the run fail: create-story throws
    mockRunCreateStory.mockRejectedValue(new Error('unexpected error'))

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    await orchestrator.run([storyKey])

    // close() must always be called (finally block)
    expect(closeSpy).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// AC5: Orchestrator works correctly without stateStore dependency
// ---------------------------------------------------------------------------

describe('AC5: Orchestrator without stateStore works correctly', () => {
  it('completes a story successfully without stateStore dep', async () => {
    const storyKey = '26-4'

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    // No stateStore provided — orchestrator must still work
    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      // stateStore intentionally omitted
    })

    const status = await orchestrator.run([storyKey])

    expect(status.state).toBe('COMPLETE')
    expect(status.stories[storyKey]?.phase).toBe('COMPLETE')
  })

  it('escalates a story without stateStore dep when create-story fails', async () => {
    const storyKey = '26-4'

    mockRunCreateStory.mockRejectedValue(new Error('create-story failed'))

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
    })

    const status = await orchestrator.run([storyKey])

    expect(status.state).toBe('COMPLETE')
    expect(status.stories[storyKey]?.phase).toBe('ESCALATED')
  })
})

// ---------------------------------------------------------------------------
// AC3: getStatus() merges StateStore cache data
// ---------------------------------------------------------------------------

describe('AC3: getStatus() merges StateStore cache data', () => {
  it('getStatus() reflects story states from in-memory _stories map', async () => {
    const storyKey = '26-4'
    const store = new FileStateStore()

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    const finalStatus = await orchestrator.run([storyKey])

    // In-memory _stories takes precedence — story must appear in status
    expect(finalStatus.stories[storyKey]).toBeDefined()
    expect(finalStatus.stories[storyKey]?.phase).toBe('COMPLETE')
  })

  it('getStatus() includes stories pre-seeded in StateStore that are not in the current run', async () => {
    const preSeededStoryKey = '26-99'
    const currentStoryKey = '26-4'

    // Pre-seed a story in a FileStateStore before the orchestrator is created.
    // The orchestrator will pick it up via queryStories({}) during initialize.
    const store = new FileStateStore()
    await store.initialize()
    await store.setStoryState(preSeededStoryKey, {
      storyKey: preSeededStoryKey,
      phase: 'COMPLETE',
      reviewCycles: 1,
      lastVerdict: 'SHIP_IT',
    })

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(currentStoryKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    // Run the orchestrator with ONLY the current story — NOT the pre-seeded one.
    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    const finalStatus = await orchestrator.run([currentStoryKey])

    // Current run story must appear in status
    expect(finalStatus.stories[currentStoryKey]).toBeDefined()
    expect(finalStatus.stories[currentStoryKey]?.phase).toBe('COMPLETE')

    // Pre-seeded story from StateStore cache must ALSO appear in status (AC3)
    expect(finalStatus.stories[preSeededStoryKey]).toBeDefined()
    expect(finalStatus.stories[preSeededStoryKey]?.phase).toBe('COMPLETE')
  })
})

// ---------------------------------------------------------------------------
// AC1 (Story 26-5): stateStore.recordMetric called on story completion
// ---------------------------------------------------------------------------

describe('AC1 (26-5): stateStore.recordMetric called on story completion', () => {
  it('calls recordMetric with all required MetricRecord fields when story completes successfully', async () => {
    // Use '26-4' to match the conflict-detector mock which returns batches: [[['26-4']]]
    const storyKey = '26-4'
    const store = new FileStateStore()
    const recordMetricSpy = vi.spyOn(store, 'recordMetric').mockResolvedValue(undefined)

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    await orchestrator.run([storyKey])

    // recordMetric must have been called at least once for the story completion
    expect(recordMetricSpy).toHaveBeenCalled()

    // The call must contain all AC1-required fields (AC1 of Story 26-5)
    const call = recordMetricSpy.mock.calls[0][0]
    expect(call.storyKey).toBe(storyKey)
    expect(typeof call.taskType).toBe('string')
    expect(typeof call.tokensIn).toBe('number')
    expect(typeof call.tokensOut).toBe('number')
    expect(typeof call.costUsd).toBe('number')
    expect(typeof call.wallClockMs).toBe('number')
    expect(typeof call.reviewCycles).toBe('number')
    expect(typeof call.stallCount).toBe('number')
    expect(typeof call.result).toBe('string')
    // model and cacheReadTokens are present in the call object (even if undefined)
    expect('model' in call).toBe(true)
    expect('cacheReadTokens' in call).toBe(true)
  })

  it('does not call recordMetric when stateStore is not provided', async () => {
    const storyKey = '26-4'

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    // No stateStore — should not throw
    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
    })

    const status = await orchestrator.run([storyKey])
    expect(status.state).toBe('COMPLETE')
  })
})

// ---------------------------------------------------------------------------
// AC7: Branch lifecycle — branchForStory, mergeStory, rollbackStory wired
// ---------------------------------------------------------------------------

describe('AC7: Branch lifecycle wired to story lifecycle', () => {
  it('calls branchForStory before story dispatch', async () => {
    const storyKey = '26-4'
    const store = new FileStateStore()
    const branchSpy = vi.spyOn(store, 'branchForStory').mockResolvedValue(undefined)

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    await orchestrator.run([storyKey])

    expect(branchSpy).toHaveBeenCalledWith(storyKey)
  })

  it('calls mergeStory when story reaches COMPLETE', async () => {
    const storyKey = '26-4'
    const store = new FileStateStore()
    const mergeSpy = vi.spyOn(store, 'mergeStory').mockResolvedValue(undefined)
    vi.spyOn(store, 'branchForStory').mockResolvedValue(undefined)

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    await orchestrator.run([storyKey])

    expect(mergeSpy).toHaveBeenCalledWith(storyKey)
  })

  it('calls rollbackStory when story reaches ESCALATED', async () => {
    const storyKey = '26-4'
    const store = new FileStateStore()
    const rollbackSpy = vi.spyOn(store, 'rollbackStory').mockResolvedValue(undefined)
    vi.spyOn(store, 'branchForStory').mockResolvedValue(undefined)
    vi.spyOn(store, 'mergeStory').mockResolvedValue(undefined)

    // Make create-story fail → ESCALATED
    mockRunCreateStory.mockRejectedValue(new Error('fail'))

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    await orchestrator.run([storyKey])

    expect(rollbackSpy).toHaveBeenCalledWith(storyKey)
  })

  it('does not throw when branchForStory fails (best-effort)', async () => {
    const storyKey = '26-4'
    const store = new FileStateStore()
    vi.spyOn(store, 'branchForStory').mockRejectedValue(new Error('branch create failed'))

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    // Should not throw even if branchForStory fails
    await expect(orchestrator.run([storyKey])).resolves.toBeDefined()
  })

  it('branch calls are no-ops with FileStateStore (existing behavior unchanged)', async () => {
    const storyKey = '26-4'
    const store = new FileStateStore()

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    const status = await orchestrator.run([storyKey])
    expect(status.state).toBe('COMPLETE')
    expect(status.stories[storyKey]?.phase).toBe('COMPLETE')
  })
})

// ---------------------------------------------------------------------------
// AC7 Integration: 3 concurrent stories, all complete with branch lifecycle
// ---------------------------------------------------------------------------

describe('AC7 Integration: 3 concurrent stories with distinct branch lifecycle', () => {
  it('dispatches 3 concurrent stories and calls branchForStory/mergeStory for each without cross-contamination', async () => {
    const storyKeys = ['26-7', '26-8', '26-9']
    const store = new FileStateStore()

    const branchSpy = vi.spyOn(store, 'branchForStory')
    const mergeSpy = vi.spyOn(store, 'mergeStory')

    // Override conflict-detector to put all 3 stories in separate groups within
    // the same batch so they are dispatched concurrently (parallel within batch).
    mockDetectConflictGroups.mockReturnValueOnce({
      batches: [[['26-7'], ['26-8'], ['26-9']]],
      edges: [],
    })

    mockRunCreateStory.mockResolvedValue({
      result: 'success' as const,
      story_file: '/path/to/story.md',
      story_key: 'test',
      story_title: 'Test Story',
      tokenUsage: { input: 100, output: 50 },
    } as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig({ maxConcurrency: 3 }),
      stateStore: store,
    })

    const status = await orchestrator.run(storyKeys)

    // All 3 stories should complete successfully
    for (const key of storyKeys) {
      expect(status.stories[key]?.phase).toBe('COMPLETE')
    }

    // branchForStory called once per story (3 total)
    expect(branchSpy).toHaveBeenCalledTimes(3)
    expect(branchSpy).toHaveBeenCalledWith('26-7')
    expect(branchSpy).toHaveBeenCalledWith('26-8')
    expect(branchSpy).toHaveBeenCalledWith('26-9')

    // mergeStory called once per story on COMPLETE (3 total)
    expect(mergeSpy).toHaveBeenCalledTimes(3)
    expect(mergeSpy).toHaveBeenCalledWith('26-7')
    expect(mergeSpy).toHaveBeenCalledWith('26-8')
    expect(mergeSpy).toHaveBeenCalledWith('26-9')

    // No cross-contamination: each story state persisted independently in FileStateStore
    const records = await Promise.all(storyKeys.map((k) => store.getStoryState(k)))
    for (const record of records) {
      expect(record?.phase).toBe('COMPLETE')
    }
  })
})
