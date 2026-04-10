/**
 * Epic 25 — Cross-Story Coherence Engine: Integration & E2E Tests
 *
 * Tests cross-module wiring that individual story unit tests do not cover:
 *
 *   Gap 1: Pre-flight build gate → skipPreflight config → event emission → pipeline abort
 *   Gap 2: LGTM_WITH_NOTES verdict → story COMPLETE → advisory notes persisted → prior_findings
 *   Gap 3: Contract declaration parsing → decision store → dispatch ordering
 *   Gap 4: Contract verification gate → post-sprint check → mismatch events
 *   Gap 5: Test-plan phase → runTestPlan invocation → tokenCeilings propagation
 *   Gap 6: Contract verification error resilience → graceful degradation
 *   Gap 7: Multi-batch sequential execution from contract-aware ordering
 *   Gap 8: LGTM_WITH_NOTES excluded from phantom review retry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DatabaseAdapter } from '../../persistence/adapter.js'
import type { MethodologyPack } from '../../modules/methodology-pack/types.js'
import type { ContextCompiler } from '../../modules/context-compiler/context-compiler.js'
import type {
  Dispatcher,
  DispatchHandle,
  DispatchResult,
} from '../../modules/agent-dispatch/types.js'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { OrchestratorConfig } from '../../modules/implementation-orchestrator/types.js'

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted
// ---------------------------------------------------------------------------

vi.mock('../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

const mockCreateDecision = vi.fn()
const mockGetDecisionsByCategory = vi.fn().mockReturnValue([])

vi.mock('../../persistence/queries/decisions.js', () => ({
  getDecisionsByPhase: vi.fn().mockReturnValue([]),
  getDecisionsByCategory: (...args: unknown[]) => mockGetDecisionsByCategory(...args),
  updatePipelineRun: vi.fn(),
  registerArtifact: vi.fn(),
  createDecision: (...args: unknown[]) => mockCreateDecision(...args),
  addTokenUsage: vi.fn(),
}))

vi.mock('../../persistence/queries/metrics.js', () => ({
  writeStoryMetrics: vi.fn(),
  aggregateTokenUsageForStory: vi.fn().mockReturnValue({ input: 0, output: 0 }),
}))

const mockRunCreateStory = vi.fn()
vi.mock('../../modules/compiled-workflows/create-story.js', () => ({
  runCreateStory: (...args: unknown[]) => mockRunCreateStory(...args),
  isValidStoryFile: vi.fn().mockResolvedValue({ valid: true }),
}))

const mockRunDevStory = vi.fn()
vi.mock('../../modules/compiled-workflows/dev-story.js', () => ({
  runDevStory: (...args: unknown[]) => mockRunDevStory(...args),
}))

const mockRunCodeReview = vi.fn()
vi.mock('../../modules/compiled-workflows/code-review.js', () => ({
  runCodeReview: (...args: unknown[]) => mockRunCodeReview(...args),
}))

const mockRunTestPlan = vi.fn()
vi.mock('../../modules/compiled-workflows/test-plan.js', () => ({
  runTestPlan: (...args: unknown[]) => mockRunTestPlan(...args),
}))

vi.mock('../../modules/compiled-workflows/test-expansion.js', () => ({
  runTestExpansion: vi.fn().mockResolvedValue({ result: 'failed' }),
}))

const mockParseInterfaceContracts = vi.fn().mockReturnValue([])
vi.mock('../../modules/compiled-workflows/interface-contracts.js', () => ({
  parseInterfaceContracts: (...args: unknown[]) => mockParseInterfaceContracts(...args),
}))

const mockVerifyContracts = vi.fn().mockReturnValue([])
vi.mock('../../modules/implementation-orchestrator/contract-verifier.js', () => ({
  verifyContracts: (...args: unknown[]) => mockVerifyContracts(...args),
}))

vi.mock('../../cli/commands/health.js', () => ({
  inspectProcessTree: vi
    .fn()
    .mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))

vi.mock('../../modules/agent-dispatch/dispatcher-impl.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
    checkGitDiffFiles: vi.fn().mockReturnValue(['src/some-modified-file.ts']),
  }
})

vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue('src/some-modified-file.ts\n'),
  exec: vi.fn(),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(''),
  readdirSync: vi.fn().mockReturnValue([]),
  watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('# Story\n\nSome content'),
}))

vi.mock('../../modules/implementation-orchestrator/escalation-diagnosis.js', () => ({
  generateEscalationDiagnosis: vi.fn().mockReturnValue({
    issueDistribution: 'none',
    severityProfile: 'no-structured-issues',
    totalIssues: 0,
    blockerCount: 0,
    majorCount: 0,
    minorCount: 0,
    affectedFiles: [],
    reviewCycles: 0,
    recommendedAction: 'retry-targeted',
    rationale: 'test',
  }),
}))

vi.mock('../../modules/implementation-orchestrator/seed-methodology-context.js', () => ({
  seedMethodologyContext: vi.fn().mockReturnValue({ decisionsCreated: 0, skippedCategories: [] }),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { createImplementationOrchestrator } from '../../modules/implementation-orchestrator/orchestrator-impl.js'
import {
  runBuildVerification,
  checkGitDiffFiles,
} from '../../modules/agent-dispatch/dispatcher-impl.js'

const mockRunBuildVerification = vi.mocked(runBuildVerification)
const mockCheckGitDiffFiles = vi.mocked(checkGitDiffFiles)

// ---------------------------------------------------------------------------
// Shared factories
// ---------------------------------------------------------------------------

function makeDb(): DatabaseAdapter {
  return {} as unknown as DatabaseAdapter
}

function makePack(): MethodologyPack {
  return {
    manifest: {
      name: 'bmad',
      version: '1.0.0',
      description: 'BMAD pack',
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

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi
      .fn()
      .mockReturnValue({ prompt: 'fallback', tokenCount: 10, sections: [], truncated: false }),
    registerTemplate: vi.fn(),
    getTemplate: vi.fn().mockReturnValue(undefined),
  } as unknown as ContextCompiler
}

function makeEventBus(): TypedEventBus {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    emit: vi.fn((event: string, ...args: unknown[]) => {
      const fns = listeners.get(event)
      if (fns) fns.forEach((fn) => fn(...args))
    }),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event)!.push(fn)
    }),
    off: vi.fn(),
  }
}

function makeDispatcher(): Dispatcher {
  const result: DispatchResult<unknown> = {
    id: 'test-dispatch',
    status: 'completed',
    exitCode: 0,
    output: '',
    parsed: null,
    parseError: null,
    durationMs: 100,
    tokenEstimate: { input: 10, output: 5 },
  }
  const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
    id: 'test-dispatch',
    status: 'completed',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: Promise.resolve(result),
  }
  return {
    dispatch: vi.fn().mockReturnValue(handle),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    getMemoryState: vi
      .fn()
      .mockReturnValue({ isPressured: false, freeMB: 1024, thresholdMB: 256, pressureLevel: 0 }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function defaultConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    maxConcurrency: 3,
    maxReviewCycles: 2,
    pipelineRunId: 'test-run-epic25',
    skipPreflight: true,
    ...overrides,
  }
}

function makeCreateStorySuccess(storyKey: string, filePath: string) {
  return {
    result: 'success' as const,
    story_file: filePath,
    story_key: storyKey,
    story_title: `Story ${storyKey}`,
    tokenUsage: { input: 100, output: 50 },
  }
}

function makeDevStorySuccess() {
  return {
    result: 'success' as const,
    ac_met: ['AC1', 'AC2'],
    ac_failures: [],
    files_modified: ['src/foo.ts', 'src/bar.ts'],
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

function makeCodeReviewLgtmWithNotes(notes: string) {
  return {
    verdict: 'LGTM_WITH_NOTES' as const,
    issues: 0,
    issue_list: [],
    notes,
    tokenUsage: { input: 150, output: 50 },
  }
}

// ---------------------------------------------------------------------------
// Gap 1: Pre-flight build gate → skipPreflight → event → abort
// ---------------------------------------------------------------------------

describe('Gap 1: Pre-flight build gate cross-module wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunBuildVerification.mockReturnValue({ status: 'passed', exitCode: 0 })
    mockCheckGitDiffFiles.mockReturnValue(['src/some-modified-file.ts'])
  })

  it('pre-flight failure emits event and aborts before any story dispatch', async () => {
    mockRunBuildVerification.mockReturnValue({
      status: 'failed',
      exitCode: 1,
      output: 'Build error: tsc failed',
    })

    const eventBus = makeEventBus()
    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus,
      config: defaultConfig({ skipPreflight: false }),
    })

    const status = await orchestrator.run(['25-99'])

    // Event emitted with correct payload
    expect(eventBus.emit).toHaveBeenCalledWith('pipeline:pre-flight-failure', {
      exitCode: 1,
      output: expect.stringContaining('Build error'),
    })

    // No stories dispatched
    expect(mockRunCreateStory).not.toHaveBeenCalled()
    expect(mockRunDevStory).not.toHaveBeenCalled()

    // Stories remain in PENDING state
    expect(status.stories['25-99']?.phase).toBe('PENDING')
  })

  it('skipPreflight=true bypasses pre-flight and dispatches stories', async () => {
    // Build verification returns passed for post-dev gate; the test verifies
    // that no pipeline:pre-flight-failure event is emitted when skipPreflight=true.
    mockRunBuildVerification.mockReturnValue({ status: 'passed', exitCode: 0 })
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-88', '/stories/25-88.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
    mockRunTestPlan.mockResolvedValue({ result: 'failed' })

    const eventBus = makeEventBus()
    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus,
      config: defaultConfig({ skipPreflight: true }),
    })

    const status = await orchestrator.run(['25-88'])

    // Pre-flight event NOT emitted
    expect(eventBus.emit).not.toHaveBeenCalledWith('pipeline:pre-flight-failure', expect.anything())

    // Story was dispatched and completed
    expect(mockRunDevStory).toHaveBeenCalled()
    expect(status.stories['25-88']?.phase).toBe('COMPLETE')
  })

  it('pre-flight failure event is receivable by listeners', async () => {
    mockRunBuildVerification.mockReturnValue({
      status: 'failed',
      exitCode: 2,
      output: 'Syntax error',
    })

    const eventBus = makeEventBus()
    const receivedEvents: unknown[] = []
    eventBus.on('pipeline:pre-flight-failure', (payload: unknown) => {
      receivedEvents.push(payload)
    })

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus,
      config: defaultConfig({ skipPreflight: false }),
    })

    await orchestrator.run(['25-77'])

    expect(receivedEvents).toHaveLength(1)
    expect(receivedEvents[0]).toEqual({
      exitCode: 2,
      output: 'Syntax error',
    })
  })
})

// ---------------------------------------------------------------------------
// Gap 2: LGTM_WITH_NOTES → COMPLETE → advisory notes → prior_findings
// ---------------------------------------------------------------------------

describe('Gap 2: LGTM_WITH_NOTES verdict → advisory notes persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunBuildVerification.mockReturnValue({ status: 'passed', exitCode: 0 })
    mockCheckGitDiffFiles.mockReturnValue(['src/some-modified-file.ts'])
  })

  it('LGTM_WITH_NOTES completes story and persists advisory notes to decision store', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-71', '/stories/25-71.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(
      makeCodeReviewLgtmWithNotes('Consider adding JSDoc to exported functions')
    )
    mockRunTestPlan.mockResolvedValue({ result: 'failed' })

    const eventBus = makeEventBus()
    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus,
      config: defaultConfig(),
    })

    const status = await orchestrator.run(['25-71'])

    // Story marked COMPLETE (not ESCALATED or NEEDS_FIXES)
    expect(status.stories['25-71']?.phase).toBe('COMPLETE')

    // Verify code review was called and returned LGTM_WITH_NOTES
    expect(mockRunCodeReview).toHaveBeenCalled()
    const crResult = await mockRunCodeReview.mock.results[0]?.value
    expect(crResult?.verdict).toBe('LGTM_WITH_NOTES')
    expect(crResult?.notes).toBe('Consider adding JSDoc to exported functions')

    // Advisory notes persisted to decision store
    expect(mockCreateDecision).toHaveBeenCalledWith(
      expect.anything(), // db
      expect.objectContaining({
        category: 'advisory-notes',
        key: expect.stringContaining('25-71'),
        value: expect.stringContaining('Consider adding JSDoc'),
      })
    )

    // story:done event emitted (same as SHIP_IT)
    expect(eventBus.emit).toHaveBeenCalledWith(
      'orchestrator:story-complete',
      expect.objectContaining({ storyKey: '25-71' })
    )
  })

  it('LGTM_WITH_NOTES without notes field does not attempt persistence', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-72', '/stories/25-72.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue({
      verdict: 'LGTM_WITH_NOTES' as const,
      issues: 0,
      issue_list: [],
      tokenUsage: { input: 150, output: 50 },
      // no notes field
    })
    mockRunTestPlan.mockResolvedValue({ result: 'failed' })

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
    })

    const status = await orchestrator.run(['25-72'])

    expect(status.stories['25-72']?.phase).toBe('COMPLETE')

    // No advisory-notes decision created (notes was undefined)
    const advisoryNoteCalls = mockCreateDecision.mock.calls.filter(
      (call) => (call[1] as Record<string, unknown>)?.category === 'advisory-notes'
    )
    expect(advisoryNoteCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Gap 3: Contract declarations → decision store → dispatch ordering
// ---------------------------------------------------------------------------

describe('Gap 3: Contract declaration parsing → decision store → dispatch ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunBuildVerification.mockReturnValue({ status: 'passed', exitCode: 0 })
    mockCheckGitDiffFiles.mockReturnValue(['src/some-modified-file.ts'])
  })

  it('parsed interface contracts from story file are stored in decision store', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-61', '/stories/25-61.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
    mockRunTestPlan.mockResolvedValue({ result: 'failed' })

    // parseInterfaceContracts returns contracts for this story
    mockParseInterfaceContracts.mockReturnValue([
      {
        storyKey: '25-61',
        contractName: 'FooSchema',
        direction: 'export',
        filePath: 'src/schemas/foo.ts',
      },
      {
        storyKey: '25-61',
        contractName: 'BarSchema',
        direction: 'import',
        filePath: 'src/schemas/bar.ts',
      },
    ])

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
    })

    await orchestrator.run(['25-61'])

    // Two interface-contract decisions created
    const contractCalls = mockCreateDecision.mock.calls.filter(
      (call) => (call[1] as Record<string, unknown>)?.category === 'interface-contract'
    )
    expect(contractCalls).toHaveLength(2)

    // Verify export declaration
    const exportCall = contractCalls.find((call) =>
      ((call[1] as Record<string, unknown>)?.key as string)?.includes('FooSchema')
    )
    expect(exportCall).toBeDefined()
    const exportValue = JSON.parse((exportCall![1] as Record<string, unknown>).value as string)
    expect(exportValue).toMatchObject({
      direction: 'export',
      schemaName: 'FooSchema',
      filePath: 'src/schemas/foo.ts',
      storyKey: '25-61',
    })
  })

  it('contract declarations from decision store influence dispatch ordering', async () => {
    // Simulate decisions previously stored for story A (export) and story B (import)
    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 1,
        category: 'interface-contract',
        key: '25-A:FooSchema',
        value: JSON.stringify({
          storyKey: '25-A',
          schemaName: 'FooSchema',
          direction: 'export',
          filePath: 'src/foo.ts',
        }),
      },
      {
        id: 2,
        category: 'interface-contract',
        key: '25-B:FooSchema',
        value: JSON.stringify({
          storyKey: '25-B',
          schemaName: 'FooSchema',
          direction: 'import',
          filePath: 'src/foo.ts',
        }),
      },
    ])

    const dispatchOrder: string[] = []

    mockRunCreateStory.mockImplementation(async (_deps, params) => {
      const key = (params as Record<string, string>).storyKey!
      return makeCreateStorySuccess(key, `/stories/${key}.md`)
    })
    mockRunDevStory.mockImplementation(async (_deps, params) => {
      const key = (params as Record<string, string>).storyKey!
      dispatchOrder.push(key)
      return makeDevStorySuccess()
    })
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
    mockRunTestPlan.mockResolvedValue({ result: 'failed' })

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig({ maxConcurrency: 1 }),
    })

    const status = await orchestrator.run(['25-A', '25-B'])

    // Exporter (25-A) dispatched before importer (25-B)
    expect(dispatchOrder.indexOf('25-A')).toBeLessThan(dispatchOrder.indexOf('25-B'))
    expect(status.stories['25-A']?.phase).toBe('COMPLETE')
    expect(status.stories['25-B']?.phase).toBe('COMPLETE')
  })

  it('stories with no contract overlap run in same batch (no regression)', async () => {
    mockGetDecisionsByCategory.mockReturnValue([])

    mockRunCreateStory.mockImplementation(async (_deps, params) => {
      const key = (params as Record<string, string>).storyKey!
      return makeCreateStorySuccess(key, `/stories/${key}.md`)
    })
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
    mockRunTestPlan.mockResolvedValue({ result: 'failed' })

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig({ maxConcurrency: 3 }),
    })

    const status = await orchestrator.run(['25-X', '25-Y'])

    // Both stories completed (ran in parallel, no ordering constraint)
    expect(status.stories['25-X']?.phase).toBe('COMPLETE')
    expect(status.stories['25-Y']?.phase).toBe('COMPLETE')
  })
})

// ---------------------------------------------------------------------------
// Gap 4: Contract verification gate → post-sprint → mismatch events
// ---------------------------------------------------------------------------

describe('Gap 4: Contract verification gate → mismatch events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunBuildVerification.mockReturnValue({ status: 'passed', exitCode: 0 })
    mockCheckGitDiffFiles.mockReturnValue(['src/some-modified-file.ts'])
  })

  it('contract mismatches emit events and appear in status', async () => {
    // Provide contract declarations so verification runs
    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 1,
        category: 'interface-contract',
        key: '25-C:BazSchema',
        value: JSON.stringify({
          storyKey: '25-C',
          schemaName: 'BazSchema',
          direction: 'export',
          filePath: 'src/baz.ts',
        }),
      },
    ])

    mockVerifyContracts.mockReturnValue([
      {
        exporter: '25-C',
        importer: '25-D',
        contractName: 'BazSchema',
        mismatchDescription: 'Exported file src/baz.ts does not exist',
      },
    ])

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-C', '/stories/25-C.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
    mockRunTestPlan.mockResolvedValue({ result: 'failed' })

    const eventBus = makeEventBus()
    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus,
      config: defaultConfig(),
      projectRoot: '/test-project',
    })

    const status = await orchestrator.run(['25-C'])

    // Story still completes (verification is post-sprint, non-blocking)
    expect(status.stories['25-C']?.phase).toBe('COMPLETE')

    // Mismatch event emitted
    expect(eventBus.emit).toHaveBeenCalledWith('pipeline:contract-mismatch', {
      exporter: '25-C',
      importer: '25-D',
      contractName: 'BazSchema',
      mismatchDescription: 'Exported file src/baz.ts does not exist',
    })

    // Verification was called with declarations and project root
    expect(mockVerifyContracts).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ storyKey: '25-C', contractName: 'BazSchema' }),
      ]),
      '/test-project'
    )
  })

  it('no contract declarations skips verification entirely', async () => {
    mockGetDecisionsByCategory.mockReturnValue([])
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-E', '/stories/25-E.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
    mockRunTestPlan.mockResolvedValue({ result: 'failed' })

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
      projectRoot: '/test-project',
    })

    await orchestrator.run(['25-E'])

    expect(mockVerifyContracts).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Gap 5: Test-plan phase → runTestPlan → tokenCeilings propagation
// ---------------------------------------------------------------------------

describe('Gap 5: Test-plan phase invocation and tokenCeilings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunBuildVerification.mockReturnValue({ status: 'passed', exitCode: 0 })
    mockCheckGitDiffFiles.mockReturnValue(['src/some-modified-file.ts'])
  })

  it('orchestrator invokes runTestPlan with tokenCeilings and story context', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-51', '/stories/25-51.md'))
    mockRunTestPlan.mockResolvedValue({ result: 'success', test_strategy: 'unit + integration' })
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const tokenCeilings = { 'dev-story': 50000, 'test-plan': 8000 }

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
      tokenCeilings,
    })

    await orchestrator.run(['25-51'])

    // runTestPlan was called
    expect(mockRunTestPlan).toHaveBeenCalledTimes(1)

    // First arg is deps (includes tokenCeilings)
    const call = mockRunTestPlan.mock.calls[0]!
    const [deps, params] = call
    expect(deps).toHaveProperty('tokenCeilings', tokenCeilings)
    expect(deps).toHaveProperty('pack')
    expect(deps).toHaveProperty('dispatcher')

    // Second arg is params (includes storyKey)
    expect(params).toHaveProperty('storyKey', '25-51')
    expect(params).toHaveProperty('storyFilePath', '/stories/25-51.md')
  })

  it('test-plan failure does not block dev-story dispatch', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-52', '/stories/25-52.md'))
    mockRunTestPlan.mockResolvedValue({ result: 'failed' })
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
    })

    const status = await orchestrator.run(['25-52'])

    // Dev story still ran despite test-plan failure
    expect(mockRunDevStory).toHaveBeenCalled()
    expect(status.stories['25-52']?.phase).toBe('COMPLETE')
  })

  it('test-plan exception does not block dev-story dispatch', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-53', '/stories/25-53.md'))
    mockRunTestPlan.mockRejectedValue(new Error('Pack has no test-plan prompt'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
    })

    const status = await orchestrator.run(['25-53'])

    expect(mockRunDevStory).toHaveBeenCalled()
    expect(status.stories['25-53']?.phase).toBe('COMPLETE')
  })
})

// ---------------------------------------------------------------------------
// Gap 6: Contract verification error resilience
// ---------------------------------------------------------------------------

describe('Gap 6: Contract verification error resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunBuildVerification.mockReturnValue({ status: 'passed', exitCode: 0 })
    mockCheckGitDiffFiles.mockReturnValue(['src/some-modified-file.ts'])
  })

  it('verifyContracts throwing does not prevent pipeline COMPLETE', async () => {
    // Contract declarations exist so verification runs
    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 1,
        category: 'interface-contract',
        key: '25-F:Schema',
        value: JSON.stringify({
          storyKey: '25-F',
          schemaName: 'Schema',
          direction: 'export',
          filePath: 'src/schema.ts',
        }),
      },
    ])

    // verifyContracts throws an error
    mockVerifyContracts.mockImplementation(() => {
      throw new Error('tsc binary not found')
    })

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-F', '/stories/25-F.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
    mockRunTestPlan.mockResolvedValue({ result: 'failed' })

    const eventBus = makeEventBus()
    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus,
      config: defaultConfig(),
      projectRoot: '/test-project',
    })

    const status = await orchestrator.run(['25-F'])

    // Story still COMPLETE — verification error is non-blocking
    expect(status.stories['25-F']?.phase).toBe('COMPLETE')

    // No mismatch events emitted (error caught before emission)
    expect(eventBus.emit).not.toHaveBeenCalledWith('pipeline:contract-mismatch', expect.anything())
  })
})

// ---------------------------------------------------------------------------
// Gap 7: Multi-batch sequential execution from contract ordering
// ---------------------------------------------------------------------------

describe('Gap 7: Multi-batch sequential execution from contract ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunBuildVerification.mockReturnValue({ status: 'passed', exitCode: 0 })
    mockCheckGitDiffFiles.mockReturnValue(['src/some-modified-file.ts'])
  })

  it('batch-2 stories start only after batch-1 stories complete', async () => {
    // Contract declarations: 25-P exports, 25-Q imports → 25-P must run before 25-Q
    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 1,
        category: 'interface-contract',
        key: '25-P:SharedType',
        value: JSON.stringify({
          storyKey: '25-P',
          schemaName: 'SharedType',
          direction: 'export',
          filePath: 'src/shared.ts',
        }),
      },
      {
        id: 2,
        category: 'interface-contract',
        key: '25-Q:SharedType',
        value: JSON.stringify({
          storyKey: '25-Q',
          schemaName: 'SharedType',
          direction: 'import',
          filePath: 'src/consumer.ts',
        }),
      },
    ])

    const timeline: Array<{ event: string; storyKey: string }> = []

    mockRunCreateStory.mockImplementation(async (_deps, params) => {
      const key = (params as Record<string, string>).storyKey!
      return makeCreateStorySuccess(key, `/stories/${key}.md`)
    })

    mockRunDevStory.mockImplementation(async (_deps, params) => {
      const key = (params as Record<string, string>).storyKey!
      timeline.push({ event: 'dev-start', storyKey: key })
      // Small delay to ensure timing is observable
      await new Promise((r) => setTimeout(r, 10))
      timeline.push({ event: 'dev-end', storyKey: key })
      return makeDevStorySuccess()
    })

    mockRunCodeReview.mockImplementation(async (_deps, params) => {
      const key = (params as Record<string, string>).storyKey!
      timeline.push({ event: 'review-end', storyKey: key })
      return makeCodeReviewShipIt()
    })

    mockRunTestPlan.mockResolvedValue({ result: 'failed' })

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig({ maxConcurrency: 3 }),
    })

    const status = await orchestrator.run(['25-P', '25-Q'])

    // Both stories completed
    expect(status.stories['25-P']?.phase).toBe('COMPLETE')
    expect(status.stories['25-Q']?.phase).toBe('COMPLETE')

    // 25-P dev-story must END before 25-Q dev-story STARTS
    const pDevEnd = timeline.findIndex((e) => e.storyKey === '25-P' && e.event === 'review-end')
    const qDevStart = timeline.findIndex((e) => e.storyKey === '25-Q' && e.event === 'dev-start')
    expect(pDevEnd).toBeGreaterThanOrEqual(0)
    expect(qDevStart).toBeGreaterThanOrEqual(0)
    expect(pDevEnd).toBeLessThan(qDevStart)
  })
})

// ---------------------------------------------------------------------------
// Gap 8: LGTM_WITH_NOTES excluded from phantom review retry
// ---------------------------------------------------------------------------

describe('Gap 8: LGTM_WITH_NOTES phantom review exclusion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunBuildVerification.mockReturnValue({ status: 'passed', exitCode: 0 })
    mockCheckGitDiffFiles.mockReturnValue(['src/some-modified-file.ts'])
  })

  it('LGTM_WITH_NOTES with empty issues and error is NOT retried as phantom', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-80', '/stories/25-80.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    // Return LGTM_WITH_NOTES with empty issue_list + error field (would be phantom for other verdicts)
    mockRunCodeReview.mockResolvedValue({
      verdict: 'LGTM_WITH_NOTES' as const,
      issues: 0,
      issue_list: [],
      error: 'partial parse warning',
      notes: 'Minor style suggestions',
      tokenUsage: { input: 150, output: 50 },
    })
    mockRunTestPlan.mockResolvedValue({ result: 'failed' })

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig({ maxReviewCycles: 2 }),
    })

    const status = await orchestrator.run(['25-80'])

    // Story completes on first review — NOT retried as phantom
    expect(status.stories['25-80']?.phase).toBe('COMPLETE')
    expect(mockRunCodeReview).toHaveBeenCalledTimes(1)
  })

  it('NEEDS_MINOR_FIXES with empty issues and error IS retried as phantom', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-81', '/stories/25-81.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())

    let callCount = 0
    mockRunCodeReview.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        // First call: phantom review (non-SHIP_IT, empty issues, has error)
        return {
          verdict: 'NEEDS_MINOR_FIXES' as const,
          issues: 0,
          issue_list: [],
          error: 'schema parse failed',
          tokenUsage: { input: 150, output: 50 },
        }
      }
      // Second call (retry): real review succeeds
      return makeCodeReviewShipIt()
    })
    mockRunTestPlan.mockResolvedValue({ result: 'failed' })

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig({ maxReviewCycles: 3 }),
    })

    const status = await orchestrator.run(['25-81'])

    // Code review called twice: phantom retry → real review
    expect(mockRunCodeReview).toHaveBeenCalledTimes(2)
    expect(status.stories['25-81']?.phase).toBe('COMPLETE')
  })
})
