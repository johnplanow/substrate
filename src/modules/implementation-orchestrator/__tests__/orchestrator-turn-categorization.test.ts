/**
 * Tests for Story 27-16: Category/Consumer Stats from Turn Analysis.
 *
 * Validates that the orchestrator post-SHIP_IT path:
 * - Calls storeCategoryStats() and storeConsumerStats() when turn analysis data exists
 * - Skips categorization gracefully when no turns exist (AC4)
 * - The TODO(27-3) hardcoded-empty-spans path is eliminated (AC3)
 *
 * Uses vi.mock to avoid real subprocess spawning and DB access.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'
import type { ITelemetryPersistence } from '../../telemetry/index.js'
import type { TurnAnalysis } from '../../telemetry/types.js'

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
    trace: vi.fn(),
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
  checkGitDiffFiles: vi.fn().mockReturnValue(['src/foo.ts']),
}))
vi.mock('../../agent-dispatch/interface-change-detector.js', () => ({
  detectInterfaceChanges: vi.fn().mockReturnValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] }),
}))
vi.mock('../seed-methodology-context.js', () => ({
  seedMethodologyContext: vi.fn().mockReturnValue({ decisionsCreated: 0, skippedCategories: [] }),
}))
vi.mock('../conflict-detector.js', () => ({
  detectConflictGroupsWithContracts: vi.fn().mockReturnValue({ batches: [[['27-16']]], edges: [] }),
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

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)
const mockIsValidStoryFile = vi.mocked(isValidStoryFile)

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
    ...overrides,
  }
}

function makeTurnAnalysis(overrides: Partial<TurnAnalysis> = {}): TurnAnalysis {
  return {
    spanId: 'turn-span-1',
    turnNumber: 1,
    name: 'assistant_turn',
    timestamp: 1000,
    source: 'claude-code',
    model: 'claude-sonnet',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    freshTokens: 1000,
    cacheHitRate: 0,
    costUsd: 0.001,
    durationMs: 1000,
    contextSize: 1000,
    contextDelta: 1000,
    isContextSpike: false,
    childSpans: [],
    ...overrides,
  }
}

function createMockTelemetryPersistence(): ITelemetryPersistence {
  return {
    storeTurnAnalysis: vi.fn().mockResolvedValue(undefined),
    getTurnAnalysis: vi.fn().mockResolvedValue([]),
    storeEfficiencyScore: vi.fn().mockResolvedValue(undefined),
    getEfficiencyScore: vi.fn().mockResolvedValue(null),
    getEfficiencyScores: vi.fn().mockResolvedValue([]),
    saveRecommendations: vi.fn().mockResolvedValue(undefined),
    getRecommendations: vi.fn().mockResolvedValue([]),
    getAllRecommendations: vi.fn().mockResolvedValue([]),
    storeCategoryStats: vi.fn().mockResolvedValue(undefined),
    getCategoryStats: vi.fn().mockResolvedValue([]),
    storeConsumerStats: vi.fn().mockResolvedValue(undefined),
    getConsumerStats: vi.fn().mockResolvedValue([]),
    recordSpan: vi.fn().mockResolvedValue(undefined),
    purgeStoryTelemetry: vi.fn(async () => {}),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as ITelemetryPersistence
}

// ---------------------------------------------------------------------------
// Workflow result factories
// ---------------------------------------------------------------------------

function makeCreateStorySuccess(storyKey = '27-16') {
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
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockIsValidStoryFile.mockResolvedValue({ valid: false, reason: 'no existing file' })
  mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess())
  mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
  mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
  mockRunTestPlan.mockResolvedValue({ plan: [], rationale: '' })
})

describe('Turn-based categorization (Story 27-16)', () => {
  it('calls storeCategoryStats() and storeConsumerStats() when turn analysis data exists', async () => {
    const telemetryPersistence = createMockTelemetryPersistence()
    const turns = [makeTurnAnalysis({ spanId: 'turn-1', model: 'claude-sonnet', inputTokens: 1000, outputTokens: 500 })]
    vi.mocked(telemetryPersistence.getTurnAnalysis).mockResolvedValue(turns)

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      telemetryPersistence,
    })

    await orchestrator.run(['27-16'])

    expect(telemetryPersistence.storeCategoryStats).toHaveBeenCalledOnce()
    expect(telemetryPersistence.storeConsumerStats).toHaveBeenCalledOnce()
  })

  it('skips storeCategoryStats() and storeConsumerStats() when no turn analysis data exists (AC4)', async () => {
    const telemetryPersistence = createMockTelemetryPersistence()
    vi.mocked(telemetryPersistence.getTurnAnalysis).mockResolvedValue([]) // empty turns

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      telemetryPersistence,
    })

    await orchestrator.run(['27-16'])

    expect(telemetryPersistence.storeCategoryStats).not.toHaveBeenCalled()
    expect(telemetryPersistence.storeConsumerStats).not.toHaveBeenCalled()
  })

  it('does not crash when telemetryPersistence is not provided', async () => {
    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      // no telemetryPersistence
    })

    const status = await orchestrator.run(['27-16'])
    expect(status.state).toBe('COMPLETE')
  })

  it('does not crash (non-blocking) when storeCategoryStats() throws', async () => {
    const telemetryPersistence = createMockTelemetryPersistence()
    const turns = [makeTurnAnalysis()]
    vi.mocked(telemetryPersistence.getTurnAnalysis).mockResolvedValue(turns)
    vi.mocked(telemetryPersistence.storeCategoryStats).mockRejectedValue(new Error('DB error'))

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      telemetryPersistence,
    })

    // Should complete without throwing despite DB error (telemetry is non-blocking)
    const status = await orchestrator.run(['27-16'])
    expect(status.state).toBe('COMPLETE')
  })
})
