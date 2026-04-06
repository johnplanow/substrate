// @vitest-environment node
/**
 * Tests for Story 31-6: Contract Detector Writes Dependencies to story_dependencies.
 *
 * Covers the orchestrator wiring:
 *   AC5 — addContractDependencies() is called fire-and-forget after detectConflictGroupsWithContracts()
 *         returns a non-empty edges array; the existing batch dispatch loop is unchanged.
 *   AC6 — a rejection from addContractDependencies() is caught and logged at WARN level;
 *         the pipeline continues and no story execution is affected.
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
// Hoisted shared mocks
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
  detectConflictGroupsWithContracts: vi.fn().mockReturnValue({ batches: [[['31-6-test']]], edges: [] }),
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
import { runTestExpansion } from '../../compiled-workflows/test-expansion.js'
import { analyzeStoryComplexity, planTaskBatches } from '../../compiled-workflows/index.js'
import { getDecisionsByPhase, getDecisionsByCategory } from '../../../persistence/queries/decisions.js'
import { aggregateTokenUsageForRun, aggregateTokenUsageForStory } from '../../../persistence/queries/metrics.js'
import { detectConflictGroupsWithContracts } from '../conflict-detector.js'
import { verifyContracts } from '../contract-verifier.js'
import { parseInterfaceContracts } from '../../compiled-workflows/interface-contracts.js'
import { computeStoryComplexity, resolveFixStoryMaxTurns } from '../../compiled-workflows/story-complexity.js'
import { runBuildVerification, checkGitDiffFiles } from '../../agent-dispatch/dispatcher-impl.js'
import { detectInterfaceChanges } from '../../agent-dispatch/interface-change-detector.js'
import { seedMethodologyContext } from '../seed-methodology-context.js'
import { inspectProcessTree } from '../../../cli/commands/health.js'
import { createLogger } from '../../../utils/logger.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)
const mockIsValidStoryFile = vi.mocked(isValidStoryFile)
const mockDetectConflictGroupsWithContracts = vi.mocked(detectConflictGroupsWithContracts)
const mockGetDecisionsByCategory = vi.mocked(getDecisionsByCategory)
const mockGetDecisionsByPhase = vi.mocked(getDecisionsByPhase)

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

const STORY_KEY = '31-6-test'

const MOCK_EDGES = [
  { from: '31-1', to: '31-2', reason: '31-1 exports FooSchema, 31-2 imports it' },
]

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

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // Re-apply ALL mock return values after vi.restoreAllMocks() may have cleared them.
  // This matches the pattern in orchestrator-wg-stories-status.test.ts.
  mockIsValidStoryFile.mockResolvedValue({ valid: false, reason: 'no file' } as any)
  mockRunTestPlan.mockResolvedValue({
    result: 'success' as const,
    test_files: [],
    test_categories: [],
    coverage_notes: '',
    tokenUsage: { input: 50, output: 20 },
  } as any)
  mockGetDecisionsByPhase.mockReturnValue([] as any)
  mockGetDecisionsByCategory.mockReturnValue([] as any)
  vi.mocked(aggregateTokenUsageForRun).mockReturnValue({ input: 0, output: 0, cost: 0 } as any)
  vi.mocked(aggregateTokenUsageForStory).mockReturnValue({ input: 0, output: 0, cost: 0 } as any)
  vi.mocked(analyzeStoryComplexity).mockReturnValue({ estimatedScope: 'small', taskCount: 2, complexity: 'simple', reason: 'test' } as any)
  vi.mocked(planTaskBatches).mockReturnValue([] as any)
  vi.mocked(runTestExpansion).mockResolvedValue({ expansion_priority: 'low', coverage_gaps: [], recommended_tests: [], rationale: 'mock' } as any)
  vi.mocked(runBuildVerification).mockReturnValue({ status: 'passed', exitCode: 0 } as any)
  vi.mocked(checkGitDiffFiles).mockReturnValue(['src/some-modified-file.ts'] as any)
  vi.mocked(detectInterfaceChanges).mockReturnValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] } as any)
  vi.mocked(seedMethodologyContext).mockReturnValue({ decisionsCreated: 0, skippedCategories: [] } as any)
  // Default: no contract edges (will be overridden per test)
  mockDetectConflictGroupsWithContracts.mockReturnValue({ batches: [[[STORY_KEY]]], edges: [] } as any)
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
// AC5: addContractDependencies() is called fire-and-forget after detection
// ---------------------------------------------------------------------------

describe('Story 31-6 AC5: addContractDependencies() called after contract detection', () => {
  it('calls addContractDependencies with the detected edges array', async () => {
    // Arrange: mock detectConflictGroupsWithContracts to return non-empty edges
    mockDetectConflictGroupsWithContracts.mockReturnValue({
      batches: [[[STORY_KEY]]],
      edges: MOCK_EDGES,
    } as any)

    const spy = vi.spyOn(WorkGraphRepository.prototype, 'addContractDependencies').mockResolvedValue(undefined)

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

    await orchestrator.run([STORY_KEY])

    // AC5: spy must have been called exactly once with the edges array
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(MOCK_EDGES)
  })

  it('still calls addContractDependencies with empty array when no edges detected (AC4 early-return path)', async () => {
    // Arrange: default mock returns empty edges
    mockDetectConflictGroupsWithContracts.mockReturnValue({
      batches: [[[STORY_KEY]]],
      edges: [],
    } as any)

    const spy = vi.spyOn(WorkGraphRepository.prototype, 'addContractDependencies').mockResolvedValue(undefined)

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

    await orchestrator.run([STORY_KEY])

    // The orchestrator unconditionally calls addContractDependencies.
    // When edges is empty, the method returns early (AC4) — so the call is a no-op.
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith([])
  })

  it('dispatch batch loop executes normally — existing ordering is preserved', async () => {
    mockDetectConflictGroupsWithContracts.mockReturnValue({
      batches: [[[STORY_KEY]]],
      edges: MOCK_EDGES,
    } as any)

    vi.spyOn(WorkGraphRepository.prototype, 'addContractDependencies').mockResolvedValue(undefined)

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

    const status = await orchestrator.run([STORY_KEY])

    // The pipeline should complete normally — batch loop unchanged by fire-and-forget
    expect(status.state).toBe('COMPLETE')
    expect(status.stories[STORY_KEY]?.phase).toBe('COMPLETE')
  })
})

// ---------------------------------------------------------------------------
// AC6: rejection from addContractDependencies() is suppressed (non-fatal)
// ---------------------------------------------------------------------------

describe('Story 31-6 AC6: addContractDependencies() errors are suppressed', () => {
  it('run() resolves normally when addContractDependencies rejects', async () => {
    mockDetectConflictGroupsWithContracts.mockReturnValue({
      batches: [[[STORY_KEY]]],
      edges: MOCK_EDGES,
    } as any)

    vi.spyOn(WorkGraphRepository.prototype, 'addContractDependencies').mockRejectedValue(
      new Error('DB write failed'),
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

    // AC6: run() must resolve — rejection must NOT propagate
    const status = await orchestrator.run([STORY_KEY])
    expect(status.state).toBe('COMPLETE')
  })

  it('logs a WARN when addContractDependencies rejects', async () => {
    mockDetectConflictGroupsWithContracts.mockReturnValue({
      batches: [[[STORY_KEY]]],
      edges: MOCK_EDGES,
    } as any)

    vi.spyOn(WorkGraphRepository.prototype, 'addContractDependencies').mockRejectedValue(
      new Error('DB write failed'),
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

    await orchestrator.run([STORY_KEY])

    // Allow microtasks from the fire-and-forget .catch() to settle
    await Promise.resolve()

    const warnCalls = mockWarnFn.mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('contract dep persistence'),
    )
    expect(warnCalls.length).toBeGreaterThan(0)
  })
})
