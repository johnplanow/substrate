// @vitest-environment node
/**
 * Unit tests for Story 28-9: RepoMapInjector wiring in run.ts
 *
 * AC7 requirement: run.ts wiring is validated by a test confirming that
 * WorkflowDeps.repoMapInjector is populated when Dolt is active and
 * omitted when file backend is active.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be before vi.mock factories
// ---------------------------------------------------------------------------

const {
  MockRepoMapInjector,
  MockDoltSymbolRepository,
  MockDoltRepoMapMetaRepository,
  MockRepoMapQueryEngine,
  MockRepoMapModule,
  MockDoltClient,
  mockCreateImplementationOrchestrator,
  mockOrchestratorRun,
  mockEventBusEmit,
  mockEventBusOn,
  mockExistsSync,
  mockPackLoad,
} = vi.hoisted(() => {
  const MockRepoMapInjector = vi.fn().mockImplementation(() => ({
    buildContext: vi.fn().mockResolvedValue({ text: '', symbolCount: 0, truncated: false }),
  }))
  const MockDoltSymbolRepository = vi.fn().mockImplementation(() => ({}))
  const MockDoltRepoMapMetaRepository = vi.fn().mockImplementation(() => ({}))
  const MockRepoMapQueryEngine = vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ symbols: [], symbolCount: 0, truncated: false, queryDurationMs: 1 }),
  }))
  const MockRepoMapModule = vi.fn().mockImplementation(() => ({
    checkStaleness: vi.fn().mockResolvedValue(null),
  }))
  const MockDoltClient = vi.fn().mockImplementation(() => ({}))
  const mockCreateImplementationOrchestrator = vi.fn()
  const mockOrchestratorRun = vi.fn()
  const mockEventBusEmit = vi.fn()
  const mockEventBusOn = vi.fn()
  const mockExistsSync = vi.fn().mockReturnValue(true)
  const mockPackLoad = vi.fn()
  return {
    MockRepoMapInjector,
    MockDoltSymbolRepository,
    MockDoltRepoMapMetaRepository,
    MockRepoMapQueryEngine,
    MockRepoMapModule,
    MockDoltClient,
    mockCreateImplementationOrchestrator,
    mockOrchestratorRun,
    mockEventBusEmit,
    mockEventBusOn,
    mockExistsSync,
    mockPackLoad,
  }
})

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

const mockAdapter = { query: vi.fn().mockResolvedValue([]), exec: vi.fn().mockResolvedValue(undefined), transaction: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

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
  RepoMapInjector: MockRepoMapInjector,
}))

vi.mock('../../../modules/repo-map/index.js', () => ({
  DoltSymbolRepository: MockDoltSymbolRepository,
  DoltRepoMapMetaRepository: MockDoltRepoMapMetaRepository,
  RepoMapQueryEngine: MockRepoMapQueryEngine,
  RepoMapModule: MockRepoMapModule,
}))

vi.mock('../../../modules/state/index.js', () => ({
  DoltClient: MockDoltClient,
  createStateStore: vi.fn(),
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
  resolveStoryKeys: vi.fn().mockReturnValue([]),
}))

vi.mock('../../../persistence/queries/decisions.js', () => ({
  createPipelineRun: vi.fn().mockReturnValue({
    id: 'run-123',
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
  inspectProcessTree: vi.fn().mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))

vi.mock('../../../modules/phase-orchestrator/phase-detection.js', () => ({
  detectStartPhase: vi.fn().mockReturnValue({
    phase: 'implementation',
    reason: 'stories ready',
    needsConcept: false,
  }),
}))

vi.mock('../../../core/event-bus.js', () => ({
  createEventBus: vi.fn(() => ({
    on: mockEventBusOn,
    emit: mockEventBusEmit,
    off: vi.fn(),
  })),
}))

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readdir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
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

vi.mock('../../../modules/routing/index.js', () => ({
  RoutingResolver: {
    createWithFallback: vi.fn().mockReturnValue({
      resolveModel: vi.fn().mockReturnValue(null),
    }),
  },
}))

vi.mock('../../../modules/telemetry/ingestion-server.js', () => ({
  IngestionServer: vi.fn(),
}))

vi.mock('../../../modules/telemetry/index.js', () => ({
  TelemetryPersistence: vi.fn(),
}))

vi.mock('../../../modules/stop-after/index.js', () => ({
  VALID_PHASES: ['analysis', 'planning', 'solutioning', 'implementation'],
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
    },
    getPrompt: vi.fn(),
    getConstraint: vi.fn(),
    getTemplate: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run.ts — RepoMapInjector wiring (Story 28-9 AC7)', () => {
  const defaultStatus = {
    state: 'COMPLETE',
    stories: { '28-1': { phase: 'COMPLETE', reviewCycles: 1 } },
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
    totalDurationMs: 60000,
    maxConcurrentActual: 1,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockPackLoad.mockResolvedValue(mockPack())
    mockOrchestratorRun.mockResolvedValue(defaultStatus)

    // Default: existsSync returns false for .dolt (file backend)
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      if (path.includes('.dolt')) return false
      return true
    })

    // Reset class mocks to their default implementations
    MockRepoMapModule.mockImplementation(() => ({
      checkStaleness: vi.fn().mockResolvedValue(null),
    }))
    MockRepoMapInjector.mockImplementation(() => ({
      buildContext: vi.fn().mockResolvedValue({ text: '', symbolCount: 0, truncated: false }),
    }))
  })

  describe('when Dolt is NOT available (file backend)', () => {
    it('calls createImplementationOrchestrator WITHOUT repoMapInjector', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction({
        pack: 'bmad',
        stories: '28-1',
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      expect(exitCode).toBe(0)
      expect(mockCreateImplementationOrchestrator).toHaveBeenCalledOnce()
      const callArgs = mockCreateImplementationOrchestrator.mock.calls[0][0] as Record<string, unknown>
      expect(callArgs.repoMapInjector).toBeUndefined()

      stdoutWrite.mockRestore()
    })
  })

  describe('when Dolt IS available', () => {
    beforeEach(() => {
      // Return true for all paths including .dolt
      mockExistsSync.mockReturnValue(true)
    })

    it('calls createImplementationOrchestrator WITH repoMapInjector', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction({
        pack: 'bmad',
        stories: '28-1',
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      expect(exitCode).toBe(0)
      expect(mockCreateImplementationOrchestrator).toHaveBeenCalledOnce()
      const callArgs = mockCreateImplementationOrchestrator.mock.calls[0][0] as Record<string, unknown>
      expect(callArgs.repoMapInjector).toBeDefined()
      expect(callArgs.maxRepoMapTokens).toBe(2000)

      stdoutWrite.mockRestore()
    })

    it('constructs the full repo-map chain: DoltClient, Repos, QueryEngine, Module, Injector', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      await runRunAction({
        pack: 'bmad',
        stories: '28-1',
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      expect(MockDoltClient).toHaveBeenCalledOnce()
      expect(MockDoltSymbolRepository).toHaveBeenCalledOnce()
      expect(MockDoltRepoMapMetaRepository).toHaveBeenCalledOnce()
      expect(MockRepoMapQueryEngine).toHaveBeenCalledOnce()
      expect(MockRepoMapModule).toHaveBeenCalledOnce()
      expect(MockRepoMapInjector).toHaveBeenCalledOnce()

      stdoutWrite.mockRestore()
    })

    it('emits pipeline:repo-map-stale when checkStaleness returns stale diff', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const staleInfo = { storedSha: 'abc123', headSha: 'def456', fileCount: 42 }
      MockRepoMapModule.mockImplementation(() => ({
        checkStaleness: vi.fn().mockResolvedValue(staleInfo),
      }))

      await runRunAction({
        pack: 'bmad',
        stories: '28-1',
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      expect(mockEventBusEmit).toHaveBeenCalledWith('pipeline:repo-map-stale', staleInfo)

      stdoutWrite.mockRestore()
    })

    it('does NOT emit pipeline:repo-map-stale when checkStaleness returns null', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      // Default mock: checkStaleness returns null
      await runRunAction({
        pack: 'bmad',
        stories: '28-1',
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        registry: mockRegistry,
      })

      expect(mockEventBusEmit).not.toHaveBeenCalledWith(
        'pipeline:repo-map-stale',
        expect.anything(),
      )

      stdoutWrite.mockRestore()
    })
  })

  describe('--dry-run flag (AC6)', () => {
    it('exits 0 without calling createImplementationOrchestrator', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction({
        pack: 'bmad',
        stories: '28-1',
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        dryRun: true,
        registry: mockRegistry,
      })

      expect(exitCode).toBe(0)
      expect(mockCreateImplementationOrchestrator).not.toHaveBeenCalled()
      expect(mockOrchestratorRun).not.toHaveBeenCalled()

      stdoutWrite.mockRestore()
    })

    it('outputs JSON with stories array when --output-format json', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction({
        pack: 'bmad',
        stories: '28-1',
        concurrency: 1,
        outputFormat: 'json',
        projectRoot: '/test/project',
        dryRun: true,
        registry: mockRegistry,
      })

      expect(exitCode).toBe(0)
      const calls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      const jsonLine = calls.find((c) => {
        try {
          const obj = JSON.parse(c) as { stories?: unknown }
          return Array.isArray(obj.stories)
        } catch {
          return false
        }
      })
      expect(jsonLine).toBeDefined()
      const parsed = JSON.parse(jsonLine!) as { stories: Array<{ storyKey: string; phases: unknown[] }> }
      expect(parsed.stories).toHaveLength(1)
      expect(parsed.stories[0]?.storyKey).toBe('28-1')
      expect(parsed.stories[0]?.phases).toHaveLength(3) // explore, generate, review

      stdoutWrite.mockRestore()
    })

    it('outputs text preview table with Story/Phase/Model/Est. Symbols header in human mode', async () => {
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const exitCode = await runRunAction({
        pack: 'bmad',
        stories: '28-1',
        concurrency: 1,
        outputFormat: 'human',
        projectRoot: '/test/project',
        dryRun: true,
        registry: mockRegistry,
      })

      expect(exitCode).toBe(0)
      const output = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('Story')
      expect(output).toContain('Phase')
      expect(output).toContain('Model')
      expect(output).toContain('Est. Symbols')

      stdoutWrite.mockRestore()
    })
  })
})
