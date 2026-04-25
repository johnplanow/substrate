/**
 * Integration tests for Story 25-5: Contract-Aware Dispatch Ordering.
 *
 * Verifies that the orchestrator:
 *   AC5: Logs contract dependency edges as structured events when they are detected
 *   AC1–AC4: Uses contract declarations from the decision store to influence dispatch ordering
 *
 * Note: The ordering behaviour (batch assignment) is primarily tested via pure unit tests
 * in contract-ordering.test.ts. This file tests the orchestrator wiring:
 *   - getDecisionsByCategory('interface-contract') is called at run() start
 *   - Dependency edges are logged via logger.info when found
 *   - No regression when no contract declarations exist
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'

// ---------------------------------------------------------------------------
// Shared mock logger instance — hoisted so it's available inside vi.mock()
// ---------------------------------------------------------------------------

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock compiled workflow functions
// ---------------------------------------------------------------------------

vi.mock('../../compiled-workflows/create-story.js', () => ({
  runCreateStory: vi.fn(),
  isValidStoryFile: vi.fn().mockResolvedValue({ valid: false, reason: 'missing_structure' }),
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

// ---------------------------------------------------------------------------
// Mock persistence queries
// ---------------------------------------------------------------------------

vi.mock('../../../persistence/queries/decisions.js', () => ({
  updatePipelineRun: vi.fn(),
  addTokenUsage: vi.fn().mockResolvedValue(undefined),
  getDecisionsByPhase: vi.fn().mockReturnValue([]),
  getDecisionsByCategory: vi.fn().mockReturnValue([]),
  registerArtifact: vi.fn(),
  createDecision: vi.fn().mockReturnValue({
    id: 'decision-uuid',
    pipeline_run_id: 'test-run-id',
    phase: 'implementation',
    category: 'interface-contract',
    key: 'test-key',
    value: '{}',
    rationale: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }),
}))

vi.mock('../../../persistence/queries/metrics.js', () => ({
  writeRunMetrics: vi.fn(),
  writeStoryMetrics: vi.fn(),
  aggregateTokenUsageForRun: vi.fn().mockReturnValue({ input: 0, output: 0, cost: 0 }),
  aggregateTokenUsageForStory: vi.fn().mockReturnValue({ input: 0, output: 0, cost: 0 }),
}))

// Shared logger mock — returned for all createLogger() calls
vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => mockLogger),
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

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { runTestPlan } from '../../compiled-workflows/test-plan.js'
import { getDecisionsByCategory } from '../../../persistence/queries/decisions.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)
const mockGetDecisionsByCategory = vi.mocked(getDecisionsByCategory)

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
    ...overrides,
  }
}

function makeCreateStorySuccess(storyKey = 'test-story', filePath?: string) {
  return {
    result: 'success' as const,
    story_file: filePath ?? `/path/to/${storyKey}.md`,
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

/** Build a mock Decision row for an interface-contract declaration */
function makeContractDecision(
  storyKey: string,
  schemaName: string,
  direction: 'export' | 'import',
  filePath = 'src/types.ts',
  transport?: string,
) {
  return {
    id: `decision-${storyKey}-${schemaName}`,
    pipeline_run_id: 'test-run-id',
    phase: 'implementation',
    category: 'interface-contract',
    key: `${storyKey}:${schemaName}`,
    value: JSON.stringify({
      direction,
      schemaName,
      filePath,
      storyKey,
      ...(transport !== undefined ? { transport } : {}),
    }),
    rationale: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AC5: orchestrator logs contract dependency edges when detected', () => {
  let db: DatabaseAdapter
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

    mockRunTestPlan.mockResolvedValue({
      result: 'success' as const,
      test_files: [],
      test_categories: [],
      coverage_notes: '',
      tokenUsage: { input: 50, output: 20 },
    })
  })

  it('calls getDecisionsByCategory with interface-contract at run() start', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-5'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({ db, pack, contextCompiler, dispatcher, eventBus, config })
    await orchestrator.run(['25-5'])

    expect(mockGetDecisionsByCategory).toHaveBeenCalledWith(db, 'interface-contract')
  })

  it('does NOT log contract edge message when no interface-contract declarations exist', async () => {
    mockGetDecisionsByCategory.mockReturnValue([])

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-5'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({ db, pack, contextCompiler, dispatcher, eventBus, config })
    await orchestrator.run(['25-5'])

    const contractEdgeLogCalls = mockLogger.info.mock.calls.filter(
      (call) =>
        typeof call[1] === 'string' && call[1].includes('Contract dependency edges'),
    )
    expect(contractEdgeLogCalls).toHaveLength(0)
  })

  it('logs contract dependency edges when exporter/importer contract declarations exist (AC5)', async () => {
    // Set up: story A exports FooSchema, story B imports FooSchema
    const contractDecisions = [
      makeContractDecision('A', 'FooSchema', 'export'),
      makeContractDecision('B', 'FooSchema', 'import'),
    ]
    mockGetDecisionsByCategory.mockImplementation((_, category) => {
      if (category === 'interface-contract') return contractDecisions
      return []
    })

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('A'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({ db, pack, contextCompiler, dispatcher, eventBus, config })
    await orchestrator.run(['A', 'B'])

    // AC5: logger.info should be called with contractEdges information
    const contractEdgeLogCall = mockLogger.info.mock.calls.find(
      (call) => {
        const msg = call[1]
        return typeof msg === 'string' && msg.includes('Contract dependency edges')
      },
    )
    expect(contractEdgeLogCall).toBeDefined()

    // Verify the structured data includes the edge
    const logData = contractEdgeLogCall![0] as Record<string, unknown>
    expect(logData).toHaveProperty('contractEdges')
    expect(logData).toHaveProperty('edgeCount', 1)

    const edges = logData.contractEdges as Array<{ from: string; to: string; contractName: string }>
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ from: 'A', to: 'B', contractName: 'FooSchema' })
  })

  it('logs contract dependency edges for dual-export serialization (AC3+AC5)', async () => {
    // Both A and B export BarSchema
    const contractDecisions = [
      makeContractDecision('A', 'BarSchema', 'export'),
      makeContractDecision('B', 'BarSchema', 'export'),
    ]
    mockGetDecisionsByCategory.mockImplementation((_, category) => {
      if (category === 'interface-contract') return contractDecisions
      return []
    })

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('A'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({ db, pack, contextCompiler, dispatcher, eventBus, config })
    await orchestrator.run(['A', 'B'])

    const contractEdgeLogCall = mockLogger.info.mock.calls.find(
      (call) => {
        const msg = call[1]
        return typeof msg === 'string' && msg.includes('Contract dependency edges')
      },
    )
    expect(contractEdgeLogCall).toBeDefined()
    const logData = contractEdgeLogCall![0] as Record<string, unknown>
    expect(logData).toHaveProperty('edgeCount', 1)
  })

  it('pipeline completes successfully even with contract declarations (no regression)', async () => {
    const contractDecisions = [
      makeContractDecision('25-5', 'SomeSchema', 'export'),
    ]
    mockGetDecisionsByCategory.mockImplementation((_, category) => {
      if (category === 'interface-contract') return contractDecisions
      return []
    })

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-5'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({ db, pack, contextCompiler, dispatcher, eventBus, config })
    const status = await orchestrator.run(['25-5'])

    expect(status.state).toBe('COMPLETE')
    expect(status.stories['25-5']?.phase).toBe('COMPLETE')
  })

  it('pipeline completes successfully with malformed contract decision value (graceful degradation)', async () => {
    // Malformed JSON in the decision value
    mockGetDecisionsByCategory.mockImplementation((_, category) => {
      if (category === 'interface-contract') {
        return [{
          id: 'bad-decision',
          pipeline_run_id: 'test-run-id',
          phase: 'implementation',
          category: 'interface-contract',
          key: 'bad:schema',
          value: 'NOT VALID JSON',
          rationale: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }]
      }
      return []
    })

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-5'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({ db, pack, contextCompiler, dispatcher, eventBus, config })
    const status = await orchestrator.run(['25-5'])

    // Should complete without error despite malformed contract data
    expect(status.state).toBe('COMPLETE')
  })
})
