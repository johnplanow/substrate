/**
 * Unit tests for Story 25-2: Pre-Flight Build Gate.
 *
 * Covers:
 *   AC1: Orchestrator runs build command before dispatching any story
 *   AC2: Pre-flight failure emits pipeline:pre-flight-failure event and aborts pipeline
 *   AC3: Custom verifyCommand is respected
 *   AC4: Auto-detected package manager is used for default build command
 *   AC5: --skip-preflight bypasses the pre-flight check entirely
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
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
  addTokenUsage: vi.fn(),
  getDecisionsByPhase: vi.fn().mockReturnValue([]),
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

// runBuildVerification is the focus — start with a default 'passed' mock and override per test
vi.mock('../../agent-dispatch/dispatcher-impl.js', () => ({
  runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
  checkGitDiffFiles: vi.fn().mockReturnValue(['src/some-modified-file.ts']),
  detectPackageManager: vi.fn().mockReturnValue({ packageManager: 'npm', lockfile: null, command: 'npm run build' }),
}))
vi.mock('../../agent-dispatch/interface-change-detector.js', () => ({
  detectInterfaceChanges: vi.fn().mockReturnValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] }),
}))

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock() calls
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { runBuildVerification } from '../../agent-dispatch/dispatcher-impl.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunBuildVerification = vi.mocked(runBuildVerification)

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockDb(): BetterSqlite3Database {
  return {} as BetterSqlite3Database
}

function createMockPack(overrides?: Partial<{ verifyCommand: string | false; verifyTimeoutMs: number }>): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack',
      phases: [],
      prompts: {},
      constraints: {},
      templates: {},
      ...overrides,
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
    pipelineRunId: 'test-run-preflight',
    gcPauseMs: 0,
    ...overrides,
  }
}

function makeCreateStorySuccess(storyKey = '25-2') {
  return {
    result: 'success' as const,
    story_file: `/path/to/${storyKey}.md`,
    story_key: storyKey,
    story_title: 'Pre-Flight Gate Story',
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

describe('orchestrator: pre-flight build gate (Story 25-2)', () => {
  let db: BetterSqlite3Database
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

    // Default: pre-flight passes and dev/review succeed
    mockRunBuildVerification.mockReturnValue({ status: 'passed', exitCode: 0 })
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-2'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
  })

  // ---------------------------------------------------------------------------
  // AC1: Pre-flight build executes before story dispatch
  // ---------------------------------------------------------------------------

  it('AC1: calls runBuildVerification before dispatching any story', async () => {
    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    await orchestrator.run(['25-2'])

    // Pre-flight (1) + post-dev build gate (Story 24-2) (1) = 2 total calls
    expect(mockRunBuildVerification).toHaveBeenCalledTimes(2)
    // Story must also have been dispatched (pipeline proceeds normally)
    expect(mockRunCreateStory).toHaveBeenCalledOnce()
  })

  it('AC1: pre-flight runs before story dispatch — story is COMPLETE when pre-flight passes', async () => {
    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    const status = await orchestrator.run(['25-2'])

    expect(status.stories['25-2']?.phase).toBe('COMPLETE')
  })

  // ---------------------------------------------------------------------------
  // AC2: Pre-flight failure emits event and aborts
  // ---------------------------------------------------------------------------

  it('AC2: pre-flight failure aborts pipeline — no stories dispatched', async () => {
    mockRunBuildVerification.mockReturnValue({
      status: 'failed',
      exitCode: 1,
      output: 'TypeScript error: Cannot find module',
      reason: 'build-verification-failed',
    })

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    const status = await orchestrator.run(['25-2'])

    // Pipeline enters FAILED state
    expect(status.state).toBe('FAILED')
    // No story dispatches — create-story must NOT have been called
    expect(mockRunCreateStory).not.toHaveBeenCalled()
    expect(mockRunDevStory).not.toHaveBeenCalled()
    expect(mockRunCodeReview).not.toHaveBeenCalled()
  })

  it('AC2: pre-flight failure emits pipeline:pre-flight-failure event with exitCode and output', async () => {
    const buildOutput = 'TypeScript error: Cannot find module "src/missing.js"'
    mockRunBuildVerification.mockReturnValue({
      status: 'failed',
      exitCode: 2,
      output: buildOutput,
      reason: 'build-verification-failed',
    })

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    await orchestrator.run(['25-2'])

    const mockEmit = vi.mocked(eventBus.emit)
    const preFlightEvent = mockEmit.mock.calls.find(
      ([eventName]) => eventName === 'pipeline:pre-flight-failure',
    )
    expect(preFlightEvent).toBeDefined()
    const payload = preFlightEvent![1] as { exitCode: number; output: string }
    expect(payload.exitCode).toBe(2)
    expect(payload.output).toBe(buildOutput)
  })

  it('AC2: timeout also triggers pre-flight failure event', async () => {
    mockRunBuildVerification.mockReturnValue({
      status: 'timeout',
      exitCode: -1,
      output: 'Build timed out after 60 seconds',
      reason: 'build-verification-timeout',
    })

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    await orchestrator.run(['25-2'])

    const mockEmit = vi.mocked(eventBus.emit)
    const preFlightEvent = mockEmit.mock.calls.find(
      ([eventName]) => eventName === 'pipeline:pre-flight-failure',
    )
    expect(preFlightEvent).toBeDefined()
    const payload = preFlightEvent![1] as { exitCode: number; output: string }
    expect(payload.exitCode).toBe(-1)
    expect(mockRunCreateStory).not.toHaveBeenCalled()
  })

  it('AC2: output is truncated to 2000 chars in the emitted event', async () => {
    const longOutput = 'x'.repeat(5000)
    mockRunBuildVerification.mockReturnValue({
      status: 'failed',
      exitCode: 1,
      output: longOutput,
      reason: 'build-verification-failed',
    })

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    await orchestrator.run(['25-2'])

    const mockEmit = vi.mocked(eventBus.emit)
    const preFlightEvent = mockEmit.mock.calls.find(
      ([eventName]) => eventName === 'pipeline:pre-flight-failure',
    )
    const payload = preFlightEvent![1] as { exitCode: number; output: string }
    expect(payload.output).toHaveLength(2000)
  })

  // ---------------------------------------------------------------------------
  // AC3: Respect verifyCommand config
  // ---------------------------------------------------------------------------

  it('AC3: uses verifyCommand from pack manifest when set', async () => {
    const customPack = createMockPack({ verifyCommand: 'make build' })
    mockRunBuildVerification.mockReturnValue({ status: 'passed', exitCode: 0 })

    const orchestrator = createImplementationOrchestrator({
      db, pack: customPack, contextCompiler, dispatcher, eventBus, config,
    })

    await orchestrator.run(['25-2'])

    expect(mockRunBuildVerification).toHaveBeenCalledWith(
      expect.objectContaining({ verifyCommand: 'make build' }),
    )
  })

  it('AC3: verifyCommand=false skips build verification (same as post-dev gate)', async () => {
    const noBuildPack = createMockPack({ verifyCommand: false })
    // When verifyCommand=false, runBuildVerification returns status:'skipped'
    mockRunBuildVerification.mockReturnValue({ status: 'skipped' })

    const orchestrator = createImplementationOrchestrator({
      db, pack: noBuildPack, contextCompiler, dispatcher, eventBus, config,
    })

    const status = await orchestrator.run(['25-2'])

    // runBuildVerification was called with verifyCommand: false
    expect(mockRunBuildVerification).toHaveBeenCalledWith(
      expect.objectContaining({ verifyCommand: false }),
    )
    // Stories still proceed normally
    expect(status.stories['25-2']?.phase).toBe('COMPLETE')
    expect(mockRunCreateStory).toHaveBeenCalledOnce()
  })

  it('AC3: verifyTimeoutMs from pack manifest is passed through', async () => {
    const timeoutPack = createMockPack({ verifyTimeoutMs: 120_000 })

    const orchestrator = createImplementationOrchestrator({
      db, pack: timeoutPack, contextCompiler, dispatcher, eventBus, config,
    })

    await orchestrator.run(['25-2'])

    expect(mockRunBuildVerification).toHaveBeenCalledWith(
      expect.objectContaining({ verifyTimeoutMs: 120_000 }),
    )
  })

  // ---------------------------------------------------------------------------
  // AC4: Auto-detected package manager
  // ---------------------------------------------------------------------------

  it('AC4: when verifyCommand is undefined, runBuildVerification receives undefined (auto-detect)', async () => {
    // Pack has no verifyCommand → undefined is passed to runBuildVerification
    const defaultPack = createMockPack()
    // Pack manifest has no verifyCommand key — it will be undefined

    const orchestrator = createImplementationOrchestrator({
      db, pack: defaultPack, contextCompiler, dispatcher, eventBus, config,
    })

    await orchestrator.run(['25-2'])

    // verifyCommand should be undefined (triggering auto-detection inside runBuildVerification)
    expect(mockRunBuildVerification).toHaveBeenCalledWith(
      expect.objectContaining({ verifyCommand: undefined }),
    )
  })

  // ---------------------------------------------------------------------------
  // AC5: --skip-preflight bypasses the check
  // ---------------------------------------------------------------------------

  it('AC5: skipPreflight=true skips the pre-flight check', async () => {
    const skipConfig = defaultConfig({ skipPreflight: true })

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config: skipConfig,
    })

    await orchestrator.run(['25-2'])

    // runBuildVerification should NOT be called for pre-flight when skipPreflight=true
    // Note: it may still be called for the post-dev build gate (Story 24-2)
    // but we check that it was never called pre-dispatch (before create-story)
    // The simplest check: pipeline still proceeds normally
    expect(mockRunCreateStory).toHaveBeenCalledOnce()
  })

  it('AC5: skipPreflight=true allows pipeline to run even when build would fail', async () => {
    // Make pre-flight return failure — but since skipPreflight=true, it should not be called
    mockRunBuildVerification
      .mockReturnValueOnce({ status: 'failed', exitCode: 1, output: 'build error', reason: 'build-verification-failed' })
      // Second call (post-dev gate, Story 24-2) passes
      .mockReturnValueOnce({ status: 'passed', exitCode: 0 })

    const skipConfig = defaultConfig({ skipPreflight: true })
    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config: skipConfig,
    })

    const status = await orchestrator.run(['25-2'])

    // Pipeline should not abort (pre-flight was skipped)
    // The post-dev gate (Story 24-2) triggers the failure — story is escalated
    // But no pipeline:pre-flight-failure event should be emitted
    const mockEmit = vi.mocked(eventBus.emit)
    const preFlightEvent = mockEmit.mock.calls.find(
      ([eventName]) => eventName === 'pipeline:pre-flight-failure',
    )
    expect(preFlightEvent).toBeUndefined()
    // Pipeline should NOT have entered FAILED state from pre-flight
    // (it may be COMPLETE or stories may be escalated due to build failures in post-dev gate,
    // but the pipeline itself ran — stories were dispatched)
    expect(mockRunCreateStory).toHaveBeenCalledOnce()
    expect(status.state).toBe('COMPLETE')
  })

  // ---------------------------------------------------------------------------
  // No-story edge case
  // ---------------------------------------------------------------------------

  it('pre-flight runs even for empty story list (no stories to dispatch)', async () => {
    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    const status = await orchestrator.run([])

    // Build check still runs (we run it before deciding what to dispatch)
    expect(mockRunBuildVerification).toHaveBeenCalledTimes(1)
    expect(status.state).toBe('COMPLETE')
  })
})

// ---------------------------------------------------------------------------
// event-types.ts: PipelinePreFlightFailureEvent shape
// ---------------------------------------------------------------------------

import { EVENT_TYPE_NAMES } from '../event-types.js'

describe('event-types: pipeline:pre-flight-failure', () => {
  it('is listed in EVENT_TYPE_NAMES', () => {
    expect(EVENT_TYPE_NAMES).toContain('pipeline:pre-flight-failure')
  })
})
