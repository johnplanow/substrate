// @vitest-environment node
/**
 * Unit tests for the `--engine` CLI flag routing in `runRunAction`.
 *
 * Story 43-10.
 *
 * AC1: `--engine=graph` routes to GraphOrchestrator
 * AC2: Default (no --engine) uses linear orchestrator
 * AC3: `--engine=linear` explicitly selects linear orchestrator
 * AC5: Invalid `--engine` value produces a clear error (exit code 1)
 * AC6: `--engine` appears in `substrate run --help` (verified via registerRunCommand test)
 * AC7: Graph engine receives --concurrency and --max-review-cycles values
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockLinearOrchestratorRun,
  mockCreateImplementationOrchestrator,
  mockGraphOrchestratorRun,
  mockCreateGraphOrchestrator,
  mockBuildSdlcHandlerRegistry,
  mockPackLoad,
  mockExistsSync,
  mockReaddirSync,
} = vi.hoisted(() => {
  const mockLinearOrchestratorRun = vi.fn()
  const mockGraphOrchestratorRun = vi.fn()
  const mockBuildSdlcHandlerRegistry = vi.fn()
  const mockCreateGraphOrchestrator = vi.fn()

  return {
    mockLinearOrchestratorRun,
    mockGraphOrchestratorRun,
    mockCreateImplementationOrchestrator: vi.fn(),
    mockCreateGraphOrchestrator,
    mockBuildSdlcHandlerRegistry,
    mockPackLoad: vi.fn(),
    mockExistsSync: vi.fn(),
    mockReaddirSync: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// vi.mock declarations — all module mocks must be at top level
// ---------------------------------------------------------------------------

const mockAdapter = {
  query: vi.fn().mockResolvedValue([]),
  exec: vi.fn().mockResolvedValue(undefined),
  transaction: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}

vi.mock('../../../persistence/adapter.js', () => ({
  createDatabaseAdapter: vi.fn(() => mockAdapter),
}))

vi.mock('../../../persistence/schema.js', () => ({
  initSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../modules/methodology-pack/pack-loader.js', () => ({
  createPackLoader: vi.fn(() => ({
    load: mockPackLoad,
    discover: vi.fn(),
  })),
}))

vi.mock('../../../modules/context-compiler/index.js', () => ({
  createContextCompiler: vi.fn(() => ({
    compile: vi.fn(),
    registerTemplate: vi.fn(),
  })),
  RepoMapInjector: vi.fn().mockImplementation(() => ({
    buildContext: vi.fn().mockResolvedValue({ text: '', symbolCount: 0, truncated: false }),
  })),
}))

vi.mock('../../../modules/repo-map/index.js', () => ({
  DoltSymbolRepository: vi.fn().mockImplementation(() => ({})),
  DoltRepoMapMetaRepository: vi.fn().mockImplementation(() => ({})),
  RepoMapQueryEngine: vi.fn().mockImplementation(() => ({})),
  RepoMapModule: vi.fn().mockImplementation(() => ({
    checkStaleness: vi.fn().mockResolvedValue(null),
  })),
  RepoMapTelemetry: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../../../modules/state/index.js', () => ({
  DoltClient: vi.fn().mockImplementation(() => ({})),
  FileStateStore: class {},
  DoltStateStore: class {},
}))

vi.mock('../../../modules/agent-dispatch/index.js', () => ({
  createDispatcher: vi.fn(() => ({
    dispatch: vi.fn(),
    shutdown: vi.fn(),
    getPending: vi.fn(() => 0),
    getRunning: vi.fn(() => 0),
  })),
}))

vi.mock('../../../modules/implementation-orchestrator/index.js', () => ({
  createImplementationOrchestrator: (...args: unknown[]) => {
    mockCreateImplementationOrchestrator(...args)
    return {
      run: mockLinearOrchestratorRun,
      pause: vi.fn(),
      resume: vi.fn(),
      getStatus: vi.fn(),
    }
  },
  discoverPendingStoryKeys: vi.fn().mockReturnValue([]),
  resolveStoryKeys: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../../persistence/queries/decisions.js', () => ({
  createPipelineRun: vi.fn().mockReturnValue({
    id: 'run-engine-test-123',
    methodology: 'bmad',
    current_phase: 'implementation',
    status: 'running',
    created_at: '2026-01-01T00:00:00Z',
  }),
  addTokenUsage: vi.fn().mockResolvedValue(undefined),
  getTokenUsageSummary: vi.fn().mockReturnValue([]),
  updatePipelineRun: vi.fn(),
  getRunningPipelineRuns: vi.fn().mockReturnValue([]),
}))

vi.mock('../../../persistence/queries/metrics.js', () => ({
  writeRunMetrics: vi.fn(),
  getStoryMetricsForRun: vi.fn().mockReturnValue([]),
  aggregateTokenUsageForRun: vi.fn().mockReturnValue({ input: 0, output: 0, cost: 0 }),
}))

vi.mock('../health.js', () => ({
  inspectProcessTree: vi.fn().mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))

vi.mock('../../../modules/phase-orchestrator/phase-detection.js', () => ({
  detectStartPhase: vi.fn().mockResolvedValue({ phase: 'implementation', reason: 'test', needsConcept: false }),
}))

vi.mock('../../../modules/phase-orchestrator/index.js', () => ({
  createPhaseOrchestrator: vi.fn(() => ({
    startRun: vi.fn().mockResolvedValue('run-phase-123'),
    advancePhase: vi.fn().mockResolvedValue({ advanced: true, phase: 'implementation' }),
    getRunStatus: vi.fn().mockResolvedValue({ currentPhase: 'implementation', status: 'running' }),
    resumeRun: vi.fn(),
    markPhaseFailed: vi.fn(),
  })),
}))

vi.mock('../../../modules/phase-orchestrator/phases/analysis.js', () => ({
  runAnalysisPhase: vi.fn().mockResolvedValue({ result: 'success', tokenUsage: { input: 0, output: 0 } }),
}))

vi.mock('../../../modules/phase-orchestrator/phases/planning.js', () => ({
  runPlanningPhase: vi.fn().mockResolvedValue({ result: 'success', tokenUsage: { input: 0, output: 0 } }),
}))

vi.mock('../../../modules/phase-orchestrator/phases/solutioning.js', () => ({
  runSolutioningPhase: vi.fn().mockResolvedValue({ result: 'success', tokenUsage: { input: 0, output: 0 } }),
}))

vi.mock('../../../modules/phase-orchestrator/phases/ux-design.js', () => ({
  runUxDesignPhase: vi.fn().mockResolvedValue({ result: 'success', tokenUsage: { input: 0, output: 0 } }),
}))

vi.mock('../../../modules/phase-orchestrator/phases/research.js', () => ({
  runResearchPhase: vi.fn().mockResolvedValue({ result: 'success', tokenUsage: { input: 0, output: 0 } }),
}))

vi.mock('../../../core/event-bus.js', () => ({
  createEventBus: vi.fn(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    off: vi.fn(),
  })),
}))

vi.mock('../../../modules/routing/index.js', () => ({
  RoutingResolver: {
    createWithFallback: vi.fn().mockReturnValue({
      resolveModel: vi.fn().mockReturnValue(null),
    }),
  },
  RoutingTokenAccumulator: vi.fn().mockImplementation(() => ({
    onRoutingSelected: vi.fn(),
    onAgentCompleted: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
  RoutingTelemetry: vi.fn().mockImplementation(() => ({
    recordModelResolved: vi.fn(),
  })),
  RoutingTuner: vi.fn().mockImplementation(() => ({
    maybeAutoTune: vi.fn().mockResolvedValue(undefined),
  })),
  RoutingRecommender: vi.fn().mockImplementation(() => ({})),
  loadModelRoutingConfig: vi.fn().mockImplementation(() => { throw new Error('No config') }),
}))

vi.mock('../../../modules/telemetry/ingestion-server.js', () => ({
  IngestionServer: vi.fn().mockImplementation(() => ({ stop: vi.fn() })),
}))

vi.mock('../../../modules/telemetry/adapter-persistence.js', () => ({
  AdapterTelemetryPersistence: vi.fn().mockImplementation(() => ({
    initSchema: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('../../../modules/stop-after/index.js', () => ({
  VALID_PHASES: ['research', 'analysis', 'planning', 'solutioning', 'implementation'],
  createStopAfterGate: vi.fn(),
  validateStopAfterFromConflict: vi.fn().mockReturnValue({ valid: true }),
  formatPhaseCompletionSummary: vi.fn().mockReturnValue(''),
}))

vi.mock('../help-agent.js', () => ({
  runHelpAgent: vi.fn().mockResolvedValue(0),
}))

vi.mock('../../tui/index.js', () => ({
  createTuiApp: vi.fn(),
  isTuiCapable: vi.fn().mockReturnValue(false),
  printNonTtyWarning: vi.fn(),
}))

vi.mock('../../../modules/implementation-orchestrator/event-emitter.js', () => ({
  createEventEmitter: vi.fn().mockReturnValue({ emit: vi.fn() }),
}))

vi.mock('../../../modules/implementation-orchestrator/progress-renderer.js', () => ({
  createProgressRenderer: vi.fn().mockReturnValue({ render: vi.fn() }),
}))

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/test-project'),
}))

vi.mock('../../../modules/config/config-system-impl.js', () => ({
  createConfigSystem: vi.fn(() => ({
    load: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn().mockReturnValue({}),
  })),
}))

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  readFileSync: vi.fn().mockReturnValue('digraph sdlc_pipeline {}'),
}))

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readdir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
}))

// ---------------------------------------------------------------------------
// Graph engine module mocks (story 43-10)
// ---------------------------------------------------------------------------

vi.mock('../../../modules/compiled-workflows/create-story.js', () => ({
  runCreateStory: vi.fn().mockResolvedValue({ result: 'success', tokenUsage: { input: 0, output: 0 } }),
}))

vi.mock('../../../modules/compiled-workflows/dev-story.js', () => ({
  runDevStory: vi.fn().mockResolvedValue({ result: 'success', tokenUsage: { input: 0, output: 0 } }),
}))

vi.mock('../../../modules/compiled-workflows/code-review.js', () => ({
  runCodeReview: vi.fn().mockResolvedValue({ verdict: 'SHIP_IT', tokenUsage: { input: 0, output: 0 } }),
}))

vi.mock('../sdlc-graph-setup.js', () => ({
  buildSdlcHandlerRegistry: (...args: unknown[]) => {
    mockBuildSdlcHandlerRegistry(...args)
    return { resolve: vi.fn(), setDefault: vi.fn(), register: vi.fn() }
  },
}))

vi.mock('@substrate-ai/sdlc', () => ({
  createGraphOrchestrator: (...args: unknown[]) => {
    mockCreateGraphOrchestrator(...args)
    return { run: mockGraphOrchestratorRun }
  },
  resolveGraphPath: vi.fn().mockReturnValue('/fake/path/sdlc-pipeline.dot'),
  applyConfigToGraph: vi.fn(),
  RunManifest: {
    open: vi.fn().mockReturnValue({
      read: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined),
      patchCLIFlags: vi.fn().mockResolvedValue(undefined),
      patchStoryState: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))

vi.mock('@substrate-ai/factory', () => ({
  parseGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
  createGraphExecutor: vi.fn().mockReturnValue({ run: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { runRunAction, registerRunCommand } from '../run.js'
import type { AdapterRegistry } from '../../../adapters/adapter-registry.js'
import { Command } from 'commander'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRegistry = {
  discoverAndRegister: vi.fn().mockResolvedValue({ results: [], failedCount: 0 }),
} as unknown as AdapterRegistry

function mockPack() {
  return {
    manifest: {
      name: 'bmad',
      version: '1.0.0',
      description: 'BMAD methodology pack',
      prompts: {},
      constraints: {},
      templates: {},
      research: false,
      uxDesign: false,
    },
    getPrompt: vi.fn(),
    getConstraint: vi.fn(),
    getTemplate: vi.fn(),
    getPhases: vi.fn().mockReturnValue([]),
  }
}

/** Default status returned by the linear orchestrator mock */
const defaultLinearStatus = {
  state: 'COMPLETE',
  stories: { '1-1': { phase: 'COMPLETE', reviewCycles: 1 } },
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:01:00Z',
  totalDurationMs: 60000,
  maxConcurrentActual: 1,
}

/** Default summary returned by the graph orchestrator mock */
const defaultGraphSummary = {
  successCount: 1,
  failureCount: 0,
  totalStories: 1,
  stories: { '1-1': { outcome: 'SUCCESS' } },
}

/** Minimal RunOptions that avoids early-exit paths (no phase orchestration needed) */
function makeBaseOptions(overrides: Record<string, unknown> = {}) {
  return {
    pack: 'bmad',
    stories: '1-1',
    concurrency: 1,
    outputFormat: 'human' as const,
    projectRoot: '/tmp/test-project',
    registry: mockRegistry,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Story 43-10: --engine flag routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPackLoad.mockResolvedValue(mockPack())
    mockLinearOrchestratorRun.mockResolvedValue(defaultLinearStatus)
    mockGraphOrchestratorRun.mockResolvedValue(defaultGraphSummary)

    // Default: story files found
    mockReaddirSync.mockReturnValue(['1-1-test-story.md'])

    // Default: existsSync — artifacts dir exists, no .dolt
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      if (path.includes('.dolt')) return false
      return true
    })
  })

  // ── AC2: Default (no --engine flag) uses linear orchestrator ───────────────

  describe('AC2: default (no --engine) uses linear orchestrator', () => {
    it('calls createImplementationOrchestrator when engine is undefined', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction(makeBaseOptions())

      expect(exitCode).toBe(0)
      expect(mockCreateImplementationOrchestrator).toHaveBeenCalled()
      expect(mockCreateGraphOrchestrator).not.toHaveBeenCalled()

      stdoutWrite.mockRestore()
    })

    it('calls the linear orchestrator run with story keys', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      await runRunAction(makeBaseOptions())

      expect(mockLinearOrchestratorRun).toHaveBeenCalledWith(['1-1'])
      expect(mockGraphOrchestratorRun).not.toHaveBeenCalled()

      stdoutWrite.mockRestore()
    })
  })

  // ── AC3: --engine=linear explicitly selects linear orchestrator ────────────

  describe('AC3: --engine=linear explicitly selects linear orchestrator', () => {
    it('calls createImplementationOrchestrator when engine is "linear"', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction(makeBaseOptions({ engine: 'linear' }))

      expect(exitCode).toBe(0)
      expect(mockCreateImplementationOrchestrator).toHaveBeenCalled()
      expect(mockCreateGraphOrchestrator).not.toHaveBeenCalled()

      stdoutWrite.mockRestore()
    })

    it('never calls createGraphOrchestrator when engine is "linear"', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      await runRunAction(makeBaseOptions({ engine: 'linear' }))

      expect(mockBuildSdlcHandlerRegistry).not.toHaveBeenCalled()
      expect(mockCreateGraphOrchestrator).not.toHaveBeenCalled()

      stdoutWrite.mockRestore()
    })
  })

  // ── AC1: --engine=graph routes to GraphOrchestrator ───────────────────────

  describe('AC1: --engine=graph routes to GraphOrchestrator', () => {
    it('calls createGraphOrchestrator when engine is "graph"', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction(makeBaseOptions({ engine: 'graph' }))

      expect(exitCode).toBe(0)
      expect(mockCreateGraphOrchestrator).toHaveBeenCalled()
      expect(mockCreateImplementationOrchestrator).not.toHaveBeenCalled()

      stdoutWrite.mockRestore()
    })

    it('calls buildSdlcHandlerRegistry when engine is "graph"', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      await runRunAction(makeBaseOptions({ engine: 'graph' }))

      expect(mockBuildSdlcHandlerRegistry).toHaveBeenCalled()

      stdoutWrite.mockRestore()
    })

    it('calls graphOrchestrator.run with story keys', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      await runRunAction(makeBaseOptions({ engine: 'graph' }))

      expect(mockGraphOrchestratorRun).toHaveBeenCalledWith(['1-1'])
      expect(mockLinearOrchestratorRun).not.toHaveBeenCalled()

      stdoutWrite.mockRestore()
    })

    it('returns exit code 0 when graph orchestrator succeeds', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction(makeBaseOptions({ engine: 'graph' }))

      expect(exitCode).toBe(0)

      stdoutWrite.mockRestore()
    })
  })

  // ── AC5: Invalid --engine value produces a clear error ────────────────────

  describe('AC5: invalid --engine value produces error', () => {
    it('returns exit code 1 for invalid engine value', async () => {
      const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction(makeBaseOptions({ engine: 'bogus' }))

      expect(exitCode).toBe(1)

      stderrWrite.mockRestore()
    })

    it('emits error message with valid values listed', async () => {
      const stderrMessages: string[] = []
      const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
        stderrMessages.push(String(msg))
        return true
      })

      await runRunAction(makeBaseOptions({ engine: 'bogus' }))

      expect(stderrMessages.join('')).toContain("Invalid engine 'bogus'. Valid values: linear, graph")

      stderrWrite.mockRestore()
    })

    it('does not call createImplementationOrchestrator for invalid engine', async () => {
      const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      await runRunAction(makeBaseOptions({ engine: 'bogus' }))

      expect(mockCreateImplementationOrchestrator).not.toHaveBeenCalled()
      expect(mockCreateGraphOrchestrator).not.toHaveBeenCalled()

      stderrWrite.mockRestore()
    })

    it('emits JSON error when outputFormat is json', async () => {
      const stdoutMessages: string[] = []
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((msg) => {
        stdoutMessages.push(String(msg))
        return true
      })

      const exitCode = await runRunAction(
        makeBaseOptions({ engine: 'bogus', outputFormat: 'json' }),
      )

      expect(exitCode).toBe(1)
      const combined = stdoutMessages.join('')
      // Should emit a JSON-formatted error
      const parsed = JSON.parse(combined)
      expect(parsed.success).toBe(false)

      stdoutWrite.mockRestore()
    })
  })

  // ── AC7: Graph engine respects --concurrency and --max-review-cycles ───────

  describe('AC7: graph engine receives concurrency and maxReviewCycles', () => {
    it('passes maxConcurrency: 2 and maxReviewCycles: 3 to createGraphOrchestrator', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      await runRunAction(
        makeBaseOptions({
          engine: 'graph',
          concurrency: 2,
          maxReviewCycles: 3,
        }),
      )

      expect(mockCreateGraphOrchestrator).toHaveBeenCalled()
      const callArgs = mockCreateGraphOrchestrator.mock.calls[0][0] as Record<string, unknown>
      expect(callArgs).toMatchObject({ maxConcurrency: 2, maxReviewCycles: 3 })

      stdoutWrite.mockRestore()
    })

    it('calls applyConfigToGraph with maxReviewCycles before creating orchestrator', async () => {
      const { applyConfigToGraph: mockApply } = await import('@substrate-ai/sdlc') as any
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      await runRunAction(makeBaseOptions({ engine: 'graph', maxReviewCycles: 5 }))

      expect(mockApply).toHaveBeenCalledOnce()
      expect(mockApply).toHaveBeenCalledWith(
        expect.anything(), // parsed graph
        { maxReviewCycles: 5 },
      )

      stdoutWrite.mockRestore()
    })

    it('passes maxConcurrency: 1 and maxReviewCycles: 2 (defaults) to createGraphOrchestrator', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      await runRunAction(makeBaseOptions({ engine: 'graph' }))

      const callArgs = mockCreateGraphOrchestrator.mock.calls[0][0] as Record<string, unknown>
      expect(callArgs).toMatchObject({ maxConcurrency: 1, maxReviewCycles: 2 })

      stdoutWrite.mockRestore()
    })
  })

  // ── AC6: --engine appears in help output ──────────────────────────────────

  describe('AC6: --engine option appears in substrate run --help', () => {
    it('registerRunCommand registers --engine option', () => {
      const program = new Command()
      registerRunCommand(program)
      const runCmd = program.commands.find((c) => c.name() === 'run')
      expect(runCmd).toBeDefined()

      // Check that --engine option is registered
      const options = runCmd!.options
      const engineOpt = options.find((o) => o.long === '--engine')
      expect(engineOpt).toBeDefined()
      expect(engineOpt!.description).toContain('Execution engine')
    })

    it('--engine option description mentions linear and graph', () => {
      const program = new Command()
      registerRunCommand(program)
      const runCmd = program.commands.find((c) => c.name() === 'run')!
      const engineOpt = runCmd.options.find((o) => o.long === '--engine')!

      expect(engineOpt.description).toContain('linear')
      expect(engineOpt.description).toContain('graph')
    })
  })
})
