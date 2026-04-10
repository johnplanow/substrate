// @vitest-environment node
/**
 * Tests for Story 39-2: Skip Phase Detection When --stories Provided
 *
 * AC1: --stories bypasses phase detection (detectStartPhase not called)
 * AC2: --from still works as before (backward compatibility)
 * AC3: no --stories and no --from triggers auto-detection (detectStartPhase called)
 * AC4: --stories with missing story file emits clear error message
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be before vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockDetectStartPhase,
  mockExistsSync,
  mockReaddirSync,
  mockOrchestratorRun,
  mockCreateImplementationOrchestrator,
  mockPackLoad,
  mockPhaseOrchestratorStartRun,
} = vi.hoisted(() => {
  return {
    mockDetectStartPhase: vi.fn(),
    mockExistsSync: vi.fn(),
    mockReaddirSync: vi.fn(),
    mockOrchestratorRun: vi.fn(),
    mockCreateImplementationOrchestrator: vi.fn(),
    mockPackLoad: vi.fn(),
    mockPhaseOrchestratorStartRun: vi.fn(),
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
  queryReadyStories: vi.fn().mockResolvedValue([]),
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
      run: mockOrchestratorRun,
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
    id: 'run-det-123',
    methodology: 'bmad',
    current_phase: 'implementation',
    status: 'running',
    created_at: '2026-01-01T00:00:00Z',
  }),
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
  inspectProcessTree: vi
    .fn()
    .mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))

vi.mock('../../../modules/phase-orchestrator/phase-detection.js', () => ({
  detectStartPhase: (...args: unknown[]) => mockDetectStartPhase(...args),
}))

vi.mock('../../../modules/phase-orchestrator/index.js', () => ({
  createPhaseOrchestrator: vi.fn(() => ({
    startRun: mockPhaseOrchestratorStartRun,
    advancePhase: vi.fn().mockResolvedValue({ advanced: true, phase: 'implementation' }),
    getRunStatus: vi.fn().mockResolvedValue({ currentPhase: 'implementation', status: 'running' }),
    resumeRun: vi.fn(),
    markPhaseFailed: vi.fn(),
  })),
}))

vi.mock('../../../modules/phase-orchestrator/phases/analysis.js', () => ({
  runAnalysisPhase: vi
    .fn()
    .mockResolvedValue({ result: 'success', tokenUsage: { input: 0, output: 0 } }),
}))

vi.mock('../../../modules/phase-orchestrator/phases/planning.js', () => ({
  runPlanningPhase: vi
    .fn()
    .mockResolvedValue({ result: 'success', tokenUsage: { input: 0, output: 0 } }),
}))

vi.mock('../../../modules/phase-orchestrator/phases/solutioning.js', () => ({
  runSolutioningPhase: vi
    .fn()
    .mockResolvedValue({ result: 'success', tokenUsage: { input: 0, output: 0 } }),
}))

vi.mock('../../../modules/phase-orchestrator/phases/ux-design.js', () => ({
  runUxDesignPhase: vi
    .fn()
    .mockResolvedValue({ result: 'success', tokenUsage: { input: 0, output: 0 } }),
}))

vi.mock('../../../modules/phase-orchestrator/phases/research.js', () => ({
  runResearchPhase: vi
    .fn()
    .mockResolvedValue({ result: 'success', tokenUsage: { input: 0, output: 0 } }),
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
  loadModelRoutingConfig: vi.fn().mockImplementation(() => {
    throw new Error('No config')
  }),
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
}))

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readdir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { runRunAction } from '../run.js'
import type { AdapterRegistry } from '../../../adapters/adapter-registry.js'

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Story 39-2: --stories bypasses phase detection', () => {
  const defaultStatus = {
    state: 'COMPLETE',
    stories: { '39-1': { phase: 'COMPLETE', reviewCycles: 1 } },
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
    totalDurationMs: 60000,
    maxConcurrentActual: 1,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockPackLoad.mockResolvedValue(mockPack())
    mockOrchestratorRun.mockResolvedValue(defaultStatus)
    mockPhaseOrchestratorStartRun.mockResolvedValue('run-full-123')

    // Default: story file found for '39-1'
    mockReaddirSync.mockReturnValue(['39-1-test-story.md'])

    // Default: existsSync returns true for artifacts dir, false for .dolt
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      if (path.includes('.dolt')) return false
      return true
    })
  })

  describe('AC1: --stories flag bypasses phase detection', () => {
    it('does NOT call detectStartPhase when --stories is provided', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction({
        pack: 'bmad',
        stories: '39-1',
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      expect(exitCode).toBe(0)
      expect(mockDetectStartPhase).not.toHaveBeenCalled()

      stdoutWrite.mockRestore()
    })

    it('calls the implementation orchestrator directly with provided story keys', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      await runRunAction({
        pack: 'bmad',
        stories: '39-1',
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      expect(mockOrchestratorRun).toHaveBeenCalledWith(['39-1'])

      stdoutWrite.mockRestore()
    })

    it('handles multiple story keys when --stories provides a comma-separated list', async () => {
      mockReaddirSync.mockReturnValue(['39-1-story-a.md', '39-2-story-b.md'])
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction({
        pack: 'bmad',
        stories: '39-1,39-2',
        concurrency: 2,
        outputFormat: 'human',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      expect(exitCode).toBe(0)
      expect(mockDetectStartPhase).not.toHaveBeenCalled()
      expect(mockOrchestratorRun).toHaveBeenCalledWith(['39-1', '39-2'])

      stdoutWrite.mockRestore()
    })
  })

  describe('AC2: --from still works (backward compatibility)', () => {
    it('does NOT call detectStartPhase when --from is provided (effectiveStartPhase is set)', async () => {
      // --from implementation routes to runFullPipeline directly without calling detectStartPhase
      mockReaddirSync.mockReturnValue([])
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction({
        pack: 'bmad',
        from: 'implementation',
        stories: undefined,
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      // --from sets effectiveStartPhase directly, so detectStartPhase is never called
      expect(mockDetectStartPhase).not.toHaveBeenCalled()
      // Route went through runFullPipeline — phase orchestrator startRun was called
      expect(mockPhaseOrchestratorStartRun).toHaveBeenCalled()
      expect(exitCode).toBe(0)

      stdoutWrite.mockRestore()
    })
  })

  describe('AC3: no --stories preserves auto-detection', () => {
    it('calls detectStartPhase when neither --stories nor --from is provided', async () => {
      // detectStartPhase returns implementation → direct implementation path
      mockDetectStartPhase.mockResolvedValue({
        phase: 'implementation',
        reason: 'stories ready for implementation',
        needsConcept: false,
      })
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction({
        pack: 'bmad',
        stories: undefined,
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      expect(mockDetectStartPhase).toHaveBeenCalled()
      expect(exitCode).toBe(0)

      stdoutWrite.mockRestore()
    })

    it('routes to runFullPipeline when detectStartPhase returns a non-implementation phase', async () => {
      mockDetectStartPhase.mockResolvedValue({
        phase: 'solutioning',
        reason: 'planning complete — continuing with solutioning',
        needsConcept: false,
      })
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction({
        pack: 'bmad',
        stories: undefined,
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      // detectStartPhase WAS called
      expect(mockDetectStartPhase).toHaveBeenCalled()
      // runFullPipeline was called (phase orchestrator startRun invoked)
      expect(mockPhaseOrchestratorStartRun).toHaveBeenCalledWith('', 'solutioning')
      expect(exitCode).toBe(0)

      stdoutWrite.mockRestore()
    })
  })

  describe('AC4: missing story files are non-blocking (create-story generates them)', () => {
    it('proceeds with missing story files — create-story phase will generate them', async () => {
      // readdirSync returns empty list — no story files exist yet
      mockReaddirSync.mockReturnValue([])

      const exitCode = await runRunAction({
        pack: 'bmad',
        stories: 'H2-1',
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      // Should NOT fail — missing story files are expected before create-story runs
      expect(exitCode).toBe(0)
    })

    it('proceeds in json output mode with missing story files', async () => {
      mockReaddirSync.mockReturnValue([])

      const exitCode = await runRunAction({
        pack: 'bmad',
        stories: 'H2-1',
        concurrency: 1,
        outputFormat: 'json',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      expect(exitCode).toBe(0)
    })

    it('skips validation and proceeds when artifacts directory does not exist', async () => {
      // existsSync returns false for the artifacts dir — no validation possible
      mockExistsSync.mockImplementation((p: unknown) => {
        const path = String(p)
        if (path.includes('implementation-artifacts')) return false
        if (path.includes('.dolt')) return false
        return true
      })
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction({
        pack: 'bmad',
        stories: '39-1',
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      // Validation was skipped (dir not found) — should proceed to implementation
      expect(exitCode).toBe(0)
      expect(mockOrchestratorRun).toHaveBeenCalled()

      stdoutWrite.mockRestore()
    })
  })
})
