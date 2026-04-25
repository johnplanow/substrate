/**
 * Unit tests for Story 39-5 (checkpoint capture) and Story 39-6 (checkpoint retry).
 *
 * Story 39-5 covers:
 *   AC1: Timeout with partial files → checkpoint context captured
 *   AC2: Timeout with partial files → story phase set to CHECKPOINT (transiently)
 *   AC3: Timeout with zero files → story escalated immediately (no checkpoint)
 *   AC4: story:checkpoint-saved event emitted with correct payload
 *   AC6: dispatch_log records timeout via stateStore.recordMetric
 *
 * Story 39-6 covers:
 *   AC1: CHECKPOINT story dispatches retry with checkpoint context
 *   AC2: Retry prompt includes git diff and "continue from where you left off"
 *   AC3: Retry uses same dev-story taskType (same timeout budget)
 *   AC4: Second timeout → story ESCALATED (no infinite retry loop)
 *   AC5: Successful retry → proceeds to code review as normal
 *   AC6: story:checkpoint-retry event emitted with correct payload
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import type { StateStore } from '../../state/index.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../compiled-workflows/create-story.js', () => ({
  runCreateStory: vi.fn(),
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
// checkGitDiffFiles is controlled per-test
vi.mock('../../agent-dispatch/dispatcher-impl.js', () => ({
  runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
  checkGitDiffFiles: vi.fn().mockReturnValue([]),
}))
vi.mock('../../agent-dispatch/interface-change-detector.js', () => ({
  detectInterfaceChanges: vi.fn().mockReturnValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] }),
}))
// execSync controlled per-test for git diff capture
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue(''),
  }
})

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
import { checkGitDiffFiles } from '../../agent-dispatch/dispatcher-impl.js'
import { execSync } from 'node:child_process'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)
const mockCheckGitDiffFiles = vi.mocked(checkGitDiffFiles)
const mockExecSync = vi.mocked(execSync)

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

function createTimeoutDispatchHandle(): DispatchHandle & { result: Promise<DispatchResult<unknown>> } {
  const timeoutResult: DispatchResult<unknown> = {
    id: 'test-timeout-dispatch',
    status: 'timeout',
    exitCode: 1,
    output: '',
    parsed: null,
    parseError: null,
    durationMs: 1_800_000,
    tokenEstimate: { input: 10, output: 0 },
  }
  return {
    id: 'test-timeout-dispatch',
    status: 'timeout',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: Promise.resolve(timeoutResult),
  }
}

function createMockEventBus(): TypedEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

function createMockStateStore(): StateStore {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getStoryState: vi.fn().mockResolvedValue(undefined),
    setStoryState: vi.fn().mockResolvedValue(undefined),
    queryStories: vi.fn().mockResolvedValue([]),
    recordMetric: vi.fn().mockResolvedValue(undefined),
    queryMetrics: vi.fn().mockResolvedValue([]),
    setMetric: vi.fn().mockResolvedValue(undefined),
    getMetric: vi.fn().mockResolvedValue(undefined),
    getContracts: vi.fn().mockResolvedValue([]),
    setContracts: vi.fn().mockResolvedValue(undefined),
    queryContracts: vi.fn().mockResolvedValue([]),
    setContractVerification: vi.fn().mockResolvedValue(undefined),
    getContractVerification: vi.fn().mockResolvedValue([]),
    branchForStory: vi.fn().mockResolvedValue(undefined),
    mergeStory: vi.fn().mockResolvedValue(undefined),
    rollbackStory: vi.fn().mockResolvedValue(undefined),
    diffStory: vi.fn().mockResolvedValue({ storyKey: '', tables: [] }),
    getHistory: vi.fn().mockResolvedValue([]),
  }
}

function defaultConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    maxConcurrency: 1,
    maxReviewCycles: 2,
    pipelineRunId: 'test-run-checkpoint',
    gcPauseMs: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Dev-story result factories
// ---------------------------------------------------------------------------

function makeDevStoryTimeout(durationMs = 1_800_000) {
  return {
    result: 'failed' as const,
    ac_met: [],
    ac_failures: [],
    files_modified: [],
    tests: 'fail' as const,
    error: `dispatch_timeout after ${durationMs}ms`,
    tokenUsage: { input: 50, output: 10 },
  }
}

function makeCreateStorySuccess(storyKey = '39-5') {
  return {
    result: 'success' as const,
    story_file: `/path/to/${storyKey}.md`,
    story_key: storyKey,
    story_title: 'Checkpoint Test Story',
    tokenUsage: { input: 100, output: 50 },
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

describe('dev-story timeout checkpoint (Story 39-5)', () => {
  let db: DatabaseAdapter
  let pack: MethodologyPack
  let contextCompiler: ContextCompiler
  let dispatcher: Dispatcher
  let eventBus: TypedEventBus
  let stateStore: StateStore
  let config: OrchestratorConfig

  beforeEach(() => {
    vi.clearAllMocks()
    db = createMockDb()
    pack = createMockPack()
    contextCompiler = createMockContextCompiler()
    dispatcher = createMockDispatcher()
    eventBus = createMockEventBus()
    stateStore = createMockStateStore()
    config = defaultConfig()

    mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
    // Default: execSync returns git diff content
    mockExecSync.mockReturnValue('diff --git a/src/foo.ts b/src/foo.ts\n+added line\n')
    // Default: code review returns SHIP_IT so tests that proceed past checkpoint don't crash
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
  })

  // -------------------------------------------------------------------------
  // AC2: Timeout with partial files → story checkpoint is captured (transiently)
  // With Story 39-6, the story proceeds to retry and eventually COMPLETE.
  // -------------------------------------------------------------------------

  it('AC2: checkpoint-saved event is emitted when timeout has partial files', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-5'))
    mockRunDevStory.mockResolvedValue(makeDevStoryTimeout())
    mockCheckGitDiffFiles.mockReturnValue(['src/foo.ts', 'src/bar.ts'])

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    await orchestrator.run(['39-5'])

    // Checkpoint was captured (event emitted) — CHECKPOINT phase set transiently
    const emitCalls = vi.mocked(eventBus.emit).mock.calls
    const checkpointEvent = emitCalls.find(([eventName]) => eventName === 'story:checkpoint-saved')
    expect(checkpointEvent).toBeDefined()
    expect(checkpointEvent![1]).toMatchObject({ storyKey: '39-5', filesCount: 2 })
  })

  // -------------------------------------------------------------------------
  // AC3: Timeout with zero files → escalated immediately
  // -------------------------------------------------------------------------

  it('AC3: escalates immediately when timeout has no partial files', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-5'))
    mockRunDevStory.mockResolvedValue(makeDevStoryTimeout())
    // No files modified — nothing to checkpoint
    mockCheckGitDiffFiles.mockReturnValue([])

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    const status = await orchestrator.run(['39-5'])

    expect(status.stories['39-5']?.phase).toBe('ESCALATED')
    expect(status.stories['39-5']?.error).toBe('timeout-no-files')
  })

  // -------------------------------------------------------------------------
  // AC4: story:checkpoint-saved event emitted with correct payload
  // -------------------------------------------------------------------------

  it('AC4: emits story:checkpoint-saved event with correct payload when files exist', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-5'))
    mockRunDevStory.mockResolvedValue(makeDevStoryTimeout())
    mockCheckGitDiffFiles.mockReturnValue(['src/foo.ts', 'src/bar.ts'])

    const gitDiffContent = 'diff --git a/src/foo.ts b/src/foo.ts\n+added line\n'
    mockExecSync.mockReturnValue(gitDiffContent)

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    await orchestrator.run(['39-5'])

    const emitCalls = vi.mocked(eventBus.emit).mock.calls
    const checkpointEvent = emitCalls.find(([eventName]) => eventName === 'story:checkpoint-saved')

    expect(checkpointEvent).toBeDefined()
    const [, payload] = checkpointEvent!
    expect(payload).toMatchObject({
      storyKey: '39-5',
      filesCount: 2,
    })
    expect((payload as { diffSizeBytes: number }).diffSizeBytes).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // AC4: no checkpoint event when zero files
  // -------------------------------------------------------------------------

  it('AC4: does NOT emit story:checkpoint-saved when timeout has no files', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-5'))
    mockRunDevStory.mockResolvedValue(makeDevStoryTimeout())
    mockCheckGitDiffFiles.mockReturnValue([])

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    await orchestrator.run(['39-5'])

    const emitCalls = vi.mocked(eventBus.emit).mock.calls
    const checkpointEvent = emitCalls.find(([eventName]) => eventName === 'story:checkpoint-saved')
    expect(checkpointEvent).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // AC6: dispatch_log records timeout via stateStore.recordMetric
  // -------------------------------------------------------------------------

  it('AC6: records timeout metric in StateStore when checkpoint is captured', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-5'))
    mockRunDevStory.mockResolvedValue(makeDevStoryTimeout())
    mockCheckGitDiffFiles.mockReturnValue(['src/foo.ts'])

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    await orchestrator.run(['39-5'])

    const recordMetricCalls = vi.mocked(stateStore.recordMetric).mock.calls
    const timeoutCall = recordMetricCalls.find(
      ([metric]) => metric.result === 'timeout' && metric.taskType === 'dev-story',
    )
    expect(timeoutCall).toBeDefined()
    expect(timeoutCall![0]).toMatchObject({
      storyKey: '39-5',
      taskType: 'dev-story',
      result: 'timeout',
    })
  })

  // -------------------------------------------------------------------------
  // AC5: CHECKPOINT phase stores filesCount for status display
  // With Story 39-6, CHECKPOINT is set transiently — the stateStore call
  // persists checkpointFilesCount even though the final phase changes.
  // -------------------------------------------------------------------------

  it('AC5: stateStore.setStoryState receives checkpointFilesCount when persisting CHECKPOINT', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-5'))
    mockRunDevStory.mockResolvedValue(makeDevStoryTimeout())
    mockCheckGitDiffFiles.mockReturnValue(['src/alpha.ts', 'src/beta.ts'])

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    await orchestrator.run(['39-5'])

    const setStoryCalls = vi.mocked(stateStore.setStoryState).mock.calls
    const checkpointCall = setStoryCalls.find(([, record]) => record.phase === 'CHECKPOINT')
    expect(checkpointCall).toBeDefined()
    expect(checkpointCall![1]).toMatchObject({
      storyKey: '39-5',
      phase: 'CHECKPOINT',
      checkpointFilesCount: 2,
    })
  })

  // -------------------------------------------------------------------------
  // Non-timeout failures still proceed to code review (regression guard)
  // -------------------------------------------------------------------------

  it('non-timeout failures are not treated as checkpoints', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-5'))
    mockRunDevStory.mockResolvedValue({
      result: 'failed' as const,
      ac_met: [],
      ac_failures: [],
      files_modified: [],
      tests: 'fail' as const,
      error: 'some_other_error',
      tokenUsage: { input: 50, output: 10 },
    })
    // Files exist on disk — but this is not a timeout
    mockCheckGitDiffFiles.mockReturnValue(['src/foo.ts'])
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    const finalStatus = await orchestrator.run(['39-5'])

    // Story should NOT be in CHECKPOINT — non-timeout failure proceeds to code review
    expect(finalStatus.stories['39-5']?.phase).not.toBe('CHECKPOINT')

    const emitCalls = vi.mocked(eventBus.emit).mock.calls
    const checkpointEvent = emitCalls.find(([eventName]) => eventName === 'story:checkpoint-saved')
    expect(checkpointEvent).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Story 39-6: Checkpoint retry
// ---------------------------------------------------------------------------

describe('checkpoint retry (Story 39-6)', () => {
  let db: DatabaseAdapter
  let pack: MethodologyPack
  let contextCompiler: ContextCompiler
  let dispatcher: Dispatcher
  let eventBus: TypedEventBus
  let stateStore: StateStore
  let config: OrchestratorConfig

  beforeEach(() => {
    vi.clearAllMocks()
    db = createMockDb()
    pack = createMockPack()
    contextCompiler = createMockContextCompiler()
    dispatcher = createMockDispatcher()
    eventBus = createMockEventBus()
    stateStore = createMockStateStore()
    config = defaultConfig({ pipelineRunId: 'test-run-39-6', gcPauseMs: 0 })

    mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
    mockExecSync.mockReturnValue('diff --git a/src/partial.ts b/src/partial.ts\n+added line\n')
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
  })

  // -------------------------------------------------------------------------
  // AC1: CHECKPOINT story dispatches a retry via dispatcher.dispatch
  // -------------------------------------------------------------------------

  it('AC1: dispatches checkpoint retry when timeout has partial files', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-6'))
    mockRunDevStory.mockResolvedValue(makeDevStoryTimeout())
    mockCheckGitDiffFiles.mockReturnValue(['src/partial.ts'])

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    await orchestrator.run(['39-6'])

    // dispatcher.dispatch should have been called for the checkpoint retry
    expect(vi.mocked(dispatcher.dispatch)).toHaveBeenCalled()
    const dispatchCalls = vi.mocked(dispatcher.dispatch).mock.calls
    const retryCall = dispatchCalls.find(([req]) => req.taskType === 'dev-story')
    expect(retryCall).toBeDefined()
    expect(retryCall![0]).toMatchObject({
      agent: 'claude-code',
      taskType: 'dev-story',
      storyKey: '39-6',
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Retry prompt includes partial work context
  // -------------------------------------------------------------------------

  it('AC2: retry prompt includes "Your prior attempt timed out" and "Continue from where you left off"', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-6'))
    mockRunDevStory.mockResolvedValue(makeDevStoryTimeout())
    mockCheckGitDiffFiles.mockReturnValue(['src/partial.ts'])

    const gitDiff = 'diff --git a/src/partial.ts b/src/partial.ts\n+added line\n'
    mockExecSync.mockReturnValue(gitDiff)

    // readFile may be called multiple times (contracts, complexity, retry prompt assembly).
    // Use mockResolvedValue (not Once) so the mock is order-independent and robust to
    // future additions or reorderings of readFile calls in the orchestrator.
    const { readFile } = await import('node:fs/promises')
    vi.mocked(readFile).mockResolvedValue('# Story 39-6 story content' as unknown as Buffer)
    // Override getPrompt to return a template with placeholders so sections are injected
    vi.mocked(pack.getPrompt).mockResolvedValueOnce('{{story_content}}\n{{checkpoint_context}}\n{{arch_constraints}}')

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    await orchestrator.run(['39-6'])

    const dispatchCalls = vi.mocked(dispatcher.dispatch).mock.calls
    const retryCall = dispatchCalls.find(([req]) => req.taskType === 'dev-story')
    expect(retryCall).toBeDefined()

    const prompt = retryCall![0].prompt
    expect(prompt).toContain('Your prior attempt timed out')
    expect(prompt).toContain('Continue from where you left off')
  })

  // -------------------------------------------------------------------------
  // AC3: Retry uses dev-story taskType (same timeout budget)
  // -------------------------------------------------------------------------

  it('AC3: retry dispatch uses taskType dev-story (same timeout as original)', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-6'))
    mockRunDevStory.mockResolvedValue(makeDevStoryTimeout())
    mockCheckGitDiffFiles.mockReturnValue(['src/partial.ts'])

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    await orchestrator.run(['39-6'])

    const dispatchCalls = vi.mocked(dispatcher.dispatch).mock.calls
    const retryCall = dispatchCalls.find(([req]) => req.taskType === 'dev-story')
    expect(retryCall).toBeDefined()
    expect(retryCall![0].taskType).toBe('dev-story')
  })

  // -------------------------------------------------------------------------
  // AC4: Second timeout → ESCALATED (no infinite retry loop)
  // -------------------------------------------------------------------------

  it('AC4: retry timeout escalates the story — no infinite retry loop', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-6'))
    mockRunDevStory.mockResolvedValue(makeDevStoryTimeout())
    mockCheckGitDiffFiles.mockReturnValue(['src/partial.ts'])

    // Make the retry dispatch also time out
    vi.mocked(dispatcher.dispatch).mockReturnValueOnce(createTimeoutDispatchHandle())

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    const status = await orchestrator.run(['39-6'])

    expect(status.stories['39-6']?.phase).toBe('ESCALATED')
    expect(status.stories['39-6']?.error).toBe('checkpoint-retry-timeout')
    // Code review should NOT be called when retry times out
    expect(mockRunCodeReview).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC5: Successful retry → proceeds to code review as normal
  // -------------------------------------------------------------------------

  it('AC5: successful retry proceeds to code review', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-6'))
    mockRunDevStory.mockResolvedValue(makeDevStoryTimeout())
    mockCheckGitDiffFiles.mockReturnValue(['src/partial.ts'])
    // dispatcher.dispatch default returns completed — retry succeeds

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    const status = await orchestrator.run(['39-6'])

    // Code review was called after the retry
    expect(mockRunCodeReview).toHaveBeenCalled()
    // Story completes (SHIP_IT from code review mock)
    expect(status.stories['39-6']?.phase).toBe('COMPLETE')
  })

  // -------------------------------------------------------------------------
  // AC6: story:checkpoint-retry event emitted with correct payload
  // -------------------------------------------------------------------------

  it('AC6: emits story:checkpoint-retry event with correct payload', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-6'))
    mockRunDevStory.mockResolvedValue(makeDevStoryTimeout())
    mockCheckGitDiffFiles.mockReturnValue(['src/partial.ts', 'src/other.ts'])

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    await orchestrator.run(['39-6'])

    const emitCalls = vi.mocked(eventBus.emit).mock.calls
    const retryEvent = emitCalls.find(([eventName]) => eventName === 'story:checkpoint-retry')

    expect(retryEvent).toBeDefined()
    const [, payload] = retryEvent!
    expect(payload).toMatchObject({
      storyKey: '39-6',
      filesCount: 2,
      attempt: 2,
    })
  })

  // -------------------------------------------------------------------------
  // AC6 companion: retry failure proceeds to code review (not escalation)
  // -------------------------------------------------------------------------

  it('retry failure still proceeds to code review (reviewer assesses partial work)', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('39-6'))
    mockRunDevStory.mockResolvedValue(makeDevStoryTimeout())
    mockCheckGitDiffFiles.mockReturnValue(['src/partial.ts'])

    // Retry dispatch fails (non-timeout)
    const failedResult: DispatchResult<unknown> = {
      id: 'test-failed-dispatch',
      status: 'failed',
      exitCode: 1,
      output: 'agent exited non-zero',
      parsed: null,
      parseError: null,
      durationMs: 100,
      tokenEstimate: { input: 10, output: 0 },
    }
    const failedHandle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
      id: 'test-failed-dispatch',
      status: 'failed',
      cancel: vi.fn().mockResolvedValue(undefined),
      result: Promise.resolve(failedResult),
    }
    vi.mocked(dispatcher.dispatch).mockReturnValueOnce(failedHandle)

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config, stateStore,
    })

    const status = await orchestrator.run(['39-6'])

    // Code review should be called even when retry fails
    expect(mockRunCodeReview).toHaveBeenCalled()
    // Story completes (SHIP_IT from code review mock)
    expect(status.stories['39-6']?.phase).toBe('COMPLETE')
  })
})
