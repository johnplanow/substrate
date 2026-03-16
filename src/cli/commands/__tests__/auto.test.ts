/**
 * Unit tests for `src/cli/commands/auto.ts`
 *
 * Covers all 8 Acceptance Criteria:
 *   AC1: auto init — validates pack, initializes database, outputs success
 *   AC2: auto run — creates pipeline run, starts orchestrator, outputs progress
 *   AC3: auto status — queries latest run, formats output
 *   AC4: --output-format json — all outputs wrapped in { success, data, error }
 *   AC5: Token telemetry — addTokenUsage called, BMAD baseline comparison shown
 *   AC6: Command registration — registerXxxCommand registers init/run/status
 *   AC7: Error handling — missing pack, missing DB, invalid story keys
 *   AC8: Run without stories — discovers from decision store
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ---------------------------------------------------------------------------
// Mocks — declared before imports
// ---------------------------------------------------------------------------

// Mock adapter

const mockAdapter = { query: vi.fn().mockResolvedValue([]), exec: vi.fn().mockResolvedValue(undefined), transaction: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

vi.mock('../../../persistence/adapter.js', () => ({
  createDatabaseAdapter: vi.fn(() => mockAdapter),
}))

vi.mock('../../../persistence/schema.js', () => ({
  initSchema: vi.fn().mockResolvedValue(undefined),
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
const mockDiscoverPendingStoryKeys = vi.fn()

vi.mock('../../../modules/implementation-orchestrator/index.js', () => ({
  createImplementationOrchestrator: vi.fn(() => ({
    run: mockOrchestratorRun,
    pause: mockOrchestratorPause,
    resume: mockOrchestratorResume,
    getStatus: mockOrchestratorGetStatus,
  })),
  discoverPendingStoryKeys: (...args: unknown[]) => mockDiscoverPendingStoryKeys(...args),
}))

// Mock decisions queries
const mockCreatePipelineRun = vi.fn()
const mockGetLatestRun = vi.fn()
const mockAddTokenUsage = vi.fn()
const mockGetTokenUsageSummary = vi.fn()

const mockGetPipelineRunById = vi.fn()

vi.mock('../../../persistence/queries/decisions.js', () => ({
  createPipelineRun: (...args: unknown[]) => mockCreatePipelineRun(...args),
  getLatestRun: (...args: unknown[]) => mockGetLatestRun(...args),
  getPipelineRunById: (...args: unknown[]) => mockGetPipelineRunById(...args),
  addTokenUsage: (...args: unknown[]) => mockAddTokenUsage(...args),
  getTokenUsageSummary: (...args: unknown[]) => mockGetTokenUsageSummary(...args),
  getRunningPipelineRuns: vi.fn().mockResolvedValue([]),
  updatePipelineRun: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../persistence/queries/metrics.js', () => ({
  getStoryMetricsForRun: vi.fn().mockResolvedValue([]),
  writeStoryMetrics: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../health.js', () => ({
  inspectProcessTree: vi.fn().mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))

// Mock phase detection — default to implementation (legacy behavior)
const mockDetectStartPhase = vi.fn().mockReturnValue({
  phase: 'implementation',
  reason: 'stories ready for implementation',
  needsConcept: false,
})

vi.mock('../../../modules/phase-orchestrator/phase-detection.js', () => ({
  detectStartPhase: (...args: unknown[]) => mockDetectStartPhase(...args),
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

// Mock fs for existsSync, mkdirSync, cpSync
const mockExistsSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockCpSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  cpSync: (...args: unknown[]) => mockCpSync(...args),
}))

// Mock fs/promises for readFile and writeFile
const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
const mockMkdir = vi.fn().mockResolvedValue(undefined)
const mockAccess = vi.fn().mockRejectedValue(new Error('ENOENT'))

vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  access: (...args: unknown[]) => mockAccess(...args),
}))

// Mock node:module createRequire for bmad-method resolution
const mockRequireResolve = vi.fn()
const mockRequireCall = vi.fn()

vi.mock('node:module', () => {
  return {
    createRequire: vi.fn(() => {
      const req = (id: string) => mockRequireCall(id)
      req.resolve = (id: string) => mockRequireResolve(id)
      return req
    }),
  }
})

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import {
  formatOutput,
  formatTokenTelemetry,
  validateStoryKey,
  PACKAGE_ROOT,
  resolveBmadMethodSrcPath,
  resolveBmadMethodVersion,
} from '../pipeline-shared.js'
import {
  runInitAction,
  scaffoldBmadFramework,
  registerInitCommand,
} from '../init.js'
import { runRunAction, registerRunCommand } from '../run.js'
import { runStatusAction, registerStatusCommand } from '../status.js'
import { createStubRegistry } from './registry-test-helpers.js'

// ---------------------------------------------------------------------------
// Shared mock registry — required by action functions that throw if missing
// ---------------------------------------------------------------------------

const mockRegistry = { discoverAndRegister: vi.fn().mockResolvedValue({ results: [], failedCount: 0 }) } as any

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
    expect(validateStoryKey('1-1a')).toBe(true)
    expect(validateStoryKey('NEW-26')).toBe(true)
    expect(validateStoryKey('E5-accessibility')).toBe(true)
  })

  it('rejects invalid story keys', () => {
    expect(validateStoryKey('abc')).toBe(false)
    expect(validateStoryKey('10')).toBe(false)
    expect(validateStoryKey('10-1-extra')).toBe(false)
    expect(validateStoryKey('')).toBe(false)
    expect(validateStoryKey('10-')).toBe(false)
    expect(validateStoryKey('-10')).toBe(false)
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

describe('runInitAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    // Default: bmad-method resolves successfully
    mockRequireResolve.mockReturnValue('/fake/node_modules/bmad-method/package.json')
    mockRequireCall.mockReturnValue({ version: '6.0.3' })
    mockWriteFile.mockResolvedValue(undefined)
    mockDiscoverAndRegister.mockResolvedValue({ registeredCount: 0, failedCount: 0, results: [] })
    // Default: template readable, CLAUDE.md does not exist
    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes('claude-md-substrate-section')) {
        return Promise.resolve('<!-- substrate:start -->\n## Substrate Pipeline\n<!-- substrate:end -->\n')
      }
      return Promise.reject(new Error('ENOENT'))
    })
  })

  it('AC1: initializes pack and database, outputs success (human format)', async () => {
    mockPackLoad.mockResolvedValue(mockPack())

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockPackLoad).toHaveBeenCalledWith('/test/project/packs/bmad')
    const { createDatabaseAdapter } = await import('../../../persistence/adapter.js')
    expect(createDatabaseAdapter).toHaveBeenCalled()
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('initialized successfully'))
    stdoutWrite.mockRestore()
  })

  it('AC1: creates .substrate directory if it does not exist', async () => {
    mockPackLoad.mockResolvedValue(mockPack())
    // Local pack manifest missing, but bundled pack manifest exists (so scaffolding succeeds)
    // .substrate dir also missing → mkdirSync should be called
    mockExistsSync.mockImplementation((p: string) => {
      // Bundled pack manifest in PACKAGE_ROOT → exists
      if (p.includes(PACKAGE_ROOT) && p.endsWith('manifest.yaml')) return true
      // Everything else (local manifest, .substrate dir) → does not exist
      return false
    })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockMkdir).toHaveBeenCalledWith('/test/project/.substrate', { recursive: true })
    stdoutWrite.mockRestore()
  })

  it('AC4: outputs JSON success format with --output-format json', async () => {
    mockPackLoad.mockResolvedValue(mockPack())

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'json',
      yes: true,
      registry: mockRegistry,
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
    const exitCode = await runInitAction({
      pack: 'nonexistent',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
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
    const exitCode = await runInitAction({
      pack: 'nonexistent',
      projectRoot: '/test/project',
      outputFormat: 'json',
      yes: true,
      registry: mockRegistry,
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

  // ---------------------------------------------------------------------------
  // Story 14.1 — Pack Scaffolding Tests
  // ---------------------------------------------------------------------------

  it('AC2: scaffolds pack when local manifest is missing', async () => {
    // Local manifest missing → existsSync for local = false; bundled = true; dbDir = false
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes('packs/bmad/manifest.yaml') && p.startsWith('/test/project')) return false
      if (p.includes(`${PACKAGE_ROOT}/packs`) || p.includes('packs/bmad/manifest.yaml')) return true
      return false // dbDir
    })
    mockPackLoad.mockResolvedValue(mockPack())

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockCpSync).toHaveBeenCalledWith(
      expect.stringContaining('packs/bmad'),
      '/test/project/packs/bmad',
      { recursive: true },
    )
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain("Scaffolding methodology pack 'bmad' into packs/bmad/")
    stdoutWrite.mockRestore()
  })

  it('AC3: skips scaffold when local pack already exists', async () => {
    // Local manifest exists → no scaffolding
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes('.substrate') && !p.endsWith('.db')) return true // dbDir
      return true // everything else including local manifest
    })
    mockPackLoad.mockResolvedValue(mockPack())

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockCpSync).not.toHaveBeenCalled()
    stdoutWrite.mockRestore()
  })

  it('AC5: overwrites existing pack with --force flag', async () => {
    // Local manifest exists, but --force is set
    mockExistsSync.mockReturnValue(true)
    mockPackLoad.mockResolvedValue(mockPack())

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      force: true,
      yes: true,
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockCpSync).toHaveBeenCalled()
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("Replacing existing pack 'bmad' with bundled version"),
    )
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain("Scaffolding methodology pack 'bmad' into packs/bmad/")
    stderrWrite.mockRestore()
    stdoutWrite.mockRestore()
  })

  it('AC4: error when bundled pack is missing (bad install)', async () => {
    // Local manifest missing AND bundled pack missing
    mockExistsSync.mockReturnValue(false)
    mockPackLoad.mockResolvedValue(mockPack())

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
    })

    expect(exitCode).toBe(1)
    expect(mockCpSync).not.toHaveBeenCalled()
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("not found locally or in bundled packs"),
    )
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("reinstalling Substrate"),
    )
    stderrWrite.mockRestore()
  })

  it('AC4: bundled pack missing error in JSON format', async () => {
    mockExistsSync.mockReturnValue(false)
    mockPackLoad.mockResolvedValue(mockPack())

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'json',
      yes: true,
      registry: mockRegistry,
    })

    expect(exitCode).toBe(1)
    const calls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    const jsonLine = calls.find((c) => c.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.success).toBe(false)
    expect(parsed.error).toContain("reinstalling Substrate")
    stdoutWrite.mockRestore()
  })

  it('AC4: error message does NOT say "Run substrate init first" with old auto prefix', async () => {
    mockExistsSync.mockReturnValue(false)
    mockPackLoad.mockResolvedValue(mockPack())

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
    })

    const allOutput = stderrWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).not.toContain("Run 'substrate auto init'")
    stderrWrite.mockRestore()
  })

  it('AC6: JSON output includes scaffolded field when pack is copied', async () => {
    // Local manifest missing → scaffold happens
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.startsWith('/test/project') && p.endsWith('manifest.yaml')) return false
      return true
    })
    mockPackLoad.mockResolvedValue(mockPack())

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'json',
      yes: true,
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    const calls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    const jsonLine = calls.find((c) => c.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.success).toBe(true)
    expect(parsed.data.scaffolded).toBe(true)
    stdoutWrite.mockRestore()
  })

  it('AC6: JSON output scaffolded is false when pack already exists', async () => {
    mockExistsSync.mockReturnValue(true)
    mockPackLoad.mockResolvedValue(mockPack())

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'json',
      yes: true,
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    const calls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    const jsonLine = calls.find((c) => c.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.success).toBe(true)
    expect(parsed.data.scaffolded).toBe(false)
    stdoutWrite.mockRestore()
  })

  it('AC7: human-readable scaffold message printed when copying pack', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.startsWith('/test/project') && p.endsWith('manifest.yaml')) return false
      return true
    })
    mockPackLoad.mockResolvedValue(mockPack())

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
    })

    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain("Scaffolding methodology pack 'bmad' into packs/bmad/")
    stdoutWrite.mockRestore()
  })

  it('AC5: --force flag is registered on init command', () => {
    const program = new Command()
    registerInitCommand(program, '1.0.0', '/test/project')

    const initCmd = program.commands.find((c) => c.name() === 'init')!
    const forceOpt = initCmd.options.find((o) => o.long === '--force')
    expect(forceOpt).toBeDefined()
  })
})

describe('runRunAction', () => {
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
    mockCreatePipelineRun.mockResolvedValue(mockPipelineRun())
    mockOrchestratorRun.mockResolvedValue(defaultStatus)
    mockGetTokenUsageSummary.mockResolvedValue([])
    mockDiscoverPendingStoryKeys.mockReturnValue([])
    // Reset adapter.query to default (returns [] — no stories from DB)
    mockAdapter.query.mockResolvedValue([])
  })

  it('AC2: creates pipeline run, starts orchestrator, outputs progress', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 2,
      outputFormat: 'human',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockCreatePipelineRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ methodology: 'bmad' }),
    )
    expect(mockOrchestratorRun).toHaveBeenCalledWith(['10-1'])
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('substrate run —'))
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

    const exitCode = await runRunAction({
      pack: 'bmad',
      stories: '10-1,10-2',
      concurrency: 2,
      outputFormat: 'human',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockOrchestratorRun).toHaveBeenCalledWith(['10-1', '10-2'])
    stdoutWrite.mockRestore()
  })

  it('AC4: outputs JSON with { success, data } structure', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'json',
      projectRoot: '/test/project',
      registry: mockRegistry,
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

    const exitCode = await runRunAction({
      pack: 'bmad',
      stories: 'abc',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(1)
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("Story key 'abc' is not a valid format"),
    )
    stderrWrite.mockRestore()
  })

  it('AC7: invalid story key format in JSON mode outputs structured error', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runRunAction({
      pack: 'bmad',
      stories: 'bad-key-format-xyz',
      concurrency: 1,
      outputFormat: 'json',
      projectRoot: '/test/project',
      registry: mockRegistry,
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

    const exitCode = await runRunAction({
      pack: 'missing-pack',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(1)
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("Methodology pack 'missing-pack' not found"),
    )
    stderrWrite.mockRestore()
  })

  it('AC8: discovers story keys from decision store when --stories not provided', async () => {
    // Mock adapter.query to return story descriptions when querying requirements table
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('requirements') && sql.includes('description')) {
        return [{ description: '10-1' }, { description: '10-2' }]
      }
      return []
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

    expect(exitCode).toBe(0)
    expect(mockOrchestratorRun).toHaveBeenCalledWith(expect.arrayContaining(['10-1', '10-2']))
    stdoutWrite.mockRestore()
  })

  it('AC8: outputs message when no stories discovered', async () => {
    // adapter.query returns [] by default — no stories discovered

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runRunAction({
      pack: 'bmad',
      stories: undefined,
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockOrchestratorRun).not.toHaveBeenCalled()
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('No pending stories'))
    stdoutWrite.mockRestore()
  })

  it('AC4 (14.2): falls back to discoverPendingStoryKeys when requirements table is empty', async () => {
    // adapter.query returns [] by default — requirements table empty
    // epics.md fallback returns two pending stories
    mockDiscoverPendingStoryKeys.mockReturnValue(['7-2', '7-3'])

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runRunAction({
      pack: 'bmad',
      stories: undefined,
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockDiscoverPendingStoryKeys).toHaveBeenCalledWith('/test/project', undefined)
    expect(mockOrchestratorRun).toHaveBeenCalledWith(expect.arrayContaining(['7-2', '7-3']))
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain('Discovered 2 pending stories from epics.md')
    expect(allOutput).toContain('7-2')
    expect(allOutput).toContain('7-3')
    stdoutWrite.mockRestore()
  })

  it('AC5 (14.2): --stories flag takes precedence over epics.md fallback', async () => {
    // Even if mockDiscoverPendingStoryKeys returns something, it should NOT be called
    // when --stories is provided
    mockDiscoverPendingStoryKeys.mockReturnValue(['7-2', '7-3'])

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)
    expect(mockDiscoverPendingStoryKeys).not.toHaveBeenCalled()
    expect(mockOrchestratorRun).toHaveBeenCalledWith(['10-1'])
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
    mockGetTokenUsageSummary.mockResolvedValue(tokenSummary)

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      registry: mockRegistry,
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

    // Capture ALL event listeners for orchestrator:story-phase-complete
    // (there are multiple: the token-usage listener and the progress renderer listener)
    // and invoke them all synchronously during orchestrator.run() to simulate event firing
    const phaseCompleteListeners: Array<(payload: PhasePayload) => void> = []
    const originalOn = mockEventBus.on
    mockEventBus.on.mockImplementation((event: string, listener: (payload: unknown) => void) => {
      if (event === 'orchestrator:story-phase-complete') {
        phaseCompleteListeners.push(listener as (payload: PhasePayload) => void)
      }
    })

    // Make orchestrator.run fire all listeners before resolving
    mockOrchestratorRun.mockImplementation(async () => {
      for (const listener of phaseCompleteListeners) {
        listener(phasePayload)
      }
      return defaultStatus
    })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runRunAction({
      pack: 'bmad',
      stories: '10-1',
      concurrency: 1,
      outputFormat: 'human',
      projectRoot: '/test/project',
      registry: mockRegistry,
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

describe('runStatusAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockGetTokenUsageSummary.mockResolvedValue([])
  })

  it('AC3: queries latest run and formats output (human)', async () => {
    const run = mockPipelineRun()
    mockGetLatestRun.mockResolvedValue(run)
    // adapter.query returns [] by default (0 counts) — fine for this test

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runStatusAction({
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
    mockGetPipelineRunById.mockResolvedValue(run)

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runStatusAction({
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
    mockGetLatestRun.mockResolvedValue(run)
    mockGetTokenUsageSummary.mockResolvedValue([])
    // adapter.query returns [] by default (0 counts) — fine for this test

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runStatusAction({
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

    const exitCode = await runStatusAction({
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
    mockGetLatestRun.mockResolvedValue(undefined)

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const exitCode = await runStatusAction({
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
    mockGetLatestRun.mockResolvedValue(run)
    mockGetTokenUsageSummary.mockResolvedValue([
      {
        phase: 'implementation',
        agent: 'claude-code',
        total_input_tokens: 1500,
        total_output_tokens: 1200,
        total_cost_usd: 0.0225,
      },
    ])

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runStatusAction({
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
    mockGetLatestRun.mockResolvedValue(run)

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runStatusAction({
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

describe('command registration', () => {
  it('AC6: registers init, run, status as top-level commands', () => {
    const program = new Command()
    registerInitCommand(program, '1.0.0', '/test/project')
    registerRunCommand(program, '1.0.0', '/test/project', createStubRegistry())
    registerStatusCommand(program, '1.0.0', '/test/project')

    const cmdNames = program.commands.map((c) => c.name())
    expect(cmdNames).toContain('init')
    expect(cmdNames).toContain('run')
    expect(cmdNames).toContain('status')
  })

  it('AC6: each command is registered and defined', () => {
    const program = new Command()
    registerInitCommand(program, '1.0.0', '/test/project')
    registerRunCommand(program, '1.0.0', '/test/project')
    registerStatusCommand(program, '1.0.0', '/test/project')

    const initCmd = program.commands.find((c) => c.name() === 'init')
    const runCmd = program.commands.find((c) => c.name() === 'run')
    const statusCmd = program.commands.find((c) => c.name() === 'status')

    expect(initCmd).toBeDefined()
    expect(runCmd).toBeDefined()
    expect(statusCmd).toBeDefined()
  })

  it('AC6: all commands have --output-format option', () => {
    const program = new Command()
    registerInitCommand(program, '1.0.0', '/test/project')
    registerRunCommand(program, '1.0.0', '/test/project')
    registerStatusCommand(program, '1.0.0', '/test/project')

    for (const cmd of program.commands) {
      const optNames = cmd.options.map((o) => o.long)
      expect(optNames).toContain('--output-format')
    }
  })
})
