/**
 * Integration tests for cost ceiling enforcement in the orchestrator — Story 53-3.
 *
 * Covers:
 *   AC3: Pre-dispatch check reads ceiling from manifest cli_flags.cost_ceiling
 *   AC4: cost:warning emitted exactly once when crossing 80%
 *   AC5: cost:ceiling-reached emitted when exceeded; story transitions to ESCALATED
 *   AC7: cost:ceiling-reached includes severity when halt_on is 'all' or 'critical'
 *
 * The RunManifest is a minimal mock: { read: vi.fn(), patchStoryState: vi.fn() }
 * The eventBus is captured to verify NDJSON event emission.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import type { RunManifestData } from '@substrate-ai/sdlc/run-model/types.js'

// ---------------------------------------------------------------------------
// Module mocks (must appear before imports)
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
    run: vi.fn().mockResolvedValue({ storyKey: '53-3', checks: [], status: 'pass', duration_ms: 0 }),
    register: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Import mocked modules
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { runTestPlan } from '../../compiled-workflows/test-plan.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'

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
    maxReviewCycles: 2,
    pipelineRunId: 'test-run-id',
    gcPauseMs: 0,
    ...overrides,
  }
}

function makeCreateStorySuccess(storyKey = '53-3') {
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

function makeTestPlanSuccess() {
  return {
    result: 'success' as const,
    test_files: [],
    test_categories: [],
    coverage_notes: '',
    tokenUsage: { input: 50, output: 20 },
  }
}

/** Build a minimal RunManifestData fixture for cost ceiling tests */
function makeManifestData(
  costCeiling: number | undefined,
  cumulativeCostUsd: number,
  haltOn = 'none',
): RunManifestData {
  const now = new Date().toISOString()
  return {
    run_id: 'test-run',
    cli_flags: {
      ...(costCeiling !== undefined ? { cost_ceiling: costCeiling } : {}),
      halt_on: haltOn,
    },
    story_scope: [],
    supervisor_pid: null,
    supervisor_session_id: null,
    per_story_state: {
      // Put the cumulative cost in a "completed" story
      ...(cumulativeCostUsd > 0 ? {
        'prev-1': {
          status: 'complete',
          phase: 'COMPLETE',
          started_at: now,
          completed_at: now,
          cost_usd: cumulativeCostUsd,
        },
      } : {}),
    },
    recovery_history: [],
    cost_accumulation: { per_story: {}, run_total: 0 },
    pending_proposals: [],
    generation: 1,
    created_at: now,
    updated_at: now,
  }
}

/** Build a mock RunManifest with controllable read() result */
function createMockRunManifest(manifestData: RunManifestData) {
  return {
    read: vi.fn().mockResolvedValue(manifestData),
    patchStoryState: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Cost ceiling enforcement in orchestrator (Story 53-3)', () => {
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
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('53-3'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
  })

  // -------------------------------------------------------------------------
  // Scenario 1: no ceiling configured
  // -------------------------------------------------------------------------

  it('Scenario 1: no ceiling configured — dispatches normally and emits no cost events', async () => {
    const manifestData = makeManifestData(undefined, 0)
    const runManifest = createMockRunManifest(manifestData)

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
      runManifest: runManifest as unknown as import('@substrate-ai/sdlc').RunManifest,
    })

    await orchestrator.run(['53-3'])

    const emitCalls = vi.mocked(eventBus.emit).mock.calls
    const costEvents = emitCalls.filter(([type]) => String(type).startsWith('cost:'))
    expect(costEvents).toHaveLength(0)

    // Story should have been dispatched (devStory called)
    expect(mockRunDevStory).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Scenario 2: 80% warning
  // -------------------------------------------------------------------------

  it('Scenario 2: 81% of ceiling — emits cost:warning exactly once, story IS dispatched', async () => {
    const ceiling = 5.00
    const cumulative = 4.05 // 81%
    const manifestData = makeManifestData(ceiling, cumulative)
    const runManifest = createMockRunManifest(manifestData)

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
      runManifest: runManifest as unknown as import('@substrate-ai/sdlc').RunManifest,
    })

    await orchestrator.run(['53-3'])

    const emitCalls = vi.mocked(eventBus.emit).mock.calls
    const warningCalls = emitCalls.filter(([type]) => type === 'cost:warning')
    expect(warningCalls).toHaveLength(1)

    const [, warningPayload] = warningCalls[0] as [string, { cumulative_cost: number; ceiling: number; percent_used: number }]
    expect(warningPayload.cumulative_cost).toBeCloseTo(cumulative, 5)
    expect(warningPayload.ceiling).toBe(ceiling)
    expect(warningPayload.percent_used).toBe(81)

    // Story should still be dispatched (we only warn, not halt)
    expect(mockRunDevStory).toHaveBeenCalled()

    // No ceiling-reached event
    const ceilingCalls = emitCalls.filter(([type]) => type === 'cost:ceiling-reached')
    expect(ceilingCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Scenario 3: ceiling exceeded, halt-on none
  // -------------------------------------------------------------------------

  it('Scenario 3: ceiling exceeded, halt-on none — story NOT dispatched, cost:ceiling-reached emitted, story ESCALATED', async () => {
    const ceiling = 5.00
    const cumulative = 5.50 // 110% — exceeded
    const manifestData = makeManifestData(ceiling, cumulative, 'none')
    const runManifest = createMockRunManifest(manifestData)

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
      runManifest: runManifest as unknown as import('@substrate-ai/sdlc').RunManifest,
    })

    await orchestrator.run(['53-3'])

    // Story should NOT have been dispatched
    expect(mockRunDevStory).not.toHaveBeenCalled()

    const emitCalls = vi.mocked(eventBus.emit).mock.calls
    const ceilingCalls = emitCalls.filter(([type]) => type === 'cost:ceiling-reached')
    expect(ceilingCalls).toHaveLength(1)

    const [, ceilingPayload] = ceilingCalls[0] as [string, {
      cumulative_cost: number
      ceiling: number
      halt_on: string
      action: string
      skipped_stories: string[]
      severity?: string
    }]
    expect(ceilingPayload.cumulative_cost).toBeCloseTo(cumulative, 5)
    expect(ceilingPayload.ceiling).toBe(ceiling)
    expect(ceilingPayload.halt_on).toBe('none')
    expect(ceilingPayload.action).toBe('stopped')
    expect(ceilingPayload.skipped_stories).toContain('53-3')
    expect(ceilingPayload.severity).toBeUndefined()

    // patchStoryState should have been called with status=escalated for the skipped story
    const patchCalls = runManifest.patchStoryState.mock.calls
    const escalatedPatch = patchCalls.find(([key, updates]) => key === '53-3' && updates.status === 'escalated')
    expect(escalatedPatch).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // Scenario 4: ceiling exceeded, halt-on critical
  // -------------------------------------------------------------------------

  it('Scenario 4: ceiling exceeded, halt-on critical — cost:ceiling-reached has severity=critical', async () => {
    const ceiling = 5.00
    const cumulative = 5.50 // 110% — exceeded
    const manifestData = makeManifestData(ceiling, cumulative, 'critical')
    const runManifest = createMockRunManifest(manifestData)

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
      runManifest: runManifest as unknown as import('@substrate-ai/sdlc').RunManifest,
    })

    await orchestrator.run(['53-3'])

    // Story should NOT have been dispatched
    expect(mockRunDevStory).not.toHaveBeenCalled()

    const emitCalls = vi.mocked(eventBus.emit).mock.calls
    const ceilingCalls = emitCalls.filter(([type]) => type === 'cost:ceiling-reached')
    expect(ceilingCalls).toHaveLength(1)

    const [, ceilingPayload] = ceilingCalls[0] as [string, {
      halt_on: string
      severity?: string
    }]
    expect(ceilingPayload.halt_on).toBe('critical')
    expect(ceilingPayload.severity).toBe('critical')
  })
})
