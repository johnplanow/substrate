/**
 * Integration tests for Story 25-6: Post-Sprint Contract Verification Gate.
 *
 * Tests the end-to-end flow from orchestrator.run() through contract
 * verification and event emission.
 *
 * Covers:
 *   AC1: Orchestrator runs verification after all stories complete
 *   AC4: pipeline:contract-mismatch events are emitted for failures
 *   AC5: Failures are surfaced in the pipeline status (contractMismatches field)
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
// Module mocks — must appear before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../compiled-workflows/create-story.js', () => ({
  runCreateStory: vi.fn(),
  isValidStoryFile: vi.fn().mockReturnValue(true),
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
}))
vi.mock('../../../cli/commands/health.js', () => ({
  inspectProcessTree: vi.fn().mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))
vi.mock('../../agent-dispatch/dispatcher-impl.js', () => ({
  runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
  checkGitDiffFiles: vi.fn().mockReturnValue(['src/some-modified-file.ts']),
  detectPackageManager: vi.fn().mockReturnValue({ packageManager: 'npm', lockfile: null, command: 'npm run build' }),
}))
vi.mock('../../agent-dispatch/interface-change-detector.js', () => ({
  detectInterfaceChanges: vi.fn().mockReturnValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] }),
}))
vi.mock('../contract-verifier.js', () => ({
  verifyContracts: vi.fn().mockReturnValue([]),
}))

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { getDecisionsByCategory } from '../../../persistence/queries/decisions.js'
import { existsSync } from 'node:fs'
import { verifyContracts } from '../contract-verifier.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockGetDecisionsByCategory = vi.mocked(getDecisionsByCategory)
const mockExistsSync = vi.mocked(existsSync)
const mockVerifyContracts = vi.mocked(verifyContracts)

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
    pipelineRunId: 'test-run-contract-verification',
    gcPauseMs: 0,
    skipPreflight: true, // skip preflight to focus tests on contract verification
    ...overrides,
  }
}

function makeCreateStorySuccess(storyKey = '25-6') {
  return {
    result: 'success' as const,
    story_file: `/path/to/${storyKey}.md`,
    story_key: storyKey,
    story_title: 'Contract Verification Story',
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

function makeContractMismatch(overrides?: object) {
  return {
    exporter: '25-6',
    importer: '25-6',
    contractName: 'JudgeResult',
    mismatchDescription: 'Exported file not found: src/judge/types.ts',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests: AC1 — Orchestrator runs verification after all stories complete
// ---------------------------------------------------------------------------

describe('orchestrator: post-sprint contract verification (Story 25-6)', () => {
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

    // Default: stories succeed
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess())
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    // Default: no contract declarations in decision store
    mockGetDecisionsByCategory.mockReturnValue([])

    // Default: existsSync returns false (no files on disk)
    mockExistsSync.mockReturnValue(false)

    // Default: verifyContracts returns no mismatches
    mockVerifyContracts.mockReturnValue([])
  })

  // ---------------------------------------------------------------------------
  // AC1: Verification runs after all stories complete
  // ---------------------------------------------------------------------------

  it('AC1: verifyContracts is called after stories complete when projectRoot provided and declarations exist', async () => {
    // Simulate a contract declaration in the decision store
    // storyKey must match a key passed to run() (stale-filtering prunes non-current-sprint declarations)
    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'dec-1',
        category: 'interface-contract',
        key: 'JudgeResult',
        value: JSON.stringify({
          storyKey: '25-6',
          schemaName: 'JudgeResult',
          direction: 'export',
          filePath: 'src/judge/types.ts',
        }),
        phase: 'create-story',
        storyKey: '25-6',
        createdAt: new Date().toISOString(),
      },
    ])

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
      projectRoot: '/project',
    })

    await orchestrator.run(['25-6'])

    // verifyContracts must have been called
    expect(mockVerifyContracts).toHaveBeenCalledOnce()
    // With projectRoot
    expect(mockVerifyContracts).toHaveBeenCalledWith(
      expect.any(Array),
      '/project',
    )
  })

  it('AC1: verifyContracts is NOT called when no projectRoot provided', async () => {
    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'dec-1',
        category: 'interface-contract',
        key: 'JudgeResult',
        value: JSON.stringify({
          storyKey: '25-6',
          schemaName: 'JudgeResult',
          direction: 'export',
          filePath: 'src/judge/types.ts',
        }),
        phase: 'create-story',
        storyKey: '25-6',
        createdAt: new Date().toISOString(),
      },
    ])

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
      // No projectRoot
    })

    await orchestrator.run(['25-6'])

    // verifyContracts should NOT be called (no projectRoot)
    expect(mockVerifyContracts).not.toHaveBeenCalled()
  })

  it('AC1: verifyContracts is NOT called when no contract declarations exist', async () => {
    // No declarations in decision store (default: empty array)
    mockGetDecisionsByCategory.mockReturnValue([])

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
      projectRoot: '/project',
    })

    await orchestrator.run(['25-6'])

    // verifyContracts not called since contractDeclarations.length === 0
    expect(mockVerifyContracts).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // AC4: pipeline:contract-mismatch events are emitted for failures
  // ---------------------------------------------------------------------------

  it('AC4: pipeline:contract-mismatch is emitted for each mismatch found', async () => {
    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'dec-1',
        category: 'interface-contract',
        key: 'JudgeResult',
        value: JSON.stringify({
          storyKey: '25-6',
          schemaName: 'JudgeResult',
          direction: 'export',
          filePath: 'src/judge/types.ts',
        }),
        phase: 'create-story',
        storyKey: '25-6',
        createdAt: new Date().toISOString(),
      },
    ])

    // verifyContracts returns 2 mismatches
    mockVerifyContracts.mockReturnValue([
      makeContractMismatch(),
      makeContractMismatch({ contractName: 'PublisherResult' }),
    ])

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
      projectRoot: '/project',
    })

    await orchestrator.run(['25-6'])

    const mockEmit = vi.mocked(eventBus.emit)
    const mismatchEvents = mockEmit.mock.calls.filter(
      ([eventName]) => eventName === 'pipeline:contract-mismatch',
    )

    expect(mismatchEvents).toHaveLength(2)

    const payloads = mismatchEvents.map(([, payload]) => payload as {
      exporter: string
      importer: string | null
      contractName: string
      mismatchDescription: string
    })

    expect(payloads[0]!.exporter).toBe('25-6')
    expect(payloads[0]!.importer).toBe('25-6')
    expect(payloads[0]!.contractName).toBe('JudgeResult')
    expect(payloads[0]!.mismatchDescription).toContain('Exported file not found')

    expect(payloads[1]!.importer).toBe('25-6')
    expect(payloads[1]!.contractName).toBe('PublisherResult')
  })

  it('AC4: no pipeline:contract-mismatch events when verification passes', async () => {
    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'dec-1',
        category: 'interface-contract',
        key: 'JudgeResult',
        value: JSON.stringify({
          storyKey: '25-6',
          schemaName: 'JudgeResult',
          direction: 'export',
          filePath: 'src/judge/types.ts',
        }),
        phase: 'create-story',
        storyKey: '25-6',
        createdAt: new Date().toISOString(),
      },
    ])

    // verifyContracts returns no mismatches (all contracts satisfied)
    mockVerifyContracts.mockReturnValue([])

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
      projectRoot: '/project',
    })

    await orchestrator.run(['25-6'])

    const mockEmit = vi.mocked(eventBus.emit)
    const mismatchEvents = mockEmit.mock.calls.filter(
      ([eventName]) => eventName === 'pipeline:contract-mismatch',
    )
    expect(mismatchEvents).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // AC5: Failures are surfaced in the pipeline status
  // ---------------------------------------------------------------------------

  it('AC5: contractMismatches field is populated in status when mismatches found', async () => {
    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'dec-1',
        category: 'interface-contract',
        key: 'JudgeResult',
        value: JSON.stringify({
          storyKey: '25-6',
          schemaName: 'JudgeResult',
          direction: 'export',
          filePath: 'src/judge/types.ts',
        }),
        phase: 'create-story',
        storyKey: '25-6',
        createdAt: new Date().toISOString(),
      },
    ])

    const mismatch = makeContractMismatch()
    mockVerifyContracts.mockReturnValue([mismatch])

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
      projectRoot: '/project',
    })

    const status = await orchestrator.run(['25-6'])

    expect(status.contractMismatches).toBeDefined()
    expect(status.contractMismatches).toHaveLength(1)
    expect(status.contractMismatches![0]!.contractName).toBe('JudgeResult')
    expect(status.contractMismatches![0]!.exporter).toBe('25-6')
    expect(status.contractMismatches![0]!.importer).toBe('25-6')
    expect(status.contractMismatches![0]!.mismatchDescription).toContain('Exported file not found')
  })

  it('AC5: contractMismatches is absent from status when no mismatches', async () => {
    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'dec-1',
        category: 'interface-contract',
        key: 'JudgeResult',
        value: JSON.stringify({
          storyKey: '25-6',
          schemaName: 'JudgeResult',
          direction: 'export',
          filePath: 'src/judge/types.ts',
        }),
        phase: 'create-story',
        storyKey: '25-6',
        createdAt: new Date().toISOString(),
      },
    ])

    mockVerifyContracts.mockReturnValue([])

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
      projectRoot: '/project',
    })

    const status = await orchestrator.run(['25-6'])

    expect(status.contractMismatches).toBeUndefined()
  })

  it('AC5: pipeline still completes (COMPLETE state) even when contract mismatches found', async () => {
    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'dec-1',
        category: 'interface-contract',
        key: 'SomeContract',
        value: JSON.stringify({
          storyKey: '25-6',
          schemaName: 'SomeContract',
          direction: 'export',
          filePath: 'src/some/types.ts',
        }),
        phase: 'create-story',
        storyKey: '25-6',
        createdAt: new Date().toISOString(),
      },
    ])

    mockVerifyContracts.mockReturnValue([makeContractMismatch()])

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
      projectRoot: '/project',
    })

    const status = await orchestrator.run(['25-6'])

    // Pipeline is COMPLETE (not FAILED) — contract verification is non-blocking
    expect(status.state).toBe('COMPLETE')
  })

  it('AC1: verifyContracts is called after stories complete (ordering check)', async () => {
    const callOrder: string[] = []

    // Track when runCodeReview is called vs verifyContracts
    mockRunCreateStory.mockImplementation(async (..._args) => {
      callOrder.push('create-story')
      return makeCreateStorySuccess()
    })
    mockRunDevStory.mockImplementation(async (..._args) => {
      callOrder.push('dev-story')
      return makeDevStorySuccess()
    })
    mockRunCodeReview.mockImplementation(async (..._args) => {
      callOrder.push('code-review')
      return makeCodeReviewShipIt()
    })
    mockVerifyContracts.mockImplementation((..._args) => {
      callOrder.push('verify-contracts')
      return []
    })

    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'dec-1',
        category: 'interface-contract',
        key: 'MyContract',
        value: JSON.stringify({
          storyKey: '25-6',
          schemaName: 'MyContract',
          direction: 'export',
          filePath: 'src/my-contract.ts',
        }),
        phase: 'create-story',
        storyKey: '25-6',
        createdAt: new Date().toISOString(),
      },
    ])

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
      projectRoot: '/project',
    })

    await orchestrator.run(['25-6'])

    // verify-contracts must come AFTER code-review
    const reviewIdx = callOrder.indexOf('code-review')
    const verifyIdx = callOrder.indexOf('verify-contracts')
    expect(reviewIdx).toBeGreaterThanOrEqual(0)
    expect(verifyIdx).toBeGreaterThan(reviewIdx)
  })

  it('AC1: verification error is caught and does not crash the pipeline', async () => {
    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'dec-1',
        category: 'interface-contract',
        key: 'MyContract',
        value: JSON.stringify({
          storyKey: '25-6',
          schemaName: 'MyContract',
          direction: 'export',
          filePath: 'src/my-contract.ts',
        }),
        phase: 'create-story',
        storyKey: '25-6',
        createdAt: new Date().toISOString(),
      },
    ])

    // verifyContracts throws an unexpected error
    mockVerifyContracts.mockImplementation(() => {
      throw new Error('Unexpected error in verifier')
    })

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
      projectRoot: '/project',
    })

    // Should not throw — error is caught
    const status = await orchestrator.run(['25-6'])
    expect(status.state).toBe('COMPLETE')
  })
})

// ---------------------------------------------------------------------------
// event-types.ts: pipeline:contract-mismatch event type registration
// ---------------------------------------------------------------------------

import { EVENT_TYPE_NAMES } from '../event-types.js'

describe('event-types: pipeline:contract-mismatch', () => {
  it('is listed in EVENT_TYPE_NAMES', () => {
    expect(EVENT_TYPE_NAMES).toContain('pipeline:contract-mismatch')
  })
})
