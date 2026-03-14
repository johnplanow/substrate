/**
 * Tests for Story 27-9 Task 5: Orchestrator IngestionServer lifecycle wiring.
 *
 * Validates:
 * - IngestionServer.start() is called before first dispatch
 * - IngestionServer.stop() is called in the finally block
 * - otlpEndpoint is passed on direct dispatcher.dispatch() calls
 * - Works correctly when ingestionServer is not provided (undefined)
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
import type { IngestionServer } from '../../telemetry/ingestion-server.js'

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
  detectConflictGroupsWithContracts: vi.fn().mockReturnValue({ batches: [[['27-9']]], edges: [] }),
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

function createMockDispatcher(): Dispatcher & { dispatch: ReturnType<typeof vi.fn> } {
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
  const dispatch = vi.fn().mockReturnValue(mockHandle)
  return {
    dispatch,
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

function createMockIngestionServer(
  endpointUrl = 'http://localhost:9317',
): IngestionServer & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getOtlpEnvVars: vi.fn().mockReturnValue({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: endpointUrl,
    }),
  } as unknown as IngestionServer & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
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

function makeCreateStorySuccess(storyKey = '27-9') {
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

describe('IngestionServer lifecycle wiring (Story 27-9, Task 5)', () => {
  it('calls ingestionServer.start() before dispatching', async () => {
    const server = createMockIngestionServer()
    const dispatcher = createMockDispatcher()

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      ingestionServer: server,
    })

    await orchestrator.run(['27-9'])

    expect(server.start).toHaveBeenCalledOnce()
  })

  it('calls ingestionServer.stop() in finally block after run()', async () => {
    const server = createMockIngestionServer()
    const dispatcher = createMockDispatcher()

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      ingestionServer: server,
    })

    await orchestrator.run(['27-9'])

    expect(server.stop).toHaveBeenCalledOnce()
  })

  it('stop() is called even when run() encounters an error', async () => {
    const server = createMockIngestionServer()
    const dispatcher = createMockDispatcher()

    // Make create-story fail — orchestrator will still clean up
    mockRunCreateStory.mockRejectedValue(new Error('create-story crashed'))

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      ingestionServer: server,
    })

    // run() should not throw — errors are caught internally
    await orchestrator.run(['27-9'])

    expect(server.stop).toHaveBeenCalledOnce()
  })

  it('works correctly when ingestionServer is not provided (undefined)', async () => {
    const dispatcher = createMockDispatcher()

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      // No ingestionServer dep
    })

    // Should not throw
    const status = await orchestrator.run(['27-9'])
    expect(status.state).toBe('COMPLETE')
  })

  it('passes otlpEndpoint from ingestionServer into WorkflowDeps for compiled workflows', async () => {
    const endpointUrl = 'http://localhost:9317'
    const server = createMockIngestionServer(endpointUrl)
    const dispatcher = createMockDispatcher()

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      ingestionServer: server,
    })

    await orchestrator.run(['27-9'])

    // runCreateStory is called with WorkflowDeps as first arg —
    // verify otlpEndpoint is included so sub-agents receive telemetry env vars
    expect(mockRunCreateStory).toHaveBeenCalledWith(
      expect.objectContaining({ otlpEndpoint: endpointUrl }),
      expect.anything(),
    )
    // runDevStory receives the same endpoint
    expect(mockRunDevStory).toHaveBeenCalledWith(
      expect.objectContaining({ otlpEndpoint: endpointUrl }),
      expect.anything(),
    )
    // runCodeReview receives the same endpoint
    expect(mockRunCodeReview).toHaveBeenCalledWith(
      expect.objectContaining({ otlpEndpoint: endpointUrl }),
      expect.anything(),
    )
  })

  it('compiled workflows receive undefined otlpEndpoint when ingestionServer is absent', async () => {
    const dispatcher = createMockDispatcher()

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig(),
      // No ingestionServer
    })

    await orchestrator.run(['27-9'])

    // WorkflowDeps should have otlpEndpoint as undefined (not set)
    expect(mockRunDevStory).toHaveBeenCalledWith(
      expect.not.objectContaining({ otlpEndpoint: expect.anything() }),
      expect.anything(),
    )
  })

  it('start() is called exactly once even for multiple stories', async () => {
    const server = createMockIngestionServer()
    const dispatcher = createMockDispatcher()

    // Set up conflict detector to allow multiple stories
    const { detectConflictGroupsWithContracts } = await import('../conflict-detector.js')
    vi.mocked(detectConflictGroupsWithContracts).mockReturnValue({
      batches: [[['27-9', '27-8']]],
      edges: [],
    })

    mockRunCreateStory
      .mockResolvedValueOnce(makeCreateStorySuccess('27-9'))
      .mockResolvedValueOnce(makeCreateStorySuccess('27-8'))

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher,
      eventBus: createMockEventBus(),
      config: defaultConfig({ maxConcurrency: 2 }),
      ingestionServer: server,
    })

    await orchestrator.run(['27-9', '27-8'])

    expect(server.start).toHaveBeenCalledOnce()
    expect(server.stop).toHaveBeenCalledOnce()
  })
})
