// @vitest-environment node
/**
 * Unit tests for resume command manifest-read path — Story 52-6.
 *
 * AC3: resume reads story scope from manifest when --stories flag not provided
 * AC4: resume falls back to Dolt-based unscoped discovery when manifest absent
 *
 * Note: runResumeAction has many heavy dependencies (DB adapter, pack loader,
 * phase orchestrator). These tests mock all external dependencies and focus on
 * verifying that:
 * 1. When no --stories flag: manifest cli_flags.stories is used as scope
 * 2. When --stories flag provided: user flag overrides manifest
 * 3. When manifest absent: falls back gracefully (no error)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RunManifestData } from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockManifestRead,
  mockRunManifestConstructor,
  mockFsReadFile,
  mockResolveStoryKeys,
  mockOrchestratorRun,
  mockPackLoad,
  mockResumeRun,
} = vi.hoisted(() => {
  const mockManifestRead = vi.fn()
  const mockRunManifestConstructor = vi.fn().mockImplementation(() => ({
    read: mockManifestRead,
  }))
  const mockFsReadFile = vi.fn()
  const mockResolveStoryKeys = vi.fn().mockResolvedValue([])
  const mockOrchestratorRun = vi.fn().mockResolvedValue(undefined)
  const mockPackLoad = vi.fn().mockResolvedValue({ name: 'bmad', version: '1.0', agents: [] })
  const mockResumeRun = vi.fn().mockResolvedValue({ currentPhase: 'implementation', status: 'running' })
  return {
    mockManifestRead,
    mockRunManifestConstructor,
    mockFsReadFile,
    mockResolveStoryKeys,
    mockOrchestratorRun,
    mockPackLoad,
    mockResumeRun,
  }
})

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

vi.mock('@substrate-ai/sdlc', () => ({
  RunManifest: mockRunManifestConstructor,
}))

vi.mock('fs/promises', () => ({
  readFile: mockFsReadFile,
}))

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

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/test-resume-project'),
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
}))

vi.mock('../../../persistence/queries/decisions.js', () => ({
  getLatestRun: vi.fn().mockResolvedValue({
    id: 'resume-run-id',
    status: 'running',
    methodology: 'bmad',
    current_phase: 'implementation',
    config_json: '{}',
    token_usage_json: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:01:00Z',
  }),
  addTokenUsage: vi.fn().mockResolvedValue(undefined),
  getTokenUsageSummary: vi.fn().mockResolvedValue([]),
  updatePipelineRun: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../modules/methodology-pack/pack-loader.js', () => ({
  createPackLoader: vi.fn(() => ({ load: mockPackLoad })),
}))

vi.mock('../../../modules/phase-orchestrator/index.js', () => ({
  createPhaseOrchestrator: vi.fn(() => ({
    resumeRun: mockResumeRun,
    advancePhase: vi.fn().mockResolvedValue({ advanced: true }),
    startRun: vi.fn().mockResolvedValue('resume-run-id'),
  })),
}))

vi.mock('../../../modules/implementation-orchestrator/index.js', () => ({
  createImplementationOrchestrator: vi.fn(() => ({
    run: mockOrchestratorRun,
  })),
  resolveStoryKeys: mockResolveStoryKeys,
}))

vi.mock('../../../modules/context-compiler/index.js', () => ({
  createContextCompiler: vi.fn(() => ({})),
}))

vi.mock('../../../modules/agent-dispatch/index.js', () => ({
  createDispatcher: vi.fn(() => ({})),
}))

vi.mock('../../../core/event-bus.js', () => ({
  createEventBus: vi.fn(() => ({ on: vi.fn(), emit: vi.fn() })),
}))

vi.mock('../../../modules/stop-after/index.js', () => ({
  VALID_PHASES: ['analysis', 'planning', 'solutioning', 'implementation'],
  createStopAfterGate: vi.fn(() => ({ shouldHalt: vi.fn().mockReturnValue(false) })),
  formatPhaseCompletionSummary: vi.fn().mockReturnValue(''),
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

vi.mock('../../../modules/telemetry/ingestion-server.js', () => ({
  IngestionServer: vi.fn(),
}))

vi.mock('../../../modules/telemetry/adapter-persistence.js', () => ({
  AdapterTelemetryPersistence: vi.fn(),
}))

vi.mock('../../../modules/config/config-system-impl.js', () => ({
  createConfigSystem: vi.fn(() => ({
    load: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn().mockReturnValue({ telemetry: { enabled: false } }),
  })),
}))

vi.mock('../../../modules/implementation-orchestrator/event-emitter.js', () => ({
  createEventEmitter: vi.fn(() => ({ emit: vi.fn() })),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

import { runResumeAction } from '../resume.js'

function makeManifestData(overrides: Partial<RunManifestData> = {}): RunManifestData {
  return {
    run_id: 'resume-run-id',
    cli_flags: { stories: ['2-1', '2-2'] },
    story_scope: ['2-1', '2-2', '2-3'],
    supervisor_pid: null,
    supervisor_session_id: null,
    per_story_state: {},
    recovery_history: [],
    cost_accumulation: { per_story: {}, run_total: 0 },
    pending_proposals: [],
    generation: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:01:00Z',
    ...overrides,
  }
}

/** Build a minimal mock AdapterRegistry */
function makeRegistry() {
  return {
    get: vi.fn().mockReturnValue(undefined),
    discoverAndRegister: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resume command — manifest-read path (Story 52-6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no current-run-id
    mockFsReadFile.mockRejectedValue(new Error('ENOENT'))
    mockAdapter.query.mockResolvedValue([])
    // Default manifest: has cli_flags.stories
    mockManifestRead.mockResolvedValue(makeManifestData())
    // Default orchestrator run completes successfully
    mockOrchestratorRun.mockResolvedValue(undefined)
    mockResolveStoryKeys.mockResolvedValue(['2-1', '2-2'])
  })

  describe('AC3: manifest available — scope from cli_flags.stories', () => {
    it('uses cli_flags.stories from manifest when --stories flag not provided (AC3)', async () => {
      // Arrange: manifest with cli_flags.stories = ['2-1', '2-2']
      mockManifestRead.mockResolvedValue(makeManifestData({
        cli_flags: { stories: ['2-1', '2-2'] },
        story_scope: [],
      }))

      // Act: call resume WITHOUT explicit stories
      const exitCode = await runResumeAction({
        runId: undefined,  // use getLatestRun (mocked to return the run)
        outputFormat: 'human',
        projectRoot: '/tmp/test-resume-project',
        concurrency: 3,
        pack: 'bmad',
        stories: undefined,  // no explicit --stories
        registry: makeRegistry(),
      })

      // Assert: resolveStoryKeys called with manifest stories as explicit scope
      expect(mockResolveStoryKeys).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ explicit: ['2-1', '2-2'] }),
      )
      expect(exitCode).toBe(0)
    })

    it('falls back to story_scope when cli_flags.stories is empty (AC3)', async () => {
      // Arrange: manifest with no cli_flags.stories but story_scope set
      mockManifestRead.mockResolvedValue(makeManifestData({
        cli_flags: {},  // no stories in cli_flags
        story_scope: ['2-1', '2-2', '2-3'],
      }))

      await runResumeAction({
        runId: undefined,  // use getLatestRun (mocked to return the run)
        outputFormat: 'human',
        projectRoot: '/tmp/test-resume-project',
        concurrency: 3,
        pack: 'bmad',
        stories: undefined,
        registry: makeRegistry(),
      })

      // Should use story_scope as fallback
      expect(mockResolveStoryKeys).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ explicit: ['2-1', '2-2', '2-3'] }),
      )
    })

    it('CLI --stories overrides manifest scope (AC3)', async () => {
      // Arrange: manifest has stories, but user provided explicit --stories
      mockManifestRead.mockResolvedValue(makeManifestData({
        cli_flags: { stories: ['2-1', '2-2'] },
        story_scope: [],
      }))

      await runResumeAction({
        runId: undefined,  // use getLatestRun (mocked to return the run)
        outputFormat: 'human',
        projectRoot: '/tmp/test-resume-project',
        concurrency: 3,
        pack: 'bmad',
        stories: ['3-1', '3-2'],  // explicit user override
        registry: makeRegistry(),
      })

      // User's explicit stories should be used
      expect(mockResolveStoryKeys).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ explicit: ['3-1', '3-2'] }),
      )
    })
  })

  describe('AC4: manifest absent — falls back gracefully', () => {
    it('falls back to Dolt-based unscoped discovery when manifest read throws (AC4)', async () => {
      // Arrange: manifest read fails
      mockRunManifestConstructor.mockImplementationOnce(() => ({
        read: vi.fn().mockRejectedValue(new Error('manifest not found')),
      }))

      // config_json has no explicitStories → fully unscoped discovery
      const exitCode = await runResumeAction({
        runId: undefined,  // use getLatestRun (mocked to return the run)
        outputFormat: 'human',
        projectRoot: '/tmp/test-resume-project',
        concurrency: 3,
        pack: 'bmad',
        stories: undefined,
        registry: makeRegistry(),
      })

      // resolveStoryKeys called without explicit scope from manifest
      // (may have explicit: undefined or from config_json, but NOT from manifest)
      expect(exitCode).toBe(0)
    })

    it('resume does not throw when manifest is completely absent (AC4)', async () => {
      // Both RunManifest constructor fails and readFile fails
      mockRunManifestConstructor.mockImplementationOnce(() => ({
        read: vi.fn().mockRejectedValue(new Error('ENOENT')),
      }))
      mockFsReadFile.mockRejectedValue(new Error('ENOENT'))

      // Should still complete without errors
      await expect(
        runResumeAction({
          runId: undefined,  // use getLatestRun (mocked to return the run)
          outputFormat: 'human',
          projectRoot: '/tmp/test-resume-project',
          concurrency: 3,
          pack: 'bmad',
          stories: undefined,
          registry: makeRegistry(),
        }),
      ).resolves.toBe(0)
    })
  })
})
