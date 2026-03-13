/**
 * Unit tests for src/cli/commands/retry-escalated.ts
 *
 * Covers AC1-AC7:
 *   AC1: Retryable story discovery (retry-targeted → retryable list)
 *   AC2: Non-retryable stories excluded with correct skip reasons
 *   AC3: --dry-run exits 0, does not invoke orchestrator
 *   AC4: No retryable escalations → message + exit 0
 *   AC5: --run-id scopes query to that run
 *   AC6: Live retry invokes orchestrator with retryable keys
 *   AC7: --output-format json produces valid JSON envelope
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — declared before imports
// ---------------------------------------------------------------------------

// Mock DatabaseWrapper
const mockOpen = vi.fn()
const mockClose = vi.fn()
const mockDb = {}

const mockAdapter = { query: vi.fn().mockResolvedValue([]), exec: vi.fn().mockResolvedValue(undefined), transaction: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

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
    get adapter() {
      return mockAdapter
    },
  })),
}))

// Mock runMigrations
vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

// Mock getRetryableEscalations
const mockGetRetryableEscalations = vi.fn()

vi.mock('../../../persistence/queries/retry-escalated.js', () => ({
  getRetryableEscalations: (...args: unknown[]) => mockGetRetryableEscalations(...args),
}))

// Mock createPipelineRun + addTokenUsage
const mockCreatePipelineRun = vi.fn()
const mockAddTokenUsage = vi.fn()

vi.mock('../../../persistence/queries/decisions.js', () => ({
  createPipelineRun: (...args: unknown[]) => mockCreatePipelineRun(...args),
  addTokenUsage: (...args: unknown[]) => mockAddTokenUsage(...args),
}))

// Mock resolveMainRepoRoot
vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/fake/root'),
}))

// Mock fs (existsSync)
const mockExistsSync = vi.fn().mockReturnValue(true)

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: vi.fn(),
}))

// Mock PackLoader
const mockPackLoad = vi.fn()

vi.mock('../../../modules/methodology-pack/pack-loader.js', () => ({
  createPackLoader: vi.fn(() => ({
    load: mockPackLoad,
  })),
}))

// Mock context-compiler
vi.mock('../../../modules/context-compiler/index.js', () => ({
  createContextCompiler: vi.fn(() => ({
    compile: vi.fn(),
  })),
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

// Mock AdapterRegistry
const mockDiscoverAndRegister = vi.fn().mockResolvedValue({ registeredCount: 0 })

vi.mock('../../../adapters/adapter-registry.js', () => ({
  AdapterRegistry: vi.fn().mockImplementation(() => ({
    discoverAndRegister: mockDiscoverAndRegister,
  })),
}))

// Mock ImplementationOrchestrator
const mockOrchestratorRun = vi.fn().mockResolvedValue(undefined)

vi.mock('../../../modules/implementation-orchestrator/index.js', () => ({
  createImplementationOrchestrator: vi.fn(() => ({
    run: mockOrchestratorRun,
  })),
}))

// Mock event bus
const mockEventBusOn = vi.fn()
const mockEventBus = {
  on: mockEventBusOn,
  emit: vi.fn(),
  off: vi.fn(),
}

vi.mock('../../../core/event-bus.js', () => ({
  createEventBus: vi.fn(() => mockEventBus),
}))

// ---------------------------------------------------------------------------
// Registry mock instance — required by runRetryEscalatedAction
// ---------------------------------------------------------------------------

const mockRegistry = { discoverAndRegister: vi.fn().mockResolvedValue({ results: [], failedCount: 0 }) } as any

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { runRetryEscalatedAction, registerRetryEscalatedCommand } from '../retry-escalated.js'
import { Command } from 'commander'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockPack() {
  return {
    manifest: {
      name: 'bmad',
      version: '1.0.0',
      description: 'BMAD methodology pack',
    },
    getPrompt: vi.fn(),
  }
}

function mockPipelineRun() {
  return {
    id: 'retry-run-uuid',
    methodology: 'bmad',
    status: 'running',
    config_json: null,
    token_usage_json: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runRetryEscalatedAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockPackLoad.mockResolvedValue(mockPack())
    mockCreatePipelineRun.mockResolvedValue(mockPipelineRun())
    mockOrchestratorRun.mockResolvedValue(undefined)
  })

  // -------------------------------------------------------------------------
  // AC4: No retryable escalations
  // -------------------------------------------------------------------------

  it('AC4: outputs message and returns 0 when no retryable escalations exist (human)', async () => {
    mockGetRetryableEscalations.mockResolvedValue({ retryable: [], skipped: [] })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runRetryEscalatedAction({
      dryRun: false,
      outputFormat: 'human',
      projectRoot: '/test',
      concurrency: 3,
      pack: 'bmad',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(stdoutWrite).toHaveBeenCalledWith('No retry-targeted escalations found.\n')
    expect(mockOrchestratorRun).not.toHaveBeenCalled()
    stdoutWrite.mockRestore()
  })

  it('AC4+AC7: outputs JSON envelope with empty lists when no retryable escalations (json)', async () => {
    mockGetRetryableEscalations.mockResolvedValue({
      retryable: [],
      skipped: [{ key: '22-1', reason: 'needs human review' }],
    })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runRetryEscalatedAction({
      dryRun: false,
      outputFormat: 'json',
      projectRoot: '/test',
      concurrency: 3,
      pack: 'bmad',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    const calls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    const jsonLine = calls.find((c) => c.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!) as { success: boolean; data: { retryKeys: string[]; skippedKeys: unknown[] } }
    expect(parsed.success).toBe(true)
    expect(parsed.data.retryKeys).toEqual([])
    expect(parsed.data.skippedKeys).toHaveLength(1)
    stdoutWrite.mockRestore()
  })

  // -------------------------------------------------------------------------
  // AC3: Dry-run mode
  // -------------------------------------------------------------------------

  it('AC3: dry-run exits 0 and does not invoke orchestrator (human)', async () => {
    mockGetRetryableEscalations.mockResolvedValue({
      retryable: ['22-1', '22-2'],
      skipped: [{ key: '22-3', reason: 'needs human review' }],
    })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runRetryEscalatedAction({
      dryRun: true,
      outputFormat: 'human',
      projectRoot: '/test',
      concurrency: 3,
      pack: 'bmad',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockOrchestratorRun).not.toHaveBeenCalled()
    const output = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(output).toContain('22-1')
    expect(output).toContain('22-2')
    expect(output).toContain('22-3')
    stdoutWrite.mockRestore()
  })

  it('AC3+AC7: dry-run with --output-format json produces JSON envelope', async () => {
    mockGetRetryableEscalations.mockResolvedValue({
      retryable: ['22-1'],
      skipped: [{ key: '22-2', reason: 'story should be split' }],
    })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runRetryEscalatedAction({
      dryRun: true,
      outputFormat: 'json',
      projectRoot: '/test',
      concurrency: 3,
      pack: 'bmad',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockOrchestratorRun).not.toHaveBeenCalled()
    const calls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    const jsonLine = calls.find((c) => c.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!) as {
      success: boolean
      data: { retryKeys: string[]; skippedKeys: { key: string; reason: string }[] }
    }
    expect(parsed.success).toBe(true)
    expect(parsed.data.retryKeys).toEqual(['22-1'])
    expect(parsed.data.skippedKeys).toContainEqual({ key: '22-2', reason: 'story should be split' })
    stdoutWrite.mockRestore()
  })

  // -------------------------------------------------------------------------
  // AC1 + AC2: Story classification
  // -------------------------------------------------------------------------

  it('AC1: passes retryable story keys to orchestrator', async () => {
    mockGetRetryableEscalations.mockResolvedValue({
      retryable: ['22-1', '22-4'],
      skipped: [],
    })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runRetryEscalatedAction({
      dryRun: false,
      outputFormat: 'human',
      projectRoot: '/test',
      concurrency: 3,
      pack: 'bmad',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockOrchestratorRun).toHaveBeenCalledWith(['22-1', '22-4'])
    stdoutWrite.mockRestore()
  })

  it('AC2: human-intervention and split-story stories appear in skipped output', async () => {
    mockGetRetryableEscalations.mockResolvedValue({
      retryable: ['22-1'],
      skipped: [
        { key: '22-2', reason: 'needs human review' },
        { key: '22-3', reason: 'story should be split' },
      ],
    })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runRetryEscalatedAction({
      dryRun: true,
      outputFormat: 'human',
      projectRoot: '/test',
      concurrency: 3,
      pack: 'bmad',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    const output = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(output).toContain('needs human review')
    expect(output).toContain('story should be split')
    stdoutWrite.mockRestore()
  })

  // -------------------------------------------------------------------------
  // AC5: --run-id scoping
  // -------------------------------------------------------------------------

  it('AC5: passes runId to getRetryableEscalations when --run-id is provided', async () => {
    mockGetRetryableEscalations.mockResolvedValue({ retryable: [], skipped: [] })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await runRetryEscalatedAction({
      runId: 'my-run-123',
      dryRun: false,
      outputFormat: 'human',
      projectRoot: '/test',
      concurrency: 3,
      pack: 'bmad',
      registry: mockRegistry,
    })

    expect(mockGetRetryableEscalations).toHaveBeenCalledWith(mockAdapter, 'my-run-123')
    stdoutWrite.mockRestore()
  })

  it('AC5: passes undefined runId when --run-id is not provided', async () => {
    mockGetRetryableEscalations.mockResolvedValue({ retryable: [], skipped: [] })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await runRetryEscalatedAction({
      dryRun: false,
      outputFormat: 'human',
      projectRoot: '/test',
      concurrency: 3,
      pack: 'bmad',
      registry: mockRegistry,
    })

    expect(mockGetRetryableEscalations).toHaveBeenCalledWith(mockAdapter, undefined)
    stdoutWrite.mockRestore()
  })

  // -------------------------------------------------------------------------
  // AC6: Orchestrator invocation
  // -------------------------------------------------------------------------

  it('AC6: invokes orchestrator with retryable keys in live mode', async () => {
    mockGetRetryableEscalations.mockResolvedValue({
      retryable: ['22-3'],
      skipped: [],
    })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runRetryEscalatedAction({
      dryRun: false,
      outputFormat: 'human',
      projectRoot: '/test',
      concurrency: 3,
      pack: 'bmad',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockOrchestratorRun).toHaveBeenCalledWith(['22-3'])
    expect(mockCreatePipelineRun).toHaveBeenCalledWith(
      mockAdapter,
      expect.objectContaining({ start_phase: 'implementation' }),
    )
    stdoutWrite.mockRestore()
  })

  // -------------------------------------------------------------------------
  // AC7: JSON output
  // -------------------------------------------------------------------------

  it('AC7: json output after live run contains retryKeys and skippedKeys', async () => {
    mockGetRetryableEscalations.mockResolvedValue({
      retryable: ['22-1'],
      skipped: [{ key: '22-2', reason: 'needs human review' }],
    })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runRetryEscalatedAction({
      dryRun: false,
      outputFormat: 'json',
      projectRoot: '/test',
      concurrency: 3,
      pack: 'bmad',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    const calls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    const jsonLine = calls.find((c) => c.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!) as {
      success: boolean
      data: { retryKeys: string[]; skippedKeys: { key: string; reason: string }[] }
    }
    expect(parsed.success).toBe(true)
    expect(parsed.data.retryKeys).toEqual(['22-1'])
    expect(parsed.data.skippedKeys).toContainEqual({ key: '22-2', reason: 'needs human review' })
    stdoutWrite.mockRestore()
  })

  // -------------------------------------------------------------------------
  // Error paths
  // -------------------------------------------------------------------------

  it('returns 1 and human error message when DB does not exist', async () => {
    mockExistsSync.mockReturnValue(false)

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitCode = await runRetryEscalatedAction({
      dryRun: false,
      outputFormat: 'human',
      projectRoot: '/test',
      concurrency: 3,
      pack: 'bmad',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(1)
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Decision store not initialized'))
    stderrWrite.mockRestore()
  })

  it('returns 1 and JSON error when DB does not exist with json format', async () => {
    mockExistsSync.mockReturnValue(false)

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runRetryEscalatedAction({
      dryRun: false,
      outputFormat: 'json',
      projectRoot: '/test',
      concurrency: 3,
      pack: 'bmad',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(1)
    const calls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    const jsonLine = calls.find((c) => c.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!) as { success: boolean; error?: string }
    expect(parsed.success).toBe(false)
    expect(parsed.error).toContain('Decision store not initialized')
    stdoutWrite.mockRestore()
  })

  it('returns 1 when pack cannot be loaded', async () => {
    mockGetRetryableEscalations.mockResolvedValue({ retryable: ['22-1'], skipped: [] })
    mockPackLoad.mockRejectedValue(new Error('pack not found'))

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitCode = await runRetryEscalatedAction({
      dryRun: false,
      outputFormat: 'human',
      projectRoot: '/test',
      concurrency: 3,
      pack: 'bmad',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(1)
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("Methodology pack 'bmad' not found"))
    stderrWrite.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Tests: registerRetryEscalatedCommand (Commander wiring)
// ---------------------------------------------------------------------------

describe('registerRetryEscalatedCommand', () => {
  it('registers the retry-escalated command on the program', () => {
    const program = new Command()
    registerRetryEscalatedCommand(program)
    const cmd = program.commands.find((c) => c.name() === 'retry-escalated')
    expect(cmd).toBeDefined()
  })

  it('command has --dry-run, --run-id, --concurrency, --pack, --project-root, --output-format options', () => {
    const program = new Command()
    registerRetryEscalatedCommand(program)
    const cmd = program.commands.find((c) => c.name() === 'retry-escalated')!
    const optionNames = cmd.options.map((o) => o.long)
    expect(optionNames).toContain('--dry-run')
    expect(optionNames).toContain('--run-id')
    expect(optionNames).toContain('--concurrency')
    expect(optionNames).toContain('--pack')
    expect(optionNames).toContain('--project-root')
    expect(optionNames).toContain('--output-format')
  })
})
