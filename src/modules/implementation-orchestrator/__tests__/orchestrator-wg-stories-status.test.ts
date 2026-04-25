// @vitest-environment node
/**
 * Tests for wg_stories status integration in the implementation orchestrator.
 *
 * Covers:
 *   AC5 — errors from wgRepo.updateStoryStatus() are caught at WARN and do NOT
 *          propagate to the pipeline caller (fire-and-forget contract)
 *   AC7 — the _wgInProgressWritten Set suppresses redundant in_progress writes
 *          when multiple active phases (IN_STORY_CREATION, IN_DEV, IN_REVIEW, …)
 *          pass through updateStory() for the same story key
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'
import { WorkGraphRepository } from '../../state/index.js'

// ---------------------------------------------------------------------------
// Hoisted shared mocks — accessible both inside vi.mock() factories and tests
// ---------------------------------------------------------------------------

const { mockWarnFn } = vi.hoisted(() => ({ mockWarnFn: vi.fn() }))

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
  createLogger: vi.fn().mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarnFn,
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
vi.mock('../seed-methodology-context.js', () => ({
  seedMethodologyContext: vi.fn().mockReturnValue({ decisionsCreated: 0, skippedCategories: [] }),
}))
vi.mock('../conflict-detector.js', () => ({
  detectConflictGroupsWithContracts: vi.fn().mockReturnValue({ batches: [[['31-4']]], edges: [] }),
}))
vi.mock('../contract-verifier.js', () => ({
  verifyContracts: vi.fn().mockReturnValue([]),
}))
vi.mock('../../compiled-workflows/interface-contracts.js', () => ({
  parseInterfaceContracts: vi.fn().mockReturnValue([]),
}))
vi.mock('../../compiled-workflows/story-complexity.js', () => ({
  computeStoryComplexity: vi.fn().mockReturnValue({ complexityScore: 5, taskCount: 2 }),
  resolveFixStoryMaxTurns: vi.fn().mockReturnValue(20),
  logComplexityResult: vi.fn(),
}))

// Mock @substrate-ai/sdlc so the Tier A verification pipeline always passes in unit tests (Story 51-5)
vi.mock('@substrate-ai/sdlc', () => ({
  createDefaultVerificationPipeline: vi.fn(() => ({
    run: vi.fn().mockImplementation((ctx: { storyKey: string }) =>
      Promise.resolve({
        storyKey: ctx.storyKey,
        checks: [],
        status: 'pass',
        duration_ms: 0,
      }),
    ),
    register: vi.fn(),
  })),
}))
// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock() calls
// ---------------------------------------------------------------------------

import { runCreateStory, isValidStoryFile } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { runTestPlan } from '../../compiled-workflows/test-plan.js'
import { getDecisionsByPhase, getDecisionsByCategory } from '../../../persistence/queries/decisions.js'
import { aggregateTokenUsageForRun, aggregateTokenUsageForStory } from '../../../persistence/queries/metrics.js'
import { analyzeStoryComplexity, planTaskBatches } from '../../compiled-workflows/index.js'
import { runTestExpansion } from '../../compiled-workflows/test-expansion.js'
import { runBuildVerification, checkGitDiffFiles } from '../../agent-dispatch/dispatcher-impl.js'
import { detectInterfaceChanges } from '../../agent-dispatch/interface-change-detector.js'
import { seedMethodologyContext } from '../seed-methodology-context.js'
import { detectConflictGroupsWithContracts } from '../conflict-detector.js'
import { verifyContracts } from '../contract-verifier.js'
import { parseInterfaceContracts } from '../../compiled-workflows/interface-contracts.js'
import { computeStoryComplexity, resolveFixStoryMaxTurns } from '../../compiled-workflows/story-complexity.js'
import { inspectProcessTree } from '../../../cli/commands/health.js'
import { createLogger } from '../../../utils/logger.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)
const mockIsValidStoryFile = vi.mocked(isValidStoryFile)
const mockGetDecisionsByPhase = vi.mocked(getDecisionsByPhase)
const mockGetDecisionsByCategory = vi.mocked(getDecisionsByCategory)
const mockAggregateTokenUsageForRun = vi.mocked(aggregateTokenUsageForRun)
const mockAggregateTokenUsageForStory = vi.mocked(aggregateTokenUsageForStory)

// ---------------------------------------------------------------------------
// Factory helpers (mirrors orchestrator-state-store.test.ts conventions)
// ---------------------------------------------------------------------------

const STORY_KEY = '31-4'

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

function makeCreateStorySuccess(storyKey = STORY_KEY) {
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
    tokenUsage: { input: 50, output: 20 },
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockIsValidStoryFile.mockResolvedValue({ valid: false, reason: 'no file' })
  mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess() as any)
  // Re-apply return values cleared by vi.restoreAllMocks() in afterEach.
  // In Vitest 2.x, restoreAllMocks() resets ALL mock implementations (not just spies).
  mockGetDecisionsByPhase.mockReturnValue([] as any)
  mockGetDecisionsByCategory.mockReturnValue([] as any)
  mockAggregateTokenUsageForRun.mockReturnValue({ input: 0, output: 0, cost: 0 } as any)
  mockAggregateTokenUsageForStory.mockReturnValue({ input: 0, output: 0, cost: 0 } as any)
  vi.mocked(analyzeStoryComplexity).mockReturnValue({ estimatedScope: 'small', taskCount: 2, complexity: 'simple', reason: 'test' } as any)
  vi.mocked(planTaskBatches).mockReturnValue([] as any)
  vi.mocked(runTestExpansion).mockResolvedValue({ expansion_priority: 'low', coverage_gaps: [], recommended_tests: [], rationale: 'mock' } as any)
  vi.mocked(runBuildVerification).mockReturnValue({ status: 'passed', exitCode: 0 } as any)
  vi.mocked(checkGitDiffFiles).mockReturnValue(['src/some-modified-file.ts'] as any)
  vi.mocked(detectInterfaceChanges).mockReturnValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] } as any)
  vi.mocked(seedMethodologyContext).mockReturnValue({ decisionsCreated: 0, skippedCategories: [] } as any)
  vi.mocked(detectConflictGroupsWithContracts).mockReturnValue({ batches: [[['31-4']]], edges: [] } as any)
  vi.mocked(verifyContracts).mockReturnValue([] as any)
  vi.mocked(parseInterfaceContracts).mockReturnValue([] as any)
  vi.mocked(computeStoryComplexity).mockReturnValue({ complexityScore: 5, taskCount: 2 } as any)
  vi.mocked(resolveFixStoryMaxTurns).mockReturnValue(20 as any)
  vi.mocked(inspectProcessTree).mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] } as any)
  vi.mocked(createLogger).mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarnFn,
    error: vi.fn(),
  }) as any)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// AC5: errors from wgRepo.updateStoryStatus() are caught and do NOT propagate
// ---------------------------------------------------------------------------

describe('AC5: wgRepo.updateStoryStatus() errors are caught (fire-and-forget contract)', () => {
  it('run() resolves normally when updateStoryStatus rejects — error does not propagate', async () => {
    // Arrange: make updateStoryStatus always reject
    const spy = vi.spyOn(WorkGraphRepository.prototype, 'updateStoryStatus').mockRejectedValue(
      new Error('DB connection failed'),
    )

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess() as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
    })

    // Act: run must resolve — not throw — despite updateStoryStatus rejecting
    const status = await orchestrator.run([STORY_KEY])

    // Assert: pipeline completed normally
    expect(status.state).toBe('COMPLETE')
    expect(status.stories[STORY_KEY]?.phase).toBe('COMPLETE')

    // The spy was called, confirming the error path was exercised
    expect(spy).toHaveBeenCalled()
  })

  it('logger.warn is called with the expected message when updateStoryStatus rejects', async () => {
    // Arrange
    vi.spyOn(WorkGraphRepository.prototype, 'updateStoryStatus').mockRejectedValue(
      new Error('DB connection failed'),
    )

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess() as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
    })

    // Act
    await orchestrator.run([STORY_KEY])

    // The fire-and-forget .catch() runs as a microtask; flush remaining microtasks
    // so the logger.warn call is guaranteed to have run before we assert.
    await Promise.resolve()

    // Assert: warn logged with the correct message (AC5 explicit contract)
    expect(mockWarnFn).toHaveBeenCalledWith(
      expect.objectContaining({ storyKey: STORY_KEY }),
      'wg_stories status update failed (best-effort)',
    )
  })
})

// ---------------------------------------------------------------------------
// AC7: _wgInProgressWritten Set suppresses redundant in_progress writes
// ---------------------------------------------------------------------------

describe('AC7: redundant in_progress writes are suppressed via _wgInProgressWritten Set', () => {
  it('updateStoryStatus is called with in_progress exactly once even when multiple active phases are traversed', async () => {
    // Arrange: spy resolves so all calls succeed; count in_progress calls
    const inProgressCalls: string[] = []
    vi.spyOn(WorkGraphRepository.prototype, 'updateStoryStatus').mockImplementation(
      async (storyKey, status) => {
        if (status === 'in_progress') inProgressCalls.push(storyKey as string)
        return undefined
      },
    )

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess() as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
    })

    // Act: full successful run traverses IN_STORY_CREATION → IN_TEST_PLANNING →
    // IN_DEV → IN_REVIEW → COMPLETE — all active phases map to 'in_progress',
    // but the dedup Set must suppress every write after the first.
    await orchestrator.run([STORY_KEY])

    // Assert: in_progress written exactly once for this story key
    const storyInProgressCalls = inProgressCalls.filter((k) => k === STORY_KEY)
    expect(storyInProgressCalls).toHaveLength(1)
  })

  it('updateStoryStatus is still called with complete after the in_progress dedup is active', async () => {
    // Arrange: capture all calls by status
    const callsByStatus: Record<string, string[]> = { in_progress: [], complete: [], escalated: [] }
    vi.spyOn(WorkGraphRepository.prototype, 'updateStoryStatus').mockImplementation(
      async (storyKey, status) => {
        const key = status as string
        if (key in callsByStatus) callsByStatus[key]!.push(storyKey as string)
        return undefined
      },
    )

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess() as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
    })

    // Act
    await orchestrator.run([STORY_KEY])

    // Assert: dedup only applies to in_progress — complete is still written once
    expect(callsByStatus['in_progress']!.filter((k) => k === STORY_KEY)).toHaveLength(1)
    expect(callsByStatus['complete']!.filter((k) => k === STORY_KEY)).toHaveLength(1)
    expect(callsByStatus['escalated']!.filter((k) => k === STORY_KEY)).toHaveLength(0)
  })
})
