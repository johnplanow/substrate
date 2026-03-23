/**
 * Unit tests for Story 44-3: Scenario Isolation — gitignore entries
 *
 * AC1: `substrate init` writes `.substrate/scenarios/` to `.gitignore`
 * AC2: gitignore write is idempotent — no duplicate entries
 * Regression: existing runtime entries still appear after the change
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — declared before imports (vi.mock is hoisted)
// ---------------------------------------------------------------------------

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

const mockPackLoad = vi.fn()
vi.mock('../../../modules/methodology-pack/pack-loader.js', () => ({
  createPackLoader: vi.fn(() => ({
    load: mockPackLoad,
    discover: vi.fn(),
  })),
}))

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockImplementation((root: string) => Promise.resolve(root)),
}))

// fs mocks — appendFileSync is captured so we can assert on it
const mockExistsSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockCpSync = vi.fn()
const mockReaddirSync = vi.fn()
const mockChmodSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockUnlinkSync = vi.fn()
const mockAppendFileSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  cpSync: (...args: unknown[]) => mockCpSync(...args),
  chmodSync: (...args: unknown[]) => mockChmodSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  appendFileSync: (...args: unknown[]) => mockAppendFileSync(...args),
}))

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

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => {
    const req = (id: string) => id
    req.resolve = (id: string) => id
    return req
  }),
}))

vi.mock('js-yaml', () => ({
  default: {
    dump: vi.fn(() => ''),
    load: vi.fn(() => ({})),
  },
}))

vi.mock('../../../modules/state/dolt-init.js', () => ({
  checkDoltInstalled: vi.fn().mockResolvedValue(undefined),
  initializeDolt: vi.fn().mockResolvedValue(undefined),
  DoltNotInstalled: class DoltNotInstalled extends Error {
    constructor() {
      super('Dolt not installed')
      this.name = 'DoltNotInstalled'
    }
  },
  DoltInitError: class DoltInitError extends Error {
    constructor(args: string[], exitCode: number, stderr: string) {
      super(`Dolt init failed: ${exitCode}${stderr}`)
      this.name = 'DoltInitError'
    }
  },
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
  mockExistsSync.mockReturnValue(true)
  mockReaddirSync.mockReturnValue([])
  mockReadFileSync.mockReturnValue('')
  mockPackLoad.mockResolvedValue(mockPack())
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('init gitignore isolation (AC1, AC2)', () => {
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
  // AC1: `.substrate/scenarios/` is added when `.gitignore` is empty
  // -------------------------------------------------------------------------

  it('AC1: appends .substrate/scenarios/ to .gitignore when not present', async () => {
    // Simulate no existing .gitignore content
    mockReadFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('.gitignore')) return ''
      return ''
    })

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)

    // Find the appendFileSync call that targets .gitignore
    const gitignoreAppendCalls = mockAppendFileSync.mock.calls.filter((call) =>
      String(call[0]).endsWith('.gitignore'),
    )
    expect(gitignoreAppendCalls.length).toBeGreaterThanOrEqual(1)

    const appendedContent = gitignoreAppendCalls.map((c) => String(c[1])).join('')
    expect(appendedContent).toContain('.substrate/scenarios/')
  })

  // -------------------------------------------------------------------------
  // AC2: idempotency — no duplicate entry when already present
  // -------------------------------------------------------------------------

  it('AC2: does not append .substrate/scenarios/ again when already present in .gitignore', async () => {
    // Simulate .gitignore already containing the entry
    const existingContent =
      '# Substrate runtime and factory files\n.substrate/orchestrator.pid\n.substrate/current-run-id\n.substrate/scenarios/\n'
    mockReadFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('.gitignore')) return existingContent
      return ''
    })

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    expect(exitCode).toBe(INIT_EXIT_SUCCESS)

    // Count how many times .substrate/scenarios/ appears across all appendFileSync calls
    const allAppended = mockAppendFileSync.mock.calls
      .filter((call) => String(call[0]).endsWith('.gitignore'))
      .map((c) => String(c[1]))
      .join('')

    // Should NOT append .substrate/scenarios/ because it's already present
    expect(allAppended).not.toContain('.substrate/scenarios/')
  })

  // -------------------------------------------------------------------------
  // AC2 (occurrence count): entry must appear exactly once across old + new
  // -------------------------------------------------------------------------

  it('AC2: total occurrence count of .substrate/scenarios/ is exactly 1 when already present', async () => {
    const existingContent = '.substrate/scenarios/\n'
    mockReadFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('.gitignore')) return existingContent
      return ''
    })

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    const allAppended = mockAppendFileSync.mock.calls
      .filter((call) => String(call[0]).endsWith('.gitignore'))
      .map((c) => String(c[1]))
      .join('')

    // Combined content should not add another occurrence
    const combined = existingContent + allAppended
    const occurrences = (combined.match(/\.substrate\/scenarios\//g) ?? []).length
    expect(occurrences).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Regression: existing runtime entries still present
  // -------------------------------------------------------------------------

  it('regression: .substrate/orchestrator.pid is still appended when missing', async () => {
    // Simulate empty .gitignore
    mockReadFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('.gitignore')) return ''
      return ''
    })

    await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
      doltMode: 'skip',
    })

    const allAppended = mockAppendFileSync.mock.calls
      .filter((call) => String(call[0]).endsWith('.gitignore'))
      .map((c) => String(c[1]))
      .join('')

    expect(allAppended).toContain('.substrate/orchestrator.pid')
    expect(allAppended).toContain('.substrate/current-run-id')
  })
})
