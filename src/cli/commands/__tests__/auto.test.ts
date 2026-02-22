/**
 * Unit tests for `src/cli/commands/auto.ts`
 *
 * Covers all 8 Acceptance Criteria:
 *   AC1: auto init — validates pack, initializes database, outputs success
 *   AC2: auto run — creates pipeline run, starts orchestrator, outputs progress
 *   AC3: auto status — queries latest run, formats output
 *   AC4: --output-format json — all outputs wrapped in { success, data, error }
 *   AC5: Token telemetry — addTokenUsage called, BMAD baseline comparison shown
 *   AC6: Command registration — registerAutoCommand registers init/run/status
 *   AC7: Error handling — missing pack, missing DB, invalid story keys
 *   AC8: Run without stories — discovers from decision store
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ---------------------------------------------------------------------------
// Mocks — declared before imports
// ---------------------------------------------------------------------------

// Mock DatabaseWrapper
const mockOpen = vi.fn()
const mockClose = vi.fn()
let mockDb: Record<string, unknown> = {}

vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: vi.fn().mockImplementation(() => ({
    open: mockOpen,
    close: mockClose,
    get db() {
      return mockDb
    },
    get isOpen() {
      return true
    },
  })),
}))

// Mock runMigrations
vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

// Mock PackLoader
const mockPackLoad = vi.fn()
const mockPackDiscover = vi.fn()

vi.mock('../../../modules/methodology-pack/pack-loader.js', () => ({
  createPackLoader: vi.fn(() => ({
    load: mockPackLoad,
    discover: mockPackDiscover,
  })),
}))

// Mock context-compiler
const mockContextCompilerCompile = vi.fn()
const mockContextCompilerRegister = vi.fn()

vi.mock('../../../modules/context-compiler/index.js', () => ({
  createContextCompiler: vi.fn(() => ({
    compile: mockContextCompilerCompile,
    registerTemplate: mockContextCompilerRegister,
  })),
}))

// Mock agent-dispatch
const mockDispatch = vi.fn()
const mockDispatcherShutdown = vi.fn()

vi.mock('../../../modules/agent-dispatch/index.js', () => ({
  createDispatcher: vi.fn(() => ({
    dispatch: mockDispatch,
    shutdown: mockDispatcherShutdown,
    getPending: vi.fn(() => 0),
    getRunning: vi.fn(() => 0),
  })),
}))

// Mock AdapterRegistry
const mockDiscoverAndRegister = vi.fn()

vi.mock('../../../adapters/adapter-registry.js', () => ({
  AdapterRegistry: vi.fn().mockImplementation(() => ({
    discoverAndRegister: mockDiscoverAndRegister,
  })),
}))

// Mock ImplementationOrchestrator
const mockOrchestratorRun = vi.fn()
const mockOrchestratorPause = vi.fn()
const mockOrchestratorResume = vi.fn()
const mockOrchestratorGetStatus = vi.fn()

vi.mock('../../../modules/implementation-orchestrator/index.js', () => ({
  createImplementationOrchestrator: vi.fn(() => ({
    run: mockOrchestratorRun,
    pause: mockOrchestratorPause,
    resume: mockOrchestratorResume,
    getStatus: mockOrchestratorGetStatus,
  })),
}))

// Mock decisions queries
const mockCreatePipelineRun = vi.fn()
const mockGetLatestRun = vi.fn()
const mockAddTokenUsage = vi.fn()
const mockGetTokenUsageSummary = vi.fn()

vi.mock('../../../persistence/queries/decisions.js', () => ({
  createPipelineRun: (...args: unknown[]) => mockCreatePipelineRun(...args),
  getLatestRun: (...args: unknown[]) => mockGetLatestRun(...args),
  addTokenUsage: (...args: unknown[]) => mockAddTokenUsage(...args),
  getTokenUsageSummary: (...args: unknown[]) => mockGetTokenUsageSummary(...args),
}))

// Mock event bus
const mockEventBus = {
  on: vi.fn(),
  emit: vi.fn(),
  off: vi.fn(),
}

vi.mock('../../../core/event-bus.js', () => ({
  createEventBus: vi.fn(() => mockEventBus),
}))

// Mock fs for existsSync and mkdirSync
const mockExistsSync = vi.fn()
const mockMkdirSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import {
  runAutoInit,
  runAutoRun,
  runAutoStatus,
  registerAutoCommand,
  formatOutput,
  formatTokenTelemetry,
  validateStoryKey,
} from '../auto.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockPipelineRun(overrides = {}) {
  return {
    id: 'run-uuid-123',
    methodology: 'bmad',
    current_phase: 'implementation',
    status: 'running',
    config_json: null,
    token_usage_json: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

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

describe('formatOutput', () => {
  it('returns JSON success format', () => {
    const result = formatOutput({ foo: 'bar' }, 'json', true)
    const parsed = JSON.parse(result)
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ foo: 'bar' })
  })

  it('returns JSON error format', () => {
    const result = formatOutput(null, 'json', false, 'something went wrong')
    const parsed = JSON.parse(result)
    expect(parsed.success).toBe(false)
    expect(parsed.error).toBe('something went wrong')
  })

  it('returns human format string as-is', () => {
    const result = formatOutput('hello world', 'human')
    expect(result).toBe('hello world')
  })
})

describe('validateStoryKey', () => {
  it('accepts valid story keys', () => {
    expect(validateStoryKey('10-1')).toBe(true)
    expect(validateStoryKey('1-2')).toBe(true)
    expect(validateStoryKey('100-99')).toBe(true)
  })

  it('rejects invalid story keys', () => {
    expect(validateStoryKey('abc')).toBe(false)
    expect(validateStoryKey('10')).toBe(false)
    expect(validateStoryKey('10-1-extra')).toBe(false)
    expect(validateStoryKey('')).toBe(false)
    expect(validateStoryKey('abc-def')).toBe(false)
  })
})

describe('formatTokenTelemetry', () => {
  it('shows "No token usage recorded" when empty', () => {
    expect(formatTokenTelemetry([])).toBe('No token usage recorded.')
  })

  it('shows token breakdown and BMAD baseline comparison', () => {
    const summary = [
      {
        phase: 'implementation',
        agent: 'claude-code',
        total_input_tokens: 1200,
        total_output_tokens: 800,
        total_cost_usd: 0.0054,
      },
    ]
    const output = formatTokenTelemetry(summary)
    expect(output).toContain('Pipeline Token Usage:')
    expect(output).toContain('implementation')
    expect(output).toContain('BMAD Baseline: 23,800 tokens')
    expect(output).toContain('Savings:')
  })
})

describe('runAutoInit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
  })

  it('AC1: initializes pack and database, outputs success (human format)', async () => {
    mockPackLoad.mockResolvedValue(mockPack())

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runAutoInit({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
    })

    expect(exitCode).toBe(0)
    expect(mockPackLoad).toHaveBeenCalledWith('/test/project/packs/bmad')
    expect(mockOpen).toHaveBeenCalled()
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('initialized successfully'))
    stdoutWrite.mockRestore()
  })

  it('AC1: creates .substrate directory if it does not exist', async () => {
    mockPackLoad.mockResolvedValue(mockPack())
    mockExistsSync.mockReturnValue(false)

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runAutoInit({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
    })

    expect(exitCode).toBe(0)
    expect(mockMkdirSync).toHaveBeenCalledWith('/test/project/.substrate', { recursive: true })
    stdoutWrite.mockRestore()
  })

  it('AC4: outputs JSON success format with --output-format json', async () => {
    mockPackLoad.mockResolvedValue(mockPack())

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runAutoInit({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'json',
    })

    expect(exitCode).toBe(0)
    const calls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    const jsonLine = calls.find((c) => c.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.success).toBe(true)
    expect(parsed.data.pack).toBe('bmad')
    stdoutWrite.mockRestore()
  })

  it('AC7: missing pack outputs error and exits 1 (human format)', async () => {
    mockPackLoad.mockRejectedValue(new Error('manifest.yaml not found'))

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitCode = await runAutoInit({
      pack: 'nonexistent',
      projectRoot: '/test/project',
      outputFormat: 'human',
    })

    expect(exitCode).toBe(1)
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("Methodology pack 'nonexistent' not found"),
    )
    stderrWrite.mockRestore()
  })

  it('AC7: missing pack in JSON mode outputs structured error', async () => {
    mockPackLoad.mockRejectedValue(new Error('manifest.yaml not found'))

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runAutoInit({
      pack: 'nonexistent',
      projectRoot: '/test/project',
      outputFormat: 'json',
    })

    expect(exitCode).toBe(1)
    const calls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    const jsonLine = calls.find((c) => c.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.success).toBe(false)
    expect(parsed.error).toContain("not found")
    stdoutWrite.mockRestore()
  })
})

describe('runAutoRun', () => {
  const defaultStatus = {
    state: 'COMPLETE',
    stories: {
      '10-1': { phase: 'COMPLETE', reviewCycles: 1 },
    },
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
    totalDurationMs: 60000,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockPackLoad.mockResolvedValue(mockPack())
    mockDiscoverAndRegister.mockResolvedValue(undefined)
    mockCreatePipelineRun.mockReturnValue(mockPipelineRun())
    mockOrchestratorRun.mockResolvedValue(defaultStatus)
    mockGetTokenUsageSummary.mockReturnValue([])

    // Setup mock db.prepare for story discovery
    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    })
    mockDb = { prepare: mockPrepare }
  })

  it('AC2: creates pipeline run, starts orchestrator, outputs progress', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoRun({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 2,
      outputFormat: 'human',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(0)
    expect(mockCreatePipelineRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ methodology: 'bmad' }),
    )
    expect(mockOrchestratorRun).toHaveBeenCalledWith(['10-1'])
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Starting pipeline'))
    stdoutWrite.mockRestore()
  })

  it('AC2: parses comma-separated story keys correctly', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    mockOrchestratorRun.mockResolvedValue({
      state: 'COMPLETE',
      stories: {
        '10-1': { phase: 'COMPLETE', reviewCycles: 1 },
        '10-2': { phase: 'COMPLETE', reviewCycles: 0 },
      },
    })

    const exitCode = await runAutoRun({
      pack: 'bmad',
      stories: '10-1,10-2',
      concurrency: 2,
      outputFormat: 'human',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(0)
    expect(mockOrchestratorRun).toHaveBeenCalledWith(['10-1', '10-2'])
    stdoutWrite.mockRestore()
  })

  it('AC4: outputs JSON with { success, data } structure', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoRun({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'json',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(0)
    const calls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    const jsonLine = calls.find((c) => c.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.success).toBe(true)
    expect(parsed.data).toHaveProperty('pipelineRunId')
    expect(parsed.data).toHaveProperty('status')
    stdoutWrite.mockRestore()
  })

  it('AC7: rejects invalid story key format', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const exitCode = await runAutoRun({
      pack: 'bmad',
      stories: 'abc',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(1)
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("Story key 'abc' is not a valid format"),
    )
    stderrWrite.mockRestore()
  })

  it('AC7: invalid story key format in JSON mode outputs structured error', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoRun({
      pack: 'bmad',
      stories: 'bad-key-format-xyz',
      concurrency: 1,
      outputFormat: 'json',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(1)
    const calls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    const jsonLine = calls.find((c) => c.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.success).toBe(false)
    stdoutWrite.mockRestore()
  })

  it('AC7: missing pack outputs error and exits 1', async () => {
    mockPackLoad.mockRejectedValue(new Error('Pack not found'))

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const exitCode = await runAutoRun({
      pack: 'missing-pack',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(1)
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("Methodology pack 'missing-pack' not found"),
    )
    stderrWrite.mockRestore()
  })

  it('AC8: discovers story keys from decision store when --stories not provided', async () => {
    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([
        { description: '10-1' },
        { description: '10-2' },
      ]),
    })
    mockDb = { prepare: mockPrepare }

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoRun({
      pack: 'bmad',
      stories: undefined,
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(0)
    expect(mockOrchestratorRun).toHaveBeenCalledWith(expect.arrayContaining(['10-1', '10-2']))
    stdoutWrite.mockRestore()
  })

  it('AC8: outputs message when no stories discovered', async () => {
    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
    })
    mockDb = { prepare: mockPrepare }

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoRun({
      pack: 'bmad',
      stories: undefined,
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(0)
    expect(mockOrchestratorRun).not.toHaveBeenCalled()
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('No pending stories'))
    stdoutWrite.mockRestore()
  })

  it('AC5: queries token usage summary after run completes', async () => {
    const tokenSummary = [
      {
        phase: 'implementation',
        agent: 'claude-code',
        total_input_tokens: 1200,
        total_output_tokens: 800,
        total_cost_usd: 0.0054,
      },
    ]
    mockGetTokenUsageSummary.mockReturnValue(tokenSummary)

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoRun({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(0)
    expect(mockGetTokenUsageSummary).toHaveBeenCalledWith(expect.anything(), 'run-uuid-123')
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain('BMAD Baseline')
    stdoutWrite.mockRestore()
  })

  it('AC5: calls addTokenUsage with correct values when phase completes with token data', async () => {
    // Simulate the orchestrator emitting story-phase-complete with token usage data
    type PhasePayload = {
      storyKey: string
      phase: string
      result: { tokenUsage?: { input: number; output: number } }
    }

    const phasePayload: PhasePayload = {
      storyKey: '10-1',
      phase: 'IN_STORY_CREATION',
      result: { tokenUsage: { input: 1200, output: 800 } },
    }

    // Capture the event listener for orchestrator:story-phase-complete
    // and invoke it synchronously during orchestrator.run() to simulate event firing
    let phaseCompleteListener: ((payload: PhasePayload) => void) | undefined
    const originalOn = mockEventBus.on
    mockEventBus.on.mockImplementation((event: string, listener: (payload: unknown) => void) => {
      if (event === 'orchestrator:story-phase-complete') {
        phaseCompleteListener = listener as (payload: PhasePayload) => void
      }
    })

    // Make orchestrator.run fire the listener before resolving
    mockOrchestratorRun.mockImplementation(async () => {
      if (phaseCompleteListener !== undefined) {
        phaseCompleteListener(phasePayload)
      }
      return defaultStatus
    })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoRun({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(0)
    expect(mockAddTokenUsage).toHaveBeenCalledWith(
      expect.anything(),
      'run-uuid-123',
      expect.objectContaining({
        phase: 'IN_STORY_CREATION',
        agent: 'claude-code',
        input_tokens: 1200,
        output_tokens: 800,
        cost_usd: expect.any(Number),
      }),
    )
    stdoutWrite.mockRestore()
    mockEventBus.on.mockImplementation(originalOn)
  })
})

describe('runAutoStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockGetTokenUsageSummary.mockReturnValue([])
  })

  it('AC3: queries latest run and formats output (human)', async () => {
    const run = mockPipelineRun()
    mockGetLatestRun.mockReturnValue(run)
    const mockPrepare = vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(run),
    })
    mockDb = { prepare: mockPrepare }

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoStatus({
      outputFormat: 'human',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(0)
    expect(mockGetLatestRun).toHaveBeenCalled()
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain('Pipeline Run:')
    expect(allOutput).toContain('run-uuid-123')
    stdoutWrite.mockRestore()
  })

  it('AC3: queries specific run with --run-id', async () => {
    const run = mockPipelineRun({ id: 'specific-run-id' })
    const mockGet = vi.fn().mockReturnValue(run)
    mockDb = {
      prepare: vi.fn().mockReturnValue({ get: mockGet }),
    }

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoStatus({
      outputFormat: 'human',
      runId: 'specific-run-id',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(0)
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain('specific-run-id')
    stdoutWrite.mockRestore()
  })

  it('AC4: outputs JSON format with { success, data } containing run_id and phases', async () => {
    const run = mockPipelineRun()
    mockGetLatestRun.mockReturnValue(run)
    mockGetTokenUsageSummary.mockReturnValue([])
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({ cnt: 0 }),
        all: vi.fn().mockReturnValue([]),
      }),
    }

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoStatus({
      outputFormat: 'json',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(0)
    const calls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    const jsonLine = calls.find((c) => c.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.success).toBe(true)
    expect(parsed.data).toHaveProperty('run_id')
    expect(parsed.data).toHaveProperty('phases')
    stdoutWrite.mockRestore()
  })

  it('AC7: no database file outputs error and exits 1', async () => {
    mockExistsSync.mockReturnValue(false)

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const exitCode = await runAutoStatus({
      outputFormat: 'human',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(1)
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining('Decision store not initialized'),
    )
    stderrWrite.mockRestore()
  })

  it('no runs found outputs error and exits 1', async () => {
    mockGetLatestRun.mockReturnValue(undefined)
    mockDb = {
      prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    }

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const exitCode = await runAutoStatus({
      outputFormat: 'human',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(1)
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining('No pipeline runs found'),
    )
    stderrWrite.mockRestore()
  })

  it('AC5: displays token telemetry in human format', async () => {
    const run = mockPipelineRun()
    mockGetLatestRun.mockReturnValue(run)
    mockDb = {
      prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(run) }),
    }
    mockGetTokenUsageSummary.mockReturnValue([
      {
        phase: 'implementation',
        agent: 'claude-code',
        total_input_tokens: 1500,
        total_output_tokens: 1200,
        total_cost_usd: 0.0225,
      },
    ])

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoStatus({
      outputFormat: 'human',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(0)
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain('Pipeline Token Usage:')
    expect(allOutput).toContain('BMAD Baseline')
    stdoutWrite.mockRestore()
  })

  it('displays per-story breakdown when story state is available', async () => {
    const storyState = {
      state: 'COMPLETE',
      stories: {
        '10-1': { phase: 'COMPLETE', reviewCycles: 1 },
        '10-2': { phase: 'ESCALATED', reviewCycles: 3 },
      },
    }
    const run = mockPipelineRun({
      token_usage_json: JSON.stringify(storyState),
    })
    mockGetLatestRun.mockReturnValue(run)
    mockDb = {
      prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(run) }),
    }

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoStatus({
      outputFormat: 'human',
      projectRoot: '/test/project',
    })

    expect(exitCode).toBe(0)
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain('Per-Story Breakdown:')
    expect(allOutput).toContain('10-1')
    expect(allOutput).toContain('10-2')
    stdoutWrite.mockRestore()
  })
})

describe('registerAutoCommand', () => {
  it('AC6: registers auto command group with init, run, status subcommands', () => {
    const program = new Command()
    registerAutoCommand(program, '1.0.0', '/test/project')

    // Check that 'auto' command is registered
    const autoCmd = program.commands.find((c) => c.name() === 'auto')
    expect(autoCmd).toBeDefined()

    // Check subcommands
    const subCmdNames = autoCmd!.commands.map((c) => c.name())
    expect(subCmdNames).toContain('init')
    expect(subCmdNames).toContain('run')
    expect(subCmdNames).toContain('status')
  })

  it('AC6: auto help shows description for each subcommand', () => {
    const program = new Command()
    registerAutoCommand(program, '1.0.0', '/test/project')

    const autoCmd = program.commands.find((c) => c.name() === 'auto')
    expect(autoCmd).toBeDefined()
    expect(autoCmd!.description()).toBe('Autonomous implementation pipeline')

    const initCmd = autoCmd!.commands.find((c) => c.name() === 'init')
    const runCmd = autoCmd!.commands.find((c) => c.name() === 'run')
    const statusCmd = autoCmd!.commands.find((c) => c.name() === 'status')

    expect(initCmd).toBeDefined()
    expect(runCmd).toBeDefined()
    expect(statusCmd).toBeDefined()
  })

  it('AC6: all subcommands have --output-format option', () => {
    const program = new Command()
    registerAutoCommand(program, '1.0.0', '/test/project')

    const autoCmd = program.commands.find((c) => c.name() === 'auto')!
    for (const subCmd of autoCmd.commands) {
      const optNames = subCmd.options.map((o) => o.long)
      expect(optNames).toContain('--output-format')
    }
  })
})
