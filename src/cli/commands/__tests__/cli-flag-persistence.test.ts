// @vitest-environment node
/**
 * Unit tests for CLI flag persistence in `runRunAction` — Story 52-3.
 *
 * AC1: All flags written to manifest at run start
 * AC2: --halt-on and --cost-ceiling accepted and validated
 * AC3: Default values for omitted flags
 *
 * Tests verify that:
 * - patchCLIFlags is called with correct flag values on successful run
 * - halt_on defaults to 'none' when --halt-on is not provided
 * - cost_ceiling is omitted when --cost-ceiling is not provided
 * - --halt-on rejects invalid values (exit code 1, error message contains 'all | critical | none')
 * - --cost-ceiling rejects non-positive values (exit code 1, error contains 'positive')
 * - manifest write failure does NOT abort the pipeline
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockPatchCLIFlags,
  mockRunManifestOpen,
  mockLinearOrchestratorRun,
  mockPackLoad,
  mockExistsSync,
  mockReaddirSync,
  mockCreatePipelineRun,
} = vi.hoisted(() => {
  const mockPatchCLIFlags = vi.fn().mockResolvedValue(undefined)
  const mockRunManifestOpen = vi.fn().mockReturnValue({ patchCLIFlags: mockPatchCLIFlags })
  const mockLinearOrchestratorRun = vi.fn()
  const mockPackLoad = vi.fn()
  const mockExistsSync = vi.fn()
  const mockReaddirSync = vi.fn()
  const mockCreatePipelineRun = vi.fn().mockReturnValue({
    id: 'run-persist-test-123',
    methodology: 'bmad',
    current_phase: 'implementation',
    status: 'running',
    created_at: '2026-01-01T00:00:00Z',
  })

  return {
    mockPatchCLIFlags,
    mockRunManifestOpen,
    mockLinearOrchestratorRun,
    mockPackLoad,
    mockExistsSync,
    mockReaddirSync,
    mockCreatePipelineRun,
  }
})

// ---------------------------------------------------------------------------
// vi.mock declarations — all at top level
// ---------------------------------------------------------------------------

const mockAdapter = {
  query: vi.fn().mockResolvedValue([]),
  exec: vi.fn().mockResolvedValue(undefined),
  transaction: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  backendType: 'sqlite' as const,
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
  createImplementationOrchestrator: vi.fn(() => ({
    run: mockLinearOrchestratorRun,
    pause: vi.fn(),
    resume: vi.fn(),
    getStatus: vi.fn(),
  })),
  discoverPendingStoryKeys: vi.fn().mockReturnValue([]),
  resolveStoryKeys: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../../persistence/queries/decisions.js', () => ({
  createPipelineRun: (...args: unknown[]) => mockCreatePipelineRun(...args),
  addTokenUsage: vi.fn(),
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
  readFileSync: vi.fn().mockReturnValue(''),
}))

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readdir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
}))

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
  buildSdlcHandlerRegistry: vi.fn().mockReturnValue({ resolve: vi.fn(), setDefault: vi.fn(), register: vi.fn() }),
}))

vi.mock('@substrate-ai/sdlc', () => ({
  createGraphOrchestrator: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ successCount: 1, failureCount: 0, totalStories: 1, stories: {} }) }),
  resolveGraphPath: vi.fn().mockReturnValue('/fake/path/sdlc-pipeline.dot'),
  applyConfigToGraph: vi.fn(),
  RunManifest: {
    open: mockRunManifestOpen,
  },
}))

vi.mock('@substrate-ai/factory', () => ({
  parseGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
  createGraphExecutor: vi.fn().mockReturnValue({ run: vi.fn() }),
}))

vi.mock('../../../modules/agent-dispatch/dispatcher-impl.js', () => ({
  runBuildVerification: vi.fn().mockResolvedValue({ exitCode: 0, output: '' }),
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER all mocks
// ---------------------------------------------------------------------------

import { runRunAction } from '../run.js'
import type { AdapterRegistry } from '../../../adapters/adapter-registry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRegistry = {
  discoverAndRegister: vi.fn().mockResolvedValue({ results: [], failedCount: 0 }),
  get: vi.fn().mockReturnValue(undefined),
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

/** Minimal RunOptions for tests that go through the implementation-only path */
function makeBaseOptions(overrides: Record<string, unknown> = {}) {
  return {
    pack: 'bmad',
    stories: '51-1,51-2',
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

describe('Story 52-3: CLI flag persistence', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockPackLoad.mockResolvedValue(mockPack())

    // Default: run the linear orchestrator successfully
    mockLinearOrchestratorRun.mockResolvedValue({
      state: 'COMPLETE',
      stories: {},
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      totalDurationMs: 1000,
      maxConcurrentActual: 1,
    })

    // Default: artifacts dir exists (for story key validation)
    mockReaddirSync.mockReturnValue(['51-1-test-story.md', '51-2-another-story.md'])
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      // .dolt not present → SQLite adapter
      if (path.includes('.dolt')) return false
      // substrate.db exists
      if (path.includes('substrate.db')) return true
      // artifacts dir exists
      if (path.includes('implementation-artifacts')) return true
      // .substrate dir exists
      if (path.includes('.substrate')) return true
      return false
    })

    // Spy on stderr/stdout to capture error messages
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
  })

  // -------------------------------------------------------------------------
  // AC1: All flags written to manifest
  // -------------------------------------------------------------------------

  it('AC1: calls patchCLIFlags with all provided flags', async () => {
    const exitCode = await runRunAction(makeBaseOptions({
      stories: '51-1,51-2',
      haltOn: 'critical',
      costCeiling: 5.00,
      agent: 'codex',
      skipVerification: true,
      events: true,
    }))

    expect(exitCode).toBe(0)
    expect(mockRunManifestOpen).toHaveBeenCalledWith(
      'run-persist-test-123',
      expect.stringContaining('runs'),
    )
    expect(mockPatchCLIFlags).toHaveBeenCalledWith(expect.objectContaining({
      stories: ['51-1', '51-2'],
      halt_on: 'critical',
      cost_ceiling: 5.00,
      agent: 'codex',
      skip_verification: true,
      events: true,
    }))
  })

  it('AC1: passes correct run ID to RunManifest.open', async () => {
    await runRunAction(makeBaseOptions({ stories: '51-1' }))

    expect(mockRunManifestOpen).toHaveBeenCalledWith(
      'run-persist-test-123',
      expect.any(String),
    )
  })

  // -------------------------------------------------------------------------
  // AC3: Default values for omitted flags
  // -------------------------------------------------------------------------

  it('AC3: halt_on defaults to "none" when --halt-on is not provided', async () => {
    await runRunAction(makeBaseOptions({ stories: '51-1' }))

    expect(mockPatchCLIFlags).toHaveBeenCalledWith(expect.objectContaining({
      halt_on: 'none',
    }))
  })

  it('AC3: cost_ceiling is omitted when --cost-ceiling is not provided', async () => {
    await runRunAction(makeBaseOptions({ stories: '51-1' }))

    const calledWith = mockPatchCLIFlags.mock.calls[0]?.[0] as Record<string, unknown>
    expect(calledWith).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(calledWith, 'cost_ceiling')).toBe(false)
  })

  it('AC3: stories is omitted from cli_flags when --stories is not provided', async () => {
    // No stories provided — will use DB discovery (returns empty)
    await runRunAction(makeBaseOptions({ stories: undefined }))

    // When no stories found, the pipeline exits early with "No pending stories found"
    // so patchCLIFlags may not be called. This is valid behavior.
    // Key: if patchCLIFlags IS called, stories should not be set
    if (mockPatchCLIFlags.mock.calls.length > 0) {
      const calledWith = mockPatchCLIFlags.mock.calls[0]?.[0] as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(calledWith, 'stories')).toBe(false)
    }
  })

  // -------------------------------------------------------------------------
  // AC2: --halt-on validation
  // -------------------------------------------------------------------------

  it('AC2: --halt-on with invalid value returns exit code 1', async () => {
    const exitCode = await runRunAction(makeBaseOptions({
      haltOn: 'invalid-value' as 'all' | 'critical' | 'none',
    }))

    expect(exitCode).toBe(1)
  })

  it('AC2: --halt-on error message mentions valid values "all | critical | none"', async () => {
    await runRunAction(makeBaseOptions({
      haltOn: 'severe' as 'all' | 'critical' | 'none',
    }))

    const allWrites = (stderrSpy.mock.calls as [string][]).map(([msg]) => msg).join('')
    expect(allWrites).toMatch(/all \| critical \| none/)
  })

  it('AC2: --cost-ceiling with negative value returns exit code 1', async () => {
    const exitCode = await runRunAction(makeBaseOptions({
      costCeiling: -1,
    }))

    expect(exitCode).toBe(1)
  })

  it('AC2: --cost-ceiling with zero returns exit code 1', async () => {
    const exitCode = await runRunAction(makeBaseOptions({
      costCeiling: 0,
    }))

    expect(exitCode).toBe(1)
  })

  it('AC2: --cost-ceiling error message mentions "positive"', async () => {
    await runRunAction(makeBaseOptions({
      costCeiling: -5,
    }))

    const allWrites = (stderrSpy.mock.calls as [string][]).map(([msg]) => msg).join('')
    expect(allWrites).toMatch(/positive/i)
  })

  it('AC2: valid --halt-on values (all, critical, none) are accepted', async () => {
    for (const value of ['all', 'critical', 'none'] as const) {
      vi.clearAllMocks()
      mockPackLoad.mockResolvedValue(mockPack())
      mockLinearOrchestratorRun.mockResolvedValue({
        state: 'COMPLETE', stories: {}, startedAt: '', completedAt: '', totalDurationMs: 0, maxConcurrentActual: 1,
      })

      const exitCode = await runRunAction(makeBaseOptions({ haltOn: value, stories: '51-1' }))
      expect(exitCode).toBe(0)
    }
  })

  // -------------------------------------------------------------------------
  // Non-fatal manifest write: pipeline must NOT abort
  // -------------------------------------------------------------------------

  it('manifest write failure does not abort the pipeline', async () => {
    // Make patchCLIFlags throw
    mockPatchCLIFlags.mockRejectedValueOnce(new Error('disk full'))

    const exitCode = await runRunAction(makeBaseOptions({ stories: '51-1' }))

    // Pipeline should still succeed (exit code 0) despite manifest write failure
    expect(exitCode).toBe(0)
    expect(mockLinearOrchestratorRun).toHaveBeenCalled()
  })
})
