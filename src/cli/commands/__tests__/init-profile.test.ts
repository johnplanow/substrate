/**
 * Unit tests for Story 37-2: substrate init — Profile Detection & User Confirmation
 *
 * Tests the project profile detection, display, confirmation, and write steps
 * added to runInitAction() in src/cli/commands/init.ts.
 *
 * AC1: Auto-Detection Invoked During Init
 * AC2: Human-Readable Profile Display
 * AC3: Interactive Confirmation Prompt
 * AC4: Non-Interactive Bypass
 * AC5: Profile Written at Canonical Path
 * AC6: Existing Profile Preserved Without --force
 * AC7: Graceful No-Detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — declared before imports (vi.mock is hoisted)
// ---------------------------------------------------------------------------

// Mock adapter
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

// Mock PackLoader
const mockPackLoad = vi.fn()
vi.mock('../../../modules/methodology-pack/pack-loader.js', () => ({
  createPackLoader: vi.fn(() => ({
    load: mockPackLoad,
    discover: vi.fn(),
  })),
}))

// Mock git-root
vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockImplementation((root: string) => Promise.resolve(root)),
}))

// Mock fs (sync)
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
const mockAccess = vi.fn()

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

// Mock js-yaml
vi.mock('js-yaml', () => ({
  default: {
    dump: vi.fn(() => 'mocked-yaml-content\n'),
    load: vi.fn(() => ({})),
  },
}))

// Mock dolt-init
const mockCheckDoltInstalled = vi.fn()
const mockInitializeDolt = vi.fn()

vi.mock('../../../modules/state/dolt-init.js', () => ({
  checkDoltInstalled: (...args: unknown[]) => mockCheckDoltInstalled(...args),
  initializeDolt: (...args: unknown[]) => mockInitializeDolt(...args),
  DoltNotInstalled: class DoltNotInstalled extends Error {
    constructor() {
      super('Dolt CLI not found in PATH.')
      this.name = 'DoltNotInstalled'
    }
  },
  DoltInitError: class DoltInitError extends Error {
    constructor(args: string[], exitCode: number, stderr: string) {
      super(
        `Dolt command "dolt ${args.join(' ')}" failed with exit code ${exitCode}${stderr ? `: ${stderr}` : ''}`
      )
      this.name = 'DoltInitError'
    }
  },
}))

// Mock detectProjectProfile
const mockDetectProjectProfile = vi.fn()

vi.mock('../../../modules/project-profile/detect.js', () => ({
  detectProjectProfile: (...args: unknown[]) => mockDetectProjectProfile(...args),
}))

// Mock writeProjectProfile
const mockWriteProjectProfile = vi.fn()

vi.mock('../../../modules/project-profile/writer.js', () => ({
  writeProjectProfile: (...args: unknown[]) => mockWriteProjectProfile(...args),
}))

// Mock readline — needed for promptProfileConfirmation (dynamic import inside
// the function).  A top-level vi.mock ensures vitest intercepts the module
// before any dynamic import('readline') resolves, avoiding the cache-miss risk
// of inline vi.doMock calls.
const mockRlQuestion = vi.fn()
const mockRlClose = vi.fn()
const mockReadlineCreateInterface = vi.fn()

vi.mock('readline', () => ({
  createInterface: (...args: unknown[]) => mockReadlineCreateInterface(...args),
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { runInitAction, INIT_EXIT_SUCCESS } from '../init.js'

// ---------------------------------------------------------------------------
// Mock AdapterRegistry
// ---------------------------------------------------------------------------

const mockRegistry = {
  discoverAndRegister: vi.fn().mockResolvedValue({ results: [], failedCount: 0 }),
} as any

// ---------------------------------------------------------------------------
// Test profile constants
// ---------------------------------------------------------------------------

const MONOREPO_PROFILE = {
  project: {
    type: 'monorepo' as const,
    tool: 'turborepo' as const,
    buildCommand: 'turbo build',
    testCommand: 'turbo test',
    packages: [
      { path: 'apps/web', language: 'typescript' as const, buildTool: 'pnpm' as const },
      { path: 'apps/lock-service', language: 'go' as const, buildTool: 'go' as const },
    ],
  },
}

const SINGLE_GO_PROFILE = {
  project: {
    type: 'single' as const,
    tool: null,
    language: 'go' as const,
    buildTool: 'go' as const,
    buildCommand: 'go build ./...',
    testCommand: 'go test ./...',
  },
}

const SINGLE_NODE_WITH_FRAMEWORK_PROFILE = {
  project: {
    type: 'single' as const,
    tool: null,
    language: 'typescript' as const,
    buildTool: 'npm' as const,
    framework: 'nextjs',
    buildCommand: 'npm run build',
    testCommand: 'npm test',
  },
}

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

  // fs/promises
  mockReadFile.mockImplementation((path: string) => {
    if (
      String(path).includes('claude-md-substrate-section.md') ||
      String(path).includes('statusline.sh')
    ) {
      return Promise.resolve('# template content\n')
    }
    if (String(path).includes('settings.json')) {
      return Promise.reject(new Error('ENOENT'))
    }
    return Promise.reject(new Error('ENOENT'))
  })
  mockWriteFile.mockResolvedValue(undefined)

  // access: profile file does NOT exist by default
  mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

  // dolt: not installed by default
  mockCheckDoltInstalled.mockRejectedValue(new Error('not found'))

  // detectProjectProfile: returns null by default (overridden per test)
  mockDetectProjectProfile.mockResolvedValue(null)

  // writeProjectProfile: succeeds
  mockWriteProjectProfile.mockResolvedValue(undefined)

  // readline: default to accepting ('y') so non-interactive-mode tests are
  // unaffected; override mockRlQuestion per-test to simulate user input.
  const defaultRlInterface = {
    question: (...args: unknown[]) => mockRlQuestion(...args),
    close: (...args: unknown[]) => mockRlClose(...args),
  }
  mockReadlineCreateInterface.mockReturnValue(defaultRlInterface)
  mockRlQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => cb('y'))
  mockRlClose.mockReset()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Profile detection integration (Story 37-2)', () => {
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
  // AC1: Auto-detection invoked during init
  // -------------------------------------------------------------------------

  it('AC1: calls detectProjectProfile during init', async () => {
    mockDetectProjectProfile.mockResolvedValue(SINGLE_GO_PROFILE)

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    expect(mockDetectProjectProfile).toHaveBeenCalledOnce()
    expect(mockDetectProjectProfile).toHaveBeenCalledWith('/test/project')
  })

  // -------------------------------------------------------------------------
  // AC2: Human-readable profile display
  // -------------------------------------------------------------------------

  it('AC2: displays single project profile in human mode', async () => {
    mockDetectProjectProfile.mockResolvedValue(SINGLE_GO_PROFILE)

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain('Stack: go')
    expect(allOutput).toContain('Build: go build ./...')
    expect(allOutput).toContain('Test:  go test ./...')
  })

  it('AC2: displays single project profile with framework in human mode', async () => {
    mockDetectProjectProfile.mockResolvedValue(SINGLE_NODE_WITH_FRAMEWORK_PROFILE)

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain('Stack: typescript (nextjs)')
  })

  it('AC2: displays monorepo profile in human mode with per-package breakdown', async () => {
    mockDetectProjectProfile.mockResolvedValue(MONOREPO_PROFILE)

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain('Type:  monorepo (turborepo)')
    expect(allOutput).toContain('Build: turbo build')
    expect(allOutput).toContain('Test:  turbo test')
    expect(allOutput).toContain('apps/web')
    expect(allOutput).toContain('apps/lock-service')
  })

  it('AC2: does NOT display profile in JSON mode', async () => {
    mockDetectProjectProfile.mockResolvedValue(SINGLE_GO_PROFILE)

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'json',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    // Profile display text should not appear in JSON output
    expect(allOutput).not.toContain('Detected project profile:')
  })

  // -------------------------------------------------------------------------
  // AC3: Interactive confirmation prompt
  // -------------------------------------------------------------------------

  it('AC3: prompts user in interactive mode when profile is detected', async () => {
    mockDetectProjectProfile.mockResolvedValue(SINGLE_GO_PROFILE)

    // Simulate user declining by overriding mockRlQuestion for this test
    mockRlQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => cb('n'))

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: false, // interactive mode
      registry: mockRegistry,
      doltMode: 'skip',
    })

    // Verify readline was actually used (mock was effective)
    expect(mockReadlineCreateInterface).toHaveBeenCalled()
    expect(mockRlQuestion).toHaveBeenCalled()
    // When user declines, profile should NOT be written
    expect(mockWriteProjectProfile).not.toHaveBeenCalled()
  })

  it('AC3: skips profile write when user declines and prints manual-config message', async () => {
    mockDetectProjectProfile.mockResolvedValue(SINGLE_GO_PROFILE)

    // Simulate user declining
    mockRlQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => cb('n'))

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: false,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    // Verify readline was invoked (mock was effective)
    expect(mockReadlineCreateInterface).toHaveBeenCalled()
    expect(mockRlQuestion).toHaveBeenCalled()
    expect(mockWriteProjectProfile).not.toHaveBeenCalled()
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain('Create .substrate/project-profile.yaml manually')
  })

  // -------------------------------------------------------------------------
  // AC4: Non-interactive bypass
  // -------------------------------------------------------------------------

  it('AC4: writes profile without prompt in non-interactive mode (-y)', async () => {
    mockDetectProjectProfile.mockResolvedValue(MONOREPO_PROFILE)

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    expect(mockWriteProjectProfile).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // AC5: Profile written at canonical path
  // -------------------------------------------------------------------------

  it('AC5: writes profile to .substrate/project-profile.yaml', async () => {
    mockDetectProjectProfile.mockResolvedValue(SINGLE_GO_PROFILE)

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    expect(mockWriteProjectProfile).toHaveBeenCalledOnce()
    const [calledPath, calledProfile] = mockWriteProjectProfile.mock.calls[0]
    expect(calledPath).toBe('/test/project/.substrate/project-profile.yaml')
    expect(calledProfile).toEqual(SINGLE_GO_PROFILE)
  })

  it('AC5: JSON output includes projectProfile and projectProfileWritten:true', async () => {
    mockDetectProjectProfile.mockResolvedValue(SINGLE_GO_PROFILE)

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'json',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    const jsonLine = allOutput.split('\n').find((l) => l.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.data.projectProfile).toEqual(SINGLE_GO_PROFILE)
    expect(parsed.data.projectProfileWritten).toBe(true)
  })

  // -------------------------------------------------------------------------
  // AC6: Existing profile preserved without --force
  // -------------------------------------------------------------------------

  it('AC6: skips writing when profile already exists and no --force', async () => {
    mockDetectProjectProfile.mockResolvedValue(SINGLE_GO_PROFILE)
    // Simulate profile file already existing:
    // access() for profile path succeeds, but for other paths (like .substrate/) fails
    mockAccess.mockImplementation((p: string) => {
      if (String(p).includes('project-profile.yaml')) {
        return Promise.resolve(undefined) // file exists
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    })

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      force: false,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    expect(mockWriteProjectProfile).not.toHaveBeenCalled()
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain('project-profile.yaml already exists')
  })

  it('AC6: overwrites existing profile when --force is set', async () => {
    mockDetectProjectProfile.mockResolvedValue(SINGLE_GO_PROFILE)
    // Profile file exists
    mockAccess.mockImplementation((p: string) => {
      if (String(p).includes('project-profile.yaml')) {
        return Promise.resolve(undefined)
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    })

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      force: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    expect(mockWriteProjectProfile).toHaveBeenCalledOnce()
  })

  it('AC6: JSON output includes projectProfileWritten:false when existing profile is skipped', async () => {
    mockDetectProjectProfile.mockResolvedValue(SINGLE_GO_PROFILE)
    // Simulate profile file already existing
    mockAccess.mockImplementation((p: string) => {
      if (String(p).includes('project-profile.yaml')) {
        return Promise.resolve(undefined) // file exists
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    })

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'json',
      yes: true,
      force: false,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    const jsonLine = allOutput.split('\n').find((l) => l.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.data.projectProfileWritten).toBe(false)
    expect(parsed.data.projectProfile).toEqual(SINGLE_GO_PROFILE)
  })

  // -------------------------------------------------------------------------
  // AC7: Graceful no-detection
  // -------------------------------------------------------------------------

  it('AC7: skips profile write when detectProjectProfile returns null', async () => {
    mockDetectProjectProfile.mockResolvedValue(null)

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    expect(mockWriteProjectProfile).not.toHaveBeenCalled()
  })

  it('AC7: prints no-detection message in human mode when null returned', async () => {
    mockDetectProjectProfile.mockResolvedValue(null)

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain('No project stack detected')
    expect(allOutput).toContain('Create .substrate/project-profile.yaml manually')
  })

  it('AC7: JSON output includes projectProfile:null when detection returns null', async () => {
    mockDetectProjectProfile.mockResolvedValue(null)

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'json',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    const jsonLine = allOutput.split('\n').find((l) => l.includes('"success"'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.data.projectProfile).toBeNull()
    expect(parsed.data.projectProfileWritten).toBe(false)
  })
})
