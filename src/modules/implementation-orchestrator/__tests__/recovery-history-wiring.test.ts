/**
 * Unit tests for recovery history manifest wiring in the implementation
 * orchestrator — Story 52-8.
 *
 * Covers AC5: appendRecoveryEntry is called on retry dispatch (non-fatal,
 * best-effort), not called on initial dispatch, and null runManifest is safe.
 *
 * Uses mock RunManifest via plain vi.fn() — no real file I/O in orchestrator
 * unit tests (same pattern as per-story-state-wiring.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'
import type { RunManifest } from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Module mocks (must appear before any imports that use them)
// ---------------------------------------------------------------------------

vi.mock('../../compiled-workflows/create-story.js', () => ({
  runCreateStory: vi.fn(),
  isValidStoryFile: vi.fn().mockResolvedValue({ valid: false, reason: 'not-found' }),
  extractStorySection: vi.fn().mockReturnValue(null),
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
  readFileSync: vi.fn().mockReturnValue(''),
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
vi.mock('@substrate-ai/sdlc', () => ({
  createDefaultVerificationPipeline: vi.fn(() => ({
    run: vi.fn().mockResolvedValue({ storyKey: '5-1', checks: [], status: 'pass', duration_ms: 0 }),
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

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)

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
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
}

function defaultConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    maxConcurrency: 1,
    maxReviewCycles: 3,  // allow 2 fix dispatches before escalation
    pipelineRunId: 'test-run-id',
    gcPauseMs: 0,
    ...overrides,
  }
}

function makeCreateStorySuccess(storyKey = '5-1') {
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

function makeCodeReviewNeedsMinorFixes() {
  return {
    verdict: 'NEEDS_MINOR_FIXES' as const,
    issues: 1,
    issue_list: [{ severity: 'minor', description: 'missing doc comment', file: 'src/foo.ts' }],
    tokenUsage: { input: 150, output: 50 },
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

/**
 * Build a minimal mock RunManifest with tracked spies for both
 * patchStoryState and appendRecoveryEntry.
 */
function createMockRunManifest(): {
  mock: RunManifest
  patchSpy: ReturnType<typeof vi.fn>
  appendSpy: ReturnType<typeof vi.fn>
} {
  const patchSpy = vi.fn().mockResolvedValue(undefined)
  const appendSpy = vi.fn().mockResolvedValue(undefined)
  const mock = {
    patchStoryState: patchSpy,
    appendRecoveryEntry: appendSpy,
  } as unknown as RunManifest
  return { mock, patchSpy, appendSpy }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Orchestrator recovery history wiring (Story 52-8, AC5)', () => {
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

    mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
  })

  // -------------------------------------------------------------------------
  // AC5: appendRecoveryEntry called on retry with correct fields
  // -------------------------------------------------------------------------

  it('AC5: appendRecoveryEntry is called with outcome=retried and attempt_number>=1 when story is retried', async () => {
    const { mock: runManifest, appendSpy } = createMockRunManifest()

    // First review returns NEEDS_MINOR_FIXES → triggers fix dispatch (retry)
    // Second review returns SHIP_IT → story completes
    mockRunCodeReview
      .mockResolvedValueOnce(makeCodeReviewNeedsMinorFixes())
      .mockResolvedValueOnce(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    await orchestrator.run(['5-1'])

    // appendRecoveryEntry should have been called once (on the fix dispatch)
    expect(appendSpy).toHaveBeenCalledTimes(1)
    const [entry] = appendSpy.mock.calls[0]!
    expect(entry).toMatchObject({
      story_key: '5-1',
      outcome: 'retried',
      strategy: 'retry-with-context',
    })
    // attempt_number should be >= 1 (1-indexed retry count)
    expect(entry.attempt_number).toBeGreaterThanOrEqual(1)
    // timestamp must be a valid ISO-8601 string
    expect(typeof entry.timestamp).toBe('string')
    expect(new Date(entry.timestamp).getTime()).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // AC5: appendRecoveryEntry NOT called on initial dispatch
  // -------------------------------------------------------------------------

  it('AC5: appendRecoveryEntry is NOT called on the initial (first) dispatch of a story', async () => {
    const { mock: runManifest, appendSpy } = createMockRunManifest()

    // Story ships on first review — no retry needed
    mockRunCodeReview.mockResolvedValueOnce(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    await orchestrator.run(['5-1'])

    // No retry occurred — appendRecoveryEntry must not have been called
    expect(appendSpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC5: appendRecoveryEntry throws — orchestrator does not throw
  // -------------------------------------------------------------------------

  it('AC5: orchestrator does not throw when appendRecoveryEntry throws', async () => {
    const appendSpy = vi.fn().mockRejectedValue(new Error('disk full'))
    const patchSpy = vi.fn().mockResolvedValue(undefined)
    const runManifest = {
      patchStoryState: patchSpy,
      appendRecoveryEntry: appendSpy,
    } as unknown as RunManifest

    // First review: NEEDS_MINOR_FIXES → retry → appendRecoveryEntry throws
    // Second review: SHIP_IT → story completes normally
    mockRunCodeReview
      .mockResolvedValueOnce(makeCodeReviewNeedsMinorFixes())
      .mockResolvedValueOnce(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, runManifest,
    })

    // Orchestrator must not throw even though appendRecoveryEntry always rejects
    await expect(orchestrator.run(['5-1'])).resolves.toMatchObject({ state: 'COMPLETE' })

    // appendRecoveryEntry was called but its rejection was swallowed
    expect(appendSpy).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC5: null runManifest — orchestrator retries without error
  // -------------------------------------------------------------------------

  it('AC5: orchestrator retries story normally when runManifest is null', async () => {
    // First review: NEEDS_MINOR_FIXES → fix dispatch
    // Second review: SHIP_IT → story completes
    mockRunCodeReview
      .mockResolvedValueOnce(makeCodeReviewNeedsMinorFixes())
      .mockResolvedValueOnce(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
      runManifest: null,
    })

    // Should complete normally with no manifest writes attempted
    const status = await orchestrator.run(['5-1'])
    expect(status.state).toBe('COMPLETE')
    expect(status.stories['5-1']?.phase).toBe('COMPLETE')
  })
})
