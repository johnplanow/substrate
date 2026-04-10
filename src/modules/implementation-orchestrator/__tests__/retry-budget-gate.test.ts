/**
 * Unit tests for Story 53-4: Per-Story Retry Budget — budget gate enforcement.
 *
 * Covers:
 *   AC4: retry_count incremented on each retry attempt
 *   AC5: budget gate enforced before each retry (escalates with 'retry_budget_exhausted')
 *   AC6: budget gate reads retry_count from run manifest for crash-recovery durability
 *   AC7: default retryBudget is 2
 *
 * Uses mocked compiled-workflow runners and a mocked dispatcher for deterministic,
 * fast unit tests. The orchestrator itself runs real logic to exercise the gate path.
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
    suggested_tests: [],
    tokenUsage: { input: 10, output: 5 },
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
  readFileSync: vi.fn().mockReturnValue('{}'),
}))
vi.mock('../../../cli/commands/health.js', () => ({
  inspectProcessTree: vi
    .fn()
    .mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))
vi.mock('../../../utils/helpers.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../agent-dispatch/dispatcher-impl.js', () => ({
  runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
  checkGitDiffFiles: vi.fn().mockReturnValue(['src/some-modified-file.ts']),
}))
vi.mock('../../agent-dispatch/interface-change-detector.js', () => ({
  detectInterfaceChanges: vi
    .fn()
    .mockReturnValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] }),
}))
vi.mock('../seed-methodology-context.js', () => ({
  seedMethodologyContext: vi.fn().mockReturnValue({ decisionsCreated: 0, skippedCategories: [] }),
}))
vi.mock('../conflict-detector.js', () => ({
  detectConflictGroupsWithContracts: vi.fn().mockReturnValue({ batches: [[['53-4']]], edges: [] }),
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
  resolveDevStoryMaxTurns: vi.fn().mockReturnValue(30),
  logComplexityResult: vi.fn(),
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue('src/some-modified-file.ts\n'),
  }
})

// Mock @substrate-ai/sdlc so the Tier A verification pipeline always passes in unit tests
vi.mock('@substrate-ai/sdlc', () => ({
  createDefaultVerificationPipeline: vi.fn(() => ({
    run: vi.fn().mockImplementation((ctx: { storyKey: string }) =>
      Promise.resolve({
        storyKey: ctx.storyKey,
        checks: [],
        status: 'pass',
        duration_ms: 0,
      })
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
import { detectConflictGroupsWithContracts } from '../conflict-detector.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)
const mockDetectConflictGroups = vi.mocked(detectConflictGroupsWithContracts)

// ---------------------------------------------------------------------------
// Test helpers / factories
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
    getMemoryState: vi
      .fn()
      .mockReturnValue({ isPressured: false, freeMB: 1024, thresholdMB: 256, pressureLevel: 0 }),
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
    maxReviewCycles: 10, // High value so maxReviewCycles doesn't interfere with budget gate tests
    pipelineRunId: 'test-run-id',
    gcPauseMs: 0,
    skipPreflight: true,
    skipBuildVerify: true,
    ...overrides,
  }
}

function makeCreateStorySuccess(storyKey = '53-4') {
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

function makeTestPlanSuccess() {
  return {
    result: 'success' as const,
    test_files: [],
    test_categories: [],
    coverage_notes: '',
    tokenUsage: { input: 50, output: 20 },
  }
}

function makeCodeReviewNeedsMajorRework() {
  return {
    verdict: 'NEEDS_MAJOR_REWORK' as const,
    issues: 2,
    issue_list: [
      { severity: 'blocker' as const, description: 'Missing implementation', file: 'src/foo.ts' },
      { severity: 'major' as const, description: 'Tests not passing', file: 'src/foo.test.ts' },
    ],
    tokenUsage: { input: 150, output: 50 },
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

/**
 * Create a minimal mock RunManifest with configurable per_story_state.
 * Only implements read() and patchStoryState() — the methods used by the budget gate logic.
 */
function createMockRunManifest(initialRetryCounts: Record<string, number> = {}) {
  // In-memory state for the mock
  const perStoryState: Record<string, { retry_count?: number }> = {}
  for (const [key, count] of Object.entries(initialRetryCounts)) {
    perStoryState[key] = { retry_count: count }
  }

  return {
    read: vi.fn().mockImplementation(() =>
      Promise.resolve({
        run_id: 'test-run-id',
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: { ...perStoryState },
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
        generation: 1,
        created_at: '2026-04-06T00:00:00.000Z',
        updated_at: '2026-04-06T00:00:00.000Z',
      })
    ),
    patchStoryState: vi.fn().mockResolvedValue(undefined),
    appendRecoveryEntry: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Story 53-4: Per-Story Retry Budget Gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
    // Set up conflict detector to work with storyKey '53-4'
    mockDetectConflictGroups.mockReturnValue({ batches: [[['53-4']]], edges: [] })
  })

  // -------------------------------------------------------------------------
  // AC5, AC7: Default retryBudget is 2 — escalation after 2 retries
  // -------------------------------------------------------------------------

  it('AC5, AC7: escalates with retry_budget_exhausted when default budget (2) is exhausted', async () => {
    const storyKey = '53-4'
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    // Always return NEEDS_MAJOR_REWORK so retries keep happening
    mockRunCodeReview.mockResolvedValue(makeCodeReviewNeedsMajorRework())

    const eventBus = createMockEventBus()

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus,
      config: defaultConfig(), // no retryBudget → defaults to 2
    })

    const status = await orchestrator.run([storyKey])

    // Story should be escalated due to retry budget exhaustion
    expect(status.stories[storyKey]?.phase).toBe('ESCALATED')
    expect(status.stories[storyKey]?.error).toBe('retry_budget_exhausted')

    // Verify escalation event was emitted
    const escalationCalls = vi
      .mocked(eventBus.emit)
      .mock.calls.filter((call) => call[0] === 'orchestrator:story-escalated')
    expect(escalationCalls.length).toBeGreaterThan(0)
    const lastEscalation = escalationCalls[escalationCalls.length - 1]
    expect(lastEscalation[1]).toMatchObject({
      storyKey,
      lastVerdict: 'retry_budget_exhausted',
    })

    // With budget=2: code review called 3 times (initial + 2 retries that pass gate)
    // At 3rd code review start (reviewCycles=2), gate passes (retry_count=1 < 2)
    // Then fix dispatched, reviewCycles++ → 3
    // At reviewCycles=3: gate checks retry_count=2 >= 2 → escalate
    // So code review should be called exactly 3 times
    expect(mockRunCodeReview).toHaveBeenCalledTimes(3)
  })

  // -------------------------------------------------------------------------
  // AC5: Custom retryBudget = 1 — escalation after 1 retry
  // -------------------------------------------------------------------------

  it('AC5: escalates after 1 retry when retryBudget: 1 is set', async () => {
    const storyKey = '53-4'
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewNeedsMajorRework())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig({ retryBudget: 1 }),
    })

    const status = await orchestrator.run([storyKey])

    expect(status.stories[storyKey]?.phase).toBe('ESCALATED')
    expect(status.stories[storyKey]?.error).toBe('retry_budget_exhausted')

    // With budget=1: code review called 2 times (initial + 1 retry that passes gate)
    // At reviewCycles=1: gate passes (retry_count=0 < 1), increment, code review
    // Fix dispatched, reviewCycles++ → 2
    // At reviewCycles=2: gate checks retry_count=1 >= 1 → escalate (no 3rd review)
    expect(mockRunCodeReview).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // AC5: retryBudget: 0 disallows retries — but budget must be ≥ 1 per schema.
  // With retryBudget: 1 after 0 retries from manifest, first retry is allowed.
  // Test that retry_count = 0 allows the retry to proceed.
  // -------------------------------------------------------------------------

  it('AC5: retry_count = 0 (initial state) allows the first retry to proceed', async () => {
    const storyKey = '53-4'
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    // Return NEEDS_MAJOR_REWORK once, then SHIP_IT (so story completes after 1 retry)
    mockRunCodeReview
      .mockResolvedValueOnce(makeCodeReviewNeedsMajorRework())
      .mockResolvedValueOnce(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig({ retryBudget: 2 }),
    })

    const status = await orchestrator.run([storyKey])

    // Story completes successfully — budget gate allowed the retry
    expect(status.stories[storyKey]?.phase).toBe('COMPLETE')
    expect(mockRunCodeReview).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // AC5: retry_count = 1, retryBudget = 2 — one more retry allowed then blocked
  // -------------------------------------------------------------------------

  it('AC5: retry_count = 1 with retryBudget = 2 allows one more retry before escalating', async () => {
    const storyKey = '53-4'
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    // Return NEEDS_MAJOR_REWORK on all reviews — budget gate will block at retry_count=2
    mockRunCodeReview.mockResolvedValue(makeCodeReviewNeedsMajorRework())

    // Mock manifest with retry_count = 1 from a previous session (AC6)
    const mockManifest = createMockRunManifest({ [storyKey]: 1 })

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig({ retryBudget: 2 }),
      // Pass the mock manifest so initRetryCount reads retry_count = 1
      runManifest: mockManifest as unknown as import('@substrate-ai/sdlc').RunManifest,
    })

    const status = await orchestrator.run([storyKey])

    expect(status.stories[storyKey]?.phase).toBe('ESCALATED')
    expect(status.stories[storyKey]?.error).toBe('retry_budget_exhausted')

    // With manifest retry_count = 1 and budget = 2:
    // reviewCycles=0: no gate, initial code review (NEEDS_MAJOR_REWORK)
    // reviewCycles=1: gate checks current=1 < 2 → allowed, increment → 2, code review (NEEDS_MAJOR_REWORK)
    // reviewCycles=2: gate checks current=2 >= 2 → escalate
    // So code review called 2 times
    expect(mockRunCodeReview).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // AC6: Crash recovery — reads retry_count from manifest on story start
  // -------------------------------------------------------------------------

  it('AC6: reads retry_count from manifest on story start for crash-recovery durability', async () => {
    const storyKey = '53-4'
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewNeedsMajorRework())

    // Simulate previous session already exhausted all retries (retry_count = 2 with budget = 2)
    const mockManifest = createMockRunManifest({ [storyKey]: 2 })

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig({ retryBudget: 2 }),
      runManifest: mockManifest as unknown as import('@substrate-ai/sdlc').RunManifest,
    })

    const status = await orchestrator.run([storyKey])

    // Should escalate immediately after the first code review fails
    // (budget already exhausted from previous session)
    expect(status.stories[storyKey]?.phase).toBe('ESCALATED')
    expect(status.stories[storyKey]?.error).toBe('retry_budget_exhausted')

    // Manifest read() should have been called to initialize retry count
    expect(mockManifest.read).toHaveBeenCalled()

    // Code review called once (initial), then gate immediately blocks at reviewCycles=1
    expect(mockRunCodeReview).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // AC4: retry_count is incremented on each retry (patchStoryState called)
  // -------------------------------------------------------------------------

  it('AC4: patchStoryState(retry_count) is called with incremented values on each retry', async () => {
    const storyKey = '53-4'
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    // Two retries before budget exhausted (retryBudget = 2, budget at reviewCycles=3)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewNeedsMajorRework())

    const mockManifest = createMockRunManifest({})

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: defaultConfig({ retryBudget: 2 }),
      runManifest: mockManifest as unknown as import('@substrate-ai/sdlc').RunManifest,
    })

    await orchestrator.run([storyKey])

    // patchStoryState should have been called with retry_count: 1 then retry_count: 2
    const retryCountCalls = vi
      .mocked(mockManifest.patchStoryState)
      .mock.calls.filter(
        (call) => typeof (call[1] as Record<string, unknown>)?.retry_count === 'number'
      )
    expect(retryCountCalls.length).toBeGreaterThanOrEqual(2)

    // First call: retry_count: 1
    expect(retryCountCalls[0][1]).toMatchObject({ retry_count: 1 })
    // Second call: retry_count: 2
    expect(retryCountCalls[1][1]).toMatchObject({ retry_count: 2 })
  })

  // -------------------------------------------------------------------------
  // AC5: escalation event carries retryBudget and retry_count in payload
  // -------------------------------------------------------------------------

  it('AC5: escalation event message includes retry_count and retryBudget context', async () => {
    const storyKey = '53-4'
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewNeedsMajorRework())

    const eventBus = createMockEventBus()

    const orchestrator = createImplementationOrchestrator({
      db: createMockDb(),
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus,
      config: defaultConfig({ retryBudget: 1 }),
    })

    await orchestrator.run([storyKey])

    const escalationCalls = vi
      .mocked(eventBus.emit)
      .mock.calls.filter((call) => call[0] === 'orchestrator:story-escalated')
    expect(escalationCalls.length).toBeGreaterThan(0)

    const escalationPayload = escalationCalls[escalationCalls.length - 1][1] as {
      storyKey: string
      lastVerdict: string
      reviewCycles: number
      issues: string[]
      retryBudget?: number
      retryCount?: number
    }
    expect(escalationPayload.storyKey).toBe(storyKey)
    expect(escalationPayload.lastVerdict).toBe('retry_budget_exhausted')
    // Issues should mention budget context
    expect(Array.isArray(escalationPayload.issues)).toBe(true)
    const issueText = escalationPayload.issues.join(' ')
    expect(issueText).toContain('retry')
    expect(issueText).toContain('budget')
    // AC5: named fields must be present for downstream consumers (Story 53-4)
    expect(escalationPayload.retryBudget).toBe(1)
    expect(escalationPayload.retryCount).toBe(1)
  })
})
