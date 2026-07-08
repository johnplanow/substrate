/**
 * Unit tests for init's `.gitignore` handling.
 *
 * Originally Story 44-3 (scenario isolation via enumerated entries); superseded
 * by the consolidated `.substrate/*` + `!.substrate/config.yaml` pattern, which
 * covers `.substrate/scenarios/` and every other runtime file while keeping the
 * operator config trackable. See computeSubstrateGitignore.
 *
 * AC1: writes the consolidated pattern when `.gitignore` is empty.
 * AC2: idempotent — no rewrite when the canonical pattern is already present.
 * Repair: converts a pre-existing wholesale `.substrate/` dir-ignore.
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

  /** Concatenate all writeFileSync calls that targeted .gitignore. */
  function gitignoreWrites(): string {
    return mockWriteFileSync.mock.calls
      .filter((call) => String(call[0]).endsWith('.gitignore'))
      .map((c) => String(c[1]))
      .join('')
  }

  // -------------------------------------------------------------------------
  // AC1: the consolidated `.substrate/*` pattern (which covers scenarios/) is
  // written when `.gitignore` is empty, with the config.yaml exception.
  // -------------------------------------------------------------------------

  it('AC1: writes .substrate/* + !.substrate/config.yaml when .gitignore is empty', async () => {
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

    const written = gitignoreWrites()
    // `.substrate/*` covers .substrate/scenarios/ and all other runtime files.
    expect(written).toContain('.substrate/*')
    expect(written).toContain('!.substrate/config.yaml')
  })

  // -------------------------------------------------------------------------
  // AC2: idempotency — no write when the canonical pattern is already present.
  // -------------------------------------------------------------------------

  it('AC2: does not rewrite .gitignore when the canonical pattern already present', async () => {
    const existingContent =
      '.substrate/*\n!.substrate/config.yaml\n!.substrate/project-profile.yaml\n!.substrate/acceptance/\n.codex/prompts/\n.codex/skills/\n.substrate/acceptance/gate-state.json\n.substrate/acceptance/metrics.json\n'
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
    expect(gitignoreWrites()).toBe('') // no .gitignore write at all
  })

  // -------------------------------------------------------------------------
  // Repairs a pre-existing wholesale `.substrate/` dir-ignore (the reported bug).
  // -------------------------------------------------------------------------

  it('repairs a wholesale .substrate/ dir-ignore so config.yaml is trackable', async () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('.gitignore')) return 'node_modules/\n.substrate/\n'
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

    const written = gitignoreWrites()
    expect(written).toContain('.substrate/*')
    expect(written).toContain('!.substrate/config.yaml')
    // the wholesale dir-ignore must be gone (it blocks the negation)
    expect(written.split('\n').map((l) => l.trim())).not.toContain('.substrate/')
    expect(written).toContain('node_modules/') // unrelated entry preserved
  })
})
