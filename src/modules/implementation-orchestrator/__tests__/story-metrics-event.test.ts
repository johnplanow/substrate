/**
 * Tests for Story 24-4: Pipeline Metrics v2
 *
 * Covers:
 *   AC8: story:metrics NDJSON event emitted on terminal state
 *
 * Verifies that the orchestrator emits a 'story:metrics' event on the event bus
 * after writeStoryMetricsBestEffort() runs on every terminal state path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { createPipelineRun } from '../../../persistence/queries/decisions.js'

// ---------------------------------------------------------------------------
// Mocks — declared before imports (vitest hoisting)
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
vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))
vi.mock('../../compiled-workflows/index.js', () => ({
  analyzeStoryComplexity: vi.fn().mockReturnValue({ complexity: 'simple', reason: 'test' }),
  planTaskBatches: vi.fn().mockReturnValue([]),
}))
vi.mock('../../../cli/commands/health.js', () => ({
  inspectProcessTree: vi.fn().mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))
vi.mock('../../agent-dispatch/dispatcher-impl.js', () => ({
  runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
  checkGitDiffFiles: vi.fn().mockReturnValue(['src/some-modified-file.ts']),
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue('src/some-modified-file.ts\n'),
  }
})
vi.mock('../../agent-dispatch/interface-change-detector.js', () => ({
  detectInterfaceChanges: vi.fn().mockResolvedValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] }),
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

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockPack(): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test',
      phases: [],
      prompts: {},
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(''),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  } as unknown as MethodologyPack
}

function createMockContextCompiler(): ContextCompiler {
  return { compile: vi.fn(), registerTemplate: vi.fn(), getTemplate: vi.fn() } as unknown as ContextCompiler
}

function createMockDispatcher(): Dispatcher {
  const mockResult: DispatchResult<unknown> = {
    id: 'mock-dispatch',
    status: 'completed',
    result: undefined,
    tokensUsed: { input: 1000, output: 500 },
    error: undefined,
    startedAt: new Date(),
    completedAt: new Date(),
  }
  return {
    dispatch: vi.fn().mockReturnValue(mockResult),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    getMemoryState: vi.fn().mockReturnValue({ isPressured: false, freeMB: 1024, thresholdMB: 256, pressureLevel: 0 }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as Dispatcher
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AC8: story:metrics event emitted on terminal state', () => {
  let adapter: InMemoryDatabaseAdapter
  let runId: string
  let emittedEvents: Array<{ event: string; payload: unknown }>
  let eventBus: TypedEventBus

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter()
    await initSchema(adapter)
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    runId = run.id

    // Capture emitted events
    emittedEvents = []
    eventBus = {
      emit: vi.fn((event: string, payload: unknown) => {
        emittedEvents.push({ event, payload })
      }),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as TypedEventBus

    vi.clearAllMocks()
  })

  it('emits story:metrics event when a story completes successfully', async () => {
    mockRunCreateStory.mockResolvedValue({
      result: 'success',
      story_file: 'docs/stories/1-1-test.md',
      story_key: '1-1',
      story_title: 'Test story',
    } as any)
    mockRunDevStory.mockResolvedValue({
      result: 'success',
      ac_met: ['AC1'],
      ac_failures: [],
      files_modified: ['src/foo.ts'],
      tests: { total: 1, passed: 1, failed: 0 },
    } as any)
    mockRunCodeReview.mockResolvedValue({
      verdict: 'SHIP_IT',
      issues: 0,
      issue_list: [],
      summary: 'Looks good',
    } as any)

    const orchestrator = createImplementationOrchestrator({
      db: adapter,
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus,
      config: { maxConcurrency: 1, maxReviewCycles: 2, pipelineRunId: runId, gcPauseMs: 0 },
    })

    await orchestrator.run(['1-1'])

    // Find all story:metrics events emitted
    const metricsEvents = emittedEvents.filter((e) => e.event === 'story:metrics')
    expect(metricsEvents.length).toBeGreaterThanOrEqual(1)

    const metricsPayload = metricsEvents[metricsEvents.length - 1].payload as {
      storyKey: string
      wallClockMs: number
      phaseBreakdown: Record<string, number>
      tokens: { input: number; output: number }
      reviewCycles: number
      dispatches: number
    }

    expect(metricsPayload.storyKey).toBe('1-1')
    expect(typeof metricsPayload.wallClockMs).toBe('number')
    expect(metricsPayload.wallClockMs).toBeGreaterThanOrEqual(0)
    expect(typeof metricsPayload.phaseBreakdown).toBe('object')
    expect(typeof metricsPayload.tokens).toBe('object')
    expect(typeof metricsPayload.tokens.input).toBe('number')
    expect(typeof metricsPayload.tokens.output).toBe('number')
    expect(typeof metricsPayload.reviewCycles).toBe('number')
    expect(typeof metricsPayload.dispatches).toBe('number')
  })

  it('emits story:metrics event when a story fails (escalation)', async () => {
    mockRunCreateStory.mockRejectedValue(new Error('Simulated create-story failure'))

    const orchestrator = createImplementationOrchestrator({
      db: adapter,
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus,
      config: { maxConcurrency: 1, maxReviewCycles: 2, pipelineRunId: runId, gcPauseMs: 0 },
    })

    await orchestrator.run(['1-1'])

    const metricsEvents = emittedEvents.filter((e) => e.event === 'story:metrics')
    expect(metricsEvents.length).toBeGreaterThanOrEqual(1)

    const payload = metricsEvents[0].payload as { storyKey: string; wallClockMs: number }
    expect(payload.storyKey).toBe('1-1')
    expect(typeof payload.wallClockMs).toBe('number')
  })

  it('per-phase breakdown sum is within tolerance of wallClockMs', async () => {
    mockRunCreateStory.mockResolvedValue({
      result: 'success',
      story_file: 'docs/stories/3-1-test.md',
      story_key: '3-1',
      story_title: 'Test story 3',
    } as any)
    mockRunDevStory.mockResolvedValue({
      result: 'success',
      ac_met: ['AC1'],
      ac_failures: [],
      files_modified: ['src/baz.ts'],
      tests: { total: 1, passed: 1, failed: 0 },
    } as any)
    mockRunCodeReview.mockResolvedValue({
      verdict: 'SHIP_IT',
      issues: 0,
      issue_list: [],
      summary: 'Clean',
    } as any)

    const orchestrator = createImplementationOrchestrator({
      db: adapter,
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus,
      config: { maxConcurrency: 1, maxReviewCycles: 2, pipelineRunId: runId, gcPauseMs: 0 },
    })

    await orchestrator.run(['3-1'])

    const metricsEvents = emittedEvents.filter((e) => e.event === 'story:metrics')
    expect(metricsEvents.length).toBeGreaterThanOrEqual(1)

    const payload = metricsEvents[metricsEvents.length - 1].payload as {
      wallClockMs: number
      phaseBreakdown: Record<string, number>
    }

    const phaseValues = Object.values(payload.phaseBreakdown)
    const phaseSum = phaseValues.reduce((acc, v) => acc + v, 0)

    // All phase durations must be non-negative
    expect(phaseSum).toBeGreaterThanOrEqual(0)
    // Sum of phase durations must not exceed total wall-clock by more than 1000ms
    // (phases are sub-intervals of the total; 1000ms tolerance covers integer rounding and overhead)
    expect(phaseSum).toBeLessThanOrEqual(payload.wallClockMs + 1000)
  })

  it('story:metrics event payload matches the expected shape', async () => {
    mockRunCreateStory.mockResolvedValue({
      result: 'success',
      story_file: 'docs/stories/2-1-test.md',
      story_key: '2-1',
      story_title: 'Test story 2',
    } as any)
    mockRunDevStory.mockResolvedValue({
      result: 'success',
      ac_met: ['AC1'],
      ac_failures: [],
      files_modified: ['src/bar.ts'],
      tests: { total: 1, passed: 1, failed: 0 },
    } as any)
    mockRunCodeReview.mockResolvedValue({
      verdict: 'SHIP_IT',
      issues: 0,
      issue_list: [],
      summary: 'Clean',
    } as any)

    const orchestrator = createImplementationOrchestrator({
      db: adapter,
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus,
      config: { maxConcurrency: 1, maxReviewCycles: 2, pipelineRunId: runId, gcPauseMs: 0 },
    })

    await orchestrator.run(['2-1'])

    const metricsEvents = emittedEvents.filter((e) => e.event === 'story:metrics')
    expect(metricsEvents.length).toBeGreaterThanOrEqual(1)

    const payload = metricsEvents[metricsEvents.length - 1].payload as Record<string, unknown>

    // All required fields must be present
    expect(payload).toHaveProperty('storyKey')
    expect(payload).toHaveProperty('wallClockMs')
    expect(payload).toHaveProperty('phaseBreakdown')
    expect(payload).toHaveProperty('tokens')
    expect(payload).toHaveProperty('reviewCycles')
    expect(payload).toHaveProperty('dispatches')

    // Tokens sub-object
    expect(payload.tokens).toHaveProperty('input')
    expect(payload.tokens).toHaveProperty('output')

    // reviewCycles must be non-negative
    expect(payload.reviewCycles as number).toBeGreaterThanOrEqual(0)
  })
})
