/**
 * Integration tests for Story 14.1: Auto Init Pack Scaffolding
 *
 * Tests the full auto init flow with a temporary directory:
 *   - Pack is copied from bundled source to project directory
 *   - Database is initialized after scaffolding
 *   - JSON output includes scaffolded field
 *
 * AC2: auto init scaffolds missing pack
 * AC6: JSON output format includes scaffolded field
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Mocks — declared before imports
// ---------------------------------------------------------------------------

// Mock DatabaseWrapper (we don't need real SQLite here)
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

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { runAutoInit, PACKAGE_ROOT } from '../auto.js'

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auto init pack scaffolding integration', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    // Create a fresh temp directory for each test
    tmpDir = mkdtempSync(join(tmpdir(), 'substrate-test-'))
    mockPackLoad.mockResolvedValue(mockPack())

    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
      run: vi.fn(),
    })
    mockDb = { prepare: mockPrepare }
  })

  afterEach(() => {
    // Remove temp directory
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('AC2: scaffolds pack from bundled source when local pack is missing', async () => {
    // tmpDir has no packs/ directory yet
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoInit({
      pack: 'bmad',
      projectRoot: tmpDir,
      outputFormat: 'human',
    })

    expect(exitCode).toBe(0)

    // Pack files should be copied from bundled source to tmpDir/packs/bmad/
    const localManifest = join(tmpDir, 'packs', 'bmad', 'manifest.yaml')
    expect(existsSync(localManifest)).toBe(true)

    // Scaffolding message should be printed
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).toContain("Scaffolding methodology pack 'bmad' into packs/bmad/")
    expect(allOutput).toContain('initialized successfully')

    stdoutWrite.mockRestore()
  })

  it('AC2: database is initialized after scaffolding', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoInit({
      pack: 'bmad',
      projectRoot: tmpDir,
      outputFormat: 'human',
    })

    expect(exitCode).toBe(0)
    expect(mockOpen).toHaveBeenCalled()
    stdoutWrite.mockRestore()
  })

  it('AC3: does NOT overwrite existing local pack', async () => {
    // Create a stub local pack with manifest.yaml
    const localPackDir = join(tmpDir, 'packs', 'bmad')
    mkdirSync(localPackDir, { recursive: true })
    writeFileSync(join(localPackDir, 'manifest.yaml'), 'name: bmad\nversion: custom\n')

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoInit({
      pack: 'bmad',
      projectRoot: tmpDir,
      outputFormat: 'human',
    })

    expect(exitCode).toBe(0)

    // Custom manifest should still be there (not overwritten)
    const { readFileSync } = await import('fs')
    const content = readFileSync(join(localPackDir, 'manifest.yaml'), 'utf-8')
    expect(content).toContain('version: custom')

    // No scaffolding message should appear
    const allOutput = stdoutWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(allOutput).not.toContain('Scaffolding methodology pack')

    stdoutWrite.mockRestore()
  })

  it('AC5: overwrites existing pack with --force', async () => {
    // Create a stub local pack
    const localPackDir = join(tmpDir, 'packs', 'bmad')
    mkdirSync(localPackDir, { recursive: true })
    writeFileSync(join(localPackDir, 'manifest.yaml'), 'name: bmad\nversion: custom\n')

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const exitCode = await runAutoInit({
      pack: 'bmad',
      projectRoot: tmpDir,
      outputFormat: 'human',
      force: true,
    })

    expect(exitCode).toBe(0)

    // Bundled manifest should have replaced the custom one
    const { readFileSync } = await import('fs')
    const content = readFileSync(join(localPackDir, 'manifest.yaml'), 'utf-8')
    expect(content).not.toContain('version: custom')

    // Warning should appear
    const stderrOutput = stderrWrite.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).toContain("Replacing existing pack 'bmad' with bundled version")

    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  })

  it('AC6: JSON output includes scaffolded:true when pack is copied', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoInit({
      pack: 'bmad',
      projectRoot: tmpDir,
      outputFormat: 'json',
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

  it('AC6: JSON output includes scaffolded:false when pack already exists', async () => {
    // Create existing pack
    const localPackDir = join(tmpDir, 'packs', 'bmad')
    mkdirSync(localPackDir, { recursive: true })
    writeFileSync(join(localPackDir, 'manifest.yaml'), 'name: bmad\nversion: 1.0.0\n')

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runAutoInit({
      pack: 'bmad',
      projectRoot: tmpDir,
      outputFormat: 'json',
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

  it('AC1: bundled packs directory exists in package root', () => {
    const bundledManifest = join(PACKAGE_ROOT, 'packs', 'bmad', 'manifest.yaml')
    expect(existsSync(bundledManifest)).toBe(true)
  })
})
