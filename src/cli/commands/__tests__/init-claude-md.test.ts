/**
 * Integration tests for Story 37-7: CLAUDE.md generation with stack-aware dev notes.
 *
 * Tests that scaffoldClaudeMd() generates correct CLAUDE.md content based on
 * the detected project profile passed from runInitAction().
 *
 * AC2: Go Single Project — go test ./... appears in CLAUDE.md
 * AC6: Turborepo Monorepo — package table with path/language in CLAUDE.md
 * AC7: No Profile — dev-workflow markers absent from CLAUDE.md
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
vi.mock('../../../modules/state/dolt-init.js', () => ({
  checkDoltInstalled: vi.fn().mockRejectedValue(new Error('not found')),
  initializeDolt: vi.fn().mockResolvedValue(undefined),
  DoltNotInstalled: class DoltNotInstalled extends Error {
    constructor() {
      super('Dolt CLI not found in PATH.')
      this.name = 'DoltNotInstalled'
    }
  },
}))

// Mock detectProjectProfile
const mockDetectProjectProfile = vi.fn()
vi.mock('../../../modules/project-profile/detect.js', () => ({
  detectProjectProfile: (...args: unknown[]) => mockDetectProjectProfile(...args),
}))

// Mock writeProjectProfile
vi.mock('../../../modules/project-profile/writer.js', () => ({
  writeProjectProfile: vi.fn().mockResolvedValue(undefined),
}))

// Mock readline
vi.mock('readline', () => ({
  createInterface: vi.fn().mockReturnValue({
    question: (_prompt: string, cb: (answer: string) => void) => cb('y'),
    close: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { runInitAction, INIT_EXIT_SUCCESS } from '../init.js'
import {
  DEV_WORKFLOW_START_MARKER,
  DEV_WORKFLOW_END_MARKER,
} from '../../templates/build-dev-notes.js'

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
    if (String(path).includes('claude-md-substrate-section.md')) {
      return Promise.resolve(
        '<!-- substrate:start -->\n# Substrate Pipeline\n<!-- substrate:end -->\n'
      )
    }
    if (String(path).includes('statusline.sh')) {
      return Promise.resolve('#!/bin/sh\n')
    }
    return Promise.reject(new Error('ENOENT'))
  })
  mockWriteFile.mockResolvedValue(undefined)
  mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  mockDetectProjectProfile.mockResolvedValue(null)
}

/**
 * Get the content written to CLAUDE.md from mockWriteFile calls.
 */
function getCapturedClaudeMdContent(): string | null {
  const calls = mockWriteFile.mock.calls
  for (const [path, content] of calls) {
    if (String(path).includes('CLAUDE.md')) {
      return String(content)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLAUDE.md generation with stack-aware dev notes (Story 37-7)', () => {
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
  // AC2: Go profile → go test ./... appears in CLAUDE.md
  // -------------------------------------------------------------------------

  it('AC2: Go profile — CLAUDE.md contains go test ./...', async () => {
    mockDetectProjectProfile.mockResolvedValue({
      project: {
        type: 'single',
        language: 'go',
        buildTool: 'go',
        buildCommand: 'go build ./...',
        testCommand: 'go test ./...',
      },
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

    const content = getCapturedClaudeMdContent()
    expect(content).not.toBeNull()
    expect(content).toContain('go test ./...')
    expect(content).toContain(DEV_WORKFLOW_START_MARKER)
    expect(content).toContain(DEV_WORKFLOW_END_MARKER)
  })

  // -------------------------------------------------------------------------
  // AC6: Turborepo monorepo with 2 packages → package table in CLAUDE.md
  // -------------------------------------------------------------------------

  it('AC6: Turborepo monorepo — CLAUDE.md contains package table with path and language', async () => {
    mockDetectProjectProfile.mockResolvedValue({
      project: {
        type: 'monorepo',
        tool: 'turborepo',
        buildCommand: 'turbo build',
        testCommand: 'turbo test',
        packages: [
          {
            path: 'apps/web',
            language: 'typescript',
            buildTool: 'pnpm',
            framework: 'nextjs',
            testCommand: 'pnpm test',
          },
          {
            path: 'apps/lock-service',
            language: 'go',
            buildTool: 'go',
          },
        ],
      },
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

    const content = getCapturedClaudeMdContent()
    expect(content).not.toBeNull()
    expect(content).toContain(DEV_WORKFLOW_START_MARKER)
    // Root commands
    expect(content).toContain('turbo build')
    expect(content).toContain('turbo test')
    // Package table with path column
    expect(content).toContain('apps/web')
    expect(content).toContain('apps/lock-service')
    // Package table with language column
    expect(content).toContain('typescript')
    expect(content).toContain('go')
  })

  // -------------------------------------------------------------------------
  // AC7: null profile → no dev-workflow markers in CLAUDE.md
  // -------------------------------------------------------------------------

  it('AC7: null profile — CLAUDE.md does not contain dev-workflow markers', async () => {
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

    const content = getCapturedClaudeMdContent()
    expect(content).not.toBeNull()
    // No dev-workflow markers when profile is null
    expect(content).not.toContain(DEV_WORKFLOW_START_MARKER)
    expect(content).not.toContain(DEV_WORKFLOW_END_MARKER)
    // Substrate section still present
    expect(content).toContain('<!-- substrate:start -->')
  })
})
