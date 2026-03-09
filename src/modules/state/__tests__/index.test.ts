// @vitest-environment node
/**
 * Unit tests for the createStateStore factory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mock implementations so they are available inside vi.mock() factories.
// ---------------------------------------------------------------------------

const mockSpawnSync = vi.hoisted(() => vi.fn())
const mockExistsSync = vi.hoisted(() => vi.fn())
const mockDebug = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawnSync: mockSpawnSync,
}))

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: mockDebug,
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}))

import { createStateStore, FileStateStore, DoltStateStore } from '../index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make spawnSync behave as if dolt binary is present (exit 0, no error). */
function mockDoltBinaryPresent(): void {
  mockSpawnSync.mockReturnValue({ status: 0, error: undefined })
}

/** Make spawnSync behave as if dolt binary is absent (error.code ENOENT). */
function mockDoltBinaryAbsent(): void {
  const err = Object.assign(new Error('spawnSync dolt ENOENT'), { code: 'ENOENT' })
  mockSpawnSync.mockReturnValue({ status: null, error: err })
}

// ---------------------------------------------------------------------------
// Explicit backend tests
// ---------------------------------------------------------------------------

describe('createStateStore', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Default: binary absent, repo absent.
    mockDoltBinaryAbsent()
    mockExistsSync.mockReturnValue(false)
  })

  it('returns a FileStateStore when called with no arguments', () => {
    const store = createStateStore()
    expect(store).toBeInstanceOf(FileStateStore)
  })

  it('returns a FileStateStore when called with { backend: "file" }', () => {
    const store = createStateStore({ backend: 'file' })
    expect(store).toBeInstanceOf(FileStateStore)
  })

  it('returns a FileStateStore when called with { backend: "file", basePath: "/tmp" }', () => {
    const store = createStateStore({ backend: 'file', basePath: '/tmp' })
    expect(store).toBeInstanceOf(FileStateStore)
  })

  it('returns a DoltStateStore when called with { backend: "dolt" }', () => {
    const store = createStateStore({ backend: 'dolt' })
    expect(store).toBeInstanceOf(DoltStateStore)
  })

  it('returns a DoltStateStore when called with { backend: "dolt", basePath: "/tmp/repo" }', () => {
    const store = createStateStore({ backend: 'dolt', basePath: '/tmp/repo' })
    expect(store).toBeInstanceOf(DoltStateStore)
  })
})

// ---------------------------------------------------------------------------
// Auto-detection tests (AC1, AC3, AC4, AC5, AC6, AC7)
// ---------------------------------------------------------------------------

describe('createStateStore — auto backend', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Default safe state: binary absent, repo absent.
    mockDoltBinaryAbsent()
    mockExistsSync.mockReturnValue(false)
  })

  it('(a) returns DoltStateStore when dolt binary is present and .dolt repo exists', () => {
    mockDoltBinaryPresent()
    mockExistsSync.mockReturnValue(true)

    const store = createStateStore({ backend: 'auto', basePath: '/tmp/proj' })

    expect(store).toBeInstanceOf(DoltStateStore)
  })

  it('(b) returns FileStateStore when dolt binary is absent (repo presence irrelevant)', () => {
    mockDoltBinaryAbsent()
    mockExistsSync.mockReturnValue(true) // irrelevant — binary check fails first

    const store = createStateStore({ backend: 'auto', basePath: '/tmp/proj' })

    expect(store).toBeInstanceOf(FileStateStore)
  })

  it('(c) returns FileStateStore when binary is present but .dolt repo directory is absent', () => {
    mockDoltBinaryPresent()
    mockExistsSync.mockReturnValue(false)

    const store = createStateStore({ backend: 'auto', basePath: '/tmp/proj' })

    expect(store).toBeInstanceOf(FileStateStore)
  })

  it('(d) returns FileStateStore for explicit "file" regardless of dolt availability — no auto-detection runs', () => {
    mockDoltBinaryPresent()
    mockExistsSync.mockReturnValue(true)

    const store = createStateStore({ backend: 'file', basePath: '/tmp/proj' })

    expect(store).toBeInstanceOf(FileStateStore)
    // spawnSync must NOT have been called — explicit backends skip detection.
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })

  it('(e) returns DoltStateStore for explicit "dolt" regardless of detection result — no auto-detection runs', () => {
    mockDoltBinaryAbsent()
    mockExistsSync.mockReturnValue(false)

    const store = createStateStore({ backend: 'dolt', basePath: '/tmp/proj' })

    expect(store).toBeInstanceOf(DoltStateStore)
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })

  it('probes dolt binary with spawnSync("dolt", ["version"]) during auto-detection', () => {
    mockDoltBinaryPresent()
    mockExistsSync.mockReturnValue(true)

    createStateStore({ backend: 'auto', basePath: '/tmp/proj' })

    expect(mockSpawnSync).toHaveBeenCalledWith('dolt', ['version'], { stdio: 'ignore' })
  })

  it('checks canonical .dolt directory under basePath during auto-detection', () => {
    mockDoltBinaryPresent()
    mockExistsSync.mockReturnValue(false)

    createStateStore({ backend: 'auto', basePath: '/tmp/proj' })

    expect(mockExistsSync).toHaveBeenCalledWith('/tmp/proj/.substrate/state/.dolt')
  })

  it('short-circuits existsSync check when binary is absent', () => {
    mockDoltBinaryAbsent()

    createStateStore({ backend: 'auto', basePath: '/tmp/proj' })

    expect(mockSpawnSync).toHaveBeenCalled()
    expect(mockExistsSync).not.toHaveBeenCalled()
  })

  it('emits a debug log message when Dolt is detected', () => {
    mockDoltBinaryPresent()
    mockExistsSync.mockReturnValue(true)

    createStateStore({ backend: 'auto', basePath: '/tmp/proj' })

    expect(mockDebug).toHaveBeenCalledWith(
      expect.stringContaining('Dolt detected'),
    )
  })

  it('emits a debug log message when Dolt is not found', () => {
    mockDoltBinaryAbsent()
    mockExistsSync.mockReturnValue(false)

    createStateStore({ backend: 'auto', basePath: '/tmp/proj' })

    expect(mockDebug).toHaveBeenCalledWith(
      expect.stringContaining('Dolt not found'),
    )
  })
})
