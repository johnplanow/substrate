/**
 * Unit tests for the efficiency-gate logic in retry-escalated (Story 30-8).
 *
 * Covers:
 *   - compositeScore < 50 emits [WARN] line
 *   - contextManagementSubScore < 50 emits [INFO] line and sets context ceiling
 *   - --force flag bypasses gate entirely
 *   - null profile (no telemetry data) does nothing
 *   - exception inside getEfficiencyProfile is caught and skipped
 *   - perStoryContextCeilings is passed into orchestrator config when ceiling is set
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — declared before imports (vitest hoisting)
// ---------------------------------------------------------------------------

// Mock database adapter
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

// Mock getRetryableEscalations — default returns one retryable story
const mockGetRetryableEscalations = vi.fn().mockResolvedValue({
  retryable: ['30-5'],
  skipped: [],
})

vi.mock('../../../persistence/queries/retry-escalated.js', () => ({
  getRetryableEscalations: (...args: unknown[]) => mockGetRetryableEscalations(...args),
}))

// Mock createPipelineRun + addTokenUsage
const mockCreatePipelineRun = vi.fn().mockResolvedValue({
  id: 'run-abc',
  methodology: 'bmad',
  status: 'running',
  config_json: null,
  token_usage_json: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
})
const mockAddTokenUsage = vi.fn()

vi.mock('../../../persistence/queries/decisions.js', () => ({
  createPipelineRun: (...args: unknown[]) => mockCreatePipelineRun(...args),
  addTokenUsage: (...args: unknown[]) => mockAddTokenUsage(...args),
}))

// Mock git root
vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/fake/root'),
}))

// Mock fs
const mockExistsSync = vi.fn().mockReturnValue(true)
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: vi.fn(),
}))

// Mock PackLoader
vi.mock('../../../modules/methodology-pack/pack-loader.js', () => ({
  createPackLoader: vi.fn(() => ({
    load: vi.fn().mockResolvedValue({
      manifest: { name: 'bmad', version: '1.0.0', description: 'BMAD methodology pack' },
      getPrompt: vi.fn(),
    }),
  })),
}))

// Mock context-compiler
vi.mock('../../../modules/context-compiler/index.js', () => ({
  createContextCompiler: vi.fn(() => ({ compile: vi.fn() })),
}))

// Mock agent-dispatch
vi.mock('../../../modules/agent-dispatch/index.js', () => ({
  createDispatcher: vi.fn(() => ({
    dispatch: vi.fn(),
    shutdown: vi.fn(),
    getPending: vi.fn(() => 0),
    getRunning: vi.fn(() => 0),
  })),
}))

// Mock event bus
vi.mock('../../../core/event-bus.js', () => ({
  createEventBus: vi.fn(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    off: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Mock TelemetryAdvisor
// ---------------------------------------------------------------------------

const mockGetEfficiencyProfile = vi.fn()

vi.mock('../../../modules/telemetry/telemetry-advisor.js', () => ({
  createTelemetryAdvisor: vi.fn(() => ({
    getEfficiencyProfile: (...args: unknown[]) => mockGetEfficiencyProfile(...args),
  })),
}))

// ---------------------------------------------------------------------------
// Mock ImplementationOrchestrator — capture the config passed to it
// ---------------------------------------------------------------------------

const mockOrchestratorRun = vi.fn().mockResolvedValue(undefined)
const capturedOrchestratorConfigs: unknown[] = []

vi.mock('../../../modules/implementation-orchestrator/index.js', () => ({
  createImplementationOrchestrator: vi.fn((deps: { config: unknown }) => {
    capturedOrchestratorConfigs.push(deps.config)
    return { run: mockOrchestratorRun }
  }),
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { runRetryEscalatedAction } from '../retry-escalated.js'

// ---------------------------------------------------------------------------
// Shared registry mock
// ---------------------------------------------------------------------------

const mockRegistry = {
  discoverAndRegister: vi.fn().mockResolvedValue({ results: [], failedCount: 0 }),
} as any

// ---------------------------------------------------------------------------
// Helper: build base options for a live (non-dry-run) call
// ---------------------------------------------------------------------------

function baseOptions(overrides: Partial<Parameters<typeof runRetryEscalatedAction>[0]> = {}) {
  return {
    dryRun: false,
    force: false,
    outputFormat: 'human' as const,
    projectRoot: '/test',
    concurrency: 1,
    pack: 'bmad',
    registry: mockRegistry,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('retry-escalated efficiency gate (Story 30-8)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedOrchestratorConfigs.length = 0
    mockExistsSync.mockReturnValue(true)
    mockOrchestratorRun.mockResolvedValue(undefined)
    mockGetRetryableEscalations.mockResolvedValue({
      retryable: ['30-5'],
      skipped: [],
    })
    mockCreatePipelineRun.mockResolvedValue({
      id: 'run-abc',
      methodology: 'bmad',
      status: 'running',
      config_json: null,
      token_usage_json: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })
  })

  // -------------------------------------------------------------------------
  // compositeScore < 50 → [WARN] output
  // -------------------------------------------------------------------------

  it('emits [WARN] when compositeScore < 50', async () => {
    mockGetEfficiencyProfile.mockResolvedValue({
      storyKey: '30-5',
      compositeScore: 40,
      cacheHitSubScore: 30,
      ioRatioSubScore: 50,
      contextManagementSubScore: 80,
      totalTurns: 10,
      contextSpikeCount: 0,
    })

    const writes: string[] = []
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })

    await runRetryEscalatedAction(baseOptions())

    stdoutWrite.mockRestore()

    const warnLine = writes.find((w) => w.startsWith('[WARN]'))
    expect(warnLine).toBeDefined()
    expect(warnLine).toContain('30-5')
    expect(warnLine).toContain('40')
  })

  // -------------------------------------------------------------------------
  // contextManagementSubScore < 50 → [INFO] + ceiling set
  // -------------------------------------------------------------------------

  it('emits [INFO] and sets context ceiling when contextManagementSubScore < 50', async () => {
    mockGetEfficiencyProfile.mockResolvedValue({
      storyKey: '30-5',
      compositeScore: 70,
      cacheHitSubScore: 80,
      ioRatioSubScore: 70,
      contextManagementSubScore: 30,
      totalTurns: 10,
      contextSpikeCount: 7,
    })

    const writes: string[] = []
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })

    await runRetryEscalatedAction(baseOptions())

    stdoutWrite.mockRestore()

    const infoLine = writes.find((w) => w.startsWith('[INFO]'))
    expect(infoLine).toBeDefined()
    expect(infoLine).toContain('30-5')
    expect(infoLine).toContain('80000') // 100_000 * 0.8 = 80000
  })

  it('passes perStoryContextCeilings into orchestrator config when ceiling is set', async () => {
    mockGetEfficiencyProfile.mockResolvedValue({
      storyKey: '30-5',
      compositeScore: 70,
      cacheHitSubScore: 80,
      ioRatioSubScore: 70,
      contextManagementSubScore: 30,
      totalTurns: 10,
      contextSpikeCount: 7,
    })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await runRetryEscalatedAction(baseOptions())
    stdoutWrite.mockRestore()

    expect(capturedOrchestratorConfigs).toHaveLength(1)
    const config = capturedOrchestratorConfigs[0] as Record<string, unknown>
    expect(config).toHaveProperty('perStoryContextCeilings')
    const ceilings = config.perStoryContextCeilings as Record<string, number>
    expect(ceilings['30-5']).toBe(80000)
  })

  // -------------------------------------------------------------------------
  // --force bypasses gate
  // -------------------------------------------------------------------------

  it('does not call getEfficiencyProfile when --force is set', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await runRetryEscalatedAction(baseOptions({ force: true }))
    stdoutWrite.mockRestore()

    expect(mockGetEfficiencyProfile).not.toHaveBeenCalled()
  })

  it('does not set perStoryContextCeilings when --force bypasses gate', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await runRetryEscalatedAction(baseOptions({ force: true }))
    stdoutWrite.mockRestore()

    const config = capturedOrchestratorConfigs[0] as Record<string, unknown>
    // Either no perStoryContextCeilings key, or it's an empty object
    if (Object.prototype.hasOwnProperty.call(config, 'perStoryContextCeilings')) {
      expect(Object.keys(config.perStoryContextCeilings as Record<string, number>)).toHaveLength(0)
    }
  })

  // -------------------------------------------------------------------------
  // null profile → nothing happens
  // -------------------------------------------------------------------------

  it('does nothing when getEfficiencyProfile returns null (no prior telemetry)', async () => {
    mockGetEfficiencyProfile.mockResolvedValue(null)

    const writes: string[] = []
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })

    await runRetryEscalatedAction(baseOptions())

    stdoutWrite.mockRestore()

    const warnLine = writes.find((w) => w.startsWith('[WARN]'))
    const infoLine = writes.find((w) => w.startsWith('[INFO]'))
    expect(warnLine).toBeUndefined()
    expect(infoLine).toBeUndefined()
  })

  it('does not set perStoryContextCeilings when profile is null', async () => {
    mockGetEfficiencyProfile.mockResolvedValue(null)

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await runRetryEscalatedAction(baseOptions())
    stdoutWrite.mockRestore()

    const config = capturedOrchestratorConfigs[0] as Record<string, unknown>
    // Either no key or empty
    if (Object.prototype.hasOwnProperty.call(config, 'perStoryContextCeilings')) {
      expect(Object.keys(config.perStoryContextCeilings as Record<string, number>)).toHaveLength(0)
    }
  })

  // -------------------------------------------------------------------------
  // Exception in getEfficiencyProfile is caught and skipped
  // -------------------------------------------------------------------------

  it('catches exception from getEfficiencyProfile and proceeds with retry', async () => {
    mockGetEfficiencyProfile.mockRejectedValue(new Error('DB read failure'))

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runRetryEscalatedAction(baseOptions())
    stdoutWrite.mockRestore()

    // Should still succeed (exception was caught)
    expect(exitCode).toBe(0)
    expect(mockOrchestratorRun).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // gate is skipped for --dry-run
  // -------------------------------------------------------------------------

  it('does not call getEfficiencyProfile when --dry-run is set', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await runRetryEscalatedAction(baseOptions({ dryRun: true }))
    stdoutWrite.mockRestore()

    expect(mockGetEfficiencyProfile).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Both conditions triggered: compositeScore < 50 AND contextMgmt < 50
  // -------------------------------------------------------------------------

  it('emits both [WARN] and [INFO] when both thresholds are crossed', async () => {
    mockGetEfficiencyProfile.mockResolvedValue({
      storyKey: '30-5',
      compositeScore: 30,
      cacheHitSubScore: 20,
      ioRatioSubScore: 30,
      contextManagementSubScore: 20,
      totalTurns: 8,
      contextSpikeCount: 6,
    })

    const writes: string[] = []
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })

    await runRetryEscalatedAction(baseOptions())

    stdoutWrite.mockRestore()

    expect(writes.some((w) => w.startsWith('[WARN]'))).toBe(true)
    expect(writes.some((w) => w.startsWith('[INFO]'))).toBe(true)
  })
})
