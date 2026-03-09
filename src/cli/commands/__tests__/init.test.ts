/**
 * Unit tests for Story 26.11: Substrate init Dolt Bootstrapping
 *
 * Tests the Dolt bootstrapping branches added to runInitAction() and the
 * CLI option wiring for --dolt / --no-dolt.
 *
 * AC1: Auto-detection on PATH
 * AC2: Silent skip when Dolt not installed
 * AC3: Idempotency — already-initialized repo
 * AC4: --no-dolt flag skips Dolt bootstrapping
 * AC5: Success output includes Dolt status line
 * AC6: --dolt flag forces Dolt init as part of full init flow
 * AC7: Unit tests cover all Dolt mode branches
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — declared before imports (vi.mock is hoisted)
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

vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

// Mock PackLoader — simulate successful pack load
const mockPackLoad = vi.fn()
vi.mock('../../../modules/methodology-pack/pack-loader.js', () => ({
  createPackLoader: vi.fn(() => ({
    load: mockPackLoad,
    discover: vi.fn(),
  })),
}))

// Mock git-root — return projectRoot as repo root
vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockImplementation((root: string) => Promise.resolve(root)),
}))

// Mock fs (sync) — existsSync returns true so pack is treated as already present
const mockExistsSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockCpSync = vi.fn()
const mockReaddirSync = vi.fn()
const mockChmodSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockUnlinkSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  cpSync: (...args: unknown[]) => mockCpSync(...args),
  chmodSync: (...args: unknown[]) => mockChmodSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
}))

// Mock fs/promises
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

// Mock node:module createRequire
const mockRequireResolve = vi.fn()
const mockRequireCall = vi.fn()

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => {
    const req = (id: string) => mockRequireCall(id)
    req.resolve = (id: string) => mockRequireResolve(id)
    return req
  }),
}))

// Mock yaml
vi.mock('js-yaml', () => ({
  default: {
    dump: vi.fn(() => ''),
    load: vi.fn(() => ({})),
  },
}))

// Mock dolt-init — the module under focus
const mockCheckDoltInstalled = vi.fn()
const mockInitializeDolt = vi.fn()

vi.mock('../../../modules/state/dolt-init.js', () => ({
  checkDoltInstalled: (...args: unknown[]) => mockCheckDoltInstalled(...args),
  initializeDolt: (...args: unknown[]) => mockInitializeDolt(...args),
  DoltNotInstalled: class DoltNotInstalled extends Error {
    constructor() {
      super('Dolt CLI not found in PATH. Install Dolt from https://docs.dolthub.com/introduction/installation')
      this.name = 'DoltNotInstalled'
    }
  },
  DoltInitError: class DoltInitError extends Error {
    constructor(args: string[], exitCode: number, stderr: string) {
      super(`Dolt command "dolt ${args.join(' ')}" failed with exit code ${exitCode}${stderr ? `: ${stderr}` : ''}`)
      this.name = 'DoltInitError'
    }
  },
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { runInitAction, INIT_EXIT_SUCCESS, INIT_EXIT_ERROR } from '../init.js'

// ---------------------------------------------------------------------------
// Mock AdapterRegistry
// ---------------------------------------------------------------------------

const mockRegistry = {
  discoverAndRegister: vi.fn().mockResolvedValue({ results: [], failedCount: 0 }),
} as any

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function setupDefaultMocks() {
  // existsSync: manifest exists so pack is not scaffolded again
  mockExistsSync.mockReturnValue(true)
  mockReaddirSync.mockReturnValue([])
  mockReadFileSync.mockReturnValue('')
  mockPackLoad.mockResolvedValue(mockPack())

  const mockPrepare = vi.fn().mockReturnValue({
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(undefined),
    run: vi.fn(),
  })
  mockDb = { prepare: mockPrepare }

  // fs/promises: readFile for CLAUDE.md template and others
  mockReadFile.mockImplementation((path: string) => {
    if (String(path).includes('claude-md-substrate-section.md') ||
        String(path).includes('statusline.sh')) {
      return Promise.resolve('# template content\n')
    }
    if (String(path).includes('settings.json')) {
      return Promise.reject(new Error('ENOENT'))
    }
    // CLAUDE.md doesn't exist
    return Promise.reject(new Error('ENOENT'))
  })
  mockWriteFile.mockResolvedValue(undefined)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dolt bootstrapping', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>
  let stderrWrite: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultMocks()
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  })

  // -------------------------------------------------------------------------
  // AC1 + AC7: doltMode 'auto' with Dolt installed
  // -------------------------------------------------------------------------

  it('AC1/AC7: doltMode auto + Dolt installed — calls initializeDolt and exits 0', async () => {
    mockCheckDoltInstalled.mockResolvedValue(undefined)
    mockInitializeDolt.mockResolvedValue(undefined)

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'auto',
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    expect(mockCheckDoltInstalled).toHaveBeenCalledOnce()
    expect(mockInitializeDolt).toHaveBeenCalledOnce()
    expect(mockInitializeDolt).toHaveBeenCalledWith({ projectRoot: '/test/project' })
  })

  it('AC5/AC7: doltMode auto + Dolt installed — output includes Dolt status line', async () => {
    mockCheckDoltInstalled.mockResolvedValue(undefined)
    mockInitializeDolt.mockResolvedValue(undefined)

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'auto',
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain('✓ Dolt state store initialized at .substrate/state/')
  })

  it('AC5/AC7: doltMode auto + Dolt installed — JSON output includes doltInitialized: true', async () => {
    mockCheckDoltInstalled.mockResolvedValue(undefined)
    mockInitializeDolt.mockResolvedValue(undefined)

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'json',
      yes: true,
      registry: mockRegistry,
      doltMode: 'auto',
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    const jsonLine = allOutput.split('\n').find((l) => l.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.data.doltInitialized).toBe(true)
  })

  // -------------------------------------------------------------------------
  // AC2 + AC7: doltMode 'auto' with Dolt NOT installed (DoltNotInstalled)
  // -------------------------------------------------------------------------

  it('AC2/AC7: doltMode auto + Dolt NOT installed — exits 0, no stderr', async () => {
    const { DoltNotInstalled } = await import('../../../modules/state/dolt-init.js')
    mockCheckDoltInstalled.mockRejectedValue(new DoltNotInstalled())

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'auto',
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    // initializeDolt must NOT be called
    expect(mockInitializeDolt).not.toHaveBeenCalled()
    // No error written to stderr about Dolt
    const stderrOutput = stderrWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).not.toContain('Dolt')
  })

  it('AC2/AC7: doltMode auto + Dolt NOT installed — JSON output includes doltInitialized: false', async () => {
    const { DoltNotInstalled } = await import('../../../modules/state/dolt-init.js')
    mockCheckDoltInstalled.mockRejectedValue(new DoltNotInstalled())

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'json',
      yes: true,
      registry: mockRegistry,
      doltMode: 'auto',
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    const jsonLine = allOutput.split('\n').find((l) => l.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.data.doltInitialized).toBe(false)
  })

  // -------------------------------------------------------------------------
  // AC7: doltMode 'auto' + initializeDolt throws non-DoltNotInstalled error
  // -------------------------------------------------------------------------

  it('AC7: doltMode auto + initializeDolt throws non-DoltNotInstalled error — exits 0 (non-blocking)', async () => {
    mockCheckDoltInstalled.mockResolvedValue(undefined)
    mockInitializeDolt.mockRejectedValue(new Error('Some unexpected Dolt error'))

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'auto',
    })

    // Must not fail — non-blocking in auto mode
    expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    // No error written to stderr about Dolt (warn-level only)
    const stderrOutput = stderrWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).not.toContain('✗ Dolt')
  })

  // -------------------------------------------------------------------------
  // AC4 + AC7: doltMode 'skip'
  // -------------------------------------------------------------------------

  it('AC4/AC7: doltMode skip — initializeDolt is never called', async () => {
    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    expect(mockCheckDoltInstalled).not.toHaveBeenCalled()
    expect(mockInitializeDolt).not.toHaveBeenCalled()
  })

  it('AC4/AC7: doltMode skip — output does NOT include Dolt status line', async () => {
    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).not.toContain('Dolt state store initialized')
  })

  // -------------------------------------------------------------------------
  // AC6 + AC7: doltMode 'force' with Dolt installed
  // -------------------------------------------------------------------------

  it('AC6/AC7: doltMode force + Dolt installed — runs full init AND Dolt, exits 0', async () => {
    mockInitializeDolt.mockResolvedValue(undefined)

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'force',
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    // checkDoltInstalled should NOT be called in force mode (initializeDolt is called directly)
    expect(mockCheckDoltInstalled).not.toHaveBeenCalled()
    expect(mockInitializeDolt).toHaveBeenCalledOnce()
    expect(mockInitializeDolt).toHaveBeenCalledWith({ projectRoot: '/test/project' })
  })

  // -------------------------------------------------------------------------
  // AC6 + AC7: doltMode 'force' with Dolt NOT installed
  // -------------------------------------------------------------------------

  it('AC6/AC7: doltMode force + Dolt NOT installed — exits non-zero with error message', async () => {
    const { DoltNotInstalled } = await import('../../../modules/state/dolt-init.js')
    mockInitializeDolt.mockRejectedValue(new DoltNotInstalled())

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'force',
    })

    expect(exitCode).toBe(INIT_EXIT_ERROR)
    // stderr should contain a Dolt error message
    const stderrOutput = stderrWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).toContain('Dolt')
  })

  it('AC6/AC7: doltMode force + DoltInitError — exits non-zero with error message', async () => {
    mockInitializeDolt.mockRejectedValue(new Error('Dolt init command failed'))

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'force',
    })

    expect(exitCode).toBe(INIT_EXIT_ERROR)
    const stderrOutput = stderrWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).toContain('✗ Dolt initialization failed')
  })

  // -------------------------------------------------------------------------
  // AC3: Idempotency — already initialized (initializeDolt is idempotent by design)
  // -------------------------------------------------------------------------

  it('AC3: calling runInitAction again when Dolt already initialized — succeeds (idempotent)', async () => {
    // initializeDolt is idempotent — calling it again just succeeds
    mockCheckDoltInstalled.mockResolvedValue(undefined)
    mockInitializeDolt.mockResolvedValue(undefined)

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'auto',
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    expect(mockInitializeDolt).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // Default doltMode: 'auto' when not specified
  // -------------------------------------------------------------------------

  it('AC1: doltMode defaults to auto when not specified — Dolt present: calls initializeDolt', async () => {
    mockCheckDoltInstalled.mockResolvedValue(undefined)
    mockInitializeDolt.mockResolvedValue(undefined)

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      // doltMode not specified — should default to 'auto'
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    expect(mockCheckDoltInstalled).toHaveBeenCalledOnce()
    expect(mockInitializeDolt).toHaveBeenCalledOnce()
  })
})
